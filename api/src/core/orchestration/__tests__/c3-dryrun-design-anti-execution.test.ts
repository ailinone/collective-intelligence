// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — Anti-execution guard invariants.
 *
 * The pure detector must flag any attempt to flip an execution lock, and a clean
 * design record must produce zero violations. No secrets may appear in the contract.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  detectC3ExecutionViolations,
  C3_PAYLOAD_TEMPLATE_INVARIANTS,
} from '@/core/experiment/c3-dryrun-experiment-design-contract';

describe('01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — anti-execution guard', () => {
  describe('detector flags execution attempts', () => {
    it('case 22: flags dryRun=false', () => {
      expect(detectC3ExecutionViolations({ dryRun: false })).toContain('dryRun_false');
    });

    it('case 23: flags providerCallExecuted=true', () => {
      expect(detectC3ExecutionViolations({ providerCallExecuted: true })).toContain(
        'providerCallExecuted_true',
      );
    });

    it('case 24: flags c3ExecutionAuthorized=true', () => {
      expect(detectC3ExecutionViolations({ c3ExecutionAuthorized: true })).toContain(
        'c3ExecutionAuthorized_true',
      );
    });

    it('flags billable / provider-probe / model-probe authorization', () => {
      expect(detectC3ExecutionViolations({ billableProviderCallsAuthorized: true })).toContain(
        'billableProviderCallsAuthorized_true',
      );
      expect(detectC3ExecutionViolations({ providerProbesAuthorized: true })).toContain(
        'providerProbesAuthorized_true',
      );
      expect(detectC3ExecutionViolations({ modelProbesAuthorized: true })).toContain(
        'modelProbesAuthorized_true',
      );
    });
  });

  describe('detector passes clean design records', () => {
    it('a dryRun=true / planOnly=true record yields zero violations', () => {
      expect(detectC3ExecutionViolations({ ...C3_PAYLOAD_TEMPLATE_INVARIANTS })).toEqual([]);
    });

    it('an empty record yields zero violations', () => {
      expect(detectC3ExecutionViolations({})).toEqual([]);
    });
  });

  describe('no secrets in the design contract', () => {
    it('case 28: contract source contains no credential-like tokens', () => {
      const src = readFileSync(
        resolve(process.cwd(), 'src/core/experiment/c3-dryrun-experiment-design-contract.ts'),
        'utf8',
      );
      expect(/sk-[A-Za-z0-9_-]{20,}/.test(src)).toBe(false);
      expect(/ak_local_[A-Za-z0-9._-]+/.test(src)).toBe(false);
      expect(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/.test(src)).toBe(false);
      expect(/BEGIN PRIVATE KEY/.test(src)).toBe(false);
    });
  });
});
