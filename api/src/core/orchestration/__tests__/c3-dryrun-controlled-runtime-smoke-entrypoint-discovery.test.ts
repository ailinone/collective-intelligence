// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Entrypoint discovery invariants.
 * The real plan-only entrypoint must exist and be importable; synthetic-only mode is forbidden.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_SYNTHETIC_GATE_ONLY_PASS_FORBIDDEN,
  C3_CONTROLLED_SMOKE_REQUIRES_REAL_ENTRYPOINT,
  isC3SmokeAllowedMode,
  isC3SyntheticOnlyMode,
} from '@/core/experiment/c3-dryrun-controlled-runtime-smoke-contract';
// Importing the REAL entrypoint proves it is discoverable + loadable in-process.
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import { detectDryRun } from '@/core/orchestration/dry-run/dry-run-execution-guard';

function read(name: string) {
  const p = resolve(process.cwd(), 'tmp', name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
const discovery = read('01c1b-c3-dryrun-controlled-runtime-smoke-entrypoint-discovery.json');
const mode = read('01c1b-c3-dryrun-controlled-runtime-smoke-mode-decision.json');

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — entrypoint discovery', () => {
  it('case 2/3: a real runtime entrypoint exists and is importable', () => {
    expect(typeof buildPlanOnlyResult).toBe('function');
    expect(typeof detectDryRun).toBe('function');
    expect(C3_CONTROLLED_SMOKE_REQUIRES_REAL_ENTRYPOINT).toBe(true);
  });

  it('case 2: synthetic-only mode cannot pass', () => {
    expect(C3_SYNTHETIC_GATE_ONLY_PASS_FORBIDDEN).toBe(true);
    expect(isC3SyntheticOnlyMode('local_adapter_only')).toBe(true);
    expect(isC3SmokeAllowedMode('local_adapter_only')).toBe(false);
  });

  it('case 4: allowed modes are exactly the three real-entrypoint modes', () => {
    expect(isC3SmokeAllowedMode('real_in_process_entrypoint')).toBe(true);
    expect(isC3SmokeAllowedMode('local_http_plan_only')).toBe(true);
    expect(isC3SmokeAllowedMode('hybrid_real_entrypoint')).toBe(true);
    expect(isC3SmokeAllowedMode('offline_compiler_only')).toBe(false);
  });

  const maybe = discovery && mode ? describe : describe.skip;
  maybe('generated discovery + mode artifacts (local verification)', () => {
    it('case 3: real entrypoint discovered + production wiring confirmed', () => {
      expect(discovery.realRuntimeEntrypointDiscovered).toBe(true);
      expect(discovery.productionWiringConfirmed).toBe(true);
    });
    it('case 4: selected mode is a real-entrypoint mode (not synthetic)', () => {
      expect(isC3SmokeAllowedMode(mode.selectedMode)).toBe(true);
      expect(isC3SyntheticOnlyMode(mode.selectedMode)).toBe(false);
      expect(mode.syntheticGateOnlyPass).toBe(false);
    });
  });
});
