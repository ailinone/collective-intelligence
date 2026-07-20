// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PLAN-VALIDATION — Input lock invariants.
 * Contract constants are CI-safe; tmp artifacts verified only when present.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_PAYLOAD_TEMPLATE_COUNT,
  C3_PLAN_ARTIFACT_COUNT,
  C3_PLAN_VALIDATION_MODE,
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED,
  MODEL_PROBES_AUTHORIZED,
  K_AUTHORIZED,
  C3_TOTAL_COST_USD,
} from '@/core/experiment/c3-dryrun-plan-validation-contract';

const ARTIFACT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-plan-validation-input-lock.json');
const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-PLAN-VALIDATION — input lock', () => {
  describe('contract constants', () => {
    it('case 2: payload template count is 49', () => {
      expect(C3_PAYLOAD_TEMPLATE_COUNT).toBe(49);
    });
    it('plan artifact count is 49 (1:1 with templates)', () => {
      expect(C3_PLAN_ARTIFACT_COUNT).toBe(49);
      expect(C3_PLAN_ARTIFACT_COUNT).toBe(C3_PAYLOAD_TEMPLATE_COUNT);
    });
    it('validation mode is offline_compiler (safest)', () => {
      expect(C3_PLAN_VALIDATION_MODE).toBe('offline_compiler');
    });
    it('case 30: contract keeps every authorization false; cost zero', () => {
      const locks: false[] = [
        C3_EXECUTION_AUTHORIZED,
        DRYRUN_FALSE_AUTHORIZED,
        BILLABLE_PROVIDER_CALLS_AUTHORIZED,
        PROVIDER_PROBES_AUTHORIZED,
        MODEL_PROBES_AUTHORIZED,
        K_AUTHORIZED,
      ];
      for (const l of locks) expect(l).toBe(false);
      expect(C3_TOTAL_COST_USD).toBe(0);
    });
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated input-lock artifact (local verification)', () => {
    it('case 1: input lock verifies the previous design + safety pass', () => {
      expect(artifact.pass).toBe(true);
      expect(artifact.previousDesignPass).toBe(true);
      expect(artifact.previousSafetyPass).toBe(true);
    });
    it('carries 49 templates and the locked canonical counts', () => {
      expect(artifact.payloadTemplateCount).toBe(49);
      expect(artifact.candidatePoolTotalCanonical).toBe(13808);
      expect(artifact.chatReadyProviders).toBe(23);
      expect(artifact.hfAllModelsCallableAssumed).toBe(false);
    });
    it('authorizes no execution', () => {
      expect(artifact.c3ExecutionAuthorized).toBe(false);
      expect(artifact.billableProviderCallsAuthorized).toBe(false);
    });
  });
});
