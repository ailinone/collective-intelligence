// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vercel AI Gateway Adapter — OpenAI-compatible multi-upstream gateway.
 *
 * Vercel's gateway proxies to OpenAI, Anthropic, Google, xAI, etc. Models
 * are namespaced as `provider/model` — for example `anthropic/claude-sonnet-4`,
 * `openai/gpt-4o`. The `/v1/models` response carries the same namespaced IDs
 * plus an `owned_by` field declaring the original upstream.
 *
 * ### Documented API surface
 * (Source: https://vercel.com/docs/ai-gateway/provider-specific-models)
 *
 *   POST /v1/chat/completions    (OpenAI shape; model is `provider/id`)
 *   POST /v1/embeddings          (same)
 *   GET  /v1/models              (response: { data: [{ id: 'openai/gpt-4o', owned_by: 'openai', ... }] })
 *
 *   Headers:
 *     Authorization: Bearer <VERCEL_AI_GATEWAY_API_KEY>
 *
 * ### Why dedicated (beyond hub)
 *
 *   - The `owned_by` field is the CRITICAL signal for capability-merger
 *     attribution: when routing a request to `anthropic/claude-sonnet-4`
 *     via Vercel, the capability surface must come from the Anthropic
 *     family merger, NOT from a generic "vercel-ai-gateway" row.
 *
 *   - Model-id parsing (`anthropic/claude-sonnet-4` → family='anthropic',
 *     modelId='claude-sonnet-4') is exposed as a static method so the
 *     registry/router can ask "who's the real owner?" without re-parsing.
 *
 *   - This adapter is the ONLY place in the codebase where a single
 *     adapter instance legitimately represents N upstream families; the
 *     anti-hardcode guard's disjointness rule is satisfied because the
 *     Vercel entry has no aliases conflicting with per-family switch cases.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

/** Parsed shape of a namespaced Vercel AI Gateway model id. */
export interface VercelGatewayModelId {
  /** The upstream family: 'openai', 'anthropic', 'google', 'xai', 'meta', etc. */
  readonly family: string;
  /** The model id as the upstream would see it (no family prefix). */
  readonly model: string;
  /** The raw namespaced id as Vercel serves it. */
  readonly raw: string;
}

export class VercelAIGatewayAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'vercel-ai-gateway',
      displayName: config.displayName || 'Vercel AI Gateway',
    });
  }

  /**
   * Parse `provider/model` into its parts. Returns undefined when the id
   * is not namespaced — some Vercel gateway configs expose bare model ids
   * when the account has a single upstream pinned.
   *
   * No allocation for the hot path — returns undefined rather than an empty
   * object so the caller can fast-fail the family lookup.
   */
  static parseModelId(raw: string): VercelGatewayModelId | undefined {
    if (!raw || typeof raw !== 'string') return undefined;
    const idx = raw.indexOf('/');
    if (idx <= 0 || idx === raw.length - 1) return undefined;
    const family = raw.slice(0, idx).toLowerCase();
    const model = raw.slice(idx + 1);
    return { family, model, raw };
  }

  /**
   * Read the documented upstream attribution from a `/v1/models` entry.
   * Used by the capability merger when it's processing a Vercel discovery
   * payload — the `owned_by` field is the most authoritative "who actually
   * runs this?" signal available.
   */
  static attributeFromDiscovery(entry: {
    id: string;
    owned_by?: string;
  }): VercelGatewayModelId | undefined {
    // Prefer the explicit `owned_by` when present. Fall back to namespace
    // parsing if the gateway returned the owned_by field empty.
    if (typeof entry.owned_by === 'string' && entry.owned_by.length > 0) {
      const parsed = VercelAIGatewayAdapter.parseModelId(entry.id);
      return parsed
        ? { ...parsed, family: entry.owned_by.toLowerCase() }
        : { family: entry.owned_by.toLowerCase(), model: entry.id, raw: entry.id };
    }
    return VercelAIGatewayAdapter.parseModelId(entry.id);
  }
}
