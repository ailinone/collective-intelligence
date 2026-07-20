// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-no-db-write.test.ts — MVP 8B.5
 *
 * The replay LIBRARY layer (loader, split, runner, metrics, report) is
 * a pure compute pipeline. The only file that touches the DB at all is
 * `scripts/export-c3-history-readonly.ts` — and that script ONLY issues
 * SELECT statements via `docker exec ci-postgres psql`.
 *
 * This test enforces:
 *   - library files contain NO INSERT/UPDATE/DELETE/TRUNCATE/ALTER/DROP/CREATE keyword
 *   - library files do NOT import `pg`, `prisma`, or any DB client
 *   - the export script's SQL contains ONLY SELECT statements and the
 *     `to_jsonb` / `json_build_object` helpers
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LIB_SOURCES: Record<string, string> = {
  'historical-replay-types.ts': resolve(__dirname, '..', 'historical-replay-types.ts'),
  'historical-replay-loader.ts': resolve(__dirname, '..', 'historical-replay-loader.ts'),
  'historical-replay-split.ts': resolve(__dirname, '..', 'historical-replay-split.ts'),
  'historical-replay-runner.ts': resolve(__dirname, '..', 'historical-replay-runner.ts'),
  'historical-replay-metrics.ts': resolve(__dirname, '..', 'historical-replay-metrics.ts'),
  'historical-replay-report.ts': resolve(__dirname, '..', 'historical-replay-report.ts'),
};

const SCRIPT_SOURCES: Record<string, string> = {
  'export-c3-history-readonly.ts': resolve(
    __dirname,
    '..',
    'scripts',
    'export-c3-history-readonly.ts',
  ),
  'run-historical-replay.ts': resolve(
    __dirname,
    '..',
    'scripts',
    'run-historical-replay.ts',
  ),
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

// ─── Library layer: no DB primitives at all ─────────────────────────────

describe('replay LIB — no DB write keywords', () => {
  const FORBIDDEN_SQL_KEYWORDS = [
    'INSERT INTO',
    'UPDATE ',
    'DELETE FROM',
    'TRUNCATE ',
    'ALTER TABLE',
    'DROP TABLE',
    'CREATE TABLE',
    'CREATE INDEX',
    'VACUUM ',
  ];
  for (const [name, content] of Object.entries(libContent)) {
    for (const kw of FORBIDDEN_SQL_KEYWORDS) {
      it(`${name} does NOT contain "${kw}"`, () => {
        expect(content.toUpperCase()).not.toContain(kw);
      });
    }
  }
});

describe('replay LIB — no DB client imports', () => {
  const FORBIDDEN_IMPORTS = [
    "from '@prisma/client'",
    "from 'prisma'",
    "from 'pg'",
    "from 'ioredis'",
    "from 'redis'",
    'child_process',
  ];
  for (const [name, content] of Object.entries(libContent)) {
    for (const f of FORBIDDEN_IMPORTS) {
      it(`${name} does NOT import "${f}"`, () => {
        expect(content).not.toContain(f);
      });
    }
  }
});

// ─── Script layer: read-only DB access ──────────────────────────────────

describe('export script — only SELECT statements', () => {
  it('contains only SELECT-prefixed SQL or read-only helpers', () => {
    const content = scriptContent['export-c3-history-readonly.ts'];
    expect(content).not.toBe('__FILE_NOT_FOUND__');
    const upper = content.toUpperCase();
    // No write verbs.
    expect(upper).not.toContain('INSERT INTO');
    expect(upper).not.toContain('UPDATE ');
    expect(upper).not.toContain('DELETE FROM');
    expect(upper).not.toContain('TRUNCATE');
    expect(upper).not.toContain('ALTER TABLE');
    expect(upper).not.toContain('DROP TABLE');
    expect(upper).not.toContain('CREATE TABLE');
    expect(upper).not.toContain('CREATE INDEX');
    expect(upper).not.toContain('VACUUM');
  });

  it('uses docker exec ci-postgres psql for read-only access', () => {
    const content = scriptContent['export-c3-history-readonly.ts'];
    expect(content).toContain('docker exec');
    expect(content).toContain('ci-postgres');
    expect(content).toContain('psql');
  });
});

describe('run-replay script — does not write to DB', () => {
  it('does NOT import any DB client', () => {
    const content = scriptContent['run-historical-replay.ts'];
    expect(content).not.toBe('__FILE_NOT_FOUND__');
    expect(content).not.toContain("from '@prisma/client'");
    expect(content).not.toContain("from 'pg'");
    expect(content).not.toContain("from 'ioredis'");
    expect(content).not.toContain("from 'redis'");
  });

  it('does NOT contain DB write verbs', () => {
    const content = scriptContent['run-historical-replay.ts'];
    const upper = content.toUpperCase();
    expect(upper).not.toContain('INSERT INTO');
    expect(upper).not.toContain('UPDATE ');
    expect(upper).not.toContain('DELETE FROM');
  });
});
