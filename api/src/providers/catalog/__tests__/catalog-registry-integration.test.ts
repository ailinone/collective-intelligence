// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog ↔ Registry — end-to-end reachability integration test.
 *
 * The previous catalog tests (schema + loader-filter) only exercise the
 * decision tree. None of them proved that a catalog entry that passes every
 * filter actually lands in the runtime `ProviderRegistry` that downstream
 * code reads from. That's the gap this file closes.
 *
 * Strategy: spin up a tiny in-process HTTP server that replies 200
 * `{data: []}` to ANY path — that's enough to satisfy the hub adapter's
 * healthCheck probe against `/models` / `/v1/models`. Point a synthetic
 * catalog entry at `http://127.0.0.1:<randomPort>/v1` and call
 * `loadProviderCatalog({ catalog: [entry], force: true })`. If the bridge
 * and the plugin-manager are wired correctly, `getProviderRegistry().has(
 * providerId)` must be true afterwards.
 *
 * Why `self-hosted-oai-compat`: the catalog Zod schema only allows `http://`
 * URLs for self-hosted-* classes (Rule 3). We use that class solely to let
 * the test hit localhost — not because we're actually testing the
 * self-hosted feature. The bridge still accepts it because
 * `isOpenAICompatibleEntry` returns true for this class.
 *
 * Why a non-"test" API key: `OpenAICompatibleHubModelFetcher.getModels()`
 * short-circuits if the key contains "mock" or "test-" — a guard intended
 * to prevent accidental discovery on unit test mocks. We use
 * `fake-integration-key-42` which evades that heuristic so discovery runs
 * against our local test server just like it would against a real hub.
 *
 * Discovery side-effects: plugin-manager calls
 * `modelAutoDiscovery.discoverNewModels()` after registration. That path
 * imports the central model discovery service which touches the DB. In an
 * isolated vitest environment the DB call throws, but the plugin-manager
 * catches those errors (see `discoverProviderModels` try/catch), so
 * `registerPlugin` still returns success. We assert on registration, not
 * on discovery counts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  loadProviderCatalog,
  resetCatalogLoaderForTests,
} from '../catalog-loader';
import {
  ProviderRegistry,
  getProviderRegistry,
  setProviderRegistry,
} from '../../provider-registry';
import type { ProviderCatalogEntry } from '../provider-catalog.types';

// Provider id shared across tests — unique enough not to collide with any
// real catalog entry. Kebab-case so it passes `providerIdString` regex and
// the <PROVIDER_ID_UPPER>_API_KEY convention (Rule 1 of the schema).
const PROVIDER_ID = 'integration-test-hub';
const API_KEY_ENV = 'INTEGRATION_TEST_HUB_API_KEY';
const BASE_URL_ENV = 'INTEGRATION_TEST_HUB_BASE_URL';

// Keys that evade the fetcher's "mock|test-" short-circuit. See file header.
const FAKE_KEY = 'fake-integration-key-42';

/**
 * Build a synthetic catalog entry pointing at a localhost HTTP server.
 * Classified as `self-hosted-oai-compat` solely to pass the http-not-https
 * schema refinement; the bridge still accepts it via `isOpenAICompatibleEntry`.
 */
function makeLocalEntry(
  port: number,
  overrides: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry {
  return {
    providerId: PROVIDER_ID,
    displayName: 'Integration Test Hub',
    providerFamily: PROVIDER_ID,
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEnvVar: API_KEY_ENV,
    supports: { chat: true },
    pricingMode: 'none',
    enabledByDefault: true,
    ...overrides,
  };
}

/** Scrub any env vars this suite may have set, regardless of test exit path. */
function scrubEnv(): void {
  delete process.env[API_KEY_ENV];
  delete process.env[BASE_URL_ENV];
  // Plugin-manager convention resolver also reads this:
  delete process.env[`${PROVIDER_ID.toUpperCase().replace(/-/g, '_')}_API_KEY`];
  delete process.env[`${PROVIDER_ID.toUpperCase().replace(/-/g, '_')}_BASE_URL`];
}

describe('catalog ↔ registry — end-to-end reachability', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    // Fresh HTTP echo-server that returns a well-formed OpenAI `/models`
    // response body on every path. That's enough for both the healthCheck
    // (needs any 2xx) and the fetcher's discovery (needs a parseable list).
    server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [], object: 'list' }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;

    // Isolate from prior tests — the registry singleton and loader flag
    // both live at module scope.
    resetCatalogLoaderForTests();
    // Seed a fresh registry singleton — the plugin-manager calls
    // getProviderRegistry() internally during registerPlugin, so a registry
    // MUST exist before the loader runs. Replacing (not clearing) also
    // guarantees nothing leaks across test boundaries.
    setProviderRegistry(new ProviderRegistry());
    scrubEnv();
  });

  afterEach(async () => {
    scrubEnv();
    setProviderRegistry(new ProviderRegistry());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a passing catalog entry becomes reachable via registry.get()', async () => {
    process.env[API_KEY_ENV] = FAKE_KEY;

    const summary = await loadProviderCatalog({
      catalog: [makeLocalEntry(port)],
      force: true,
    });

    // Loader-level assertion: the entry went all the way through.
    expect(summary.attempted).toBe(1);
    expect(summary.registered).toBe(1);
    expect(summary.failed).toBe(0);

    // The main contract: the adapter must be queryable from the same
    // singleton registry that production execution code reads.
    const registry = getProviderRegistry();
    expect(registry.has(PROVIDER_ID)).toBe(true);

    const adapter = registry.get(PROVIDER_ID);
    expect(adapter).toBeDefined();
    expect(adapter!.getName()).toBe(PROVIDER_ID);
  });

  it('registered adapter appears in getAll() / getProviderNames()', async () => {
    process.env[API_KEY_ENV] = FAKE_KEY;

    await loadProviderCatalog({
      catalog: [makeLocalEntry(port)],
      force: true,
    });

    const registry = getProviderRegistry();
    expect(registry.getProviderNames()).toContain(PROVIDER_ID);
    expect(registry.getAll().map((a) => a.getName())).toContain(PROVIDER_ID);
  });
});

describe('catalog ↔ registry — env-signaled opt-in for enabledByDefault=false', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [], object: 'list' }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;

    resetCatalogLoaderForTests();
    // Seed a fresh registry singleton — the plugin-manager calls
    // getProviderRegistry() internally during registerPlugin, so a registry
    // MUST exist before the loader runs. Replacing (not clearing) also
    // guarantees nothing leaks across test boundaries.
    setProviderRegistry(new ProviderRegistry());
    scrubEnv();
  });

  afterEach(async () => {
    scrubEnv();
    setProviderRegistry(new ProviderRegistry());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('skips with disabled-by-default when NO opt-in env var is set', async () => {
    const entry = makeLocalEntry(port, {
      enabledByDefault: false,
      apiKeyOptional: true,
      baseUrlEnvVar: BASE_URL_ENV,
    });

    const summary = await loadProviderCatalog({
      catalog: [entry],
      force: true,
    });

    expect(summary.registered).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.reason).toBe('disabled-by-default');
    expect(getProviderRegistry().has(PROVIDER_ID)).toBe(false);
  });

  it('proceeds past the skip when baseUrlEnvVar is set (registers)', async () => {
    // Catalog default baseUrl is deliberately unreachable — the env override
    // is what makes the test server reachable. That proves the
    // baseUrl-resolution chain honored the env var.
    const catalogDefault = 'http://192.0.2.1:9/v1'; // TEST-NET-1, never reachable
    process.env[BASE_URL_ENV] = `http://127.0.0.1:${port}/v1`;

    const entry = makeLocalEntry(port, {
      baseUrl: catalogDefault,
      enabledByDefault: false,
      apiKeyOptional: true,
      baseUrlEnvVar: BASE_URL_ENV,
    });

    const summary = await loadProviderCatalog({
      catalog: [entry],
      force: true,
    });

    const result = summary.results[0];
    expect(result).toBeDefined();
    // Critical: the reason MUST NOT be 'disabled-by-default'. Anything else
    // means the pre-flight filter respected the env opt-in.
    expect(result!.reason).not.toBe('disabled-by-default');
    expect(result!.status).toBe('registered');
    expect(getProviderRegistry().has(PROVIDER_ID)).toBe(true);
  });

  it('proceeds past the skip when apiKeyEnvVar is set (registers)', async () => {
    process.env[API_KEY_ENV] = FAKE_KEY;

    const entry = makeLocalEntry(port, {
      enabledByDefault: false,
      apiKeyOptional: true,
      baseUrlEnvVar: BASE_URL_ENV, // declared but intentionally unset
    });

    const summary = await loadProviderCatalog({
      catalog: [entry],
      force: true,
    });

    const result = summary.results[0];
    expect(result).toBeDefined();
    expect(result!.reason).not.toBe('disabled-by-default');
    expect(result!.status).toBe('registered');
    expect(getProviderRegistry().has(PROVIDER_ID)).toBe(true);
  });
});

describe('catalog ↔ registry — failure modes do NOT leak into the registry', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    // Server that REJECTS every request with 500. Healthcheck must fail.
    server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('internal server error');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;

    resetCatalogLoaderForTests();
    // Seed a fresh registry singleton — the plugin-manager calls
    // getProviderRegistry() internally during registerPlugin, so a registry
    // MUST exist before the loader runs. Replacing (not clearing) also
    // guarantees nothing leaks across test boundaries.
    setProviderRegistry(new ProviderRegistry());
    scrubEnv();
  });

  afterEach(async () => {
    scrubEnv();
    setProviderRegistry(new ProviderRegistry());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a 500-always server still registers the adapter (fail-open) and marks it degraded', async () => {
    // 2026-05-05 architectural change: boot-time health probe is no longer a
    // hard gate on registration. A 5-second cold network call has too high a
    // false-failure rate to permanently silence a working provider for the
    // container's lifetime. Industry pattern (k8s readiness, Envoy outlier
    // detection) is: register first, mark health observably, retry on use.
    // Persistent failures are caught by the request-time circuit breaker.
    //
    // The contract this test enforces:
    //   1. A health-failing provider is REGISTERED (so its models become
    //      runnable and the request path can probe live).
    //   2. Its availability status is `degraded` (so /providers diagnostics
    //      surface the boot-probe failure to operators).
    //   3. The catalog summary reports `success: true` with no
    //      `health-check-failed` failure — that bucket is now unreachable.
    process.env[API_KEY_ENV] = FAKE_KEY;

    const summary = await loadProviderCatalog({
      catalog: [makeLocalEntry(port)],
      force: true,
    });

    const result = summary.results[0];
    expect(result).toBeDefined();
    expect(result!.status).toBe('registered');
    // Registry MUST contain the adapter — the request path needs it.
    expect(getProviderRegistry().has(PROVIDER_ID)).toBe(true);

    // Availability service MUST mark it degraded so operators can tell that
    // the boot probe failed even though the adapter is wired.
    const { providerAvailabilityService } = await import(
      '@/services/provider-availability-service'
    );
    const status = providerAvailabilityService.getStatus(PROVIDER_ID);
    expect(status?.status).toBe('degraded');
    expect(status?.reason).toMatch(/health.?check failed at boot/i);
  });
});
