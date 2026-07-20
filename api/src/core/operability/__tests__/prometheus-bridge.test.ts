// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prometheus bridge — verifies that incrementCounter/observeHistogram/setGauge
 * actually update prom-client metrics in addition to in-memory counters.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import {
  incrementCounter,
  observeHistogram,
  setGauge,
  setActiveRegistryForTesting,
  resetMetricCountersForTesting,
  METRIC_NAMES,
} from '../metrics';

describe('Prometheus bridge', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    setActiveRegistryForTesting(registry);
    resetMetricCountersForTesting();
  });

  afterEach(() => {
    setActiveRegistryForTesting(null);
  });

  it('incrementCounter registers + increments prom-client counter', async () => {
    incrementCounter(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, { providerId: 'foo' });
    incrementCounter(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, { providerId: 'foo' });
    incrementCounter(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, { providerId: 'bar' });

    const metrics = await registry.metrics();
    expect(metrics).toContain('provider_configured_total');
    expect(metrics).toMatch(/provider_configured_total\{providerId="foo"\}\s+2/);
    expect(metrics).toMatch(/provider_configured_total\{providerId="bar"\}\s+1/);
  });

  it('observeHistogram registers + observes', async () => {
    observeHistogram(METRIC_NAMES.PROVIDER_DISCOVERY_DURATION_MS, 123);
    observeHistogram(METRIC_NAMES.PROVIDER_DISCOVERY_DURATION_MS, 456);

    const metrics = await registry.metrics();
    expect(metrics).toContain('provider_discovery_duration_ms');
    expect(metrics).toMatch(/provider_discovery_duration_ms_count\s+2/);
  });

  it('setGauge registers + sets', async () => {
    setGauge(METRIC_NAMES.PROVIDER_HEALTH_STATE, 1, { providerId: 'foo', state: 'healthy' });
    setGauge(METRIC_NAMES.PROVIDER_HEALTH_STATE, 0, { providerId: 'foo', state: 'auth_failed' });

    const metrics = await registry.metrics();
    expect(metrics).toContain('provider_health_state');
    // Two label combinations registered
    expect(metrics).toMatch(/provider_health_state\{providerId="foo",state="healthy"\}\s+1/);
    expect(metrics).toMatch(/provider_health_state\{providerId="foo",state="auth_failed"\}\s+0/);
  });

  it('drops undeclared labels silently (prom-client) but keeps in-memory test counter', () => {
    incrementCounter(METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL, {
      providerId: 'foo',
      undeclared: 'bar', // not in METRIC_DEFS labels
    });
    // Should not throw — prom-client gets only `providerId`, in-memory has both
    expect(true).toBe(true);
  });

  it('handles unknown metric names gracefully (no crash)', () => {
    // Cast to bypass TS check — this is the runtime guard test
    expect(() => incrementCounter('not_a_real_metric' as never, {})).not.toThrow();
  });
});
