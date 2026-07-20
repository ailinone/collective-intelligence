// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — CollectiveRun repository mapping (F1.5)
 *
 * Tests the PURE mapping helpers
 * (`buildCollectiveRunCreatePayload`, `buildCollectiveSignalCreatePayloads`)
 * that translate domain types into Prisma create payloads. The DB-side
 * `persistCollectiveRun`/`getCollectiveRun`/`listCollectiveRunsByRequestId`
 * functions belong to integration tests with a real Postgres instance
 * (out of scope for this unit suite — they would not exercise the
 * mapping logic anyway since the SDK does its own type-checking).
 */

import { describe, it, expect } from 'vitest';
import {
  buildCollectiveRunCreatePayload,
  buildCollectiveSignalCreatePayloads,
  buildTriRoleRunCreatePayload,
  buildTriRoleSignalCreatePayloads,
  buildDebateRunCreatePayload,
  buildDebateSignalCreatePayloads,
  buildExpertPanelRunCreatePayload,
  buildExpertPanelSignalCreatePayloads,
  type PersistTriRoleRunInput,
  type TriRoleTurnInput,
  type PersistDebateRunInput,
  type DebateSignalInput,
  type PersistExpertPanelRunInput,
  type ExpertPanelSignalInput,
} from '../collective-run-repository';
import type {
  CoordinationConfig,
  CoordinationLimits,
  CoordinationResult,
  CoordinationSignal,
  CoordinationState,
} from '../coordination-types';
import { DEFAULT_COORDINATION_CONFIG } from '../coordination-types';

function defaultLimits(): CoordinationLimits {
  return {
    maxRounds: 3,
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: true,
    minValidSignalsPerRound: 2,
    detectStagnation: true,
    maxCostUsd: 0.5,
    maxLatencyMs: 60000,
  };
}

function makeState(overrides: Partial<CoordinationState> = {}): CoordinationState {
  return {
    runId: 'run-test',
    strategy: 'sensitivity-consensus',
    round: 2,
    variables: {},
    convergence: {
      score: 0.85,
      decisionFlipRate: 0.10,
      dissent: 0.15,
      confidenceTrend: [0.6, 0.85],
      stableVariables: ['risk'],
      unstableVariables: [],
    },
    risks: [],
    history: [],
    limits: defaultLimits(),
    totalCostUsd: 0.05,
    totalLatencyMs: 1500,
    totalTokens: 800,
    ...overrides,
  };
}

function makeResult(overrides: Partial<CoordinationResult> = {}): CoordinationResult {
  return {
    decision: {
      type: 'approve',
      value: 'approved',
      confidence: 0.88,
      rationale: 'Quality looks strong',
    },
    participatingModels: [
      { modelId: 'm-a', modelName: 'Model A', providerId: 'p-a' },
      { modelId: 'm-b', modelName: 'Model B', providerId: 'p-b' },
    ],
    convergence: {
      score: 0.85,
      decisionFlipRate: 0.10,
      dissent: 0.15,
      confidenceTrend: [0.6, 0.85],
      stableVariables: ['risk'],
      unstableVariables: [],
    },
    roundsExecuted: 2,
    stopReason: 'converged',
    criticalVariables: ['data_loss'],
    dominantSensitivities: [
      { variable: 'risk', direction: 'decrease', trigger: 'tests pass', confidence: 0.9, rationale: 'good coverage' },
    ],
    dissent: [],
    finalResponseText: 'final answer',
    totalCostUsd: 0.05,
    totalLatencyMs: 1500,
    totalTokens: 800,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<CoordinationSignal> = {}): CoordinationSignal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'run-test',
    round: 1,
    agentId: 'agent-a',
    modelId: 'model-a',
    providerId: 'provider-a',
    decision: { type: 'approve', value: 'ok', confidence: 0.85, rationale: 'r' },
    sensitivities: [
      { variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.8, rationale: 'r' },
    ],
    metrics: { latencyMs: 400, inputTokens: 200, outputTokens: 100, estimatedCost: 0.005 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── buildCollectiveRunCreatePayload ───────────────────────────────────

describe('buildCollectiveRunCreatePayload', () => {
  it('produces a payload with all required scalar fields', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      requestId: 'req-1',
      state: makeState(),
      result: makeResult(),
      config: DEFAULT_COORDINATION_CONFIG,
    });

    expect(payload.organizationId).toBe('org-1');
    expect(payload.requestId).toBe('req-1');
    expect(payload.strategy).toBe('sensitivity-consensus');
    expect(payload.rounds).toBe(2);
    expect(payload.stopReason).toBe('converged');
    expect(payload.totalLatencyMs).toBe(1500);
    expect(payload.totalTokens).toBe(800);
    expect(payload.finalDecisionType).toBe('approve');
  });

  it('omits requestId when not provided', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config: DEFAULT_COORDINATION_CONFIG,
    });
    expect(payload.requestId).toBeNull();
  });

  it('serializes config as JSON-safe object containing the runtime knobs', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config: { ...DEFAULT_COORDINATION_CONFIG, entropySeedEnabled: true, aggregationMethod: 'llm_synthesis' },
    });
    const config = payload.config as Record<string, unknown>;
    expect(config.entropySeedEnabled).toBe(true);
    expect(config.aggregationMethod).toBe('llm_synthesis');
    expect(config.maxRounds).toBe(3);
  });

  it('captures dominant sensitivities + critical variables in metadata', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config: DEFAULT_COORDINATION_CONFIG,
    });
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.criticalVariables).toEqual(['data_loss']);
    expect(metadata.stableVariables).toEqual(['risk']);
    expect(metadata.dissentCount).toBe(0);
    const dominant = metadata.dominantSensitivities as Array<Record<string, unknown>>;
    expect(dominant).toHaveLength(1);
    expect(dominant[0].variable).toBe('risk');
  });

  it('rounds latency and tokens to integers', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult({ totalLatencyMs: 1234.789, totalTokens: 567.4 }),
      config: DEFAULT_COORDINATION_CONFIG,
    });
    expect(payload.totalLatencyMs).toBe(1235);
    expect(payload.totalTokens).toBe(567);
  });
});

// ─── buildCollectiveSignalCreatePayloads ───────────────────────────────

describe('buildCollectiveSignalCreatePayloads', () => {
  it('returns an empty array for empty input', () => {
    expect(buildCollectiveSignalCreatePayloads([])).toEqual([]);
  });

  it('maps every signal field including optional metrics and rationale', () => {
    const signal = makeSignal({
      role: 'expert',
      decision: { type: 'reject', value: { reason: 'tests fail' }, confidence: 0.7, rationale: 'coverage too low' },
    });
    const payloads = buildCollectiveSignalCreatePayloads([signal]);
    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.round).toBe(1);
    expect(p.agentId).toBe('agent-a');
    expect(p.role).toBe('expert');
    expect(p.decisionType).toBe('reject');
    expect(p.decisionRationale).toBe('coverage too low');
    expect(p.latencyMs).toBe(400);
    expect(p.inputTokens).toBe(200);
    expect(p.outputTokens).toBe(100);
    expect(p.costUsd).not.toBeNull();
  });

  it('substitutes nulls when metrics are missing', () => {
    const signal = makeSignal({ metrics: undefined });
    const payloads = buildCollectiveSignalCreatePayloads([signal]);
    const p = payloads[0];
    expect(p.latencyMs).toBeNull();
    expect(p.inputTokens).toBeNull();
    expect(p.outputTokens).toBeNull();
    expect(p.costUsd).toBeNull();
  });

  it('handles object-typed decision values (e.g. structured outputs)', () => {
    const signal = makeSignal({
      decision: {
        type: 'plan',
        value: { steps: ['a', 'b'], complexity: 0.7 },
        confidence: 0.9,
        rationale: 'plan',
      },
    });
    const payloads = buildCollectiveSignalCreatePayloads([signal]);
    expect(payloads[0].decisionValue).toEqual({ steps: ['a', 'b'], complexity: 0.7 });
  });

  it('preserves sensitivities array shape', () => {
    const signal = makeSignal({
      sensitivities: [
        { variable: 'a', direction: 'increase', trigger: 't1', confidence: 0.7, rationale: 'r1' },
        { variable: 'b', direction: 'decrease', trigger: 't2', confidence: 0.8, rationale: 'r2', risk: 'high' },
      ],
    });
    const payloads = buildCollectiveSignalCreatePayloads([signal]);
    const sensitivities = payloads[0].sensitivities as Array<Record<string, unknown>>;
    expect(sensitivities).toHaveLength(2);
    expect(sensitivities[1].risk).toBe('high');
  });

  it('keeps stable order across the input array', () => {
    const signals = [
      makeSignal({ agentId: 'a', round: 1 }),
      makeSignal({ agentId: 'b', round: 1 }),
      makeSignal({ agentId: 'c', round: 2 }),
    ];
    const payloads = buildCollectiveSignalCreatePayloads(signals);
    expect(payloads.map((p) => p.agentId)).toEqual(['a', 'b', 'c']);
    expect(payloads.map((p) => p.round)).toEqual([1, 1, 2]);
  });
});

// ─── CoordinationConfig with all knobs survives the JSON round-trip ─────

describe('Trace span persistence (F2.10)', () => {
  it('omits collectiveTraceSpans when traceSpans is not provided', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config: DEFAULT_COORDINATION_CONFIG,
    });
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.collectiveTraceSpans).toBeUndefined();
  });

  it('includes collectiveTraceSpans when traceSpans is supplied', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config: DEFAULT_COORDINATION_CONFIG,
      traceSpans: [
        {
          spanId: 'run-1-span-001',
          parentSpanId: undefined,
          runId: 'run-1',
          phase: 'run_init',
          startedAt: '2026-05-04T00:00:00.000Z',
          endedAt: '2026-05-04T00:00:00.005Z',
          durationMs: 5,
          status: 'ok',
          attributes: { strategy: 'sensitivity-consensus' },
        },
        {
          spanId: 'run-1-span-002',
          parentSpanId: 'run-1-span-001',
          runId: 'run-1',
          phase: 'aggregate',
          startedAt: '2026-05-04T00:00:00.006Z',
          endedAt: '2026-05-04T00:00:00.020Z',
          durationMs: 14,
          status: 'ok',
          attributes: { round: 1 },
        },
      ],
    });
    const metadata = payload.metadata as Record<string, unknown>;
    const spans = metadata.collectiveTraceSpans as Array<Record<string, unknown>>;
    expect(spans).toHaveLength(2);
    expect(spans[0].phase).toBe('run_init');
    expect(spans[1].parentSpanId).toBe('run-1-span-001');
  });

  it('omits collectiveTraceSpans when traceSpans is empty', () => {
    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config: DEFAULT_COORDINATION_CONFIG,
      traceSpans: [],
    });
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.collectiveTraceSpans).toBeUndefined();
  });
});

describe('CoordinationConfig serialization', () => {
  it('every CoordinationConfig field round-trips through JSON cleanly', () => {
    const config: CoordinationConfig = {
      ...DEFAULT_COORDINATION_CONFIG,
      enabled: true,
      maxRounds: 5,
      minConvergenceScore: 0.9,
      maxDecisionFlipRate: 0.05,
      maxDissent: 0.2,
      maxCostUsd: 0.75,
      maxLatencyMs: 90000,
      stopOnCriticalRisk: true,
      minModelsPerRound: 4,
      maxModelsPerRound: 6,
      requireQualityTarget: 0.85,
      aggregationMethod: 'hybrid',
      persistAuditTrail: true,
      enableForExperiments: true,
      entropySeedEnabled: true,
    };

    const payload = buildCollectiveRunCreatePayload({
      organizationId: 'org-1',
      state: makeState(),
      result: makeResult(),
      config,
    });

    const persisted = payload.config as Record<string, unknown>;
    // Values stored on the run record; confirm a representative subset.
    expect(persisted.maxRounds).toBe(5);
    expect(persisted.entropySeedEnabled).toBe(true);
    expect(persisted.aggregationMethod).toBe('hybrid');
    expect(persisted.minConvergenceScore).toBe(0.9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tri-Role persistence (F4.1 prep)
// ═══════════════════════════════════════════════════════════════════════════

function makeTriRoleTurn(overrides: Partial<TriRoleTurnInput> = {}): TriRoleTurnInput {
  return {
    turn: 1,
    role: 'planner',
    modelId: 'openai/gpt-5',
    providerId: 'openai',
    responseText: 'GOAL: ship feature\nSTEPS:\n1. design\n2. test\nSUCCESS_CRITERIA: tests pass',
    cost: 0.012,
    durationMs: 1500,
    inputTokens: 400,
    outputTokens: 200,
    schedulerName: 'fixed-state-machine',
    decisionReason: 'turn-1-fixed',
    ...overrides,
  };
}

function makeTriRoleInput(
  overrides: Partial<PersistTriRoleRunInput> = {},
): PersistTriRoleRunInput {
  return {
    organizationId: 'org-1',
    requestId: 'req-tri-1',
    runId: 'run-tri-1',
    config: {
      maxTurns: 5,
      maxCostUsd: 0.30,
      maxLatencyMs: 60000,
      ambiguityResolution: 'accept',
    },
    stopReason: 'accepted',
    finalDecisionType: 'auditor-accept',
    finalConfidence: 1.0,
    totalCostUsd: 0.05,
    totalLatencyMs: 4500,
    totalTokens: 1800,
    participatingModels: [
      { modelId: 'openai/gpt-5', modelName: 'GPT-5', providerId: 'openai' },
      { modelId: 'anthropic/claude-sonnet', modelName: 'Claude Sonnet', providerId: 'anthropic' },
    ],
    transcript: [
      makeTriRoleTurn({ turn: 1, role: 'planner', decisionReason: 'turn-1-fixed' }),
      makeTriRoleTurn({
        turn: 2,
        role: 'solver',
        modelId: 'anthropic/claude-sonnet',
        providerId: 'anthropic',
        responseText: 'final answer here',
        decisionReason: 'turn-2-fixed',
      }),
      makeTriRoleTurn({
        turn: 3,
        role: 'auditor',
        modelId: 'openai/gpt-5',
        providerId: 'openai',
        responseText: 'VERDICT: ACCEPT\nLooks good.',
        verdict: { status: 'accept', feedback: 'Looks good.', inferred: false },
        decisionReason: 'after-solver',
      }),
    ],
    ...overrides,
  };
}

describe('buildTriRoleRunCreatePayload (F4.1 prep)', () => {
  it('produces a payload with all required scalar fields', () => {
    const payload = buildTriRoleRunCreatePayload(makeTriRoleInput());
    expect(payload.organizationId).toBe('org-1');
    expect(payload.requestId).toBe('req-tri-1');
    expect(payload.strategy).toBe('tri-role-collective');
    expect(payload.rounds).toBe(3);
    expect(payload.stopReason).toBe('accepted');
    expect(payload.totalLatencyMs).toBe(4500);
    expect(payload.totalTokens).toBe(1800);
    expect(payload.finalDecisionType).toBe('auditor-accept');
  });

  it('encodes accepted stopReason as convergenceScore=1, others as 0', () => {
    const accepted = buildTriRoleRunCreatePayload(makeTriRoleInput({ stopReason: 'accepted' }));
    const maxTurns = buildTriRoleRunCreatePayload(makeTriRoleInput({ stopReason: 'max_turns' }));
    const noSolver = buildTriRoleRunCreatePayload(makeTriRoleInput({ stopReason: 'no_solver' }));

    expect(String(accepted.convergenceScore)).toBe('1');
    expect(String(maxTurns.convergenceScore)).toBe('0');
    expect(String(noSolver.convergenceScore)).toBe('0');
  });

  it('always sets dissent and decisionFlipRate to 0 (sequential strategy)', () => {
    const payload = buildTriRoleRunCreatePayload(makeTriRoleInput());
    expect(String(payload.dissent)).toBe('0');
    expect(String(payload.decisionFlipRate)).toBe('0');
  });

  it('persists the config snapshot with tri-role-specific keys', () => {
    const payload = buildTriRoleRunCreatePayload(makeTriRoleInput());
    const config = payload.config as Record<string, unknown>;
    expect(config.maxTurns).toBe(5);
    expect(config.ambiguityResolution).toBe('accept');
    // Sensitivity-consensus knobs must NOT be present for tri-role runs.
    expect(config.aggregationMethod).toBeUndefined();
    expect(config.minConvergenceScore).toBeUndefined();
  });

  it('omits collectiveTraceSpans when no traceSpans supplied', () => {
    const payload = buildTriRoleRunCreatePayload(makeTriRoleInput());
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.collectiveTraceSpans).toBeUndefined();
  });

  it('includes collectiveTraceSpans when supplied', () => {
    const payload = buildTriRoleRunCreatePayload(
      makeTriRoleInput({
        traceSpans: [
          { spanId: 's1', name: 'run_init', startedAt: 0, endedAt: 5, attributes: { runId: 'r' } },
        ],
      }),
    );
    const metadata = payload.metadata as Record<string, unknown>;
    expect(Array.isArray(metadata.collectiveTraceSpans)).toBe(true);
    expect((metadata.collectiveTraceSpans as unknown[]).length).toBe(1);
  });

  it('preserves participatingModels in metadata', () => {
    const payload = buildTriRoleRunCreatePayload(makeTriRoleInput());
    const metadata = payload.metadata as Record<string, unknown>;
    const models = metadata.participatingModels as Array<{ modelId: string }>;
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.modelId)).toEqual(['openai/gpt-5', 'anthropic/claude-sonnet']);
  });
});

describe('buildTriRoleSignalCreatePayloads (F4.1 prep)', () => {
  it('emits one signal per transcript turn, in order', () => {
    const payloads = buildTriRoleSignalCreatePayloads(makeTriRoleInput().transcript);
    expect(payloads).toHaveLength(3);
    expect(payloads.map((p) => p.role)).toEqual(['planner', 'solver', 'auditor']);
    expect(payloads.map((p) => p.round)).toEqual([1, 2, 3]);
  });

  it('encodes auditor verdict in decisionType (verdict-accept / verdict-revise)', () => {
    const accepted = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        role: 'auditor',
        verdict: { status: 'accept', feedback: 'ok', inferred: false },
      }),
    ]);
    const revised = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        role: 'auditor',
        verdict: { status: 'revise', feedback: 'fix x', inferred: false },
      }),
    ]);
    expect(accepted[0].decisionType).toBe('verdict-accept');
    expect(revised[0].decisionType).toBe('verdict-revise');
  });

  it('uses the bare role for non-auditor turns', () => {
    const payloads = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({ role: 'planner' }),
      makeTriRoleTurn({ role: 'solver' }),
    ]);
    expect(payloads[0].decisionType).toBe('planner');
    expect(payloads[1].decisionType).toBe('solver');
  });

  it('embeds F4.1 audit fields in decision_value when present', () => {
    const payloads = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        schedulerName: 'fixed-state-machine',
        decisionReason: 'turn-1-fixed',
      }),
    ]);
    const decision = payloads[0].decisionValue as Record<string, unknown>;
    expect(decision.schedulerName).toBe('fixed-state-machine');
    expect(decision.decisionReason).toBe('turn-1-fixed');
    expect(decision.responseText).toBeDefined();
  });

  it('omits F4.1 audit fields when not provided (preserves opt-out)', () => {
    const payloads = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({ schedulerName: undefined, decisionReason: undefined }),
    ]);
    const decision = payloads[0].decisionValue as Record<string, unknown>;
    expect(decision.schedulerName).toBeUndefined();
    expect(decision.decisionReason).toBeUndefined();
  });

  it('lowers confidence to 0.50 for inferred (ambiguous) verdicts', () => {
    const certain = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        role: 'auditor',
        verdict: { status: 'accept', feedback: 'ok', inferred: false },
      }),
    ]);
    const inferred = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        role: 'auditor',
        verdict: { status: 'accept', feedback: 'ok', inferred: true },
      }),
    ]);
    expect(String(certain[0].decisionConfidence)).toBe('1');
    expect(String(inferred[0].decisionConfidence)).toBe('0.5');
  });

  it('places verdict feedback into decisionRationale', () => {
    const payloads = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        role: 'auditor',
        verdict: { status: 'revise', feedback: 'Add error handling for nil input', inferred: false },
      }),
    ]);
    expect(payloads[0].decisionRationale).toBe('Add error handling for nil input');
  });

  it('always sets sensitivities to empty array (tri-role does not emit sensitivities)', () => {
    const payloads = buildTriRoleSignalCreatePayloads(makeTriRoleInput().transcript);
    for (const p of payloads) {
      expect(p.sensitivities).toEqual([]);
    }
  });

  it('uses agentId convention "<role>-turn-<turn>"', () => {
    const payloads = buildTriRoleSignalCreatePayloads(makeTriRoleInput().transcript);
    expect(payloads[0].agentId).toBe('planner-turn-1');
    expect(payloads[1].agentId).toBe('solver-turn-2');
    expect(payloads[2].agentId).toBe('auditor-turn-3');
  });

  it('preserves per-turn metrics (latency, tokens, cost)', () => {
    const payloads = buildTriRoleSignalCreatePayloads([
      makeTriRoleTurn({
        durationMs: 2500,
        inputTokens: 600,
        outputTokens: 300,
        cost: 0.0345,
      }),
    ]);
    expect(payloads[0].latencyMs).toBe(2500);
    expect(payloads[0].inputTokens).toBe(600);
    expect(payloads[0].outputTokens).toBe(300);
    expect(String(payloads[0].costUsd)).toBe('0.0345');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Debate persistence (F4.1 audit-flow extension)
// ═══════════════════════════════════════════════════════════════════════════

function makeDebateSignal(overrides: Partial<DebateSignalInput> = {}): DebateSignalInput {
  return {
    round: 1,
    agentName: 'GPT-5',
    modelId: 'openai/gpt-5',
    providerId: 'openai',
    role: 'debater',
    decisionType: 'opening',
    text: 'Position: option A is preferable because...',
    durationMs: 1200,
    cost: 0.012,
    inputTokens: 400,
    outputTokens: 200,
    ...overrides,
  };
}

function makeDebateInput(overrides: Partial<PersistDebateRunInput> = {}): PersistDebateRunInput {
  return {
    organizationId: 'org-1',
    requestId: 'req-debate-1',
    runId: 'run-debate-1',
    config: { maxParticipants: 3, numDebateRounds: 2 },
    moderatorScheduler: 'pin-or-quality',
    moderatorReason: 'quality-fallback',
    stopReason: 'completed',
    totalCostUsd: 0.05,
    totalLatencyMs: 4500,
    totalTokens: 1800,
    participatingModels: [
      { modelId: 'openai/gpt-5', modelName: 'GPT-5', providerId: 'openai' },
      { modelId: 'anthropic/claude-sonnet', modelName: 'Claude Sonnet', providerId: 'anthropic' },
      { modelId: 'google/gemini-pro', modelName: 'Gemini Pro', providerId: 'google' },
    ],
    signals: [
      makeDebateSignal({ round: 1, decisionType: 'opening' }),
      makeDebateSignal({ round: 2, decisionType: 'response', respondingTo: 'Claude Sonnet' }),
      makeDebateSignal({
        round: 3,
        agentName: 'GPT-5',
        modelId: 'openai/gpt-5',
        providerId: 'openai',
        role: 'moderator',
        decisionType: 'synthesis',
        text: 'Synthesis: option A wins because...',
        schedulerName: 'pin-or-quality',
        decisionReason: 'quality-fallback',
      }),
    ],
    ...overrides,
  };
}

describe('buildDebateRunCreatePayload (F4.1 audit-flow extension)', () => {
  it('produces a payload with all required scalar fields', () => {
    const payload = buildDebateRunCreatePayload(makeDebateInput());
    expect(payload.organizationId).toBe('org-1');
    expect(payload.requestId).toBe('req-debate-1');
    expect(payload.strategy).toBe('debate');
    expect(payload.rounds).toBe(2);
    expect(payload.stopReason).toBe('completed');
    expect(payload.totalLatencyMs).toBe(4500);
    expect(payload.finalDecisionType).toBe('synthesis');
  });

  it('persists moderator-selection F4.1 audit fields in metadata', () => {
    const payload = buildDebateRunCreatePayload(makeDebateInput());
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.moderatorScheduler).toBe('pin-or-quality');
    expect(metadata.moderatorReason).toBe('quality-fallback');
  });

  it('encodes completed stopReason as convergenceScore=1, others as 0', () => {
    const completed = buildDebateRunCreatePayload(makeDebateInput({ stopReason: 'completed' }));
    const noSyn = buildDebateRunCreatePayload(makeDebateInput({ stopReason: 'no_synthesis' }));
    expect(String(completed.convergenceScore)).toBe('1');
    expect(String(noSyn.convergenceScore)).toBe('0');
  });

  it('persists config snapshot keys without sensitivity-consensus pollution', () => {
    const payload = buildDebateRunCreatePayload(makeDebateInput());
    const config = payload.config as Record<string, unknown>;
    expect(config.maxParticipants).toBe(3);
    expect(config.numDebateRounds).toBe(2);
    expect(config.aggregationMethod).toBeUndefined();
    expect(config.minConvergenceScore).toBeUndefined();
  });

  it('omits collectiveTraceSpans when not supplied', () => {
    const payload = buildDebateRunCreatePayload(makeDebateInput());
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.collectiveTraceSpans).toBeUndefined();
  });

  it('includes collectiveTraceSpans when supplied', () => {
    const payload = buildDebateRunCreatePayload(
      makeDebateInput({
        traceSpans: [
          { spanId: 's1', name: 'debate_init', startedAt: 0, endedAt: 5, attributes: { runId: 'r' } },
        ],
      }),
    );
    const metadata = payload.metadata as Record<string, unknown>;
    expect(Array.isArray(metadata.collectiveTraceSpans)).toBe(true);
  });
});

describe('buildDebateSignalCreatePayloads (F4.1 audit-flow extension)', () => {
  it('emits one signal per input, preserving order', () => {
    const payloads = buildDebateSignalCreatePayloads(makeDebateInput().signals);
    expect(payloads).toHaveLength(3);
    expect(payloads.map((p) => p.role)).toEqual(['debater', 'debater', 'moderator']);
    expect(payloads.map((p) => p.decisionType)).toEqual(['opening', 'response', 'synthesis']);
  });

  it('uses agentId convention "<role>-<name>-round-<round>"', () => {
    const payloads = buildDebateSignalCreatePayloads(makeDebateInput().signals);
    expect(payloads[0].agentId).toBe('debater-GPT-5-round-1');
    expect(payloads[2].agentId).toBe('moderator-GPT-5-round-3');
  });

  it('embeds F4.1 audit fields in synthesis decision_value', () => {
    const payloads = buildDebateSignalCreatePayloads(makeDebateInput().signals);
    const synthesis = payloads[2].decisionValue as Record<string, unknown>;
    expect(synthesis.schedulerName).toBe('pin-or-quality');
    expect(synthesis.decisionReason).toBe('quality-fallback');
  });

  it('embeds respondingTo in response signals when present', () => {
    const payloads = buildDebateSignalCreatePayloads(makeDebateInput().signals);
    const response = payloads[1].decisionValue as Record<string, unknown>;
    expect(response.respondingTo).toBe('Claude Sonnet');
    const opening = payloads[0].decisionValue as Record<string, unknown>;
    expect(opening.respondingTo).toBeUndefined();
  });

  it('always sets sensitivities to empty array', () => {
    const payloads = buildDebateSignalCreatePayloads(makeDebateInput().signals);
    for (const p of payloads) expect(p.sensitivities).toEqual([]);
  });

  it('preserves per-signal metrics (latency, tokens, cost)', () => {
    const payloads = buildDebateSignalCreatePayloads([
      makeDebateSignal({ durationMs: 2500, inputTokens: 600, outputTokens: 300, cost: 0.0345 }),
    ]);
    expect(payloads[0].latencyMs).toBe(2500);
    expect(payloads[0].inputTokens).toBe(600);
    expect(payloads[0].outputTokens).toBe(300);
    expect(String(payloads[0].costUsd)).toBe('0.0345');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Expert-Panel persistence (F4.1 audit-flow extension)
// ═══════════════════════════════════════════════════════════════════════════

function makeExpertPanelSignal(overrides: Partial<ExpertPanelSignalInput> = {}): ExpertPanelSignalInput {
  return {
    round: 1,
    agentName: 'GPT-5',
    modelId: 'openai/gpt-5',
    providerId: 'openai',
    role: 'expert',
    decisionType: 'expert-opinion',
    text: 'From a coding perspective, …',
    domain: 'coding',
    durationMs: 1500,
    cost: 0.018,
    inputTokens: 500,
    outputTokens: 250,
    ...overrides,
  };
}

function makeExpertPanelInput(
  overrides: Partial<PersistExpertPanelRunInput> = {},
): PersistExpertPanelRunInput {
  return {
    organizationId: 'org-1',
    requestId: 'req-panel-1',
    runId: 'run-panel-1',
    config: { expertCount: 3, domains: ['coding', 'security', 'testing'], crossReviewEnabled: true },
    panelScheduler: 'pin-or-quality',
    panelReason: 'quality-fallback',
    stopReason: 'completed',
    totalCostUsd: 0.08,
    totalLatencyMs: 6000,
    totalTokens: 3000,
    participatingModels: [
      { modelId: 'openai/gpt-5', modelName: 'GPT-5', providerId: 'openai' },
      { modelId: 'anthropic/claude-sonnet', modelName: 'Claude Sonnet', providerId: 'anthropic' },
      { modelId: 'google/gemini-pro', modelName: 'Gemini Pro', providerId: 'google' },
    ],
    signals: [
      makeExpertPanelSignal({ role: 'expert', decisionType: 'expert-opinion', domain: 'coding' }),
      makeExpertPanelSignal({
        role: 'expert',
        decisionType: 'expert-opinion',
        domain: 'security',
        agentName: 'Claude Sonnet',
        modelId: 'anthropic/claude-sonnet',
        providerId: 'anthropic',
      }),
      makeExpertPanelSignal({
        round: 2,
        role: 'reviewer',
        decisionType: 'cross-review',
        domain: 'coding',
        reviewedExpert: 'Claude Sonnet',
        text: 'Coding perspective on the security analysis: …',
      }),
      makeExpertPanelSignal({
        round: 3,
        role: 'coordinator',
        decisionType: 'synthesis',
        text: 'Final synthesis across all 3 domains: …',
        domain: undefined,
        schedulerName: 'pin-or-quality',
        decisionReason: 'quality-fallback',
      }),
    ],
    ...overrides,
  };
}

describe('buildExpertPanelRunCreatePayload (F4.1 audit-flow extension)', () => {
  it('produces a payload with all required scalar fields', () => {
    const payload = buildExpertPanelRunCreatePayload(makeExpertPanelInput());
    expect(payload.organizationId).toBe('org-1');
    expect(payload.requestId).toBe('req-panel-1');
    expect(payload.strategy).toBe('expert-panel');
    expect(payload.rounds).toBe(3); // consultations + cross-review + synthesis
    expect(payload.finalDecisionType).toBe('synthesis');
  });

  it('rounds=2 when cross-review is disabled', () => {
    const payload = buildExpertPanelRunCreatePayload(
      makeExpertPanelInput({
        config: { expertCount: 3, domains: ['a', 'b', 'c'], crossReviewEnabled: false },
      }),
    );
    expect(payload.rounds).toBe(2);
  });

  it('persists panel-selection F4.1 audit fields + domains in metadata', () => {
    const payload = buildExpertPanelRunCreatePayload(makeExpertPanelInput());
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.panelScheduler).toBe('pin-or-quality');
    expect(metadata.panelReason).toBe('quality-fallback');
    expect(metadata.domains).toEqual(['coding', 'security', 'testing']);
  });

  it('persists config snapshot with expertCount + domains + crossReviewEnabled', () => {
    const payload = buildExpertPanelRunCreatePayload(makeExpertPanelInput());
    const config = payload.config as Record<string, unknown>;
    expect(config.expertCount).toBe(3);
    expect(config.crossReviewEnabled).toBe(true);
    expect(config.domains).toEqual(['coding', 'security', 'testing']);
  });
});

describe('buildExpertPanelSignalCreatePayloads (F4.1 audit-flow extension)', () => {
  it('emits one signal per input', () => {
    const payloads = buildExpertPanelSignalCreatePayloads(makeExpertPanelInput().signals);
    expect(payloads).toHaveLength(4);
    expect(payloads.map((p) => p.role)).toEqual(['expert', 'expert', 'reviewer', 'coordinator']);
  });

  it('embeds domain in expert + reviewer decision_value', () => {
    const payloads = buildExpertPanelSignalCreatePayloads(makeExpertPanelInput().signals);
    const expertOpinion = payloads[0].decisionValue as Record<string, unknown>;
    expect(expertOpinion.domain).toBe('coding');
    const review = payloads[2].decisionValue as Record<string, unknown>;
    expect(review.domain).toBe('coding');
    expect(review.reviewedExpert).toBe('Claude Sonnet');
  });

  it('embeds F4.1 audit fields in coordinator-synthesis decision_value', () => {
    const payloads = buildExpertPanelSignalCreatePayloads(makeExpertPanelInput().signals);
    const synthesis = payloads[3].decisionValue as Record<string, unknown>;
    expect(synthesis.schedulerName).toBe('pin-or-quality');
    expect(synthesis.decisionReason).toBe('quality-fallback');
  });

  it('uses agentId convention "<role>-<name>-round-<round>"', () => {
    const payloads = buildExpertPanelSignalCreatePayloads(makeExpertPanelInput().signals);
    expect(payloads[0].agentId).toBe('expert-GPT-5-round-1');
    expect(payloads[2].agentId).toBe('reviewer-GPT-5-round-2');
    expect(payloads[3].agentId).toBe('coordinator-GPT-5-round-3');
  });

  it('omits domain on coordinator-synthesis', () => {
    const payloads = buildExpertPanelSignalCreatePayloads(makeExpertPanelInput().signals);
    const synthesis = payloads[3].decisionValue as Record<string, unknown>;
    expect(synthesis.domain).toBeUndefined();
  });
});
