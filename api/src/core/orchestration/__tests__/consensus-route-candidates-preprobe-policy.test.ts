// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R §11.4 — Tests for routeCandidates preprobe policy.
 *
 * Pins the contract:
 *   - allowUnknownLiveOperability=true (discovery/pre-probe):
 *     `routeCandidatesPerRole` exposes UNAUDITED routes (liveReady=false)
 *     so operators can target them with probes.
 *   - allowUnknownLiveOperability=false (strict):
 *     unaudited routes are REJECTED with reason='unauditied_live_state'.
 *
 * Without this fix, J1 ran into a circular dependency: the pre-probe
 * returned 0 routeCandidates because the builder strict-rejected all
 * unauditied routes, but the probes needed approved routes to target.
 */
import { describe, it, expect } from 'vitest';
import { ConsensusPlanDryRunService } from '../strategies/consensus-plan-dry-run-service';
import {
  diversePool,
  makeCandidate,
  makeModel,
} from '../model-selection/__tests__/role-resolver.fixtures';
import type { ChatRequest } from '@/types';

function basePool() {
  return [
    ...diversePool().filter((c) => c.hasCredits).map((c) => c.model),
    makeCandidate({
      id: 'judge-candidate',
      model: makeModel({
        id: 'judge-candidate',
        provider: 'judge-prov',
        capabilities: ['chat', 'text_generation', 'json_mode', 'function_calling'] as never[],
        contextWindow: 64000,
        performance: { latencyMs: 500, throughput: 200, quality: 0.85, reliability: 0.93 },
        inputCostPer1k: 0.0001,
        outputCostPer1k: 0.0004,
      }),
    }).model,
  ];
}

function reqWithEval(overrides?: Record<string, unknown>): ChatRequest {
  return {
    model: 'auto',
    strategy: 'consensus',
    messages: [{ role: 'user', content: 'Probe task' }],
    max_tokens: 1500,
    max_cost: 0.5,
    // @ts-expect-error eval additive
    eval: {
      includeRouteCandidates: true,
      ...overrides,
    },
  } as ChatRequest;
}

describe('01C.1B-J1R — routeCandidates preprobe policy', () => {
  it('allowUnknownLiveOperability=true exposes UNAUDITED routeCandidates', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWithEval({ allowUnknownLiveOperability: true }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesIncluded?: boolean;
      routeCandidatesPerRole?: ReadonlyArray<{
        role: string;
        candidates: ReadonlyArray<{ liveReady?: boolean; routeId?: string }>;
      }>;
      routeSelectionPolicy?: { requireLiveReadyForCriticalRoles?: boolean };
    };
    expect(ext.routeCandidatesIncluded).toBe(true);
    // Policy must mirror the operator intent: NOT require live-ready when allowUnknown=true
    expect(ext.routeSelectionPolicy?.requireLiveReadyForCriticalRoles).toBe(false);
    // At least ONE role should have approved candidates now.
    const totalApproved = (ext.routeCandidatesPerRole ?? []).reduce(
      (a, r) => a + r.candidates.length,
      0,
    );
    expect(totalApproved).toBeGreaterThan(0);
    // The candidates should be marked liveReady=false (unaudited) since the
    // operability store is fresh / no probes have run.
    const allUnaudited = (ext.routeCandidatesPerRole ?? []).every((r) =>
      r.candidates.every((c) => c.liveReady === false || c.liveReady === undefined),
    );
    expect(allUnaudited).toBe(true);
  });

  it('allowUnknownLiveOperability=false (strict) REJECTS unaudited routes', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWithEval({ allowUnknownLiveOperability: false }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesIncluded?: boolean;
      routeCandidatesPerRole?: ReadonlyArray<{
        role: string;
        candidates: ReadonlyArray<unknown>;
      }>;
      routeSelectionPolicy?: { requireLiveReadyForCriticalRoles?: boolean };
    };
    expect(ext.routeCandidatesIncluded).toBe(true);
    expect(ext.routeSelectionPolicy?.requireLiveReadyForCriticalRoles).toBe(true);
    // With no probes run, strict mode should reject all routes.
    const totalApproved = (ext.routeCandidatesPerRole ?? []).reduce(
      (a, r) => a + r.candidates.length,
      0,
    );
    expect(totalApproved).toBe(0);
  });

  it('allowUnknownLiveOperability omitted (default false) preserves strict legacy behavior', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWithEval({ /* no allowUnknownLiveOperability flag */ }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeSelectionPolicy?: { requireLiveReadyForCriticalRoles?: boolean };
    };
    expect(ext.routeSelectionPolicy?.requireLiveReadyForCriticalRoles).toBe(true);
  });

  it('routeCandidates surfaced in pre-probe include providerId + apiModelId for targeting', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWithEval({ allowUnknownLiveOperability: true }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesPerRole?: ReadonlyArray<{
        role: string;
        logicalModelId: string;
        candidates: ReadonlyArray<{
          providerId?: string;
          apiModelId?: string;
          routeId?: string;
          equivalenceKind?: string;
        }>;
      }>;
    };
    expect(ext.routeCandidatesPerRole).toBeDefined();
    // Each candidate must have the FOUR fields the probe scripts need.
    for (const r of ext.routeCandidatesPerRole ?? []) {
      for (const c of r.candidates) {
        expect(typeof c.providerId).toBe('string');
        expect(typeof c.apiModelId).toBe('string');
        expect(typeof c.routeId).toBe('string');
        expect(typeof c.equivalenceKind).toBe('string');
      }
    }
  });

  it('promptTrace + planFingerprint remain present alongside routeCandidates', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWithEval({
        allowUnknownLiveOperability: true,
        tracePromptPayload: true,
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      promptTrace?: unknown;
      promptFingerprints?: unknown;
      promptIncludedInPlanFingerprint?: boolean;
      routeCandidatesIncluded?: boolean;
      routeCandidatesPerRole?: ReadonlyArray<{ candidates: ReadonlyArray<unknown> }>;
    };
    expect(ext.promptTrace).toBeDefined();
    expect(ext.promptFingerprints).toBeDefined();
    expect(ext.promptIncludedInPlanFingerprint).toBe(true);
    expect(ext.routeCandidatesIncluded).toBe(true);
    expect((ext.routeCandidatesPerRole ?? []).length).toBeGreaterThan(0);
  });
});
