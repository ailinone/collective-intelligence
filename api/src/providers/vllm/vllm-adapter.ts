// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * vLLM Adapter — self-hosted OpenAI-compatible server.
 *
 * vLLM (https://github.com/vllm-project/vllm) exposes a 100% OpenAI-compatible
 * surface at `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`,
 * `/v1/models`. The only quirks vs. OpenAI are operational:
 *
 *   1. **Auth is optional.** vLLM runs unauthenticated by default. If the
 *      operator sets `--api-key <key>` at launch, the server requires
 *      `Authorization: Bearer <key>`; otherwise ANY Authorization header
 *      works (vLLM ignores it).
 *   2. **No `/models` rate limits**, but calling it frequently on a busy
 *      inference node steals GPU cycles — we rely on the hub's built-in
 *      model-list caching.
 *   3. **Per-deployment model catalog.** The operator loads ONE model per
 *      vLLM process; discovery tells you what's there.
 *
 * ### Why a dedicated adapter and not bare hub
 *
 * The hub already handles vLLM correctly with `apiKeyOptional: true` in the
 * catalog row. This wrapper exists to:
 *   - Give vLLM a crisp named identity in logs / metrics (`provider: vllm`)
 *   - Make the intent explicit: "self-hosted, don't call it if baseUrl
 *     hasn't been overridden from localhost:8000"
 *   - Future-proof: vLLM occasionally adds non-OAI extensions (e.g.
 *     `/v1/generate` for raw completions, LoRA adapter swap at request
 *     time). Those ride on this class cleanly.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type VllmAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class VllmAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: VllmAdapterConfig) {
    super({
      ...config,
      providerName: 'vllm',
      displayName: config.displayName || 'vLLM',
      metadata: {
        // Auth is optional by default. If `apiKey` is empty we still need
        // SOME value so `buildRequestHeaders` doesn't emit `Authorization: Bearer`.
        // The hub's own `apiKeyOptional` path handles this.
        apiKeyOptional: true,
        ...config.metadata,
      },
    });
  }
}
