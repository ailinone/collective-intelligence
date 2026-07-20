// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-trace-schema.test.ts — MVP 3
 *
 * Proves the trace's structural contract:
 *   - Serializable via JSON (no Map / Set / Date / functions).
 *   - Carries routingMode, selected ids, candidatesByStage, latencyByPhase.
 *   - After redaction, NEVER contains a forbidden key (top-level or nested).
 */

import { describe, expect, it } from 'vitest';
import { redactRoutingTrace } from '../routing-redaction';
import {
  ROUTING_TRACE_ALLOWED_KEYS,
  ROUTING_TRACE_FORBIDDEN_KEYS,
} from '../routing-decision-trace';
import {
  TRACE_WITH_PII,
  VALID_TRACE,
  makeValidTrace,
} from './fixtures/routing-trace.fixture';

function deepKeys(obj: unknown, out: string[] = []): string[] {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      deepKeys(v, out);
    }
    if (Array.isArray(v)) {
      for (const item of v) deepKeys(item, out);
    }
  }
  return out;
}

describe('routing-trace-schema — serializability', () => {
  it('valid trace round-trips through JSON', () => {
    const json = JSON.stringify(VALID_TRACE);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json);
    expect(parsed.traceId).toBe(VALID_TRACE.traceId);
    expect(parsed.routingMode).toBe(VALID_TRACE.routingMode);
  });

  it('redacted trace round-trips through JSON', () => {
    const redacted = redactRoutingTrace(VALID_TRACE);
    const json = JSON.stringify(redacted);
    const parsed = JSON.parse(json);
    expect(parsed.traceId).toBe(redacted.traceId);
  });

  it('makeValidTrace produces a serializable object', () => {
    for (let i = 0; i < 5; i += 1) {
      const t = makeValidTrace(`t-${i}`);
      expect(() => JSON.stringify(t)).not.toThrow();
    }
  });
});

describe('routing-trace-schema — required fields present', () => {
  it('redacted trace has routingMode field', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect(out.routingMode).toBeDefined();
  });

  it('redacted trace has the selected* fields (even if null)', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect('selectedCanonicalModelId' in out).toBe(true);
    expect('selectedOfferingId' in out).toBe(true);
    expect('selectedRouteId' in out).toBe(true);
  });

  it('redacted trace has candidatesByStage', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect(out.candidatesByStage).toBeDefined();
    expect(typeof out.candidatesByStage).toBe('object');
  });

  it('redacted trace has latencyByPhase', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect(out.latencyByPhase).toBeDefined();
    expect(typeof out.latencyByPhase).toBe('object');
  });

  it('redacted trace has scoreBreakdown', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect(out.scoreBreakdown).toBeDefined();
  });

  it('redacted trace has rejectedByStage as an array', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect(Array.isArray(out.rejectedByStage)).toBe(true);
  });

  it('redacted trace has strategyPlan with strategy + routes', () => {
    const out = redactRoutingTrace(VALID_TRACE);
    expect(out.strategyPlan.strategy).toBeDefined();
    expect(Array.isArray(out.strategyPlan.routes)).toBe(true);
  });
});

describe('routing-trace-schema — forbidden keys are absent after redaction', () => {
  it('no forbidden key appears anywhere in the redacted output (deep walk)', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    const keys = deepKeys(out);
    for (const forbidden of ROUTING_TRACE_FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('serialized JSON contains no PII substrings from the input', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    const json = JSON.stringify(out);
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('passport number');
    expect(json).not.toContain('Alice Liddell');
    expect(json).not.toContain('+1-415-555-0123');
  });
});

describe('routing-trace-schema — top-level keys are allow-listed', () => {
  it('every top-level key of the redacted trace is in ROUTING_TRACE_ALLOWED_KEYS', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    for (const k of Object.keys(out)) {
      expect(ROUTING_TRACE_ALLOWED_KEYS.has(k)).toBe(true);
    }
  });

  it('a fully-populated trace serialises without throwing', () => {
    const populated = {
      ...VALID_TRACE,
      selectedCanonicalModelId: 'anthropic:claude-opus-4-7',
      selectedOfferingId: 'uid-anthropic-claude-opus-4-7',
      selectedRouteId: 'uid-anthropic-claude-opus-4-7::anthropic',
      candidatesByStage: { initial: 30, after_modality: 24, final: 5 },
      scoreBreakdown: { semantic: 0.7, capability: 0.9, cost: 0.5 },
      latencyByPhase: { embed: 5, retrieve: 3, score: 2, plan: 1 },
      strategyPlan: { strategy: 'single_best', routes: ['route-1'] },
      outcomeStatus: 'success' as const,
      outcomeLatencyMs: 480,
    };
    const out = redactRoutingTrace(populated);
    const json = JSON.stringify(out);
    const parsed = JSON.parse(json);
    expect(parsed.selectedCanonicalModelId).toBe('anthropic:claude-opus-4-7');
    expect(parsed.outcomeStatus).toBe('success');
    expect(parsed.outcomeLatencyMs).toBe(480);
  });
});
