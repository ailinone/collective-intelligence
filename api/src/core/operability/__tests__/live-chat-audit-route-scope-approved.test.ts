// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D §11.1 — Route-scope CLI flag tests.
 *
 * The live-chat audit script now accepts `--route-scope selected|approved|all`
 * and, when `--include-route-candidates` is set, defaults to `approved`
 * (extracting from `routeCandidatesPerRole[r].approvedForExecution[]`).
 *
 * These tests pin the FILE-LEVEL surface of the script. They verify the
 * presence of the new CLI args + default-behavior comments without
 * spawning the binary (the binary requires Prisma + Redis bootstrap,
 * which is out of scope for unit tests).
 *
 * No DB / provider calls.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const scriptSource = fs.readFileSync(
  path.resolve(__dirname, '../scripts/run-live-chat-operability-audit.ts'),
  'utf8',
);

describe('01C.1B-J1D §11.1 — route-scope CLI flag', () => {
  it('script declares `--route-scope` flag', () => {
    expect(scriptSource).toMatch(/'--route-scope'/);
  });

  it('script declares `--max-routes-per-role` flag', () => {
    expect(scriptSource).toMatch(/'--max-routes-per-role'/);
  });

  it('script declares `--max-total-route-probes` flag', () => {
    expect(scriptSource).toMatch(/'--max-total-route-probes'/);
  });

  it('script declares `--prioritize-no-live-evidence` flag', () => {
    expect(scriptSource).toMatch(/'--prioritize-no-live-evidence'/);
  });

  it('script declares `--stop-role-after-first-live-ready` flag', () => {
    expect(scriptSource).toMatch(/'--stop-role-after-first-live-ready'/);
  });

  it('script declares `--include-route-candidates` flag', () => {
    expect(scriptSource).toMatch(/'--include-route-candidates'/);
  });

  it('script declares `--plan-only` / `--dry-run` flags', () => {
    expect(scriptSource).toMatch(/'--plan-only'/);
    expect(scriptSource).toMatch(/'--dry-run'/);
  });

  it('script declares `--write-plan` and `--write-json` flags', () => {
    expect(scriptSource).toMatch(/'--write-plan'/);
    expect(scriptSource).toMatch(/'--write-json'/);
  });

  it('default routeScope is `selected` (legacy)', () => {
    expect(scriptSource).toMatch(/routeScope:\s*'selected'\s*\|\s*'approved'\s*\|\s*'all'\s*=\s*'selected'/);
  });

  it('routeScope flips to `approved` when --include-route-candidates is set without explicit --route-scope', () => {
    expect(scriptSource).toMatch(/if\s*\(\s*includeRouteCandidates\s*&&\s*!routeScopeExplicitlySet\s*\)/);
  });

  it('extractRoutesFromDryRunJson accepts scope param', () => {
    expect(scriptSource).toMatch(/extractRoutesFromDryRunJson\s*\([^)]*\bopts\?:\s*\{[^}]*scope/);
  });

  it('extract pulls from routeCandidatesPerRole when scope is approved/all', () => {
    expect(scriptSource).toMatch(/routeCandidatesPerRole/);
    expect(scriptSource).toMatch(/scope\s*===\s*'approved'/);
    expect(scriptSource).toMatch(/scope\s*===\s*'all'/);
  });
});
