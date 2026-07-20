// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-no-provider-call.test.ts — MVP 8A
 *
 * Confirms the Pareto layer is offline.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'cost-quality-frontier.ts': resolve(__dirname, '..', 'cost-quality-frontier.ts'),
  'pareto-ensemble-optimizer.ts': resolve(__dirname, '..', 'pareto-ensemble-optimizer.ts'),
  'collective-selection-policy.ts': resolve(__dirname, '..', 'collective-selection-policy.ts'),
  'ensemble-plan-types.ts': resolve(__dirname, '..', 'ensemble-plan-types.ts'),
  'ensemble-plan-validator.ts': resolve(__dirname, '..', 'ensemble-plan-validator.ts'),
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
    throw new Error('fetch_must_not_be_called_in_pareto_layer');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pareto — no fetch / no provider call', () => {
  it('importing the optimizer does not call fetch', async () => {
    await import('../pareto-ensemble-optimizer');
    expect(true).toBe(true);
  });

  it('optimizer with empty input does not throw via fetch path', async () => {
    const mod = await import('../pareto-ensemble-optimizer');
    expect(() =>
      mod.optimizeParetoEnsemble({
        candidates: [],
        taskType: 'code-generation',
        taskModality: 'text',
        baseline: { singleModelJudge: 0.6, singleModelCostUsd: 0.02 },
      }),
    ).not.toThrow();
  });
});

describe('pareto — sources do not import forbidden modules', () => {
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

describe('pareto — sources do not call fetch or timers', () => {
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
