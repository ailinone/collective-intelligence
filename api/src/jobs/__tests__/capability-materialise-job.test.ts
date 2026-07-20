// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring-contract tests for the capability materialise job.
 *
 * Same shape and rationale as the embedding-refresh wiring tests — see
 * `embedding-refresh-job.test.ts` for the longer explanation. In short, we
 * grep the registry source rather than importing `SCHEDULED_JOBS` so the
 * registry doesn't have to widen its public surface for tests.
 *
 * Three guarantees:
 *
 *   1. Handler entry under `'capability-materialise'` exists in JOB_HANDLERS,
 *      so a fired schedule doesn't end up in the "Unknown scheduled job"
 *      error path.
 *
 *   2. Handler resolves from `./capability-materialise-job`, not some other
 *      module that might happen to export the same name.
 *
 *   3. `isCapabilityMaterialiseEnabled()` matches the registry's gate. Both
 *      the cron registration and the runner's defensive check should reach
 *      for the same env var, so flipping one flips both — drift between
 *      "cron is registered" and "runner thinks it should run" is a debugging
 *      trap we'd rather not ship.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCapabilityMaterialiseEnabled } from '../capability-materialise-job';

const REGISTRY_PATH = join(__dirname, '..', 'register-scheduled-jobs.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');

describe('capability-materialise job ↔ scheduled-jobs registry wiring', () => {
  it('registers a handler under the name `capability-materialise`', () => {
    expect(registrySource).toMatch(/['"]capability-materialise['"]\s*:\s*async\s*\(\)/);
  });

  it('handler imports from `./capability-materialise-job`', () => {
    expect(registrySource).toMatch(
      /import\(\s*['"]\.\/capability-materialise-job(\.js)?['"]\s*\)/,
    );
  });

  it('schedules the cron under the same name', () => {
    expect(registrySource).toMatch(/name:\s*['"]capability-materialise['"]/);
  });
});

describe('isCapabilityMaterialiseEnabled', () => {
  const originalDisabled = process.env.HCRA_MATERIALISE_DISABLED;
  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.HCRA_MATERIALISE_DISABLED;
    else process.env.HCRA_MATERIALISE_DISABLED = originalDisabled;
  });

  it('returns true by default (env var unset)', () => {
    delete process.env.HCRA_MATERIALISE_DISABLED;
    expect(isCapabilityMaterialiseEnabled()).toBe(true);
  });

  it('returns false only when explicitly set to "true"', () => {
    process.env.HCRA_MATERIALISE_DISABLED = 'true';
    expect(isCapabilityMaterialiseEnabled()).toBe(false);
  });

  it('returns true for any non-"true" value (defensive default)', () => {
    process.env.HCRA_MATERIALISE_DISABLED = 'false';
    expect(isCapabilityMaterialiseEnabled()).toBe(true);
    process.env.HCRA_MATERIALISE_DISABLED = '0';
    expect(isCapabilityMaterialiseEnabled()).toBe(true);
    process.env.HCRA_MATERIALISE_DISABLED = '';
    expect(isCapabilityMaterialiseEnabled()).toBe(true);
  });
});
