// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Contract invariants + guards.
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
  isC3RuntimeExecutionLocked,
  isC3NonResolvableRuntimeSentinel,
} from '@/core/experiment/c3-dryrun-runtime-gate-contract';

const safeResponse = {
  dryRun: true,
  planOnly: true,
  c3ExecutionAuthorized: false,
  billableProviderCallsAuthorized: false,
  providerCallExecuted: false,
  providerCallsExecuted: 0,
  modelProbesExecuted: 0,
  providerProbesExecuted: 0,
  cost_usd: 0,
  usage: { total_tokens: 0 },
};

describe('01C.1B-C3-DRYRUN-RUNTIME-GATE — contract', () => {
  it('case 33: all execution authorizations are false', () => {
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

  it('case 34: isC3RuntimeExecutionLocked is true for a safe response', () => {
    expect(isC3RuntimeExecutionLocked(safeResponse)).toBe(true);
  });

  it('case 35: isC3RuntimeExecutionLocked is false for a positive cost', () => {
    expect(isC3RuntimeExecutionLocked({ ...safeResponse, cost_usd: 0.0001 })).toBe(false);
  });

  it('case 36: isC3RuntimeExecutionLocked is false for positive usage', () => {
    expect(isC3RuntimeExecutionLocked({ ...safeResponse, usage: { total_tokens: 1 } })).toBe(false);
  });

  it('also false when an execution lock or counter flips', () => {
    expect(isC3RuntimeExecutionLocked({ ...safeResponse, providerCallExecuted: true })).toBe(false);
    expect(isC3RuntimeExecutionLocked({ ...safeResponse, c3ExecutionAuthorized: true })).toBe(false);
    expect(isC3RuntimeExecutionLocked({ ...safeResponse, providerCallsExecuted: 1 })).toBe(false);
    expect(isC3RuntimeExecutionLocked({ ...safeResponse, dryRun: false })).toBe(false);
  });

  it('case 37: isC3NonResolvableRuntimeSentinel detects PLACEHOLDER_MODEL sentinel', () => {
    expect(isC3NonResolvableRuntimeSentinel('__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_deepseek_1__')).toBe(true);
  });

  it('case 38: isC3NonResolvableRuntimeSentinel detects MODEL_PROBE_VALIDATED sentinel', () => {
    expect(isC3NonResolvableRuntimeSentinel('__C3_DRYRUN_DESIGN_MODEL_PROBE_VALIDATED_inworld__')).toBe(true);
    expect(isC3NonResolvableRuntimeSentinel('__C3_DRYRUN_DESIGN_MODEL_PROBE_VALIDATED_infermatic__')).toBe(true);
  });

  it('a genuinely resolvable model id is NOT flagged as a sentinel', () => {
    expect(isC3NonResolvableRuntimeSentinel('Qwen/Qwen2.5-7B-Instruct')).toBe(false);
  });
});
