// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Voyage AI Adapter — embeddings + rerank only.
 *
 * Voyage is an embeddings/rerank specialist. It does NOT expose chat
 * completions. This adapter is deliberately not an `OpenAICompatibleHub*`
 * extension because the rerank endpoint has nothing in common with the
 * OpenAI chat surface — different URL, different payload, different response.
 *
 * ### Documented API surface (source: https://docs.voyageai.com/reference)
 *
 *   GET  /v1/models
 *     List models. Returns { data: [{ id, object: 'model', ... }] }.
 *
 *   POST /v1/embeddings
 *     Body: {
 *       input: string | string[],
 *       model: <embedding-model-id>,         // discovered from /v1/models
 *       input_type?: 'query' | 'document',
 *       truncation?: boolean,
 *       encoding_format?: 'float' | 'base64',
 *       output_dimension?: number,
 *     }
 *     Response: { object: 'list', data: [{ object: 'embedding', embedding: number[], index }], model, usage }.
 *
 *   POST /v1/rerank
 *     Body: {
 *       query: string,
 *       documents: string[],
 *       model: <rerank-model-id>,            // discovered from /v1/models
 *       top_k?: number,
 *       return_documents?: boolean,
 *       truncation?: boolean,
 *     }
 *     Response: { object: 'list', data: [{ index, relevance_score, document? }], model, usage }.
 *
 * Specific model names are intentionally NOT hardcoded in this adapter — the
 * catalog / dynamic discovery service is the sole source of truth. Voyage
 * families are identified by kebab-case prefix (see KNOWN_MODEL_PREFIXES) so
 * the capability classifier can tag embeddings-vs-rerank without knowing the
 * individual model identifiers.
 *
 * ### Auth
 *
 * `Authorization: Bearer <VOYAGE_API_KEY>`. No org/project/region headers.
 *
 * ### Rerank is the differentiator
 *
 * The `rerank()` method on this adapter is the reason Voyage gets a dedicated
 * class. The base `ProviderAdapter` has no rerank abstraction — so rerank is
 * exposed via a class-specific method that callers narrow to `VoyageAdapter`
 * when the capability routing resolves to Voyage. Until a first-class rerank
 * interface lands in `ProviderAdapter`, `rerank()` here is the contract.
 */

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import { narrowAs } from '@/utils/type-guards';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';

export interface VoyageAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
}

/** Rerank request — not yet in shared types; lives here until Voyage has a peer. */
export interface VoyageRerankRequest {
  readonly query: string;
  readonly documents: readonly string[];
  readonly model: string;
  readonly top_k?: number;
  readonly return_documents?: boolean;
  readonly truncation?: boolean;
}

/** Rerank response mirroring the documented Voyage shape. */
export interface VoyageRerankResponse {
  readonly object: 'list';
  readonly model: string;
  readonly data: ReadonlyArray<{
    readonly index: number;
    readonly relevance_score: number;
    readonly document?: string;
  }>;
  readonly usage?: { readonly total_tokens: number };
}

/**
 * Voyage model family PREFIXES — the ONE intentional structural hardcode in
 * this adapter. These are not model IDs; they're the `family-` segment of a
 * kebab-case naming convention that Voyage uses across every generation
 * (`voyage-*` = embeddings, `rerank-*` = cross-encoder rerankers). The
 * classifier below tags a discovered model's capability by matching its
 * prefix — no specific model IDs are enumerated. When Voyage ships a new
 * family (e.g. `voyage-vision-*`), this list is the single extension point;
 * the discovery service doesn't need a code change.
 */
const KNOWN_MODEL_PREFIXES = ['voyage-', 'rerank-'] as const;

export class VoyageAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly log = logger.child({ provider: 'voyage' });

  constructor(config: VoyageAdapterConfig) {
    super('voyage', 'Voyage AI', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.voyageai.com/v1').replace(/\/$/, '');
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'voyage',
      name: 'voyage',
      displayName: this.displayName,
      status: health.healthy ? 'active' : 'disabled',
      models,
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
    };
  }

  /**
   * Voyage does NOT expose a public GET /v1/models endpoint — confirmed
   * HTTP 404 via live probe (2026-04-22) and cross-checked against
   * docs.voyageai.com, which only documents /embeddings, /multimodalembeddings,
   * and /rerank. The catalog is therefore the single source of truth for
   * Voyage model IDs; the adapter returns an empty list here so the discovery
   * merger treats Voyage as "catalog-only" for this provider instead of
   * recording a spurious HTTP failure on every startup.
   *
   * If Voyage ever ships a discovery endpoint, restore the fetchJson<>('/models')
   * path here — the KNOWN_MODEL_PREFIXES classifier below is already in place
   * for family tagging.
   */
  async getModels(): Promise<Model[]> {
    this.log.debug(
      'Voyage has no /v1/models endpoint — returning empty list (model IDs come from catalog/DB)',
    );
    // KNOWN_MODEL_PREFIXES remains the extension point if discovery returns —
    // suppress the unused-const warning without silencing it at lint level.
    void KNOWN_MODEL_PREFIXES;
    return [];
  }

  /**
   * Chat is not supported. Explicit error so routing code never silently
   * dispatches a chat request to Voyage.
   */
  async chatCompletion(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error(
      'voyage: chatCompletion not supported — Voyage is embeddings + rerank only',
    );
  }

  async *chatCompletionStream(
    _request: ChatRequest,
  ): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error(
      'voyage: chatCompletionStream not supported — Voyage is embeddings + rerank only',
    );
    // unreachable yield for generator type conformance
    yield undefined as never;
  }

  /**
   * POST /v1/embeddings — matches documented Voyage shape 1:1.
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const body: Record<string, unknown> = {
      input: request.input,
      model: request.model,
    };
    if (request.encoding_format) body.encoding_format = request.encoding_format;
    // `input_type` is Voyage-specific. If the caller passes it via a
    // per-request option on EmbeddingRequest, we forward it. We don't invent
    // a default — Voyage's server-side default is fine.
    const extra = (narrowAs<{ input_type?: string }>(request)).input_type;
    if (extra === 'query' || extra === 'document') {
      body.input_type = extra;
    }

    const json = await this.fetchJson<EmbeddingResponse>('/embeddings', {
      method: 'POST',
      body,
    });
    return json;
  }

  /**
   * POST /v1/rerank — Voyage-specific. No shared `rerank()` on ProviderAdapter
   * yet, so this lives on the concrete class. Callers obtain the adapter via
   * the registry and narrow to VoyageAdapter when the capability is `rerank`.
   */
  async rerank(request: VoyageRerankRequest): Promise<VoyageRerankResponse> {
    if (!request.query || request.query.trim().length === 0) {
      throw new Error('voyage.rerank: query must be non-empty');
    }
    if (!Array.isArray(request.documents) || request.documents.length === 0) {
      throw new Error('voyage.rerank: documents must be a non-empty array');
    }

    const body: Record<string, unknown> = {
      query: request.query,
      documents: request.documents,
      model: request.model,
    };
    if (typeof request.top_k === 'number') body.top_k = request.top_k;
    if (typeof request.return_documents === 'boolean') body.return_documents = request.return_documents;
    if (typeof request.truncation === 'boolean') body.truncation = request.truncation;

    return this.fetchJson<VoyageRerankResponse>('/rerank', {
      method: 'POST',
      body,
    });
  }

  /**
   * Healthcheck — Voyage does not expose a GET discovery or ping endpoint,
   * and /embeddings is a metered POST. To avoid burning paid quota on each
   * periodic health probe we verify the key is present and defer the real
   * auth check to the first actual embeddings/rerank call (which will
   * surface a 401 immediately if the key is invalid). This is the same
   * trade-off several other embeddings-only providers make.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'VOYAGE_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    return {
      healthy: true,
      checkedAt: new Date(),
      latency: Date.now() - start,
    };
  }

  /**
   * Cost calculation — Voyage's /models does not include pricing, so unless
   * the capability merger has seeded numbers we return 0. Zero is treated as
   * "unknown" (see dynamic-model-selector).
   */
  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  /**
   * Normalize the caller-supplied model name. We deliberately do NOT fall back
   * to any specific model ID here — a missing/blank model is a caller bug, and
   * silently routing to a hardcoded default would mask routing failures. The
   * discovery pipeline is expected to resolve the concrete model before the
   * request reaches the adapter.
   */
  normalizeModelName(modelName: string): string {
    const trimmed = modelName?.trim();
    if (!trimmed) {
      throw new Error(
        'voyage.normalizeModelName: model is required — no hardcoded default is applied at adapter level',
      );
    }
    return trimmed;
  }

  // ─── Specialty disclaimers — Voyage does none of these ─────────────────
  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('voyage: imageEdit not supported');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('voyage: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('voyage: moderation not supported');
  }

  // ─── Internals ────────────────────────────────────────────────────────
  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async fetchJson<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const timeoutMs = Math.max(1000, this.config.timeout ?? 30000);

    // Single choke-point for all Voyage API calls — route through the
    // resilience stack (bulkhead → breaker → timeout) so an outage fast-fails
    // and is isolated per-provider.
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(url, {
        method: init.method,
        headers: this.buildHeaders(),
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '<unreadable>');
        throw new Error(`Voyage HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      return (await response.json()) as T;
    }, `${init.method} ${path}`);
  }
}
