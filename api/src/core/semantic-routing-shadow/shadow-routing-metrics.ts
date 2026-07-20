// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-metrics.ts — MVP 8C.0
 *
 * Minimal metric surface for the shadow layer. Default impl is an
 * in-memory counter that tests can read; production wires its own
 * adapter (e.g. Prometheus bridge) by passing a different impl into
 * the ShadowRoutingService.
 *
 * Pure interface. No I/O. No clock.
 */

export interface ShadowRoutingMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * No-op metrics — used when caller omits.
 */
export const noopShadowMetrics: ShadowRoutingMetrics = Object.freeze({
  increment(): void {
    // no-op
  },
  observe(): void {
    // no-op
  },
});

/**
 * In-memory metrics — tests use this to assert counter/histogram
 * cardinality without coupling to a real metrics backend.
 */
export class InMemoryShadowMetrics implements ShadowRoutingMetrics {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, number[]>();

  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const key = this.buildKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    const key = this.buildKey(name, labels);
    let arr = this.observations.get(key);
    if (!arr) {
      arr = [];
      this.observations.set(key, arr);
    }
    arr.push(value);
  }

  getCount(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.counters.get(this.buildKey(name, labels)) ?? 0;
  }

  getObservations(
    name: string,
    labels: Readonly<Record<string, string>> = {},
  ): readonly number[] {
    return this.observations.get(this.buildKey(name, labels)) ?? [];
  }

  reset(): void {
    this.counters.clear();
    this.observations.clear();
  }

  private buildKey(name: string, labels: Readonly<Record<string, string>>): string {
    const sorted = Object.entries(labels).sort();
    const labelStr = sorted.map(([k, v]) => `${k}=${v}`).join('|');
    return labelStr.length > 0 ? `${name}{${labelStr}}` : name;
  }
}

// ─── Metric name constants ──────────────────────────────────────────────

export const SHADOW_METRIC_NAMES = Object.freeze({
  REQUESTS_TOTAL: 'shadow_routing_requests_total',
  EXECUTED_TOTAL: 'shadow_routing_executed_total',
  SKIPPED_TOTAL: 'shadow_routing_skipped_total',
  TIMEOUT_TOTAL: 'shadow_routing_timeout_total',
  ERROR_TOTAL: 'shadow_routing_error_total',
  LATENCY_MS: 'shadow_routing_latency_ms',
});
