// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Input lock invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { C3_SOURCE_PLAN_ARTIFACT_COUNT } from '@/core/experiment/c3-dryrun-runtime-gate-contract';
import {
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED,
  MODEL_PROBES_AUTHORIZED,
  K_AUTHORIZED,
  C3_TOTAL_COST_USD,
} from '@/core/experiment/c3-dryrun-controlled-runtime-smoke-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-controlled-runtime-smoke-input-lock.json');
const artifact = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — input lock', () => {
  it('case 2: source plan artifact count is 49', () => {
    expect(C3_SOURCE_PLAN_ARTIFACT_COUNT).toBe(49);
  });

  it('case 36: contract keeps every authorization false; cost zero', () => {
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
    expect(C3_TOTAL_COST_USD).toBe(0);
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated input-lock artifact (local verification)', () => {
    it('case 1: input lock verifies the previous runtime gate + safety + adversarial pass', () => {
      expect(artifact.pass).toBe(true);
      expect(artifact.previousRuntimeGatePass).toBe(true);
      expect(artifact.previousSafetyPass).toBe(true);
      expect(artifact.previousAdversarialPass).toBe(true);
    });
    it('previous mode was the synthetic local_adapter_only (this stage must go beyond it)', () => {
      expect(artifact.previousMode).toBe('local_adapter_only');
      expect(artifact.c3ExecutionAuthorized).toBe(false);
    });
  });
});
