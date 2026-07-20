// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-no-provider-call.test.ts — MVP 8A
 *
 * Confirms the contribution layer is offline: no fetch, no DB, no
 * Redis, no TEI, no HNSW, no C3.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'historical-execution-types.ts': resolve(__dirname, '..', 'historical-execution-types.ts'),
  'model-task-performance-profile.ts': resolve(__dirname, '..', 'model-task-performance-profile.ts'),
  'model-harm-profile.ts': resolve(__dirname, '..', 'model-harm-profile.ts'),
  'pair-contribution-profile.ts': resolve(__dirname, '..', 'pair-contribution-profile.ts'),
  'historical-contribution-scorer.ts': resolve(__dirname, '..', 'historical-contribution-scorer.ts'),
  'contribution-aware-candidate-scorer.ts': resolve(__dirname, '..', 'contribution-aware-candidate-scorer.ts'),
  'contribution-explanation.ts': resolve(__dirname, '..', 'contribution-explanation.ts'),
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
    throw new Error('fetch_must_not_be_called_in_contribution_layer');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('contribution — no fetch / no provider call', () => {
  it('importing the scorer does not call fetch', async () => {
    await import('../historical-contribution-scorer');
    expect(true).toBe(true);
  });

  it('importing the candidate scorer does not call fetch', async () => {
    await import('../contribution-aware-candidate-scorer');
    expect(true).toBe(true);
  });

  it('scoring with empty input does not throw via fetch path', async () => {
    const mod = await import('../historical-contribution-scorer');
    expect(() => mod.scoreHistoricalContribution({ executions: [] })).not.toThrow();
  });
});

describe('contribution — sources do not import forbidden modules', () => {
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

describe('contribution — sources do not call fetch or timers', () => {
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
