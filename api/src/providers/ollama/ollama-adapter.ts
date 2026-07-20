// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ollama Adapter — self-hosted model runner (local-first).
 *
 * Ollama (https://ollama.com) exposes two surfaces on the same server:
 *
 *   1. **OpenAI-compatible** at `http://host:11434/v1/...` — standard
 *      `/chat/completions`, `/embeddings`, `/models`. This is the path the
 *      hub drives for all current traffic, and the one that matters for
 *      ordinary LLM calls.
 *
 *   2. **Native Ollama** at `http://host:11434/api/...` — `/api/tags` for
 *      richer model listings (includes disk size, digest, parameters),
 *      `/api/generate` for raw non-chat completion, `/api/pull` for
 *      on-demand model download, `/api/show` for config introspection.
 *
 * This adapter is currently a thin wrapper over the hub (like vLLM) — it
 * exists so logs, metrics, and circuit-breaker scopes get a crisp
 * `provider: ollama` identifier, and so future native-endpoint coverage
 * (e.g. admin `/api/pull` for CI warm-starts) has a subclass seat.
 *
 * ### Why not wait for demand before class-ifying
 *
 * The catalog-hub path works today. BUT every legacy `case 'ollama'` in
 * provider-registry.ts and every future Ollama-specific routing decision
 * needs a named class to hang logic on. Introducing it now (empty subclass,
 * zero behavior change) means tomorrow's Ollama-native feature lands as a
 * method addition instead of a cross-cutting migration.
 *
 * ### Auth
 *
 * Ollama's OAI-compat endpoint ignores any `Authorization` header. Some
 * operators put it behind a reverse-proxy with Bearer auth; we set
 * `apiKeyOptional: true` so an empty key doesn't error, but we still emit
 * the header if one is present (doesn't hurt Ollama, works for the proxy).
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type OllamaAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class OllamaAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OllamaAdapterConfig) {
    super({
      ...config,
      providerName: 'ollama',
      displayName: config.displayName || 'Ollama',
      metadata: {
        // Auth is optional — Ollama ignores Authorization on its OAI-compat
        // endpoint. Reverse-proxy deployments can set OLLAMA_API_KEY and
        // we'll emit Bearer (ignored by Ollama itself but used by the proxy).
        apiKeyOptional: true,
        ...config.metadata,
      },
    });
  }
}
