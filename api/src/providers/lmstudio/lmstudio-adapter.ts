// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LM Studio Adapter — local OpenAI-compatible server bundled with the LM Studio
 * desktop app.
 *
 * LM Studio exposes `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`
 * on `http://localhost:1234/v1` by default. Differences vs. OpenAI:
 *
 *   1. **No auth at all** — LM Studio runs on the user's laptop; it trusts
 *      the loopback interface. Sending any `Authorization` header is a
 *      no-op but some users configure a placeholder key to make other SDKs
 *      happy. We honor whatever's in config.
 *   2. **One model at a time.** LM Studio loads one GGUF into RAM; the
 *      model list reflects what's currently loaded, not the library.
 *   3. **No `/chat/completions` streaming on some old builds** — the hub's
 *      SSE handling already tolerates half-implemented servers.
 *
 * This adapter is intentionally thin. It exists for consistency with vLLM /
 * Xinference / other self-hosted servers — so the catalog resolution tree
 * always finds a dedicated class, and future LM Studio quirks have a home.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export type LmStudioAdapterConfig = OpenAICompatibleHubAdapterConfig;

export class LmStudioAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: LmStudioAdapterConfig) {
    super({
      ...config,
      providerName: 'lm-studio',
      displayName: config.displayName || 'LM Studio',
      metadata: {
        apiKeyOptional: true,
        ...config.metadata,
      },
    });
  }
}
