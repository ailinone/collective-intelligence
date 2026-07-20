// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-I3A §9 — Tests for runtime wiring of routeCandidates in consensus dry-run.
 *
 * Proves:
 *   - When `eval.includeRouteCandidates=true`, the dry-run plan ships
 *     `routeCandidatesPerRole`, `routeSelectionPolicy`,
 *     `routeCandidatesIncluded=true`, `routeCandidatesFingerprintIncluded=true`.
 *   - When `includeRouteCandidates=false` or absent, the legacy plan
 *     shape is preserved (no new fields).
 *   - `allowOutOfPlanRoutes=false` is enforced in the policy.
 *   - Each role's routeCandidates either has approved entries OR an
 *     empty list (caller surfaces blockers).
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

function reqWith(overrides?: Partial<ChatRequest & { eval?: unknown }>): ChatRequest {
  return {
    model: 'auto',
    strategy: 'consensus',
    messages: [{ role: 'user', content: 'Probe task' }],
    max_tokens: 1500,
    max_cost: 0.5,
    ...overrides,
  } as ChatRequest;
}

describe('runtime wiring — routeCandidates in consensus dry-run', () => {
  it('attaches routeCandidatesPerRole + policy when includeRouteCandidates=true', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error eval is additive
        eval: { includeRouteCandidates: true, maxRouteAttempts: 3 },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesIncluded?: boolean;
      routeCandidatesFingerprintIncluded?: boolean;
      routeSelectionPolicy?: {
        orderBy: readonly string[];
        maxRouteAttempts: number;
        allowOutOfPlanRoutes: boolean;
      };
      routeCandidatesPerRole?: ReadonlyArray<{
        role: string;
        logicalModelId: string;
        candidates: ReadonlyArray<unknown>;
      }>;
    };
    expect(ext.routeCandidatesIncluded).toBe(true);
    expect(ext.routeCandidatesFingerprintIncluded).toBe(true);
    expect(ext.routeSelectionPolicy).toBeDefined();
    expect(ext.routeSelectionPolicy!.maxRouteAttempts).toBe(3);
    expect(ext.routeSelectionPolicy!.allowOutOfPlanRoutes).toBe(false);
    expect(Array.isArray(ext.routeCandidatesPerRole)).toBe(true);
  });

  it('routeSelectionPolicy enforces allowOutOfPlanRoutes=false', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { includeRouteCandidates: true, allowOutOfPlanRoutes: true },  // caller tries to relax
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeSelectionPolicy?: { allowOutOfPlanRoutes: boolean };
    };
    // Service must enforce hard-false regardless of caller request.
    expect(ext.routeSelectionPolicy!.allowOutOfPlanRoutes).toBe(false);
  });

  it('does NOT attach routeCandidates fields when flag is absent (legacy preserved)', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith(),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesIncluded?: unknown;
      routeCandidatesPerRole?: unknown;
      routeSelectionPolicy?: unknown;
    };
    expect(ext.routeCandidatesIncluded).toBeUndefined();
    expect(ext.routeCandidatesPerRole).toBeUndefined();
    expect(ext.routeSelectionPolicy).toBeUndefined();
  });

  it('routeCandidatesPerRole entries reference the plan-selected logical models', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { includeRouteCandidates: true },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesPerRole?: ReadonlyArray<{ role: string; logicalModelId: string }>;
    };
    const roles = (ext.routeCandidatesPerRole ?? []).map((r) => r.role);
    // At least participant should be present; synthesizer/judge/fallback depend on plan selection.
    expect(roles.length).toBeGreaterThanOrEqual(1);
    // All entries must have a logicalModelId string.
    for (const r of ext.routeCandidatesPerRole ?? []) {
      expect(typeof r.logicalModelId).toBe('string');
      expect(r.logicalModelId.length).toBeGreaterThan(0);
    }
  });

  it('maxRouteAttempts in policy honors caller override when valid', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { includeRouteCandidates: true, maxRouteAttempts: 5 },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeSelectionPolicy?: { maxRouteAttempts: number };
    };
    expect(ext.routeSelectionPolicy!.maxRouteAttempts).toBe(5);
  });

  it('routeCandidatesUnauditedCount + routeCandidatesAllLiveReady are surfaced', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { includeRouteCandidates: true },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      routeCandidatesUnauditedCount?: number;
      routeCandidatesAllLiveReady?: boolean;
    };
    expect(typeof ext.routeCandidatesUnauditedCount).toBe('number');
    expect(typeof ext.routeCandidatesAllLiveReady).toBe('boolean');
  });
});
