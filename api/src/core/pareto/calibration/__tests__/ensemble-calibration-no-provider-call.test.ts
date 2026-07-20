// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-no-provider-call.test.ts — MVP 8B.7
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('fetch_must_not_be_called_in_ensemble_calibration');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ensemble calibration — runtime calls', () => {
  it('imports do not call fetch', async () => {
    await import('../peer-lift-calibrator');
    await import('../marginal-gain-calibrator');
    await import('../ensemble-expected-judge-estimator');
    await import('../ensemble-calibrated-optimizer');
    await import('../tasktype-ensemble-approval');
    await import('../ensemble-calibration-report');
    expect(true).toBe(true);
  });
});

describe('ensemble calibration sources — no forbidden imports', () => {
  const FORBIDDEN = [
    "from '@prisma/client'",
    "from 'prisma'",
    "from 'ioredis'",
    "from 'redis'",
    "from 'pg'",
    "from 'undici'",
    "from 'node-fetch'",
    "from 'hnswlib-node'",
    "from 'hnswlib'",
    'tei-client',
    'embedding-cache',
    'semantic-index',
    'provider-operability-hub',
    'orchestration-engine',
    'pool-builder',
    'base-strategy',
    'experiment-runner',
    'queue-runner',
    'child_process',
  ];
  for (const [name, src] of Object.entries(content)) {
    it(`${name} does NOT import any forbidden module`, () => {
      for (const f of FORBIDDEN) expect(src).not.toContain(f);
    });
  }
});

describe('ensemble calibration sources — no fetch/timers', () => {
  for (const [name, src] of Object.entries(content)) {
    it(`${name} does not call fetch(`, () => expect(src).not.toContain('fetch('));
    it(`${name} does not setTimeout/setInterval`, () => {
      expect(src).not.toContain('setTimeout(');
      expect(src).not.toContain('setInterval(');
    });
  }
});
