// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TEI client — minimal wrapper around HuggingFace text-embeddings-inference.
 *
 * Phase 4 (2026-05-08): the embedding service for hot-path semantic
 * matching. Talks to a local TEI container (tei-embedder on
 * port 8080 inside the docker network, HCRA_EMBEDDER_URL env var).
 *
 * Why local TEI vs cloud HF API:
 *   - Latency: 5-15ms p99 vs 100-800ms cloud
 *   - Reliability: no rate limit, no 404 from upstream
 *   - Cost: $0 marginal
 *   - Privacy: query stays in-cluster
 *
 * The client is deliberately minimal — no retry, no circuit breaker.
 * Those concerns belong to the higher-level cache + ranking pipeline
 * (Phase 4.1).
 *
 * NOT included here:
 *   - Batching multiple queries in one /embed call (Phase 4.1)
 *   - Embedding model registry (which model is wired)
 *   - HNSW index (separate file, separate concern)
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'tei-client' });

// ─── Config ────────────────────────────────────────────────────────────────

/**
 * Resolves a positive integer env var, falling back to `defaultMs`.
 * Returns the default when env is absent, NaN, zero, or negative —
 * preventing footguns like `TEI_HEALTH_TIMEOUT_MS=0` (instant abort).
 */
function readTimeoutEnv(envName: string, defaultMs: number): number {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
}

const DEFAULT_BASE_URL = process.env.HCRA_EMBEDDER_URL ?? 'http://tei-embedder:8080';

/**
 * Embed timeout default: 5s. Tunable via TEI_EMBED_TIMEOUT_MS.
 * Embed payloads can be large (1024-dim float arrays × N inputs) so the
 * tail can exceed simple /health latency by an order of magnitude under
 * batching pressure.
 */
const DEFAULT_EMBED_TIMEOUT_MS = readTimeoutEnv('TEI_EMBED_TIMEOUT_MS', 5_000);

/**
 * Health timeout default: 5s (was 1.5s pre-R2). The earlier 1.5s was too
 * aggressive — under event loop saturation (plugin init concurrent with
 * discovery probes), fetch dispatch alone can exceed 1.5s, causing
 * `tei.isHealthy()` to falsely return false even when TEI itself is
 * responding in <50ms. The pipeline then no-ops the rebuild and the
 * SemanticIndex stays empty.
 *
 * Tune via TEI_HEALTH_TIMEOUT_MS for environments with different latency
 * budgets.
 */
// LAT-10 (2026-06-11): the 5s default let a saturated boot block on TEI health
// for the full window even when TEI was healthy; 1.5s is ample for a local
// /health probe and fails fast to the lexical fallback when TEI is down.
const DEFAULT_HEALTH_TIMEOUT_MS = readTimeoutEnv('TEI_HEALTH_TIMEOUT_MS', 1_500);

export interface TEIClientConfig {
  baseUrl?: string;
  /** Timeout for /embed POST. Default: TEI_EMBED_TIMEOUT_MS env or 5s. */
  timeoutMs?: number;
  /** Timeout for /health GET. Default: TEI_HEALTH_TIMEOUT_MS env or 5s. */
  healthTimeoutMs?: number;
}

// ─── Wire shapes ──────────────────────────────────────────────────────────
// TEI /embed returns number[][] (one vector per input) or [[...]] for a
// single input; request body is { inputs: string | string[] }. The response
// is parsed structurally below (accepting array-of-arrays and
// array-of-numbers), so no named wire interface is needed.

// ─── Client ────────────────────────────────────────────────────────────────

class TEIClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;

  constructor(config: TEIClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.healthTimeoutMs = config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  /**
   * Embeds a single string. Returns a Float32Array.
   * Throws on HTTP error or timeout.
   */
  async embed(text: string): Promise<Float32Array> {
    const arr = await this.embedBatch([text]);
    if (!arr[0]) throw new Error('TEI returned empty response for single input');
    return arr[0];
  }

  /**
   * Embeds an array of strings in a single request. Returns one
   * Float32Array per input, in input order.
   *
   * Use this when you have multiple queries to embed concurrently —
   * TEI's batched inference is significantly more efficient than N
   * sequential `embed` calls.
   */
  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: texts.length === 1 ? texts[0] : [...texts] }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`TEI embed failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
      }
      const json: unknown = await resp.json();
      return parseTEIResponse(json, texts.length);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Health check — call /health, return true if responsive.
   * Used by readiness validators; never throws.
   */
  async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      return resp.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Diagnostic helper: returns the active timeout values. Used by the
   * admin endpoint to surface the actual config in production
   * (so operators can confirm env wiring took effect).
   */
  getTimeouts(): { embedMs: number; healthMs: number } {
    return { embedMs: this.timeoutMs, healthMs: this.healthTimeoutMs };
  }
}

// ─── Response parser ──────────────────────────────────────────────────────

function parseTEIResponse(json: unknown, expectedLength: number): Float32Array[] {
  if (!Array.isArray(json)) {
    throw new Error('TEI response not an array');
  }

  // Case 1: outer array IS the embedding (single input, response is [num, num, ...])
  if (json.length > 0 && typeof json[0] === 'number') {
    if (expectedLength !== 1) {
      throw new Error(`TEI returned single embedding but ${expectedLength} expected`);
    }
    return [Float32Array.from(json as number[])];
  }

  // Case 2: outer array is array-of-embeddings (batched response)
  const out: Float32Array[] = [];
  for (const entry of json) {
    if (!Array.isArray(entry) || entry.length === 0 || typeof entry[0] !== 'number') {
      throw new Error('TEI batched response entry is not number[]');
    }
    out.push(Float32Array.from(entry as number[]));
  }
  if (out.length !== expectedLength) {
    log.warn(
      { received: out.length, expected: expectedLength },
      'TEI returned different number of embeddings than requested',
    );
  }
  return out;
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: TEIClient | null = null;

export function getTEIClient(config?: TEIClientConfig): TEIClient {
  if (!instance) {
    instance = new TEIClient(config);
  }
  return instance;
}

export function resetTEIClientForTesting(): void {
  instance = null;
}

export type { TEIClient };
