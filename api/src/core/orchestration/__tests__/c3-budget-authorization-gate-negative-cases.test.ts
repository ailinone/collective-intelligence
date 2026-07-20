// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Negative authorization cases (real guard).
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateC3BudgetAuthorization,
  type C3BudgetAuthorizationRequest,
  type C3BudgetAuthorizationConfig,
} from '@/core/experiment/c3-budget-authorization-gate-contract';

const cfg: C3BudgetAuthorizationConfig = {
  allowlistProviders: new Set(['huggingface']),
  allowlistModels: new Set(['Qwen/Qwen2.5-7B-Instruct']),
  budget: { maxTotalCostUsd: 0.05, maxInputTokens: 1200, maxOutputTokens: 300 },
  envelope: { approvalStatus: 'not_approved', effectiveAuthorization: false },
};
function valid(): C3BudgetAuthorizationRequest {
  return {
    dryRunFalse: false, billable: false, c3ExecutionAuthorized: false,
    approvedPlanFingerprint: 'pf', approvedBudgetFingerprint: 'bf', approvedAllowlistFingerprint: 'af', approvedKillSwitchFingerprint: 'kf',
    fingerprintMismatch: false, providerId: 'huggingface', modelId: 'Qwen/Qwen2.5-7B-Instruct',
    candidateClass: 'model_probe_validated', modelProbeStatus: 'validated', requiresModelProbeBeforeBillableExecution: false,
    costUsd: 0.01, inputTokens: 100, outputTokens: 50, maxRetries: 0, streaming: false, fallbackEnabled: false,
    killSwitchActive: true, providerBoundarySentry: true, externalNetworkSentry: true,
  };
}
function rejected(mut: (r: C3BudgetAuthorizationRequest) => void, reason: string) {
  const r = valid();
  mut(r);
  const res = evaluateC3BudgetAuthorization(r, cfg);
  expect(res.executionAllowed).toBe(false);
  expect(res.reasons).toContain(reason);
  expect(res.cost_usd).toBe(0);
  expect(res.usage.total_tokens).toBe(0);
  expect(res.effectiveAuthorization).toBe(false);
}

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — negative cases (real guard)', () => {
  it('a maximally-valid request is STILL blocked (only approval reasons)', () => {
    const res = evaluateC3BudgetAuthorization(valid(), cfg);
    expect(res.executionAllowed).toBe(false);
    expect(res.reasons.every((x) => x === 'not_approved' || x === 'effective_authorization_false')).toBe(true);
  });

  it('case 13: dryRun=false without approval rejected', () => rejected((r) => { r.dryRunFalse = true; }, 'dryrun_false_without_approval'));
  it('case 14: billable without approval rejected', () => rejected((r) => { r.billable = true; }, 'billable_without_approval'));
  it('case 15: c3ExecutionAuthorized=true without approval rejected', () => rejected((r) => { r.c3ExecutionAuthorized = true; }, 'c3_execution_auth_true_without_approval'));
  it('case 16a: provider outside allowlist rejected', () => rejected((r) => { r.providerId = 'rogue'; }, 'provider_outside_allowlist'));
  it('case 16b: model outside allowlist rejected', () => rejected((r) => { r.modelId = 'rogue/model'; }, 'model_outside_allowlist'));
  it('case 17: catalog_candidate rejected', () => rejected((r) => { r.candidateClass = 'catalog_candidate'; }, 'catalog_candidate'));
  it('case 18: placeholder rejected', () => rejected((r) => { r.modelId = '__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_x__'; }, 'placeholder_candidate'));
  it('case 19: requiresModelProbeBeforeBillable rejected', () => rejected((r) => { r.requiresModelProbeBeforeBillableExecution = true; }, 'requires_model_probe_before_billable'));
  it('hf wildcard rejected', () => rejected((r) => { r.modelId = 'huggingface/*'; }, 'hf_wildcard'));
  it('unknown provider status rejected', () => rejected((r) => { r.modelProbeStatus = 'unknown'; }, 'unknown_provider_status'));
  it('case 20: maxRetries > 0 rejected', () => rejected((r) => { r.maxRetries = 1; }, 'max_retries_gt_zero'));
  it('case 21: streaming true rejected', () => rejected((r) => { r.streaming = true; }, 'streaming_true'));
  it('case 22: budget exceeded rejected', () => rejected((r) => { r.costUsd = 0.1; }, 'budget_exceeded'));
  it('case 23a: input tokens exceeded rejected', () => rejected((r) => { r.inputTokens = 5000; }, 'input_tokens_exceeded'));
  it('case 23b: output tokens exceeded rejected', () => rejected((r) => { r.outputTokens = 5000; }, 'output_tokens_exceeded'));
  it('case 24: fallback enabled rejected', () => rejected((r) => { r.fallbackEnabled = true; }, 'fallback_enabled'));
  it('case 25: fingerprint mismatch rejected', () => rejected((r) => { r.fingerprintMismatch = true; }, 'fingerprint_mismatch'));
  it('missing plan fingerprint rejected', () => rejected((r) => { r.approvedPlanFingerprint = null; }, 'missing_plan_fingerprint'));
  it('case 26: kill switch inactive rejected', () => rejected((r) => { r.killSwitchActive = false; }, 'kill_switch_inactive'));
  it('provider boundary sentry missing rejected', () => rejected((r) => { r.providerBoundarySentry = false; }, 'provider_boundary_sentry_missing'));
  it('external network sentry missing rejected', () => rejected((r) => { r.externalNetworkSentry = false; }, 'external_network_sentry_missing'));

  const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-budget-authorization-gate-negative-responses.json');
  const nr = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;
  const maybe = nr ? describe : describe.skip;
  maybe('generated negative responses (local verification)', () => {
    it('all 25 cases rejected, expected reason present, execution-safe', () => {
      expect(nr.responseCount).toBeGreaterThanOrEqual(25);
      expect(nr.allRejected).toBe(true);
      expect(nr.allExpectedPresent).toBe(true);
      expect(nr.allSafe).toBe(true);
    });
  });
});
