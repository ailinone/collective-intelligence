// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Perplexity Adapter — OpenAI-shape chat with first-class web-search citations.
 *
 * Perplexity accepts OpenAI-compatible chat requests but returns an extra
 * top-level `citations: string[]` array alongside `choices`. The generic hub
 * adapter drops unknown top-level fields, which is fine for providers that
 * just return standard OAI — but for Perplexity it means **every response
 * loses its citations**, defeating the entire point of using Perplexity over
 * GPT-4.
 *
 * ### Documented API surface
 * (Source: https://docs.perplexity.ai/api-reference/chat-completions)
 *
 *   POST /chat/completions
 *     Body: OpenAI chat shape + perplexity-specific knobs:
 *       - search_domain_filter?: string[]   (allowlist: ['arxiv.org', ...])
 *       - search_recency_filter?: 'day' | 'week' | 'month' | 'year'
 *       - return_citations?: boolean (default true — ignored on sonar-*)
 *       - return_images?: boolean
 *       - return_related_questions?: boolean
 *
 *     Response: OpenAI envelope + top-level extras:
 *       - citations: string[]                 (the URLs)
 *       - related_questions?: string[]
 *       - images?: Array<{image_url, origin_url, height, width}>
 *
 *   No `GET /models` endpoint. Catalog entry supplies `staticModels`.
 *
 * ### Why dedicated
 *
 *   - Citations must survive the response. Without this class they'd be
 *     dropped by the hub adapter's response shape.
 *   - Search filters (`search_domain_filter`, `search_recency_filter`) are
 *     Perplexity-specific and must be plumbed through the ChatRequest
 *     options bag — same pattern as Groq reasoning knobs.
 *   - Perplexity is the only provider we have where `web_search` is the
 *     entire point — the routing layer uses `web_search` capability to
 *     prefer Perplexity for real-time queries.
 *
 * ### What this class does NOT do
 *
 *   - It does not fabricate citations when the upstream returns none.
 *   - It does not attempt to parse or validate the citation URLs — they
 *     are exposed verbatim. Consumers that want to render them are
 *     responsible for URL validation/cleanup.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { narrowAs } from '@/utils/type-guards';
import type { ChatRequest, ChatResponse } from '@/types';

export interface PerplexitySearchOptions {
  search_domain_filter?: string[];
  search_recency_filter?: 'day' | 'week' | 'month' | 'year';
  return_citations?: boolean;
  return_images?: boolean;
  return_related_questions?: boolean;
}

/**
 * Extended ChatResponse shape — documented to hold the Perplexity extras.
 * Consumers receive a ChatResponse cast to this type when they know they're
 * talking to Perplexity; everyone else still sees standard OpenAI fields.
 */
export interface PerplexityChatResponse extends ChatResponse {
  citations?: string[];
  related_questions?: string[];
  images?: Array<{ image_url: string; origin_url?: string; height?: number; width?: number }>;
}

export class PerplexityAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'perplexity',
      displayName: config.displayName || 'Perplexity AI',
    });
  }

  /**
   * Type-narrow the hub's generic ChatResponse to a PerplexityChatResponse.
   * At runtime the hub spreads the upstream JSON envelope as-is, so top-level
   * `citations`/`related_questions`/`images` fields are preserved verbatim —
   * this override only refines the static type for consumers that know
   * they're talking to Perplexity.
   */
  override async chatCompletion(request: ChatRequest): Promise<PerplexityChatResponse> {
    return (await super.chatCompletion(request)) as PerplexityChatResponse;
  }

  override async *chatCompletionStream(
    request: ChatRequest,
  ): AsyncGenerator<PerplexityChatResponse, void, unknown> {
    for await (const chunk of super.chatCompletionStream(request)) {
      yield chunk as PerplexityChatResponse;
    }
  }

  /**
   * Inject Perplexity search knobs (search_domain_filter, search_recency_filter,
   * return_citations, return_images, return_related_questions) via the hub's
   * typed extension hook. This replaces the broken "spread onto request"
   * pattern — the hub's payload builder is closed, and extra top-level keys
   * on ChatRequest are silently dropped.
   */
  protected override getExtraChatPayloadFields(
    _resolvedModel: string,
    request: ChatRequest,
  ): Record<string, unknown> {
    const searchOpts = this.extractSearchOptions(request);
    return searchOpts ? { ...searchOpts } : {};
  }

  /**
   * Extract Perplexity search knobs from either `request.options` or the
   * request root (both forms are accepted by the upstream). The allowlist
   * prevents option-bag leakage into the body.
   */
  private extractSearchOptions(
    request: ChatRequest,
  ): Partial<PerplexitySearchOptions> | undefined {
    const opts = (narrowAs<{ options?: Record<string, unknown> }>(request)).options;
    const source: Record<string, unknown> =
      opts && typeof opts === 'object'
        ? opts
        : (narrowAs<Record<string, unknown>>(request));

    const picked: Partial<PerplexitySearchOptions> = {};
    if (Array.isArray(source.search_domain_filter)) {
      const filtered = source.search_domain_filter.filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (filtered.length > 0) picked.search_domain_filter = filtered;
    }
    const recency = source.search_recency_filter;
    if (recency === 'day' || recency === 'week' || recency === 'month' || recency === 'year') {
      picked.search_recency_filter = recency;
    }
    if (typeof source.return_citations === 'boolean') picked.return_citations = source.return_citations;
    if (typeof source.return_images === 'boolean') picked.return_images = source.return_images;
    if (typeof source.return_related_questions === 'boolean') {
      picked.return_related_questions = source.return_related_questions;
    }
    return Object.keys(picked).length > 0 ? picked : undefined;
  }
}
