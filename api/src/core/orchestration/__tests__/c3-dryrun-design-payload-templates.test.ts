// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — Payload template invariants.
 *
 * Every payload template is a PLAN ONLY: dryRun=true, planOnly=true, all execution
 * locks false. No template may authorize a billable call, provider probe or model probe.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { C3_PAYLOAD_TEMPLATE_INVARIANTS } from '@/core/experiment/c3-dryrun-experiment-design-contract';

const PATH = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-design-payload-templates.json');
const payloads = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — payload templates', () => {
  describe('template invariants (contract)', () => {
    it('case 16: dryRun is true', () => {
      expect(C3_PAYLOAD_TEMPLATE_INVARIANTS.dryRun).toBe(true);
    });
    it('case 17: planOnly is true', () => {
      expect(C3_PAYLOAD_TEMPLATE_INVARIANTS.planOnly).toBe(true);
    });
    it('case 18: c3ExecutionAuthorized is false', () => {
      expect(C3_PAYLOAD_TEMPLATE_INVARIANTS.c3ExecutionAuthorized).toBe(false);
    });
    it('case 19: billableProviderCallsAuthorized is false', () => {
      expect(C3_PAYLOAD_TEMPLATE_INVARIANTS.billableProviderCallsAuthorized).toBe(false);
    });
    it('case 20: providerProbesAuthorized is false', () => {
      expect(C3_PAYLOAD_TEMPLATE_INVARIANTS.providerProbesAuthorized).toBe(false);
    });
    it('case 21: modelProbesAuthorized is false', () => {
      expect(C3_PAYLOAD_TEMPLATE_INVARIANTS.modelProbesAuthorized).toBe(false);
    });
  });

  const maybe = payloads ? describe : describe.skip;
  maybe('generated payload templates (local verification)', () => {
    it('templates exist', () => {
      expect(payloads.templateCount).toBeGreaterThan(0);
      expect(payloads.templates.length).toBe(payloads.templateCount);
    });

    it('cases 16-17: every template is dryRun=true and planOnly=true', () => {
      expect(payloads.templates.every((t: any) => t.request.dryRun === true)).toBe(true);
      expect(payloads.templates.every((t: any) => t.request.planOnly === true)).toBe(true);
    });

    it('cases 18-21: every template withholds all execution authorization', () => {
      const ok = payloads.templates.every(
        (t: any) =>
          t.request.c3ExecutionAuthorized === false &&
          t.request.billableProviderCallsAuthorized === false &&
          t.request.providerProbesAuthorized === false &&
          t.request.modelProbesAuthorized === false &&
          t.executionLocks.c3ExecutionAuthorized === false &&
          t.executionLocks.billableProviderCallsAuthorized === false &&
          t.executionLocks.providerProbesAuthorized === false &&
          t.executionLocks.modelProbesAuthorized === false,
      );
      expect(ok).toBe(true);
    });

    it('every template carries selection, budget and provenance references', () => {
      const ok = payloads.templates.every(
        (t: any) =>
          Boolean(t.taskId) &&
          Boolean(t.strategyId || t.baselineId) &&
          Boolean(t.candidateSelectionRef) &&
          Boolean(t.budgetPolicyRef) &&
          Boolean(t.provenancePolicyRef),
      );
      expect(ok).toBe(true);
    });
  });
});
