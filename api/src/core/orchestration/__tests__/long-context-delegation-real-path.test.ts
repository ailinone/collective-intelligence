// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Long-context delegation — REAL call-path proof (2026-09 follow-up).
 *
 * The original bug (2026-09 audit): `buildContext()`'s session-affinity
 * pin-reuse branch only called `applyLongContextHandling()` when
 * `passesContextWindow` was true (`contextSize < pinnedModel.contextWindow`).
 * But `applyLongContextHandling()`'s own delegation trigger
 * (`pickDelegationModel()`) only fires when the request does NOT fit —
 * mutually exclusive conditions, so delegation was unreachable from any real
 * request. The wiring test that shipped alongside `pickDelegationModel()`
 * (`context-compaction-delegation-wiring.test.ts`) called
 * `applyLongContextHandling()` DIRECTLY with a hand-fed `contextSize` the
 * real caller could never produce — proving the callee worked while missing
 * that the caller could never reach it. That is exactly the gap this file
 * closes: it drives `OrchestrationEngine.buildContext()` itself — the actual
 * caller containing the fixed gate — from realistic top-level inputs
 * (organizationId/userId/request), through a REAL session-affinity read (a
 * fake in-memory Redis client stands in for the network boundary only; the
 * actual `SessionAffinityService` read/decode logic runs unmodified), REAL
 * `ContextCompactionService` compaction, and REAL `pickDelegationModel()`
 * selection — and asserts on the resulting `OrchestrationContext`.
 *
 * `buildContext()` is private; called here via the same `as unknown as {...}`
 * cast this test suite already uses for `applyLongContextHandling()` and
 * `observer-nonstreaming-wiring.test.ts` uses for `wireObserverFeed()`. The
 * only faked collaborators are true I/O boundaries this suite cannot boot
 * (the Prisma-backed model catalog and central-discovery services, and
 * Redis) — `providerRegistry.findModel` is faked the same way the sibling
 * wiring suite already does. Without the catalog/discovery mocks below,
 * `buildContext()` still WORKS (both are wrapped in try/catch, "non-critical"
 * per the source) but pays a real multi-second TCP-connect-timeout tax on
 * its first call in-process — mocked here purely for test speed/hermeticity,
 * not because the fallback behavior needed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/model-catalog-service', () => ({
  // Forces buildContext()'s try/catch fallback to `providerRegistry.getAllModels()`
  // — the real Prisma-backed catalog is unavailable in this hermetic suite.
  getChatEligibleModels: () => Promise.reject(new Error('no db in hermetic test')),
}));

vi.mock('@/services/central-model-discovery-service', () => ({
  // buildContext()'s balance-enrichment step ("non-critical", already
  // try/catch-wrapped in the source) otherwise pays a real connection-
  // timeout tax on its first call in-process — reject fast instead.
  getCentralModelDiscoveryService: () => Promise.reject(new Error('no discovery service in hermetic test')),
}));

// In-memory stand-in for the ONE thing SessionAffinityService talks to over
// the network. Everything else about session affinity (key derivation,
// hashing, the lookup()/recordOutcome() methods themselves) is the REAL
// module, imported unmocked below.
const fakeRedisStore = new Map<string, Record<string, string>>();
vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    hgetall: async (key: string) => fakeRedisStore.get(key) ?? {},
    hset: async (key: string, fields: Record<string, string>) => {
      fakeRedisStore.set(key, { ...(fakeRedisStore.get(key) ?? {}), ...fields });
      return 'OK';
    },
    hincrby: async (key: string, field: string, amount: number) => {
      const current = fakeRedisStore.get(key) ?? {};
      const next = (Number(current[field]) || 0) + amount;
      fakeRedisStore.set(key, { ...current, [field]: String(next) });
      return next;
    },
    expire: async () => 1,
  }),
}));

import { OrchestrationEngine } from '../orchestration-engine';
import { __resetContextCompactionServiceForTests } from '../context-compaction-service';
import {
  __resetSessionAffinityServiceForTests,
  buildAffinityRedisKey,
  deriveSessionKey,
  resolveAffinityIdentifier,
} from '@/services/session-affinity-service';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ProviderRegistry } from '@/providers/provider-registry';

const adapter = { getName: () => 'fake-adapter' } as unknown as ProviderAdapter;

function model(overrides: {
  id: string;
  provider: string;
  contextWindow: number;
  quality?: number;
  balanceStatus?: Model['balanceStatus'];
}): Model {
  return {
    id: overrides.id,
    providerId: overrides.provider,
    provider: overrides.provider,
    name: overrides.id,
    displayName: overrides.id,
    contextWindow: overrides.contextWindow,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat', 'text_generation'],
    performance: { latencyMs: 100, throughput: 10, quality: overrides.quality ?? 0.5, reliability: 0.9 },
    status: 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
  } as Model;
}

function bigTurn(role: 'user' | 'assistant', n: number): { role: 'user' | 'assistant'; content: string } {
  return { role, content: `turn-${n}-${'x'.repeat(2000)}` };
}

function makeRequest(turnCount: number): ChatRequest {
  const messages: ChatRequest['messages'] = [{ role: 'system', content: 'be helpful' }];
  for (let i = 0; i < turnCount; i++) {
    messages.push(bigTurn(i % 2 === 0 ? 'user' : 'assistant', i));
  }
  return {
    model: 'auto',
    messages,
    stream: false,
    ailin_session_scope: { conversationId: 'conv-real-path-1' },
  } as unknown as ChatRequest;
}

function makeEngine(models: Model[]): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => models,
      findModel: async (modelId: string, preferredProvider?: string) => {
        const found = preferredProvider
          ? models.find((m) => m.id === modelId && m.provider === preferredProvider)
          : models.find((m) => m.id === modelId);
        return found ? { model: found, adapter } : null;
      },
      findModelByName: async () => null,
      getProviderNames: () => Array.from(new Set(models.map((m) => m.provider))),
      getModelOperability: () => ({ runnable: true, resolvedProvider: 'acme', nonOperationalReasons: [] }),
    } as unknown as ProviderRegistry,
    enableTriaging: false, // no LLM triage call — deterministic, hermetic
  });
}

type BuildContext = (
  request: ChatRequest,
  organizationId: string,
  userId: string | undefined,
  requestId: string
) => Promise<OrchestrationContext>;

function callBuildContext(
  engine: OrchestrationEngine,
  ...args: Parameters<BuildContext>
): Promise<OrchestrationContext> {
  return (engine as unknown as { buildContext: BuildContext }).buildContext(...args);
}

/** Seed the fake Redis store with a session-affinity hit for this exact
 *  request, using the REAL key-derivation functions (never a guessed key). */
function seedAffinityHit(
  organizationId: string,
  userId: string,
  request: ChatRequest,
  pinnedModelId: string,
  pinnedProvider: string
): void {
  const identifier = resolveAffinityIdentifier({ userId, apiKeyId: undefined });
  const sessionKey = deriveSessionKey(request);
  const key = buildAffinityRedisKey(organizationId, identifier, sessionKey);
  fakeRedisStore.set(key, {
    modelId: pinnedModelId,
    provider: pinnedProvider,
    lastUsedAt: String(Date.now()),
    turnCount: '3',
  });
}

describe('OrchestrationEngine.buildContext() — long-context delegation, real call path', () => {
  const ORG = 'org-real-path';
  const USER = 'user-real-path';

  beforeEach(() => {
    fakeRedisStore.clear();
    __resetSessionAffinityServiceForTests();
    __resetContextCompactionServiceForTests();
    delete process.env.SESSION_AFFINITY_ENABLED;
    delete process.env.CONTEXT_COMPACTION_KEEP_TURNS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'an over-budget session-affinity pin is delegated to a larger sibling — through the real buildContext() gate, not by hand-feeding applyLongContextHandling()',
    async () => {
      const pinnedSmall = model({ id: 'pinned-small', provider: 'acme', contextWindow: 2_000 });
      const sameProviderBig = model({
        id: 'big-same',
        provider: 'acme',
        contextWindow: 200_000,
        quality: 0.9,
      });
      const pool = [pinnedSmall, sameProviderBig];

      const engine = makeEngine(pool);
      // 12 big turns ≈ far more than 2,000 tokens once estimated — the
      // pinned model's window is already blown BEFORE buildContext ever
      // runs, unlike the old wiring test's hand-fed 999_999 which the real
      // gate could never produce.
      const request = makeRequest(12);
      seedAffinityHit(ORG, USER, request, pinnedSmall.id, pinnedSmall.provider);

      const context = await callBuildContext(engine, request, ORG, USER, 'req-1');

      // The REAL fix: the pin was over budget, yet buildContext() still
      // attempted (and here, succeeded at) long-context handling instead of
      // dropping straight to a passesContextWindow-failed fallback.
      expect(context.precomputedModelSelection?.model.id).toBe('big-same');
      expect(context.preferredModelIds).toEqual(['big-same']);

      // Compaction (the primary mechanism) also actually ran against the
      // real request messages, proving the whole chain fired, not just the
      // tail end.
      expect(request.messages.length).toBeLessThan(13); // system + 12 turns compacted down
      expect(
        request.messages.some((m) => (m as { isCompactionSummary?: boolean }).isCompactionSummary)
      ).toBe(true);
    },
    90_000
  );

  it('a pin that already fits is reused as-is — no unnecessary compaction/delegation churn', async () => {
    const pinnedRoomy = model({ id: 'pinned-roomy', provider: 'acme', contextWindow: 500_000 });
    const pool = [pinnedRoomy];

    const engine = makeEngine(pool);
    const request: ChatRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hello' },
      ],
      stream: false,
      ailin_session_scope: { conversationId: 'conv-real-path-2' },
    } as unknown as ChatRequest;
    seedAffinityHit(ORG, USER, request, pinnedRoomy.id, pinnedRoomy.provider);

    const context = await callBuildContext(engine, request, ORG, USER, 'req-2');

    expect(context.precomputedModelSelection?.model.id).toBe('pinned-roomy');
    expect(request.messages).toHaveLength(2); // untouched — nothing to compact
  });

  it('a pin that fails capability re-validation (tools requested, function_calling not declared) is dropped, not silently reused', async () => {
    const pinnedNoTools = model({ id: 'pinned-no-tools', provider: 'acme', contextWindow: 500_000 });
    const pool = [pinnedNoTools];

    const engine = makeEngine(pool);
    const request: ChatRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'call a tool please' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      stream: false,
      ailin_session_scope: { conversationId: 'conv-real-path-3' },
    } as unknown as ChatRequest;
    seedAffinityHit(ORG, USER, request, pinnedNoTools.id, pinnedNoTools.provider);

    const context = await callBuildContext(engine, request, ORG, USER, 'req-3');

    // The pin declares no function_calling capability but the request needs
    // tools — admission must refuse it and fall through to fresh selection
    // (no precomputed pin left for SingleModelStrategy to blindly trust).
    expect(context.precomputedModelSelection).toBeUndefined();
  });
});
