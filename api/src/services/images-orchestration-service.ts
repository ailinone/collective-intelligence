// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Images Orchestration Service
 * Orchestrates image generation, editing, and variations across multiple providers.
 *
 * Migrated to executeWithFallback (2026-04-30). Each public method now
 * delegates to the central primitive — capability discovery, adapter probe,
 * tier-aware ranking, structured attempt log are owned by
 * core/orchestration/execute-with-fallback.ts. The strategy-aware ranking
 * (cost/speed/quality/balanced) and provider diversification stay here as
 * the *input order* to the primitive — the primitive's tier sort is order-
 * stable, so within-tier ordering preserves our strategy preference.
 *
 * NO HARDCODED MODELS — all selection is dynamic via model discovery.
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import { normalizeStrategy, resolveFallbackDeadlineMs, diversifyProviders } from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { isAdapterMethodImplemented } from '@/providers/provider-operability';
import { narrowAs } from '@/utils/type-guards';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';

const log = logger.child({ service: 'images-orchestration' });

// ============================================
// Types
// ============================================

type ImageStrategy =
  | 'single'
  | 'cost'
  | 'speed'
  | 'quality'
  | 'balanced'
  | 'parallel'
  | 'debate'
  | 'quality_multipass'
  | 'dynamic';

export interface ImageGenerationOptions {
  prompt: string;
  model?: string; // undefined = auto-select
  n: number;
  size: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  quality: 'standard' | 'hd';
  responseFormat: 'url' | 'b64_json';
  style: 'vivid' | 'natural';
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ImageEditOptions {
  image: Buffer;
  mask?: Buffer;
  prompt: string;
  model?: string;
  n: number;
  size: '256x256' | '512x512' | '1024x1024';
  responseFormat: 'url' | 'b64_json';
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ImageVariationOptions {
  image: Buffer;
  model?: string;
  n: number;
  size: '256x256' | '512x512' | '1024x1024';
  responseFormat: 'url' | 'b64_json';
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ImageResult {
  images: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  modelUsed: string;
  provider: string;
  durationMs: number;
  strategyUsed?: string;
  fallbackUsed?: boolean;
  /**
   * Per-candidate attempt log. Uses the primitive's richer CandidateAttempt
   * shape (errorClass, statusCode, modelId) — supersedes the old
   * { model, provider, status, durationMs, error? } shape.
   */
  attempts?: CandidateAttempt[];
}

// ============================================
// Images Orchestration Service
// ============================================

export class ImagesOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Generate images from text prompts.
   * Capability: `image_generation`. Adapter method: `imageGenerate`.
   */
  async generateImages(options: ImageGenerationOptions): Promise<ImageResult> {
    const startTime = Date.now();
    const {
      prompt,
      model,
      n,
      size,
      quality,
      responseFormat,
      style,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      {
        requestId,
        model,
        promptLength: prompt.length,
        n,
        size,
        quality,
        style,
        strategy: strategyUsed,
        allowFallback,
      },
      'Image generation orchestration started',
    );

    const catalogRows = await this.modelRepo.searchModels({
      capabilities: ['image_generation' as ModelCapability],
      status: 'active',
    });
    // Strategy-major within-tier ordering, then parameter-bonus, then provider
    // diversification. The primitive's tier sort runs on top with stable
    // tiebreaking, so this preference becomes the within-tier order.
    const strategyRanked = this.sortModelsByStrategy(catalogRows, strategyUsed, userContext);
    const parameterRanked = this.applyParameterBonuses(strategyRanked, quality, style);
    const preRanked = diversifyProviders(parameterRanked);

    return this.runImageOperation({
      capabilityLabel: 'image_generation',
      capability: ['image_generation' as ModelCapability],
      explicit: model,
      adapterMethod: 'imageGenerate',
      catalog: preRanked,
      strategyUsed,
      allowFallback,
      requestId,
      startTime,
      execute: async (selectedModel, adapter) => {
        return narrowAs<{
          imageGenerate: ProviderAdapter['imageGenerate'];
        }>(adapter).imageGenerate(selectedModel, {
          prompt,
          size,
          options: { n, quality, style, responseFormat },
        });
      },
      mapResult: (raw) => this.mapGenerationResult(raw, responseFormat),
    });
  }

  /**
   * Edit images with text prompts.
   * Capability: `image_editing` OR `image_generation` (some providers
   * tag generation models as edit-capable). Adapter method: `imageEdit`.
   */
  async editImage(options: ImageEditOptions): Promise<ImageResult> {
    const startTime = Date.now();
    const {
      image,
      mask,
      prompt,
      model,
      n,
      size,
      responseFormat,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      {
        requestId,
        model,
        promptLength: prompt.length,
        hasMask: !!mask,
        strategy: strategyUsed,
        allowFallback,
      },
      'Image edit orchestration started',
    );

    // Image edit accepts EITHER `image_editing` OR `image_generation` rows
    // because some providers tag generation models as edit-capable. The two
    // catalog searches are independent — run them concurrently instead of one
    // round-trip after another (cache-miss otherwise pays 2x the wait).
    const [editRows, generationRows] = await Promise.all([
      this.modelRepo.searchModels({
        capabilities: ['image_editing' as ModelCapability],
        status: 'active',
      }),
      this.modelRepo.searchModels({
        capabilities: ['image_generation' as ModelCapability],
        status: 'active',
      }),
    ]);
    const merged = Array.from(
      new Map([...editRows, ...generationRows].map((m) => [m.id, m])).values(),
    );
    const ranked = this.sortModelsByStrategy(merged, strategyUsed, userContext);
    const preRanked = diversifyProviders(ranked);

    return this.runImageOperation({
      capabilityLabel: 'image_editing',
      capability: ['image_editing' as ModelCapability, 'image_generation' as ModelCapability],
      explicit: model,
      adapterMethod: 'imageEdit',
      catalog: preRanked,
      strategyUsed,
      allowFallback,
      requestId,
      startTime,
      execute: async (selectedModel, adapter) => {
        return narrowAs<{ imageEdit: ProviderAdapter['imageEdit'] }>(adapter).imageEdit(
          selectedModel,
          {
            image,
            mask,
            prompt,
            size,
            options: { n, responseFormat },
          },
        );
      },
      mapResult: (raw) => this.mapEditOrVariationResult(raw, responseFormat),
    });
  }

  /**
   * Create variations of an image.
   * Capability: `image_generation`. Adapter method: `imageVariation`.
   */
  async createVariations(options: ImageVariationOptions): Promise<ImageResult> {
    const startTime = Date.now();
    const {
      image,
      model,
      n,
      size,
      responseFormat,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      { requestId, model, n, size, strategy: strategyUsed, allowFallback },
      'Image variation orchestration started',
    );

    const catalogRows = await this.modelRepo.searchModels({
      capabilities: ['image_generation' as ModelCapability],
      status: 'active',
    });
    const ranked = this.sortModelsByStrategy(catalogRows, strategyUsed, userContext);
    const preRanked = diversifyProviders(ranked);

    return this.runImageOperation({
      capabilityLabel: 'image_variation',
      capability: ['image_generation' as ModelCapability],
      explicit: model,
      adapterMethod: 'imageVariation',
      catalog: preRanked,
      strategyUsed,
      allowFallback,
      requestId,
      startTime,
      execute: async (selectedModel, adapter) => {
        return narrowAs<{
          imageVariation: ProviderAdapter['imageVariation'];
        }>(adapter).imageVariation(selectedModel, {
          image,
          size,
          options: { n, responseFormat },
        });
      },
      mapResult: (raw) => this.mapEditOrVariationResult(raw, responseFormat),
    });
  }

  // ============================================
  // Shared driver — owns the executeWithFallback call + result envelope
  // ============================================

  private async runImageOperation<TRaw>(args: {
    capabilityLabel: string;
    capability: ModelCapability[];
    explicit?: string;
    adapterMethod: 'imageGenerate' | 'imageEdit' | 'imageVariation';
    catalog: Model[];
    strategyUsed: ImageStrategy;
    allowFallback: boolean;
    requestId: string;
    startTime: number;
    execute: (model: Model, adapter: ProviderAdapter) => Promise<TRaw>;
    mapResult: (raw: TRaw) => ImageResult['images'];
  }): Promise<ImageResult> {
    const supportsMethod = (adapter: ProviderAdapter): boolean =>
      isAdapterMethodImplemented(adapter, args.adapterMethod);

    // DUP #2 phase 2: executeWithFallback + cost + completion log + error
    // classification (NoFallback→ValidationError, FallbackExhausted→503) are
    // owned by the shared runModalityFallback driver. Only candidate selection,
    // the execute hook, and the image envelope mapping are image-specific.
    const result = await runModalityFallback<TRaw>({
      capability: args.capability,
      capabilityLabel: args.capabilityLabel,
      explicit: args.explicit ?? null,
      catalog: args.catalog,
      deadlineMs: resolveFallbackDeadlineMs(args.strategyUsed, args.allowFallback),
      registry: this.getRegistry(),
      supportsCapability: supportsMethod,
      execute: args.execute,
      log,
      requestId: args.requestId,
      startTime: args.startTime,
    });

    return {
      images: args.mapResult(result.response),
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed: args.strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }

  // ============================================
  // Strategy normalization + ranking helpers (preserved)
  // ============================================

  private getModelAverageCostPer1k(model: Model): number {
    const input = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
    const output = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : input;
    return (Math.max(0, input) + Math.max(0, output)) / 2;
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
    return 2000;
  }


  private sortModelsByStrategy(
    models: Model[],
    strategy: ImageStrategy,
    userContext: OrchestrationContext,
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

  /**
   * Boost candidates whose `supported_parameters` metadata advertises
   * `quality=hd` or `style` support when those options are requested.
   */
  private applyParameterBonuses(models: Model[], quality: string, style: string): Model[] {
    return [...models].sort((a, b) => {
      const supportedA = ((a.metadata?.supported_parameters as string[] | undefined) ?? []).map(
        (item) => item.toLowerCase(),
      );
      const supportedB = ((b.metadata?.supported_parameters as string[] | undefined) ?? []).map(
        (item) => item.toLowerCase(),
      );
      const qualityBonusA =
        quality === 'hd' && (supportedA.includes('hd') || supportedA.includes('quality')) ? 1 : 0;
      const qualityBonusB =
        quality === 'hd' && (supportedB.includes('hd') || supportedB.includes('quality')) ? 1 : 0;
      if (qualityBonusA !== qualityBonusB) return qualityBonusB - qualityBonusA;

      const styleBonusA = style && supportedA.includes('style') ? 1 : 0;
      const styleBonusB = style && supportedB.includes('style') ? 1 : 0;
      if (styleBonusA !== styleBonusB) return styleBonusB - styleBonusA;
      return 0;
    });
  }


  // ============================================
  // Result mappers
  // ============================================

  private mapGenerationResult(
    raw: Awaited<ReturnType<ProviderAdapter['imageGenerate']>>,
    responseFormat: 'url' | 'b64_json',
  ): ImageResult['images'] {
    const images = Array.isArray(raw.image) ? raw.image : [raw.image];
    interface ImageItem {
      url?: string;
      b64_json?: string;
      buffer?: Buffer;
    }
    return images.map((img: ImageItem | Buffer) => {
      const imageItem: ImageItem = Buffer.isBuffer(img) ? { buffer: img } : img;
      return {
        ...(responseFormat === 'url'
          ? { url: imageItem.url || this.bufferToDataURL(imageItem.buffer || Buffer.from('')) }
          : {
              b64_json:
                imageItem.b64_json || this.bufferToBase64(imageItem.buffer || Buffer.from('')),
            }),
        revised_prompt: (raw.raw as { revised_prompt?: string })?.revised_prompt,
      };
    });
  }

  private mapEditOrVariationResult(
    raw: Awaited<ReturnType<ProviderAdapter['imageEdit']>>,
    responseFormat: 'url' | 'b64_json',
  ): ImageResult['images'] {
    const images = Array.isArray(raw.image) ? raw.image : [raw.image];
    interface ImageItem {
      url?: string;
      b64_json?: string;
    }
    return images.map((img: Buffer | ImageItem): ImageItem => {
      if (Buffer.isBuffer(img)) {
        return responseFormat === 'url'
          ? { url: this.bufferToDataURL(img) }
          : { b64_json: this.bufferToBase64(img) };
      }
      return {
        ...(responseFormat === 'url'
          ? { url: img.url || (Buffer.isBuffer(img) ? this.bufferToDataURL(img) : undefined) }
          : { b64_json: Buffer.isBuffer(img) ? this.bufferToBase64(img) : undefined }),
      };
    });
  }

  // ============================================
  // Format conversion helpers
  // ============================================

  private bufferToDataURL(buffer: Buffer | string): string {
    if (typeof buffer === 'string') return buffer;
    if (Buffer.isBuffer(buffer)) {
      const base64 = buffer.toString('base64');
      return `data:image/png;base64,${base64}`;
    }
    return '';
  }

  private bufferToBase64(buffer: Buffer | string): string {
    if (typeof buffer === 'string') return buffer;
    if (Buffer.isBuffer(buffer)) return buffer.toString('base64');
    return '';
  }
}
