// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Music Orchestration Service (LOTE AX, 2026-09-06)
 *
 * Orchestrates music/soundtrack generation across providers with dynamic
 * capability routing — the same shape as AudioOrchestrationService and
 * VideoOrchestrationService, scoped to the `music_generation` capability.
 *
 * NO HARDCODED MODELS — model/provider selection is entirely dynamic via
 * the `music_generation` capability tag. As of this LOTE only ElevenLabs
 * (`generateMusic`, backed by `POST /v1/music`) implements the adapter
 * method, but this service does not name that provider anywhere: a second
 * music provider becomes eligible purely by tagging a model
 * `music_generation` and overriding `generateMusic()`.
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import {
  normalizeStrategy,
  resolveFallbackDeadlineMs,
  diversifyProviders,
} from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { ProviderAdapter } from '@/providers/base/provider-adapter';
import { isAdapterMethodImplemented } from '@/providers/provider-operability';
import { ValidationError } from '@/utils/custom-errors';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';

const log = logger.child({ service: 'music-orchestration' });

export interface MusicGenerationOptions {
  /** Free-text description of the desired composition. */
  prompt?: string;
  /** Structured, section-by-section composition plan (vendor-shaped, passed
   *  through opaquely). Mutually exclusive with `prompt` in practice. */
  compositionPlan?: Record<string, unknown>;
  model?: string; // undefined = auto-select
  musicLengthMs?: number;
  forceInstrumental?: boolean;
  seed?: number;
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface MusicResult {
  audioBuffer: Buffer;
  modelUsed: string;
  provider: string;
  durationMs: number;
  format: string;
  strategyUsed?: string;
  fallbackUsed?: boolean;
  attempts?: CandidateAttempt[];
}

export class MusicOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
  }

  private getModelAverageCostPer1k(model: Model): number {
    const input = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
    const output = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : input;
    const average = (Math.max(0, input) + Math.max(0, output)) / 2;
    return Number.isFinite(average) ? average : 0;
  }

  private getModelQuality(model: Model): number {
    if (
      typeof model.performance?.quality === 'number' &&
      Number.isFinite(model.performance.quality)
    ) {
      return model.performance.quality;
    }
    return 0.5;
  }

  private getModelLatencyMs(model: Model): number {
    if (
      typeof model.performance?.latencyMs === 'number' &&
      Number.isFinite(model.performance.latencyMs)
    ) {
      return model.performance.latencyMs;
    }
    // Music generation is a long-running synthesis task even when the
    // vendor call itself is synchronous — default higher than TTS's 2000ms.
    return 8000;
  }

  private sortModelsByStrategy(
    models: Model[],
    strategy:
      | 'single'
      | 'cost'
      | 'speed'
      | 'quality'
      | 'balanced'
      | 'parallel'
      | 'debate'
      | 'quality_multipass'
      | 'dynamic',
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

      const qualityWeight =
        userContext.qualityTarget && userContext.qualityTarget > 0.7 ? 0.6 : 0.45;
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

  private hasMusicCapability(model: Model): boolean {
    return model.capabilities.includes('music_generation' as ModelCapability);
  }

  private filterModelsByAdapterMethod(models: Model[]): Model[] {
    const providerRegistry = this.getRegistry();
    return models.filter((model) => {
      const resolution = providerRegistry.resolveAdapterForModel(model);
      if (!resolution.adapter) return false;
      return isAdapterMethodImplemented(resolution.adapter, 'generateMusic');
    });
  }

  private async selectMusicCandidateModels(
    explicitModel: string | undefined,
    userContext: OrchestrationContext,
    strategy:
      | 'single'
      | 'cost'
      | 'speed'
      | 'quality'
      | 'balanced'
      | 'parallel'
      | 'debate'
      | 'quality_multipass'
      | 'dynamic'
  ): Promise<Model[]> {
    if (explicitModel) {
      // Whole-catalog id/name resolution, every provider row for the id —
      // see AudioOrchestrationService.selectTTSCandidateModels for why
      // (arbitrary recency windows silently dropped explicit references).
      const rows = await this.modelRepo.findModelsByIdOrName(explicitModel);
      const capable = rows.filter((entry) => this.hasMusicCapability(entry));
      if (capable.length === 0) {
        throw new ValidationError(
          `Model ${explicitModel} not found or does not support music generation`,
          { modelId: explicitModel, capability: 'music_generation' }
        );
      }
      const runnable = this.filterModelsByAdapterMethod(capable);
      if (runnable.length === 0) {
        throw new ValidationError(
          `Model ${explicitModel} does not expose an operational generateMusic adapter`,
          {
            modelId: explicitModel,
            capability: 'music_generation',
            reason: 'adapter_not_operational',
          }
        );
      }
      return runnable;
    }

    const musicModels = await this.modelRepo.searchModelsComplete({
      capabilities: ['music_generation' as ModelCapability],
      status: 'active',
    });

    const uniqueModels = Array.from(
      new Map(musicModels.map((model) => [`${model.provider}:${model.id || model.name}`, model])).values()
    );

    const runnableModels = this.filterModelsByAdapterMethod(uniqueModels);
    if (runnableModels.length === 0) return [];

    const ranked = this.sortModelsByStrategy(runnableModels, strategy, userContext);
    // No truncation — see resolveFallbackDeadlineMs doc. The full ranked,
    // diversified pool is offered; search depth is governed by the caller's
    // deadlineMs, not by how many providers happen to exist today.
    return diversifyProviders(ranked);
  }

  /**
   * Generate music (soundtrack/composition)
   * Dynamically selects the best music-generation model based on strategy.
   *
   * Follows the shared `runModalityFallback` driver used by audio/video/
   * images: candidate selection stays here, execution + fallback + cost +
   * completion logging is the primitive's job. No `orchestration` fallback
   * exists (see capability-registry.ts) — a chat model cannot approximate a
   * music composition — so exhaustion is repackaged as a deliberate 422
   * `capability_dependency_unavailable`, matching every other generative
   * modality in this catalog.
   */
  async generateMusic(options: MusicGenerationOptions): Promise<MusicResult> {
    const startTime = Date.now();
    const {
      prompt,
      compositionPlan,
      model,
      musicLengthMs,
      forceInstrumental,
      seed,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    if (!prompt && !compositionPlan) {
      throw new ValidationError('Either prompt or compositionPlan is required', {
        capability: 'music_generation',
      });
    }

    log.info(
      {
        requestId,
        model,
        hasPrompt: !!prompt,
        hasCompositionPlan: !!compositionPlan,
        strategy: strategyUsed,
        allowFallback,
      },
      'Music orchestration started'
    );

    const candidates = await this.selectMusicCandidateModels(model, userContext, strategyUsed);

    if (candidates.length === 0) {
      throw new ValidationError(
        'No music generation models available. Ensure at least one provider with music_generation capability is configured.',
        { capability: 'music_generation' }
      );
    }

    const parallelDegree = allowFallback ? Math.min(3, candidates.length) : 1;

    const result = await runModalityFallback<
      Awaited<ReturnType<ProviderAdapter['generateMusic']>>
    >({
      capability: 'music_generation' as ModelCapability,
      capabilityLabel: 'music_generation',
      explicit: model ?? null,
      maxCandidates: candidates.length,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      catalog: candidates,
      supportsCapability: (adapter) => isAdapterMethodImplemented(adapter, 'generateMusic'),
      parallelDegree,
      execute: async (selectedModel, adapter) => {
        // Music synthesis is minutes-long output — give it substantially
        // more headroom than TTS's 8s before treating a candidate as a lost
        // cause and moving to the next one.
        const MUSIC_TIMEOUT_MS = 45000;
        return Promise.race([
          adapter.generateMusic(selectedModel, {
            prompt,
            compositionPlan,
            musicLengthMs,
            forceInstrumental,
            seed,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Music generation timeout after ${MUSIC_TIMEOUT_MS}ms`)),
              MUSIC_TIMEOUT_MS
            )
          ),
        ]);
      },
      onFallbackExhausted: (error, durationMs) => {
        log.error(
          { requestId, attempts: error.attempts, durationMs },
          'Music generation exhausted all candidates'
        );
        const repackaged = new Error(error.message) as Error & {
          statusCode: number;
          code: string;
          details: Record<string, unknown>;
        };
        repackaged.statusCode = 422;
        repackaged.code = 'capability_dependency_unavailable';
        repackaged.details = {
          capability: 'music_generation',
          strategyUsed,
          candidateCount: candidates.length,
          durationMs,
          attempts: error.attempts,
        };
        throw repackaged;
      },
      log,
      requestId,
      startTime,
    });

    const musicResponse = result.response;
    return {
      audioBuffer: musicResponse.audio,
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      format: musicResponse.format,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }
}
