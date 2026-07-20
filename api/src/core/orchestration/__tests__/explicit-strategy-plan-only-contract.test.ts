// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R3 §12c — Explicit strategy plan-only contract tests.
 *
 * Verifies that buildPlanOnlyResult() produces the correct plan-only
 * contract when called with explicit strategies (selectionSource='explicit')
 * vs cold-start policy (selectionSource='cold-start-policy').
 *
 * Also verifies the strategy_resolution_trace correctly reflects the
 * selection source.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX_WITH_MODELS: OrchestrationContext = {
  requestId: 'sm-r3-explicit-contract-001',
  taskType: 'code-generation',
  qualityTarget: 0.9,
  preferSpeed: false,
  models: [
    { id: 'gpt-4', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'claude-3', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'gemini-pro', provider: 'google' } as OrchestrationContext['models'][0],
  ],
};

const CTX_EMPTY_MODELS: OrchestrationContext = {
  requestId: 'sm-r3-explicit-contract-002',
  taskType: 'general',
  qualityTarget: 0.7,
  preferSpeed: true,
  models: [],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'Write a test' }],
  dryRun: true as const,
};

describe('01C.1B-SM-R3 §12c — explicit strategy plan-only contract', () => {
  describe('selectionSource field in strategy_resolution_trace', () => {
    it('explicit selection source sets coldStartPolicyApplied=false', () => {
      const result = buildPlanOnlyResult(
        'single', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true },
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['strategy_resolution_trace'] as Record<string, unknown>;
      expect(trace).toBeDefined();
      expect(trace['coldStartPolicyApplied']).toBe(false);
      expect(trace['selectionSource']).toBe('explicit');
    });

    it('cold-start-policy selection source sets coldStartPolicyApplied=true', () => {
      const result = buildPlanOnlyResult(
        'single', 'cold-start-policy', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9,
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['strategy_resolution_trace'] as Record<string, unknown>;
      expect(trace['coldStartPolicyApplied']).toBe(true);
      expect(trace['selectionSource']).toBe('cold-start-policy');
    });

    it('resolvedStrategy in trace matches the strategyName argument', () => {
      for (const strategy of ['single', 'consensus', 'debate', 'cost-cascade']) {
        const result = buildPlanOnlyResult(
          strategy, 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.85, { registered: true },
        );
        const meta = result.metadata as Record<string, unknown>;
        const trace = meta['strategy_resolution_trace'] as Record<string, unknown>;
        expect(trace['resolvedStrategy']).toBe(strategy);
      }
    });
  });

  describe('context integration — models and taskType', () => {
    it('modelsAvailable in trace reflects context.models.length', () => {
      const result = buildPlanOnlyResult(
        'consensus', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true },
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['strategy_resolution_trace'] as Record<string, unknown>;
      expect(trace['modelsAvailable']).toBe(3);
    });

    it('modelsAvailable=0 when context has no models', () => {
      const result = buildPlanOnlyResult(
        'single', 'explicit', 'request-flag', REQ, CTX_EMPTY_MODELS, null, 0.7, { registered: true },
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['strategy_resolution_trace'] as Record<string, unknown>;
      expect(trace['modelsAvailable']).toBe(0);
    });

    it('taskType in trace reflects context.taskType', () => {
      const result = buildPlanOnlyResult(
        'single', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true },
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['strategy_resolution_trace'] as Record<string, unknown>;
      expect(trace['taskType']).toBe('code-generation');
    });
  });

  describe('triage trace when triage not invoked', () => {
    it('triage_trace.invoked=false when triageDecision=null', () => {
      const result = buildPlanOnlyResult(
        'single', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS,
        null, // triageDecision = null
        0.9, { registered: true },
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['triage_trace'] as Record<string, unknown>;
      expect(trace['invoked']).toBe(false);
      expect(trace['discarded']).toBe(false);
    });

    it('triage_trace.invoked=true when triageDecision is provided', () => {
      const result = buildPlanOnlyResult(
        'consensus', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS,
        { intent: 'analysis', complexity: 'high', confidence: 0.92, recommendedStrategy: 'consensus' },
        0.9, { registered: true },
      );
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['triage_trace'] as Record<string, unknown>;
      expect(trace['invoked']).toBe(true);
      expect(trace['intent']).toBe('analysis');
      expect(trace['complexity']).toBe('high');
      expect(trace['confidence']).toBe(0.92);
    });
  });

  describe('cost-quality trace', () => {
    it('estimatedPlanCostUsd is always 0', () => {
      const result = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['cost_quality_trace'] as Record<string, unknown>;
      expect(trace['estimatedPlanCostUsd']).toBe(0);
    });

    it('providerCallExecuted is false in cost_quality_trace', () => {
      const result = buildPlanOnlyResult('single', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['cost_quality_trace'] as Record<string, unknown>;
      expect(trace['providerCallExecuted']).toBe(false);
    });

    it('qualityTarget reflects the passed qualityTarget', () => {
      const result = buildPlanOnlyResult('debate', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.75, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['cost_quality_trace'] as Record<string, unknown>;
      expect(trace['qualityTarget']).toBe(0.75);
    });

    it('planExecutable=false when no models available (routeReadiness=0)', () => {
      const result = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, CTX_EMPTY_MODELS, null, 0.9, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['cost_quality_trace'] as Record<string, unknown>;
      expect(trace['planExecutable']).toBe(false);
    });

    it('planExecutable=true when models are available', () => {
      const result = buildPlanOnlyResult('single', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const trace = meta['cost_quality_trace'] as Record<string, unknown>;
      expect(trace['planExecutable']).toBe(true);
    });
  });

  describe('route candidates trace', () => {
    it('route_candidates.routeSelectionPolicy equals selectionSource', () => {
      const result = buildPlanOnlyResult('consensus', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const routeCands = meta['route_candidates'] as Record<string, unknown>;
      expect(routeCands['routeSelectionPolicy']).toBe('explicit');
    });

    it('route_candidates.selectedRoute is null when no models available', () => {
      const result = buildPlanOnlyResult('single', 'explicit', 'request-flag', REQ, CTX_EMPTY_MODELS, null, 0.7, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const routeCands = meta['route_candidates'] as Record<string, unknown>;
      expect(routeCands['selectedRoute']).toBeNull();
    });

    it('route_candidates.selectedRoute is a model id when models are available', () => {
      const result = buildPlanOnlyResult('single', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: true });
      const meta = result.metadata as Record<string, unknown>;
      const routeCands = meta['route_candidates'] as Record<string, unknown>;
      expect(typeof routeCands['selectedRoute']).toBe('string');
    });

    it('route_candidates.candidates are all available=false for unregistered strategy', () => {
      const result = buildPlanOnlyResult('sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX_WITH_MODELS, null, 0.9, { registered: false });
      const meta = result.metadata as Record<string, unknown>;
      const routeCands = meta['route_candidates'] as Record<string, unknown>;
      const candidates = routeCands['candidates'] as Array<{ available: boolean }>;
      expect(candidates.every(c => c.available === false)).toBe(true);
    });
  });

  describe('detection path preserved in metadata', () => {
    it('dry_run_interception_path matches the passed detectionPath', () => {
      for (const path of ['request-flag', 'ailin-metadata-flag', 'eval-flag'] as const) {
        const result = buildPlanOnlyResult('single', 'explicit', path, REQ, CTX_WITH_MODELS, null, 0.9);
        const meta = result.metadata as Record<string, unknown>;
        expect(meta['dry_run_interception_path']).toBe(path);
      }
    });
  });
});
