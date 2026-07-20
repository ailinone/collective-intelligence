// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Anti-execution + validator gates.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isC3RuntimeExecutionLocked } from '@/core/experiment/c3-dryrun-runtime-gate-contract';

// Inline cost scanner (mirror of the validator) — verifies the corrected sub-dollar pattern.
const COST_RE = /"cost_usd"\s*:\s*(?!0(?:\.0+)?(?:[,}\s\]]|$))[0-9.]+/i;

describe('01C.1B-C3-DRYRUN-RUNTIME-GATE — anti-execution', () => {
  describe('execution-lock guard (contract)', () => {
    it('a safe response is execution-locked', () => {
      expect(
        isC3RuntimeExecutionLocked({
          dryRun: true,
          planOnly: true,
          c3ExecutionAuthorized: false,
          billableProviderCallsAuthorized: false,
          providerCallExecuted: false,
          providerCallsExecuted: 0,
          modelProbesExecuted: 0,
          providerProbesExecuted: 0,
          cost_usd: 0,
          usage: { total_tokens: 0 },
        }),
      ).toBe(true);
    });
  });

  describe('cost scanner (sub-dollar fix)', () => {
    it('flags sub-dollar and dollar+ costs; ignores zero forms', () => {
      expect(COST_RE.test('{"cost_usd":0.0001}')).toBe(true);
      expect(COST_RE.test('{"cost_usd":0.5}')).toBe(true);
      expect(COST_RE.test('{"cost_usd":1}')).toBe(true);
      expect(COST_RE.test('{"cost_usd":0}')).toBe(false);
      expect(COST_RE.test('{"cost_usd":0.0}')).toBe(false);
    });
  });

  // Validator artifacts (cases 28-32) — verified when present.
  const names = ['runtime', 'negative-case', 'provenance', 'anti-execution', 'final'];
  const artifacts = names
    .map((n) => resolve(process.cwd(), 'tmp', `01c1b-c3-dryrun-runtime-gate-${n}-validator.json`))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const maybe = artifacts.length === names.length ? describe : describe.skip;
  maybe('generated validator artifacts (local verification)', () => {
    it('cases 28-32: all five validators passed with no findings', () => {
      for (const a of artifacts) {
        expect(a.pass).toBe(true);
        expect(a.findings ?? []).toEqual([]);
      }
    });
  });
});
