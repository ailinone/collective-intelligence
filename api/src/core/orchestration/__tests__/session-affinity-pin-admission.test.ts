// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Session-affinity pin admission gate (2026-09 long-context-delegation
 * follow-up).
 *
 * `evaluateSessionAffinityPinAdmission` / `modelFitsContext` are the pure
 * decision extracted from `OrchestrationEngine.buildContext()`'s
 * session-affinity block (same rationale as `pickSessionAffinityExecution`,
 * tested in the sibling `session-affinity-write-hook.test.ts`: instantiating
 * the full engine to reach this decision requires Prisma/Redis/provider
 * registry wiring unrelated to the decision itself).
 *
 * The specific regression this locks: admission used to require
 * `contextSize < pinnedModel.contextWindow` (`passesContextWindow`) as a hard
 * gate. `applyLongContextHandling()`'s delegation step only fires when the
 * request does NOT fit the pinned model — so the old gate made admission and
 * delegation mutually exclusive, and `pickDelegationModel()` was confirmed
 * dead code reachable only via directly invoking the private helper with a
 * hand-fed contextSize the real caller could never produce. `admit` here must
 * stay TRUE for an over-budget request (so buildContext() goes on to attempt
 * compaction/delegation) and only fall to FALSE for a genuinely untrustworthy
 * pin (no credit, wrong capabilities, or an unknown context window).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateSessionAffinityPinAdmission,
  modelFitsContext,
} from '../orchestration-engine';
import type { Model, ModelCapability } from '@/types';

function pinnedModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'pinned',
    providerId: 'acme',
    provider: 'acme',
    name: 'pinned',
    displayName: 'pinned',
    contextWindow: 2_000,
    maxOutputTokens: 1024,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat', 'text_generation'] as ModelCapability[],
    performance: { latencyMs: 100, throughput: 10, quality: 0.8, reliability: 0.9 },
    status: 'active',
    balanceStatus: 'has-credits',
    ...overrides,
  };
}

describe('modelFitsContext', () => {
  it('fits when contextSize is strictly under a known, positive contextWindow', () => {
    expect(modelFitsContext(pinnedModel({ contextWindow: 2_000 }), 1_000)).toBe(true);
  });

  it('does not fit when contextSize meets or exceeds the contextWindow', () => {
    expect(modelFitsContext(pinnedModel({ contextWindow: 2_000 }), 2_000)).toBe(false);
    expect(modelFitsContext(pinnedModel({ contextWindow: 2_000 }), 5_000)).toBe(false);
  });

  it('fails CLOSED on an unknown (0/undefined) contextWindow — never treated as evidence of fit', () => {
    expect(modelFitsContext(pinnedModel({ contextWindow: 0 }), 10)).toBe(false);
    expect(modelFitsContext(undefined, 10)).toBe(false);
  });
});

describe('evaluateSessionAffinityPinAdmission', () => {
  it('admits a pin that already fits, has credit, and needs no special capabilities', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel(),
      contextSize: 500,
      requiredCapabilities: undefined,
      requestTools: undefined,
    });
    expect(result).toEqual({
      admit: true,
      passesContextWindow: true,
      passesCredit: true,
      passesCapabilities: true,
      pinnedContextWindowKnown: true,
    });
  });

  it('REGRESSION GUARD: admits an over-budget request (passesContextWindow false) — this is exactly the case long-context handling exists to recover', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({ contextWindow: 2_000 }),
      contextSize: 50_000, // wildly over budget
      requiredCapabilities: undefined,
      requestTools: undefined,
    });
    expect(result.passesContextWindow).toBe(false);
    // The old bug: `admit` used to equal `passesContextWindow`, making this
    // case (and therefore delegation) unreachable. It must not anymore.
    expect(result.admit).toBe(true);
  });

  it('refuses admission when the context window is unknown — nothing to compact/delegate against', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({ contextWindow: 0 }),
      contextSize: 100,
      requiredCapabilities: undefined,
      requestTools: undefined,
    });
    expect(result.pinnedContextWindowKnown).toBe(false);
    expect(result.admit).toBe(false);
  });

  it('refuses admission when the pinned model has no credits', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({ balanceStatus: 'no-credits' }),
      contextSize: 100,
      requiredCapabilities: undefined,
      requestTools: undefined,
    });
    expect(result.passesCredit).toBe(false);
    expect(result.admit).toBe(false);
  });

  it('refuses admission when the pinned model explicitly lacks a required capability', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({ capabilities: ['chat', 'text_generation'] as ModelCapability[] }),
      contextSize: 100,
      requiredCapabilities: ['vision'] as ModelCapability[],
      requestTools: undefined,
    });
    expect(result.passesCapabilities).toBe(false);
    expect(result.admit).toBe(false);
  });

  it('admits when required capabilities are unknown (empty capabilities list) — fails open on missing metadata', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({ capabilities: [] as ModelCapability[] }),
      contextSize: 100,
      requiredCapabilities: ['vision'] as ModelCapability[],
      requestTools: undefined,
    });
    expect(result.passesCapabilities).toBe(true);
    expect(result.admit).toBe(true);
  });

  it('refuses admission when the request carries tools but the pin explicitly lacks function_calling', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({ capabilities: ['chat', 'text_generation'] as ModelCapability[] }),
      contextSize: 100,
      requiredCapabilities: undefined,
      requestTools: [{ type: 'function', function: { name: 'lookup' } }],
    });
    expect(result.passesCapabilities).toBe(false);
    expect(result.admit).toBe(false);
  });

  it('admits a tools request when the pin explicitly declares function_calling', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: pinnedModel({
        capabilities: ['chat', 'text_generation', 'function_calling'] as ModelCapability[],
      }),
      contextSize: 100,
      requiredCapabilities: undefined,
      requestTools: [{ type: 'function', function: { name: 'lookup' } }],
    });
    expect(result.passesCapabilities).toBe(true);
    expect(result.admit).toBe(true);
  });

  it('refuses admission outright when there is no pinned model at all', () => {
    const result = evaluateSessionAffinityPinAdmission({
      pinnedModel: undefined,
      contextSize: 100,
      requiredCapabilities: undefined,
      requestTools: undefined,
    });
    expect(result.admit).toBe(false);
  });
});
