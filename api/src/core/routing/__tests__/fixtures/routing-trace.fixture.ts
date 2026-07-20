// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-trace.fixture.ts — deterministic RoutingDecisionTrace samples.
 *
 * Used by:
 *   - routing-trace-async.test.ts
 *   - routing-trace-bounded-queue.test.ts
 *   - routing-trace-redaction.test.ts (both "good" and intentionally-bad)
 *   - routing-trace-failure-isolated.test.ts
 *   - routing-trace-schema.test.ts
 */

import type { RoutingDecisionTrace } from '../../routing-decision-trace';

/**
 * A minimal but FULLY-VALID trace. Every required field present, no
 * forbidden keys, no PII anywhere.
 */
export const VALID_TRACE: RoutingDecisionTrace = Object.freeze({
  traceId: 'trace-fixture-001',
  requestId: 'req-fixture-001',
  timestamp: '2026-05-12T12:00:00.000Z',
  routingMode: 'legacy' as const,
  taskProfile: {
    taskType: 'general',
    complexity: 'medium',
    modalities: ['text'],
    riskLevel: 'low',
    privacyMode: 'standard',
  },
  semanticIndexBackend: 'none' as const,
  candidatesEvaluated: 30,
  candidatesByStage: { initial: 30 },
  rejectedByStage: [],
  selectedCanonicalModelId: null,
  selectedOfferingId: null,
  selectedRouteId: null,
  scoreBreakdown: {},
  strategyPlan: { strategy: 'none', routes: [] },
  explicitModelPin: null,
  pinSubstitution: null,
  latencyByPhase: {},
});

/**
 * Builds a fresh valid trace with a custom id — useful when the test
 * needs N traces to fill the queue.
 */
export function makeValidTrace(traceId: string): RoutingDecisionTrace {
  return {
    ...VALID_TRACE,
    traceId,
    requestId: `req-${traceId}`,
  };
}

/**
 * A trace that smuggles PII / prompts INTO the object. The redaction
 * layer must strip everything except the documented allowlist.
 *
 * Cast as `unknown` because TypeScript would (correctly) reject the
 * extra fields if we used `RoutingDecisionTrace` directly. The
 * production caller can't reach here via the type, but the redactor
 * must defend against runtime drift.
 */
export const TRACE_WITH_PII = Object.freeze({
  traceId: 'trace-fixture-002',
  requestId: 'req-fixture-002',
  timestamp: '2026-05-12T12:01:00.000Z',
  routingMode: 'legacy',
  taskProfile: {
    taskType: 'general',
    complexity: 'medium',
    modalities: ['text'],
    riskLevel: 'low',
    privacyMode: 'standard',
    // ⚠ Forbidden: prompt content inside taskProfile
    prompt: 'Hello, my email is alice@example.com and phone is +55 11 91234-5678',
    rawContext: 'system prompt with private data',
  },
  semanticIndexBackend: 'none',
  candidatesEvaluated: 5,
  candidatesByStage: { initial: 5 },
  rejectedByStage: [
    {
      routeId: 'route-x',
      stage: 'capability_filter',
      reason: 'missing_tool — user alice@example.com requested unavailable feature',
    },
  ],
  selectedCanonicalModelId: null,
  selectedOfferingId: null,
  selectedRouteId: null,
  scoreBreakdown: { semantic: 0.7, cost: 0.3 },
  strategyPlan: { strategy: 'none', routes: [] },
  explicitModelPin: null,
  pinSubstitution: null,
  latencyByPhase: { task_profile: 0.4, candidate_pool: 1.2 },
  // ⚠ Forbidden: top-level prompt + messages
  prompt: 'tell me a joke about my passport number 555-12-3456',
  rawPrompt: 'duplicate of prompt',
  messages: [{ role: 'user', content: 'private thing' }],
  userMessage: 'leaked',
  context: 'leaked',
  rawContext: 'leaked',
  email: 'leaked-pii@example.com',
  phone: '+1-415-555-0123',
  fullName: 'Alice Liddell',
  userId: 'user-99',
  userName: 'alice',
  userInput: 'leaked',
} as unknown);

/**
 * A trace with a forbidden field BURIED deep inside `taskProfile`. The
 * redactor strips it because `redactTaskProfile` uses a strict allowlist.
 */
export const TRACE_PII_IN_TASK_PROFILE = Object.freeze({
  ...VALID_TRACE,
  taskProfile: {
    taskType: 'general',
    complexity: 'medium',
    modalities: ['text'],
    riskLevel: 'low',
    privacyMode: 'standard',
    prompt: 'should be stripped',
    messages: ['should be stripped'],
  },
} as unknown);
