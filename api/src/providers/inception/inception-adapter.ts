// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Inception Labs Adapter — Mercury diffusion LLM (dLLM) quirks.
 *
 * Mercury is NOT autoregressive — text is denoised iteratively rather than
 * generated left-to-right token-by-token. Two concrete consequences for a
 * generic OpenAI-compatible hub client:
 *
 *  1. `diffusing:true` changes the SSE contract: instead of incremental
 *     deltas, each chunk carries the FULL rewritten text at that denoising
 *     step. This hub's streaming parser assumes delta-concatenation
 *     (`OpenAICompatibleHubAdapter.chatCompletionStream`), so we never
 *     forward `diffusing` — if a caller sets it anyway, we drop it and log
 *     rather than silently producing garbled/duplicated streamed text.
 *
 *  2. `temperature` is restricted server-side to [0.5, 1.0]; values outside
 *     that range are silently reset to 0.75 with a `warning` field on the
 *     response. We clamp client-side instead so the behavior is
 *     deterministic and visible in our own logs rather than a silent
 *     server-side surprise.
 *
 * Docs: https://docs.inceptionlabs.ai/get-started/models
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { narrowAs } from '@/utils/type-guards';
import type { ChatRequest } from '@/types';

const MIN_TEMPERATURE = 0.5;
const MAX_TEMPERATURE = 1.0;

export class InceptionAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: OpenAICompatibleHubAdapterConfig) {
    super({
      ...config,
      providerName: 'inception',
      displayName: config.displayName || 'Inception Labs (Mercury)',
    });
  }

  protected override async getTemperatureParamAsync(
    modelId: string,
    temperature?: number,
  ): Promise<Record<string, number | undefined>> {
    const base = await super.getTemperatureParamAsync(modelId, temperature);
    if (typeof base.temperature !== 'number') {
      return base;
    }

    const clamped = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, base.temperature));
    if (clamped !== base.temperature) {
      this.providerLog.warn(
        { modelId, requested: base.temperature, clamped },
        'Inception Mercury only accepts temperature in [0.5, 1.0]; clamping client-side instead of letting the server silently reset it to 0.75',
      );
    }
    return { temperature: clamped };
  }

  protected override getExtraChatPayloadFields(
    _resolvedModel: string,
    request: ChatRequest,
  ): Record<string, unknown> {
    const opts = narrowAs<{ options?: Record<string, unknown> }>(request).options;
    if (opts?.diffusing === true) {
      this.providerLog.warn(
        "diffusing:true requested for Inception Mercury but intentionally not forwarded — that mode rewrites the full text per SSE chunk instead of streaming deltas, which is incompatible with this hub adapter's delta-concatenation parser.",
      );
    }
    return {};
  }
}
