// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ImagesOrchestrationService — attribute-aware candidate pre-filter (Task 10,
 * LOTE AZ 2026-09-23).
 *
 * Wires the generic `canSatisfyCapabilityAttributes` dispatcher into
 * `resolveImageCatalog`, mirroring `video-orchestration-service.ts`'s
 * `canSatisfyVideoAttributes` wiring (see that file's
 * "attribute-aware selection" describe block in
 * video-orchestration-service.test.ts for the analogous video coverage).
 *
 * Fail-open contract: a candidate whose DECLARED image capabilityAttributes
 * conflict with the request (e.g. a maxDimensions ceiling smaller than the
 * requested size) is excluded. A candidate with NO declared capabilityAttributes
 * is never excluded — almost no provider has image_generation attributes
 * populated yet, so this must be a no-op for essentially all current traffic.
 *
 * Mocking pattern matches images-orchestration-best-of-n.test.ts
 * (searchModelsComplete/findModelsByIdOrName/resolveAdapterForModel), plus
 * the PROVIDER_CATALOG mock convention from
 * services/catalog/__tests__/capability-attribute-store.test.ts.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Model, OrchestrationContext } from '@/types';

const searchModelsComplete = vi.fn();
const findModelsByIdOrName = vi.fn();

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModelsComplete = searchModelsComplete;
    findModelsByIdOrName = findModelsByIdOrName;
  },
}));

const resolveAdapterForModel = vi.fn();
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ resolveAdapterForModel }),
}));

vi.mock('@/providers/provider-operability', () => ({
  isAdapterMethodImplemented: (adapter: Record<string, unknown>, methodName: string) =>
    typeof adapter[methodName] === 'function',
}));

vi.mock('@/providers/catalog/providers.catalog', () => ({
  PROVIDER_CATALOG: [
    {
      providerId: 'provider-a',
      capabilityAttributes: {
        image_generation: { maxDimensions: '512x512' },
      },
    },
    { providerId: 'provider-b' },
  ],
}));

import { ImagesOrchestrationService } from '../images-orchestration-service';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeModel(id: string, provider: string, overrides: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    displayName: id,
    provider,
    capabilities: ['image_generation'],
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.02,
    performance: { latencyMs: 2000, throughput: 1, quality: 0.7, reliability: 1 },
    status: 'active',
    ...overrides,
  } as unknown as Model;
}

/** Wires a fixed candidate pool through per-provider adapter mocks. */
function wirePool(models: Model[], adaptersByProvider: Record<string, { imageGenerate: Mock }>): void {
  searchModelsComplete.mockResolvedValue(models);
  resolveAdapterForModel.mockImplementation((model: Model) => ({
    adapter: { ...adaptersByProvider[model.provider], getName: () => model.provider },
    operability: {},
  }));
}

const OK_IMAGE_RESPONSE = {
  image: [{ url: 'https://example.com/generated.png' }],
  format: 'png',
  raw: {},
};

describe('ImagesOrchestrationService — attribute-aware pre-filter (Task 10)', () => {
  let service: ImagesOrchestrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImagesOrchestrationService();
  });

  describe('capabilityAttributes', () => {
    it('excludes a candidate whose declared maxDimensions is smaller than the requested size, and keeps a candidate with no declared attributes (fail-open)', async () => {
      const modelA = makeModel('model-a', 'provider-a');
      const modelB = makeModel('model-b', 'provider-b');

      const genA = vi.fn().mockResolvedValue(OK_IMAGE_RESPONSE);
      const genB = vi.fn().mockResolvedValue(OK_IMAGE_RESPONSE);

      wirePool([modelA, modelB], {
        'provider-a': { imageGenerate: genA },
        'provider-b': { imageGenerate: genB },
      });

      const result = await service.generateImages({
        prompt: 'a wide panoramic mountain vista',
        n: 1,
        size: '1792x1024',
        quality: 'standard',
        responseFormat: 'url',
        style: 'vivid',
        userContext: USER_CONTEXT,
        requestId: 'req_attr_1',
      });

      // provider-a's declared 512x512 ceiling cannot satisfy 1792x1024 — it
      // must never be called.
      expect(genA).not.toHaveBeenCalled();
      // provider-b declares no capabilityAttributes at all — fail-open means
      // it is NOT excluded, and is the only candidate left to serve the request.
      expect(genB).toHaveBeenCalledTimes(1);
      expect(result.modelUsed).toBe('model-b');
      expect(result.provider).toBe('provider-b');
    });

    it('editImage: excludes a candidate whose OWN declared image_generation attributes violate the request, even though the OTHER requested capability (image_editing) is undeclared for it — regression for the multi-capability .some() masking bug', async () => {
      // model-a only declares `image_generation` (not `image_editing`), and
      // provider-a's catalog entry caps image_generation at 512x512 —
      // smaller than the requested edit size. Before the fix, `.some()`
      // over ['image_editing', 'image_generation'] would short-circuit on
      // `image_editing` (undeclared for provider-a -> fail-open `true`)
      // before ever evaluating the `image_generation` violation, so model-a
      // would incorrectly survive the filter.
      //
      // model-a is deliberately the ONLY candidate in the pool: if it were
      // mixed with an always-eligible model-b, the assertion would only prove
      // "the fallback tried the first-ranked candidate that happened to
      // succeed," not "model-a was excluded from the filtered pool." With
      // model-a alone, correct filtering must empty the pool and reject with
      // NoFallbackCandidateError; the bug instead lets model-a through and the
      // edit succeeds.
      const modelA = makeModel('model-a', 'provider-a', { capabilities: ['image_generation'] });

      const editA = vi.fn().mockResolvedValue(OK_IMAGE_RESPONSE);

      searchModelsComplete.mockImplementation(
        async ({ capabilities }: { capabilities: string[] }) => {
          if (capabilities.includes('image_generation')) return [modelA];
          return [];
        }
      );
      resolveAdapterForModel.mockImplementation((model: Model) => ({
        adapter: { imageEdit: editA, getName: () => model.provider },
        operability: {},
      }));

      // provider-a's declared image_generation ceiling (512x512) cannot
      // satisfy the requested 1024x1024 edit, so — once the OWN-capability
      // intersection fix is applied — model-a must be filtered out entirely,
      // leaving an empty candidate pool and a rejection. edit must never be
      // called, regardless of image_editing being undeclared for provider-a.
      await expect(
        service.editImage({
          image: Buffer.from('fake-image'),
          prompt: 'make it brighter',
          n: 1,
          size: '1024x1024',
          responseFormat: 'url',
          userContext: USER_CONTEXT,
          requestId: 'req_attr_2',
        })
      ).rejects.toThrow();
      expect(editA).not.toHaveBeenCalled();
    });
  });
});
