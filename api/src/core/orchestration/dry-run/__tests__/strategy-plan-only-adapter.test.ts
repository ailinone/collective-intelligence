// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-plan-only-adapter.test.ts — SM-R2-CORRECTIVE §15
 *
 * Tests for the plan-only adapter for non-consensus strategies.
 * Verifies: cost=0, providerCallExecuted=false, synthetic response, trace fields.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '../strategy-plan-only-adapter';
import type { ChatRequest, OrchestrationContext } from '@/types';

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'test-request-1',
    taskType: 'general',
    qualityTarget: 0.85,
    preferSpeed: false,
    models: [
      { id: 'model-a', name: 'Model A' } as never,
      { id: 'model-b', name: 'Model B' } as never,
      { id: 'model-c', name: 'Model C' } as never,
    ],
    ...overrides,
  } as OrchestrationContext;
}

function makeRequest(overrides: Partial<ChatRequest & { dryRun?: boolean }> = {}) {
  return {
    messages: [{ role: 'user' as const, content: 'test question' }],
    ...overrides,
  };
}

describe('buildPlanOnlyResult — cost invariants', () => {
  it('always returns totalCost=0', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'request.dryRun',
      makeRequest({ dryRun: true }), makeContext(), null, 0.85,
    );
    expect(result.totalCost).toBe(0);
  });

  it('always returns cost_usd=0 in metadata', () => {
    const result = buildPlanOnlyResult(
      'consensus', 'cold-start-policy', 'request.dryRun',
      makeRequest({ dryRun: true }), makeContext(), null, 0.92,
    );
    expect(result.metadata.cost_usd).toBe(0);
  });

  it('always returns modelsUsed=[]', () => {
    const result = buildPlanOnlyResult(
      'cost-cascade', 'cold-start-policy', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.7,
    );
    expect(result.modelsUsed).toHaveLength(0);
  });
});

describe('buildPlanOnlyResult — provider call invariants', () => {
  it('sets provider_call_executed=false', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.8,
    );
    expect(result.metadata.provider_call_executed).toBe(false);
  });

  it('sets plan_only=true', () => {
    const result = buildPlanOnlyResult(
      'debate', 'cold-start-policy', 'eval.dryRun',
      makeRequest(), makeContext(), null, 0.9,
    );
    expect(result.metadata.plan_only).toBe(true);
  });
});

describe('buildPlanOnlyResult — response structure', () => {
  it('produces a valid ChatResponse with assistant message', () => {
    const result = buildPlanOnlyResult(
      'consensus', 'cold-start-policy', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.9,
    );
    expect(result.finalResponse.object).toBe('chat.completion');
    expect(result.finalResponse.choices).toHaveLength(1);
    expect(result.finalResponse.choices[0].message.role).toBe('assistant');
    expect(typeof result.finalResponse.choices[0].message.content).toBe('string');
    expect(result.finalResponse.choices[0].finish_reason).toBe('stop');
  });

  it('response content mentions the strategy name', () => {
    const result = buildPlanOnlyResult(
      'cost-cascade', 'cold-start-policy', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.7,
    );
    expect(result.finalResponse.choices[0].message.content).toContain('cost-cascade');
  });

  it('response usage is all zeros', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.85,
    );
    expect(result.finalResponse.usage?.prompt_tokens).toBe(0);
    expect(result.finalResponse.usage?.completion_tokens).toBe(0);
    expect(result.finalResponse.usage?.total_tokens).toBe(0);
  });
});

describe('buildPlanOnlyResult — trace fields', () => {
  it('includes strategy_resolution_trace with correct strategy', () => {
    const result = buildPlanOnlyResult(
      'consensus', 'cold-start-policy', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.9,
    );
    const trace = result.metadata.strategy_resolution_trace as {
      resolvedStrategy: string; selectionSource: string; coldStartPolicyApplied: boolean;
    };
    expect(trace.resolvedStrategy).toBe('consensus');
    expect(trace.selectionSource).toBe('cold-start-policy');
    expect(trace.coldStartPolicyApplied).toBe(true);
  });

  it('includes triage_trace with discarded=true when triage was discarded', () => {
    const triageDecision = {
      intent: 'analysis',
      complexity: 'high',
      confidence: 0.3,
      recommendedStrategy: null,  // discarded
      discarded: true,
    };
    const result = buildPlanOnlyResult(
      'consensus', 'cold-start-policy', 'request.dryRun',
      makeRequest(), makeContext(), triageDecision, 0.9,
    );
    const triageTrace = result.metadata.triage_trace as {
      invoked: boolean; discarded: boolean; discardReason: string;
    };
    expect(triageTrace.invoked).toBe(true);
    expect(triageTrace.discarded).toBe(true);
    expect(triageTrace.discardReason).toBe('TRIAGE_CONFIDENCE_BELOW_THRESHOLD');
  });

  it('includes triage_trace with invoked=false when triage was not run', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.8,
    );
    const triageTrace = result.metadata.triage_trace as { invoked: boolean };
    expect(triageTrace.invoked).toBe(false);
  });

  it('includes cost_quality_trace with estimatedPlanCostUsd=0', () => {
    const result = buildPlanOnlyResult(
      'consensus', 'cold-start-policy', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.9,
    );
    const cqTrace = result.metadata.cost_quality_trace as {
      estimatedPlanCostUsd: number; providerCallExecuted: boolean;
    };
    expect(cqTrace.estimatedPlanCostUsd).toBe(0);
    expect(cqTrace.providerCallExecuted).toBe(false);
  });

  it('includes route_trace as non-empty array', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.8,
    );
    const routeTrace = result.metadata.route_trace as string[];
    expect(Array.isArray(routeTrace)).toBe(true);
    expect(routeTrace.length).toBeGreaterThan(0);
  });

  it('includes dry_run_interception_path', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'eval.planOnly',
      makeRequest(), makeContext(), null, 0.8,
    );
    expect(result.metadata.dry_run_interception_path).toBe('eval.planOnly');
  });

  it('resolved_strategy matches the strategy argument', () => {
    for (const strategy of ['single', 'consensus', 'cost-cascade', 'debate']) {
      const result = buildPlanOnlyResult(
        strategy, 'cold-start-policy', 'request.dryRun',
        makeRequest(), makeContext(), null, 0.85,
      );
      expect(result.metadata.resolved_strategy).toBe(strategy);
    }
  });
});

describe('buildPlanOnlyResult — totalDuration', () => {
  it('totalDuration is 0 (no execution)', () => {
    const result = buildPlanOnlyResult(
      'single', 'heuristic', 'request.dryRun',
      makeRequest(), makeContext(), null, 0.85,
    );
    expect(result.totalDuration).toBe(0);
  });
});
