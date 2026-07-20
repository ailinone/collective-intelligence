// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PLAN-VALIDATION — Provenance completeness invariants.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { C3_PROVENANCE_REQUIRED_FIELDS } from '@/core/experiment/c3-dryrun-experiment-design-contract';

const INDEX = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-plan-validation-plan-index.json');
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : null;
const plans: any[] = index
  ? index.plans
      .map((p: any) => resolve(process.cwd(), p.path))
      .filter((p: string) => existsSync(p))
      .map((p: string) => JSON.parse(readFileSync(p, 'utf8')))
  : [];

describe('01C.1B-C3-DRYRUN-PLAN-VALIDATION — provenance', () => {
  describe('required provenance fields (contract)', () => {
    it('case 22: includes modelEligibilityTrace', () => {
      expect(C3_PROVENANCE_REQUIRED_FIELDS).toContain('modelEligibilityTrace');
    });
    it('case 23: includes providerRouteTrace', () => {
      expect(C3_PROVENANCE_REQUIRED_FIELDS).toContain('providerRouteTrace');
    });
    it('case 24: includes samplingTrace', () => {
      expect(C3_PROVENANCE_REQUIRED_FIELDS).toContain('samplingTrace');
    });
    it('case 25: includes budgetTrace', () => {
      expect(C3_PROVENANCE_REQUIRED_FIELDS).toContain('budgetTrace');
    });
    it('case 26: includes planFingerprint', () => {
      expect(C3_PROVENANCE_REQUIRED_FIELDS).toContain('planFingerprint');
    });
  });

  const maybe = index ? describe : describe.skip;
  maybe('generated plans provenance (local verification)', () => {
    it('every plan declares complete provenance with all required fields present', () => {
      for (const p of plans) {
        expect(p.provenance?.complete).toBe(true);
        const present = new Set(p.provenance?.presentFields ?? []);
        for (const field of p.provenance?.requiredFields ?? []) {
          expect(present.has(field)).toBe(true);
        }
      }
    });

    it('case 26: every plan carries planFingerprint and promptFingerprint', () => {
      for (const p of plans) {
        expect(typeof p.planFingerprint).toBe('string');
        expect(p.planFingerprint.length).toBeGreaterThan(0);
        expect(typeof p.promptFingerprint).toBe('string');
        expect(p.promptFingerprint.length).toBeGreaterThan(0);
      }
    });
  });
});
