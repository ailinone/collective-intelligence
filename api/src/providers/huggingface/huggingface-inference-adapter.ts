// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HuggingFace Inference Providers Adapter
 *
 * HF's "Inference Providers" router (https://router.huggingface.co/v1) is a
 * unified OAI-compatible endpoint that fans out to partner inference backends
 * (TogetherAI, Fireworks, SambaNova, Replicate, Nebius, Cerebras, etc.) on
 * behalf of a single HF_TOKEN. The value prop is billing convergence: one
 * credit pool bills across heterogeneous providers, letting us A/B providers
 * from the same issuer without rotating keys or juggling pools.
 *
 * ### Why a dedicated adapter (and not just a hub catalog row)
 *
 *   1. **Benchmark caching is a correctness bug.** HF's router returns cached
 *      responses by default when the same request body is submitted twice
 *      within a short window. For production traffic this is a feature; for
 *      SOTA benchmark runs it destroys latency measurements and creates the
 *      illusion of massive TTFT improvements. We hard-disable caching by
 *      injecting `x-use-cache: false` on every request.
 *
 *   2. **Routing hints.** HF exposes a per-request `x-hf-provider` header that
 *      pins the downstream backend (e.g. `together`, `fireworks`) instead of
 *      letting the router pick. Future RW support for this lives on this
 *      class, not on the generic hub.
 *
 *   3. **Per-backend error passthrough.** Errors from downstream providers
 *      come wrapped in an HF envelope. When we surface them in operator logs
 *      we want a recognizable `provider: huggingface-inference` tag plus the
 *      underlying vendor name in the same record — again, class-scoped.
 *
 * Docs: https://huggingface.co/docs/inference-providers/index
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import type { ChatRequest, ChatResponse } from '@/types';
import { logger } from '@/utils/logger';

export type HuggingFaceInferenceAdapterConfig = OpenAICompatibleHubAdapterConfig;

/**
 * Header injected on every HF Inference request to force a fresh evaluation.
 * Exported so tests can assert the exact string literal.
 */
export const HF_NO_CACHE_HEADER = { 'x-use-cache': 'false' } as const;

export class HuggingFaceInferenceAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: HuggingFaceInferenceAdapterConfig) {
    const callerExtraHeaders = config.metadata?.extraHeaders ?? {};
    super({
      ...config,
      providerName: 'huggingface',
      displayName: config.displayName || 'Hugging Face Inference',
      metadata: {
        ...config.metadata,
        // Merge order matters: caller-supplied headers take priority on a
        // collision, so a test or operator can explicitly re-enable caching
        // by passing `extraHeaders: { 'x-use-cache': 'true' }` if they have
        // a reason to. The default is always no-cache.
        extraHeaders: {
          ...HF_NO_CACHE_HEADER,
          ...callerExtraHeaders,
        },
      },
    });
  }

  private hfLog = logger.child({ component: 'hf-inference-adapter' });

  /**
   * ALWAYS-HOT ROUTING (2026-06-29). HF's router, left to its own devices, may
   * dispatch to a serverless on-demand backend (featherless) that cold-loads the
   * model (30-60s) and makes execution non-deterministic ("sometimes hits on
   * attempt N"). Instead, we PIN the fastest live inference provider from the
   * model's metadata (groq/cerebras/together/… — dedicated, always-hot, ranked by
   * measured tokensPerSecond) by sending `<model>:<provider>` in the OUTBOUND
   * payload. The catalog lookup already resolved this adapter with the bare id
   * upstream, so appending the provider here only steers the HF router — it does
   * NOT affect resolution. Fully dynamic (no static model): the provider is chosen
   * from live, measured per-model data each call. If the model already carries a
   * `:provider`, or has no live providers, we leave it untouched.
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const pinned = await this.pinFastestLiveProvider(request.model);
    return super.chatCompletion(
      pinned && pinned !== request.model ? { ...request, model: pinned } : request,
    );
  }

  private async pinFastestLiveProvider(modelId?: string): Promise<string | undefined> {
    if (!modelId || modelId.length === 0 || modelId.includes(':')) return modelId;
    try {
      const { modelCatalogService } = await import('@/services/model-catalog-service');
      const model = await modelCatalogService.getModel(modelId, 'huggingface');
      const providers = Array.isArray(model?.metadata?.inferenceProviders)
        ? (model.metadata.inferenceProviders as Array<{
            provider?: string;
            status?: string;
            tokensPerSecond?: number;
          }>)
        : [];
      const live = providers.filter((p) => p.status === 'live' && p.provider);
      if (live.length === 0) return modelId;
      // Fastest live backend first (tokensPerSecond is the always-hot proxy:
      // groq/cerebras/sambanova rank far above serverless featherless).
      const best = live
        .slice()
        .sort((a, b) => (b.tokensPerSecond ?? 0) - (a.tokensPerSecond ?? 0))[0];
      if (!best?.provider) return modelId;
      this.hfLog.debug({ modelId, provider: best.provider, tps: best.tokensPerSecond }, 'HF always-hot route pinned');
      return `${modelId}:${best.provider}`;
    } catch (err) {
      this.hfLog.debug({ modelId, err }, 'HF provider pin skipped (non-fatal)');
      return modelId;
    }
  }

  /**
   * Preserve a pinned `:<provider>` suffix across normalization. chatCompletion()
   * appends it for always-hot routing; the base normalizer would try to look the
   * whole `<model>:<provider>` up as a single id (and miss → drop the pin). We
   * normalize the bare model and re-attach the provider so the HF router receives
   * `<model>:<provider>` and dispatches to that backend.
   */
  override async normalizeModelName(modelId: string): Promise<string> {
    if (modelId) {
      const m = modelId.match(/^(.+):([a-z0-9._-]+)$/i);
      // HF model ids are `org/model`; a trailing `:token` is the provider we pinned.
      if (m && m[1].includes('/')) {
        const normalizedBase = await super.normalizeModelName(m[1]);
        return `${normalizedBase}:${m[2]}`;
      }
    }
    return super.normalizeModelName(modelId);
  }
}
