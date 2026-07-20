// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Snapshot + sentry invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(name: string) {
  const p = resolve(process.cwd(), 'tmp', name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
const offline = read('01c1b-c3-dryrun-parity-gate-offline-snapshots.json');
const runtime = read('01c1b-c3-dryrun-parity-gate-runtime-snapshots.json');
const sentry = read('01c1b-c3-dryrun-parity-gate-runtime-sentry.json');

const maybe = offline && runtime && sentry ? describe : describe.skip;
describe('01C.1B-C3-DRYRUN-PARITY-GATE — snapshots + sentry', () => {
  maybe('generated snapshot + sentry artifacts (local verification)', () => {
    it('case 6/7: offline + runtime snapshots exist for all plans', () => {
      expect(offline.count).toBeGreaterThan(0);
      expect(runtime.count).toBe(offline.count);
    });
    it('case 8: runtime evidence sufficient', () => {
      expect(runtime.evidenceSufficient).toBe(true);
    });
    it('case 9: runtime sentry provider attempts = 0', () => {
      expect(sentry.providerAdapterCallAttempts).toBe(0);
    });
    it('case 10: runtime sentry network attempts = 0', () => {
      expect(sentry.externalNetworkCallAttempts).toBe(0);
      expect(sentry.patchedPrimitives.length).toBeGreaterThanOrEqual(7);
    });
    it('every runtime snapshot is execution-locked', () => {
      expect(runtime.snapshots.every((s: any) => s.snapshot.runtimeProviderCallExecuted === false && s.snapshot.runtimeCostUsd === 0 && s.snapshot.runtimeUsageTotalTokens === 0)).toBe(true);
    });
  });
});
