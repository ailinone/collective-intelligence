// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-no-provider-call.test.ts — MVP 8C.0
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultShadowRoutingService,
} from '../shadow-routing-service';
import { resolveShadowConfig } from '../shadow-routing-config';
import type { ShadowRoutingInput } from '../shadow-routing-types';

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

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('fetch_must_not_be_called_in_shadow_routing');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('shadow routing — no provider call', () => {
  it('disabled service runs without invoking fetch', async () => {
    const service = new DefaultShadowRoutingService({});
    const input: ShadowRoutingInput = {
      requestId: 'r-1',
      routeContext: { actualModel: 'm', actualProvider: 'p', actualStrategy: 's' },
      profilerInput: { requestId: 'r-1' },
      metadata: { source: 'chat', timestamp: 't' },
    };
    await expect(service.run(input)).resolves.toBeDefined();
  });

  it('enabled service with deferred computer runs without invoking fetch', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
    });
    const input: ShadowRoutingInput = {
      requestId: 'r-2',
      routeContext: { actualModel: 'm', actualProvider: 'p', actualStrategy: 's' },
      profilerInput: { requestId: 'r-2', taskTypeHint: 'code-generation' },
      metadata: { source: 'chat', timestamp: 't' },
    };
    await expect(service.run(input)).resolves.toBeDefined();
  });
});

describe('shadow routing — sources do not import provider/runtime modules', () => {
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
    "from '@/providers/",
    "from '@/core/orchestration/",
    "from '@/core/pool/",
    "from '@/core/experiment/",
  ];
  for (const [name, src] of Object.entries(content)) {
    it(`${name} does NOT import any forbidden module`, () => {
      for (const f of FORBIDDEN) expect(src).not.toContain(f);
    });
  }
});

describe('shadow routing — sources do not call fetch directly', () => {
  for (const [name, src] of Object.entries(content)) {
    it(`${name} does not contain literal "fetch("`, () => {
      expect(src).not.toContain('fetch(');
    });
  }
});
