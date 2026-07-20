// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Negative drift detection (real comparator).
 * Each mutation must be detected with its specific drift reason.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareC3ParitySnapshots,
  type C3ParityCanonicalSnapshot,
  type C3ParityDriftReason,
} from '@/core/experiment/c3-dryrun-parity-gate-contract';

function base(): C3ParityCanonicalSnapshot {
  return {
    planId: 'p1', taskId: 'T1', strategyId: 'single', baselineId: null,
    candidates: [
      { candidateId: 'c1', providerId: 'prov1', modelId: 'm1', candidateClass: 'catalog_candidate', modelProbeStatus: 'not_model_probe_validated', requiresModelProbeBeforeBillableExecution: true, selectedExecutableModel: false, providerRouteCreated: false },
    ],
    unresolvedCatalogCandidates: ['c1'],
    fanout: 1, fanoutCap: 4,
    roles: [{ role: 'responder', candidateRef: 'c1', phase: 'direct_answer' }],
    budgetPolicyKey: '{"x":1}',
    provenanceRequiredFields: ['taskId', 'strategyId', 'planFingerprint'],
    provenanceComplete: true,
    hiddenFallbackDetected: false,
    planFingerprint: 'pf_abc', promptFingerprint: 'pp_abc',
    runtimeResolvedStrategy: 'single', runtimeTaskType: 'T1', runtimePlanFingerprint: 'pf_run',
    runtimeProviderCallExecuted: false, runtimeCostUsd: 0, runtimeUsageTotalTokens: 0,
  };
}
function driftDetected(mutate: (s: C3ParityCanonicalSnapshot) => void, reason: C3ParityDriftReason) {
  const approved = base();
  const runtime = base();
  mutate(runtime);
  const r = compareC3ParitySnapshots(approved, runtime);
  expect(r.pass).toBe(false);
  expect(r.driftReasons).toContain(reason);
}

describe('01C.1B-C3-DRYRUN-PARITY-GATE — negative drift detection', () => {
  it('case 29: candidate_added', () => driftDetected((s) => s.candidates.push({ ...s.candidates[0]!, candidateId: 'extra' }), 'candidate_added'));
  it('case 30: candidate_removed', () => driftDetected((s) => { s.candidates.pop(); }, 'candidate_removed'));
  it('case 31: provider_changed', () => driftDetected((s) => { s.candidates[0]!.providerId = 'rogue'; }, 'provider_changed'));
  it('case 32: model_changed', () => driftDetected((s) => { s.candidates[0]!.modelId = 'rogue'; }, 'model_changed'));
  it('candidate_class_changed', () => driftDetected((s) => { s.candidates[0]!.candidateClass = 'model_probe_validated'; }, 'candidate_class_changed'));
  it('model_probe_status_changed', () => driftDetected((s) => { s.candidates[0]!.modelProbeStatus = 'rogue'; }, 'model_probe_status_changed'));
  it('case 33: fanout_changed', () => driftDetected((s) => { s.fanout = 9; }, 'fanout_changed'));
  it('fanout_cap_changed', () => driftDetected((s) => { s.fanoutCap = 9; }, 'fanout_cap_changed'));
  it('case 34: role_changed', () => driftDetected((s) => { s.roles[0]!.role = 'rogue'; }, 'role_changed'));
  it('budget_policy_changed', () => driftDetected((s) => { s.budgetPolicyKey = 'rogue'; }, 'budget_policy_changed'));
  it('case 35: fallback_inserted', () => driftDetected((s) => { s.hiddenFallbackDetected = true; }, 'fallback_inserted'));
  it('provenance_required_field_removed', () => driftDetected((s) => { s.provenanceRequiredFields = s.provenanceRequiredFields.slice(1); }, 'provenance_required_field_removed'));
  it('case 38: provenance_complete_false', () => driftDetected((s) => { s.provenanceComplete = false; }, 'provenance_complete_false'));
  it('case 36: plan_fingerprint_mismatch', () => driftDetected((s) => { s.planFingerprint = 'rogue'; }, 'plan_fingerprint_mismatch'));
  it('case 37: prompt_fingerprint_mismatch', () => driftDetected((s) => { s.promptFingerprint = 'rogue'; }, 'prompt_fingerprint_mismatch'));
  it('approved_plan_fingerprint_mismatch', () => driftDetected((s) => { s.runtimePlanFingerprint = 'rogue'; }, 'approved_plan_fingerprint_mismatch'));
  it('case 39: selected_executable_model_true', () => driftDetected((s) => { s.candidates[0]!.selectedExecutableModel = true; }, 'selected_executable_model_true'));
  it('case 40: provider_route_created_true', () => driftDetected((s) => { s.candidates[0]!.providerRouteCreated = true; }, 'provider_route_created_true'));

  const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-parity-gate-negative-drift-responses.json');
  const nr = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;
  const maybe = nr ? describe : describe.skip;
  maybe('generated negative-drift responses (local verification)', () => {
    it('all 18 drift cases rejected with expected reason, execution-safe', () => {
      expect(nr.responseCount).toBeGreaterThanOrEqual(18);
      expect(nr.allRejected).toBe(true);
      expect(nr.allExecutionSafe).toBe(true);
      expect(nr.responses.every((r: any) => r.expectedDriftPresent === true)).toBe(true);
    });
  });
});
