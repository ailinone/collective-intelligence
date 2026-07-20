// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Execution Pool Builder
 *
 * Replaces the misleading "606 models in registry" with a visible, auditable
 * pipeline that shows exactly where models drop and why.
 *
 * Each filter stage records:
 *   - How many models entered
 *   - How many passed
 *   - Why each dropped model was excluded
 *
 * Usage:
 *   const result = new PoolBuilder(allModels)
 *     .filterByModality('chat')
 *     .filterByCapabilities(['chat'])
 *     .filterByOperability()
 *     .filterByCredits()
 *     .filterByQuality(0.4)
 *     .excludeSelfHosted()
 *     .sortByQualityThenCost()
 *     .build();
 *
 *   // result.stages shows: 606 → 420 → 312 → 280 → 45 etc.
 */

import type { Model } from '@/types';
import { safeMetadata } from '@/types/model-metadata.schema';
import { getProviderOperabilityHub } from '../provider-operability-hub';
import { extractModelFamily } from '../operability/operability-snapshot';
import { popularityPriorFromMetadata } from '../selection/popularity-prior';
import { isNonGenerativeModel } from './non-generative-filter';
import type { PoolResult, PoolStage } from './pool-types';

const NON_CHAT_CAPABILITIES = new Set([
  'image_generation', 'image_editing', 'image_upscaling',
  'video_generation', 'video_editing',
  'audio_generation', 'text_to_speech', 'speech_to_text',
  'embedding', 'reranking',
  'moderation', 'classification',
]);

const SOURCE_PRIORITY: Record<string, number> = {
  native_api: 0,
  cloud_hub: 1,
  router: 2,
  aggregator: 3,
};

export class PoolBuilder {
  private models: Model[];
  private readonly stages: PoolStage[] = [];
  private selfHostedCount = 0;

  constructor(allModels: Model[]) {
    this.models = [...allModels];
  }

  // ── Filter Stages ─────────────────────────────────────────────────

  /**
   * Filter by modality — exclude models that are primarily non-chat.
   * A model must have 'chat' or 'text_generation' capability AND
   * not be exclusively non-chat (image/audio/embedding only).
   */
  filterByModality(modality: 'chat' = 'chat'): this {
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};

    this.models = this.models.filter((model) => {
      const caps = model.capabilities ?? [];

      if (modality === 'chat') {
        const hasChatCap = caps.includes('chat') || caps.includes('text_generation');
        if (!hasChatCap) {
          reasons['no_chat_capability'] = (reasons['no_chat_capability'] ?? 0) + 1;
          return false;
        }
        // Exclude models that ONLY have non-chat caps + streaming
        const hasOnlyNonChat = caps.length > 0 && caps.every(
          (c) => NON_CHAT_CAPABILITIES.has(c) || c === 'streaming'
        );
        if (hasOnlyNonChat) {
          reasons['only_non_chat_capabilities'] = (reasons['only_non_chat_capabilities'] ?? 0) + 1;
          return false;
        }
        // Robust non-generative exclusion: catalog capability tags are unreliable
        // (rerankers/embeddings/decoding-method repos are frequently mis-tagged
        // `chat`), so also exclude by capability+id class signal. Keeps corrupt
        // retrieval/audio/search models out of chat & collective-voting pools.
        if (isNonGenerativeModel(model)) {
          reasons['non_generative_model'] = (reasons['non_generative_model'] ?? 0) + 1;
          return false;
        }
      }
      return true;
    });

    this.stages.push({ name: 'modality_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Filter by required capabilities.
   */
  filterByCapabilities(requiredCaps: string[]): this {
    if (requiredCaps.length === 0) return this;

    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};

    this.models = this.models.filter((model) => {
      const caps = (model.capabilities ?? []) as readonly string[];
      for (const rc of requiredCaps) {
        if (!caps.includes(rc)) {
          reasons[`missing_${rc}`] = (reasons[`missing_${rc}`] ?? 0) + 1;
          return false;
        }
      }
      return true;
    });

    this.stages.push({ name: 'capability_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Filter by operability — exclude models whose execution provider is not usable.
   * Uses route-level precision: aihubmix:openai failing ≠ aihubmix:anthropic failing.
   */
  filterByOperability(): this {
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};
    const hub = getProviderOperabilityHub();

    this.models = this.models.filter((model) => {
      const provider = (model.provider ?? '').toLowerCase();
      if (!provider) return true; // Unknown provider — don't filter

      // Route-level check
      const usable = hub.isRouteUsable(provider, model.id);
      if (!usable) {
        const state = hub.getRouteState(provider, model.id).operabilityState;
        reasons[`${state}:${provider}`] = (reasons[`${state}:${provider}`] ?? 0) + 1;
        return false;
      }
      return true;
    });

    this.stages.push({ name: 'operability_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Filter by credit/balance status.
   */
  filterByCredits(): this {
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};

    this.models = this.models.filter((model) => {
      if (model.balanceStatus === 'no-credits') {
        const provider = (model.provider ?? 'unknown').toLowerCase();
        reasons[`no_credits:${provider}`] = (reasons[`no_credits:${provider}`] ?? 0) + 1;
        return false;
      }
      return true;
    });

    this.stages.push({ name: 'credit_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Filter by quality threshold.
   */
  filterByQuality(minQuality: number): this {
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};

    this.models = this.models.filter((model) => {
      const quality = model.performance?.quality ?? 0;
      if (quality < minQuality) {
        // Allow quality=0 (no data) when threshold is lenient
        if (quality === 0 && minQuality < 0.6) {
          return true; // pass through for exploration
        }
        reasons['below_threshold'] = (reasons['below_threshold'] ?? 0) + 1;
        return false;
      }
      return true;
    });

    this.stages.push({ name: 'quality_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Filter by status — only active models.
   */
  filterByStatus(): this {
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};

    this.models = this.models.filter((model) => {
      if (model.status !== 'active') {
        reasons[`status_${model.status ?? 'unknown'}`] = (reasons[`status_${model.status ?? 'unknown'}`] ?? 0) + 1;
        return false;
      }
      return true;
    });

    this.stages.push({ name: 'status_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Filter by cost ceiling.
   */
  filterByCost(maxCostPer1k: number): this {
    if (maxCostPer1k <= 0) return this;
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};

    this.models = this.models.filter((model) => {
      const estimatedCost = (Number(model.inputCostPer1k) + Number(model.outputCostPer1k)) * 2;
      if (estimatedCost > maxCostPer1k) {
        reasons['above_cost_ceiling'] = (reasons['above_cost_ceiling'] ?? 0) + 1;
        return false;
      }
      return true;
    });

    this.stages.push({ name: 'cost_filter', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Exclude self-hosted/local models from the primary pool.
   * Tracks the count so last-resort policy can use them.
   */
  excludeSelfHosted(): this {
    const inputCount = this.models.length;
    const reasons: Record<string, number> = {};
    const hub = getProviderOperabilityHub();

    this.models = this.models.filter((model) => {
      const provider = (model.provider ?? '').toLowerCase();
      if (hub.isSelfHostedProvider(provider)) {
        this.selfHostedCount++;
        reasons['self_hosted'] = (reasons['self_hosted'] ?? 0) + 1;
        return false;
      }
      return true;
    });

    this.stages.push({ name: 'self_hosted_exclusion', inputCount, outputCount: this.models.length, droppedReasons: reasons });
    return this;
  }

  /**
   * Sort: quality desc → native providers first → cheapest at same quality.
   */
  sortByQualityThenCost(): this {
    // Dynamic HF popularity prior (downloads/likes) — a *live* legitimacy signal,
    // not a model pin. Curated native models that never carried HF stats return
    // `undefined`; treat that as a neutral 0.5 so premium API models stay
    // competitive instead of sinking below 0-download fine-tunes.
    const pop = (m: Model): number =>
      popularityPriorFromMetadata(m.metadata as Record<string, unknown> | undefined) ?? 0.5;
    this.models.sort((a, b) => {
      const qa = a.performance?.quality ?? 0;
      const qb = b.performance?.quality ?? 0;
      if (qa !== qb) return qb - qa;
      // Same catalog quality (usually 0 — sparse data) → prefer PROVEN/popular
      // models so strong models aren't buried under merely-cheaper junk. This
      // only reorders within a quality tie; it never overrides real quality data.
      const pa = pop(a);
      const pb = pop(b);
      if (pa !== pb) return pb - pa;
      // Same quality + popularity → prefer native provider
      const srcA = SOURCE_PRIORITY[safeMetadata(a.metadata).sourceType ?? ''] ?? 9;
      const srcB = SOURCE_PRIORITY[safeMetadata(b.metadata).sourceType ?? ''] ?? 9;
      if (srcA !== srcB) return srcA - srcB;
      // Otherwise → prefer cheaper
      const costA = Number(a.inputCostPer1k) + Number(a.outputCostPer1k);
      const costB = Number(b.inputCostPer1k) + Number(b.outputCostPer1k);
      return costA - costB;
    });
    return this;
  }

  // ── Build ─────────────────────────────────────────────────────────

  build(): PoolResult {
    const providerSet = new Set<string>();
    const familySet = new Set<string>();

    for (const m of this.models) {
      const provider = (m.provider ?? '').toLowerCase();
      if (provider) providerSet.add(provider);
      const family = extractModelFamily(m.id);
      if (family) familySet.add(family);
    }

    const summary = this.stages
      .map(s => `${s.name}: ${s.inputCount}→${s.outputCount}`)
      .join(' | ');

    return {
      models: this.models,
      poolSize: this.models.length,
      stages: this.stages,
      selfHostedAvailable: this.selfHostedCount,
      providerDiversity: providerSet.size,
      familyDiversity: familySet.size,
      summary: `Pool: ${this.models.length} models (${providerSet.size} providers) | ${summary}`,
    };
  }
}

/**
 * Convenience: build a standard chat execution pool from all models.
 * Applies the full filter chain used by getEligibleModels().
 */
export function buildChatExecutionPool(
  allModels: Model[],
  qualityThreshold: number,
  maxCost?: number,
  requiredCapabilities?: string[],
): PoolResult {
  let builder = new PoolBuilder(allModels)
    .filterByModality('chat')
    .filterByStatus()
    .excludeSelfHosted()
    .filterByOperability()
    .filterByCredits()
    .filterByQuality(qualityThreshold);

  if (requiredCapabilities && requiredCapabilities.length > 0) {
    builder = builder.filterByCapabilities(requiredCapabilities);
  }

  if (maxCost && maxCost > 0) {
    builder = builder.filterByCost(maxCost);
  }

  return builder.sortByQualityThenCost().build();
}
