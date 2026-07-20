// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Contract invariants + guard.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import {
  C3_EXECUTION_AUTHORIZED, DRYRUN_FALSE_AUTHORIZED, BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED, MODEL_PROBES_AUTHORIZED, K_AUTHORIZED,
  C3_MAX_TOTAL_COST_USD, C3_MAX_RETRIES, C3_NON_STREAMING_REQUIRED,
  C3_APPROVAL_STATUS, C3_EFFECTIVE_AUTHORIZATION,
  evaluateC3BudgetAuthorization, type C3BudgetAuthorizationConfig,
} from '@/core/experiment/c3-budget-authorization-gate-contract';

const cfgUnapproved: C3BudgetAuthorizationConfig = {
  allowlistProviders: new Set(['huggingface']),
  allowlistModels: new Set(['Qwen/Qwen2.5-7B-Instruct']),
  budget: { maxTotalCostUsd: 0.05, maxInputTokens: 1200, maxOutputTokens: 300 },
  envelope: { approvalStatus: 'not_approved', effectiveAuthorization: false },
};

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — contract', () => {
  it('case 29: all execution authorizations are false', () => {
    for (const l of [C3_EXECUTION_AUTHORIZED, DRYRUN_FALSE_AUTHORIZED, BILLABLE_PROVIDER_CALLS_AUTHORIZED, PROVIDER_PROBES_AUTHORIZED, MODEL_PROBES_AUTHORIZED, K_AUTHORIZED] as false[]) {
      expect(l).toBe(false);
    }
  });
  it('budget constants are conservative', () => {
    expect(C3_MAX_TOTAL_COST_USD).toBeLessThanOrEqual(0.05);
    expect(C3_MAX_RETRIES).toBe(0);
    expect(C3_NON_STREAMING_REQUIRED).toBe(true);
  });
  it('approval defaults are inactive', () => {
    expect(C3_APPROVAL_STATUS).toBe('not_approved');
    expect(C3_EFFECTIVE_AUTHORIZATION).toBe(false);
  });
  it('guard NEVER authorizes execution under an unapproved envelope (even a valid request)', () => {
    const valid = {
      dryRunFalse: false, billable: false, c3ExecutionAuthorized: false,
      approvedPlanFingerprint: 'pf', approvedBudgetFingerprint: 'bf', approvedAllowlistFingerprint: 'af', approvedKillSwitchFingerprint: 'kf',
      fingerprintMismatch: false, providerId: 'huggingface', modelId: 'Qwen/Qwen2.5-7B-Instruct',
      candidateClass: 'model_probe_validated', modelProbeStatus: 'validated', requiresModelProbeBeforeBillableExecution: false,
      costUsd: 0.01, inputTokens: 100, outputTokens: 50, maxRetries: 0, streaming: false, fallbackEnabled: false,
      killSwitchActive: true, providerBoundarySentry: true, externalNetworkSentry: true,
    };
    const res = evaluateC3BudgetAuthorization(valid, cfgUnapproved);
    expect(res.executionAllowed).toBe(false);
    expect(res.effectiveAuthorization).toBe(false);
    expect(res.reasons).toContain('not_approved');
    expect(res.cost_usd).toBe(0);
    expect(res.usage.total_tokens).toBe(0);
  });
});
