// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Approval envelope invariants (INACTIVE).
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-budget-authorization-gate-approval-envelope.json');
const env = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

const maybe = env ? describe : describe.skip;
describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — approval envelope', () => {
  maybe('generated approval envelope (local verification)', () => {
    it('case 11: approval status not_approved', () => {
      expect(env.approvalStatus).toBe('not_approved');
      expect(env.manualApprovalRequired).toBe(true);
    });
    it('case 12: effectiveAuthorization false', () => {
      expect(env.effectiveAuthorization).toBe(false);
    });
    it('all four fingerprints required but null (unapproved)', () => {
      expect(env.approvedPlanFingerprintRequired).toBe(true);
      expect(env.approvedBudgetFingerprintRequired).toBe(true);
      expect(env.approvedAllowlistFingerprintRequired).toBe(true);
      expect(env.approvedKillSwitchFingerprintRequired).toBe(true);
      expect(env.approvedPlanFingerprint).toBeNull();
      expect(env.approvedBudgetFingerprint).toBeNull();
      expect(env.approvedAllowlistFingerprint).toBeNull();
      expect(env.approvedKillSwitchFingerprint).toBeNull();
    });
    it('all authorizations false; future authorization stage required', () => {
      expect(env.dryRunFalseAuthorized).toBe(false);
      expect(env.billableProviderCallsAuthorized).toBe(false);
      expect(env.c3ExecutionAuthorized).toBe(false);
      expect(env.futureStageRequired).toBe('01C.1B-C3-MINIMAL-BILLABLE-MICROPROBE-AUTHORIZATION');
    });
  });
});
