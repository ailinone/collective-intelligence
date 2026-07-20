// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Contract invariants + guards.
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
  isC3ControlledSmokeExecutionLocked,
  isC3SmokeAllowedMode,
  isC3SyntheticOnlyMode,
} from '@/core/experiment/c3-dryrun-controlled-runtime-smoke-contract';

const safe = {
  dryRun: true, planOnly: true, c3ExecutionAuthorized: false, billableProviderCallsAuthorized: false,
  providerCallExecuted: false, providerCallsExecuted: 0, modelProbesExecuted: 0, providerProbesExecuted: 0,
  cost_usd: 0, usage: { total_tokens: 0 }, hiddenFallbackDetected: false,
};

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — contract', () => {
  it('case 36: all execution authorizations are false', () => {
    for (const l of [
      C3_EXECUTION_AUTHORIZED,
      DRYRUN_FALSE_AUTHORIZED,
      BILLABLE_PROVIDER_CALLS_AUTHORIZED,
      PROVIDER_PROBES_AUTHORIZED,
      MODEL_PROBES_AUTHORIZED,
      K_AUTHORIZED,
    ] as false[]) {
      expect(l).toBe(false);
    }
  });

  it('case 37: isC3ControlledSmokeExecutionLocked is true for a safe response', () => {
    expect(isC3ControlledSmokeExecutionLocked(safe)).toBe(true);
  });
  it('case 38: false for a positive cost', () => {
    expect(isC3ControlledSmokeExecutionLocked({ ...safe, cost_usd: 0.0001 })).toBe(false);
  });
  it('case 39: false for positive usage', () => {
    expect(isC3ControlledSmokeExecutionLocked({ ...safe, usage: { total_tokens: 1 } })).toBe(false);
  });
  it('also false when provider call / exec auth flips', () => {
    expect(isC3ControlledSmokeExecutionLocked({ ...safe, providerCallExecuted: true })).toBe(false);
    expect(isC3ControlledSmokeExecutionLocked({ ...safe, c3ExecutionAuthorized: true })).toBe(false);
    expect(isC3ControlledSmokeExecutionLocked({ ...safe, dryRun: false })).toBe(false);
  });

  it('case 40: isC3SyntheticOnlyMode is true for local_adapter_only', () => {
    expect(isC3SyntheticOnlyMode('local_adapter_only')).toBe(true);
    expect(isC3SyntheticOnlyMode('offline_compiler_only')).toBe(true);
    expect(isC3SyntheticOnlyMode('real_in_process_entrypoint')).toBe(false);
  });

  it('case 41: isC3SmokeAllowedMode rejects local_adapter_only', () => {
    expect(isC3SmokeAllowedMode('local_adapter_only')).toBe(false);
    expect(isC3SmokeAllowedMode('real_in_process_entrypoint')).toBe(true);
  });
});
