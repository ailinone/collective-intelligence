// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Positive cases (real gate).
 * Exercises evaluateC3RuntimeGate directly with a safe plan-only request.
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

function validRequest(): C3RuntimeGateRequest {
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

describe('01C.1B-C3-DRYRUN-RUNTIME-GATE — positive cases', () => {
  const res = evaluateC3RuntimeGate(validRequest(), allowedC, allowedP);

  it('case 8: a dryRun=true / planOnly=true plan is accepted', () => {
    expect(res.accepted).toBe(true);
    expect(res.rejected).toBe(false);
    expect(res.rejectionReasons).toEqual([]);
  });

  it('case 9: response keeps providerCallExecuted=false', () => {
    expect(res.providerCallExecuted).toBe(false);
  });
  it('case 10: response keeps providerCallsExecuted=0', () => {
    expect(res.providerCallsExecuted).toBe(0);
  });
  it('case 11: response keeps modelProbesExecuted=0', () => {
    expect(res.modelProbesExecuted).toBe(0);
  });
  it('case 12: response keeps providerProbesExecuted=0', () => {
    expect(res.providerProbesExecuted).toBe(0);
  });
  it('case 13: response keeps cost_usd=0', () => {
    expect(res.cost_usd).toBe(0);
  });
  it('case 14: response keeps usage.total_tokens=0', () => {
    expect(res.usage.total_tokens).toBe(0);
  });

  it('accepted response is provenance-complete with fingerprints', () => {
    expect(res.provenanceComplete).toBe(true);
    expect(res.planFingerprint).toBe('fp_plan');
    expect(res.promptFingerprint).toBe('fp_prompt');
  });

  const ARTIFACT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-runtime-gate-runtime-responses.json');
  const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;
  const maybe = artifact ? describe : describe.skip;
  maybe('generated runtime responses (local verification)', () => {
    it('all subset positive responses accepted + execution-locked', () => {
      expect(artifact.allAccepted).toBe(true);
      expect(artifact.allExecutionLocked).toBe(true);
      expect(artifact.responses.every((r: any) => r.response.accepted === true)).toBe(true);
    });
  });
});
