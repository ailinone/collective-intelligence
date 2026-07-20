// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4A §12 — Pool builder × live-ready injection tests.
 *
 * Validates the integration of `injectLiveReadyCandidatesIntoRolePool`
 * into `buildConsensusRoleSpecificCandidatePools`:
 *   - default OFF → returns unchanged shape (no liveReadyInjection field)
 *   - ON + matching store entry → injects into per-role pools
 *   - dedupe against existing base pool
 *   - rejects state with no catalog match
 *   - cooldown_active state is filtered out (not injected)
 *   - per-role traces are emitted
 *
 * No DB, no fetch. The repository + store are both faked.
 */
import { describe, it, expect } from 'vitest';
import { buildConsensusRoleSpecificCandidatePools } from '@/core/orchestration/model-selection/role-specific-candidate-pool-builder';
import type {
  ModelRepositoryLike,
  LiveChatOperabilityStoreLike,
} from '@/core/orchestration/model-selection/role-specific-candidate-pool-builder';
import type { Model, ModelCapability } from '@/types';
import type { LiveChatOperabilityState } from '@/core/operability/live-chat-operability-state';

function mkModel(
  overrides: Partial<Model> & Pick<Model, 'id' | 'provider'>,
): Model {
  return {
    providerId: overrides.provider,
    name: overrides.id,
    displayName: overrides.id,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0003,
    capabilities: ['chat'] as ModelCapability[],
    performance: { latencyMs: 800, throughput: 100, quality: 0.8, reliability: 0.9 },
    status: 'active',
    metadata: {},
    ...overrides,
  } as Model;
}

function mkRepo(rows: Model[]): ModelRepositoryLike {
  return {
    async searchModels() {
      return rows;
    },
  };
}

function mkStore(states: LiveChatOperabilityState[]): LiveChatOperabilityStoreLike {
  return { snapshot: () => states };
}

function mkState(
  overrides: Partial<LiveChatOperabilityState> &
    Pick<LiveChatOperabilityState, 'providerId' | 'modelId'>,
): LiveChatOperabilityState {
  return {
    routeId: `${overrides.providerId}::${overrides.modelId}`,
    chatReady: true,
    eligibleForCriticalRole: true,
    successCountRecent: 1,
    failureCountRecent: 0,
    source: 'direct_chat_probe',
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as LiveChatOperabilityState;
}

describe('01C.1B-J1D-R4A — pool builder × live-ready injection', () => {
  it('default behavior: no injection flag → no liveReadyInjection field', async () => {
    const repo = mkRepo([
      mkModel({ id: 'gpt-4o-mini', provider: 'openai' }),
      mkModel({ id: 'claude-3.5-sonnet', provider: 'anthropic' }),
    ]);
    const r = await buildConsensusRoleSpecificCandidatePools({ repo });
    expect(r.liveReadyInjection).toBeUndefined();
    expect(r.sharedPool.length).toBe(2);
  });

  it('flag ON without store provided → no injection, no field', async () => {
    const repo = mkRepo([mkModel({ id: 'gpt-4o-mini', provider: 'openai' })]);
    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
    });
    expect(r.liveReadyInjection).toBeUndefined();
  });

  it('flag ON + store + chatReady state in catalog → injected into per-role pools', async () => {
    const liveReadyModel = mkModel({
      id: 'openai/gpt-oss-120b',
      provider: 'deepinfra',
    });
    const popularModel = mkModel({ id: 'gpt-4o-mini', provider: 'openai' });

    const repo = mkRepo([popularModel, liveReadyModel]);
    const store = mkStore([
      mkState({ providerId: 'deepinfra', modelId: 'openai/gpt-oss-120b' }),
    ]);

    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });

    expect(r.liveReadyInjection).toBeDefined();
    expect(r.liveReadyInjection?.enabled).toBe(true);
    expect(r.liveReadyInjection?.source).toBe('live_operability_store');

    const participantTrace = r.liveReadyInjection!.byRole.find((b) => b.role === 'participant');
    expect(participantTrace).toBeDefined();
    // Both models are in the catalog AND the live-ready model is among them,
    // so it's a dedupe match (already-present) — not a new injection.
    expect(
      (participantTrace!.injectedLiveReadyCount ?? 0) +
        (participantTrace!.dedupedExistingLiveReadyCount ?? 0),
    ).toBeGreaterThanOrEqual(1);
  });

  it('chatReady state NOT in catalog → rejected (live_ready_state_not_in_catalog)', async () => {
    const repo = mkRepo([mkModel({ id: 'gpt-4o-mini', provider: 'openai' })]);
    const store = mkStore([
      mkState({ providerId: 'mystery-provider', modelId: 'unknown-model-9000' }),
    ]);

    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });

    const t = r.liveReadyInjection!.byRole[0];
    expect(t.injectedLiveReadyCount).toBe(0);
    expect(t.rejectionCounts).toHaveProperty('live_ready_state_not_in_catalog');
  });

  it('cooldown_active state is filtered out (never reaches injector)', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const liveReadyModel = mkModel({
      id: 'openai/gpt-oss-120b',
      provider: 'deepinfra',
    });
    const repo = mkRepo([liveReadyModel]);
    const store = mkStore([
      mkState({
        providerId: 'deepinfra',
        modelId: 'openai/gpt-oss-120b',
        chatReady: false,
        cooldownUntil: future,
      }),
    ]);

    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });

    expect(r.liveReadyInjection?.byRole[0]?.injectedLiveReadyCount ?? 0).toBe(0);
  });

  it('dedupe: live-ready model already in base pool → not added twice', async () => {
    const liveReadyModel = mkModel({
      id: 'openai/gpt-oss-120b',
      provider: 'deepinfra',
    });
    // Catalog returns the live-ready model so it's both in the base
    // pool AND matched by the live-ready state.
    const repo = mkRepo([liveReadyModel]);
    const store = mkStore([
      mkState({ providerId: 'deepinfra', modelId: 'openai/gpt-oss-120b' }),
    ]);

    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });

    expect(r.sharedPool.length).toBe(1);
    const t = r.liveReadyInjection!.byRole[0];
    // The model was already in base — should be dedupe-matched, not re-injected.
    expect(t.injectedLiveReadyCount).toBe(0);
    expect(t.dedupedExistingLiveReadyCount).toBe(1);
  });

  it('per-role traces emitted for participant + synthesizer + judge + fallback', async () => {
    const liveReadyModel = mkModel({
      id: 'openai/gpt-oss-120b',
      provider: 'deepinfra',
    });
    const repo = mkRepo([liveReadyModel]);
    const store = mkStore([
      mkState({ providerId: 'deepinfra', modelId: 'openai/gpt-oss-120b' }),
    ]);
    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });
    const roles = new Set(r.liveReadyInjection!.byRole.map((b) => b.role));
    expect(roles).toEqual(new Set(['participant', 'synthesizer', 'judge', 'fallback']));
  });

  it('snapshot hash propagates into liveReadyInjection.snapshotHash', async () => {
    const repo = mkRepo([
      mkModel({ id: 'openai/gpt-oss-120b', provider: 'deepinfra' }),
    ]);
    const store = mkStore([
      mkState({ providerId: 'deepinfra', modelId: 'openai/gpt-oss-120b' }),
    ]);
    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
      liveOperabilitySnapshotHash: 'sha256-stub-abc',
      liveOperabilitySnapshotPath: '/tmp/snap.json',
    });
    expect(r.liveReadyInjection?.snapshotHash).toBe('sha256-stub-abc');
    expect(r.liveReadyInjection?.snapshotPath).toBe('/tmp/snap.json');
  });

  it('multiple live-ready states injected for distinct catalog rows', async () => {
    const models = [
      mkModel({ id: 'openai/gpt-oss-120b', provider: 'deepinfra' }),
      mkModel({ id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', provider: 'huggingface' }),
    ];
    const repo = mkRepo(models);
    const store = mkStore([
      mkState({ providerId: 'deepinfra', modelId: 'openai/gpt-oss-120b' }),
      mkState({
        providerId: 'huggingface',
        modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      }),
    ]);
    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });
    const participantTrace = r.liveReadyInjection!.byRole.find((b) => b.role === 'participant')!;
    // Both states are in base catalog → both should be dedupe-matched
    expect(participantTrace.catalogMatches).toBe(2);
  });

  it('empty store snapshot → enabled, but zero injected, zero rejected', async () => {
    const repo = mkRepo([mkModel({ id: 'gpt-4o-mini', provider: 'openai' })]);
    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: mkStore([]),
    });
    expect(r.liveReadyInjection?.enabled).toBe(true);
    for (const trace of r.liveReadyInjection!.byRole) {
      expect(trace.injectedLiveReadyCount).toBe(0);
      expect(trace.dedupedExistingLiveReadyCount).toBe(0);
    }
  });

  it('does NOT use provider-only readiness (provider OR model mismatch → no match)', async () => {
    const repo = mkRepo([
      mkModel({ id: 'openai/gpt-oss-120b', provider: 'deepinfra' }),
    ]);
    // Store has deepinfra but a different model id
    const store = mkStore([
      mkState({ providerId: 'deepinfra', modelId: 'some/other-model' }),
    ]);
    const r = await buildConsensusRoleSpecificCandidatePools({
      repo,
      injectLiveReadyFromStore: true,
      liveOperabilityStore: store,
    });
    expect(r.liveReadyInjection!.byRole[0].injectedLiveReadyCount).toBe(0);
    // The mismatched (deepinfra, some/other-model) should be rejected as
    // not_in_catalog (since the catalog doesn't have that pair).
    expect(
      r.liveReadyInjection!.byRole[0].rejectionCounts.live_ready_state_not_in_catalog,
    ).toBeGreaterThanOrEqual(1);
  });

  it('default behavior preserved: roleCandidateStats shape unchanged when injection OFF', async () => {
    const repo = mkRepo([mkModel({ id: 'gpt-4o-mini', provider: 'openai' })]);
    const r = await buildConsensusRoleSpecificCandidatePools({ repo });
    expect(r.roleCandidateStats.participant.source).toBe('shared_pool');
    expect(r.roleCandidateStats.fallback.source).toBe('shared_pool');
  });
});
