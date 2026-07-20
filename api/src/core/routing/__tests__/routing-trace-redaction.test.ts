// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-trace-redaction.test.ts — MVP 3
 *
 * Proves:
 *   - prompt / messages / rawContext / userMessage / context / email /
 *     phone / fullName / userId / userName / userInput are removed.
 *   - Email patterns inside reason / route id strings are scrubbed.
 *   - Phone patterns inside reason strings are scrubbed.
 *   - Original input object is NOT mutated.
 *   - Output has ONLY the documented allowlist of top-level keys.
 *   - taskProfile only carries categorical fields.
 */

import { describe, expect, it } from 'vitest';
import { redactRoutingTrace } from '../routing-redaction';
import {
  ROUTING_TRACE_ALLOWED_KEYS,
  ROUTING_TRACE_FORBIDDEN_KEYS,
} from '../routing-decision-trace';
import {
  TRACE_PII_IN_TASK_PROFILE,
  TRACE_WITH_PII,
  VALID_TRACE,
} from './fixtures/routing-trace.fixture';

describe('redaction — forbidden keys are stripped', () => {
  it('removes top-level prompt / rawPrompt / messages / userMessage / context / rawContext', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    for (const key of ROUTING_TRACE_FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(out, key)).toBe(false);
    }
  });

  it('removes top-level email / phone / fullName / userId / userName / userInput', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    // These are all in ROUTING_TRACE_FORBIDDEN_KEYS — same loop covers them.
    expect((out as Record<string, unknown>).email).toBeUndefined();
    expect((out as Record<string, unknown>).phone).toBeUndefined();
    expect((out as Record<string, unknown>).fullName).toBeUndefined();
    expect((out as Record<string, unknown>).userId).toBeUndefined();
    expect((out as Record<string, unknown>).userName).toBeUndefined();
    expect((out as Record<string, unknown>).userInput).toBeUndefined();
  });

  it('strips prompt / messages BURIED in taskProfile', () => {
    const out = redactRoutingTrace(TRACE_PII_IN_TASK_PROFILE);
    expect(Object.keys(out.taskProfile)).toEqual([
      'taskType',
      'complexity',
      'modalities',
      'riskLevel',
      'privacyMode',
    ]);
    expect((out.taskProfile as Record<string, unknown>).prompt).toBeUndefined();
    expect((out.taskProfile as Record<string, unknown>).messages).toBeUndefined();
  });
});

describe('redaction — top-level keys conform to the allowlist', () => {
  it('output object has ONLY keys from ROUTING_TRACE_ALLOWED_KEYS', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    for (const k of Object.keys(out)) {
      expect(ROUTING_TRACE_ALLOWED_KEYS.has(k)).toBe(true);
    }
  });
});

describe('redaction — email and phone scrubbing inside strings', () => {
  it('scrubs email patterns inside rejected.reason', () => {
    const input = {
      ...VALID_TRACE,
      rejectedByStage: [
        {
          routeId: 'route-a',
          stage: 'capability_filter',
          reason: 'user alice@example.com requested missing tool',
        },
      ],
    } as unknown;
    const out = redactRoutingTrace(input);
    expect(out.rejectedByStage[0].reason).not.toContain('alice@example.com');
    expect(out.rejectedByStage[0].reason).toContain('[REDACTED]');
  });

  it('scrubs phone patterns inside rejected.reason', () => {
    const input = {
      ...VALID_TRACE,
      rejectedByStage: [
        {
          routeId: 'route-a',
          stage: 'capability_filter',
          reason: 'callback to +55 11 91234-5678 was attempted',
        },
      ],
    } as unknown;
    const out = redactRoutingTrace(input);
    expect(out.rejectedByStage[0].reason).not.toContain('91234-5678');
    expect(out.rejectedByStage[0].reason).toContain('[REDACTED]');
  });

  it('scrubs both email and phone patterns combined', () => {
    const input = {
      ...VALID_TRACE,
      rejectedByStage: [
        {
          routeId: 'route-a',
          stage: 'x',
          reason: 'contact bob@corp.example with phone (415) 555-0123',
        },
      ],
    } as unknown;
    const out = redactRoutingTrace(input);
    expect(out.rejectedByStage[0].reason).not.toContain('bob@corp.example');
    expect(out.rejectedByStage[0].reason).not.toContain('555-0123');
  });

  it('does NOT redact arbitrary short digit sequences (no false positives)', () => {
    const input = {
      ...VALID_TRACE,
      rejectedByStage: [
        {
          routeId: 'route-a',
          stage: 'x',
          reason: 'p95 was 720ms, p99 was 950ms',
        },
      ],
    } as unknown;
    const out = redactRoutingTrace(input);
    expect(out.rejectedByStage[0].reason).toBe('p95 was 720ms, p99 was 950ms');
  });
});

describe('redaction — does NOT mutate the original input', () => {
  it('input forbidden keys remain on the input after redaction', () => {
    // Deep copy via JSON so the test does not rely on `Object.freeze` for the fixture.
    const input = JSON.parse(JSON.stringify(TRACE_WITH_PII)) as Record<string, unknown>;
    const inputCopy = JSON.parse(JSON.stringify(input));
    redactRoutingTrace(input);
    expect(input).toEqual(inputCopy);
  });
});

describe('redaction — defensive against bad input', () => {
  it('null input returns a sentinel trace with empty/zero values', () => {
    const out = redactRoutingTrace(null);
    expect(out.traceId).toBe('');
    expect(out.candidatesEvaluated).toBe(0);
    expect(out.routingMode).toBe('legacy');
    expect(out.taskProfile.taskType).toBe('unknown');
  });

  it('undefined input returns sentinel', () => {
    const out = redactRoutingTrace(undefined);
    expect(out.traceId).toBe('');
  });

  it('invalid routingMode falls back to "legacy"', () => {
    const out = redactRoutingTrace({
      ...VALID_TRACE,
      routingMode: 'definitely-not-a-mode',
    });
    expect(out.routingMode).toBe('legacy');
  });

  it('invalid pin substitution returns null (policyAuthorized must be true)', () => {
    const out = redactRoutingTrace({
      ...VALID_TRACE,
      pinSubstitution: {
        originalCanonicalModelId: 'x',
        originalRouteId: 'y',
        substitutedCanonicalModelId: 'a',
        substitutedRouteId: 'b',
        reason: 'original_route_blocked_no_credit',
        policyAuthorized: false, // ← invalid
        authorizingPolicy: 'test',
      },
    });
    expect(out.pinSubstitution).toBeNull();
  });

  it('JSON.stringify on redacted output never throws (serializable invariant)', () => {
    const out = redactRoutingTrace(TRACE_WITH_PII);
    expect(() => JSON.stringify(out)).not.toThrow();
    const json = JSON.stringify(out);
    // PII string must not survive a round-trip.
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('passport');
    expect(json).not.toContain('private thing');
  });
});
