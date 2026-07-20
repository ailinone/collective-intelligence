// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Contract invariants + guards.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import {
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED,
  MODEL_PROBES_AUTHORIZED,
  K_AUTHORIZED,
  isC3ParityExecutionLocked,
  isC3ParityAllowedMode,
  isC3ParityForbiddenMode,
} from '@/core/experiment/c3-dryrun-parity-gate-contract';

const safe = {
  dryRun: true, planOnly: true, c3ExecutionAuthorized: false, billableProviderCallsAuthorized: false,
  providerCallExecuted: false, providerCallsExecuted: 0, modelProbesExecuted: 0, providerProbesExecuted: 0,
  cost_usd: 0, usage: { total_tokens: 0 }, hiddenFallbackDetected: false,
};

describe('01C.1B-C3-DRYRUN-PARITY-GATE — contract', () => {
  it('case 43: all execution authorizations are false', () => {
    for (const l of [C3_EXECUTION_AUTHORIZED, DRYRUN_FALSE_AUTHORIZED, BILLABLE_PROVIDER_CALLS_AUTHORIZED, PROVIDER_PROBES_AUTHORIZED, MODEL_PROBES_AUTHORIZED, K_AUTHORIZED] as false[]) {
      expect(l).toBe(false);
    }
  });
  it('case 44: isC3ParityExecutionLocked true for a safe response', () => {
    expect(isC3ParityExecutionLocked(safe)).toBe(true);
  });
  it('case 45: false for positive cost', () => {
    expect(isC3ParityExecutionLocked({ ...safe, cost_usd: 0.0001 })).toBe(false);
  });
  it('case 46: false for positive usage', () => {
    expect(isC3ParityExecutionLocked({ ...safe, usage: { total_tokens: 1 } })).toBe(false);
  });
  it('also false when provider call / exec auth flips', () => {
    expect(isC3ParityExecutionLocked({ ...safe, providerCallExecuted: true })).toBe(false);
    expect(isC3ParityExecutionLocked({ ...safe, c3ExecutionAuthorized: true })).toBe(false);
  });
  it('case 47: isC3ParityForbiddenMode rejects offline_only_parity', () => {
    expect(isC3ParityForbiddenMode('offline_only_parity')).toBe(true);
  });
  it('case 48: isC3ParityAllowedMode accepts real_in_process_entrypoint_parity', () => {
    expect(isC3ParityAllowedMode('real_in_process_entrypoint_parity')).toBe(true);
    expect(isC3ParityAllowedMode('offline_only_parity')).toBe(false);
  });
});
