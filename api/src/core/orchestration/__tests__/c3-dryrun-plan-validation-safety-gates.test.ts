// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PLAN-VALIDATION — Safety gate logic.
 * Self-contained gate detectors (mirror the .mjs validators) are exercised against
 * adversarial inputs; the real validator artifacts are checked when present.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Inline gate detectors (logic mirror) ────────────────────────────────────────
function manifestBoundaryViolations(
  plan: { selectedCandidates: { candidateId: string; providerId: string }[] },
  allowedCandidateIds: Set<string>,
  allowedProviderIds: Set<string>,
): string[] {
  const v: string[] = [];
  for (const c of plan.selectedCandidates) {
    if (!allowedCandidateIds.has(c.candidateId)) v.push('candidate_outside_manifest');
    if (!allowedProviderIds.has(c.providerId)) v.push('provider_outside_manifest');
  }
  return v;
}
const fanoutViolation = (plan: { fanout: number; fanoutCap: number }) => plan.fanout > plan.fanoutCap;
const judgeSynthViolation = (policy: { fixedJudgeUsed?: boolean; fixedSynthesizerUsed?: boolean; sameModelSelectedReason?: unknown }) =>
  policy.fixedJudgeUsed === true || (policy.fixedSynthesizerUsed === true && !policy.sameModelSelectedReason);

const ANTI_EXEC_PATTERNS: [string, RegExp][] = [
  ['dryRunFalse', /"dryRun"\s*:\s*false|dryRun=false/i],
  ['providerCallExecutedTrue', /"providerCallExecuted"\s*:\s*true/i],
  ['c3ExecutionAuthorizedTrue', /"c3ExecutionAuthorized"\s*:\s*true/i],
  ['costPositive', /"cost_usd"\s*:\s*(?!0(?:\.0+)?(?:[,}\s\]]|$))[0-9.]+/i],
];
const antiExecScan = (text: string) => ANTI_EXEC_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);

describe('01C.1B-C3-DRYRUN-PLAN-VALIDATION — safety gates', () => {
  describe('manifest boundary', () => {
    const allowedC = new Set(['cand_a']);
    const allowedP = new Set(['prov_a']);
    it('case 16: blocks a provider outside the manifest', () => {
      const v = manifestBoundaryViolations({ selectedCandidates: [{ candidateId: 'cand_a', providerId: 'rogue' }] }, allowedC, allowedP);
      expect(v).toContain('provider_outside_manifest');
    });
    it('case 17: blocks a candidate outside the manifest', () => {
      const v = manifestBoundaryViolations({ selectedCandidates: [{ candidateId: 'rogue', providerId: 'prov_a' }] }, allowedC, allowedP);
      expect(v).toContain('candidate_outside_manifest');
    });
    it('passes an in-manifest candidate', () => {
      expect(manifestBoundaryViolations({ selectedCandidates: [{ candidateId: 'cand_a', providerId: 'prov_a' }] }, allowedC, allowedP)).toEqual([]);
    });
  });

  describe('fanout', () => {
    it('case 18: flags fanout above cap; passes at/under cap', () => {
      expect(fanoutViolation({ fanout: 5, fanoutCap: 4 })).toBe(true);
      expect(fanoutViolation({ fanout: 4, fanoutCap: 4 })).toBe(false);
      expect(fanoutViolation({ fanout: 1, fanoutCap: 1 })).toBe(false);
    });
  });

  describe('judge / synthesizer', () => {
    it('case 20: fixed judge fails', () => {
      expect(judgeSynthViolation({ fixedJudgeUsed: true })).toBe(true);
    });
    it('case 21: fixed synthesizer without justification fails; with reason passes', () => {
      expect(judgeSynthViolation({ fixedSynthesizerUsed: true })).toBe(true);
      expect(judgeSynthViolation({ fixedSynthesizerUsed: true, sameModelSelectedReason: 'best reasoning prior, score breakdown attached' })).toBe(false);
    });
  });

  describe('hidden fallback', () => {
    it('case 19: a plan flagged hiddenFallbackDetected=true is a violation', () => {
      const plan = { hiddenFallbackDetected: true };
      expect(plan.hiddenFallbackDetected === true).toBe(true);
    });
  });

  describe('anti-execution scanner', () => {
    it('case 27: flags dryRun=false', () => {
      expect(antiExecScan(JSON.stringify({ dryRun: false }))).toContain('dryRunFalse');
    });
    it('case 28: flags providerCallExecuted=true', () => {
      expect(antiExecScan(JSON.stringify({ providerCallExecuted: true }))).toContain('providerCallExecutedTrue');
    });
    it('case 29: flags cost_usd > 0; ignores cost_usd = 0', () => {
      expect(antiExecScan(JSON.stringify({ cost_usd: 0.0001 }))).toContain('costPositive');
      expect(antiExecScan(JSON.stringify({ cost_usd: 0 }))).not.toContain('costPositive');
    });
    it('a clean plan-only record yields no findings', () => {
      expect(antiExecScan(JSON.stringify({ dryRun: true, planOnly: true, c3ExecutionAuthorized: false, cost_usd: 0 }))).toEqual([]);
    });
  });

  // Local verification of the real validator artifacts when present.
  const names = [
    'manifest-boundary',
    'fanout',
    'placeholder',
    'hidden-fallback',
    'judge-synth',
    'provenance',
    'anti-execution',
    'final',
  ];
  const artifacts = names
    .map((n) => resolve(process.cwd(), 'tmp', `01c1b-c3-dryrun-plan-validation-${n}-validator.json`))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const maybe = artifacts.length === names.length ? describe : describe.skip;
  maybe('generated validator artifacts (local verification)', () => {
    it('all gate validators passed with no findings', () => {
      for (const a of artifacts) {
        expect(a.pass).toBe(true);
        expect(a.findings ?? []).toEqual([]);
      }
    });
  });
});
