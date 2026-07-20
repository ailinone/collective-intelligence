// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PLAN-VALIDATION — Payload precheck invariants.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertC3PlanExecutionLocks,
  C3_PAYLOAD_TEMPLATE_COUNT,
} from '@/core/experiment/c3-dryrun-plan-validation-contract';

const ARTIFACT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-plan-validation-payload-precheck.json');
const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-PLAN-VALIDATION — payload precheck', () => {
  describe('precheck logic (contract guard)', () => {
    it('case 3+4: a record missing dryRun=true / planOnly=true is not execution-safe', () => {
      expect(assertC3PlanExecutionLocks({ dryRun: false, planOnly: true })).toBe(false);
      expect(assertC3PlanExecutionLocks({ dryRun: true, planOnly: false })).toBe(false);
    });

    it('case 5: a record with c3ExecutionAuthorized=true is rejected', () => {
      expect(
        assertC3PlanExecutionLocks({
          dryRun: true,
          planOnly: true,
          c3ExecutionAuthorized: true,
          billableProviderCallsAuthorized: false,
          providerCallExecuted: false,
          cost_usd: 0,
        }),
      ).toBe(false);
    });

    it('a fully clean dry-run/plan-only record passes', () => {
      expect(
        assertC3PlanExecutionLocks({
          dryRun: true,
          planOnly: true,
          c3ExecutionAuthorized: false,
          billableProviderCallsAuthorized: false,
          providerCallExecuted: false,
          cost_usd: 0,
        }),
      ).toBe(true);
    });

    it('expected payload template count is 49', () => {
      expect(C3_PAYLOAD_TEMPLATE_COUNT).toBe(49);
    });
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated payload-precheck artifact (local verification)', () => {
    it('precheck passed with 49 templates and no findings', () => {
      expect(artifact.pass).toBe(true);
      expect(artifact.templateCount).toBe(49);
      expect(artifact.findings).toEqual([]);
    });
  });
});
