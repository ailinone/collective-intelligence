// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HuggingFace Hub Model Fetcher
 *
 * Discovers the inference-routable subset of the HuggingFace Hub
 * (https://huggingface.co/models?inference_provider=all) by paginating
 * https://huggingface.co/api/models with cursor-based Link headers.
 *
 * Why this exists alongside the catalog-bridge huggingface source:
 * - The bridge hits https://router.huggingface.co/v1/models, the OpenAI-compatible
 *   router, which exposes only the subset of models with at least one configured
 *   inference provider behind the router (~hundreds, not tens of thousands).
 * - The Hub API exposes the full inference-enabled surface (~58k at time of
 *   writing), giving downstream selection layers a much larger candidate pool.
 *
 * Pricing is intentionally 0 with metadata.pricingSource = 'unknown' because the
 * Hub does not surface pricing; cost-aware components should treat these rows as
 * pricing-unknown rather than free.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface HfHubModel {
  _id: string;
  id: string;
  modelId?: string;
  likes?: number;
  trendingScore?: number;
  private?: boolean;
  downloads?: number;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  createdAt?: string;
  inferenceProviderMapping?: HfInferenceProviderMapping[];
}

/** Per-provider serving info from the HF API when ?expand[]=inferenceProviderMapping
 *  is requested. status:'live' = the provider is actually serving the model right
 *  now (HF's own prove-before-advertise signal), callable via the HF router
 *  `router.huggingface.co/v1` as `<id>:<provider>`. */
interface HfInferenceProviderMapping {
  provider: string;
  providerId: string;
  status?: string;
  task?: string;
  providerDetails?: {
    context_length?: number;
    pricing?: { input?: number; output?: number };
  };
  performance?: { tokensPerSecond?: number; firstTokenLatencyMs?: number };
}

const PIPELINE_TAG_TO_CAPABILITIES: Record<string, ModelCapability[]> = {
  'text-generation': ['chat', 'completions'],
  'text2text-generation': ['chat', 'completions'],
  'conversational': ['chat'],
  'question-answering': ['chat'],
  'summarization': ['chat'],
  'translation': ['chat'],
  'fill-mask': ['completions'],
  'feature-extraction': ['embedding'],
  'sentence-similarity': ['embedding'],
  'text-to-image': ['image_generation'],
  'image-to-image': ['image_generation'],
  'text-to-video': ['video_generation'],
  'text-to-speech': ['text_to_speech'],
  'automatic-speech-recognition': ['speech_to_text', 'transcription'],
  'audio-classification': ['speech_to_text'],
  'image-classification': ['vision'],
  'object-detection': ['vision'],
  'image-segmentation': ['vision'],
  'image-to-text': ['vision'],
  'visual-question-answering': ['vision', 'chat'],
  'image-text-to-text': ['chat', 'vision'],
  'image-to-video': ['video_generation'],
};

export class HfHubModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'huggingface';
  private token: string | undefined;
  private baseUrl: string;
  private maxModels: number;
  private pageSize: number;
  private requestTimeoutMs: number;
  private log = logger.child({ component: 'hf-hub-fetcher' });

  constructor(
    token?: string,
    baseUrl = 'https://huggingface.co/api/models',
    maxModels = Number(process.env.HF_HUB_DISCOVERY_MAX_MODELS || '60000'),
    pageSize = Number(process.env.HF_HUB_DISCOVERY_PAGE_SIZE || '1000'),
    requestTimeoutMs = Number(process.env.HF_HUB_DISCOVERY_TIMEOUT_MS || '15000'),
  ) {
    super();
    this.token = token && token.length > 0 ? token : undefined;
    this.baseUrl = baseUrl;
    this.maxModels = maxModels;
    this.pageSize = pageSize;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getModels(): Promise<ProviderModel[]> {
    const start = Date.now();
    const out: ProviderModel[] = [];
    // expand[]=inferenceProviderMapping returns, per model, WHICH providers serve
    // it + their status (live/staging) + pricing + context + perf. This is HF's
    // own proof-of-operability: we mark serverless_callable from status:'live'
    // (prove-before-advertise) instead of assuming, and capture real pricing.
    //
    // CRITICAL (2026-06-29): the HF list API switches to a RESTRICTED projection
    // (id + only the expanded fields) as soon as ANY expand[] is present — so
    // downloads/likes/trendingScore came back `undefined` for ~95% of models
    // (measured: only 3,097/63,572 populated). These are the ONLY dynamic
    // legitimacy signal that lets the selector's cold-start prior tell a 2M-download
    // model from a 0-download fine-tune (no static model pin). They MUST be
    // expanded explicitly here, or the popularity prior has no data to rank on.
    let nextUrl: string | null =
      `${this.baseUrl}?inference_provider=all` +
      `&expand[]=inferenceProviderMapping&expand[]=downloads&expand[]=likes&expand[]=trendingScore` +
      `&limit=${this.pageSize}`;
    let pages = 0;

    try {
      while (nextUrl && out.length < this.maxModels) {
        const response = await fetch(nextUrl, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

        if (!response.ok) {
          this.log.warn(
            { status: response.status, url: nextUrl, page: pages },
            'HF Hub API non-OK response, stopping pagination',
          );
          break;
        }

        const page = (await response.json()) as HfHubModel[];
        if (!Array.isArray(page) || page.length === 0) break;

        for (const m of page) {
          if (out.length >= this.maxModels) break;
          if (m.private) continue;
          out.push(this.transform(m));
        }

        pages++;
        nextUrl = this.parseNextLink(response.headers.get('link'));
      }

      this.log.info(
        { models: out.length, pages, durationMs: Date.now() - start, capped: out.length >= this.maxModels },
        'HF Hub discovery completed',
      );
      return out;
    } catch (error) {
      this.log.error({ error, pages, partial: out.length }, 'HF Hub discovery failed');
      return out;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'ailin-ci/discovery (huggingface-hub)',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  private transform(model: HfHubModel): ProviderModel {
    const capabilities = this.mapCapabilities(model);

    // Derive operability + pricing + context from HF's inferenceProviderMapping.
    // status:'live' providers prove the model is callable NOW via the HF router
    // (`<id>:<provider>`). No live provider ⇒ not serverless_callable, so it stays
    // out of the hot path (prove-before-advertise — no static assumption).
    const mapping = Array.isArray(model.inferenceProviderMapping) ? model.inferenceProviderMapping : [];
    const liveProviders = mapping.filter((p) => p.status === 'live');
    const serverlessCallable = liveProviders.length > 0;
    // Best live provider = lowest input price (cost-aware), else first.
    const bestProvider = liveProviders
      .slice()
      .sort((a, b) =>
        (a.providerDetails?.pricing?.input ?? Number.POSITIVE_INFINITY) -
        (b.providerDetails?.pricing?.input ?? Number.POSITIVE_INFINITY))[0];
    const contextLength = liveProviders.reduce((mx, p) => Math.max(mx, p.providerDetails?.context_length ?? 0), 0);
    const inputPrice = bestProvider?.providerDetails?.pricing?.input;
    const outputPrice = bestProvider?.providerDetails?.pricing?.output;
    const hasPricing = typeof inputPrice === 'number' || typeof outputPrice === 'number';

    const metadata: Record<string, unknown> = {
      pipeline_tag: model.pipeline_tag,
      library_name: model.library_name,
      tags: model.tags,
      downloads: model.downloads,
      likes: model.likes,
      trendingScore: model.trendingScore,
      createdAt: model.createdAt,
      // HF integration / Camada 4: proven operability from HF's own live status,
      // the served-provider list (for `<id>:<provider>` routing), and real pricing.
      serverless_callable: serverlessCallable,
      inferenceProviders: liveProviders.map((p) => ({
        provider: p.provider,
        providerId: p.providerId,
        status: p.status,
        task: p.task,
        tokensPerSecond: p.performance?.tokensPerSecond,
      })),
      pricingSource: hasPricing ? 'hf_inference_providers' : 'unknown',
      priceConfidence: hasPricing ? 'high' : 'low',
      hubInventoryClass: 'aggregated_index',
    };

    return {
      id: model.id,
      name: model.id,
      displayName: model.id,
      contextWindow: contextLength,
      maxOutputTokens: 0,
      capabilities,
      pricing: {
        inputCostPer1M: typeof inputPrice === 'number' ? inputPrice : 0,
        outputCostPer1M: typeof outputPrice === 'number' ? outputPrice : 0,
        currency: 'USD',
      },
      metadata,
    };
  }

  private mapCapabilities(model: HfHubModel): ModelCapability[] {
    // 1. Prefer the LIVE inference provider's `task` — what is ACTUALLY being served
    //    right now. Critical because ~60k/62k HF rows have NO pipeline_tag (and no
    //    tags in the list response), but the provider mapping always carries the
    //    real task (conversational, text-to-image, automatic-speech-recognition, …).
    //    The old `return ['chat']` default mislabeled all ~60k of them as chat.
    const mapping = Array.isArray(model.inferenceProviderMapping) ? model.inferenceProviderMapping : [];
    const caps = new Set<ModelCapability>();
    for (const p of mapping) {
      if (p.status !== 'live' || !p.task) continue;
      for (const c of PIPELINE_TAG_TO_CAPABILITIES[p.task] ?? []) caps.add(c);
    }
    if (caps.size > 0) return [...caps];

    // 2. Fall back to the model's own pipeline_tag when present.
    const tag = model.pipeline_tag;
    if (tag && PIPELINE_TAG_TO_CAPABILITIES[tag]) {
      return PIPELINE_TAG_TO_CAPABILITIES[tag];
    }

    // 3. Genuinely unknown task — do NOT assume chat. Empty so the row only ever
    //    joins the pool whose capability is actually known/served.
    return [];
  }
}
