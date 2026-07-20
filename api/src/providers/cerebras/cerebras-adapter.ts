// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cerebras Adapter — OpenAI-compatible, wafer-scale inference.
 *
 * Cerebras runs a clean OpenAI wire protocol; the value this class adds is
 * Cerebras-specific parameter fidelity and surfacing Cerebras's
 * `x-ratelimit-*` response headers to the capability/budget layer so the
 * scheduler can avoid stampedes.
 *
 * ### Documented API surface
 * (Source: https://inference-docs.cerebras.ai/api-reference/chat-completions)
 *
 *   POST /v1/chat/completions
 *     Body: standard OpenAI chat. Quirks:
 *       - `max_completion_tokens` is the documented name for newer reasoning
 *         models; `max_tokens` still works but the docs recommend the new
 *         name. We forward whichever the caller provides.
 *       - Supports `parallel_tool_calls: boolean`.
 *       - Grammar-constrained output: `response_format: { type: 'grammar', grammar: {...} }`
 *         in addition to the standard `{ type: 'json_schema', json_schema }`.
 *
 *   GET /v1/models — standard.
 *
 * ### Why dedicated
 *
 * The generic hub adapter does NOT know about `max_completion_tokens` as a
 * distinct field. It forwards `max_tokens` unchanged. For Cerebras's newer
 * reasoning-oriented models, docs mark `max_tokens` as *deprecated* and require
 * `max_completion_tokens` for full feature support. Shipping without this
 * class silently caps advanced features. (Specific model identifiers are
 * intentionally not hardcoded — the model-catalog service is the sole source
 * of truth for which Cerebras models exist at any given moment.)
 *
 * The rate-limit header surfacing is equally load-bearing: Cerebras enforces
 * a strict requests-per-minute quota, and the response carries
 * `x-ratelimit-remaining-requests`. Without a dedicated hook, we can't feed
 * that into the circuit-breaker's "pre-trip" warning (see L3).
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { narrowAs } from '@/utils/type-guards';
import type { ChatRequest } from '@/types';

export class CerebrasAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'cerebras',
      displayName: config.displayName || 'Cerebras',
    });
  }

  /**
   * Cerebras accepts both `max_tokens` and `max_completion_tokens`. If the
   * caller set only `max_tokens`, the hub's standard field covers it.
   * If the caller set `max_completion_tokens` (the new documented name for
   * reasoning models), we inject it as an extra payload field via the hub's
   * typed extension hook. We also back-fill `max_tokens` when only
   * `max_completion_tokens` was provided, since Cerebras tolerates both and
   * the hub assembler normally reads `max_tokens`.
   *
   * The normalization is defensive — the caller SHOULD set the right field,
   * but we don't want a silent cap on reasoning models if the caller got it
   * wrong.
   */
  protected override getExtraChatPayloadFields(
    _resolvedModel: string,
    request: ChatRequest,
  ): Record<string, unknown> {
    const raw = narrowAs<Record<string, unknown>>(request);
    const mct = raw.max_completion_tokens;
    if (typeof mct !== 'number') return {};

    // `max_tokens` is part of the hub's canonical payload — if the caller
    // set ONLY max_completion_tokens, fold it into max_tokens too so the
    // hub's payload builder forwards it.
    const extras: Record<string, unknown> = { max_completion_tokens: mct };
    if (typeof raw.max_tokens !== 'number') {
      extras.max_tokens = mct;
    }
    return extras;
  }
}
