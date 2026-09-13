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
import {
  normalizeStrategy,
  resolveFallbackDeadlineMs,
  diversifyProviders,
} from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { isAdapterMethodImplemented } from '@/providers/provider-operability';
import { narrowAs } from '@/utils/type-guards';
import {
  classifyFallbackError,
  FallbackExhaustedError,
  type CandidateAttempt,
} from '@/core/orchestration/execute-with-fallback';
import { getImageCandidateJudge, type ImageJudgeVerdict } from '@/services/image-candidate-judge';

const log = logger.child({ service: 'images-orchestration' });

/**
 * Package B (2026-09-09): strategies that get REAL collective intelligence —
 * generate N candidates from DIFFERENT models concurrently, judge them with a
 * real vision-capable model, return the best one. Before this change, all
 * three collapsed to the same behavior as plain `quality` (sort by static
 * score, race the top of the pool, return whichever answers first) — the
 * strategy names implied deliberation that never happened. They differ only
 * in which strategy ranks the CANDIDATE POOL feeding the N slots (quality/
 * debate/quality_multipass all rank by the static quality score first, same
 * as before); the collective step itself — judge-scored best-of-N — is now
 * real and identical for all three, an honest simplification over three
 * previously-fake-differentiated names.
 */
const BEST_OF_N_STRATEGIES: ReadonlySet<ImageStrategy> = new Set([
  'parallel',
  'debate',
  'quality_multipass',
]);

const DEFAULT_BEST_OF_N = 3;
const MIN_BEST_OF_N = 2;
const MAX_BEST_OF_N = 5;

function resolveBestOfN(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IMAGE_BEST_OF_N ?? DEFAULT_BEST_OF_N);
  if (!Number.isFinite(raw)) return DEFAULT_BEST_OF_N;
  return Math.min(MAX_BEST_OF_N, Math.max(MIN_BEST_OF_N, Math.floor(raw)));
}

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

/**
 * Image ENHANCEMENT (upscale / denoise) — LOTE AP.
 *
 * Distinct from `image_editing`: editing is prompt-driven and changes what
 * the picture depicts; enhancement is parameter-driven and changes only its
 * fidelity (resolution, noise, sharpness). They share the `imageEdit` adapter
 * method because that is the only adapter entry point that takes an image IN
 * and returns an image OUT, but they must NOT share a candidate pool — an
 * `image_editing` model asked to upscale will happily regenerate the picture.
 */
export interface ImageEnhancementOptions {
  image: Buffer;
  /** `image_upscale` or `image_denoise`. Selects the catalog capability. */
  capability: ModelCapability;
  model?: string;
  /** Target magnification (provider-dependent; Topaz accepts 1|2|4|6). */
  upscaleFactor?: number;
  /** Noise-reduction strength, 0-100. */
  noiseReduction?: number;
  /** Sharpening strength, 0-100. */
  sharpen?: number;
  /**
   * Optional guidance. Enhancement is parameter-driven, so this is passed
   * through for providers that accept one and is NOT required — an empty
   * prompt is the normal case.
   */
  prompt?: string;
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
  /**
   * Package B (2026-09-09): `true` when a real judge comparison actually
   * decided the winner among multiple generated candidates (only possible
   * for `parallel`/`debate`/`quality_multipass`, and only when at least 2
   * candidates succeeded AND the judge was available for at least one of
   * them). `false`/absent means either a single-candidate strategy, or a
   * best-of-N run where the judge was disabled/unavailable and the winner
   * was chosen by the pre-existing static ranking instead — this field is
   * the honest "did real collective intelligence happen here" signal, not
   * just log data nobody reads.
   */
  judgeUsed?: boolean;
  /** How many candidates actually succeeded and were considered (best-of-N
   *  strategies only). */
  candidatesEvaluated?: number;
  /** Per-candidate judge output, in the order they were scored — surfaced so
   *  a caller can see WHY a given candidate won, not just that one did. */
  judgeVerdicts?: Array<{
    modelUsed: string;
    provider: string;
    score: number;
    verdict: ImageJudgeVerdict['verdict'];
    rationale?: string;
    available: boolean;
  }>;
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
      'Image generation orchestration started'
    );

    const catalogRows = await this.resolveImageCatalog(
      ['image_generation' as ModelCapability],
      model
    );
    // Strategy-major within-tier ordering, then parameter-bonus, then provider
    // diversification. The primitive's tier sort runs on top with stable
    // tiebreaking, so this preference becomes the within-tier order.
    const strategyRanked = this.sortModelsByStrategy(catalogRows, strategyUsed, userContext);
    const parameterRanked = this.applyParameterBonuses(strategyRanked, quality, style);
    const preRanked = diversifyProviders(parameterRanked);

    // Package B (2026-09-09): real collective intelligence for
    // parallel/debate/quality_multipass — see BEST_OF_N_STRATEGIES' doc.
    // Gated on auto-select (`!model`): an explicit single model has nothing
    // to compare against, so it keeps the ordinary single-winner path.
    if (BEST_OF_N_STRATEGIES.has(strategyUsed) && (!model || model === 'auto')) {
      return this.runBestOfNImageGeneration({
        prompt,
        size,
        quality,
        style,
        responseFormat,
        catalog: preRanked,
        strategyUsed,
        allowFallback,
        requestId,
        startTime,
        userContext,
      });
    }

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
   * Real best-of-N image generation + judge selection (Package B).
   *
   * Generates from the top `n` (env-configurable, default 3) DISTINCT
   * candidate models CONCURRENTLY via `Promise.allSettled` — unlike
   * `executeWithFallback`'s `parallelDegree` (`Promise.any`, which returns on
   * the FIRST success and discards the rest), every successful candidate is
   * kept and judged. The judge's verdict decides the winner; when the judge
   * is unavailable/disabled or only one candidate succeeded, the winner
   * falls back to the pool's existing static ranking order (`successes[0]`)
   * — never silently fabricated as "judged" when it wasn't (`judgeUsed`
   * reports which happened).
   *
   * Scope note: forces `n:1` on each per-candidate generation call regardless
   * of the caller's requested `ImageGenerationOptions.n` — the comparison is
   * between DIFFERENT MODELS' single outputs, and generating N images from
   * EACH of N models to then judge N*N candidates would multiply cost
   * unpredictably. A caller combining `strategy: 'debate'` with `n > 1`
   * gets exactly 1 image back (the judged winner), not `n` — a deliberate,
   * documented limitation.
   *
   * Reliability: if every one of the top-N candidates fails, falls through
   * to the ordinary sequential fallback primitive over the REMAINING pool —
   * a best-of-N request is never LESS reliable than the equivalent
   * single-winner request, only potentially higher quality when candidates
   * succeed.
   */
  private async runBestOfNImageGeneration(args: {
    prompt: string;
    size: ImageGenerationOptions['size'];
    quality: ImageGenerationOptions['quality'];
    style: ImageGenerationOptions['style'];
    responseFormat: 'url' | 'b64_json';
    catalog: Model[];
    strategyUsed: ImageStrategy;
    allowFallback: boolean;
    requestId: string;
    startTime: number;
    userContext: OrchestrationContext;
  }): Promise<ImageResult> {
    const n = resolveBestOfN();
    const registry = this.getRegistry();
    const supportsMethod = (adapter: ProviderAdapter): boolean =>
      isAdapterMethodImplemented(adapter, 'imageGenerate');

    const resolvedCandidates: Array<{ model: Model; adapter: ProviderAdapter }> = [];
    const remaining: Model[] = [];
    for (const candidateModel of args.catalog) {
      if (resolvedCandidates.length >= n) {
        remaining.push(candidateModel);
        continue;
      }
      const resolution = registry.resolveAdapterForModel(candidateModel);
      if (!resolution.adapter || !supportsMethod(resolution.adapter)) continue;
      resolvedCandidates.push({ model: candidateModel, adapter: resolution.adapter });
    }

    log.info(
      {
        requestId: args.requestId,
        strategy: args.strategyUsed,
        candidatePoolSize: resolvedCandidates.length,
        bestOfN: n,
      },
      'Best-of-N image generation started'
    );

    type RawGenResult = Awaited<ReturnType<ProviderAdapter['imageGenerate']>>;
    type Success = { model: Model; adapter: ProviderAdapter; raw: RawGenResult };
    const attempts: CandidateAttempt[] = [];
    const successes: Success[] = [];

    const generateOne = (model: Model, adapter: ProviderAdapter) =>
      narrowAs<{ imageGenerate: ProviderAdapter['imageGenerate'] }>(adapter).imageGenerate(model, {
        prompt: args.prompt,
        size: args.size,
        options: { n: 1, quality: args.quality, style: args.style, responseFormat: args.responseFormat },
      });

    await Promise.allSettled(
      resolvedCandidates.map(async ({ model, adapter }) => {
        const startedAt = Date.now();
        try {
          const raw = await generateOne(model, adapter);
          attempts.push({
            model: model.name,
            modelId: model.id,
            provider: model.provider,
            status: 'success',
            durationMs: Date.now() - startedAt,
          });
          successes.push({ model, adapter, raw });
        } catch (err) {
          const classified = classifyFallbackError(err);
          attempts.push({
            model: model.name,
            modelId: model.id,
            provider: model.provider,
            status: 'failed',
            errorClass: classified.errorClass,
            errorMessage: classified.message,
            statusCode: classified.statusCode,
            durationMs: Date.now() - startedAt,
          });
        }
      })
    );

    if (successes.length === 0) {
      if (remaining.length === 0) {
        throw new FallbackExhaustedError('image_generation', attempts);
      }
      // Every top-N candidate failed — sequential fallback over whatever
      // remains, same reliability contract as the non-best-of-N path.
      const fallbackResult = await this.runImageOperation({
        capabilityLabel: 'image_generation',
        capability: ['image_generation' as ModelCapability],
        adapterMethod: 'imageGenerate',
        catalog: remaining,
        strategyUsed: args.strategyUsed,
        allowFallback: args.allowFallback,
        requestId: args.requestId,
        startTime: args.startTime,
        execute: (selectedModel, adapter) => generateOne(selectedModel, adapter),
        mapResult: (raw) => this.mapGenerationResult(raw, args.responseFormat),
      });
      return { ...fallbackResult, attempts: [...attempts, ...(fallbackResult.attempts ?? [])] };
    }

    let winner: Success = successes[0];
    let judgeUsed = false;
    let judgeVerdicts: ImageResult['judgeVerdicts'];

    if (successes.length > 1) {
      const judge = getImageCandidateJudge();
      const scored = await Promise.all(
        successes.map(async (candidate) => {
          // Always judge against a 'url' rendering (real URL or data: URL)
          // regardless of the caller's requested responseFormat — the judge
          // needs SOMETHING VisionOrchestrationService can consume, and the
          // final winner is still mapped in the caller's actual format below.
          const imageForJudge = this.mapGenerationResult(candidate.raw, 'url')[0];
          const image = imageForJudge?.url;
          if (!image) {
            return {
              candidate,
              verdict: {
                score: 0,
                verdict: 'uncertain' as const,
                available: false,
                unavailableReason: 'no_image_bytes',
              } satisfies ImageJudgeVerdict,
            };
          }
          const verdict = await judge.score(
            { image, prompt: args.prompt },
            { requestId: args.requestId, userContext: args.userContext }
          );
          return { candidate, verdict };
        })
      );

      judgeVerdicts = scored.map((s) => ({
        modelUsed: s.candidate.model.name,
        provider: s.candidate.model.provider,
        score: s.verdict.score,
        verdict: s.verdict.verdict,
        rationale: s.verdict.rationale,
        available: s.verdict.available,
      }));

      if (scored.some((s) => s.verdict.available)) {
        judgeUsed = true;
        // Unavailable verdicts always sort last — a candidate the judge
        // never actually scored must not "win" a comparison it didn't
        // participate in just because its placeholder score is compared
        // numerically against real scores.
        scored.sort((a, b) => {
          if (a.verdict.available !== b.verdict.available) return a.verdict.available ? -1 : 1;
          return b.verdict.score - a.verdict.score;
        });
        winner = scored[0].candidate;
      }
      // else: judge unavailable for every candidate — winner stays
      // successes[0] (deterministic, pre-existing static-ranking order).
    }

    return {
      images: this.mapGenerationResult(winner.raw, args.responseFormat),
      modelUsed: winner.model.name,
      provider: winner.model.provider,
      durationMs: Date.now() - args.startTime,
      strategyUsed: args.strategyUsed,
      fallbackUsed: winner.model.id !== args.catalog[0]?.id,
      attempts,
      judgeUsed,
      candidatesEvaluated: successes.length,
      ...(judgeVerdicts ? { judgeVerdicts } : {}),
    };
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
      'Image edit orchestration started'
    );

    // Image edit accepts EITHER `image_editing` OR `image_generation` rows
    // because some providers tag generation models as edit-capable. The two
    // catalog searches are independent — run them concurrently instead of one
    // round-trip after another (cache-miss otherwise pays 2x the wait).
    const merged = await this.resolveImageCatalog(
      ['image_editing' as ModelCapability, 'image_generation' as ModelCapability],
      model
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
          }
        );
      },
      mapResult: (raw) => this.mapEditOrVariationResult(raw, responseFormat),
    });
  }

  /**
   * Upscale or denoise an existing image.
   *
   * Capability: `image_upscale` / `image_denoise`. Adapter method: `imageEdit`.
   *
   * The candidate pool is the enhancement capability ALONE — deliberately not
   * widened to `image_editing`/`image_generation` the way `editImage` widens
   * itself. A generative editor handed an upscale request returns a
   * *different picture*, which is a silent correctness failure, not a
   * degraded result. If no provider in the catalog advertises the
   * enhancement capability, `runModalityFallback` raises
   * `NoFallbackCandidateError` (404) and the caller learns the truth.
   */
  async enhanceImage(options: ImageEnhancementOptions): Promise<ImageResult> {
    const startTime = Date.now();
    const {
      image,
      capability,
      model,
      upscaleFactor,
      noiseReduction,
      sharpen,
      prompt,
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
        capability,
        model,
        imageBytes: image.length,
        upscaleFactor,
        noiseReduction,
        sharpen,
        strategy: strategyUsed,
        allowFallback,
      },
      'Image enhancement orchestration started'
    );

    const catalogRows = await this.resolveImageCatalog([capability], model);
    const ranked = this.sortModelsByStrategy(catalogRows, strategyUsed, userContext);
    const preRanked = diversifyProviders(ranked);

    return this.runImageOperation({
      capabilityLabel: capability,
      capability: [capability],
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
            // Enhancement is parameter-driven; the empty string keeps the
            // shared ImageEditRequest contract satisfied without inventing an
            // instruction the model would then try to follow.
            prompt: prompt ?? '',
            options: {
              n: 1,
              responseFormat,
              // Only forward parameters the caller actually set — sending
              // `upscale_factor: undefined` to a multipart builder that
              // type-checks `typeof === 'number'` is harmless, but sending a
              // default the caller never asked for is not.
              ...(typeof upscaleFactor === 'number' ? { upscale_factor: upscaleFactor } : {}),
              ...(typeof noiseReduction === 'number' ? { noise_reduction: noiseReduction } : {}),
              ...(typeof sharpen === 'number' ? { sharpen } : {}),
              enhancement: capability,
            },
          }
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
      'Image variation orchestration started'
    );

    const catalogRows = await this.resolveImageCatalog(
      ['image_generation' as ModelCapability],
      model
    );
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

  /**
   * Build the candidate pool for an image capability.
   *
   * Two distinct failures were measured live against the running server
   * (LOTE AN), both caused by `searchModels`' silent `limit || 100` combined
   * with `ORDER BY created_at DESC` (see `ModelRepository.searchModels`):
   *
   *   - `POST /v1/images/generations` with no model answered 503 listing only
   *     `huggingface/Muapi/...` rows. With ~52k HuggingFace LoRA repos tagged
   *     `image_generation`, the pool was literally "the 100 most recently
   *     discovered rows" — every real hosted image model was outside the
   *     window, so every attempt failed `provider_unavailable`.
   *   - `POST /v1/images/generations` with `model: "gpt-image-1"` answered
   *     400 `Model "gpt-image-1" not found or does not support
   *     image_generation`, even though the catalog holds it under four
   *     runnable providers. `executeWithFallback` name-matches against the
   *     catalog it is HANDED, so an explicit id outside the 100-row window is
   *     indistinguishable from a nonexistent one.
   *
   * The video service already fixed exactly this (audit 2026-07-17); images
   * was never migrated. Same remedy, same reasoning: an explicit reference is
   * resolved by direct id/name lookup, and the automatic pool reaches the
   * whole catalog. How many candidates get TRIED stays governed by the
   * fallback time budget — never by what is allowed into the pool.
   */
  private async resolveImageCatalog(
    capabilities: ModelCapability[],
    explicit: string | undefined
  ): Promise<Model[]> {
    if (explicit && explicit !== 'auto') {
      // Returns EVERY provider row carrying this id, so fallback can cross
      // providers of the same model.
      const rows = await this.modelRepo.findModelsByIdOrName(explicit);
      return rows.filter((m) => capabilities.some((c) => (m.capabilities ?? []).includes(c)));
    }

    const pools = await Promise.all(
      capabilities.map((c) => this.modelRepo.searchModelsComplete({ capabilities: [c], status: 'active' }))
    );
    // De-duplicate across capabilities while preserving repository order.
    return Array.from(new Map(pools.flat().map((m) => [`${m.provider}:${m.id}`, m])).values());
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

  /**
   * Boost candidates whose `supported_parameters` metadata advertises
   * `quality=hd` or `style` support when those options are requested.
   */
  private applyParameterBonuses(models: Model[], quality: string, style: string): Model[] {
    return [...models].sort((a, b) => {
      const supportedA = ((a.metadata?.supported_parameters as string[] | undefined) ?? []).map(
        (item) => item.toLowerCase()
      );
      const supportedB = ((b.metadata?.supported_parameters as string[] | undefined) ?? []).map(
        (item) => item.toLowerCase()
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
    responseFormat: 'url' | 'b64_json'
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
    responseFormat: 'url' | 'b64_json'
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
