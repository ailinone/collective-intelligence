// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Embedder Interface (ADR-022, Sprint 3)
 *
 * Abstracts the embedding backend so the worker doesn't care whether we run
 * BGE-small inside a TEI container, hit OpenAI's `text-embedding-3-small`
 * with `dimensions=384`, or self-host on Ollama. The contract is simple:
 *   embed(strings) ⇒ Float32 vectors of length 384.
 *
 * Why HTTP-based and not in-process ONNX
 * --------------------------------------
 * Running BGE-small via @huggingface/transformers in Node works but pulls a
 * ~30MB model + ~80MB onnxruntime-node into the API container. That cost
 * makes sense once we have GPU/batch needs, but for the current scale
 * (~7k models × one embedding each, refreshed monthly) an HTTP call to a
 * sidecar TEI container or a hosted endpoint is cheaper to operate, easier
 * to scale independently, and lets us swap embedders without redeploying
 * the API.
 *
 * The interface is small enough that a future in-process implementation
 * (when batch throughput becomes the bottleneck) is a one-class addition.
 *
 * Configuration (env)
 * -------------------
 *   HCRA_EMBEDDER_URL     — base URL ending at the OpenAI-compatible host
 *                           (e.g. https://api.openai.com or http://tei:8080).
 *                           Required.
 *   HCRA_EMBEDDER_MODEL   — model name to send in the request body.
 *                           Default: "BAAI/bge-small-en-v1.5" (TEI default).
 *   HCRA_EMBEDDER_API_KEY — Bearer token. Optional for local TEI.
 *   HCRA_EMBEDDER_DIMS    — output dimensionality. Default 384. The
 *                           OpenAI-compatible endpoints accept `dimensions`
 *                           param for truncation (text-embedding-3-* support
 *                           Matryoshka). Hard-validated against vector(384)
 *                           column on persistence.
 *   HCRA_EMBEDDER_BATCH   — max strings per request. Default 32.
 *
 * The factory will throw at startup if no URL is configured AND a worker
 * tries to use the embedder. A noop "missing embedder" mode would mask
 * silent embedding rot — explicit error is correct.
 */

import { logger } from '@/utils/logger';

export const EMBEDDING_DIMS = 384;

export interface EmbedderRequest {
  /** Strings to embed. Order is preserved in the response. */
  inputs: string[];
}

export interface EmbedderResult {
  /** One vector per input, in input order. Vector length === EMBEDDING_DIMS. */
  vectors: number[][];
  /** Echo of the embedder identity for persistence (`models.embedding_model`). */
  modelVersion: string;
}

export interface Embedder {
  /** The model identifier as it should be persisted (`embedding_model` column). */
  readonly modelVersion: string;
  /** Output dimensionality. Persistence layer validates equality with `EMBEDDING_DIMS`. */
  readonly dimensions: number;
  /** Embed a batch. Throws on transport/decode error. The caller is responsible for retry. */
  embed(req: EmbedderRequest): Promise<EmbedderResult>;
}

// ─── OpenAI-compatible HTTP embedder ──────────────────────────────────────────

interface OpenAIEmbeddingsResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export interface OpenAICompatibleEmbedderConfig {
  /** Base URL ending at the host root, e.g. "https://api.openai.com" or "http://tei:8080". */
  baseUrl: string;
  /** Model identifier sent in the body. */
  model: string;
  /** Optional bearer token. */
  apiKey?: string;
  /** Output dims; some backends honour this (OpenAI text-embedding-3-*), others ignore. */
  dimensions?: number;
  /** Max batch size. */
  batchSize?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly modelVersion: string;
  readonly dimensions: number;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly log = logger.child({ component: 'embedder.openai-compat' });

  constructor(config: OpenAICompatibleEmbedderConfig) {
    if (!config.baseUrl) throw new Error('OpenAICompatibleEmbedder: baseUrl is required');
    if (!config.model) throw new Error('OpenAICompatibleEmbedder: model is required');
    this.modelVersion = config.model;
    this.dimensions = config.dimensions ?? EMBEDDING_DIMS;
    const trimmed = config.baseUrl.replace(/\/+$/, '');
    // Tolerate either ".../v1" or root.
    this.url = trimmed.endsWith('/v1') ? `${trimmed}/embeddings` : `${trimmed}/v1/embeddings`;
    this.apiKey = config.apiKey;
    this.batchSize = config.batchSize ?? 32;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async embed(req: EmbedderRequest): Promise<EmbedderResult> {
    if (req.inputs.length === 0) {
      return { vectors: [], modelVersion: this.modelVersion };
    }

    const out = new Array<number[]>(req.inputs.length);

    // Slice into provider-friendly batches. Order preserved via absolute index.
    for (let start = 0; start < req.inputs.length; start += this.batchSize) {
      const slice = req.inputs.slice(start, start + this.batchSize);
      const vectors = await this.embedSlice(slice);
      for (let i = 0; i < vectors.length; i += 1) {
        out[start + i] = vectors[i]!;
      }
    }

    return { vectors: out, modelVersion: this.modelVersion };
  }

  private async embedSlice(inputs: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.modelVersion,
      input: inputs,
      encoding_format: 'float',
    };
    // Only emit `dimensions` when caller explicitly wants it; many local
    // backends (TEI, Ollama embed endpoints) reject unknown keys.
    if (this.dimensions !== EMBEDDING_DIMS || /text-embedding-3/.test(this.modelVersion)) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await safeReadBody(response);
      const err = new Error(`Embedder ${response.status}: ${text.slice(0, 300)}`);
      this.log.warn(
        { url: this.url, status: response.status, sample: text.slice(0, 200) },
        'Embedder request failed',
      );
      throw err;
    }

    const payload = (await response.json()) as OpenAIEmbeddingsResponse;
    if (!payload.data || !Array.isArray(payload.data)) {
      throw new Error('Embedder response missing `data` array');
    }
    if (payload.data.length !== inputs.length) {
      throw new Error(
        `Embedder returned ${payload.data.length} vectors for ${inputs.length} inputs`,
      );
    }

    // Sort by index in case the backend returns out-of-order (the spec allows it).
    const sorted = [...payload.data].sort((a, b) => a.index - b.index);
    return sorted.map((row, i) => {
      const vec = row.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`Embedder returned empty vector at index ${i}`);
      }
      if (vec.length !== this.dimensions) {
        throw new Error(
          `Embedder returned vector of length ${vec.length} but expected ${this.dimensions}`,
        );
      }
      return vec;
    });
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let cached: Embedder | null = null;

/**
 * Build the embedder from environment. Cached as a singleton because the
 * config is immutable per process and the embedder is stateless past
 * construction.
 *
 * Throws if no `HCRA_EMBEDDER_URL` is configured. Callers that want an
 * "absent embedder is fine" semantic should call `tryGetEmbedder()` instead.
 */
export function getEmbedder(): Embedder {
  if (cached) return cached;
  const url = process.env.HCRA_EMBEDDER_URL;
  if (!url) {
    throw new Error(
      'HCRA_EMBEDDER_URL is not set. Configure to point at a TEI/OpenAI-compatible /v1/embeddings host.',
    );
  }
  cached = new OpenAICompatibleEmbedder({
    baseUrl: url,
    model: process.env.HCRA_EMBEDDER_MODEL ?? 'BAAI/bge-small-en-v1.5',
    apiKey: process.env.HCRA_EMBEDDER_API_KEY,
    dimensions: process.env.HCRA_EMBEDDER_DIMS ? Number(process.env.HCRA_EMBEDDER_DIMS) : EMBEDDING_DIMS,
    batchSize: process.env.HCRA_EMBEDDER_BATCH ? Number(process.env.HCRA_EMBEDDER_BATCH) : 32,
  });
  return cached;
}

export function tryGetEmbedder(): Embedder | null {
  try { return getEmbedder(); } catch { return null; }
}

/** Test hook — clear the singleton between tests or after env updates. */
export function resetEmbedderForTesting(): void {
  cached = null;
}

/** Inject an embedder (DI / tests / batch reprocessing with a different backend). */
export function setEmbedderForTesting(embedder: Embedder | null): void {
  cached = embedder;
}
