// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-no-db-write.test.ts — MVP 8B.6
 *
 * The calibration + harvest LIBRARY layers contain no DB primitives.
 * Only the export script touches the DB — and only via SELECT.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LIB_SOURCES: Record<string, string> = {
  'harvest/historical-results-schema.ts': resolve(__dirname, '..', 'harvest', 'historical-results-schema.ts'),
  'harvest/historical-results-sanitizer.ts': resolve(__dirname, '..', 'harvest', 'historical-results-sanitizer.ts'),
  'harvest/historical-results-normalizer.ts': resolve(__dirname, '..', 'harvest', 'historical-results-normalizer.ts'),
  'harvest/historical-results-deduper.ts': resolve(__dirname, '..', 'harvest', 'historical-results-deduper.ts'),
  'harvest/historical-results-quality-gate.ts': resolve(__dirname, '..', 'harvest', 'historical-results-quality-gate.ts'),
  'harvest/historical-results-harvester.ts': resolve(__dirname, '..', 'harvest', 'historical-results-harvester.ts'),
  'calibration/calibration-policy.ts': resolve(__dirname, '..', 'calibration', 'calibration-policy.ts'),
  'calibration/expected-judge-calibrator.ts': resolve(__dirname, '..', 'calibration', 'expected-judge-calibrator.ts'),
  'calibration/calibrated-expected-judge-estimator.ts': resolve(__dirname, '..', 'calibration', 'calibrated-expected-judge-estimator.ts'),
  'calibration/tasktype-calibration.ts': resolve(__dirname, '..', 'calibration', 'tasktype-calibration.ts'),
  'calibration/calibration-metrics.ts': resolve(__dirname, '..', 'calibration', 'calibration-metrics.ts'),
  'calibration/calibration-report.ts': resolve(__dirname, '..', 'calibration', 'calibration-report.ts'),
};

const SCRIPT_SOURCES: Record<string, string> = {
  'export-all-c3-history-readonly.ts': resolve(__dirname, '..', 'scripts', 'export-all-c3-history-readonly.ts'),
  'run-calibrated-historical-replay.ts': resolve(__dirname, '..', 'scripts', 'run-calibrated-historical-replay.ts'),
  'run-expected-judge-calibration.ts': resolve(__dirname, '..', 'scripts', 'run-expected-judge-calibration.ts'),
};

const libContent: Record<string, string> = {};
for (const [n, p] of Object.entries(LIB_SOURCES)) {
  try {
    libContent[n] = readFileSync(p, 'utf-8');
  } catch {
    libContent[n] = '__FILE_NOT_FOUND__';
  }
}
const scriptContent: Record<string, string> = {};
for (const [n, p] of Object.entries(SCRIPT_SOURCES)) {
  try {
    scriptContent[n] = readFileSync(p, 'utf-8');
  } catch {
    scriptContent[n] = '__FILE_NOT_FOUND__';
  }
}

const WRITE_KEYWORDS = [
  'INSERT INTO',
  'UPDATE ',
  'DELETE FROM',
  'TRUNCATE ',
  'ALTER TABLE',
  'DROP TABLE',
  'CREATE TABLE',
  'CREATE INDEX',
  'VACUUM ',
  'REFRESH MATERIALIZED',
];

describe('calibration LIB — no DB write keywords', () => {
  for (const [name, content] of Object.entries(libContent)) {
    for (const kw of WRITE_KEYWORDS) {
      it(`${name} does NOT contain "${kw}"`, () => {
        expect(content.toUpperCase()).not.toContain(kw);
      });
    }
  }
});

describe('calibration LIB — no DB clients imported', () => {
  const FORBIDDEN = [
    "from '@prisma/client'",
    "from 'prisma'",
    "from 'pg'",
    "from 'ioredis'",
    "from 'redis'",
    'child_process',
  ];
  for (const [name, content] of Object.entries(libContent)) {
    for (const f of FORBIDDEN) {
      it(`${name} does NOT import "${f}"`, () => {
        expect(content).not.toContain(f);
      });
    }
  }
});

describe('export-all script — read-only SQL only', () => {
  it('contains no INSERT/UPDATE/DELETE/TRUNCATE/ALTER/CREATE/DROP', () => {
    const content = scriptContent['export-all-c3-history-readonly.ts'];
    expect(content).not.toBe('__FILE_NOT_FOUND__');
    const upper = content.toUpperCase();
    for (const kw of WRITE_KEYWORDS) expect(upper).not.toContain(kw);
  });

  it('uses docker exec ci-postgres psql for SELECT', () => {
    const content = scriptContent['export-all-c3-history-readonly.ts'];
    expect(content).toContain('docker exec');
    expect(content).toContain('ci-postgres');
    expect(content).toContain('psql');
  });
});

describe('run-calibrated-historical-replay — no DB writes', () => {
  it('does NOT import a DB client', () => {
    const content = scriptContent['run-calibrated-historical-replay.ts'];
    expect(content).not.toContain("from '@prisma/client'");
    expect(content).not.toContain("from 'pg'");
    expect(content).not.toContain("from 'redis'");
  });

  it('does NOT contain DB write keywords', () => {
    const content = scriptContent['run-calibrated-historical-replay.ts'];
    const upper = content.toUpperCase();
    for (const kw of WRITE_KEYWORDS) expect(upper).not.toContain(kw);
  });
});
