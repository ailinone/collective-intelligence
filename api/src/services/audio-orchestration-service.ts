// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Audio Orchestration Service
 * Orchestrates TTS, STT, and Audio Translation across multiple providers
 * 
 * Features:
 * - Dynamic model selection based on capabilities (text_to_speech, speech_to_text)
 * - Multi-provider orchestration (OpenAI, Google, ElevenLabs, etc.)
 * - Automatic failover on provider failures
 * - Format conversion and streaming support
 * 
 * NO HARDCODED MODELS - All selection is dynamic via model discovery
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import { normalizeStrategy, resolveFallbackDeadlineMs, diversifyProviders } from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { ProviderAdapter } from '@/providers/base/provider-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { resolveAilinAlias } from '@/core/orchestration/ailin-alias-resolver';
import { modelPerformanceTracker } from '@/core/selection/model-performance-tracker';
import { ValidationError } from '@/utils/custom-errors';
import { narrowAs } from '@/utils/type-guards';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';

const log = logger.child({ service: 'audio-orchestration' });

// ============================================
// Types
// ============================================

export interface TTSOptions {
  text: string;
  model?: string; // undefined = auto-select
  voice?: string;
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface TTSResult {
  audioBuffer: Buffer;
  modelUsed: string;
  provider: string;
  durationMs: number;
  format: string;
  strategyUsed?: string;
  fallbackUsed?: boolean;
  /**
   * Per-candidate attempt log. Aligned with STTResult.attempts and
   * TranslationResult.attempts on the primitive's CandidateAttempt
   * shape (errorClass, statusCode, modelId) — supersedes the old
   * { model, provider, status, durationMs, error? } shape. Service-
   * level observability only; the audio route's response headers
   * expose only modelUsed/provider/durationMs.
   */
  attempts?: CandidateAttempt[];
}

export interface STTOptions {
  audioBuffer: Buffer;
  filename: string;
  model?: string; // undefined = auto-select
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
  timestampGranularities?: ('word' | 'segment')[];
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface STTResult {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }>;
  srt?: string;
  vtt?: string;
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

export interface TranslationOptions {
  audioBuffer: Buffer;
  filename: string;
  model?: string; // undefined = auto-select
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface TranslationResult {
  text: string;
  duration?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
  srt?: string;
  vtt?: string;
  modelUsed: string;
  provider: string;
  durationMs: number;
  strategyUsed?: string;
  fallbackUsed?: boolean;
  /**
   * Per-candidate attempt log. Aligned with STTResult.attempts on the
   * primitive's CandidateAttempt shape (errorClass, statusCode, modelId)
   * — supersedes the old { model, provider, status, durationMs, error? }
   * shape. The audio route's `_ailin` envelope does not currently expose
   * this field; service-level observability only.
   */
  attempts?: CandidateAttempt[];
}

// ============================================
// Audio Orchestration Service
// ============================================

export class AudioOrchestrationService {
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
    if (typeof model.performance?.quality === 'number' && Number.isFinite(model.performance.quality)) {
      return model.performance.quality;
    }
    const metadata = model.metadata && typeof model.metadata === 'object' ? model.metadata : {};
    const metadataQuality = (metadata as Record<string, unknown>).quality;
    if (typeof metadataQuality === 'number' && Number.isFinite(metadataQuality)) {
      return metadataQuality;
    }
    return 0.5;
  }

  private getModelLatencyMs(model: Model): number {
    if (typeof model.performance?.latencyMs === 'number' && Number.isFinite(model.performance.latencyMs)) {
      return model.performance.latencyMs;
    }
    const metadata = model.metadata && typeof model.metadata === 'object' ? model.metadata : {};
    const providerMetadata = (metadata as Record<string, unknown>).provider_metadata;
    if (providerMetadata && typeof providerMetadata === 'object') {
      const avgLatency = (providerMetadata as Record<string, unknown>).avgLatency;
      if (typeof avgLatency === 'number' && Number.isFinite(avgLatency)) {
        return avgLatency;
      }
    }
    return 2000;
  }

  private sortModelsByStrategy(
    models: Model[],
    strategy: 'single' | 'cost' | 'speed' | 'quality' | 'balanced' | 'parallel' | 'debate' | 'quality_multipass' | 'dynamic',
    userContext: OrchestrationContext
  ): Model[] {
    const sorted = [...models];

    // LATENCY OPT: Pre-fetch empirical scores for all candidates (single Map lookup)
    const empiricalScores = modelPerformanceTracker.getScores(sorted.map(m => m.id));

    sorted.sort((a, b) => {
      const costA = this.getModelAverageCostPer1k(a);
      const costB = this.getModelAverageCostPer1k(b);

      // Use empirical data when available (more accurate than static DB values)
      const empA = empiricalScores.get(a.id);
      const empB = empiricalScores.get(b.id);
      const qualityA = empA && empA.sampleCount >= 5 ? empA.rollingQuality : this.getModelQuality(a);
      const qualityB = empB && empB.sampleCount >= 5 ? empB.rollingQuality : this.getModelQuality(b);
      const latencyA = empA && empA.sampleCount >= 5 ? empA.rollingLatencyP50 : this.getModelLatencyMs(a);
      const latencyB = empB && empB.sampleCount >= 5 ? empB.rollingLatencyP50 : this.getModelLatencyMs(b);

      // LATENCY OPT: Heavily penalize models with high error rates
      const errorPenaltyA = empA && empA.errorRate > 0.3 ? 1000000 : 0;
      const errorPenaltyB = empB && empB.errorRate > 0.3 ? 1000000 : 0;
      if (errorPenaltyA !== errorPenaltyB) return errorPenaltyA - errorPenaltyB;

      if (strategy === 'cost') {
        if (costA !== costB) return costA - costB;
        if (qualityA !== qualityB) return qualityB - qualityA;
        return latencyA - latencyB;
      }

      if (strategy === 'speed') {
        if (latencyA !== latencyB) return latencyA - latencyB;
        if (costA !== costB) return costA - costB;
        return qualityB - qualityA;
      }

      if (strategy === 'quality' || strategy === 'quality_multipass' || strategy === 'debate') {
        if (qualityA !== qualityB) return qualityB - qualityA;
        if (latencyA !== latencyB) return latencyA - latencyB;
        return costA - costB;
      }

      // balanced / dynamic / single / parallel
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
      if (qualityA !== qualityB) return qualityB - qualityA;
      return costA - costB;
    });
    return sorted;
  }


  // Note: toErrorMessage + createCapabilityNotOperationalError were
  // removed when synthesizeSpeech migrated to executeWithFallback. The
  // primitive's tryCandidate handles error classification (errorClass,
  // statusCode) and adapter-resolution failures, replacing the manual
  // capability-not-operational construction that lived in the bespoke
  // per-method loops. See commits 9764759 / acab45f for the parallel STT
  // and translation migrations.

  private isAdapterMethodImplemented(
    adapter: ProviderAdapter,
    methodName: 'textToSpeech' | 'speechToText'
  ): boolean {
    // Adapter instances and their prototypes are plain objects with named
    // members — route the structural narrow through `narrowAs<Record<...>>`
    // so the lint rule against `as unknown as` stays green and the cast is
    // documented at one auditable site (the helper itself).
    const method = narrowAs<Record<string, unknown>>(adapter)[methodName];
    const baseMethod = narrowAs<Record<string, unknown>>(ProviderAdapter.prototype)[methodName];
    return typeof method === 'function' && method !== baseMethod;
  }

  private filterModelsByAdapterMethod(
    models: Model[],
    methodName: 'textToSpeech' | 'speechToText'
  ): Model[] {
    const providerRegistry = this.getRegistry();
    return models.filter((model) => {
      const resolution = providerRegistry.resolveAdapterForModel(model);
      if (!resolution.adapter) return false;
      return this.isAdapterMethodImplemented(resolution.adapter, methodName);
    });
  }

  /**
   * Synthesize speech (TTS)
   * Dynamically selects best TTS model based on language, voice, and quality
   *
   * DUP #2 phase 2b: the 3 audio methods now delegate to the shared
   * `runModalityFallback` driver, which was extended with a `parallelDegree`
   * pass-through (audio races the top candidates for cold-start amortization)
   * and an `onFallbackExhausted` hook (audio re-packages FallbackExhaustedError
   * as a deliberate **422** `capability_dependency_unavailable` — NOT the
   * driver's default 503 — so the gateway does not retry slow audio inference).
   * Only candidate selection, the per-modality execute hook (with its timeout),
   * and the result-envelope mapping remain audio-specific.
   */
  async synthesizeSpeech(options: TTSOptions): Promise<TTSResult> {
    const startTime = Date.now();
    const {
      text,
      model,
      voice,
      format = 'mp3',
      speed = 1.0,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      { requestId, model, textLength: text.length, voice, format, strategy: strategyUsed, allowFallback },
      'TTS orchestration started'
    );

    const candidates = await this.selectTTSCandidateModels(
      model,
      voice,
      userContext,
      strategyUsed
    );

    if (candidates.length === 0) {
      throw new ValidationError(
        'No TTS models available. Ensure at least one provider with text_to_speech capability is configured.',
        { capability: 'text_to_speech' }
      );
    }

    // Race top 3 when fallback is allowed (cold-start amortization).
    const parallelDegree = allowFallback ? Math.min(3, candidates.length) : 1;

    // DUP #2: executeWithFallback + cost + completion log + NoFallback→Validation
    // are owned by the shared runModalityFallback driver. Audio keeps its
    // parallelDegree racing and the deliberate 422-on-exhaustion (vs the driver's
    // default 503) via the onFallbackExhausted hook.
    const result = await runModalityFallback<
      Awaited<ReturnType<ProviderAdapter['textToSpeech']>>
    >({
      capability: [
        'text_to_speech' as ModelCapability,
        'tts' as ModelCapability,
        'audio_generation' as ModelCapability,
        'audio_output' as ModelCapability,
      ],
      capabilityLabel: 'text_to_speech',
      explicit: model ?? null,
      maxCandidates: candidates.length,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      catalog: candidates,
      supportsCapability: (adapter) =>
        this.isAdapterMethodImplemented(adapter, 'textToSpeech'),
      parallelDegree,
      execute: async (selectedModel, adapter) => {
        // TTS timeouts are tighter than STT: native TTS responds in ~300ms once
        // warm, so 8s catches genuine slow paths. Self-hosted retains 30s.
        const isSelfHosted =
          selectedModel.provider === 'self-hosted' ||
          selectedModel.providerId === 'self-hosted';
        const TTS_TIMEOUT_MS = isSelfHosted ? 30000 : 8000;
        return Promise.race([
          adapter.textToSpeech(selectedModel, {
            text,
            voice,
            format,
            options: { speed },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`TTS timeout after ${TTS_TIMEOUT_MS}ms`)),
              TTS_TIMEOUT_MS
            )
          ),
        ]);
      },
      onFallbackExhausted: (error, durationMs) => {
        log.error(
          { requestId, attempts: error.attempts, durationMs },
          'TTS exhausted all candidates'
        );
        // Re-package as 422 to suppress route-layer retry on slow audio inference.
        const repackaged = new Error(error.message) as Error & {
          statusCode: number;
          code: string;
          details: Record<string, unknown>;
        };
        repackaged.statusCode = 422;
        repackaged.code = 'capability_dependency_unavailable';
        repackaged.details = {
          capability: 'text_to_speech',
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

    const ttsResponse = result.response;
    return {
      audioBuffer: ttsResponse.audio,
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      format: ttsResponse.format,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }

  /**
   * Transcribe audio (STT)
   * Dynamically selects best STT model based on language and audio quality.
   *
   * Migrated to executeWithFallback (2026-04-30). The audio-specific
   * pre-ranking (circuit-breaker health filter, native-STT preference,
   * empirical performance scoring, language-match boost, ailin-* alias
   * resolution) stays in `selectSTTCandidateModels` — its output is the
   * input order to the primitive. The primitive's tier sort is order-stable
   * so within-tier our preference survives. Cold-start latency is
   * preserved by setting parallelDegree=3 (race top three candidates with
   * Promise.any semantics; first success wins).
   *
   * Why this returns 422 on exhaustion (not 503): audio inference is slow
   * and route-level retries amplify the wait. 422 signals the gateway not
   * to retry. Other capability routes use 503, but those are cheap to
   * retry. We re-package the primitive's FallbackExhaustedError on the way
   * out to preserve this contract.
   */
  async transcribeAudio(options: STTOptions): Promise<STTResult> {
    const startTime = Date.now();
    const {
      audioBuffer,
      filename,
      model,
      language,
      prompt,
      responseFormat = 'json',
      temperature = 0,
      timestampGranularities,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      { requestId, model, filename, language, format: responseFormat, strategy: strategyUsed, allowFallback },
      'STT orchestration started'
    );

    const candidates = await this.selectSTTCandidateModels(
      model,
      language,
      userContext,
      strategyUsed
    );

    if (candidates.length === 0) {
      throw new ValidationError(
        'No STT models available. Ensure at least one provider with speech_to_text capability is configured.',
        { capability: 'speech_to_text' }
      );
    }

    const parallelDegree = allowFallback ? Math.min(3, candidates.length) : 1;

    const result = await runModalityFallback<
      Awaited<ReturnType<ProviderAdapter['speechToText']>>
    >({
      capability: ['speech_to_text' as ModelCapability, 'transcription' as ModelCapability],
      capabilityLabel: 'speech_to_text',
      explicit: model ?? null,
      maxCandidates: candidates.length,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      catalog: candidates,
      supportsCapability: (adapter) =>
        this.isAdapterMethodImplemented(adapter, 'speechToText'),
      parallelDegree,
      execute: async (selectedModel, adapter) => {
        const isSelfHostedSTT =
          selectedModel.provider === 'self-hosted' ||
          selectedModel.providerId === 'self-hosted';
        const STT_TIMEOUT_MS = isSelfHostedSTT ? 30000 : 12000;
        return Promise.race([
          adapter.speechToText(selectedModel, {
            audio: audioBuffer,
            language,
            options: { prompt, responseFormat, temperature, timestampGranularities },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`STT timeout after ${STT_TIMEOUT_MS}ms`)),
              STT_TIMEOUT_MS
            )
          ),
        ]);
      },
      onFallbackExhausted: (error, durationMs) => {
        log.error(
          { requestId, attempts: error.attempts, durationMs },
          'STT exhausted all candidates'
        );
        const repackaged = new Error(error.message) as Error & {
          statusCode: number;
          code: string;
          details: Record<string, unknown>;
        };
        repackaged.statusCode = 422;
        repackaged.code = 'capability_dependency_unavailable';
        repackaged.details = {
          capability: 'speech_to_text',
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

    const sttResponse = result.response;
    const selectedModel = result.selectedModel;

    // ----- response shape conversion (preserved verbatim) -----
    let srt: string | undefined;
    let vtt: string | undefined;

    // Type guard for raw response with segments
    const rawWithSegments =
      sttResponse.raw && typeof sttResponse.raw === 'object' && 'segments' in sttResponse.raw
        ? (sttResponse.raw as {
            segments?: unknown;
            language?: string;
            duration?: number;
            words?: unknown;
          })
        : null;

    const segmentsArray =
      rawWithSegments?.segments && Array.isArray(rawWithSegments.segments)
        ? rawWithSegments.segments
        : undefined;

    if (responseFormat === 'srt' && segmentsArray) {
      srt = this.convertToSRT(segmentsArray);
    } else if (responseFormat === 'vtt' && segmentsArray) {
      vtt = this.convertToVTT(segmentsArray);
    }

    // Type guard for words (array of word objects)
    const wordsArray =
      rawWithSegments?.words && Array.isArray(rawWithSegments.words)
        ? (rawWithSegments.words as Array<{ word: string; start: number; end: number }>)
        : undefined;

    return {
      text: sttResponse.text,
      language: rawWithSegments?.language,
      duration: rawWithSegments?.duration,
      words: wordsArray,
      segments: segmentsArray as STTResult['segments'],
      srt,
      vtt,
      modelUsed: selectedModel.name,
      provider: selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }

  /**
   * Translate audio (to English)
   * Dynamically selects best translation model
   */
  async translateAudio(options: TranslationOptions): Promise<TranslationResult> {
    const startTime = Date.now();
    const {
      audioBuffer,
      filename,
      model,
      prompt,
      responseFormat = 'json',
      temperature = 0,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      { requestId, model, filename, format: responseFormat, strategy: strategyUsed, allowFallback },
      'Translation orchestration started'
    );

    const candidates = await this.selectTranslationCandidateModels(
      model,
      userContext,
      strategyUsed
    );

    if (candidates.length === 0) {
      throw new ValidationError(
        'No translation models available. Ensure at least one provider with speech_to_text capability is configured.',
        { capability: 'audio_translation' }
      );
    }

    const parallelDegree = allowFallback ? Math.min(3, candidates.length) : 1;

    const result = await runModalityFallback<
      Awaited<ReturnType<ProviderAdapter['speechToText']>>
    >({
      capability: ['speech_to_text' as ModelCapability, 'transcription' as ModelCapability],
      capabilityLabel: 'audio_translation',
      explicit: model ?? null,
      maxCandidates: candidates.length,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      catalog: candidates,
      supportsCapability: (adapter) =>
        this.isAdapterMethodImplemented(adapter, 'speechToText'),
      parallelDegree,
      execute: async (selectedModel, adapter) => {
        const isSelfHostedSTT =
          selectedModel.provider === 'self-hosted' ||
          selectedModel.providerId === 'self-hosted';
        const TRANSLATE_TIMEOUT_MS = isSelfHostedSTT ? 30000 : 12000;
        return Promise.race([
          adapter.speechToText(selectedModel, {
            audio: audioBuffer,
            language: 'en', // Translation always targets English
            options: { prompt, responseFormat, temperature },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Translation timeout after ${TRANSLATE_TIMEOUT_MS}ms`)),
              TRANSLATE_TIMEOUT_MS
            )
          ),
        ]);
      },
      onFallbackExhausted: (error, durationMs) => {
        log.error(
          { requestId, attempts: error.attempts, durationMs },
          'Translation exhausted all candidates'
        );
        const repackaged = new Error(error.message) as Error & {
          statusCode: number;
          code: string;
          details: Record<string, unknown>;
        };
        repackaged.statusCode = 422;
        repackaged.code = 'capability_dependency_unavailable';
        repackaged.details = {
          capability: 'audio_translation',
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

    const translationResponse = result.response;
    const selectedModel = result.selectedModel;

    // ----- response shape conversion (preserved verbatim) -----
    let srt: string | undefined;
    let vtt: string | undefined;

    // Type guard for raw response with segments
    const rawWithSegments =
      translationResponse.raw && typeof translationResponse.raw === 'object' && 'segments' in translationResponse.raw
        ? (translationResponse.raw as { segments?: unknown; duration?: number })
        : null;

    if (responseFormat === 'srt' && rawWithSegments?.segments && Array.isArray(rawWithSegments.segments)) {
      srt = this.convertToSRT(rawWithSegments.segments);
    } else if (responseFormat === 'vtt' && rawWithSegments?.segments && Array.isArray(rawWithSegments.segments)) {
      vtt = this.convertToVTT(rawWithSegments.segments);
    }

    const segmentsArray =
      rawWithSegments?.segments && Array.isArray(rawWithSegments.segments)
        ? (rawWithSegments.segments as Array<{ id: number; start: number; end: number; text: string }>)
        : undefined;

    return {
      text: translationResponse.text,
      duration: rawWithSegments?.duration,
      segments: segmentsArray,
      srt,
      vtt,
      modelUsed: selectedModel.name,
      provider: selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }

  // ============================================
  // Private Methods - Dynamic Model Selection
  // ============================================

  /**
   * Build ranked TTS candidates dynamically (multi-provider + strategy-aware)
   */
  private async selectTTSCandidateModels(
    explicitModel: string | undefined,
    voice: string | undefined,
    userContext: OrchestrationContext,
    strategy: 'single' | 'cost' | 'speed' | 'quality' | 'balanced' | 'parallel' | 'debate' | 'quality_multipass' | 'dynamic'
  ): Promise<Model[]> {
    // Resolve ailin-* aliases (e.g., 'ailin-tts-quality' → strategy:quality, quality_target:0.95)
    if (explicitModel?.startsWith('ailin-')) {
      const profile = resolveAilinAlias(explicitModel);
      if (profile) {
        log.info({ alias: explicitModel, strategy: profile.strategy, preferSpeed: profile.prefer_speed }, 'Resolved audio alias');
        if (profile.strategy) strategy = profile.strategy as typeof strategy;
        if (profile.prefer_speed) strategy = 'speed';
        explicitModel = undefined;
      }
    }

    if (explicitModel) {
      // Search TTS-capable models with separate queries (OR semantics via Promise.all)
      const [primary, secondary, byTag] = await Promise.all([
        this.modelRepo.searchModels({ capabilities: ['text_to_speech' as ModelCapability], limit: 500 }),
        this.modelRepo.searchModels({ capabilities: ['tts' as ModelCapability], limit: 200 }),
        this.modelRepo.searchModels({ tags: [explicitModel], limit: 10 }),
      ]);
      const allModels = [...primary, ...secondary, ...byTag];
      const model = allModels.find((entry) => entry.name === explicitModel || entry.id === explicitModel);
      if (!model || !this.hasTTSCapability(model)) {
        throw new ValidationError(
          `Model ${explicitModel} not found or does not support TTS`,
          { modelId: explicitModel, capability: 'text_to_speech' }
        );
      }
      const runnable = this.filterModelsByAdapterMethod([model], 'textToSpeech');
      if (runnable.length === 0) {
        throw new ValidationError(
          `Model ${explicitModel} does not expose an operational textToSpeech adapter`,
          { modelId: explicitModel, capability: 'text_to_speech', reason: 'adapter_not_operational' }
        );
      }
      return runnable;
    }

    const [ttsModelsPrimary, ttsModelsSecondary, ttsModelsFallback] = await Promise.all([
      this.modelRepo.searchModels({
        capabilities: ['text_to_speech' as ModelCapability],
        status: 'active',
      }),
      this.modelRepo.searchModels({
        capabilities: ['tts' as ModelCapability],
        status: 'active',
      }),
      this.modelRepo.searchModels({
        capabilities: ['audio_generation' as ModelCapability],
        status: 'active',
      }),
    ]);

    const merged = [...ttsModelsPrimary, ...ttsModelsSecondary, ...ttsModelsFallback].filter((model) =>
      this.hasTTSCapability(model)
    );
    const uniqueModels = Array.from(new Map(merged.map((model) => [model.id, model])).values());

    // QUALITY FIX: Exclude models that are clearly STT-only (misclassified with text_to_speech)
    // Models with "transcribe", "whisper", "listen", "scribe" in name are STT, not TTS
    const STT_NAME_PATTERNS = /transcrib|whisper|listen|scribe|diarize/i;
    const ttsOnly = uniqueModels.filter(m => !STT_NAME_PATTERNS.test(m.name || m.id));
    const modelsToFilter = ttsOnly.length > 0 ? ttsOnly : uniqueModels; // fallback

    const runnableModels = this.filterModelsByAdapterMethod(modelsToFilter, 'textToSpeech');
    if (runnableModels.length === 0) return [];

    // TIER FILTER: Prefer native TTS models (Cartesia, ElevenLabs) over multimodal chat models
    const nativeTTSModels = runnableModels.filter(m => this.isNativeTTSModel(m));
    const modelsForHealth = nativeTTSModels.length > 0 ? nativeTTSModels : runnableModels;

    // LATENCY OPT: Skip providers with OPEN circuit breakers (avoids 5-15s timeout cascade)
    const healthyModels = this.filterByCircuitBreakerHealth(modelsForHealth);
    const modelsToRank = healthyModels.length > 0 ? healthyModels : modelsForHealth; // Fallback to all if none healthy

    let ranked = this.sortModelsByStrategy(modelsToRank, strategy, userContext);
    if (voice) {
      ranked = ranked.sort((a, b) => {
        const voiceA = (a.metadata?.supported_voices as string[] | undefined) ?? [];
        const voiceB = (b.metadata?.supported_voices as string[] | undefined) ?? [];
        const aMatch = voiceA.includes(voice) ? 1 : 0;
        const bMatch = voiceB.includes(voice) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return 0;
      });
    }

    // No truncation — see resolveFallbackDeadlineMs doc. The full ranked,
    // diversified pool is offered; search depth is governed by the caller's
    // deadlineMs, not by how many providers happen to exist today.
    return diversifyProviders(ranked);
  }

  /**
   * Build ranked STT candidates dynamically (multi-provider + strategy-aware)
   */
  private async selectSTTCandidateModels(
    explicitModel: string | undefined,
    language: string | undefined,
    userContext: OrchestrationContext,
    strategy: 'single' | 'cost' | 'speed' | 'quality' | 'balanced' | 'parallel' | 'debate' | 'quality_multipass' | 'dynamic'
  ): Promise<Model[]> {
    // Resolve ailin-* aliases (e.g., 'ailin-stt-fast' → strategy:speed, prefer_speed:true)
    if (explicitModel?.startsWith('ailin-')) {
      const profile = resolveAilinAlias(explicitModel);
      if (profile) {
        log.info({ alias: explicitModel, strategy: profile.strategy, preferSpeed: profile.prefer_speed }, 'Resolved audio alias');
        // Override strategy from alias profile
        if (profile.strategy) strategy = profile.strategy as typeof strategy;
        if (profile.prefer_speed) strategy = 'speed';
        // Don't pass explicitModel further — let auto-selection work with the alias profile
        explicitModel = undefined;
      }
    }

    if (explicitModel) {
      const [primary, secondary, byTag] = await Promise.all([
        this.modelRepo.searchModels({ capabilities: ['speech_to_text' as ModelCapability], limit: 500 }),
        this.modelRepo.searchModels({ capabilities: ['listen' as ModelCapability], limit: 200 }),
        this.modelRepo.searchModels({ tags: [explicitModel], limit: 10 }),
      ]);
      const allModels = [...primary, ...secondary, ...byTag];
      const model = allModels.find((entry) => entry.name === explicitModel || entry.id === explicitModel);
      if (!model || !this.hasSTTCapability(model)) {
        throw new ValidationError(
          `Model ${explicitModel} not found or does not support STT`,
          { modelId: explicitModel, capability: 'speech_to_text' }
        );
      }
      const runnable = this.filterModelsByAdapterMethod([model], 'speechToText');
      if (runnable.length === 0) {
        throw new ValidationError(
          `Model ${explicitModel} does not expose an operational speechToText adapter`,
          { modelId: explicitModel, capability: 'speech_to_text', reason: 'adapter_not_operational' }
        );
      }
      return runnable;
    }

    const [sttPrimary, sttSecondary, sttTertiary] = await Promise.all([
      this.modelRepo.searchModels({
        capabilities: ['speech_to_text' as ModelCapability],
        status: 'active',
      }),
      this.modelRepo.searchModels({
        capabilities: ['transcription' as ModelCapability],
        status: 'active',
      }),
      this.modelRepo.searchModels({
        capabilities: ['audio_input' as ModelCapability],
        status: 'active',
      }),
    ]);

    const merged = [...sttPrimary, ...sttSecondary, ...sttTertiary].filter((model) =>
      this.hasSTTCapability(model)
    );
    const uniqueModels = Array.from(new Map(merged.map((model) => [model.id, model])).values());
    const runnableModels = this.filterModelsByAdapterMethod(uniqueModels, 'speechToText');
    if (runnableModels.length === 0) return [];

    // TIER FILTER: Prefer native STT models (Deepgram, Whisper) over multimodal chat models (GPT-4o)
    // This prevents selecting 4000+ chat models that were incorrectly tagged with speech_to_text
    const nativeSTTModels = runnableModels.filter(m => this.isNativeSTTModel(m));
    const modelsForRanking = nativeSTTModels.length > 0 ? nativeSTTModels : runnableModels;

    // LATENCY OPT: Skip providers with OPEN circuit breakers
    const healthyModels = this.filterByCircuitBreakerHealth(modelsForRanking);
    const modelsToRank = healthyModels.length > 0 ? healthyModels : runnableModels;

    let ranked = this.sortModelsByStrategy(modelsToRank, strategy, userContext);
    if (language) {
      ranked = ranked.sort((a, b) => {
        const languagesA = (a.metadata?.supported_languages as string[] | undefined) ?? [];
        const languagesB = (b.metadata?.supported_languages as string[] | undefined) ?? [];
        const aMatch = languagesA.includes(language) ? 1 : 0;
        const bMatch = languagesB.includes(language) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return 0;
      });
    }

    // No truncation — see resolveFallbackDeadlineMs doc. The full ranked,
    // diversified pool is offered; search depth is governed by the caller's
    // deadlineMs, not by how many providers happen to exist today.
    return diversifyProviders(ranked);
  }

  /**
   * Build ranked translation candidates dynamically (translation via STT stack)
   */
  private async selectTranslationCandidateModels(
    explicitModel: string | undefined,
    userContext: OrchestrationContext,
    strategy: 'single' | 'cost' | 'speed' | 'quality' | 'balanced' | 'parallel' | 'debate' | 'quality_multipass' | 'dynamic'
  ): Promise<Model[]> {
    if (explicitModel) {
      const [primary, secondary, byTag] = await Promise.all([
        this.modelRepo.searchModels({ capabilities: ['speech_to_text' as ModelCapability], limit: 500 }),
        this.modelRepo.searchModels({ capabilities: ['listen' as ModelCapability], limit: 200 }),
        this.modelRepo.searchModels({ tags: [explicitModel], limit: 10 }),
      ]);
      const allModels = [...primary, ...secondary, ...byTag];
      const model = allModels.find((entry) => entry.name === explicitModel || entry.id === explicitModel);
      if (!model || !this.hasSTTCapability(model)) {
        throw new ValidationError(
          `Model ${explicitModel} not found or does not support translation`,
          { modelId: explicitModel, capability: 'audio_translation' }
        );
      }
      const runnable = this.filterModelsByAdapterMethod([model], 'speechToText');
      if (runnable.length === 0) {
        throw new ValidationError(
          `Model ${explicitModel} does not expose an operational speechToText adapter`,
          { modelId: explicitModel, capability: 'audio_translation', reason: 'adapter_not_operational' }
        );
      }
      return runnable;
    }

    const [translationPrimary, translationFallback] = await Promise.all([
      this.modelRepo.searchModels({
        capabilities: ['transcription' as ModelCapability],
        status: 'active',
      }),
      this.modelRepo.searchModels({
        capabilities: ['speech_to_text' as ModelCapability],
        status: 'active',
      }),
    ]);

    const merged = [...translationPrimary, ...translationFallback].filter((model) =>
      this.hasSTTCapability(model)
    );
    const uniqueModels = Array.from(new Map(merged.map((model) => [model.id, model])).values());
    const runnableModels = this.filterModelsByAdapterMethod(uniqueModels, 'speechToText');
    if (runnableModels.length === 0) return [];

    const ranked = this.sortModelsByStrategy(runnableModels, strategy, userContext);
    // No truncation — see resolveFallbackDeadlineMs doc. The full ranked,
    // diversified pool is offered; search depth is governed by the caller's
    // deadlineMs, not by how many providers happen to exist today.
    return diversifyProviders(ranked);
  }

  /**
   * LATENCY OPT: Filter out models whose provider has an OPEN circuit breaker.
   * Avoids wasting 5-15s retrying providers that are known to be down.
   * Falls back gracefully: if all providers are unhealthy, returns empty
   * so the caller can use the full unfiltered list.
   */
  private filterByCircuitBreakerHealth(models: Model[]): Model[] {
    // Sync filter — check local circuit breaker state (no Redis call)
    // Use high threshold (5+ failures AND OPEN state) to avoid over-filtering.
    // A single model failure shouldn't block the entire provider.
    const seenProviders = new Map<string, boolean>();

    return models.filter(model => {
      const providerName = model.provider || model.providerId;
      if (!providerName) return true;

      if (seenProviders.has(providerName)) return seenProviders.get(providerName)!;

      try {
        const breaker = distributedCircuitBreakerManager.getBreaker(`${providerName}-api`);
        // `localState` is a private member used as a debug surface — narrow
        // through `narrowAs<>` to keep the cast lint-clean while documenting
        // the boundary at a single, grep-able call site.
        const localState = narrowAs<{ localState?: { state: string; consecutiveFailures: number } }>(breaker).localState;
        // Only skip if circuit is fully OPEN with 5+ consecutive failures
        // This prevents over-filtering when only some models of a provider fail
        if (localState && localState.state === 'OPEN' && localState.consecutiveFailures >= 5) {
          log.debug({ provider: providerName, state: localState.state, failures: localState.consecutiveFailures }, 'Skipping unhealthy provider (OPEN + 5+ failures)');
          seenProviders.set(providerName, false);
          return false;
        }
        seenProviders.set(providerName, true);
        return true;
      } catch {
        seenProviders.set(providerName, true);
        return true;
      }
    });
  }

  /**
   * Check if model has TTS capability
   */
  private hasTTSCapability(model: Model): boolean {
    return (
      model.capabilities.includes('text_to_speech' as ModelCapability) ||
      model.capabilities.includes('tts' as ModelCapability) ||
      model.capabilities.includes('audio_generation' as ModelCapability) ||
      model.capabilities.includes('audio_output' as ModelCapability)
    );
  }

  /**
   * Check if model has STT capability
   */
  private hasSTTCapability(model: Model): boolean {
    return (
      model.capabilities.includes('speech_to_text' as ModelCapability) ||
      model.capabilities.includes('transcription' as ModelCapability) ||
      model.capabilities.includes('audio_input' as ModelCapability) ||
      model.capabilities.includes('listen' as ModelCapability) ||
      model.capabilities.includes('diarization' as ModelCapability) ||
      model.capabilities.includes('video_to_text' as ModelCapability) ||
      model.capabilities.includes('video_transcription' as ModelCapability)
    );
  }

  /**
   * Check if model is a NATIVE STT model (dedicated endpoint, not multimodal chat).
   * Prevents selecting GPT-4o/Gemini when Deepgram/Whisper are available.
   */
  private isNativeSTTModel(model: Model): boolean {
    const provider = (model.provider || '').toLowerCase();
    const modelId = (model.id || model.name || '').toLowerCase();

    // Known native STT providers
    if (['deepgram', 'self-hosted'].includes(provider)) return true;

    // Known native STT model patterns
    if (/\b(whisper|nova-\d|faster-whisper|sherpa|moonshine|sensevoice)\b/i.test(modelId)) return true;

    // OpenAI whisper models
    if (provider === 'openai' && modelId.includes('whisper')) return true;

    // Models that declare audio_transcriptions as explicit endpoint
    const endpoints = model.metadata?.endpoints as string[] | undefined;
    if (endpoints?.some(e => e.includes('audio/transcriptions') || e.includes('listen'))) return true;

    return false;
  }

  /**
   * Check if model is a NATIVE TTS model (dedicated endpoint, not multimodal).
   */
  private isNativeTTSModel(model: Model): boolean {
    const provider = (model.provider || '').toLowerCase();
    const modelId = (model.id || model.name || '').toLowerCase();

    if (['cartesia', 'elevenlabs', 'deepgram', 'self-hosted'].includes(provider)) return true;
    if (/\b(tts|piper|kokoro|melotts|cosyvoice|sonic|aura|xtts|fish-speech)\b/i.test(modelId)) return true;
    if (provider === 'openai' && modelId.includes('tts')) return true;

    return false;
  }

  // ============================================
  // Format Conversion Helpers
  // ============================================

  /**
   * Convert segments to SRT format
   */
  private convertToSRT(segments: unknown[]): string {
    return segments
      .map((seg, index) => {
        if (typeof seg !== 'object' || seg === null || !('start' in seg) || !('end' in seg) || !('text' in seg)) {
          return '';
        }
        const typedSeg = seg as { start: number; end: number; text: string };
        const startTime = this.formatSRTTime(typedSeg.start);
        const endTime = this.formatSRTTime(typedSeg.end);
        return `${index + 1}\n${startTime} --> ${endTime}\n${typedSeg.text.trim()}\n`;
      })
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Convert segments to VTT format
   */
  private convertToVTT(segments: unknown[]): string {
    const header = 'WEBVTT\n\n';
    const body = segments
      .map((seg) => {
        if (typeof seg !== 'object' || seg === null || !('start' in seg) || !('end' in seg) || !('text' in seg)) {
          return '';
        }
        const typedSeg = seg as { start: number; end: number; text: string };
        const startTime = this.formatVTTTime(typedSeg.start);
        const endTime = this.formatVTTTime(typedSeg.end);
        return `${startTime} --> ${endTime}\n${typedSeg.text.trim()}\n`;
      })
      .filter(Boolean)
      .join('\n');
    return header + body;
  }

  private formatSRTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${millis.toString().padStart(3, '0')}`;
  }

  private formatVTTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
  }
}

