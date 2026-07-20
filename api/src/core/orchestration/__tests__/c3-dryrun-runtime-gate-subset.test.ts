// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Subset manifest invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_RUNTIME_GATE_MIN_SUBSET_PLANS,
  C3_RUNTIME_GATE_MAX_SUBSET_PLANS,
} from '@/core/experiment/c3-dryrun-runtime-gate-contract';

const ARTIFACT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-runtime-gate-subset-manifest.json');
const subset = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;

describe('01C.1B-C3-DRYRUN-RUNTIME-GATE — subset manifest', () => {
  describe('contract bounds', () => {
    it('subset bounds are 6..12', () => {
      expect(C3_RUNTIME_GATE_MIN_SUBSET_PLANS).toBe(6);
      expect(C3_RUNTIME_GATE_MAX_SUBSET_PLANS).toBe(12);
    });
  });

  const maybe = subset ? describe : describe.skip;
  maybe('generated subset manifest (local verification)', () => {
    it('case 3: subset count is within 6..12', () => {
      expect(subset.subsetPlanCount).toBeGreaterThanOrEqual(C3_RUNTIME_GATE_MIN_SUBSET_PLANS);
      expect(subset.subsetPlanCount).toBeLessThanOrEqual(C3_RUNTIME_GATE_MAX_SUBSET_PLANS);
    });
    it('case 4: includes strategy plans', () => {
      expect(subset.coverage.includesStrategyPlans).toBe(true);
    });
    it('case 5: includes baseline plans', () => {
      expect(subset.coverage.includesBaselinePlans).toBe(true);
    });
    it('case 6: includes a placeholder-guarded plan', () => {
      expect(subset.coverage.includesPlaceholderGuardedPlan).toBe(true);
    });
    it('case 7: includes a model_probe_validated plan', () => {
      expect(subset.coverage.includesModelProbeValidatedPlan).toBe(true);
    });
    it('covers single, cost-cascade, a collective strategy, and critique/multipass', () => {
      expect(subset.coverage.includesSingle).toBe(true);
      expect(subset.coverage.includesCostCascade).toBe(true);
      expect(subset.coverage.includesCollective).toBe(true);
      expect(subset.coverage.includesCritiqueOrMultipass).toBe(true);
    });
    it('every subset entry carries a selectionReason', () => {
      expect(subset.subset.every((e: any) => Array.isArray(e.selectionReason) && e.selectionReason.length > 0)).toBe(true);
    });
  });
});
