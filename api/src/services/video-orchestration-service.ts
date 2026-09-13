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
import {
  normalizeStrategy,
  resolveFallbackDeadlineMs,
  diversifyProviders,
} from '@/services/modality/modality-execution-helpers';
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
import {
  canSatisfyVideoAttributes,
  type VideoAttributeRequest,
} from '@/providers/catalog/video-capability-matcher';
import {
  extendVideoToDuration,
  probeMedia,
  muxAudioIntoVideo,
  MediaToolkitUnavailableError,
} from '@/services/media/ffmpeg-media-toolkit';

const log = logger.child({ service: 'video-orchestration' });

/**
 * Duration-reconciliation tolerance (2026-09-09): only treat a generated
 * clip as short of the request when the shortfall is BOTH more than 1
 * absolute second AND more than 10% of the target. Encoder frame-rounding
 * routinely lands a "10s" request at 9.6-10.0s — reprocessing every such
 * near-exact result through ffmpeg would add latency/cost for a gap that
 * was never real. This only gates the extend step; candidate SELECTION
 * (`canSatisfyVideoAttributes`) is unaffected.
 */
function isMeaningfullyShort(actualSec: number, targetSec: number): boolean {
  const shortfallSec = targetSec - actualSec;
  return shortfallSec > 1 && shortfallSec > targetSec * 0.1;
}

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
  /**
   * LOTE AS (2026-09-06): structural resolution request (e.g. '4K', '1080p'),
   * distinct from the free-form `size` string. Reaches BytePlus's real
   * RESOLUTIONS enum (byteplus-adapter.ts's `opts.resolution`) and Google's
   * Veo `parameters.resolution` (google-adapter.ts's `options.resolution`,
   * already wired independent of this change). Adapters with no resolution
   * concept simply ignore it — no-op, never fabricated.
   */
  resolution?: string;
  /**
   * LOTE AS (2026-09-06): request a native, vendor-generated video
   * soundtrack — BytePlus Seedance's real, vendor-documented `generate_audio`
   * field (see providers.catalog.ts's byteplus note: "a video soundtrack,
   * not TTS"), and Google Veo's own `parameters.generateAudio`. This is NOT
   * the same as `audio` above, which is an INPUT conditioning clip URL.
   * Ignored/no-op by adapters without a native soundtrack feature.
   */
  generateAudio?: boolean;
  /**
   * Package A (2026-09-09): a real soundtrack asset (base64-encoded audio
   * bytes, NOT a URL — see the doc below) the caller wants attached to the
   * generated video when the winning model can't do it natively.
   *
   * `generateAudio` above only reaches a NATIVE vendor soundtrack switch
   * (BytePlus Seedance, Google Veo) — real, but a no-op on every other
   * provider, including the two the catalog explicitly documents as having
   * NO native audio feature (runwayml, siliconflow). This field is the
   * "second specialized tool" completion of that story, mirroring the
   * established `image_upscale`/`image_denoise` pattern (a first model
   * generates the base asset, a second specialized step — there, Topaz;
   * here, ffmpeg — completes a requirement the first model couldn't): after
   * a candidate with no confirmed native audio support generates a (likely
   * silent) video, this asset is muxed in via
   * `ffmpeg-media-toolkit.ts#muxAudioIntoVideo`. Base64-only, deliberately —
   * accepting an arbitrary caller-supplied URL here would make this process
   * fetch attacker-controlled URLs server-side (the same SSRF concern
   * `capabilities-routes.ts#resolveVisionImage` documents for images).
   *
   * Best-effort: composition failure (ffmpeg unavailable, bad audio bytes,
   * mux error) never fails the whole request — it falls back to the
   * unmodified video and reports `audioComposed: false` /
   * `audioRequirementUnmet: true` on the result. See `generateVideo`'s
   * post-processing step.
   */
  soundtrackAudioBase64?: string;
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
  /**
   * Package A (2026-09-09): `true` when a supplied `soundtrackAudioBase64`
   * was successfully muxed into the returned video (the video in `videos[]`
   * IS the composed one). Absent when composition was never attempted
   * (audio wasn't requested, or the winning model already has confirmed
   * native audio support).
   */
  audioComposed?: boolean;
  /**
   * `true` when audio/a soundtrack was requested (`generateAudio: true`) but
   * the returned video does NOT have it — either no `soundtrackAudioBase64`
   * was supplied to compose one, or composition was attempted and failed
   * (see the warning-level log line for the reason). Never fabricated:
   * this is the honest signal that the requirement was not met, rather than
   * silently shipping a mute video and claiming success.
   */
  audioRequirementUnmet?: boolean;
  /**
   * `true` when the returned video was SHORTER than the requested `duration`
   * by more than the reconciliation tolerance and was successfully extended
   * (looped + trimmed) via `ffmpeg-media-toolkit.ts#extendVideoToDuration`
   * to reach it. The video in `videos[]` IS the extended one. Absent when no
   * `duration` was requested, or the delivered clip already met it.
   */
  durationExtended?: boolean;
  /**
   * `true` when a `duration` was requested, the returned clip was
   * confirmed (by probing it) to fall meaningfully short of it, and
   * extension was not possible (ffmpeg unavailable, probe/extend error, or
   * the shortfall exceeded the safety-capped loop count) — the ORIGINAL,
   * still-short clip ships. Never set when the shortfall could not be
   * verified at all (e.g. an async job handle with no retrievable bytes
   * yet): unknown is not the same as unmet. Honest signal, never fabricated
   * success.
   */
  durationRequirementUnmet?: boolean;
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
    return 3000;
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
    if (capability !== 'video_generation' && model.capabilities.includes('video_generation'))
      return true;
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
      // live probe 2026-07-17; the rest (zai/gmi/siliconflow/stepfun/venice,
      // plus imagerouter/byteplus added since) are catalog-level claims not
      // yet probed and will be exercised by prove-then-advertise once those
      // providers have active models — this comment is intentionally not
      // re-enumerated every time a new provider sets videoGeneration:true in
      // the catalog; the gate logic below is what's load-bearing, not this
      // list. Dedicated adapters with their own videoGenerate (google/Veo,
      // runwayml, openai, openrouter) pass as before — runwayml specifically
      // is correctly wired (confirmed 2026-08-01: real key, right baseUrl/
      // headers) but blocked purely on billing (creditBalance: 0), not code.
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
    requestAttrs: VideoAttributeRequest
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
        throw new Error(
          `Model ${explicitModel} does not expose an operational videoGenerate adapter`
        );
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

    // LOTE AS (2026-09-06): additive attribute-aware pre-filter, ahead of
    // cost/quality/latency ranking. A candidate whose DECLARED
    // videoCapabilityAttributes conflict with the request's duration/
    // resolution/aspectRatio/audio need is excluded here; a candidate with
    // no declared attributes for that field is NOT excluded — see
    // canSatisfyVideoAttributes's fail-open/fail-closed contract.
    const candidatesByCapability = Array.from(unique.values()).filter(
      (model) =>
        this.hasVideoCapability(model, requiredCapability) &&
        canSatisfyVideoAttributes(
          this.getCatalogEntry(model.provider)?.videoCapabilityAttributes,
          requestAttrs
        )
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

    // LOTE AS (2026-09-06): the request-side view of VideoAttributeRequest,
    // derived from the public options — `audioRequested` maps ONLY from the
    // new `generateAudio` (soundtrack) field, never from `audio` (an input
    // conditioning clip, a different concept entirely).
    const audioRequested = options.generateAudio === true;
    const requestAttrs: VideoAttributeRequest = {
      durationSeconds: options.duration,
      resolution: options.resolution,
      aspectRatio: options.aspectRatio,
      audioRequested,
    };

    // Package A (2026-09-09): the pre-filter above excludes a candidate with
    // CONFIRMED `nativeAudioSupport: false` (runwayml, siliconflow) whenever
    // audio is requested — correct when nothing else could satisfy the
    // requirement. But when the caller ALSO supplies `soundtrackAudioBase64`,
    // composition (see the post-processing step below) can satisfy the
    // requirement on ANY candidate regardless of native support — excluding
    // those two providers in that case would be needlessly conservative now
    // that a real fallback exists. The filter gets its OWN narrower view;
    // `requestAttrs` above (used for the post-processing decision) keeps the
    // full "was audio requested at all" signal.
    const filterAttrs: VideoAttributeRequest = {
      ...requestAttrs,
      audioRequested: audioRequested && !options.soundtrackAudioBase64,
    };

    const candidates = await this.selectVideoCandidateModels(
      options.model,
      requiredCapability,
      options.userContext,
      strategyUsed,
      filterAttrs
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
    const result = await runModalityFallback<Awaited<ReturnType<ProviderAdapter['videoGenerate']>>>(
      {
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
        execute: async (selectedModel, adapter, { deadlineAt }) => {
          const response = await adapter.videoGenerate(selectedModel, {
            prompt: options.prompt,
            image: options.image,
            startImage: options.startImage,
            endImage: options.endImage,
            audio: options.audio,
            video: options.video,
            duration: options.duration,
            aspectRatio: options.aspectRatio,
            size: options.size,
            // LOTE AS (2026-09-06): FIX THE DEAD OPTIONS BAG. This nested bag
            // used to carry only {n, response_format, video} — duration/
            // aspectRatio/size/audio/resolution/generateAudio never reached
            // it, even though several adapters read THIS bag (not the
            // top-level fields above) for their own dead reads:
            //   - RunwayML (runwayml-adapter.ts ~196-197): options.duration,
            //     options.ratio (aspect ratio under Runway's own field name).
            //   - BytePlus (byteplus-adapter.ts ~1786, ~1806): opts.resolution,
            //     opts.generate_audio (its real, vendor-documented Seedance
            //     soundtrack switch).
            //   - Google Veo (google-adapter.ts ~1686-1691): options.resolution,
            //     options.generateAudio (already wired, just never populated).
            // Duplicating duration/aspectRatio/size/audio here (redundant
            // with the top-level fields, which some adapters — openai,
            // openai-compatible-hub — read instead/also) is deliberate: it
            // costs nothing and closes the dead-read gap for every adapter
            // convention observed in this codebase without special-casing
            // per adapter.
            options: {
              n: options.n ?? 1,
              response_format: responseFormat,
              video: options.video,
              duration: options.duration,
              aspectRatio: options.aspectRatio,
              ratio: options.aspectRatio,
              size: options.size,
              audio: options.audio,
              resolution: options.resolution,
              generateAudio: options.generateAudio,
              generate_audio: options.generateAudio,
              // Bug 2 fix (2026-09-08): the absolute deadline for the WHOLE
              // fallback search (executeWithFallback's `deadlineMs`), not
              // just this one candidate. Adapters whose video generation
              // polls an async job (openai-compatible-hub's pollVideoTask,
              // byteplus's submitAndPollGenerationTask) bound their own poll
              // budget by this so a single slow-failing candidate cannot
              // consume the entire search budget and starve every other
              // candidate — live-proven 2026-09-08 on empiriolabs/wan-3-0,
              // where a 300000ms poll ran to completion under a 30000ms
              // search deadline. Adapters with no internal wait ignore it.
              orchestrationDeadlineAt: deadlineAt,
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
      }
    );

    let videos = this.normalizeVideoOutput(result.response.video, responseFormat);

    // Package A (2026-09-09): soundtrack composition — the "second
    // specialized tool" completion of an audio requirement the winning
    // model can't satisfy natively. See VideoGenerationOptions
    // .soundtrackAudioBase64's doc for the full rationale.
    let audioComposed: boolean | undefined;
    let audioRequirementUnmet: boolean | undefined;
    if (requestAttrs.audioRequested === true) {
      const selectedAttrs = this.getCatalogEntry(result.selectedModel.provider)
        ?.videoCapabilityAttributes;
      const alreadyHasNativeAudio = selectedAttrs?.nativeAudioSupport === true;
      if (!alreadyHasNativeAudio) {
        if (options.soundtrackAudioBase64) {
          const composed = await this.tryComposeSoundtrack(
            videos,
            options.soundtrackAudioBase64,
            responseFormat,
            options.requestId
          );
          if (composed) {
            videos = composed;
            audioComposed = true;
          } else {
            audioComposed = false;
            audioRequirementUnmet = true;
          }
        } else {
          // Audio was requested, the model has no confirmed native support,
          // and the caller supplied no asset to compose — honest signal
          // rather than silently shipping a mute video as a "success".
          audioRequirementUnmet = true;
        }
      }
    }

    // 2026-09-09: duration-chaining completion. `canSatisfyVideoAttributes`
    // already keeps a candidate with a DECLARED duration ceiling below the
    // request out of the pool, but only 5 providers have that attribute
    // populated — every other candidate is admitted fail-open, with no
    // guarantee its actual output reaches the requested length. This is the
    // second, complementary specialized-tool step for the cases the pre-
    // filter cannot catch: probe what was actually delivered and, when it
    // falls meaningfully short, extend it for real via ffmpeg rather than
    // silently shipping (and reporting as a plain "success") a clip shorter
    // than what was asked for.
    let durationExtended: boolean | undefined;
    let durationRequirementUnmet: boolean | undefined;
    if (typeof options.duration === 'number' && options.duration > 0) {
      // Cost guard: verifying duration means fetching the FULL video back
      // from the URL the provider just returned (see
      // resolveVideoBytesForDurationCheck) — real egress cost on every call.
      // `canSatisfyVideoAttributes` already excluded any candidate whose
      // DECLARED duration ceiling conflicts with the request, so a winning
      // candidate that HAS declared, vendor-verified duration attributes
      // already carries real confidence, not a guess — skip the fetch there.
      // The majority of providers have no declared attributes at all, which
      // is exactly the risk case this fix targets, so they still get the
      // real, fetched check.
      const attrs = this.getCatalogEntry(result.selectedModel.provider)?.videoCapabilityAttributes;
      const durationDeclared =
        attrs?.maxDurationSeconds !== undefined ||
        (attrs?.allowedDurationsSeconds !== undefined && attrs.allowedDurationsSeconds.length > 0);
      if (!durationDeclared) {
        const reconciled = await this.reconcileVideoDuration(
          videos,
          options.duration,
          responseFormat,
          options.requestId
        );
        videos = reconciled.videos;
        durationExtended = reconciled.durationExtended;
        durationRequirementUnmet = reconciled.durationRequirementUnmet;
      }
    }

    return {
      videos,
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
      ...(audioComposed !== undefined ? { audioComposed } : {}),
      ...(audioRequirementUnmet !== undefined ? { audioRequirementUnmet } : {}),
      ...(durationExtended !== undefined ? { durationExtended } : {}),
      ...(durationRequirementUnmet !== undefined ? { durationRequirementUnmet } : {}),
    };
  }

  /**
   * Reconcile a delivered video's ACTUAL duration against what was
   * requested. Returns the (possibly extended) video list plus honest
   * status flags — never throws, and never silently claims success on an
   * unmet requirement. Three possible outcomes:
   *  - the shortfall can't be verified (no retrievable bytes yet, e.g. an
   *    async job handle, or the probe itself fails) -> both flags absent.
   *    Unknown is deliberately NOT the same as unmet.
   *  - the clip already meets/exceeds the target (or the shortfall is
   *    within `isMeaningfullyShort`'s tolerance) -> both flags absent.
   *  - a real, meaningful shortfall is confirmed: extension is attempted;
   *    success sets `durationExtended`, failure (toolkit unavailable, safety
   *    cap exceeded, ffmpeg error) sets `durationRequirementUnmet` and ships
   *    the original, unmodified clip.
   */
  private async reconcileVideoDuration(
    videos: VideoResult['videos'],
    targetDurationSec: number,
    responseFormat: 'url' | 'b64_json',
    requestId: string
  ): Promise<{
    videos: VideoResult['videos'];
    durationExtended?: boolean;
    durationRequirementUnmet?: boolean;
  }> {
    const first = videos[0];
    if (!first) return { videos };

    const videoBytes = await this.resolveVideoBytesForDurationCheck(first);
    if (!videoBytes) return { videos };

    let actualDurationSec: number | undefined;
    try {
      actualDurationSec = (await probeMedia(videoBytes, 'generated.mp4')).durationSec;
    } catch (error) {
      log.warn(
        {
          requestId,
          reason: error instanceof Error ? error.message : String(error),
        },
        'Could not probe generated video duration; skipping the extend check'
      );
      return { videos };
    }
    if (actualDurationSec === undefined || !isMeaningfullyShort(actualDurationSec, targetDurationSec)) {
      return { videos };
    }

    try {
      const extended = await extendVideoToDuration(videoBytes, 'generated.mp4', {
        targetDurationSec,
      });
      const composedEntry =
        responseFormat === 'url'
          ? { id: first.id, url: `data:video/mp4;base64,${extended.buffer.toString('base64')}` }
          : { id: first.id, b64_json: extended.buffer.toString('base64') };
      log.info(
        { requestId, requestedSec: targetDurationSec, actualSec: actualDurationSec, loopsApplied: extended.loopsApplied },
        'Extended generated video to meet the requested duration'
      );
      return { videos: [composedEntry, ...videos.slice(1)], durationExtended: true };
    } catch (error) {
      const reason =
        error instanceof MediaToolkitUnavailableError
          ? 'ffmpeg toolkit unavailable'
          : error instanceof Error
            ? error.message
            : String(error);
      log.warn(
        { requestId, reason, requestedSec: targetDurationSec, actualSec: actualDurationSec },
        'Duration extension failed; shipping the original, shorter video'
      );
      return { videos, durationRequirementUnmet: true };
    }
  }

  /**
   * Best-effort soundtrack composition. Returns the composed video list on
   * success, `null` on ANY failure (toolkit unavailable, bad input, mux
   * error) — callers treat `null` as "compose was attempted and failed,
   * ship the original video" rather than propagating the error and failing
   * the whole (otherwise-successful) generation request over an additive
   * enhancement.
   */
  private async tryComposeSoundtrack(
    videos: VideoResult['videos'],
    soundtrackAudioBase64: string,
    responseFormat: 'url' | 'b64_json',
    requestId: string
  ): Promise<VideoResult['videos'] | null> {
    const first = videos[0];
    if (!first) return null;

    try {
      const videoBytes = await this.resolveVideoBytesForCompose(first);
      if (!videoBytes) return null;

      const audioBuffer = Buffer.from(soundtrackAudioBase64, 'base64');
      if (audioBuffer.length === 0) {
        log.warn({ requestId }, 'Soundtrack composition skipped: empty audio payload');
        return null;
      }

      const composed = await muxAudioIntoVideo(
        videoBytes,
        'generated.mp4',
        audioBuffer,
        'soundtrack.audio'
      );

      const composedEntry =
        responseFormat === 'url'
          ? { id: first.id, url: `data:video/mp4;base64,${composed.buffer.toString('base64')}` }
          : { id: first.id, b64_json: composed.buffer.toString('base64') };

      return [composedEntry, ...videos.slice(1)];
    } catch (error) {
      // Fail-soft by design — see the method doc. Still logged at `warn` so
      // operators can see how often composition is attempted vs. succeeds.
      const reason =
        error instanceof MediaToolkitUnavailableError
          ? 'ffmpeg toolkit unavailable'
          : error instanceof Error
            ? error.message
            : String(error);
      log.warn({ requestId, reason }, 'Soundtrack composition failed; shipping original video');
      return null;
    }
  }

  /**
   * Resolve a normalized video entry to raw bytes so it can be probed/
   * extended. Handles `b64_json` directly, a `data:` URL directly, and an
   * `http(s)://` URL via a bounded fetch — that URL was returned by the
   * PROVIDER we just called (not supplied by the end user), so fetching it
   * is not a new SSRF surface distinct from the request already made to
   * reach that provider. Returns `null` (never throws) when nothing usable
   * is present (e.g. an id-only async job handle with no bytes yet).
   *
   * KNOWN COST TRADEOFF: for a `url`-format response (the common case for
   * video, which is why providers return a URL instead of embedding a large
   * base64 payload), this downloads the ENTIRE clip a second time purely to
   * probe its duration — real egress + latency on every call this reaches.
   * The caller already narrows to candidates with no declared duration
   * attributes (see `generateVideo`'s `durationDeclared` guard) to avoid
   * paying this for the 5 vendor-verified providers, but the majority with
   * no declared attributes still pay it — that is the same tradeoff
   * `#529`'s equivalent `resolveVideoBytesForCompose` accepts for its
   * audio-composition check. A future optimization (bounding by a
   * `Content-Length` HEAD check, or reading only enough of a faststart MP4
   * to reach its `moov` atom) is a reasonable follow-up, not done here.
   */
  private async resolveVideoBytesForDurationCheck(video: {
    id?: string;
    url?: string;
    b64_json?: string;
  }): Promise<Buffer | null> {
    try {
      if (video.b64_json) {
        return Buffer.from(video.b64_json, 'base64');
      }
      if (video.url?.startsWith('data:')) {
        const commaIdx = video.url.indexOf(',');
        if (commaIdx === -1) return null;
        return Buffer.from(video.url.slice(commaIdx + 1), 'base64');
      }
      if (video.url?.startsWith('http://') || video.url?.startsWith('https://')) {
        const response = await fetch(video.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return null;
        return Buffer.from(await response.arrayBuffer());
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Resolve a normalized video entry to raw bytes for muxing. Handles
   * `b64_json` directly, a `data:` URL directly, and an `http(s)://` URL via
   * a bounded fetch — that URL was returned by the PROVIDER we just called
   * (not supplied by the end user), so fetching it is not a new SSRF surface
   * distinct from the request we already made to reach that provider.
   * Returns `null` (never throws) when nothing usable is present, matching
   * `tryComposeSoundtrack`'s fail-soft contract.
   */
  private async resolveVideoBytesForCompose(video: {
    id?: string;
    url?: string;
    b64_json?: string;
  }): Promise<Buffer | null> {
    if (video.b64_json) {
      return Buffer.from(video.b64_json, 'base64');
    }
    if (video.url?.startsWith('data:')) {
      const commaIdx = video.url.indexOf(',');
      if (commaIdx === -1) return null;
      return Buffer.from(video.url.slice(commaIdx + 1), 'base64');
    }
    if (video.url?.startsWith('http://') || video.url?.startsWith('https://')) {
      const response = await fetch(video.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    // An id-only entry (async job handle with no retrievable bytes yet) —
    // nothing to compose against.
    return null;
  }
}
