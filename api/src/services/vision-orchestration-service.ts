// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vision Orchestration Service (LOTE AP, 2026-09-05)
 *
 * The native-adapter execution path for `vision` and its two task-level
 * narrower capabilities, `image_captioning` and `visual_question_answering`.
 *
 * ### Why this exists
 *
 * All three capabilities already DECLARED `executionPath:
 * ['native_adapter', 'orchestration']` in the capability registry, but
 * `executeNativeAdapterMode` had no branch for any of them — so every request
 * threw `No native adapter executor available`, burned a logged failed
 * attempt, and only then fell through to generic chat orchestration. The
 * declared path was fiction.
 *
 * `ProviderAdapter.vision()` has been a real, working implementation the
 * whole time (it normalizes the image into a data URL / http URL and issues a
 * multimodal `chatCompletion`), with genuine overrides on OpenAI, OpenRouter,
 * BytePlus and the OAI-compatible hub. This service is the missing driver in
 * front of it: catalog-by-capability candidate pool → strategy ranking →
 * provider diversification → `runModalityFallback`, exactly like
 * images/audio/video.
 *
 * ### Captioning and VQA are prompt framing, not new pipelines
 *
 * A captioner and a visual question answerer are the same model doing the
 * same forward pass as `vision`; what differs is the instruction and the
 * expected output shape. Building separate pipelines for them would have
 * duplicated the whole fallback stack to change one string, so instead the
 * task is expressed as a prompt template over the ONE real vision path.
 *
 * NO HARDCODED MODELS — the pool comes from the catalog by capability.
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import {
  normalizeStrategy,
  resolveFallbackDeadlineMs,
  diversifyProviders,
  type ModalityStrategy,
} from '@/services/modality/modality-execution-helpers';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import type { VisionResponse } from '@/types/model-client';
import { isAdapterMethodImplemented } from '@/providers/provider-operability';
import { narrowAs } from '@/utils/type-guards';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';
import { ValidationError } from '@/utils/custom-errors';

const log = logger.child({ service: 'vision-orchestration' });

/** The vision-family capabilities this service can execute. */
export type VisionTask = 'vision' | 'image_captioning' | 'visual_question_answering';

export interface VisionAnalysisOptions {
  /** Task framing. Decides the default prompt and the response envelope. */
  task: VisionTask;
  /**
   * Image as a Buffer, an http(s) URL, or a base64 / data-URL string.
   * `ProviderAdapter.vision()` normalizes all three.
   */
  image: Buffer | string;
  /**
   * Caller instruction. For `visual_question_answering` this is the QUESTION
   * and is mandatory — a VQA request without a question is just captioning,
   * and silently turning one into the other would hide a caller bug.
   */
  prompt?: string;
  model?: string;
  detail?: 'low' | 'high' | 'auto';
  maxTokens?: number;
  temperature?: number;
  strategy?: string;
  allowFallback?: boolean;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface VisionAnalysisResult {
  content: string;
  task: VisionTask;
  modelUsed: string;
  provider: string;
  durationMs: number;
  strategyUsed: ModalityStrategy;
  fallbackUsed: boolean;
  attempts?: CandidateAttempt[];
}

/**
 * Task prompt templates.
 *
 * Captioning asks for ONE sentence because the caption is meant to be usable
 * as alt text; letting the model write a paragraph is the single most common
 * way a captioning endpoint becomes unusable downstream. VQA constrains the
 * model to the image so an unanswerable question yields "not visible" rather
 * than a confident guess from priors.
 */
const DEFAULT_VISION_PROMPT =
  'Describe this image in detail. Cover the subjects, the setting, any visible text, ' +
  'and anything notable about composition or context.';

const CAPTION_PROMPT =
  'Write a single concise caption for this image, suitable for use as alt text. ' +
  'One sentence, no preamble, no quotation marks, no markdown.';

function buildVqaPrompt(question: string): string {
  return (
    'Answer the question using ONLY what is visible in the image. ' +
    'If the image does not contain enough information to answer, say exactly that ' +
    'instead of guessing.\n\n' +
    `Question: ${question}`
  );
}

export class VisionOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
  }

  async analyzeImage(options: VisionAnalysisOptions): Promise<VisionAnalysisResult> {
    const startTime = Date.now();
    const {
      task,
      image,
      model,
      detail = 'auto',
      maxTokens,
      temperature,
      strategy,
      allowFallback = true,
      userContext,
      requestId,
    } = options;

    if (!image || (typeof image === 'string' && image.trim().length === 0)) {
      throw new ValidationError('image is required (Buffer, URL, or base64 string)');
    }

    const prompt = this.resolvePrompt(task, options.prompt);
    const strategyUsed = normalizeStrategy(strategy);

    log.info(
      {
        requestId,
        task,
        model,
        promptLength: prompt.length,
        imageKind: Buffer.isBuffer(image) ? 'buffer' : 'string',
        strategy: strategyUsed,
        allowFallback,
      },
      'Vision orchestration started'
    );

    const catalogRows = await this.resolveVisionCatalog(model);
    const ranked = this.sortModelsByStrategy(catalogRows, strategyUsed, userContext);
    const preRanked = diversifyProviders(ranked);

    const supportsMethod = (adapter: ProviderAdapter): boolean =>
      isAdapterMethodImplemented(adapter, 'vision');

    const result = await runModalityFallback<VisionResponse>({
      // `multimodal` rides along so a model tagged only multimodal is still a
      // legal candidate — the same pair `CapabilityExecutionService` uses for
      // the orchestration path.
      capability: ['vision' as ModelCapability, 'multimodal' as ModelCapability],
      capabilityLabel: task,
      explicit: model && model !== 'auto' ? model : null,
      catalog: preRanked,
      deadlineMs: resolveFallbackDeadlineMs(strategyUsed, allowFallback),
      registry: this.getRegistry(),
      supportsCapability: supportsMethod,
      log,
      requestId,
      startTime,
      execute: async (selectedModel, adapter) => {
        return narrowAs<{ vision: ProviderAdapter['vision'] }>(adapter).vision(selectedModel, {
          prompt,
          image,
          options: {
            detail,
            ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
            ...(typeof temperature === 'number' ? { temperature } : {}),
          },
        });
      },
    });

    const content = (result.response.content ?? '').trim();

    return {
      content,
      task,
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      strategyUsed,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
    };
  }

  // ============================================
  // Prompt framing
  // ============================================

  private resolvePrompt(task: VisionTask, callerPrompt: string | undefined): string {
    const trimmed = callerPrompt?.trim();

    if (task === 'visual_question_answering') {
      if (!trimmed) {
        throw new ValidationError(
          'visual_question_answering requires a question — pass it as `prompt` (or `question`).'
        );
      }
      return buildVqaPrompt(trimmed);
    }

    if (task === 'image_captioning') {
      // A caller-supplied instruction refines the caption (e.g. "focus on the
      // product"), it does not replace the alt-text framing.
      return trimmed ? `${CAPTION_PROMPT}\n\nAdditional guidance: ${trimmed}` : CAPTION_PROMPT;
    }

    return trimmed || DEFAULT_VISION_PROMPT;
  }

  // ============================================
  // Candidate pool
  // ============================================

  /**
   * Vision candidate pool.
   *
   * `searchModelsComplete`, not `searchModels` — see the LOTE AN note in
   * `images-orchestration-service.ts`: the capped variant returns "the 100
   * most recently discovered rows", which for a 76k-row catalog silently
   * excludes essentially every established vision model.
   */
  private async resolveVisionCatalog(explicit: string | undefined): Promise<Model[]> {
    const capabilities: ModelCapability[] = [
      'vision' as ModelCapability,
      'multimodal' as ModelCapability,
    ];

    if (explicit && explicit !== 'auto') {
      const rows = await this.modelRepo.findModelsByIdOrName(explicit);
      return rows.filter((m) => capabilities.some((c) => (m.capabilities ?? []).includes(c)));
    }

    const pools = await Promise.all(
      capabilities.map((c) =>
        this.modelRepo.searchModelsComplete({ capabilities: [c], status: 'active' })
      )
    );
    return Array.from(new Map(pools.flat().map((m) => [`${m.provider}:${m.id}`, m])).values());
  }

  // ============================================
  // Ranking
  // ============================================

  private getModelAverageCostPer1k(model: Model): number {
    const input = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
    const output = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : input;
    return (Math.max(0, input) + Math.max(0, output)) / 2;
  }

  private getModelQuality(model: Model): number {
    const quality = model.performance?.quality;
    return typeof quality === 'number' && Number.isFinite(quality) ? quality : 0.5;
  }

  private getModelLatencyMs(model: Model): number {
    const latency = model.performance?.latencyMs;
    return typeof latency === 'number' && Number.isFinite(latency) ? latency : 2000;
  }

  private sortModelsByStrategy(
    models: Model[],
    strategy: ModalityStrategy,
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
}

let sharedVisionService: VisionOrchestrationService | null = null;

export function getVisionOrchestrationService(): VisionOrchestrationService {
  if (!sharedVisionService) {
    sharedVisionService = new VisionOrchestrationService();
  }
  return sharedVisionService;
}

/** Test seam — resets the singleton between suites. */
export function resetVisionOrchestrationServiceForTesting(): void {
  sharedVisionService = null;
}
