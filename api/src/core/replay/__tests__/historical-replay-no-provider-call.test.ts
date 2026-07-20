// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-no-provider-call.test.ts — MVP 8B.5
 *
 * The replay layer is offline. With a fetch spy that throws, no module
 * may call providers, TEI, HNSW or external services. Source-level
 * lint confirms no forbidden imports.
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
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import { loadFromJsonl } from '../historical-replay-loader';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import { SYNTHETIC_REPLAY_FIXTURE, asJsonl } from './fixtures/synthetic-replay.fixture';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';
import type { HistoricalReplayExecution } from '../historical-replay-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'historical-replay-types.ts': resolve(__dirname, '..', 'historical-replay-types.ts'),
  'historical-replay-loader.ts': resolve(__dirname, '..', 'historical-replay-loader.ts'),
  'historical-replay-split.ts': resolve(__dirname, '..', 'historical-replay-split.ts'),
  'historical-replay-runner.ts': resolve(__dirname, '..', 'historical-replay-runner.ts'),
  'historical-replay-metrics.ts': resolve(__dirname, '..', 'historical-replay-metrics.ts'),
  'historical-replay-report.ts': resolve(__dirname, '..', 'historical-replay-report.ts'),
};

const sourceContent: Record<string, string> = {};
for (const [name, path] of Object.entries(SOURCES)) {
  try {
    sourceContent[name] = readFileSync(path, 'utf-8');
  } catch {
    sourceContent[name] = '__FILE_NOT_FOUND__';
  }
}

function adapt(e: HistoricalReplayExecution): HistoricalExecution {
  return {
    executionId: e.executionId,
    experimentId: e.experimentId,
    taskId: e.taskId,
    taskType: e.taskType,
    complexity: e.complexity ?? 'medium',
    strategyId: e.strategyId,
    effectiveStrategyId: e.effectiveStrategyId ?? e.strategyId,
    modelsUsed: e.modelsUsed,
    judgeScore: typeof e.judgeScore === 'number' ? e.judgeScore : 0,
    costUsd: typeof e.costUsd === 'number' ? e.costUsd : 0,
    success: e.success,
    modality: e.modality,
  };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('fetch_must_not_be_called_in_replay_layer');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('replay — runtime calls', () => {
  it('loadFromJsonl runs with fetch spy that throws', () => {
    expect(() => loadFromJsonl(asJsonl())).not.toThrow();
  });

  it('splitTrainHoldout runs with fetch spy that throws', () => {
    expect(() => splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE)).not.toThrow();
  });

  it('runHistoricalReplay runs with fetch spy that throws', () => {
    const split = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainHistory = scoreHistoricalContribution({
      executions: split.train.map(adapt),
    });
    expect(() =>
      runHistoricalReplay({
        train: split.train,
        holdout: split.holdout,
        trainHistory,
      }),
    ).not.toThrow();
  });
});

describe('replay — sources do not import forbidden modules', () => {
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
  ];

  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT import any forbidden module`, () => {
      for (const f of FORBIDDEN_IMPORTS) {
        expect(content).not.toContain(f);
      }
    });
  }
});

describe('replay — sources do not call fetch or timers', () => {
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
