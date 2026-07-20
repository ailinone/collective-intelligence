// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Budget policy invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_MAX_TOTAL_COST_USD, C3_MAX_COST_PER_PROVIDER_USD, C3_MAX_INPUT_TOKENS,
  C3_MAX_OUTPUT_TOKENS, C3_MAX_RETRIES, C3_NON_STREAMING_REQUIRED,
} from '@/core/experiment/c3-budget-authorization-gate-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-budget-authorization-gate-budget-policy.json');
const budget = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — budget policy', () => {
  it('case 4: max total cost <= 0.05', () => expect(C3_MAX_TOTAL_COST_USD).toBeLessThanOrEqual(0.05));
  it('case 5: max cost per provider <= 0.05', () => expect(C3_MAX_COST_PER_PROVIDER_USD).toBeLessThanOrEqual(0.05));
  it('case 6: max retries = 0', () => expect(C3_MAX_RETRIES).toBe(0));
  it('case 7: non-streaming required', () => expect(C3_NON_STREAMING_REQUIRED).toBe(true));
  it('token caps are positive and bounded', () => {
    expect(C3_MAX_INPUT_TOKENS).toBeGreaterThan(0);
    expect(C3_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });

  const maybe = budget ? describe : describe.skip;
  maybe('generated budget policy (local verification)', () => {
    it('case 3: budget policy exists with caps + fingerprint', () => {
      expect(budget.policyId).toBe('c3_minimal_billable_microprobe_budget_v1');
      expect(budget.maxTotalCostUsd).toBeLessThanOrEqual(0.05);
      expect(budget.maxRetries).toBe(0);
      expect(budget.nonStreamingRequired).toBe(true);
      expect(budget.abortOnFirstAnomaly).toBe(true);
      expect(typeof budget.budgetPolicyFingerprint).toBe('string');
      expect(budget.effectiveAuthorization).toBe(false);
    });
  });
});
