// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAI Capability Embedder (ADR-022, Sprint 3)
 *
 * Default implementation of `CapabilityEmbedder` backed by OpenAI's
 * `text-embedding-3-small` with `dimensions: 384` (Matryoshka truncation,
 * supported natively since the v3 family).
 *
 * Why OpenAI 3-small at 384d:
 * - Cheapest production-grade embedder available (~$0.02 / 1M tokens).
 * - Matryoshka-trained — truncation to 384 retains the bulk of semantic
 *   quality vs the full 1536d. Documented loss is ~2-3% on MTEB.
 * - The project already has OpenAI credentials wired (see openai-adapter.ts).
 *   Reusing the same client keeps the dependency surface stable.
 *
 * Cost envelope (back-of-envelope):
 *   60 ontology entries × ~30 tokens each   = 1.8k tokens once
 *   6.8k models × ~40 tokens each           = 272k tokens once + delta
 *   Steady state (delta only):              ~10k tokens / day
 *   Monthly cost: well under $0.01.
 *
 * Failure modes handled here:
 * - Network/rate-limit errors → throw (worker retries with exponential backoff).
 * - Batch too large → OpenAI splits internally; we cap at 96 to stay safely
 *   below the 2048-input limit and the 8191-token-per-input limit.
 * - Empty input → returns zero vector (deterministic, avoids NaN downstream).
 */

import OpenAI from 'openai';
import {
  EMBEDDING_DIM,
  type CapabilityEmbedder,
  type EmbedderId,
  type EmbedResult,
} from './embedder';

const DEFAULT_MODEL = 'text-embedding-3-small';
/**
 * Default batch sizes:
 *  - OpenAI cloud: 96 inputs/request (well under the 2048 array limit and
 *    the 8191-token-per-input limit). Tuned for cost-amortised throughput.
 *  - TEI sidecar (HCRA_EMBEDDER_URL set): 8 inputs/request. The ONNX backend
 *    in `text-embeddings-inference` warms up with `Backend does not support a
 *    batch size > 8` for bge-small-en-v1.5; sending more triggers HTTP 413.
 *    Operators can override with `HCRA_EMBEDDER_BATCH_SIZE` if they tune TEI
 *    with a larger backend (CUDA / FlashAttention) that admits >8.
 */
const DEFAULT_BATCH_SIZE_OPENAI = 96;
const DEFAULT_BATCH_SIZE_SIDECAR = 8;
const MAX_INPUT_CHARS = 8_000; // ~2k tokens, well under the 8191-token limit

/**
 * Resolve batch size from env, falling back to backend-aware defaults.
 * Read on every construct (not module load) so tests can override via env
 * before instantiating a fresh embedder.
 */
function resolveBatchSize(hasSidecarUrl: boolean): number {
  const raw = process.env.HCRA_EMBEDDER_BATCH_SIZE;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return hasSidecarUrl ? DEFAULT_BATCH_SIZE_SIDECAR : DEFAULT_BATCH_SIZE_OPENAI;
}

/**
 * Whether to send the OpenAI-specific `dimensions` truncation hint.
 *  - OpenAI v3 family (`text-embedding-3-*`) supports Matryoshka truncation.
 *  - TEI ignores the field gracefully but other OpenAI-compat backends may
 *    422 on it. Be conservative: only send when the model name pattern
 *    matches the v3 family AND we are NOT pointed at a sidecar.
 */
function shouldSendDimensions(model: string, hasSidecarUrl: boolean): boolean {
  if (hasSidecarUrl) return false;
  return /^text-embedding-3-/.test(model);
}

export interface OpenAIEmbedderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Override embedder id for tests / multi-region routing. If omitted, derived
   * from `model` and `dimensions` (e.g. `openai/text-embedding-3-small@384`).
   */
  id?: EmbedderId;
}

export class OpenAIEmbedder implements CapabilityEmbedder {
  readonly id: EmbedderId;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly sendDimensions: boolean;

  constructor(opts: OpenAIEmbedderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenAIEmbedder: OPENAI_API_KEY missing. Set the env var or pass apiKey explicitly.',
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseUrl,
      timeout: 30_000,
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.id = opts.id ?? `openai/${this.model}@${EMBEDDING_DIM}`;
    // Backend-aware tuning: TEI sidecars and other OpenAI-compat backends
    // typically cap batch size at 8 and reject the `dimensions` field. The
    // factory passes `baseUrl` only when HCRA_EMBEDDER_URL is set, so we use
    // its presence as the sidecar signal.
    const hasSidecarUrl = Boolean(opts.baseUrl);
    this.batchSize = resolveBatchSize(hasSidecarUrl);
    this.sendDimensions = shouldSendDimensions(this.model, hasSidecarUrl);
  }

  async embed(text: string): Promise<EmbedResult> {
    const [result] = await this.embedBatch([text]);
    if (!result) throw new Error('OpenAIEmbedder.embed: empty result from embedBatch');
    return result;
  }

  async embedBatch(texts: readonly string[]): Promise<EmbedResult[]> {
    if (texts.length === 0) return [];

    const out = new Array<EmbedResult>(texts.length);

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const slice = texts.slice(i, i + this.batchSize);
      const sanitized = slice.map(safeInput);
      // The OpenAI SDK strips undefined fields on the wire, so omitting
      // `dimensions` keeps the request bytes identical for backends that
      // would 422 on the field. EMBEDDING_DIM is still enforced by the
      // length check below — non-Matryoshka backends MUST already serve
      // the expected dimension natively (we deploy bge-small-en-v1.5 at 384).
      const params: Parameters<typeof this.client.embeddings.create>[0] = {
        model: this.model,
        input: sanitized,
        encoding_format: 'float',
      };
      if (this.sendDimensions) {
        (params as { dimensions?: number }).dimensions = EMBEDDING_DIM;
      }
      const response = await this.client.embeddings.create(params);

      if (response.data.length !== slice.length) {
        throw new Error(
          `OpenAIEmbedder: response length mismatch — expected ${slice.length}, got ${response.data.length}`,
        );
      }

      for (let j = 0; j < response.data.length; j += 1) {
        const item = response.data[j];
        if (!item || !Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIM) {
          throw new Error(
            `OpenAIEmbedder: malformed embedding at batch offset ${j} (dim=${item?.embedding?.length})`,
          );
        }
        out[i + j] = { vector: item.embedding };
      }
    }

    return out;
  }
}

/**
 * Truncate to the API's safe input window. OpenAI rejects inputs > 8191 tokens;
 * 8000 chars is a conservative proxy (assumes ~4 chars/token = 2000 tokens).
 * Empty strings get a placeholder so the API doesn't error on zero-length input.
 */
function safeInput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '∅';
  if (trimmed.length <= MAX_INPUT_CHARS) return trimmed;
  return trimmed.slice(0, MAX_INPUT_CHARS);
}
