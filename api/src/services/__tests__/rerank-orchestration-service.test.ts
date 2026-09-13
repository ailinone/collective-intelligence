// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RerankOrchestrationService — LOTE AP.
 *
 * Pins the behaviour that makes `reranking` a real capability rather than a
 * catalog flag:
 *   - dynamic, zero-hardcode candidate selection (catalog by capability),
 *     via `searchModelsComplete` and NEVER the 100-row-capped `searchModels`;
 *   - an explicit model resolves through `findModelsByIdOrName` so every
 *     provider row carrying that id is a fallback candidate;
 *   - the portable `RerankResponse` contract is honoured — descending order,
 *     indices into the ORIGINAL document array;
 *   - `topN` is enforced locally, not trusted to the provider;
 *   - input validation rejects the shapes that would otherwise become
 *     opaque provider 4xx;
 *   - provider failure falls through to the next candidate.
 *
 * Repository and provider registry are mocked: no DB, no network.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Model, OrchestrationContext } from '@/types';
import type { RerankResponse } from '@/types/model-client';

const searchModelsComplete = vi.fn();
const searchModels = vi.fn();
const findModelsByIdOrName = vi.fn();

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModelsComplete = searchModelsComplete;
    searchModels = searchModels;
    findModelsByIdOrName = findModelsByIdOrName;
  },
}));

const resolveAdapterForModel = vi.fn();
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ resolveAdapterForModel }),
}));

// The pool gate must reflect a REAL rerank implementation, not a base stub —
// mirrored here so the test does not depend on adapter prototypes.
vi.mock('@/providers/provider-operability', () => ({
  isAdapterMethodImplemented: (adapter: { rerank?: unknown }) => typeof adapter.rerank === 'function',
}));

import {
  RerankOrchestrationService,
  MAX_RERANK_DOCUMENTS,
} from '../rerank-orchestration-service';
import { ValidationError } from '@/utils/custom-errors';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'rerank-fixture',
    name: 'rerank-fixture',
    displayName: 'Rerank Fixture',
    provider: 'fixture-provider',
    capabilities: ['reranking', 'retrieval'],
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.01,
    status: 'active',
    ...overrides,
  } as unknown as Model;
}

function makeAdapter(rerank: Mock) {
  return { rerank, getName: () => 'fixture-provider' };
}

function response(
  results: Array<{ index: number; relevanceScore: number; document?: string }>
): RerankResponse {
  return { results, raw: { results } };
}

const DOCS = ['alpha document', 'beta document', 'gamma document'];

describe('RerankOrchestrationService', () => {
  let service: RerankOrchestrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RerankOrchestrationService();
  });

  describe('candidate selection (zero-hardcode)', () => {
    it('pools the WHOLE catalog by capability via searchModelsComplete, never searchModels', async () => {
      const model = makeModel();
      searchModelsComplete.mockResolvedValue([model]);
      const rerank = vi.fn().mockResolvedValue(response([{ index: 0, relevanceScore: 0.9 }]));
      resolveAdapterForModel.mockReturnValue({ adapter: makeAdapter(rerank) });

      await service.rerank({
        query: 'q',
        documents: DOCS,
        userContext: USER_CONTEXT,
        requestId: 'req_1',
      });

      expect(searchModelsComplete).toHaveBeenCalledWith({
        capabilities: ['reranking'],
        status: 'active',
      });
      // `searchModels` silently caps at 100 rows ordered by created_at DESC —
      // the LOTE AN failure mode. It must never be the rerank pool.
      expect(searchModels).not.toHaveBeenCalled();
    });

    it('resolves an explicit model across every provider row carrying that id', async () => {
      const rows = [
        makeModel({ provider: 'provider-a' }),
        makeModel({ provider: 'provider-b' }),
        makeModel({ provider: 'provider-c', capabilities: ['chat'] }),
      ];
      findModelsByIdOrName.mockResolvedValue(rows);
      const rerank = vi.fn().mockResolvedValue(response([{ index: 0, relevanceScore: 0.5 }]));
      resolveAdapterForModel.mockReturnValue({ adapter: makeAdapter(rerank) });

      const result = await service.rerank({
        query: 'q',
        documents: DOCS,
        model: 'rerank-fixture',
        userContext: USER_CONTEXT,
        requestId: 'req_2',
      });

      expect(findModelsByIdOrName).toHaveBeenCalledWith('rerank-fixture');
      expect(searchModelsComplete).not.toHaveBeenCalled();
      // The chat-only row is filtered out; a rerank row remains.
      expect(['provider-a', 'provider-b']).toContain(result.provider);
    });

    it('treats model:"auto" as dynamic selection, not as a model id', async () => {
      searchModelsComplete.mockResolvedValue([makeModel()]);
      const rerank = vi.fn().mockResolvedValue(response([{ index: 0, relevanceScore: 0.4 }]));
      resolveAdapterForModel.mockReturnValue({ adapter: makeAdapter(rerank) });

      await service.rerank({
        query: 'q',
        documents: DOCS,
        model: 'auto',
        userContext: USER_CONTEXT,
        requestId: 'req_3',
      });

      expect(searchModelsComplete).toHaveBeenCalled();
      expect(findModelsByIdOrName).not.toHaveBeenCalled();
    });
  });

  describe('result contract', () => {
    it('passes query + documents through and returns descending relevance', async () => {
      searchModelsComplete.mockResolvedValue([makeModel()]);
      const rerank = vi.fn().mockResolvedValue(
        response([
          { index: 2, relevanceScore: 0.91 },
          { index: 0, relevanceScore: 0.55 },
          { index: 1, relevanceScore: 0.12 },
        ])
      );
      resolveAdapterForModel.mockReturnValue({ adapter: makeAdapter(rerank) });

      const result = await service.rerank({
        query: 'which document mentions gamma?',
        documents: DOCS,
        userContext: USER_CONTEXT,
        requestId: 'req_4',
      });

      const [, request] = rerank.mock.calls[0];
      expect(request.query).toBe('which document mentions gamma?');
      expect(request.documents).toEqual(DOCS);

      expect(result.results.map((r) => r.index)).toEqual([2, 0, 1]);
      expect(result.modelUsed).toBe('rerank-fixture');
      expect(result.provider).toBe('fixture-provider');
    });

    it('enforces topN locally even when the provider ignores it', async () => {
      searchModelsComplete.mockResolvedValue([makeModel()]);
      // Provider returns all three despite top_n=1 — several do exactly this.
      const rerank = vi.fn().mockResolvedValue(
        response([
          { index: 1, relevanceScore: 0.99 },
          { index: 0, relevanceScore: 0.5 },
          { index: 2, relevanceScore: 0.1 },
        ])
      );
      resolveAdapterForModel.mockReturnValue({ adapter: makeAdapter(rerank) });

      const result = await service.rerank({
        query: 'q',
        documents: DOCS,
        topN: 1,
        userContext: USER_CONTEXT,
        requestId: 'req_5',
      });

      expect(rerank.mock.calls[0][1].topN).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].index).toBe(1);
    });

    it('surfaces provider token usage when reported', async () => {
      searchModelsComplete.mockResolvedValue([makeModel()]);
      const rerank = vi.fn().mockResolvedValue({
        results: [{ index: 0, relevanceScore: 0.7 }],
        totalTokens: 42,
        raw: {},
      });
      resolveAdapterForModel.mockReturnValue({ adapter: makeAdapter(rerank) });

      const result = await service.rerank({
        query: 'q',
        documents: DOCS,
        userContext: USER_CONTEXT,
        requestId: 'req_6',
      });

      expect(result.totalTokens).toBe(42);
    });
  });

  describe('fallback', () => {
    it('moves to the next candidate when a provider fails', async () => {
      const failing = vi.fn().mockRejectedValue(new Error('provider exploded'));
      const working = vi.fn().mockResolvedValue(response([{ index: 0, relevanceScore: 0.8 }]));

      searchModelsComplete.mockResolvedValue([
        makeModel({
          id: 'rerank-broken',
          provider: 'broken',
          inputCostPer1k: 0.001,
          outputCostPer1k: 0.001,
        }),
        makeModel({
          id: 'rerank-healthy',
          provider: 'healthy',
          inputCostPer1k: 0.002,
          outputCostPer1k: 0.002,
        }),
      ]);
      resolveAdapterForModel.mockImplementation((model: Model) => ({
        adapter:
          model.provider === 'broken'
            ? { rerank: failing, getName: () => 'broken' }
            : { rerank: working, getName: () => 'healthy' },
      }));

      const result = await service.rerank({
        query: 'q',
        documents: DOCS,
        strategy: 'cost',
        userContext: USER_CONTEXT,
        requestId: 'req_7',
      });

      expect(failing).toHaveBeenCalled();
      expect(working).toHaveBeenCalled();
      expect(result.provider).toBe('healthy');
      expect(result.fallbackUsed).toBe(true);
    });

    it('excludes adapters with no real rerank implementation from the pool', async () => {
      searchModelsComplete.mockResolvedValue([makeModel()]);
      // Adapter without a rerank method — the base-class throw case.
      resolveAdapterForModel.mockReturnValue({ adapter: { getName: () => 'no-rerank' } });

      await expect(
        service.rerank({
          query: 'q',
          documents: DOCS,
          userContext: USER_CONTEXT,
          requestId: 'req_8',
        })
      ).rejects.toThrow();
    });
  });

  describe('input validation', () => {
    it.each([
      ['empty query', { query: '   ', documents: DOCS }],
      ['no documents', { query: 'q', documents: [] as string[] }],
    ])('rejects %s before touching the catalog', async (_label, partial) => {
      await expect(
        service.rerank({
          ...partial,
          userContext: USER_CONTEXT,
          requestId: 'req_9',
        })
      ).rejects.toBeInstanceOf(ValidationError);
      expect(searchModelsComplete).not.toHaveBeenCalled();
    });

    it('rejects a document list beyond the vendor-wide cap', async () => {
      const documents = Array.from({ length: MAX_RERANK_DOCUMENTS + 1 }, (_, i) => `doc ${i}`);
      await expect(
        service.rerank({
          query: 'q',
          documents,
          userContext: USER_CONTEXT,
          requestId: 'req_10',
        })
      ).rejects.toThrow(/exceeds the maximum/);
    });

    it('rejects a non-string document rather than shipping it to the provider', async () => {
      await expect(
        service.rerank({
          query: 'q',
          documents: ['ok', 42 as unknown as string],
          userContext: USER_CONTEXT,
          requestId: 'req_11',
        })
      ).rejects.toThrow(/documents\[1\] must be a string/);
    });
  });
});
