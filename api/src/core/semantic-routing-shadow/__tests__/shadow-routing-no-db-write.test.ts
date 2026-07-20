// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-no-db-write.test.ts — MVP 8C.0
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'shadow-routing-types.ts': resolve(__dirname, '..', 'shadow-routing-types.ts'),
  'shadow-routing-config.ts': resolve(__dirname, '..', 'shadow-routing-config.ts'),
  'shadow-routing-sampling.ts': resolve(__dirname, '..', 'shadow-routing-sampling.ts'),
  'shadow-routing-redaction.ts': resolve(__dirname, '..', 'shadow-routing-redaction.ts'),
  'shadow-routing-logger.ts': resolve(__dirname, '..', 'shadow-routing-logger.ts'),
  'shadow-routing-metrics.ts': resolve(__dirname, '..', 'shadow-routing-metrics.ts'),
  'shadow-routing-service.ts': resolve(__dirname, '..', 'shadow-routing-service.ts'),
};

const content: Record<string, string> = {};
for (const [n, p] of Object.entries(SOURCES)) {
  try {
    content[n] = readFileSync(p, 'utf-8');
  } catch {
    content[n] = '__NOT_FOUND__';
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
  'REFRESH MATERIALIZED',
];

describe('shadow routing — no DB write keywords', () => {
  for (const [name, src] of Object.entries(content)) {
    for (const kw of WRITE_KEYWORDS) {
      it(`${name} does NOT contain "${kw}"`, () => {
        expect(src.toUpperCase()).not.toContain(kw);
      });
    }
  }
});

describe('shadow routing — no DB client imports', () => {
  const FORBIDDEN = [
    "from '@prisma/client'",
    "from 'prisma'",
    "from 'pg'",
    "from 'ioredis'",
    "from 'redis'",
    "from '@/database/",
    "from '@/infrastructure/",
  ];
  for (const [name, src] of Object.entries(content)) {
    for (const f of FORBIDDEN) {
      it(`${name} does NOT import "${f}"`, () => {
        expect(src).not.toContain(f);
      });
    }
  }
});

describe('shadow routing — service does NOT write to a sink that could persist', () => {
  it('default logger and metrics are no-op (production injects its own)', () => {
    const serviceSource = content['shadow-routing-service.ts'];
    expect(serviceSource).toContain('noopShadowLogger');
    expect(serviceSource).toContain('noopShadowMetrics');
  });
});
