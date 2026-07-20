// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Gemini OpenAI-Compatible Adapter — Google AI Studio's OAI-shim layer.
 *
 * Google ships a **drop-in OpenAI-compatible endpoint** for its Gemini
 * models at:
 *
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 *
 * This is distinct from the native `GoogleAdapter` (which uses the
 * `@google/generative-ai` SDK and its bespoke wire protocol:
 * `/v1beta/models/{m}:generateContent`, `contents[].parts[]`, inline base64,
 * etc.). The OAI-compat layer is what third-party routers (LiteLLM,
 * OpenRouter, Vercel AI SDK) actually target when they say "use Gemini" —
 * it accepts standard `/chat/completions` shape and converts internally.
 *
 * ### Why BOTH — native and OAI-compat?
 *
 * 1. The native SDK unlocks features the OAI shim doesn't expose: long-
 *    running video generation, file upload API, grounded search with
 *    `googleSearch` tool, vision with structured safetySettings.
 * 2. The OAI shim gets used for simple chat/embedding traffic where we want
 *    a uniform wire contract across providers (easier to reason about in
 *    retries, circuit breakers, and rate-limit adapters).
 *
 * Registered as `providerName: 'gemini-openai'` to keep telemetry scopes
 * separate from the native `providerName: 'google'`. Operators who want
 * vision/video use the native adapter; routers that want vanilla chat use
 * this one.
 *
 * ### Auth
 *
 * Standard `Authorization: Bearer {GEMINI_API_KEY}`. The same API key works
 * on both surfaces (native SDK reads it via env, this hub sends it via
 * header).
 *
 * ### Known quirks that DO bleed through the OAI shim
 *
 *  - Model field accepts both `gemini-2.0-flash` and `models/gemini-2.0-flash`.
 *    The hub passes model IDs unchanged; Google accepts either.
 *  - Streaming uses OpenAI-format SSE (`data: {...}`) — no Google-specific
 *    `application/json-seq` negotiation needed.
 *  - Function calling works but parameter schemas use a stripped-down
 *    subset of OpenAPI — complex `$ref` or `oneOf` schemas will 400.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/openai
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type GeminiOpenAIAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class GeminiOpenAIAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: GeminiOpenAIAdapterConfig) {
    super({
      ...config,
      providerName: 'gemini-openai',
      displayName: config.displayName || 'Google AI Studio (Gemini OAI)',
      baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
      metadata: {
        // Standard OpenAI Authorization header; Google accepts the API key
        // as a Bearer token on the OAI shim (same key that works for
        // ?key=... on the native surface).
        authHeaderName: 'Authorization',
        authScheme: 'Bearer',
        ...config.metadata,
      },
    });
  }
}
