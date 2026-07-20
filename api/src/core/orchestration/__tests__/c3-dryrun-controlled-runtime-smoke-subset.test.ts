// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Subset manifest invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_SMOKE_MIN_SUBSET_PLANS,
  C3_SMOKE_MAX_SUBSET_PLANS,
} from '@/core/experiment/c3-dryrun-controlled-runtime-smoke-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-controlled-runtime-smoke-subset-manifest.json');
const subset = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — subset manifest', () => {
  it('contract subset bounds are 3..5', () => {
    expect(C3_SMOKE_MIN_SUBSET_PLANS).toBe(3);
    expect(C3_SMOKE_MAX_SUBSET_PLANS).toBe(5);
  });

  const maybe = subset ? describe : describe.skip;
  maybe('generated subset manifest (local verification)', () => {
    it('case 5: subset has 3..5 plans', () => {
      expect(subset.subsetPlanCount).toBeGreaterThanOrEqual(C3_SMOKE_MIN_SUBSET_PLANS);
      expect(subset.subsetPlanCount).toBeLessThanOrEqual(C3_SMOKE_MAX_SUBSET_PLANS);
    });
    it('case 6: includes a strategy plan', () => {
      expect(subset.coverage.includesStrategyPlan).toBe(true);
    });
    it('case 7: includes a baseline plan', () => {
      expect(subset.coverage.includesBaselinePlan).toBe(true);
    });
    it('case 8: includes a placeholder-guarded plan', () => {
      expect(subset.coverage.includesPlaceholderGuardedPlan).toBe(true);
    });
    it('case 9: includes a model_probe_validated plan', () => {
      expect(subset.coverage.includesModelProbeValidatedPlan).toBe(true);
    });
    it('every subset entry carries a selectionReason', () => {
      expect(subset.subset.every((e: any) => Array.isArray(e.selectionReason) && e.selectionReason.length > 0)).toBe(true);
    });
  });
});
