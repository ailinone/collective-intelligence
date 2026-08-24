// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level tests for exposing the ailin-* first-party virtual model aliases
 * on GET /v1/models, GET /v1/models/list and GET /v1/models/:id.
 *
 * Contract under test (see models-routes.ts + models-list-serialization.ts):
 * - Alias rows are emitted FIRST and reuse the exact buildModelDto row shape
 *   (discoverySource: 'ailin-virtual').
 * - They are additive: counted in counts.aliases ONLY — never in
 *   counts.catalog/runnable/scoped/matched — and never consume page slots
 *   (limit/offset apply to the DB-derived result set only).
 * - GET /v1/models/:id resolves an alias id to the same DTO the list emits.
 *
 * The catalog service and prisma client are mocked so no DB is needed; the
 * route's runtime-signal query fails soft (empty map) exactly as it does when
 * the DB is unreachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Model } from '@/types';
import type { ProviderRegistry } from '@/providers/provider-registry';

const catalogDataset = vi.hoisted((): Model[] => [
  {
    id: 'openai-gpt-test',
    providerId: 'openai',
    provider: 'openai',
    name: 'gpt-test',
    displayName: 'GPT Test',
    contextWindow: 8_000,
    maxOutputTokens: 1_024,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    // quality 0.98 → rank ≈ 148, clearly above anthropic's ≈ 146.5, so the
    // DB-derived ordering in assertions below is deterministic.
    capabilities: ['chat', 'streaming', 'function_calling'],
    performance: { latencyMs: 800, throughput: 120, quality: 0.98, reliability: 0.99 },
    status: 'active',
  },
  {
    id: 'anthropic-claude-test',
    providerId: 'anthropic',
    provider: 'anthropic',
    name: 'claude-test',
    displayName: 'Claude Test',
    contextWindow: 100_000,
    maxOutputTokens: 4_096,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'streaming', 'function_calling'],
    performance: { latencyMs: 1_200, throughput: 80, quality: 0.95, reliability: 0.99 },
    status: 'active',
  },
]);

vi.mock('@/services/model-catalog-service', () => ({
  getAllCatalogModels: async () => catalogDataset.map((model) => ({ ...model })),
  getModelById: async (modelId: string) => {
    const found = catalogDataset.find((model) => model.id === modelId);
    return found ? { ...found } : null;
  },
}));

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: vi.fn().mockRejectedValue(new Error('db unavailable in unit test')),
  },
}));

import { registerModelRoutes } from '@/routes/models/models-routes';

const DEFAULT_ALIAS_IDS = [
  'ailin-auto',
  'ailin-best',
  'ailin-fast',
  'ailin-economy',
  'ailin-consensus',
  'ailin-voice',
  'ailin-stt',
  'ailin-realtime',
];

/** Every catalog model is runnable under the stub registry below. */
const stubRegistry = {
  getModelOperability: (model: Model) => ({
    runnable: true,
    originProvider: model.provider,
    executionProvider: model.provider,
    resolvedProvider: model.provider,
    fallbackChain: [model.provider],
    nonOperationalReasons: [],
    warnings: [],
  }),
} as unknown as ProviderRegistry;

describe('Ailin virtual model aliases on /v1/models*', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    // Pin the default profile set — env-configured custom profiles would
    // change the alias count these tests assert against.
    delete process.env.AILIN_VIRTUAL_MODEL_PROFILES;
    delete process.env.AILIN_AUTO_MODEL_ALIASES;

    app = Fastify();
    await registerModelRoutes(app, stubRegistry);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /v1/models (bounded default path)', () => {
    it('lists the 8 default aliases FIRST, before catalog rows', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.statusCode).toBe(200);
      const payload = response.json();

      const ids: string[] = payload.data.map((row: { id: string }) => row.id);
      expect(ids.slice(0, DEFAULT_ALIAS_IDS.length)).toEqual(DEFAULT_ALIAS_IDS);
      // Catalog rows follow, unchanged.
      expect(ids.slice(DEFAULT_ALIAS_IDS.length)).toEqual([
        'openai-gpt-test',
        'anthropic-claude-test',
      ]);
      expect(payload.data.length).toBe(10);
    });

    it('emits alias rows in the exact serializer DTO shape (key parity with catalog rows)', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      const payload = response.json();

      const aliasRow = payload.data[0];
      const catalogRow = payload.data[DEFAULT_ALIAS_IDS.length];

      // Same buildModelDto builder → identical key set.
      expect(Object.keys(aliasRow).sort()).toEqual(Object.keys(catalogRow).sort());

      expect(aliasRow).toEqual(
        expect.objectContaining({
          id: 'ailin-auto',
          name: 'ailin-auto',
          displayName: 'Ailin Auto',
          provider: 'ailin-virtual',
          originProvider: 'ailin-virtual',
          executionProvider: 'ailin-virtual',
          resolvedProvider: null,
          runnable: true,
          operability: 'operational',
          nonOperationalReasons: [],
          warnings: [],
          discoverySource: 'ailin-virtual',
          discoveryTimestamp: null,
          inventoryClass: 'not-applicable-non-model-surface',
          contextWindow: 0,
          maxOutputTokens: 0,
          modalities: ['text'],
          endpoints: ['chat_completions', 'responses'],
          endpointCompatibility: { chat_completions: 'explicit', responses: 'explicit' },
          pricing: { inputCostPer1M: 0, outputCostPer1M: 0, currency: 'USD' },
          status: 'active',
        })
      );
      // NOTE: the route response schema declares `performance` as a bare
      // object, so the serializer flattens it to {} for EVERY row (pre-existing
      // behavior, identical for catalog rows). The :id endpoint exposes the
      // unflattened zeros — asserted in the :id describe block.
      expect(aliasRow.capabilities).toContain('chat');
      expect(aliasRow.fallbackChain).toEqual([]);
    });

    it('derives voice/stt/realtime alias capabilities and modalities from their endpoints', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      const byId = new Map<string, Record<string, unknown>>(
        response.json().data.map((row: Record<string, unknown>) => [row.id as string, row])
      );

      const voice = byId.get('ailin-voice')!;
      expect(voice.endpoints).toEqual(['audio_speech', 'audio_transcriptions', 'realtime']);
      expect(voice.modalities).toContain('audio');
      expect(voice.modalities).toContain('text');
      expect(voice.capabilities).toEqual(
        expect.arrayContaining(['text_to_speech', 'speech_to_text', 'realtime'])
      );

      const stt = byId.get('ailin-stt')!;
      expect(stt.endpoints).toEqual(['audio_transcriptions']);
      expect(stt.capabilities).toContain('speech_to_text');
      expect(stt.capabilities).not.toContain('chat');

      const realtime = byId.get('ailin-realtime')!;
      expect(realtime.endpoints).toEqual(['realtime']);
      expect(realtime.modalities).toEqual(['audio']);
    });

    it('keeps DB-derived counts unchanged and reports aliases separately', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      const payload = response.json();

      expect(payload.counts).toEqual({
        catalog: 2,
        runnable: 2,
        scoped: 2,
        matched: 2,
        returned: 10, // page rows + additive aliases (== data.length)
        aliases: 8,
      });
      expect(payload.pagination.total).toBe(2); // DB-derived set only
      expect(payload.pagination.limit).toBe(100);
      expect(payload.pagination.offset).toBe(0);
      expect(payload.pagination.hasMore).toBe(false);
      expect(payload.pagination.nextOffset).toBeNull();
      expect(payload.pagination.returned).toBe(payload.data.length);
    });

    it('does not let aliases consume page slots (limit/offset apply to DB rows only)', async () => {
      const first = (
        await app.inject({ method: 'GET', url: '/v1/models?limit=1&offset=0' })
      ).json();
      expect(first.data.length).toBe(9); // 8 additive aliases + 1 DB row
      expect(first.data[DEFAULT_ALIAS_IDS.length].id).toBe('openai-gpt-test');
      expect(first.pagination).toEqual({
        limit: 1,
        offset: 0,
        total: 2,
        returned: 9,
        hasMore: true,
        nextOffset: 1,
      });
      expect(first.counts.matched).toBe(2);
      expect(first.counts.aliases).toBe(8);

      const second = (
        await app.inject({ method: 'GET', url: '/v1/models?limit=1&offset=1' })
      ).json();
      expect(second.data.length).toBe(9); // aliases ride on top of every page
      expect(second.data[DEFAULT_ALIAS_IDS.length].id).toBe('anthropic-claude-test');
      expect(second.pagination.hasMore).toBe(false);
      expect(second.pagination.total).toBe(2);

      // Beyond the DB set: empty DB page, aliases still present.
      const beyond = (
        await app.inject({ method: 'GET', url: '/v1/models?limit=1&offset=2' })
      ).json();
      expect(beyond.data.map((row: { id: string }) => row.id)).toEqual(DEFAULT_ALIAS_IDS);
      expect(beyond.pagination.hasMore).toBe(false);
    });

    it('applies the ?endpoint= filter to aliases as well', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models?endpoint=realtime' });
      const payload = response.json();

      expect(payload.data.map((row: { id: string }) => row.id)).toEqual([
        'ailin-voice',
        'ailin-realtime',
      ]);
      expect(payload.counts.matched).toBe(0); // no DB rows matched
      expect(payload.counts.aliases).toBe(2);
      expect(payload.counts.returned).toBe(2);
      expect(payload.endpointFilter).toBe('realtime');
    });
  });

  describe('GET /v1/models/list', () => {
    it('exposes the same alias surface as /v1/models (shared handler)', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models/list' });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.data.slice(0, DEFAULT_ALIAS_IDS.length).map((r: { id: string }) => r.id)).toEqual(
        DEFAULT_ALIAS_IDS
      );
      expect(payload.counts.aliases).toBe(8);
      expect(payload.counts.catalog).toBe(2);
    });
  });

  describe('GET /v1/models ?all=true (streamed path)', () => {
    it('streams aliases first, keeps DB-derived counts, reports aliases separately', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models?all=true' });
      expect(response.statusCode).toBe(200);
      const payload = response.json();

      const ids: string[] = payload.data.map((row: { id: string }) => row.id);
      expect(ids.slice(0, DEFAULT_ALIAS_IDS.length)).toEqual(DEFAULT_ALIAS_IDS);
      expect(ids.length).toBe(10);
      expect(payload.counts).toEqual({
        catalog: 2,
        runnable: 2,
        scoped: 2,
        matched: 2,
        returned: 10,
        aliases: 8,
      });

      // Streamed rows must be shape-identical to bounded rows.
      const aliasRow = payload.data[0];
      const catalogRow = payload.data[DEFAULT_ALIAS_IDS.length];
      expect(Object.keys(aliasRow).sort()).toEqual(Object.keys(catalogRow).sort());
    });
  });

  describe('GET /v1/models/:id', () => {
    it('resolves an alias id to the SAME DTO the list emits', async () => {
      const listRow = (
        await app.inject({ method: 'GET', url: '/v1/models' })
      ).json().data.find((row: { id: string }) => row.id === 'ailin-best');

      const response = await app.inject({ method: 'GET', url: '/v1/models/ailin-best' });
      expect(response.statusCode).toBe(200);
      // Same buildModelDto output; the list's response schema flattens
      // `performance` to {} (pre-existing, applies to every row), so restore
      // it before comparing.
      expect(response.json()).toEqual({
        ...listRow,
        performance: { latencyMs: 0, throughput: 0, quality: 0, reliability: 0 },
      });
    });

    it('resolves every default alias id', async () => {
      for (const aliasId of DEFAULT_ALIAS_IDS) {
        const response = await app.inject({ method: 'GET', url: `/v1/models/${aliasId}` });
        expect(response.statusCode, aliasId).toBe(200);
        const row = response.json();
        expect(row.id).toBe(aliasId);
        expect(row.provider).toBe('ailin-virtual');
        expect(row.discoverySource).toBe('ailin-virtual');
        expect(row.operability).toBe('operational');
      }
    });

    it('still serves catalog models by id and 404s unknown ids', async () => {
      const ok = await app.inject({ method: 'GET', url: '/v1/models/openai-gpt-test' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().id).toBe('openai-gpt-test');

      const missing = await app.inject({ method: 'GET', url: '/v1/models/nope-does-not-exist' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('model_not_found');
    });
  });
});
