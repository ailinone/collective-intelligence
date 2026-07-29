// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Scrape-token gate for the worker's raw node:http /metrics server —
 * same contract as api/src/routes/metrics/metrics-route.auth.test.ts:
 *
 *   - token configured                → must present the matching Bearer token.
 *   - no token, NODE_ENV=production   → DENY — fail-closed, never serve
 *                                       metrics unauthenticated in production.
 *   - no token, non-production        → ALLOW (open for local/dev scraping).
 *
 * `config.observability.prometheusToken` is captured at import time, so we
 * mock `@/config` per test and re-import the module fresh (resetModules) so
 * the mocked token value is the one the function reads.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function fakeRequest(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

async function loadAuthorize(token: string | undefined, nodeEnv: string) {
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  vi.doMock('@/config', () => ({
    config: { observability: { prometheusToken: token } },
  }));
  const { authorizeWorkerMetricsScrape } = await import('../worker-metrics-auth');
  return authorizeWorkerMetricsScrape;
}

describe('worker /metrics scrape-token gate (secure-by-default)', () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.doUnmock('@/config');
  });

  it('DENIES in production when no token is configured', async () => {
    const authorize = await loadAuthorize(undefined, 'production');
    expect(authorize(fakeRequest())).toBe(false);
  });

  it('ALLOWS in non-production when no token is configured', async () => {
    const authorize = await loadAuthorize(undefined, 'test');
    expect(authorize(fakeRequest())).toBe(true);
  });

  it('requires the matching Bearer token when a token IS configured (even in dev)', async () => {
    const authorize = await loadAuthorize('s3cr3t', 'test');

    expect(authorize(fakeRequest())).toBe(false);
    expect(authorize(fakeRequest('Bearer nope'))).toBe(false);
    expect(authorize(fakeRequest('Bearer s3cr3t'))).toBe(true);
  });

  it('accepts the configured token in production (the normal scrape path)', async () => {
    const authorize = await loadAuthorize('prod-token', 'production');
    expect(authorize(fakeRequest('Bearer prod-token'))).toBe(true);
  });

  it('rejects a non-Bearer-shaped authorization header', async () => {
    const authorize = await loadAuthorize('s3cr3t', 'test');
    expect(authorize(fakeRequest('Basic s3cr3t'))).toBe(false);
  });
});
