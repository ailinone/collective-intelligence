// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Negative cases via real guard + admission gate.
 * Each adversarial mutation is rejected by detectDryRun (real guard) or evaluateC3RuntimeGate
 * BEFORE the real entrypoint would run.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectDryRun } from '@/core/orchestration/dry-run/dry-run-execution-guard';
import { evaluateC3RuntimeGate } from '@/core/experiment/c3-dryrun-runtime-gate-contract';

const allowedC = new Set(['cand_a']);
const allowedP = new Set(['prov_a']);

function admit(req: any, env: any): string[] {
  const reasons: string[] = [];
  if (!detectDryRun(req).detected) reasons.push('dryrun_false');
  const gate = evaluateC3RuntimeGate(env, allowedC, allowedP);
  if (gate.rejected) reasons.push(...gate.rejectionReasons);
  return [...new Set(reasons)];
}
const baseReq = () => ({ model: 'auto', messages: [{ role: 'user' as const, content: '[neg]' }], dryRun: true });
const baseEnv = () => ({
  dryRun: true, planOnly: true, c3ExecutionAuthorized: false, billableProviderCallsAuthorized: false,
  providerCallExecuted: false, cost_usd: 0, usage: { total_tokens: 0 },
  selectedCandidates: [{ candidateId: 'cand_a', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct', selectedExecutableModel: false }],
  hiddenFallbackDetected: false, fanout: 1, fanoutCap: 1, planFingerprint: 'fp', promptFingerprint: 'fp2', provenance: { complete: true },
});
function rejected(req: any, env: any, reason: string) {
  expect(admit(req, env)).toContain(reason);
}

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — negative cases (real guard + gate)', () => {
  it('case 21: dryRun=false rejected (real guard)', () => rejected({ ...baseReq(), dryRun: false }, { ...baseEnv(), dryRun: false }, 'dryrun_false'));
  it('case 22: planOnly=false rejected', () => rejected(baseReq(), { ...baseEnv(), planOnly: false }, 'planonly_false'));
  it('case 23: c3ExecutionAuthorized=true rejected', () => rejected(baseReq(), { ...baseEnv(), c3ExecutionAuthorized: true }, 'c3_execution_authorized_true'));
  it('case 24: billableProviderCallsAuthorized=true rejected', () => rejected(baseReq(), { ...baseEnv(), billableProviderCallsAuthorized: true }, 'billable_provider_calls_true'));
  it('case 24b: providerCallExecuted=true rejected (parity with 14-case harness)', () => rejected(baseReq(), { ...baseEnv(), providerCallExecuted: true }, 'provider_call_executed_true'));
  it('case 25: cost_usd=0.0001 rejected', () => rejected(baseReq(), { ...baseEnv(), cost_usd: 0.0001 }, 'cost_positive'));
  it('case 26: usage.total_tokens=1 rejected', () => rejected(baseReq(), { ...baseEnv(), usage: { total_tokens: 1 } }, 'usage_tokens_positive'));
  it('case 27: candidate outside manifest rejected', () => rejected(baseReq(), { ...baseEnv(), selectedCandidates: [{ candidateId: 'rogue', providerId: 'prov_a', modelId: 'Qwen/Qwen2.5-7B-Instruct' }] }, 'candidate_outside_manifest'));
  it('case 28: provider outside manifest rejected', () => rejected(baseReq(), { ...baseEnv(), selectedCandidates: [{ candidateId: 'cand_a', providerId: 'rogue', modelId: 'Qwen/Qwen2.5-7B-Instruct' }] }, 'provider_outside_manifest'));
  it('case 29: placeholder executable rejected', () => rejected(baseReq(), { ...baseEnv(), selectedCandidates: [{ candidateId: 'cand_a', providerId: 'prov_a', modelId: '__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_deepseek_1__', selectedExecutableModel: true }] }, 'placeholder_executable'));
  it('case 30: hidden fallback rejected', () => rejected(baseReq(), { ...baseEnv(), hiddenFallbackDetected: true }, 'hidden_fallback'));
  it('case 31: fanout over cap rejected', () => rejected(baseReq(), { ...baseEnv(), fanout: 5, fanoutCap: 4 }, 'fanout_over_cap'));
  it('case 32: invalid fingerprint rejected', () => rejected(baseReq(), { ...baseEnv(), planFingerprint: '', promptFingerprint: '' }, 'invalid_fingerprint'));
  it('case 33: provenance incomplete rejected', () => rejected(baseReq(), { ...baseEnv(), provenance: { complete: false } }, 'provenance_incomplete'));

  const NR = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-controlled-runtime-smoke-negative-responses.json');
  const nr = existsSync(NR) ? JSON.parse(readFileSync(NR, 'utf8')) : null;
  const maybe = nr ? describe : describe.skip;
  maybe('generated negative responses (local verification)', () => {
    it('all negatives rejected, execution-safe, entrypoint not invoked', () => {
      expect(nr.allRejected).toBe(true);
      expect(nr.allExecutionSafe).toBe(true);
      expect(nr.responses.every((r: any) => r.realEntrypointInvoked === false)).toBe(true);
    });
  });
});
