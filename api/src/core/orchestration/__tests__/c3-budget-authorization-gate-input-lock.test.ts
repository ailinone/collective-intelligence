// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Input lock + mode invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_EXECUTION_AUTHORIZED, DRYRUN_FALSE_AUTHORIZED, BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED, MODEL_PROBES_AUTHORIZED, K_AUTHORIZED,
  C3_BUDGET_AUTHORIZATION_GATE_MODE, C3_EFFECTIVE_AUTHORIZATION, C3_APPROVAL_STATUS,
} from '@/core/experiment/c3-budget-authorization-gate-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-budget-authorization-gate-input-lock.json');
const artifact = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — input lock + mode', () => {
  it('case 29: contract keeps every authorization false', () => {
    for (const l of [C3_EXECUTION_AUTHORIZED, DRYRUN_FALSE_AUTHORIZED, BILLABLE_PROVIDER_CALLS_AUTHORIZED, PROVIDER_PROBES_AUTHORIZED, MODEL_PROBES_AUTHORIZED, K_AUTHORIZED] as false[]) {
      expect(l).toBe(false);
    }
  });
  it('case 2: mode is offline_authorization_design', () => {
    expect(C3_BUDGET_AUTHORIZATION_GATE_MODE).toBe('offline_authorization_design');
  });
  it('contract approval status not_approved; effective authorization false', () => {
    expect(C3_APPROVAL_STATUS).toBe('not_approved');
    expect(C3_EFFECTIVE_AUTHORIZATION).toBe(false);
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated input-lock artifact (local verification)', () => {
    it('case 1: input lock verifies the parity gate', () => {
      expect(artifact.pass).toBe(true);
      expect(artifact.parityGateDecisionVerified).toBe(true);
      expect(artifact.previousSafetyPass).toBe(true);
      expect(artifact.previousAdversarialPass).toBe(true);
    });
  });
});
