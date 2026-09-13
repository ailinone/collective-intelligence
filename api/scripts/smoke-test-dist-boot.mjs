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
 * Dist boot smoke test.
 *
 * Context (see PR #539, "fix(build): pin tsc-alias to 1.9.2 — fixes production
 * boot crash-loop"): a tsc-alias version bump silently mis-rewrote a compiled
 * `@/generated/prisma/index.js` import into `require("../index.js")` — the
 * app's OWN entrypoint file, still mid-evaluation — producing a synchronous
 * `TypeError: PrismaClient is not a constructor` during module load, BEFORE
 * `bootstrap()`'s try/catch in src/index.ts was ever reached. That throw
 * propagates through app.cjs's/worker.cjs's `process.on('uncaughtException')`
 * safety net (installed for an unrelated Google-Auth edge case), which
 * re-throws anything that isn't a Google-Auth error — and Node's
 * exception-during-uncaughtException-handling machinery then kills the
 * process with exit code 7.
 *
 * This was 100% invisible to `vitest` (api/package.json's `test`/`test:*`
 * scripts), because that suite runs against the TypeScript sources under
 * src/ directly via its own tsx/vitest-tsconfig-paths alias resolution — it
 * never requires the compiled `dist/` output the Dockerfile actually ships
 * and production actually boots.
 *
 * This script closes that gap generically: it boots the REAL compiled
 * entrypoint (dist/app.cjs or dist/worker.cjs) with a throwaway env (no real
 * DB/Redis/GCP credentials needed — see below) and asserts the process
 * survives past the point where every static top-level `require()` in the
 * module graph resolves. It does NOT need the app to fully start serving
 * traffic: the historical bug manifested purely as a broken require() path
 * at module-load time, well before any network call.
 *
 * How "survives past module load" is detected, without knowing the exact
 * shape of a future regression:
 *   - Any synchronous throw during the require() graph flows through the
 *     `process.on('uncaughtException')` handler in app.cjs/worker.cjs, which
 *     unconditionally logs the literal string "[uncaughtException]" before
 *     re-throwing (unless it's a recognized Google-Auth error, which is a
 *     deliberately narrow, unrelated allowlist — see the signature list in
 *     app.cjs). Re-throwing from inside that handler is what produces Node's
 *     exit code 7. So: `"[uncaughtException]"` in the captured output, or an
 *     exit code of 7, is treated as a FAIL — regardless of the exact error
 *     message — because that is the generic fingerprint of "something threw
 *     synchronously during module load," which is the entire bug class this
 *     guard exists to catch.
 *   - If the process is still running (or exits later for an unrelated,
 *     already-caught, expected-in-this-fake-environment reason, e.g. failing
 *     to reach the dummy DATABASE_URL host — which surfaces asynchronously,
 *     INSIDE bootstrap()'s own try/catch, not via uncaughtException) once the
 *     timeout elapses, that's a PASS: it proves the require graph resolved.
 *
 * Required dummy env (see src/config/index.ts): `DATABASE_URL` and
 * `JWT_SECRET` are the only two environment variables with no default that
 * are read unconditionally at module-load time (inside the `@/config`
 * import, which happens before `@/database/client` in src/index.ts) — if
 * either is missing, `getEnv()` throws synchronously and this script would
 * (correctly, but confusingly) flag that as an "uncaughtException", so both
 * must always be supplied here as harmless dummies. No real network access,
 * DB, Redis, or GCP credentials are required or used.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const entrypointArg = process.argv[2];
if (!entrypointArg) {
  console.error('Usage: node scripts/smoke-test-dist-boot.mjs <path-to-entrypoint.cjs> [timeoutMs]');
  process.exit(2);
}
const ENTRYPOINT = path.resolve(API_ROOT, entrypointArg);
const TIMEOUT_MS = Number(process.argv[3] || process.env.SMOKE_TEST_TIMEOUT_MS || 15000);

if (!existsSync(ENTRYPOINT)) {
  console.error(`[smoke-test-dist-boot] entrypoint not found: ${ENTRYPOINT}`);
  console.error('Run the dist build step (pnpm run build + copy app.cjs/worker.cjs) first.');
  process.exit(1);
}

// Bad-signature markers. "[uncaughtException]" is the load-bearing one — see
// the header comment above for why it generically fingerprints ANY
// synchronous throw during the require() graph, not just this specific bug.
const BAD_MARKERS = [
  '[uncaughtException]',
  'is not a constructor',
  'Cannot find module',
  'MODULE_NOT_FOUND',
];

const dummyEnv = {
  ...process.env,
  // Deliberately NOT 'production': several strict production-only checks in
  // src/config/index.ts's validateConfig() (e.g. "SECRETS_PROVIDER_PRIMARY
  // must be gcp in production") and the Phase-5 boot guard in src/index.ts
  // would otherwise require real GCP wiring this smoke test has no interest
  // in exercising. The bug this guards against is a require()-time failure
  // that happens identically regardless of NODE_ENV.
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '127.0.0.1',
  // Unreachable-by-design: never actually dialed before the danger zone this
  // test cares about, and safe to let time out/fail later inside
  // bootstrap()'s own try/catch (an async, already-caught failure — not the
  // synchronous uncaughtException this guard watches for).
  DATABASE_URL: 'postgresql://smoketest:smoketest@127.0.0.1:1/smoketest_dummy_db',
  JWT_SECRET: 'smoke-test-dummy-jwt-secret-not-for-real-use-0000000000',
  SKIP_DB_MIGRATIONS: 'true',
  SKIP_PER_PLUGIN_DISCOVERY: 'true',
  RBAC_SYNC_ON_BOOT: 'false',
  MODEL_CATALOG_AUTO_SYNC: 'false',
  PROMETHEUS_ENABLED: 'false',
  CACHE_ENABLED: 'false',
  OPERABILITY_HEALTH_SYNC_ENABLED: 'false',
  OPERABILITY_DISCOVERY_SCHEDULER_ENABLED: 'false',
  QUARANTINE_REVALIDATION_INTERVAL_MS: '0',
};

console.log(`[smoke-test-dist-boot] booting ${path.relative(API_ROOT, ENTRYPOINT)} (timeout ${TIMEOUT_MS}ms)...`);

const child = spawn(process.execPath, [ENTRYPOINT], {
  cwd: API_ROOT,
  env: dummyEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let exited = false;
let exitCode = null;
let exitSignal = null;

child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

const exitPromise = new Promise((resolve) => {
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    resolve();
  });
});

const timeoutPromise = new Promise((resolve) => {
  setTimeout(resolve, TIMEOUT_MS);
});

await Promise.race([exitPromise, timeoutPromise]);

if (!exited) {
  // Still running once the window closed — that's the expected/good outcome:
  // it got past the synchronous require() graph and into the long-running
  // async bootstrap sequence (which will itself eventually fail to reach the
  // dummy DB/Redis, harmlessly, well outside this test's window). Stop it.
  child.kill('SIGTERM');
  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (!exited) child.kill('SIGKILL');
}

const foundMarkers = BAD_MARKERS.filter((marker) => output.includes(marker));
const crashedWithExit7 = exited && exitCode === 7;

const lastLines = output.split('\n').slice(-80).join('\n');

if (foundMarkers.length > 0 || crashedWithExit7) {
  console.error(
    `\n[smoke-test-dist-boot] FAILED — ${path.relative(API_ROOT, ENTRYPOINT)} crashed during module load.`
  );
  if (exited) {
    console.error(`  exit code: ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ''}`);
  } else {
    console.error('  process was still running at kill time (unexpected alongside a bad marker match)');
  }
  if (foundMarkers.length > 0) {
    console.error(`  bad marker(s) found in output: ${foundMarkers.join(', ')}`);
  }
  console.error('\n--- captured output (last 80 lines) ---');
  console.error(lastLines);
  console.error('--- end captured output ---\n');
  console.error(
    'This is the exact failure class fixed in PR #539: a synchronous exception during the ' +
      'require() graph (e.g. a tsc-alias/tsconfig regression mis-rewriting a compiled `@/...` ' +
      'import) that never reaches bootstrap()\'s try/catch, gets caught by the ' +
      "process.on('uncaughtException') safety net in app.cjs/worker.cjs, and crashes the " +
      'process with exit code 7 before it can serve a single request. See ' +
      'src/database/client.ts and the ~48 `@/generated/prisma/*` import sites for the exact ' +
      'shape of the original regression.'
  );
  process.exit(1);
}

console.log(
  `[smoke-test-dist-boot] PASSED — ${path.relative(API_ROOT, ENTRYPOINT)} survived past module load ` +
    `(${exited ? `exited cleanly later with code ${exitCode}` : 'still running, killed after timeout'}).`
);
console.log('--- last lines of captured output, for context ---');
console.log(output.split('\n').slice(-20).join('\n'));
