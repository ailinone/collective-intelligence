#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Orphan-module guard (audit DEAD-4, 2026-06-11).
 *
 * The 2026-06-11 audit found 76 production files (~20k LOC) with zero
 * execution-flow references — superseded provider adapters, ghost resilience
 * modules, duplicate middleware/routes ("build the v2, never delete the v1").
 * This guard fails the quality gate when a NEW orphan appears.
 *
 * Heuristic: a src file is an orphan when its basename never appears inside a
 * quoted module specifier anywhere in src/, scripts/, tests/, package.json,
 * Dockerfiles, or workflows. Substring collisions (auth-routes matching
 * auth-routes-clean) bias toward ALIVE — i.e. false negatives, never false
 * positives. Multi-line dynamic imports are covered because we scan full file
 * contents, not import lines.
 *
 * Files that are intentionally referenced by nothing in-repo (process entry
 * points) or kept deliberately (documented allowlist) are skipped.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';

const API_ROOT = join(import.meta.dirname, '..');
const SRC = join(API_ROOT, 'src');

/** Process entry points / tool-invoked files — referenced outside the repo. */
const ENTRYPOINTS = new Set([
  'src/index.ts',
  'src/server.ts',
  'src/workers/queue-runner.ts',
  'src/database/migrate.ts',
  'src/database/reset.ts',
  'src/database/seed.ts',
]);

/**
 * Known-kept files with no production reference. Each entry needs a reason;
 * shrinking this list is the goal, growing it needs a code-review decision.
 */
const ALLOWLIST = new Map([
  ['src/routes/auth/auth-routes.ts', 'legacy routes still imported by 4 integration tests + scripts/debug-login — migrate tests to auth-routes-clean, then delete'],
  ['src/routes/user/user-routes.ts', 'legacy routes still imported by integration tests — migrate tests to user-routes-clean, then delete'],
  ['src/routes/organization/organization-routes.ts', 'legacy routes still imported by integration tests — migrate to -clean, then delete'],

  // ── Operational CLI scripts — process entry points run via `pnpm tsx`, never
  //    imported by production flow. Legitimate, not dead code. ──
  ['src/core/operability/scripts/run-g2-reclassification-report.ts', 'CLI entry point (G→G2 reclassification report) — run via tsx'],
  ['src/core/operability/scripts/run-g3-offline-reclassify.ts', 'CLI entry point (G3 offline reclassification) — run via tsx'],
  ['src/core/operability/scripts/run-live-chat-operability-inventory.ts', 'CLI entry point (live-chat operability inventory) — run via tsx'],
  ['src/core/operability/scripts/run-provider-adapter-readiness-audit.ts', 'CLI entry point (provider adapter readiness audit) — run via tsx'],
  ['src/core/operability/scripts/run-provider-canonical-model-reprobe.ts', 'CLI entry point (provider canonical model reprobe) — run via tsx'],
  ['src/core/operability/scripts/run-provider-credential-validation-audit.ts', 'CLI entry point (provider credential validation audit) — run via tsx'],
  ['src/core/operability/scripts/run-provider-credit-audit.ts', 'CLI entry point (provider credit audit) — run via tsx'],
  ['src/core/operability/scripts/run-provider-discovery-alias-learning.ts', 'CLI entry point (provider discovery alias learning) — run via tsx'],
  ['src/core/operability/scripts/run-role-eligibility-audit.ts', 'CLI entry point (role eligibility audit) — run via tsx'],
  ['src/core/operability/scripts/run-system-registry-parity-audit.ts', 'CLI entry point (system registry parity audit) — run via tsx'],
  ['src/core/replay/scripts/export-all-c3-history-readonly.ts', 'CLI entry point (export all C3 history, read-only) — run via tsx'],
  ['src/core/replay/scripts/export-c3-history-readonly.ts', 'CLI entry point (export C3 history, read-only) — run via tsx'],
  ['src/core/replay/scripts/run-calibrated-historical-replay.ts', 'CLI entry point (calibrated historical replay) — run via tsx'],
  ['src/core/replay/scripts/run-ensemble-calibrated-replay.ts', 'CLI entry point (ensemble calibrated replay) — run via tsx'],
  ['src/core/replay/scripts/run-ensemble-level-calibration.ts', 'CLI entry point (ensemble-level calibration) — run via tsx'],
  ['src/core/replay/scripts/run-expected-judge-calibration.ts', 'CLI entry point (expected-judge calibration) — run via tsx'],
  ['src/core/replay/scripts/run-historical-replay.ts', 'CLI entry point (historical replay) — run via tsx'],

  // ── Built-but-not-yet-wired modules (WIP, pending integration — NOT dead;
  //    each has a planned consumer). Shrink this as they get wired. ──
  ['src/core/operability/operability-filter.ts', 'built + unit-tested; pending wiring into selector/parallel fan-out (resilience audit DEAD-4)'],
  ['src/services/pricing-snapshot-loader.ts', 'pricing-engine snapshot loader — feeds pricing-calibrator; pending pricing go-live wiring (operator-gated)'],
  ['src/network/provider-http-transport.ts', 'network HTTP transport — WIP infra, pending wiring into provider adapters'],
  ['src/core/experiment/c3-resolvers.ts', 'C3 experiment resolver — WIP, pending experiment-flow wiring'],
]);

const SKIP_DIRS = new Set(['node_modules', 'generated', 'dist', '__tests__']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

// Build the reference haystack: all TS sources (including tests) + manifests.
const haystackFiles = [];
function* walkAll(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated' || entry.name === 'dist') continue;
      yield* walkAll(full);
    } else if (/\.(ts|mjs|cjs|json|yml|yaml)$/.test(entry.name) || entry.name.startsWith('Dockerfile')) {
      yield full;
    }
  }
}
for (const f of walkAll(API_ROOT)) haystackFiles.push(f);
const workflowsDir = join(API_ROOT, '..', '.github', 'workflows');
try {
  for (const f of readdirSync(workflowsDir)) haystackFiles.push(join(workflowsDir, f));
} catch { /* repo layout without workflows */ }

const contents = new Map(
  haystackFiles.map((f) => {
    try { return [f, readFileSync(f, 'utf8')]; } catch { return [f, '']; }
  })
);

const orphans = [];
for (const file of walk(SRC)) {
  const rel = relative(API_ROOT, file).replaceAll('\\', '/');
  if (ENTRYPOINTS.has(rel)) continue;
  if (ALLOWLIST.has(rel)) continue;

  const base = basename(file, '.ts');
  // index.ts files are imported via their directory name.
  const needle = base === 'index' ? basename(dirname(file)) : base;
  if (needle.length < 4) continue; // too generic to scan reliably

  const pattern = new RegExp(`['"\\/]${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js)?['"]`);
  let referenced = false;
  for (const [hf, content] of contents) {
    if (hf === file) continue;
    if (pattern.test(content)) { referenced = true; break; }
  }
  if (!referenced) orphans.push(rel);
}

if (orphans.length > 0) {
  console.error(`\n✖ Orphan guard: ${orphans.length} production file(s) have no execution-flow reference:\n`);
  for (const o of orphans) console.error(`  - ${o}`);
  console.error(
    '\nEither wire the file into a real flow, delete it (it lives in git history), ' +
    'or — with reviewer sign-off — add it to the ALLOWLIST in scripts/check-orphans.mjs with a reason.\n'
  );
  process.exit(1);
}

console.log(`✓ Orphan guard: no unreferenced production modules (allowlist: ${ALLOWLIST.size}).`);
