// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Performance Tracker
 *
 * Maintains rolling averages of real execution performance per model.
 * Updates dynamically on each execution so DynamicModelSelector uses
 * empirical scores instead of static seed values from the DB.
 *
 * Architecture:
 * - In-memory ring buffers of last N executions per model (fast reads)
 * - Async DB flush every FLUSH_INTERVAL_MS (durability)
 * - On cold start, pre-warms from model_health table if available
 *
 * Usage:
 *   modelPerformanceTracker.record({ modelId, provider, qualityScore, latencyMs, success, costUsd });
 *   const score = modelPerformanceTracker.getDynamicScore(modelId);
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'model-performance-tracker' });

export interface ModelExecutionSample {
  modelId: string;
  provider: string;
  qualityScore: number;   // 0–1
  latencyMs: number;
  success: boolean;
  costUsd: number;
  timestamp: number;
  taskType?: string;      // Task type for per-type competence tracking (independence filter)
}

export interface DynamicModelScore {
  modelId: string;
  rollingQuality: number;     // Exponential moving average
  rollingLatencyP50: number;  // Median of last N samples
  rollingLatencyP99: number;  // 99th percentile of last N samples
  errorRate: number;          // Fraction of failed executions
  costEfficiency: number;     // quality / (costUsd * 1000 + 0.001)
  sampleCount: number;
  lastUpdated: number;
}

const RING_SIZE = 100;         // Keep last 100 executions per model
const EMA_ALPHA = 0.1;         // Exponential moving average decay (lower = slower to adapt)
const FLUSH_INTERVAL_MS = 60_000;  // Flush to DB every minute

// Provider-level sliding window: samples from the last 15 minutes decide
// whether a provider is "unreliable". This replaces the previous cumulative
// counter (failures/total since process start) that would monotonically drift
// toward "unreliable" for any provider that ever had a bad hour — and never
// recover without a full container restart. See docs in isProviderUnreliable().
const PROVIDER_WINDOW_MS = 15 * 60 * 1000;           // 15 min
const PROVIDER_MIN_SAMPLES = 5;                       // need 5+ samples in-window
const PROVIDER_UNRELIABLE_THRESHOLD = 0.6;            // 60% failure rate
const PROVIDER_RING_MAX = 200;                        // hard cap on per-provider ring

interface ProviderSample {
  timestamp: number;
  success: boolean;
}

// ── Selection-scoring feedback bridge (2026-07-03) ───────────────────────────
// The SELECTOR scores candidates from the *services* ModelPerformanceTracker
// (getPerformanceSummary), which historically had NO writer — so scoring was
// blind (modelsWithRealTimeData:0) and could never demote slow/empty providers
// (the HuggingFace-serverless cascade). Forward every execution sample there too
// so measured latency / success / quality feed selection DYNAMICALLY over time —
// no static pins. Lazily imported (avoids any import cycle) + fire-and-forget so
// the hot path is never blocked or broken by a metrics failure.
let _selectionMetrics:
  | import('@/services/model-performance-tracker').ModelPerformanceTracker
  | null = null;
let _selectionMetricsLoading = false;
function bridgeSampleToSelectionMetrics(sample: ModelExecutionSample): void {
  const send = (t: NonNullable<typeof _selectionMetrics>): void => {
    void t
      .trackRequest({
        modelId: sample.modelId,
        taskType: sample.taskType as import('@/types').TaskType | undefined,
        responseTime: sample.latencyMs,
        cost: sample.costUsd,
        qualityScore: sample.qualityScore,
        success: sample.success,
      })
      .catch(() => { /* non-critical */ });
  };
  if (_selectionMetrics) {
    send(_selectionMetrics);
    return;
  }
  if (_selectionMetricsLoading) return;
  _selectionMetricsLoading = true;
  void import('@/services/model-performance-tracker')
    .then((m) => {
      _selectionMetrics = m.getModelPerformanceTracker();
      send(_selectionMetrics);
    })
    .catch(() => { /* non-critical */ })
    .finally(() => {
      _selectionMetricsLoading = false;
    });
}

class ModelPerformanceTracker {
  // modelId → ring buffer of recent samples
  private readonly rings = new Map<string, ModelExecutionSample[]>();
  // modelId → current dynamic score (EMA-based for speed)
  private readonly scores = new Map<string, DynamicModelScore>();
  // provider → time-windowed samples (replaces the old cumulative counter)
  private readonly providerSamples = new Map<string, ProviderSample[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startFlushTimer();
  }

  /**
   * Record a model execution sample and update the rolling score.
   * Non-blocking — all computation is synchronous in-memory.
   */
  record(sample: Omit<ModelExecutionSample, 'timestamp'>): void {
    const fullSample: ModelExecutionSample = { ...sample, timestamp: Date.now() };

    // Update ring buffer
    let ring = this.rings.get(sample.modelId);
    if (!ring) {
      ring = [];
      this.rings.set(sample.modelId, ring);
    }
    ring.push(fullSample);
    if (ring.length > RING_SIZE) ring.shift();

    // Update EMA score
    this.updateScore(sample.modelId, fullSample, ring);

    // Update provider-level stats (time-windowed sliding buffer).
    // IMPORTANT: `sample.provider` must be the EXECUTION provider (the adapter
    // that actually made the HTTP call), not the logical provider from the
    // model catalog. Attributing failures to the logical provider was the root
    // cause of the recurring pool-collapse bug: e.g. aihubmix failing on
    // `openai/gpt-4o-mini-search-preview` was being counted as an `openai`
    // failure, eventually marking native openai as unreliable.
    if (sample.provider) {
      const p = sample.provider.toLowerCase();
      let samples = this.providerSamples.get(p);
      if (!samples) {
        samples = [];
        this.providerSamples.set(p, samples);
      }
      samples.push({ timestamp: fullSample.timestamp, success: sample.success });
      // Evict samples older than the rolling window and cap memory.
      const cutoff = Date.now() - PROVIDER_WINDOW_MS;
      while (samples.length > 0 && samples[0].timestamp < cutoff) {
        samples.shift();
      }
      if (samples.length > PROVIDER_RING_MAX) {
        samples.splice(0, samples.length - PROVIDER_RING_MAX);
      }
    }

    // Mirror this sample into the SELECTOR's scoring store so scoring is no
    // longer blind (closes the measured-performance feedback loop).
    bridgeSampleToSelectionMetrics(fullSample);
  }

  /**
   * Update the EMA quality score for a model without touching provider stats.
   * Used by the orchestration engine to refine the initial 0.8 placeholder
   * from base-strategy with the actual LLM-judge score after execution.
   *
   * This replaces calling `record()` a second time, which previously double-
   * counted the execution in provider stats and polluted the unreliable
   * detection.
   */
  updateQualityOnly(modelId: string, qualityScore: number): void {
    const score = this.scores.get(modelId);
    if (!score) return;
    const newQuality = score.rollingQuality * (1 - EMA_ALPHA) + qualityScore * EMA_ALPHA;
    this.scores.set(modelId, {
      ...score,
      rollingQuality: newQuality,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Get the current dynamic score for a model.
   * Returns null if no samples have been recorded yet.
   */
  getDynamicScore(modelId: string): DynamicModelScore | null {
    return this.scores.get(modelId) ?? null;
  }

  /**
   * Get scores for multiple models at once.
   */
  getScores(modelIds: string[]): Map<string, DynamicModelScore> {
    const result = new Map<string, DynamicModelScore>();
    for (const id of modelIds) {
      const score = this.scores.get(id);
      if (score) result.set(id, score);
    }
    return result;
  }

  /**
   * Apply a dynamic score to a model's performance field.
   * Used by DynamicModelSelector to prefer empirical quality over DB seed values.
   */
  applyToModel<T extends { id: string; performance?: unknown }>(model: T): T {
    const score = this.getDynamicScore(model.id);
    if (!score || score.sampleCount < 5) return model; // Not enough data yet

    const existingPerf =
      model.performance && typeof model.performance === 'object' ? model.performance : {};

    return {
      ...model,
      performance: {
        ...(existingPerf as Record<string, unknown>),
        quality: score.rollingQuality,
        latencyMs: score.rollingLatencyP50,
        errorRate: score.errorRate,
        _empirical: true,
        _sampleCount: score.sampleCount,
      },
    };
  }

  /**
   * Check if a provider is unreliable based on the rolling window of recent
   * execution samples.
   *
   * Rules:
   *   1. Need at least `PROVIDER_MIN_SAMPLES` (5) samples in the window — avoids
   *      classifying on 1-2 bad requests right after startup.
   *   2. Only samples from the last `PROVIDER_WINDOW_MS` (15 min) count —
   *      old failures stop contributing automatically, so a provider can
   *      recover on its own without a container restart.
   *   3. Failure rate must be ≥ `PROVIDER_UNRELIABLE_THRESHOLD` (60%) —
   *      stricter than the old 50% to reduce false positives for normally
   *      noisy providers.
   */
  isProviderUnreliable(provider: string): boolean {
    const samples = this.providerSamples.get(provider.toLowerCase());
    if (!samples || samples.length < PROVIDER_MIN_SAMPLES) return false;
    // Trim any samples that fell out of the window since the last call.
    const cutoff = Date.now() - PROVIDER_WINDOW_MS;
    while (samples.length > 0 && samples[0].timestamp < cutoff) {
      samples.shift();
    }
    if (samples.length < PROVIDER_MIN_SAMPLES) return false;
    const failures = samples.filter((s) => !s.success).length;
    return failures / samples.length >= PROVIDER_UNRELIABLE_THRESHOLD;
  }

  /** Get all providers currently marked as unreliable by the rolling window. */
  getUnreliableProviders(): string[] {
    const unreliable: string[] = [];
    for (const [provider] of this.providerSamples.entries()) {
      if (this.isProviderUnreliable(provider)) {
        unreliable.push(provider);
      }
    }
    return unreliable;
  }

  /**
   * Debug helper: returns the current window stats for a provider.
   * Useful for diagnosing false positives without digging into memory.
   */
  getProviderWindowStats(provider: string): {
    samples: number;
    failures: number;
    failureRate: number;
    windowMinutes: number;
  } | null {
    const samples = this.providerSamples.get(provider.toLowerCase());
    if (!samples || samples.length === 0) return null;
    const cutoff = Date.now() - PROVIDER_WINDOW_MS;
    const inWindow = samples.filter((s) => s.timestamp >= cutoff);
    const failures = inWindow.filter((s) => !s.success).length;
    return {
      samples: inWindow.length,
      failures,
      failureRate: inWindow.length > 0 ? failures / inWindow.length : 0,
      windowMinutes: PROVIDER_WINDOW_MS / 60_000,
    };
  }

  private updateScore(
    modelId: string,
    sample: ModelExecutionSample,
    ring: ModelExecutionSample[]
  ): void {
    const current = this.scores.get(modelId);

    const prevQuality = current?.rollingQuality ?? sample.qualityScore;
    const newQuality = sample.success
      ? prevQuality * (1 - EMA_ALPHA) + sample.qualityScore * EMA_ALPHA
      : prevQuality * (1 - EMA_ALPHA); // Failed execution pulls quality down

    // P50/P99 from ring
    const successLatencies = ring
      .filter((s) => s.success)
      .map((s) => s.latencyMs)
      .sort((a, b) => a - b);

    const p50 = this.percentile(successLatencies, 50);
    const p99 = this.percentile(successLatencies, 99);
    const errorRate = ring.filter((s) => !s.success).length / ring.length;
    const avgCost =
      ring.reduce((s, r) => s + r.costUsd, 0) / ring.length || 0.001;
    const costEfficiency = newQuality / (avgCost * 1000 + 0.001);

    this.scores.set(modelId, {
      modelId,
      rollingQuality: newQuality,
      rollingLatencyP50: p50,
      rollingLatencyP99: p99,
      errorRate,
      costEfficiency,
      sampleCount: ring.length,
      lastUpdated: Date.now(),
    });
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx];
  }

  private startFlushTimer(): void {
    if (typeof setInterval === 'undefined') return; // Not in a timer-capable environment
    this.flushTimer = setInterval(() => {
      this.flushToDB().catch((err) => {
        log.warn({ error: String(err) }, 'ModelPerformanceTracker DB flush failed');
      });
    }, FLUSH_INTERVAL_MS);
    // Don't block process exit on this timer
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Flush current scores to model_health table for persistence across restarts.
   * Only flushes models that have collected ≥ 5 samples.
   */
  private async flushToDB(): Promise<void> {
    const eligibleScores = [...this.scores.values()].filter((s) => s.sampleCount >= 5);
    if (eligibleScores.length === 0) return;

    for (const score of eligibleScores) {
      try {
        await prisma.$executeRaw`
          INSERT INTO model_health (model_id, status, latency_ms, error_rate, availability, updated_at)
          VALUES (
            ${score.modelId},
            ${score.errorRate > 0.3 ? 'degraded' : 'healthy'},
            ${Math.round(score.rollingLatencyP50)},
            ${score.errorRate},
            ${1 - score.errorRate},
            NOW()
          )
          ON CONFLICT (model_id) DO UPDATE
            SET
              latency_ms = EXCLUDED.latency_ms,
              error_rate = EXCLUDED.error_rate,
              availability = EXCLUDED.availability,
              status = EXCLUDED.status,
              updated_at = NOW()
        `;
      } catch {
        // Non-fatal: tracker continues even if DB is unavailable
      }
    }

    log.debug({ flushed: eligibleScores.length }, 'ModelPerformanceTracker flushed to DB');
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// Singleton
export const modelPerformanceTracker = new ModelPerformanceTracker();
