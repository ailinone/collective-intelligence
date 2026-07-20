// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-config-no-provider-call.test.ts — MVP 7A
 *
 * Confirms the provider does not call out to any external system:
 * no fetch, no DB, no Redis, no TEI, no HNSW, no adapters, no C3.
 *
 * The check is enforced two ways:
 *   1. A fetch spy that throws on any call.
 *   2. Source-level inspection that no forbidden import names appear
 *      inside the production files.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'runtime-routing-config-types.ts': resolve(
    __dirname,
    '..',
    'runtime-routing-config-types.ts',
  ),
  'runtime-routing-config-provider.ts': resolve(
    __dirname,
    '..',
    'runtime-routing-config-provider.ts',
  ),
  'static-routing-config-provider.ts': resolve(
    __dirname,
    '..',
    'static-routing-config-provider.ts',
  ),
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
    throw new Error('fetch_must_not_be_called_in_routing_config');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('routing-config — no fetch / no provider call', () => {
  it('importing the provider module does not call fetch', async () => {
    await import('../runtime-routing-config-provider');
    // If module load called fetch, the spy would have thrown synchronously.
    expect(true).toBe(true);
  });

  it('createStaticRoutingConfigProvider() does not call fetch', async () => {
    const mod = await import('../runtime-routing-config-provider');
    expect(() =>
      mod.createStaticRoutingConfigProvider({ mode: 'shadow_structural_full' }),
    ).not.toThrow();
  });

  it('getConfig/getMode/isModeAllowed/explainMode do not call fetch', async () => {
    const mod = await import('../runtime-routing-config-provider');
    const p = mod.createStaticRoutingConfigProvider({ mode: 'legacy' });
    expect(() => {
      p.getConfig();
      p.getMode();
      p.isModeAllowed('shadow_structural_full');
      p.explainMode('semantic_primary');
    }).not.toThrow();
  });
});

describe('routing-config — sources do not import forbidden modules', () => {
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

describe('routing-config — sources do not reference fetch/timers directly', () => {
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
