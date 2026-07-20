// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Input lock invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED,
  MODEL_PROBES_AUTHORIZED,
  K_AUTHORIZED,
  C3_TOTAL_COST_USD,
  C3_RUNTIME_PLAN_DRIFT_FORBIDDEN,
  C3_FINGERPRINT_MISMATCH_FORBIDDEN,
  C3_SILENT_PLAN_MUTATION_FORBIDDEN,
} from '@/core/experiment/c3-dryrun-parity-gate-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-parity-gate-input-lock.json');
const artifact = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-PARITY-GATE — input lock', () => {
  it('case 43: contract keeps every authorization false; cost zero', () => {
    for (const l of [C3_EXECUTION_AUTHORIZED, DRYRUN_FALSE_AUTHORIZED, BILLABLE_PROVIDER_CALLS_AUTHORIZED, PROVIDER_PROBES_AUTHORIZED, MODEL_PROBES_AUTHORIZED, K_AUTHORIZED] as false[]) {
      expect(l).toBe(false);
    }
    expect(C3_TOTAL_COST_USD).toBe(0);
  });

  it('drift / fingerprint / silent-mutation are forbidden by contract', () => {
    expect(C3_RUNTIME_PLAN_DRIFT_FORBIDDEN).toBe(true);
    expect(C3_FINGERPRINT_MISMATCH_FORBIDDEN).toBe(true);
    expect(C3_SILENT_PLAN_MUTATION_FORBIDDEN).toBe(true);
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated input-lock artifact (local verification)', () => {
    it('case 1: input lock verifies the previous controlled runtime smoke', () => {
      expect(artifact.pass).toBe(true);
      expect(artifact.previousControlledSmokePass).toBe(true);
      expect(artifact.previousMode).toBe('real_in_process_entrypoint');
      expect(artifact.syntheticGateOnlyPass).toBe(false);
    });
  });
});
