// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Negative cases (real gate).
 * Each adversarial mutation must be rejected with the expected reason; the gate must stay
 * execution-safe (no provider call, zero cost) even while rejecting.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateC3RuntimeGate,
  type C3RuntimeGateRequest,
} from '@/core/experiment/c3-dryrun-runtime-gate-contract';

const allowedC = new Set(['cand_a']);
const allowedP = new Set(['prov_a']);

function valid(): C3RuntimeGateRequest {
  return {
    dryRun: true,
    planOnly: true,
    c3ExecutionAuthorized: false,
    billableProviderCallsAuthorized: false,
    providerCallExecuted: false,
    cost_usd: 0,
    usage: { total_tokens: 0 },
    selectedCandidates: [
      { candidateId: 'cand_a', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct', selectedExecutableModel: false },
    ],
    hiddenFallbackDetected: false,
    fanout: 1,
    fanoutCap: 1,
    planFingerprint: 'fp_plan',
    promptFingerprint: 'fp_prompt',
    provenance: { complete: true },
  };
}
function gate(req: C3RuntimeGateRequest) {
  return evaluateC3RuntimeGate(req, allowedC, allowedP);
}
function rejectedWith(req: C3RuntimeGateRequest, reason: string) {
  const r = gate(req);
  expect(r.rejected).toBe(true);
  expect(r.rejectionReasons).toContain(reason);
  // Execution-safe even while rejecting:
  expect(r.providerCallExecuted).toBe(false);
  expect(r.providerCallsExecuted).toBe(0);
  expect(r.cost_usd).toBe(0);
  expect(r.usage.total_tokens).toBe(0);
}

describe('01C.1B-C3-DRYRUN-RUNTIME-GATE — negative cases', () => {
  it('case 15: dryRun=false rejected', () => rejectedWith({ ...valid(), dryRun: false }, 'dryrun_false'));
  it('case 15b: planOnly=false rejected (full lock-surface coverage)', () => rejectedWith({ ...valid(), planOnly: false }, 'planonly_false'));
  it('case 16: c3ExecutionAuthorized=true rejected', () => rejectedWith({ ...valid(), c3ExecutionAuthorized: true }, 'c3_execution_authorized_true'));
  it('case 17: billableProviderCallsAuthorized=true rejected', () => rejectedWith({ ...valid(), billableProviderCallsAuthorized: true }, 'billable_provider_calls_true'));
  it('case 18: providerCallExecuted=true rejected', () => rejectedWith({ ...valid(), providerCallExecuted: true }, 'provider_call_executed_true'));
  it('case 19: cost_usd=0.0001 rejected', () => rejectedWith({ ...valid(), cost_usd: 0.0001 }, 'cost_positive'));
  it('case 20: usage.total_tokens=1 rejected', () => rejectedWith({ ...valid(), usage: { total_tokens: 1 } }, 'usage_tokens_positive'));
  it('case 21: candidate outside manifest rejected', () =>
    rejectedWith({ ...valid(), selectedCandidates: [{ candidateId: 'rogue', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct' }] }, 'candidate_outside_manifest'));
  it('case 22: provider outside manifest rejected', () =>
    rejectedWith({ ...valid(), selectedCandidates: [{ candidateId: 'cand_a', providerId: 'rogue', modelId: 'Qwen/Qwen2.5-7B-Instruct' }] }, 'provider_outside_manifest'));
  it('case 23: placeholder executable rejected', () =>
    rejectedWith(
      { ...valid(), selectedCandidates: [{ candidateId: 'cand_a', providerId: 'prov_a', modelId: '__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_deepseek_1__', selectedExecutableModel: true }] },
      'placeholder_executable',
    ));
  it('case 24: hidden fallback rejected', () => rejectedWith({ ...valid(), hiddenFallbackDetected: true }, 'hidden_fallback'));
  it('case 25: fanout over cap rejected', () => rejectedWith({ ...valid(), fanout: 5, fanoutCap: 4 }, 'fanout_over_cap'));
  it('case 25b: candidate-array length over cap rejected (even when scalar fanout lies)', () =>
    rejectedWith(
      {
        ...valid(),
        fanout: 1,
        fanoutCap: 1,
        selectedCandidates: [
          { candidateId: 'cand_a', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct' },
          { candidateId: 'cand_a', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct' },
          { candidateId: 'cand_a', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct' },
        ],
      },
      'fanout_over_cap',
    ));
  it('case 26: invalid fingerprint rejected', () => rejectedWith({ ...valid(), planFingerprint: '', promptFingerprint: '' }, 'invalid_fingerprint'));
  it('case 27: provenance incomplete rejected', () => rejectedWith({ ...valid(), provenance: { complete: false } }, 'provenance_incomplete'));

  const ARTIFACT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-runtime-gate-negative-responses.json');
  const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;
  const maybe = artifact ? describe : describe.skip;
  maybe('generated negative responses (local verification)', () => {
    it('all 13 negatives rejected with expected reason and execution-safe', () => {
      expect(artifact.responseCount).toBeGreaterThanOrEqual(13);
      expect(artifact.allRejected).toBe(true);
      expect(artifact.allExpectedReasonPresent).toBe(true);
      expect(artifact.allExecutionSafe).toBe(true);
    });
  });
});
