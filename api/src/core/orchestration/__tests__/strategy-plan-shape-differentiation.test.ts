// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R4 §13b — Strategy plan shape differentiation tests.
 *
 * Verifies that each strategy produces a DISTINCT plan:
 *   - All plan fingerprints are unique across strategies
 *   - Quality scores differ between strategy families
 *   - Latency estimates differ between strategy families
 *   - Step count differentiates single-step from multi-step families
 *
 * This pins the SF5 gate (fingerprints unique) and the semantic
 * differentiation that makes plans strategy-aware, not generic.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r4-diff-001',
  taskType: 'analysis',
  qualityTarget: 0.85,
  preferSpeed: false,
  models: [
    { id: 'model-x', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-y', provider: 'anthropic' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'differentiation test' }],
  dryRun: true as const,
};

const ALL_STRATEGIES = [
  'single', 'cost-cascade', 'consensus', 'debate',
  'quality-multipass', 'critique-repair', 'expert-panel',
];

function buildMeta(strategy: string) {
  const result = buildPlanOnlyResult(
    strategy, 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
  );
  return result.metadata as Record<string, unknown>;
}

// ── Fingerprint uniqueness ────────────────────────────────────────────────────
describe('01C.1B-SM-R4 §13b — plan fingerprint uniqueness', () => {
  it('all 7 strategies produce unique fingerprints', () => {
    const fps = ALL_STRATEGIES.map(s => {
      const meta = buildMeta(s);
      return meta['planFingerprint'] as string;
    });
    const unique = new Set(fps);
    expect(unique.size).toBe(ALL_STRATEGIES.length);
  });

  it('each fingerprint starts with pf_', () => {
    for (const strategy of ALL_STRATEGIES) {
      const meta = buildMeta(strategy);
      expect((meta['planFingerprint'] as string).startsWith('pf_')).toBe(true);
    }
  });

  it('different taskTypes produce different fingerprints for the same strategy', () => {
    const ctxA = { ...CTX, requestId: 'fp-a', taskType: 'analysis' };
    const ctxB = { ...CTX, requestId: 'fp-b', taskType: 'code-generation' };
    const resultA = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, ctxA, null, 0.85);
    const resultB = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, ctxB, null, 0.85);
    const metaA = resultA.metadata as Record<string, unknown>;
    const metaB = resultB.metadata as Record<string, unknown>;
    expect(metaA['planFingerprint']).not.toBe(metaB['planFingerprint']);
  });

  it('registered=false produces different fingerprint than registered=true', () => {
    const trueResult = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true });
    const falseResult = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: false });
    const metaTrue = trueResult.metadata as Record<string, unknown>;
    const metaFalse = falseResult.metadata as Record<string, unknown>;
    expect(metaTrue['planFingerprint']).not.toBe(metaFalse['planFingerprint']);
  });
});

// ── Quality score differentiation ────────────────────────────────────────────
describe('01C.1B-SM-R4 §13b — quality score differentiation', () => {
  function getQuality(strategy: string): number {
    const meta = buildMeta(strategy);
    const cqt = meta['cost_quality_trace'] as Record<string, unknown>;
    return cqt['expectedQualityScore'] as number;
  }

  it('multi-agent strategies (consensus, debate) score higher than single', () => {
    const qSingle = getQuality('single');
    const qConsensus = getQuality('consensus');
    const qDebate = getQuality('debate');
    expect(qConsensus).toBeGreaterThan(qSingle);
    expect(qDebate).toBeGreaterThan(qSingle);
  });

  it('quality-multipass scores highest among all strategies', () => {
    const scores = ALL_STRATEGIES.map(s => getQuality(s));
    const qmp = getQuality('quality-multipass');
    expect(qmp).toBe(Math.max(...scores));
  });

  it('cost-cascade scores lower than consensus (reflects cost-quality trade-off)', () => {
    expect(getQuality('cost-cascade')).toBeLessThan(getQuality('consensus'));
  });

  it('all quality scores are in valid [0,1] range', () => {
    for (const s of ALL_STRATEGIES) {
      const q = getQuality(s);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

// ── Latency differentiation ───────────────────────────────────────────────────
describe('01C.1B-SM-R4 §13b — latency estimate differentiation', () => {
  function getLatency(strategy: string): number {
    const meta = buildMeta(strategy);
    const cqt = meta['cost_quality_trace'] as Record<string, unknown>;
    return cqt['estimatedLatencyMs'] as number;
  }

  it('single-step strategies are faster than multi-step strategies', () => {
    const latSingle = getLatency('single');
    const latConsensus = getLatency('consensus');
    const latDebate = getLatency('debate');
    expect(latSingle).toBeLessThan(latConsensus);
    expect(latSingle).toBeLessThan(latDebate);
  });

  it('quality-multipass is the slowest strategy', () => {
    const latencies = ALL_STRATEGIES.map(s => getLatency(s));
    const latQmp = getLatency('quality-multipass');
    expect(latQmp).toBe(Math.max(...latencies));
  });

  it('all latencies are positive', () => {
    for (const s of ALL_STRATEGIES) {
      expect(getLatency(s)).toBeGreaterThan(0);
    }
  });
});

// ── Step count differentiation ────────────────────────────────────────────────
// SM-R6 update: step counts are now enumerated per strategy rather than
// grouped by a simplistic single-step / multi-step family taxonomy.
// cost-cascade (FIX-002): 1 → 4 steps
// critique-repair (FIX-003): 2 → 3 steps
// quality-multipass (FIX-004): 2 → 4 steps
describe('01C.1B-SM-R6 §13b — step count differentiation (SM-R6 semantic depth)', () => {
  function getStepCount(strategy: string): number {
    const meta = buildMeta(strategy);
    const plan = meta['executionPlan'] as { steps: unknown[] };
    return plan.steps.length;
  }

  it('single has exactly 1 step (direct-answer)', () => {
    expect(getStepCount('single')).toBe(1);
  });

  it('cost-cascade has exactly 4 steps (FIX-002: cheap→gate→escalate→finalize)', () => {
    expect(getStepCount('cost-cascade')).toBe(4);
  });

  it('critique-repair has exactly 3 steps (FIX-003: critique→repair→validation)', () => {
    expect(getStepCount('critique-repair')).toBe(3);
  });

  it('quality-multipass has exactly 4 steps (FIX-004: draft→review→refine→final)', () => {
    expect(getStepCount('quality-multipass')).toBe(4);
  });

  it('consensus has exactly 2 steps (execute + synthesize, STEP_ROLES 2-tier)', () => {
    expect(getStepCount('consensus')).toBe(2);
  });

  it('debate has exactly 2 steps (propose + judge, STEP_ROLES 2-tier)', () => {
    expect(getStepCount('debate')).toBe(2);
  });

  it('expert-panel has exactly 2 steps (expert + judge, STEP_ROLES 2-tier)', () => {
    expect(getStepCount('expert-panel')).toBe(2);
  });

  it('no strategy has 0 steps (always has a plan)', () => {
    for (const s of ALL_STRATEGIES) {
      expect(getStepCount(s)).toBeGreaterThan(0);
    }
  });
});
