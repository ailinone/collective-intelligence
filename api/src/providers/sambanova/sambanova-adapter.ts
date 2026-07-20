// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SambaNova Adapter — OpenAI-compatible, RDU inference.
 *
 * SambaNova Cloud speaks the standard OpenAI wire protocol for chat,
 * embeddings, tools, and JSON mode. The value a dedicated class adds is:
 *
 *   - Honoring SambaNova's documented model-family tier hints (Llama-70B
 *     vs Llama-405B have very different latency profiles).
 *   - Explicit model-name normalization to the canonical SambaNova names
 *     (`Meta-Llama-3.3-70B-Instruct`), case-sensitive per docs.
 *   - Preventing fallthrough to the hub's generic displayName, which would
 *     log "Generic OAI-compat" in observability instead of "SambaNova".
 *
 * Source: https://docs.sambanova.ai/cloud/docs/capabilities/function-calling
 *
 * There is no SambaNova-specific request/response quirk beyond this today.
 * If that changes (rate-limit header exposure, speculative-decoding flags),
 * this is the file to extend.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';

export class SambanovaAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'sambanova',
      displayName: config.displayName || 'SambaNova Cloud',
    });
  }

  /**
   * Known fast-tier models per SambaNova docs. Exposed statically so the
   * capability merger can hint `low_latency: confidence 0.85` for these
   * specifically, rather than the whole family.
   */
  static readonly FAST_TIER_MODELS = [
    'Meta-Llama-3.1-8B-Instruct',
    'Meta-Llama-3.2-1B-Instruct',
    'Meta-Llama-3.2-3B-Instruct',
  ] as const;

  static isFastTier(modelId: string): boolean {
    return (SambanovaAdapter.FAST_TIER_MODELS as readonly string[]).includes(modelId);
  }
}
