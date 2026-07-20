// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Kill-switch invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { C3_GLOBAL_KILL_SWITCH_REQUIRED } from '@/core/experiment/c3-budget-authorization-gate-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-budget-authorization-gate-kill-switch-policy.json');
const ks = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — kill switch', () => {
  it('global kill switch required by contract', () => {
    expect(C3_GLOBAL_KILL_SWITCH_REQUIRED).toBe(true);
  });

  const maybe = ks ? describe : describe.skip;
  maybe('generated kill-switch policy (local verification)', () => {
    it('global kill switch required, default blocked, future activation required', () => {
      expect(ks.globalKillSwitchRequired).toBe(true);
      expect(ks.defaultState).toBe('blocked');
      expect(ks.requiresExplicitFutureStageActivation).toBe(true);
    });
    it('all required runtime guards present', () => {
      const g = ks.requiredRuntimeGuards;
      for (const k of ['providerBoundarySentry', 'externalNetworkSentry', 'costAnomalyAbort', 'usageAnomalyAbort', 'fingerprintDriftAbort', 'fallbackAbort', 'providerOutsideAllowlistAbort', 'modelOutsideAllowlistAbort', 'maxRetriesZero', 'nonStreamingOnly']) {
        expect(g[k]).toBe(true);
      }
    });
    it('effectiveAuthorization false; fingerprint present', () => {
      expect(ks.effectiveAuthorization).toBe(false);
      expect(typeof ks.killSwitchFingerprint).toBe('string');
    });
  });
});
