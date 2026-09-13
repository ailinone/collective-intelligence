// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Observability coverage contract (LOTE AK, 2026-09-04).
 *
 * An audit asked a simple question of the operability plane — "can you see
 * discovery latency, discovery failures, capability-probe outcomes and
 * semantic-search latency?" — and the honest answer was only partly yes:
 *
 *   - discovery latency existed ONLY as a whole-run histogram with no labels,
 *     so it could say the sweep was slow but never which provider made it
 *     slow. `probeLatencyMs` was already computed per provider and returned
 *     by the admin endpoint; it simply never reached Prometheus.
 *   - the embedding cache observed its TEI round-trip under
 *     `PROVIDER_DISCOVERY_DURATION_MS` — a different subsystem's metric — so
 *     every cache miss corrupted the discovery-latency series and neither
 *     name meant what it said.
 *   - the capability (function-calling) probe had NO Prometheus metric at
 *     all: just process-local counters behind `getProbeStats()` and log
 *     lines, so probe volume, verdict mix and cost were unobservable.
 *   - semantic search latency was only measured as the whole
 *     `resolveSemanticCandidates` call, which bundles the TEI round-trip and
 *     the pool filter around the kNN — a slow index and a slow embedder were
 *     indistinguishable.
 *
 * These tests pin the four dimensions as METRIC DEFINITIONS that must keep
 * existing with the labels that make them answerable. They assert the
 * contract, not implementation details of any one call site — a caller that
 * stops emitting is caught by its own site's tests; a metric that is deleted
 * or has its labels stripped is caught here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import {
  incrementCounter,
  observeHistogram,
  setActiveRegistryForTesting,
  resetMetricCountersForTesting,
  METRIC_NAMES,
} from '../metrics';

describe('observability coverage — the four audited dimensions', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    setActiveRegistryForTesting(registry);
    resetMetricCountersForTesting();
  });

  afterEach(() => {
    setActiveRegistryForTesting(null);
  });

  it('discovery latency is attributable to a single provider and outcome', async () => {
    observeHistogram(METRIC_NAMES.PROVIDER_DISCOVERY_PROBE_LATENCY_MS, 1200, {
      providerId: 'atlascloud',
      status: 'available',
    });
    observeHistogram(METRIC_NAMES.PROVIDER_DISCOVERY_PROBE_LATENCY_MS, 30_000, {
      providerId: 'slow-vendor',
      status: 'unavailable',
    });

    const metrics = await registry.metrics();
    // Both labels must survive: without `providerId` the series cannot answer
    // "who made the sweep slow", and without `status` a 30s failure looks
    // identical to a 30s success.
    expect(metrics).toMatch(/provider_discovery_probe_latency_ms_count\{[^}]*providerId="atlascloud"/);
    expect(metrics).toMatch(/provider_discovery_probe_latency_ms_count\{[^}]*status="unavailable"/);
  });

  it('keeps embedding latency out of the discovery-latency series', async () => {
    observeHistogram(METRIC_NAMES.EMBEDDING_COMPUTE_DURATION_MS, 42);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(/embedding_compute_duration_ms_count\s+1/);
    // The regression this guards: a TEI round-trip recorded as provider
    // discovery duration. Discovery must be untouched by an embedding call.
    expect(metrics).not.toMatch(/provider_discovery_duration_ms_count\s+[1-9]/);
  });

  it('records capability-probe outcomes with the verdict kept distinct from a non-verdict', async () => {
    for (const outcome of ['supported', 'unsupported', 'inconclusive', 'provider-dead']) {
      incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
        capability: 'function_calling',
        providerId: 'somehub',
        outcome,
      });
    }
    observeHistogram(METRIC_NAMES.CAPABILITY_PROBE_LATENCY_MS, 850, {
      capability: 'function_calling',
      outcome: 'supported',
    });

    const metrics = await registry.metrics();
    // "supported" and "inconclusive" must not collapse into one bucket:
    // only the former is a capability conclusion, and only it is cached
    // long-term. An alert on "probe failures" that counted inconclusive as
    // unsupported would silently mark live models as tool-incapable.
    expect(metrics).toMatch(/capability_probe_total\{[^}]*outcome="supported"[^}]*\}\s+1/);
    expect(metrics).toMatch(/capability_probe_total\{[^}]*outcome="inconclusive"[^}]*\}\s+1/);
    expect(metrics).toMatch(/capability_probe_total\{[^}]*outcome="provider-dead"[^}]*\}\s+1/);
    expect(metrics).toMatch(/capability_probe_latency_ms_count\{[^}]*capability="function_calling"/);
  });

  it('measures semantic index search separately from the whole resolution', async () => {
    observeHistogram(METRIC_NAMES.SEMANTIC_INDEX_SEARCH_LATENCY_MS, 3);
    observeHistogram(METRIC_NAMES.CANDIDATE_RESOLUTION_LATENCY_MS, 180, {
      outcome: 'semantic_ranked',
    });

    const metrics = await registry.metrics();
    expect(metrics).toMatch(/semantic_index_search_latency_ms_count\s+1/);
    expect(metrics).toMatch(/candidate_resolution_latency_ms_count\{outcome="semantic_ranked"\}\s+1/);
  });

  it('still counts discovery failures by provider and by cause', async () => {
    // Pre-existing coverage — asserted here so a refactor cannot drop it
    // while "adding" the new metrics above.
    incrementCounter(METRIC_NAMES.PROVIDER_DISCOVERED_TOTAL, {
      providerId: 'p',
      status: 'unavailable',
    });
    incrementCounter(METRIC_NAMES.PROVIDER_ERROR_CLASS_TOTAL, {
      providerId: 'p',
      errorClass: 'auth_failed',
    });

    const metrics = await registry.metrics();
    expect(metrics).toMatch(/provider_discovered_total\{[^}]*status="unavailable"[^}]*\}\s+1/);
    expect(metrics).toMatch(/provider_error_class_total\{[^}]*errorClass="auth_failed"[^}]*\}\s+1/);
  });
});
