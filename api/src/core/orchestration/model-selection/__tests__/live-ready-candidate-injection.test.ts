// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4A §8 — Unit tests for live-ready candidate injection helper.
 *
 * Pure: no I/O, no Postgres, no Redis, no provider calls. All callbacks
 * are injected; the SUT is deterministic given the same inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLiveReadyCandidateDedupeKey,
  injectLiveReadyCandidatesIntoRolePool,
  isStateCurrentlyEligible,
  DEFAULT_LIVE_READY_INJECTION_POLICY,
  type LiveReadyCandidateInjectionPolicy,
} from '@/core/orchestration/model-selection/live-ready-candidate-injection';

type FakeCandidate = {
  id: string;
  providerId: string;
  apiModelId?: string;
  routeId?: string;
  caps: readonly string[];
  injectedByLiveReadyStore?: boolean;
  liveReadyEvidenceSource?: string;
};

type FakeState = {
  providerId: string;
  routeId: string;
  modelId: string;
  chatReady: boolean;
  eligibleForCriticalRole: boolean;
  cooldownUntil?: string;
  logicalRole?: string;
};

function mkCandidate(
  overrides: Partial<FakeCandidate> & Pick<FakeCandidate, 'id' | 'providerId'>,
): FakeCandidate {
  return {
    apiModelId: overrides.id,
    routeId: `${overrides.providerId}::${overrides.id}`,
    caps: ['chat'],
    ...overrides,
  };
}

const projectCandidateKey = (c: FakeCandidate, role: string) =>
  buildLiveReadyCandidateDedupeKey({
    role,
    logicalModelId: c.id,
    providerId: c.providerId,
    apiModelId: c.apiModelId,
    routeId: c.routeId,
  });

const projectStateKey = (s: FakeState, role: string) =>
  buildLiveReadyCandidateDedupeKey({
    role,
    logicalModelId: s.modelId,
    providerId: s.providerId,
    apiModelId: s.modelId,
    routeId: s.routeId,
  });

const attachInjectionMetadata = (
  c: FakeCandidate,
): FakeCandidate => ({
  ...c,
  injectedByLiveReadyStore: true,
  liveReadyEvidenceSource: 'live_operability_store',
});

const projectStateForTrace = (s: FakeState) => ({
  logicalModelId: s.modelId,
  providerId: s.providerId,
  apiModelId: s.modelId,
  routeId: s.routeId,
  source: 'live_operability_store' as const,
});

const stateIsEligible = (s: FakeState) => isStateCurrentlyEligible(s);
const stateProvider = (s: FakeState) => s.providerId;
const stateModel = (s: FakeState) => s.modelId;
const stateLogicalRole = (s: FakeState) => s.logicalRole;
const candidateSupportsRole = (c: FakeCandidate) => c.caps.includes('chat');

// ─── isStateCurrentlyEligible ────────────────────────────────────────────

describe('isStateCurrentlyEligible', () => {
  it('rejects when chatReady=false', () => {
    expect(isStateCurrentlyEligible({ chatReady: false, eligibleForCriticalRole: true })).toBe(false);
  });
  it('rejects when eligibleForCriticalRole=false', () => {
    expect(isStateCurrentlyEligible({ chatReady: true, eligibleForCriticalRole: false })).toBe(false);
  });
  it('rejects when cooldownUntil is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      isStateCurrentlyEligible({ chatReady: true, eligibleForCriticalRole: true, cooldownUntil: future }),
    ).toBe(false);
  });
  it('accepts when cooldownUntil has expired', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      isStateCurrentlyEligible({ chatReady: true, eligibleForCriticalRole: true, cooldownUntil: past }),
    ).toBe(true);
  });
  it('accepts when no cooldown set', () => {
    expect(isStateCurrentlyEligible({ chatReady: true, eligibleForCriticalRole: true })).toBe(true);
  });
});

// ─── buildLiveReadyCandidateDedupeKey ────────────────────────────────────

describe('buildLiveReadyCandidateDedupeKey', () => {
  const base = {
    role: 'synthesizer',
    logicalModelId: 'gpt-oss-120b',
    providerId: 'deepinfra',
    apiModelId: 'openai/gpt-oss-120b',
    routeId: 'deepinfra::openai/gpt-oss-120b',
    adapterKind: 'openai-compatible-chat',
  };
  const baseKey = buildLiveReadyCandidateDedupeKey(base);

  it('changes when role changes', () => {
    expect(buildLiveReadyCandidateDedupeKey({ ...base, role: 'judge' })).not.toBe(baseKey);
  });
  it('changes when providerId changes', () => {
    expect(buildLiveReadyCandidateDedupeKey({ ...base, providerId: 'huggingface' })).not.toBe(baseKey);
  });
  it('changes when apiModelId changes', () => {
    expect(buildLiveReadyCandidateDedupeKey({ ...base, apiModelId: 'openai/gpt-oss-120b-Turbo' })).not.toBe(
      baseKey,
    );
  });
  it('changes when routeId changes', () => {
    expect(buildLiveReadyCandidateDedupeKey({ ...base, routeId: 'something-else' })).not.toBe(baseKey);
  });
  it('changes when adapterKind changes', () => {
    expect(buildLiveReadyCandidateDedupeKey({ ...base, adapterKind: 'openai-compatible-hub' })).not.toBe(
      baseKey,
    );
  });
  it('normalizes case + whitespace', () => {
    expect(buildLiveReadyCandidateDedupeKey({ ...base, providerId: ' DeepInfra ' })).toBe(baseKey);
  });
});

// ─── injectLiveReadyCandidatesIntoRolePool ───────────────────────────────

function baseInjectionArgs(overrides: Partial<{
  role: string;
  base: FakeCandidate[];
  states: FakeState[];
  resolver: (s: FakeState) => FakeCandidate | FakeCandidate[] | undefined;
  policy?: LiveReadyCandidateInjectionPolicy;
}> = {}) {
  return {
    role: overrides.role ?? 'synthesizer',
    baseCandidates: (overrides.base ?? []) as readonly FakeCandidate[],
    liveReadyStates: (overrides.states ?? []) as readonly FakeState[],
    resolveCatalogCandidate: overrides.resolver ?? ((s: FakeState) =>
      mkCandidate({ id: s.modelId, providerId: s.providerId, routeId: s.routeId, caps: ['chat'] })),
    candidateSupportsRole,
    projectCandidateKey,
    projectStateKey,
    attachInjectionMetadata,
    projectStateForTrace,
    stateIsEligible,
    stateLogicalRole,
    stateProvider,
    stateModel,
    policy: overrides.policy,
  };
}

describe('injectLiveReadyCandidatesIntoRolePool', () => {
  it('does NOT inject when policy.enabled=false', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'deepinfra::openai/gpt-oss-120b',
            modelId: 'openai/gpt-oss-120b',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
        policy: { ...DEFAULT_LIVE_READY_INJECTION_POLICY, enabled: false },
      }),
    );
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.catalogMatches).toBe(0);
  });

  it('rejects states that are not currently eligible', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: false,
            eligibleForCriticalRole: true,
          },
        ],
      }),
    );
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['not_live_ready']);
  });

  it('injects when liveReady + catalog match + capability OK', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'deepinfra::openai/gpt-oss-120b',
            modelId: 'openai/gpt-oss-120b',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
      }),
    );
    expect(r.injectedCandidates.length).toBe(1);
    expect(r.injectedCandidates[0].injectedByLiveReadyStore).toBe(true);
    expect(r.injectedCandidates[0].liveReadyEvidenceSource).toBe('live_operability_store');
    expect(r.catalogMatches).toBe(1);
  });

  it('does NOT inject when catalog resolver returns undefined', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
        resolver: () => undefined,
      }),
    );
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['live_ready_state_not_in_catalog']);
  });

  it('rejects ambiguous catalog match (>1 candidate)', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
        resolver: () => [
          mkCandidate({ id: 'm', providerId: 'deepinfra', apiModelId: 'm', routeId: 'r1', caps: ['chat'] }),
          mkCandidate({ id: 'm', providerId: 'deepinfra', apiModelId: 'm', routeId: 'r2', caps: ['chat'] }),
        ],
      }),
    );
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['ambiguous_catalog_match']);
  });

  it('dedupes a candidate already in the base pool (no double-count)', () => {
    const existing = mkCandidate({
      id: 'gpt-oss-120b',
      providerId: 'deepinfra',
      apiModelId: 'openai/gpt-oss-120b',
      routeId: 'deepinfra::openai/gpt-oss-120b',
      caps: ['chat'],
    });
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        base: [existing],
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'deepinfra::openai/gpt-oss-120b',
            modelId: 'gpt-oss-120b',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
        resolver: () => existing,
      }),
    );
    expect(r.injectedCandidates).toEqual([]);
    expect(r.dedupedExistingCandidates.length).toBe(1);
  });

  it('rejects capability_mismatch (e.g. judge needs json, candidate has no json)', () => {
    const r = injectLiveReadyCandidatesIntoRolePool({
      ...baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
        resolver: () => mkCandidate({ id: 'm', providerId: 'deepinfra', caps: ['something-else'] }),
      }),
      candidateSupportsRole: (c: FakeCandidate, _role: string) => c.caps.includes('chat'),
    });
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['capability_mismatch']);
  });

  it('attaches metadata.injectedByLiveReadyStore=true on every injection', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
      }),
    );
    expect(r.metadata.injectedByLiveReadyStore).toBe(true);
    for (const c of r.injectedCandidates) {
      expect(c.injectedByLiveReadyStore).toBe(true);
    }
  });

  it('disallows cross-role when policy.allowCrossRoleByCapabilities=false', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        role: 'judge',
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
            logicalRole: 'synthesizer',
          },
        ],
        policy: { ...DEFAULT_LIVE_READY_INJECTION_POLICY, allowCrossRoleByCapabilities: false },
      }),
    );
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['role_mismatch']);
  });

  it('allows cross-role when policy.allowCrossRoleByCapabilities=true (default)', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        role: 'judge',
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
            logicalRole: 'synthesizer',
          },
        ],
      }),
    );
    expect(r.injectedCandidates.length).toBe(1);
  });

  it('rejects state with missing provider OR model', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states: [
          {
            providerId: '',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
      }),
    );
    expect(r.rejected.map((x) => x.reason)).toEqual(['missing_provider_or_model']);
  });

  it('honors maxInjectedPerRole cap', () => {
    const states: FakeState[] = ['a', 'b', 'c'].map((m) => ({
      providerId: 'deepinfra',
      routeId: `r-${m}`,
      modelId: m,
      chatReady: true,
      eligibleForCriticalRole: true,
    }));
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        states,
        policy: { ...DEFAULT_LIVE_READY_INJECTION_POLICY, maxInjectedPerRole: 2 },
      }),
    );
    expect(r.injectedCandidates.length).toBe(2);
  });

  it('is deterministic with same input', () => {
    const args = baseInjectionArgs({
      states: [
        {
          providerId: 'deepinfra',
          routeId: 'r',
          modelId: 'm',
          chatReady: true,
          eligibleForCriticalRole: true,
        },
      ],
    });
    const r1 = injectLiveReadyCandidatesIntoRolePool(args);
    const r2 = injectLiveReadyCandidatesIntoRolePool(args);
    expect(r1.injectedCandidates).toEqual(r2.injectedCandidates);
    expect(r1.rejected).toEqual(r2.rejected);
    expect(r1.trace).toEqual(r2.trace);
  });

  it('records trace entries for every successful injection AND for dedupe matches', () => {
    const existing = mkCandidate({
      id: 'gpt-oss-120b',
      providerId: 'deepinfra',
      apiModelId: 'openai/gpt-oss-120b',
      routeId: 'deepinfra::openai/gpt-oss-120b',
      caps: ['chat'],
    });
    const r = injectLiveReadyCandidatesIntoRolePool(
      baseInjectionArgs({
        base: [existing],
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'deepinfra::openai/gpt-oss-120b',
            modelId: 'gpt-oss-120b',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
          {
            providerId: 'huggingface',
            routeId: 'huggingface::openai/gpt-oss-120b',
            modelId: 'openai/gpt-oss-120b',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
        resolver: (s) =>
          s.providerId === 'deepinfra'
            ? existing
            : mkCandidate({
                id: s.modelId,
                providerId: s.providerId,
                apiModelId: s.modelId,
                routeId: s.routeId,
                caps: ['chat'],
              }),
      }),
    );
    expect(r.trace.length).toBe(2); // one for dedupe match + one for new injection
    expect(r.injectedCandidates.length).toBe(1);
    expect(r.dedupedExistingCandidates.length).toBe(1);
  });

  it('snapshot hash + path propagate into metadata', () => {
    const r = injectLiveReadyCandidatesIntoRolePool({
      ...baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
      }),
      snapshotHash: 'abc123',
      snapshotPath: '/tmp/snap.json',
    });
    expect(r.metadata.liveOperabilitySnapshotHash).toBe('abc123');
    expect(r.metadata.liveOperabilitySnapshotPath).toBe('/tmp/snap.json');
  });

  it('does NOT leak the snapshot file CONTENT or any secret-like data in metadata', () => {
    const r = injectLiveReadyCandidatesIntoRolePool({
      ...baseInjectionArgs({
        states: [
          {
            providerId: 'deepinfra',
            routeId: 'r',
            modelId: 'm',
            chatReady: true,
            eligibleForCriticalRole: true,
          },
        ],
      }),
      snapshotHash: 'sha256-stub',
      snapshotPath: '/tmp/snap.json',
    });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('returns zero injections when liveReadyStates is empty (no state)', () => {
    const r = injectLiveReadyCandidatesIntoRolePool(baseInjectionArgs({ states: [] }));
    expect(r.injectedCandidates).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.catalogMatches).toBe(0);
  });
});
