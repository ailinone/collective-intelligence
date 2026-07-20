// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R3 §12d — Strategy prompt / cost / route trace tests.
 *
 * Verifies that buildPlanOnlyResult() includes all expected trace structures:
 *   - model_ranking_trace: candidateModels, selectionPolicy, modelCount
 *   - cost_quality_trace: estimatedPlanCostUsd=0, expectedQualityScore, routeReadinessScore
 *   - route_candidates: candidates, selectedRoute, routeSelectionPolicy
 *   - route_trace: non-empty array of strings
 *   - models_considered: array of model ids
 *
 * These tests pin the SM-R3 §7 trace contract:
 * all validators should pass the deepFind() scan.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX3: OrchestrationContext = {
  requestId: 'sm-r3-trace-001',
  taskType: 'analysis',
  qualityTarget: 0.88,
  preferSpeed: false,
  models: [
    { id: 'model-x', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-y', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'model-z', provider: 'mistral' } as OrchestrationContext['models'][0],
    { id: 'model-w', provider: 'google' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'analyse this' }],
  dryRun: true as const,
};

function build(strategy: string, qualityTarget = 0.88) {
  const result = buildPlanOnlyResult(
    strategy, 'explicit', 'request-flag', REQ, CTX3, null, qualityTarget, { registered: true },
  );
  return result.metadata as Record<string, unknown>;
}

describe('01C.1B-SM-R3 §12d — strategy prompt/cost/route trace', () => {
  describe('model_ranking_trace', () => {
    it('model_ranking_trace is present in metadata', () => {
      const meta = build('single');
      expect(meta['model_ranking_trace']).toBeDefined();
    });

    it('candidateModels is an array', () => {
      const meta = build('consensus');
      const mrt = meta['model_ranking_trace'] as Record<string, unknown>;
      expect(Array.isArray(mrt['candidateModels'])).toBe(true);
    });

    it('candidateModels contains up to 5 models from context', () => {
      const meta = build('single');
      const mrt = meta['model_ranking_trace'] as Record<string, unknown>;
      const candidates = mrt['candidateModels'] as Array<{ id: string }>;
      // CTX3 has 4 models → 4 candidates
      expect(candidates.length).toBeLessThanOrEqual(5);
      expect(candidates.length).toBeGreaterThan(0);
    });

    it('modelCount reflects actual model count', () => {
      const meta = build('debate');
      const mrt = meta['model_ranking_trace'] as Record<string, unknown>;
      expect(mrt['modelCount']).toBe(4); // CTX3 has 4 models
    });

    it('selectionPolicy equals the selectionSource', () => {
      const meta = build('cost-cascade');
      const mrt = meta['model_ranking_trace'] as Record<string, unknown>;
      expect(mrt['selectionPolicy']).toBe('explicit');
    });

    it('each candidate has an id field', () => {
      const meta = build('quality-multipass');
      const mrt = meta['model_ranking_trace'] as Record<string, unknown>;
      const candidates = mrt['candidateModels'] as Array<{ id: string }>;
      for (const c of candidates) {
        expect(typeof c.id).toBe('string');
        expect(c.id.length).toBeGreaterThan(0);
      }
    });
  });

  describe('route_candidates', () => {
    it('route_candidates is present in metadata', () => {
      const meta = build('single');
      expect(meta['route_candidates']).toBeDefined();
    });

    it('routeSelectionPolicy is set', () => {
      const meta = build('consensus');
      const rc = meta['route_candidates'] as Record<string, unknown>;
      expect(typeof rc['routeSelectionPolicy']).toBe('string');
    });

    it('candidates is an array of objects', () => {
      const meta = build('debate');
      const rc = meta['route_candidates'] as Record<string, unknown>;
      expect(Array.isArray(rc['candidates'])).toBe(true);
    });

    it('selectedRoute is a string when models are available', () => {
      const meta = build('expert-panel');
      const rc = meta['route_candidates'] as Record<string, unknown>;
      expect(typeof rc['selectedRoute']).toBe('string');
    });

    it('all candidates have estimatedCostUsd=0', () => {
      const meta = build('single');
      const rc = meta['route_candidates'] as Record<string, unknown>;
      const candidates = rc['candidates'] as Array<{ estimatedCostUsd: number }>;
      for (const c of candidates) {
        expect(c.estimatedCostUsd).toBe(0);
      }
    });
  });

  describe('route_trace', () => {
    it('route_trace is an array', () => {
      const meta = build('single');
      expect(Array.isArray(meta['route_trace'])).toBe(true);
    });

    it('route_trace is non-empty', () => {
      const meta = build('consensus');
      const trace = meta['route_trace'] as string[];
      expect(trace.length).toBeGreaterThan(0);
    });

    it('route_trace entries are strings', () => {
      const meta = build('debate');
      const trace = meta['route_trace'] as string[];
      for (const entry of trace) {
        expect(typeof entry).toBe('string');
      }
    });
  });

  describe('models_considered', () => {
    it('models_considered is an array', () => {
      const meta = build('single');
      expect(Array.isArray(meta['models_considered'])).toBe(true);
    });

    it('models_considered matches candidateModels ids', () => {
      const meta = build('consensus');
      const considered = meta['models_considered'] as string[];
      const mrt = meta['model_ranking_trace'] as Record<string, unknown>;
      const candidates = mrt['candidateModels'] as Array<{ id: string }>;
      for (const id of considered) {
        expect(candidates.some(c => c.id === id)).toBe(true);
      }
    });
  });

  describe('cost_quality_trace strategy heuristics', () => {
    it('consensus has higher expectedQualityScore than single', () => {
      const metaConsensus = build('consensus', 0.85);
      const metaSingle = build('single', 0.85);
      const qConsensus = (metaConsensus['cost_quality_trace'] as Record<string, unknown>)['expectedQualityScore'] as number;
      const qSingle = (metaSingle['cost_quality_trace'] as Record<string, unknown>)['expectedQualityScore'] as number;
      expect(qConsensus).toBeGreaterThan(qSingle);
    });

    it('all strategies have expectedQualityScore between 0 and 1', () => {
      const strategies = ['single', 'cost-cascade', 'consensus', 'debate', 'quality-multipass', 'expert-panel'];
      for (const s of strategies) {
        const meta = build(s, 0.8);
        const cqt = meta['cost_quality_trace'] as Record<string, unknown>;
        const q = cqt['expectedQualityScore'] as number;
        expect(q).toBeGreaterThanOrEqual(0);
        expect(q).toBeLessThanOrEqual(1);
      }
    });

    it('routeReadinessScore is between 0 and 1', () => {
      const meta = build('single');
      const cqt = meta['cost_quality_trace'] as Record<string, unknown>;
      const rrs = cqt['routeReadinessScore'] as number;
      expect(rrs).toBeGreaterThanOrEqual(0);
      expect(rrs).toBeLessThanOrEqual(1);
    });

    it('estimatedLatencyMs is defined and positive for all strategies', () => {
      const strategies = ['single', 'cost-cascade', 'consensus', 'debate'];
      for (const s of strategies) {
        const meta = build(s);
        const cqt = meta['cost_quality_trace'] as Record<string, unknown>;
        const latency = cqt['estimatedLatencyMs'] as number;
        expect(typeof latency).toBe('number');
        expect(latency).toBeGreaterThan(0);
      }
    });
  });

  describe('SM-R3 §11 deepFind compatibility', () => {
    function deepFind(obj: unknown, key: string): unknown {
      if (obj === null || typeof obj !== 'object') return undefined;
      if (key in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[key];
      for (const v of Object.values(obj as Record<string, unknown>)) {
        const found = deepFind(v, key);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    it('deepFind finds "candidateModels" in metadata', () => {
      const meta = build('single');
      expect(deepFind(meta, 'candidateModels')).toBeDefined();
    });

    it('deepFind finds "routeSelectionPolicy" in metadata', () => {
      const meta = build('consensus');
      expect(deepFind(meta, 'routeSelectionPolicy')).toBeDefined();
    });

    it('deepFind finds "planFingerprint" in metadata', () => {
      const meta = build('debate');
      expect(deepFind(meta, 'planFingerprint')).toBeDefined();
    });

    it('deepFind finds "steps" (executionPlan.steps) in metadata', () => {
      const meta = build('consensus');
      expect(deepFind(meta, 'steps')).toBeDefined();
    });

    it('deepFind finds "executable" in metadata', () => {
      const meta = build('single');
      expect(deepFind(meta, 'executable')).toBeDefined();
    });

    it('deepFind finds "dryRun"=true in metadata', () => {
      const meta = build('cost-cascade');
      expect(deepFind(meta, 'dryRun')).toBe(true);
    });

    it('deepFind finds "planOnly"=true in metadata', () => {
      const meta = build('single');
      expect(deepFind(meta, 'planOnly')).toBe(true);
    });
  });
});
