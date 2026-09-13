// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Xinference Adapter — self-hosted multi-modality runtime (Xorbits Inference).
 *
 * Xinference (https://inference.readthedocs.io/) is a self-hosted model
 * serving runtime that speaks OpenAI on `/v1/chat/completions`,
 * `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`, and
 * `/v1/audio/transcriptions` — AND adds a **`/v1/rerank`** endpoint for
 * cross-encoder reranker models (bge-reranker, Cohere-style rerank).
 *
 * Rerank isn't part of the OpenAI spec. Since LOTE AP the base
 * `ProviderAdapter` carries a portable `rerank(model, request)` contract, so
 * this adapter overrides it and callers no longer narrow to
 * `XinferenceAdapter`; `rerankNative()` keeps the vendor wire shape. The
 * surface is intentionally Cohere-compatible:
 *
 *   POST /v1/rerank
 *   { model: string, query: string, documents: string[], top_n?: number }
 *   → { results: [{ index, relevance_score, document: {text} }] }
 *
 * ### Why a dedicated adapter
 *
 *   1. Rerank is a first-class Xinference capability that OAI providers
 *      don't expose — dropping it into the hub would force the hub to care
 *      about a non-standard surface.
 *   2. `apiKeyOptional: true` — Xinference runs unauthenticated by default.
 *   3. Clear named identity in metrics and circuit-breaker scoping.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';
import type { Model } from '@/types';
import type { RerankRequest, RerankResponse } from '@/types/model-client';

export type XinferenceAdapterConfig = OpenAICompatibleHubAdapterConfig;

export interface XinferenceRerankRequest {
  model: string;
  query: string;
  documents: string[];
  /** Return only the top-N results, sorted by relevance. */
  top_n?: number;
  /** Whether to echo the document text in each result. Default false. */
  return_documents?: boolean;
}

export interface XinferenceRerankResult {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

export interface XinferenceRerankResponse {
  id?: string;
  results: XinferenceRerankResult[];
  meta?: { api_version?: string };
}

export class XinferenceAdapter extends OpenAICompatibleHubAdapter {
  private readonly xlog = logger.child({ provider: 'xinference' });

  constructor(config: XinferenceAdapterConfig) {
    super({
      ...config,
      providerName: 'xinference',
      displayName: config.displayName || 'Xinference',
      metadata: {
        apiKeyOptional: true,
        ...config.metadata,
      },
    });
  }

  /**
   * POST /v1/rerank — Cohere-compatible cross-encoder reranker.
   *
   * Validation is lenient: empty `documents` returns a well-formed empty
   * result rather than hitting the wire, because an empty request is a
   * caller programming mistake and the local failure is clearer.
   */
  async rerankNative(request: XinferenceRerankRequest): Promise<XinferenceRerankResponse> {
    if (!request.model || !request.model.trim()) {
      throw new Error('xinference.rerank: model is required');
    }
    if (!request.query || typeof request.query !== 'string') {
      throw new Error('xinference.rerank: query is required (string)');
    }
    if (!Array.isArray(request.documents)) {
      throw new Error('xinference.rerank: documents must be an array of strings');
    }
    if (request.documents.length === 0) {
      return { results: [] };
    }

    const url = `${this.getBaseUrl()}/rerank`;
    const headers = {
      ...this.exposeBuildRequestHeaders(true),
      Accept: 'application/json',
    };

    const body = JSON.stringify({
      model: request.model,
      query: request.query,
      documents: request.documents,
      top_n: request.top_n,
      return_documents: request.return_documents ?? false,
    });

    // The hub base routes chat/embeddings through executeThroughBulkhead via
    // sendJsonRequestWithRetry; this rerank override calls fetch directly, so
    // wrap it too for uniform fast-fail + isolation.
    return this.executeThroughBulkhead(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 60_000)),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`Xinference rerank HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const json = (await res.json()) as XinferenceRerankResponse;
      if (!Array.isArray(json.results)) {
        throw new Error('xinference.rerank: response missing `results` array');
      }
      return json;
    }, 'rerank');
  }

  /**
   * Shared `ProviderAdapter.rerank` contract (LOTE AP). Flattens Xinference's
   * Cohere-shaped `results[].document.text` object into the portable bare
   * string and guarantees descending order (the runtime documents it but the
   * contract promises it).
   */
  async rerank(model: Model, request: RerankRequest): Promise<RerankResponse> {
    const native = await this.rerankNative({
      model: model.name || model.id,
      query: request.query,
      documents: [...request.documents],
      ...(typeof request.topN === 'number' ? { top_n: request.topN } : {}),
      ...(typeof request.returnDocuments === 'boolean'
        ? { return_documents: request.returnDocuments }
        : {}),
    });

    const results = native.results
      .map((entry) => ({
        index: entry.index,
        relevanceScore: entry.relevance_score,
        ...(entry.document?.text !== undefined ? { document: entry.document.text } : {}),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return { results, raw: native };
  }

  /** Expose the hub's base URL for the rerank endpoint. */
  private getBaseUrl(): string {
    // The hub's `baseURL` is protected but we only need the string — use the
    // config's `baseUrl` directly. The hub normalizes trailing slashes at
    // construction, so this matches what the hub uses for /chat/completions.
    const raw = this.config.baseUrl || '';
    return raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }

  /**
   * Shim into the hub's protected `buildRequestHeaders`. TypeScript's
   * protected modifier blocks direct access from this class's own methods
   * only when calling on `this` from outside the hierarchy chain — which
   * isn't our case. The cast here makes the override-override-override
   * chain explicit to readers.
   */
  private exposeBuildRequestHeaders(includeJsonContentType: boolean): Record<string, string> {
    return narrowAs<{
      buildRequestHeaders(includeJsonContentType: boolean): Record<string, string>;
    }>(this).buildRequestHeaders(includeJsonContentType);
  }
}
