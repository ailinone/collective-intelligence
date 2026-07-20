// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Input lock invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_SOURCE_PLAN_ARTIFACT_COUNT,
  C3_RUNTIME_GATE_MODE,
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED,
  MODEL_PROBES_AUTHORIZED,
  K_AUTHORIZED,
  C3_TOTAL_COST_USD,
} from '@/core/experiment/c3-dryrun-runtime-gate-contract';

const ARTIFACT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-runtime-gate-input-lock.json');
const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-RUNTIME-GATE — input lock', () => {
  describe('contract constants', () => {
    it('case 2: source plan artifact count is 49', () => {
      expect(C3_SOURCE_PLAN_ARTIFACT_COUNT).toBe(49);
    });
    it('runtime gate mode is local_adapter_only (safest)', () => {
      expect(C3_RUNTIME_GATE_MODE).toBe('local_adapter_only');
    });
    it('case 33: contract keeps every authorization false; cost zero', () => {
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
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated input-lock artifact (local verification)', () => {
    it('case 1: input lock verifies the previous plan validation + safety pass', () => {
      expect(artifact.pass).toBe(true);
      expect(artifact.previousPlanValidationPass).toBe(true);
      expect(artifact.previousSafetyPass).toBe(true);
    });
    it('carries 49 plans/templates and authorizes no execution', () => {
      expect(artifact.planArtifactCount).toBe(49);
      expect(artifact.payloadTemplateCount).toBe(49);
      expect(artifact.c3ExecutionAuthorized).toBe(false);
      expect(artifact.billableProviderCallsAuthorized).toBe(false);
    });
  });
});
