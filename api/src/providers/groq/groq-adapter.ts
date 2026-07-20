// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Groq Adapter — OpenAI-compatible surface with Groq-specific reasoning params.
 *
 * Groq runs the OpenAI chat/embeddings wire protocol faithfully, which is
 * why this extends the hub adapter instead of rewriting the HTTP stack. The
 * value a dedicated class adds is Groq-specific **reasoning-model knobs**
 * that the generic OAI shape doesn't know about:
 *
 *   - `reasoning_format`: 'parsed' | 'raw' | 'hidden'
 *     Controls how reasoning traces appear in the response.
 *       - parsed  → `message.reasoning` field on the choice, content is final answer only
 *       - raw     → reasoning inlined in `message.content` with <think> tags
 *       - hidden  → reasoning fully suppressed
 *
 *   - `reasoning_effort`: 'low' | 'medium' | 'high' | 'default'
 *     Latency/quality tradeoff for gpt-oss-* / deepseek-r1-*.
 *
 *   - Service-tier param (`service_tier`) — flex routing for speed.
 *
 * Source: https://console.groq.com/docs/reasoning
 *
 * Non-reasoning models ignore these params silently; that's the documented
 * Groq behavior, so we pass them through unconditionally when the caller sets
 * them on ChatRequest.options. The model list side (`/models`) is standard.
 *
 * ### Why this is NOT cosmetic
 *
 * Without this adapter:
 *   - Callers can't enable reasoning-parsed mode → reasoning traces get mixed
 *     into final answer content, breaking downstream parsers.
 *   - Callers can't lower reasoning_effort → every reasoning-model call pays
 *     peak latency even when low would do.
 *   - The capability merger has no way to know which Groq models expose
 *     reasoning at all.
 *
 * This class surfaces all three through typed request extensions.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { narrowAs } from '@/utils/type-guards';
import type { ChatRequest } from '@/types';

/**
 * Groq-specific request extension. Callers pass these through the standard
 * ChatRequest.options bag; this adapter promotes them to top-level body
 * fields before forwarding to the hub layer.
 */
export interface GroqReasoningOptions {
  reasoning_format?: 'parsed' | 'raw' | 'hidden';
  reasoning_effort?: 'low' | 'medium' | 'high' | 'default';
  service_tier?: 'on_demand' | 'flex' | 'auto';
}

/** Model-id prefixes that the Groq docs declare as reasoning-capable. */
const REASONING_MODEL_PATTERNS = [
  /^openai\/gpt-oss/i,
  /^deepseek-r1/i,
  /^qwen(-|\/)qwq/i,
  /^groq\/compound-beta/i,
] as const;

export class GroqAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'groq',
      displayName: config.displayName || 'Groq',
    });
  }

  /**
   * Public: is this model documented as supporting Groq's reasoning knobs?
   * Used by the capability merger to decide whether to surface
   * `reasoning` as a capability for this model.
   */
  static isReasoningModel(modelId: string): boolean {
    return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
  }

  /**
   * Inject Groq-specific reasoning/tier knobs into the outgoing payload via
   * the hub's extension hook. The hook runs for both non-streaming and
   * streaming paths, so this single override covers both.
   *
   * Returning `{}` (no extras present on the request) is the safe no-op —
   * non-reasoning models simply won't see the fields.
   */
  protected override getExtraChatPayloadFields(
    _resolvedModel: string,
    request: ChatRequest,
  ): Record<string, unknown> {
    const groqOpts = this.extractReasoningOptions(request);
    return groqOpts ? { ...groqOpts } : {};
  }

  /**
   * Pull Groq-specific fields off the caller's `options` bag. Only declared
   * keys are copied to prevent arbitrary option leakage into the upstream
   * payload.
   */
  private extractReasoningOptions(
    request: ChatRequest,
  ): Partial<GroqReasoningOptions> | undefined {
    const opts = (narrowAs<{ options?: Record<string, unknown> }>(request)).options;
    if (!opts || typeof opts !== 'object') {
      // Also accept flattened top-level fields — some callers set them
      // directly on the request. Groq's API accepts either.
      const flat: Partial<GroqReasoningOptions> = {};
      const raw = narrowAs<Record<string, unknown>>(request);
      if (isReasoningFormat(raw.reasoning_format)) flat.reasoning_format = raw.reasoning_format;
      if (isReasoningEffort(raw.reasoning_effort)) flat.reasoning_effort = raw.reasoning_effort;
      if (isServiceTier(raw.service_tier)) flat.service_tier = raw.service_tier;
      return Object.keys(flat).length > 0 ? flat : undefined;
    }
    const picked: Partial<GroqReasoningOptions> = {};
    if (isReasoningFormat(opts.reasoning_format)) picked.reasoning_format = opts.reasoning_format;
    if (isReasoningEffort(opts.reasoning_effort)) picked.reasoning_effort = opts.reasoning_effort;
    if (isServiceTier(opts.service_tier)) picked.service_tier = opts.service_tier;
    return Object.keys(picked).length > 0 ? picked : undefined;
  }
}

// Narrow type guards — keep the cast-layer local, make the call sites read clean.
function isReasoningFormat(v: unknown): v is GroqReasoningOptions['reasoning_format'] {
  return v === 'parsed' || v === 'raw' || v === 'hidden';
}
function isReasoningEffort(v: unknown): v is GroqReasoningOptions['reasoning_effort'] {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'default';
}
function isServiceTier(v: unknown): v is GroqReasoningOptions['service_tier'] {
  return v === 'on_demand' || v === 'flex' || v === 'auto';
}
