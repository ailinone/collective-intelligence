// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring-contract regression test — 2026-09-08 incident root cause.
 *
 * workers/queue-runner.ts (the dedicated BullMQ worker entrypoint) is the
 * process that actually executes the pricing-integrity-check and
 * model-discovery-hourly cron payloads in this deployment (see
 * jobs/register-scheduled-jobs.ts + docker-compose.production.yml's worker
 * service). Its header comment claims it "mirrors the core initialization
 * path from the API entrypoint" (index.ts) — but until this fix it never
 * called loadSecretsIntoEnv(), the ONLY mechanism that populates
 * process.env.<PROVIDER>_API_KEY (etc.) from GCP Secret Manager
 * (config/load-secrets-into-env.ts). index.ts calls it; queue-runner.ts did
 * not. Confirmed via the GCP Secret Manager console that every affected
 * provider-key secret had exactly one ENABLED version: the secrets were
 * never missing, the loading
 * step for this specific process just never ran.
 *
 * This test cannot practically drive the real bootstrapWorker() end-to-end
 * (it connects to Postgres/Redis/BullMQ and starts an HTTP server) — it
 * pins the fix at the source level, the same technique already used by
 * jobs/__tests__/pricing-integrity-job.test.ts and
 * jobs/__tests__/pricing-integrity-job-db-client.test.ts for this kind of
 * boot-sequence/wiring concern in this codebase.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_PATH = join(__dirname, '..', 'queue-runner.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('queue-runner.ts — GCP secrets loaded into process.env before use', () => {
  it('imports loadSecretsIntoEnv from the same module index.ts uses', () => {
    expect(source).toMatch(/import\(\s*['"]@\/config\/load-secrets-into-env(\.js)?['"]\s*\)/);
  });

  it('actually calls (awaits) loadSecretsIntoEnv(), not just imports it', () => {
    expect(source).toMatch(/await\s+loadSecretsIntoEnv\s*\(\s*\)/);
  });

  it('calls loadSecretsIntoEnv() AFTER initializeSecretsManager() and BEFORE validateConfig() — the documented call order in load-secrets-into-env.ts', () => {
    const initIdx = source.indexOf('await initializeSecretsManager(');
    const loadIdx = source.indexOf('await loadSecretsIntoEnv(');
    const validateIdx = source.indexOf('validateConfig();');

    expect(initIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(loadIdx);
    expect(loadIdx).toBeLessThan(validateIdx);
  });
});
