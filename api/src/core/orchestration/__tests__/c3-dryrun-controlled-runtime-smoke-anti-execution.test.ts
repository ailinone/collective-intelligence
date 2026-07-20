// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Anti-execution invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isC3ControlledSmokeExecutionLocked } from '@/core/experiment/c3-dryrun-controlled-runtime-smoke-contract';

const COST_RE = /"cost_usd"\s*:\s*(?!0(?:\.0+)?(?:[,}\s\]]|$))[0-9.]+/i;
const safe = {
  dryRun: true, planOnly: true, c3ExecutionAuthorized: false, billableProviderCallsAuthorized: false,
  providerCallExecuted: false, providerCallsExecuted: 0, modelProbesExecuted: 0, providerProbesExecuted: 0,
  cost_usd: 0, usage: { total_tokens: 0 }, hiddenFallbackDetected: false,
};

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — anti-execution', () => {
  it('execution-lock guard accepts a safe response', () => {
    expect(isC3ControlledSmokeExecutionLocked(safe)).toBe(true);
  });

  it('cost scanner flags sub-dollar/dollar costs; ignores zero forms', () => {
    expect(COST_RE.test('{"cost_usd":0.0001}')).toBe(true);
    expect(COST_RE.test('{"cost_usd":0.5}')).toBe(true);
    expect(COST_RE.test('{"cost_usd":1}')).toBe(true);
    expect(COST_RE.test('{"cost_usd":0}')).toBe(false);
    expect(COST_RE.test('{"cost_usd":0.0}')).toBe(false);
  });

  // Validator artifacts (cases 34-35) — verified when present.
  const names = ['entrypoint', 'provider-boundary', 'runtime', 'negative-case', 'provenance', 'anti-execution', 'final'];
  const artifacts = names
    .map((n) => resolve(process.cwd(), 'tmp', `01c1b-c3-dryrun-controlled-runtime-smoke-${n}-validator.json`))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const maybe = artifacts.length === names.length ? describe : describe.skip;
  maybe('generated validator artifacts (local verification)', () => {
    it('cases 34-35: all validators passed with no findings', () => {
      for (const a of artifacts) {
        expect(a.pass).toBe(true);
        expect(a.findings ?? []).toEqual([]);
      }
    });
  });
});
