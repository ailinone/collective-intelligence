// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Video Orchestration Service
 * Orchestrates video generation/editing across providers with dynamic capability routing.
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import { normalizeStrategy, resolveFallbackDeadlineMs, diversifyProviders } from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { isAdapterMethodImplemented } from '@/providers/provider-operability';
import { ProviderAdapter } from '@/providers/base/provider-adapter';
import { OpenAICompatibleHubAdapter } from '@/providers/openai-compatible-hub/openai-compatible-hub-adapter';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import type { ProviderCatalogEntry } from '@/providers/catalog/provider-catalog.types';

const log = logger.child({ service: 'video-orchestration' });

export interface VideoGenerationOptions {
  prompt: string;
  model?: string;
  image?: string;
  startImage?: string;
  endImage?: string;
  audio?: string;
  video?: string;
  duration?: number;
  aspectRatio?: string;
  size?: string;
  n?: number;
  responseFormat?: 'url' | 'b64_json';
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface VideoResult {
  videos: Array<{
    id?: string;
    url?: string;
    b64_json?: string;
  }>;
  modelUsed: string;
  provider: string;
  durationMs: number;
  strategyUsed?: string;
  fallbackUsed?: boolean;
  // DUP #2 phase 2c: now the primitive's CandidateAttempt[] (internal-only —
  // not exposed by the /v1/videos route; the chat-request consumer reads only
  // `.model`, which CandidateAttempt has).
  attempts?: CandidateAttempt[];
}

export class VideoOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
  }

  private getModelAverageCostPer1k(model: Model): number {
    const input = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
    const output = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : input;
    return (Math.max(0, input) + Math.max(0, output)) / 2;
  }

  private getModelQuality(model: Model): number {
    if (typeof model.performance?.quality === 'number' && Number.isFinite(model.performance.quality)) {
      return model.performance.quality;
    }
    return 0.5;
  }

  private getModelLatencyMs(model: Model): number {
    if (typeof model.performance?.latencyMs === 'number' && Number.isFinite(model.performance.latencyMs)) {
      return model.performance.latencyMs;
    }
    return 3000;
  }

  private sortModelsByStrategy(
    models: Model[],
    strategy: 'single' | 'cost' | 'speed' | 'quality' | 'balanced' | 'parallel' | 'debate' | 'quality_multipass' | 'dynamic',
    userContext: OrchestrationContext
  ): Model[] {
    const sorted = [...models];
    sorted.sort((a, b) => {
      const costA = this.getModelAverageCostPer1k(a);
      const costB = this.getModelAverageCostPer1k(b);
      const qualityA = this.getModelQuality(a);
      const qualityB = this.getModelQuality(b);
      const latencyA = this.getModelLatencyMs(a);
      const latencyB = this.getModelLatencyMs(b);

      if (strategy === 'cost') {
        if (costA !== costB) return costA - costB;
        return qualityB - qualityA;
      }
      if (strategy === 'speed') {
        if (latencyA !== latencyB) return latencyA - latencyB;
        return costA - costB;
      }
      if (strategy === 'quality' || strategy === 'quality_multipass' || strategy === 'debate') {
        if (qualityA !== qualityB) return qualityB - qualityA;
        if (latencyA !== latencyB) return latencyA - latencyB;
        return costA - costB;
      }

      const qualityWeight = userContext.qualityTarget && userContext.qualityTarget > 0.7 ? 0.6 : 0.45;
      const costWeight = userContext.maxCost !== undefined ? 0.45 : 0.3;
      const latencyWeight = 1 - qualityWeight - costWeight;
      const scoreA =
        qualityA * qualityWeight -
        Math.log10(Math.max(1, costA + 1)) * costWeight -
        Math.log10(Math.max(1, latencyA)) * latencyWeight;
      const scoreB =
        qualityB * qualityWeight -
        Math.log10(Math.max(1, costB + 1)) * costWeight -
        Math.log10(Math.max(1, latencyB)) * latencyWeight;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return costA - costB;
    });

    return sorted;
  }


  private determineRequiredCapability(options: VideoGenerationOptions): ModelCapability {
    if (options.video) {
      return 'video_to_video';
    }
    if (options.image || options.startImage || options.endImage) {
      return 'image_to_video';
    }
    return 'video_generation';
  }

  private hasVideoCapability(model: Model, capability: ModelCapability): boolean {
    if (model.capabilities.includes(capability)) return true;
    if (capability !== 'video_generation' && model.capabilities.includes('video_generation')) return true;
    return false;
  }

  /**
   * Catalog entries by providerId — data lookup for the declared-surface gate
   * below. Built lazily once; the catalog is a static import (data, not
   * behavior), so no invalidation is needed within a process lifetime.
   */
  private catalogByProviderId: Map<string, ProviderCatalogEntry> | null = null;

  private getCatalogEntry(providerId: string | undefined): ProviderCatalogEntry | undefined {
    if (!providerId) return undefined;
    if (!this.catalogByProviderId) {
      this.catalogByProviderId = new Map(PROVIDER_CATALOG.map((e) => [e.providerId, e]));
    }
    const exact = this.catalogByProviderId.get(providerId);
    if (exact) return exact;
    // Multi-deployment providers run under derived ids (`azure-openai-<alias>`,
    // `databricks-<alias>`) — resolve to the catalog entry whose providerId is
    // the longest prefix of the runtime id followed by '-'.
    let best: ProviderCatalogEntry | undefined;
    for (const [id, entry] of this.catalogByProviderId) {
      if (providerId.startsWith(`${id}-`) && (!best || id.length > best.providerId.length)) {
        best = entry;
      }
    }
    return best;
  }

  private getRunnableVideoModels(models: Model[]): Model[] {
    const providerRegistry = this.getRegistry();
    return models.filter((model) => {
      const resolution = providerRegistry.resolveAdapterForModel(model);
      if (!resolution.adapter) return false;
      if (!isAdapterMethodImplemented(resolution.adapter, 'videoGenerate')) return false;

      // Declared-surface gate (audit 2026-07-17): the generic hub adapter
      // overrides videoGenerate for EVERY catalog-backed provider, so the
      // method-override probe above has zero precision for hubs — providers
      // with no video route at all (vercel-ai-gateway, apertis, atlascloud;
      // all 404-proven by live sweep) passed it and burned the whole
      // fallback budget on guaranteed failures. When the implementation that
      // would run is the hub's generic one, require the provider's CATALOG
      // entry to declare a video surface (supports.videoGeneration or an
      // explicit paths.videoGenerate). Provenance is mixed: the fastrouter/
      // aihubmix/cometapi/togetherai/empiriolabs declarations were proven by
      // live probe 2026-07-17; the legacy flags (zai/gmi/siliconflow/stepfun/
      // venice) are catalog-level claims not yet probed and will be exercised
      // by prove-then-advertise once those providers have active models.
      // Dedicated adapters with their own videoGenerate (google/Veo,
      // runwayml, openai, openrouter) pass as before.
      const usesGenericHubVideo =
        (resolution.adapter as ProviderAdapter & { videoGenerate?: unknown }).videoGenerate ===
        OpenAICompatibleHubAdapter.prototype.videoGenerate;
      if (!usesGenericHubVideo) return true;

      const providerId = resolution.operability.resolvedProvider ?? model.provider;
      const entry = this.getCatalogEntry(providerId);
      if (!entry) return false;
      return entry.supports.videoGeneration === true || Boolean(entry.paths?.videoGenerate);
    });
  }

  private async selectVideoCandidateModels(
    explicitModel: string | undefined,
    requiredCapability: ModelCapability,
    userContext: OrchestrationContext,
    strategy: 'single' | 'cost' | 'speed' | 'quality' | 'balanced' | 'parallel' | 'debate' | 'quality_multipass' | 'dynamic'
  ): Promise<Model[]> {
    if (explicitModel) {
      // Direct id/name lookup — the previous searchModels({}).find(...) only
      // saw the repository's 100-most-recent window, so an explicit reference
      // to any older model failed with "not found" (audit 2026-07-17). The
      // lookup returns EVERY provider row for the id (same id exists under N
      // providers) so the gate below can keep all runnable deployments and
      // fallback can cross providers of the same model.
      const rows = await this.modelRepo.findModelsByIdOrName(explicitModel);
      if (rows.length === 0) {
        throw new Error(`Model ${explicitModel} not found`);
      }
      const capable = rows.filter((model) => this.hasVideoCapability(model, requiredCapability));
      if (capable.length === 0) {
        throw new Error(
          `Model ${explicitModel} does not support required capability ${requiredCapability}`
        );
      }
      const runnable = this.getRunnableVideoModels(capable);
      if (runnable.length === 0) {
        throw new Error(`Model ${explicitModel} does not expose an operational videoGenerate adapter`);
      }
      // Order preserved from the repository (createdAt desc, uid tiebreak).
      return runnable;
    }

    // searchModelsComplete: the plain searchModels has a silent 100-row
    // recency window that reduced this pool to "the newest-onboarded
    // providers" (97 of 494 video models; aiml/poe/huggingface/imagerouter
    // never entered — audit 2026-07-17). The candidate pool must reach the
    // ENTIRE catalog; how deep the fallback search goes is governed by the
    // wall-clock deadline, never by what is allowed into the pool.
    const primaryModels = await this.modelRepo.searchModelsComplete({
      capabilities: [requiredCapability],
      status: 'active',
    });

    const fallbackModels =
      requiredCapability === 'video_generation'
        ? []
        : await this.modelRepo.searchModelsComplete({
            capabilities: ['video_generation'],
            status: 'active',
          });

    const merged = [...primaryModels, ...fallbackModels];
    const unique = new Map<string, Model>();
    for (const model of merged) {
      // Dedup by provider+id: keying on id alone collapsed the pool to ONE
      // provider row per model id, killing cross-provider fallback for the
      // same model.
      const key = `${model.provider}:${model.id || model.name}`;
      if (!unique.has(key)) unique.set(key, model);
    }

    const candidatesByCapability = Array.from(unique.values()).filter((model) =>
      this.hasVideoCapability(model, requiredCapability)
    );
    const runnable = this.getRunnableVideoModels(candidatesByCapability);
    if (runnable.length === 0) return [];

    let ranked = this.sortModelsByStrategy(runnable, strategy, userContext);
    ranked = ranked.sort((a, b) => {
      const aExact = a.capabilities.includes(requiredCapability) ? 1 : 0;
      const bExact = b.capabilities.includes(requiredCapability) ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return 0;
    });

    // No truncation — see resolveFallbackDeadlineMs doc. The full ranked,
    // diversified pool is offered; search depth is governed by generateVideo's
    // deadlineMs, not by how many providers happen to exist today.
    return diversifyProviders(ranked);
  }

  private normalizeVideoOutput(
    rawVideo: unknown,
    responseFormat: 'url' | 'b64_json'
  ): Array<{ id?: string; url?: string; b64_json?: string }> {
    if (Buffer.isBuffer(rawVideo)) {
      return responseFormat === 'url'
        ? [{ url: `data:video/mp4;base64,${rawVideo.toString('base64')}` }]
        : [{ b64_json: rawVideo.toString('base64') }];
    }

    if (Array.isArray(rawVideo)) {
      return rawVideo
        .filter((item) => typeof item === 'object' && item !== null)
        .map((item) => {
          const obj = item as { id?: unknown; url?: unknown; b64_json?: unknown };
          return {
            id: typeof obj.id === 'string' ? obj.id : undefined,
            url: typeof obj.url === 'string' ? obj.url : undefined,
            b64_json: typeof obj.b64_json === 'string' ? obj.b64_json : undefined,
          };
        });
    }

    if (rawVideo && typeof rawVideo === 'object') {
      const obj = rawVideo as { id?: unknown; url?: unknown; b64_json?: unknown };
      return [
        {
          id: typeof obj.id === 'string' ? obj.id : undefined,
          url: typeof obj.url === 'string' ? obj.url : undefined,
          b64_json: typeof obj.b64_json === 'string' ? obj.b64_json : undefined,
        },
      ];
    }

    return [];
  }

  async generateVideo(options: VideoGenerationOptions): Promise<VideoResult> {
    const startTime = Date.now();
    const requiredCapability = this.determineRequiredCapability(options);
    const responseFormat = options.responseFormat ?? 'url';
    const strategyUsed = normalizeStrategy(options.strategy);
    const allowFallback = options.allowFallback !== false;

    log.info(
      {
        requestId: options.requestId,
        model: options.model,
        requiredCapability,
        hasImage: !!options.image,
        hasStartImage: !!options.startImage,
        hasEndImage: !!options.endImage,
        hasAudio: !!options.audio,
        hasVideo: !!options.video,
        strategy: strategyUsed,
        allowFallback,
      },
      'Video orchestration started'
    );

    const candidates = await this.selectVideoCandidateModels(
      options.model,
      requiredCapability,
      options.userContext,
      strategyUsed
    );
    if (candidates.length === 0) {
      throw new Error(
        `No runnable models available for capability ${requiredCapability}. Ensure provider adapters expose videoGenerate().`
      );
    }

    // Video submits on aggregators are ASYNC PAID JOBS with no cancellation
    // route (live-proven 2026-07-17 on fastrouter: the submit itself starts
    // billing, and the Promise.any losers keep running — and keep charging —
    // after a winner resolves). Paid-submission fan-out is therefore
    // forbidden for video, including parallel/debate/quality_multipass:
    // maxParallel stays 1 until a cancellation route exists. The fallback
    // search remains sequential, governed by the deadline.
    const maxParallel = 1;

    // DUP #2 phase 2c: the primitive's parallelDegree (Phase-1 Promise.any over
    // the top-N, Phase-2 sequential fallback) is exactly video's former manual
    // loop, so executeWithFallback + cost + completion log are owned by the
    // shared runModalityFallback driver. Video keeps its deliberate
    // 422-on-exhaustion via the onFallbackExhausted hook. Candidates are already
    // operability-filtered by selectVideoCandidateModels, so the primitive's
    // adapter resolution + the videoGenerate method probe suffice.
    const result = await runModalityFallback<
      Awaited<ReturnType<ProviderAdapter['videoGenerate']>>
    >({
      capability: requiredCapability as ModelCapability,
      capabilityLabel: requiredCapability,
      explicit: options.model ?? null,
      catalog: candidates,
      maxCandidates: candidates.length,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      supportsCapability: (adapter) =>
        typeof (adapter as { videoGenerate?: unknown }).videoGenerate === 'function',
      parallelDegree: maxParallel,
      execute: async (selectedModel, adapter) => {
        const response = await adapter.videoGenerate(selectedModel, {
          prompt: options.prompt,
          image: options.image,
          startImage: options.startImage,
          endImage: options.endImage,
          audio: options.audio,
          duration: options.duration,
          aspectRatio: options.aspectRatio,
          size: options.size,
          options: {
            n: options.n ?? 1,
            response_format: responseFormat,
            video: options.video,
          },
        });
        // Empty-generation guard (2026-07-04, c3-v4 defect A): a candidate that
        // resolves but normalizes to ZERO videos is a FAILED rung, not a
        // success — otherwise the fallback stops here and the caller gets a
        // 200 with an empty video.list (83/83 benchmark video rows did exactly
        // this, scored ~0 while flagged success). Async job handles survive:
        // normalizeVideoOutput keeps id-only objects, so only truly
        // empty/unrecognized payloads throw and let the chain advance to the
        // next candidate (exhaustion still raises the deliberate 422 below).
        if (this.normalizeVideoOutput(response.video, responseFormat).length === 0) {
          throw new Error(
            `Model ${selectedModel.name} returned no video output (empty generation)`
          );
        }
        return response;
      },
      onFallbackExhausted: (error, durationMs) => {
        const err = new Error(
          `Video orchestration exhausted ${candidates.length} candidate model(s) without success`
        ) as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> };
        // Pool exhaustion is terminal; 422 avoids route-level retries.
        err.statusCode = 422;
        err.code = 'capability_dependency_unavailable';
        err.details = {
          capability: requiredCapability,
          strategyUsed,
          candidateCount: candidates.length,
          durationMs,
          attempts: error.attempts,
        };
        throw err;
      },
      log,
      requestId: options.requestId,
      startTime,
    });

    const videos = this.normalizeVideoOutput(result.response.video, responseFormat);

    return {
      videos,
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }
}
