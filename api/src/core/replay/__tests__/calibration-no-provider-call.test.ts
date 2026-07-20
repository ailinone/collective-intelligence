// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * calibration-no-provider-call.test.ts — MVP 8B.6
 *
 * The calibration LIBRARY layer is offline. Source-level lint confirms
 * no forbidden imports + no `fetch(` direct calls. A fetch spy that
 * throws confirms nothing crosses the network.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  // Harvest layer.
  'historical-results-schema.ts': resolve(__dirname, '..', 'harvest', 'historical-results-schema.ts'),
  'historical-results-sanitizer.ts': resolve(__dirname, '..', 'harvest', 'historical-results-sanitizer.ts'),
  'historical-results-normalizer.ts': resolve(__dirname, '..', 'harvest', 'historical-results-normalizer.ts'),
  'historical-results-deduper.ts': resolve(__dirname, '..', 'harvest', 'historical-results-deduper.ts'),
  'historical-results-quality-gate.ts': resolve(__dirname, '..', 'harvest', 'historical-results-quality-gate.ts'),
  'historical-results-harvester.ts': resolve(__dirname, '..', 'harvest', 'historical-results-harvester.ts'),
  // Calibration layer.
  'calibration-policy.ts': resolve(__dirname, '..', 'calibration', 'calibration-policy.ts'),
  'expected-judge-calibrator.ts': resolve(__dirname, '..', 'calibration', 'expected-judge-calibrator.ts'),
  'calibrated-expected-judge-estimator.ts': resolve(__dirname, '..', 'calibration', 'calibrated-expected-judge-estimator.ts'),
  'tasktype-calibration.ts': resolve(__dirname, '..', 'calibration', 'tasktype-calibration.ts'),
  'calibration-metrics.ts': resolve(__dirname, '..', 'calibration', 'calibration-metrics.ts'),
  'calibration-report.ts': resolve(__dirname, '..', 'calibration', 'calibration-report.ts'),
};

const sourceContent: Record<string, string> = {};
for (const [name, path] of Object.entries(SOURCES)) {
  try {
    sourceContent[name] = readFileSync(path, 'utf-8');
  } catch {
    sourceContent[name] = '__FILE_NOT_FOUND__';
  }
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('fetch_must_not_be_called_in_calibration_layer');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('calibration — runtime calls', () => {
  it('importing all calibration modules runs without fetch', async () => {
    await import('../calibration/calibration-policy');
    await import('../calibration/expected-judge-calibrator');
    await import('../calibration/calibrated-expected-judge-estimator');
    await import('../calibration/tasktype-calibration');
    await import('../calibration/calibration-metrics');
    await import('../calibration/calibration-report');
    expect(true).toBe(true);
  });

  it('importing all harvest modules runs without fetch', async () => {
    await import('../harvest/historical-results-schema');
    await import('../harvest/historical-results-sanitizer');
    await import('../harvest/historical-results-normalizer');
    await import('../harvest/historical-results-deduper');
    await import('../harvest/historical-results-quality-gate');
    await import('../harvest/historical-results-harvester');
    expect(true).toBe(true);
  });
});

describe('calibration sources — no forbidden imports', () => {
  const FORBIDDEN_IMPORTS = [
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
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT import any forbidden module`, () => {
      for (const f of FORBIDDEN_IMPORTS) {
        expect(content).not.toContain(f);
      }
    });
  }
});

describe('calibration sources — no fetch / no timers', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does not call fetch(`, () => {
      expect(content).not.toContain('fetch(');
    });
    it(`${name} does not setTimeout/setInterval`, () => {
      expect(content).not.toContain('setTimeout(');
      expect(content).not.toContain('setInterval(');
    });
  }
});
