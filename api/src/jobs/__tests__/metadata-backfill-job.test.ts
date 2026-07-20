// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring-contract tests for the metadata-backfill cron.
 *
 * Same shape as the embedding-refresh and capability-materialise wiring
 * tests: registry-source grep + env-gate behavior. The actual SQL backfill
 * is exercised by the manual scripts (`_backfill-metadata-*.ts`) and the
 * inference modules' unit tests; duplicating that here would just shadow
 * the same logic against a mocked Prisma.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMetadataBackfillEnabled } from '../metadata-backfill-job';

const REGISTRY_PATH = join(__dirname, '..', 'register-scheduled-jobs.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');

describe('metadata-backfill job ↔ scheduled-jobs registry wiring', () => {
  it('registers a handler under the name `metadata-backfill`', () => {
    expect(registrySource).toMatch(/['"]metadata-backfill['"]\s*:\s*async\s*\(\)/);
  });

  it('handler imports from `./metadata-backfill-job`', () => {
    expect(registrySource).toMatch(
      /import\(\s*['"]\.\/metadata-backfill-job(\.js)?['"]\s*\)/,
    );
  });

  it('schedules the cron under the same name', () => {
    expect(registrySource).toMatch(/name:\s*['"]metadata-backfill['"]/);
  });
});

describe('isMetadataBackfillEnabled', () => {
  const originalDisabled = process.env.METADATA_BACKFILL_DISABLED;
  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.METADATA_BACKFILL_DISABLED;
    else process.env.METADATA_BACKFILL_DISABLED = originalDisabled;
  });

  it('returns true by default (env var unset)', () => {
    delete process.env.METADATA_BACKFILL_DISABLED;
    expect(isMetadataBackfillEnabled()).toBe(true);
  });

  it('returns false only when explicitly set to "true"', () => {
    process.env.METADATA_BACKFILL_DISABLED = 'true';
    expect(isMetadataBackfillEnabled()).toBe(false);
  });

  it('returns true for any non-"true" value (defensive default)', () => {
    process.env.METADATA_BACKFILL_DISABLED = 'false';
    expect(isMetadataBackfillEnabled()).toBe(true);
    process.env.METADATA_BACKFILL_DISABLED = '';
    expect(isMetadataBackfillEnabled()).toBe(true);
  });
});
