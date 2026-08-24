// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TTFT/TTFB Tracker — latency-aware first-rung selection + dynamic first-chunk
 * budget (Workstream G, 2026-08-17).
 *
 * WHY this exists (and why it is NOT another ModelPerformanceTracker):
 *   - ModelPerformanceTracker (services/) keeps an EWMA of FULL-response time
 *     keyed by modelId only — no TTFB, no provider dimension, no p95, and it
 *     is fed post-hoc rather than at the moment the first chunk lands.
 *   - The operability hub (core/provider-operability-hub.ts) tracks
 *     success/auth state per provider but has no latency samples.
 *   - ci-metrics' `streamingTimeToFirstByte` histogram only covers the
 *     non-orchestrated chat-routes streaming path, and Prometheus histograms
 *     are write-only from the request path's perspective.
 * None of those can answer "what first-chunk budget should THIS provider/
 * model get right now?" — this tracker fills exactly that gap, deliberately
 * mirroring the hub's design rules: in-memory rings, zero I/O on the hot
 * path, singleton via getter, and a module-level `resetForTesting`.
 *
 * Two uses:
 *   1. RANKING: cost-cascade's candidate sort consults predictedTtftMs() to
 *      break cost ties — a cheap-but-3s model is not cheap.
 *   2. BUDGET: cost-cascade's rung-1 first-chunk deadline becomes
 *      clamp(p95 * factor, floor, ceiling) once enough history exists
 *      (see computeFirstChunkBudgetMs), falling back to the static
 *      COLLECTIVE_FIRST_RUNG_TTFB_MS otherwise.
 *
 * Failures (pre-first-chunk errors/timeouts) are counted separately so
 * ranking can avoid erroring candidates even before the circuit breaker
 * trips; degraded/empty outputs surface as failures because the recording
 * site (base-strategy.streamSynthesisWithFallback) only records a SUCCESS
 * sample when a real first chunk arrives — a degradedSynthesisTotal emission
 * means every candidate failed and was recorded as a failure here.
 */

export interface TtftStats {
  key: string;
  samples: number;
  ewmaMs: number;
  p95Ms: number | null;
  errorRate: number;
  lastSampleAt: number | null;
}

interface KeyState {
  /** Newest-last ring of recent first-chunk latencies (ms). */
  ring: number[];
  /** Exponentially-weighted moving average of first-chunk latency (ms). */
  ewmaMs: number;
  failures: number;
  successes: number;
  lastSampleAt: number | null;
}

const DEFAULT_RING_SIZE = 32;
const DEFAULT_EWMA_ALPHA = 0.3;
const DEFAULT_FACTOR = 1.5;
const DEFAULT_FLOOR_MS = 1500;
const DEFAULT_CEILING_MS = 8000;
const DEFAULT_MIN_SAMPLES = 5;

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export class TtftTracker {
  private readonly states = new Map<string, KeyState>();

  constructor(
    private readonly ringSize: number = envNum('TTFT_TRACKER_RING_SIZE', DEFAULT_RING_SIZE),
    private readonly alpha: number = DEFAULT_EWMA_ALPHA
  ) {}

  /** Stable identity for a (provider, model) execution route. */
  routeKey(provider: string, modelId: string): string {
    return `${(provider || 'unknown').toLowerCase()}:${modelId}`;
  }

  /**
   * Record a SUCCESSFUL first chunk after `latencyMs` waiting. Only call this
   * when real provider content arrived — that is what keeps degraded/empty
   * "successes" out of the latency history (semantic-success guarantee).
   */
  recordFirstChunk(provider: string, modelId: string, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const key = this.routeKey(provider, modelId);
    const state = this.stateFor(key);
    state.ring.push(latencyMs);
    if (state.ring.length > this.ringSize) state.ring.shift();
    state.ewmaMs =
      state.ewmaMs === 0 ? latencyMs : this.alpha * latencyMs + (1 - this.alpha) * state.ewmaMs;
    state.successes += 1;
    state.lastSampleAt = Date.now();
  }

  /**
   * Record a pre-first-chunk FAILURE (timeout, provider error, degraded
   * fallback). Counts toward error rate; contributes no latency sample (an
   * aborted wait is not a TTFB observation).
   */
  recordFailure(provider: string, modelId: string): void {
    const state = this.stateFor(this.routeKey(provider, modelId));
    state.failures += 1;
  }

  /** EWMA-predicted first-chunk latency in ms, or null with no history. */
  predictedTtftMs(provider: string, modelId: string): number | null {
    const state = this.states.get(this.routeKey(provider, modelId));
    return state && state.successes > 0 ? state.ewmaMs : null;
  }

  /** Rolling p95 of the recent sample ring (nearest-rank), or null. */
  p95TtftMs(provider: string, modelId: string): number | null {
    const state = this.states.get(this.routeKey(provider, modelId));
    if (!state || state.ring.length === 0) return null;
    const sorted = [...state.ring].sort((a, b) => a - b);
    // Nearest-rank p95: ceil(0.95*n)-th smallest (1-based).
    const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
    return sorted[rank - 1];
  }

  /** Fraction of attempts (successes+failures) that failed; 0 with no data. */
  errorRate(provider: string, modelId: string): number {
    const state = this.states.get(this.routeKey(provider, modelId));
    if (!state) return 0;
    const total = state.successes + state.failures;
    return total === 0 ? 0 : state.failures / total;
  }

  sampleCount(provider: string, modelId: string): number {
    return this.states.get(this.routeKey(provider, modelId))?.successes ?? 0;
  }

  /** Total observed attempts (successes + pre-first-chunk failures) for a route. */
  attemptCount(provider: string, modelId: string): number {
    const state = this.states.get(this.routeKey(provider, modelId));
    return state ? state.successes + state.failures : 0;
  }

  stats(provider: string, modelId: string): TtftStats | null {
    const state = this.states.get(this.routeKey(provider, modelId));
    if (!state) return null;
    return {
      key: this.routeKey(provider, modelId),
      samples: state.successes,
      ewmaMs: state.ewmaMs,
      p95Ms: this.p95TtftMs(provider, modelId),
      errorRate: this.errorRate(provider, modelId),
      lastSampleAt: state.lastSampleAt,
    };
  }

  /**
   * Snapshot of every tracked route (read by the out-of-band ttft-probe job
   * to check convergence and skip already-sampled routes). Zero I/O.
   */
  allStats(): TtftStats[] {
    return [...this.states.entries()].map(([key, state]) => {
      // key format is "provider:modelId" where modelId may itself contain
      // colons — split on the FIRST colon only.
      const colon = key.indexOf(':');
      const provider = key.slice(0, colon);
      const modelId = key.slice(colon + 1);
      return {
        key,
        samples: state.successes,
        ewmaMs: state.ewmaMs,
        p95Ms: this.p95TtftMs(provider, modelId),
        errorRate:
          state.successes + state.failures === 0
            ? 0
            : state.failures / (state.successes + state.failures),
        lastSampleAt: state.lastSampleAt,
      };
    });
  }

  /**
   * Dynamic first-chunk budget for a candidate route:
   *
   *   clamp(ringP95 * factor, floor, ceiling)   when samples >= minSamples
   *   staticFallbackMs                           otherwise
   *
   * The p95 (not the EWMA) sizes the budget: a budget below the true tail
   * would abort healthy-but-slow requests — exactly the false-positive the
   * static window was originally sized to avoid. Factor adds headroom above
   * the observed tail; floor/ceiling keep the window inside operator bounds.
   */
  computeFirstChunkBudgetMs(
    provider: string,
    modelId: string,
    opts: {
      staticFallbackMs: number;
      factor?: number;
      floorMs?: number;
      ceilingMs?: number;
      minSamples?: number;
    }
  ): number {
    const factor = opts.factor ?? envNum('COLLECTIVE_TTFB_BUDGET_FACTOR_X100', DEFAULT_FACTOR * 100) / 100;
    const floorMs = opts.floorMs ?? envNum('COLLECTIVE_TTFB_BUDGET_FLOOR_MS', DEFAULT_FLOOR_MS);
    const ceilingMs = opts.ceilingMs ?? envNum('COLLECTIVE_TTFB_BUDGET_CEILING_MS', DEFAULT_CEILING_MS);
    const minSamples = opts.minSamples ?? envNum('COLLECTIVE_TTFB_BUDGET_MIN_SAMPLES', DEFAULT_MIN_SAMPLES);
    if (this.sampleCount(provider, modelId) < minSamples) return opts.staticFallbackMs;
    const p95 = this.p95TtftMs(provider, modelId);
    if (p95 === null) return opts.staticFallbackMs;
    // An inverted ceiling (ceiling < floor) is normalized UP to the floor so
    // the clamp can never produce a window below the operator floor.
    const ceiling = Math.max(floorMs, ceilingMs);
    return Math.min(ceiling, Math.max(floorMs, Math.round(p95 * factor)));
  }

  private stateFor(key: string): KeyState {
    let state = this.states.get(key);
    if (!state) {
      state = { ring: [], ewmaMs: 0, failures: 0, successes: 0, lastSampleAt: null };
      this.states.set(key, state);
    }
    return state;
  }
}

let trackerInstance: TtftTracker | null = null;

export function getTtftTracker(): TtftTracker {
  if (!trackerInstance) trackerInstance = new TtftTracker();
  return trackerInstance;
}

/** Test-only: drop all state so fixtures don't leak across cases. */
export function resetTtftTrackerForTesting(): void {
  trackerInstance = null;
}
