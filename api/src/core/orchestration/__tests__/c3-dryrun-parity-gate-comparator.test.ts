// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Comparator parity (real compareC3ParitySnapshots).
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareC3ParitySnapshots,
  c3ParityCanonicalFingerprint,
  type C3ParityCanonicalSnapshot,
} from '@/core/experiment/c3-dryrun-parity-gate-contract';

function baseSnap(): C3ParityCanonicalSnapshot {
  return {
    planId: 'p1', taskId: 'T1_simple_factual', strategyId: 'single', baselineId: null,
    candidates: [
      { candidateId: 'c1', providerId: 'prov1', modelId: 'm1', candidateClass: 'model_probe_validated', modelProbeStatus: 'model_probe_validated', requiresModelProbeBeforeBillableExecution: false, selectedExecutableModel: false, providerRouteCreated: false },
      { candidateId: 'c2', providerId: 'prov2', modelId: 'm2', candidateClass: 'catalog_candidate', modelProbeStatus: 'not_model_probe_validated', requiresModelProbeBeforeBillableExecution: true, selectedExecutableModel: false, providerRouteCreated: false },
    ],
    unresolvedCatalogCandidates: ['c2'],
    fanout: 2, fanoutCap: 4,
    roles: [{ role: 'responder', candidateRef: 'c1', phase: 'direct_answer' }],
    budgetPolicyKey: '{"judgeRequired":false}',
    provenanceRequiredFields: ['taskId', 'strategyId', 'planFingerprint'],
    provenanceComplete: true,
    hiddenFallbackDetected: false,
    planFingerprint: 'pf_abc', promptFingerprint: 'pp_abc',
    runtimeResolvedStrategy: 'single', runtimeTaskType: 'T1_simple_factual', runtimePlanFingerprint: 'pf_run',
    runtimeProviderCallExecuted: false, runtimeCostUsd: 0, runtimeUsageTotalTokens: 0,
  };
}

describe('01C.1B-C3-DRYRUN-PARITY-GATE — comparator (identical snapshots pass)', () => {
  const approved = baseSnap();
  const runtime = baseSnap();
  const result = compareC3ParitySnapshots(approved, runtime);

  it('cases 11-28: identical snapshots → pass, no diffs, no drift', () => {
    expect(result.pass).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.driftReasons).toEqual([]);
  });

  it('canonical fingerprints are equal for identical snapshots', () => {
    expect(c3ParityCanonicalFingerprint(approved)).toBe(c3ParityCanonicalFingerprint(runtime));
  });

  it('canonical fingerprint changes when any critical field changes', () => {
    const mutated = baseSnap();
    mutated.strategyId = 'consensus';
    expect(c3ParityCanonicalFingerprint(approved)).not.toBe(c3ParityCanonicalFingerprint(mutated));
  });

  const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-parity-gate-parity-comparison.json');
  const cmp = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;
  const maybe = cmp ? describe : describe.skip;
  maybe('generated parity comparison (local verification)', () => {
    it('case 28: all plans pass with zero critical diffs', () => {
      expect(cmp.allPlansPass).toBe(true);
      expect(cmp.totalDiffs).toBe(0);
      expect(cmp.criticalDiffs).toBe(0);
    });
    it('every plan consistency check passed', () => {
      expect(cmp.comparisons.every((c: any) => Object.values(c.consistency).every(Boolean))).toBe(true);
    });
  });
});
