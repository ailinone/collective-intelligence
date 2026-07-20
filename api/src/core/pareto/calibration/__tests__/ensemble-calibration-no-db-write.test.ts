// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-no-db-write.test.ts — MVP 8B.7
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'ensemble-calibration-types.ts': resolve(__dirname, '..', 'ensemble-calibration-types.ts'),
  'peer-lift-calibrator.ts': resolve(__dirname, '..', 'peer-lift-calibrator.ts'),
  'marginal-gain-calibrator.ts': resolve(__dirname, '..', 'marginal-gain-calibrator.ts'),
  'ensemble-expected-judge-estimator.ts': resolve(__dirname, '..', 'ensemble-expected-judge-estimator.ts'),
  'ensemble-lift-policy.ts': resolve(__dirname, '..', 'ensemble-lift-policy.ts'),
  'ensemble-calibrated-optimizer.ts': resolve(__dirname, '..', 'ensemble-calibrated-optimizer.ts'),
  'tasktype-ensemble-approval.ts': resolve(__dirname, '..', 'tasktype-ensemble-approval.ts'),
  'ensemble-calibration-report.ts': resolve(__dirname, '..', 'ensemble-calibration-report.ts'),
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
  'VACUUM ',
  'REFRESH MATERIALIZED',
];

describe('ensemble calibration LIB — no DB write keywords', () => {
  for (const [name, src] of Object.entries(content)) {
    for (const kw of WRITE_KEYWORDS) {
      it(`${name} does NOT contain "${kw}"`, () => {
        expect(src.toUpperCase()).not.toContain(kw);
      });
    }
  }
});

describe('ensemble calibration LIB — no DB clients', () => {
  const FORBIDDEN = [
    "from '@prisma/client'",
    "from 'prisma'",
    "from 'pg'",
    "from 'ioredis'",
    "from 'redis'",
    'child_process',
  ];
  for (const [name, src] of Object.entries(content)) {
    for (const f of FORBIDDEN) {
      it(`${name} does NOT import "${f}"`, () => {
        expect(src).not.toContain(f);
      });
    }
  }
});
