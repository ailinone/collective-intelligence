// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Subset + mode invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isC3ParityAllowedMode,
  isC3ParityForbiddenMode,
  C3_PARITY_MIN_SUBSET_PLANS,
  C3_PARITY_MAX_SUBSET_PLANS,
} from '@/core/experiment/c3-dryrun-parity-gate-contract';

function read(name: string) {
  const p = resolve(process.cwd(), 'tmp', name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
const mode = read('01c1b-c3-dryrun-parity-gate-mode-decision.json');
const subset = read('01c1b-c3-dryrun-parity-gate-subset-manifest.json');

describe('01C.1B-C3-DRYRUN-PARITY-GATE — subset + mode', () => {
  it('case 2: real_in_process_entrypoint_parity is an allowed mode', () => {
    expect(isC3ParityAllowedMode('real_in_process_entrypoint_parity')).toBe(true);
  });
  it('case 3: forbidden modes are rejected', () => {
    for (const m of ['offline_only_parity', 'synthetic_only_parity', 'local_adapter_only_parity', 'fingerprint_only_without_structural_parity', 'structural_only_without_fingerprint_parity']) {
      expect(isC3ParityForbiddenMode(m)).toBe(true);
      expect(isC3ParityAllowedMode(m)).toBe(false);
    }
  });
  it('subset bounds are 3..5', () => {
    expect(C3_PARITY_MIN_SUBSET_PLANS).toBe(3);
    expect(C3_PARITY_MAX_SUBSET_PLANS).toBe(5);
  });

  const maybe = mode && subset ? describe : describe.skip;
  maybe('generated subset + mode artifacts (local verification)', () => {
    it('case 2: selected mode is allowed', () => {
      expect(isC3ParityAllowedMode(mode.selectedMode)).toBe(true);
    });
    it('case 4/5: subset is 3..5 and matches controlled smoke', () => {
      expect(subset.subsetPlanCount).toBeGreaterThanOrEqual(3);
      expect(subset.subsetPlanCount).toBeLessThanOrEqual(5);
      expect(subset.matchesControlledSmoke).toBe(true);
      expect(subset.subset.every((e: any) => e.existsInIndex && e.sourcePlanPathExists)).toBe(true);
    });
  });
});
