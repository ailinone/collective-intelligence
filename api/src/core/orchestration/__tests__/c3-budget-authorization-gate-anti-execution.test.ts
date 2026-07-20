// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Anti-execution invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isC3BudgetExecutionLocked } from '@/core/experiment/c3-budget-authorization-gate-contract';

const safe = {
  dryRunFalseAuthorized: false, billableProviderCallsAuthorized: false, c3ExecutionAuthorized: false,
  effectiveAuthorization: false, approvalStatus: 'not_approved', providerCallExecuted: false,
  providerCallsExecuted: 0, modelProbesExecuted: 0, providerProbesExecuted: 0, cost_usd: 0, totalCostUsd: 0, usage: { total_tokens: 0 },
};

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — anti-execution', () => {
  it('execution-lock guard accepts a fully-locked, unapproved state', () => {
    expect(isC3BudgetExecutionLocked(safe)).toBe(true);
  });
  it('guard rejects approved / effective / cost / authorized flips', () => {
    expect(isC3BudgetExecutionLocked({ ...safe, approvalStatus: 'approved' })).toBe(false);
    expect(isC3BudgetExecutionLocked({ ...safe, effectiveAuthorization: true })).toBe(false);
    expect(isC3BudgetExecutionLocked({ ...safe, c3ExecutionAuthorized: true })).toBe(false);
    expect(isC3BudgetExecutionLocked({ ...safe, billableProviderCallsAuthorized: true })).toBe(false);
    expect(isC3BudgetExecutionLocked({ ...safe, cost_usd: 0.0001 })).toBe(false);
    expect(isC3BudgetExecutionLocked({ ...safe, usage: { total_tokens: 1 } })).toBe(false);
  });

  const names = ['input-lock', 'budget-policy', 'allowlist', 'kill-switch', 'approval-envelope', 'negative-case', 'anti-execution', 'final'];
  const artifacts = names
    .map((n) => resolve(process.cwd(), 'tmp', `01c1b-c3-budget-authorization-gate-${n}-validator.json`))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const maybe = artifacts.length === names.length ? describe : describe.skip;
  maybe('generated validator artifacts (local verification)', () => {
    it('cases 27-28: all validators passed with no findings', () => {
      for (const a of artifacts) {
        expect(a.pass).toBe(true);
        expect(a.findings ?? []).toEqual([]);
      }
    });
  });
});
