// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring-contract tests for the Chip 5 embedding refresh job.
 *
 * These tests guard:
 *
 * 1. The job handler is registered in `register-scheduled-jobs.ts` so the
 *    BullMQ worker can dispatch it. Without this entry, the schedule would
 *    fire and immediately fail with `Unknown scheduled job`.
 *
 * 2. The scheduled job entry exists with a guard tied to `HCRA_EMBEDDER_URL`.
 *    Without the guard, the cron would fire on every host even when no
 *    embedder is configured, throwing on every tick and burying real errors
 *    in the prom-counter for failed jobs.
 *
 * 3. `isEmbeddingRefreshEnabled()` reflects the env. This is the same
 *    boolean the registry's `enabled` callback consults; tying both to a
 *    single function prevents drift between the runner's defensive check
 *    and the cron's gating logic.
 *
 * Why a string-grep test for the registry: the SCHEDULED_JOBS array isn't
 * exported, and exporting it just for tests would widen the public surface.
 * The contract is "this filename appears in the registry source" — a textual
 * check captures that exactly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEmbeddingRefreshEnabled } from '../embedding-refresh-job';

const REGISTRY_PATH = join(__dirname, '..', 'register-scheduled-jobs.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');

describe('embedding-refresh job ↔ scheduled-jobs registry wiring', () => {
  it('registers a handler under the name `embedding-refresh`', () => {
    expect(registrySource).toMatch(/['"]embedding-refresh['"]\s*:\s*async\s*\(\)/);
  });

  it('handler imports from `./embedding-refresh-job`', () => {
    expect(registrySource).toMatch(
      /import\(\s*['"]\.\/embedding-refresh-job(\.js)?['"]\s*\)/,
    );
  });

  it('schedules with a cron pattern AND an HCRA_EMBEDDER_URL gate', () => {
    // Assert both invariants together so a refactor that drops the gate is caught.
    expect(registrySource).toMatch(/name:\s*['"]embedding-refresh['"]/);
    expect(registrySource).toMatch(/HCRA_EMBEDDER_URL/);
  });
});

describe('isEmbeddingRefreshEnabled', () => {
  const originalUrl = process.env.HCRA_EMBEDDER_URL;
  afterEach(() => {
    if (originalUrl === undefined) delete process.env.HCRA_EMBEDDER_URL;
    else process.env.HCRA_EMBEDDER_URL = originalUrl;
  });

  it('returns true when HCRA_EMBEDDER_URL is set', () => {
    process.env.HCRA_EMBEDDER_URL = 'https://api.openai.com';
    expect(isEmbeddingRefreshEnabled()).toBe(true);
  });

  it('returns false when HCRA_EMBEDDER_URL is unset', () => {
    delete process.env.HCRA_EMBEDDER_URL;
    expect(isEmbeddingRefreshEnabled()).toBe(false);
  });

  it('returns false when HCRA_EMBEDDER_URL is empty', () => {
    process.env.HCRA_EMBEDDER_URL = '';
    expect(isEmbeddingRefreshEnabled()).toBe(false);
  });
});
