// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-no-provider-call.test.ts — MVP 7A
 *
 * The composer is offline. With a fetch spy that throws, no mode may
 * touch the network. Source-level inspection confirms no forbidden
 * imports.
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
import { composeRoutingPipeline } from '../routing-pipeline-composer';
import { createStaticRoutingConfigProvider } from '../../routing-config/runtime-routing-config-provider';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import type { RoutingMode } from '../../routing-config/runtime-routing-config-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'routing-pipeline-types.ts': resolve(__dirname, '..', 'routing-pipeline-types.ts'),
  'routing-pipeline-trace.ts': resolve(__dirname, '..', 'routing-pipeline-trace.ts'),
  'routing-pipeline-composer.ts': resolve(
    __dirname,
    '..',
    'routing-pipeline-composer.ts',
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
    throw new Error('fetch_must_not_be_called_in_routing_pipeline');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('routing-pipeline — fetch is never called', () => {
  const MODES: readonly RoutingMode[] = [
    'legacy',
    'registry_cache',
    'shadow_trace_only',
    'shadow_registry_only',
    'shadow_structural_full',
    'shadow_semantic_full',
    'semantic_primary',
  ];

  for (const mode of MODES) {
    it(`mode=${mode} runs without calling fetch`, () => {
      expect(() =>
        composeRoutingPipeline({
          requestId: 'r-no-net',
          profilerInput: { requestId: 'r-no-net', text: 'hello' },
          registry: buildFixtureRegistry(),
          configProvider: createStaticRoutingConfigProvider({ mode }),
          nowIso: '2026-05-12T13:06:00.000Z',
          traceId: 'trace-no-net',
        }),
      ).not.toThrow();
    });
  }
});

describe('routing-pipeline — sources do not import forbidden modules', () => {
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

describe('routing-pipeline — sources do not reference fetch/timers directly', () => {
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
