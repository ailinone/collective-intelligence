// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Moderations Orchestration Service
 * Orchestrates content moderation across multiple providers
 * 
 * Features:
 * - Dynamic model selection based on capabilities
 * - Multi-provider orchestration (OpenAI Moderation, Google Safety API, Azure, etc.)
 * - Automatic failover on provider failures
 * - Multi-language support
 * - Consistent category scoring
 * 
 * NO HARDCODED MODELS - All selection is dynamic via model discovery
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import { runModalityFallback } from '@/services/modality/modality-fallback-driver';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability, OrchestrationContext } from '@/types';
import { narrowAs } from '@/utils/type-guards';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';

const log = logger.child({ service: 'moderations-orchestration' });

// ============================================
// Types
// ============================================

export interface ModerationOptions {
  inputs: string[];
  model?: string; // undefined = auto-select
  userContext: OrchestrationContext;
  requestId: string;
}

export interface ModerationResult {
  results: Array<{
    flagged: boolean;
    categories: {
      sexual: boolean;
      hate: boolean;
      harassment: boolean;
      'self-harm': boolean;
      'sexual/minors': boolean;
      'hate/threatening': boolean;
      'violence/graphic': boolean;
      'self-harm/intent': boolean;
      'self-harm/instructions': boolean;
      'harassment/threatening': boolean;
      violence: boolean;
    };
    category_scores: {
      sexual: number;
      hate: number;
      harassment: number;
      'self-harm': number;
      'sexual/minors': number;
      'hate/threatening': number;
      'violence/graphic': number;
      'self-harm/intent': number;
      'self-harm/instructions': number;
      'harassment/threatening': number;
      violence: number;
    };
  }>;
  modelUsed: string;
  provider: string;
  durationMs: number;
  /**
   * Per-candidate attempt log. Present when at least one fallback was tried.
   * Useful for `_ailin` diagnostics in the API response and for debugging
   * why a particular provider succeeded or failed.
   */
  attempts?: CandidateAttempt[];
}

// ============================================
// Moderations Orchestration Service
// ============================================

export class ModerationsOrchestrationService {
  private modelRepo: ModelRepository;
  private getRegistry: () => ProviderRegistry;

  constructor() {
    this.modelRepo = new ModelRepository();
    this.getRegistry = getProviderRegistry;
  }

  /**
   * Moderate content
   * Dynamically selects best moderation model based on language and content type.
   *
   * Migrated to `executeWithFallback` (2026-04-29). Previous behavior tried a
   * single model and 5xx'd on any failure. Now iterates the catalog by
   * (capability, supportsCapability adapter probe), tier-aware ranking, with
   * structured attempt log returned to the caller for diagnostics.
   */
  async moderateContent(options: ModerationOptions): Promise<ModerationResult> {
    const startTime = Date.now();
    const { inputs, model, userContext: _userContext, requestId } = options;

    log.info({ requestId, model, inputCount: inputs.length }, 'Moderation orchestration started');

    // Pre-rank by moderation-specific signal (language coverage, category
    // count, cost, latency). The primitive's tier ordering is order-stable,
    // so this preference becomes the within-tier tiebreaker.
    const moderationModels = await this.modelRepo.searchModels({
      capabilities: ['moderation' as ModelCapability, 'safety' as ModelCapability],
      status: 'active',
    });
    const preRanked = this.rankModerationCandidates(moderationModels);

    const supportsModeration = (adapter: ProviderAdapter): boolean =>
      typeof (narrowAs<{ moderate?: unknown }>(adapter)).moderate === 'function';

    // DUP #2 phase 2: executeWithFallback + cost + completion log + error
    // classification (NoFallback→ValidationError, FallbackExhausted→503) are
    // owned by the shared runModalityFallback driver. Only the atomic-batch
    // execute hook + the result envelope are moderation-specific.
    const result = await runModalityFallback<ModerationResult['results']>({
      capability: ['moderation' as ModelCapability, 'safety' as ModelCapability],
      capabilityLabel: 'moderation',
      explicit: model ?? null,
      maxCandidates: 5,
      registry: this.getRegistry(),
      catalog: preRanked,
      supportsCapability: supportsModeration,
      execute: async (selectedModel, adapter) => {
        // Atomic batch: any per-input failure throws and the primitive
        // restarts the whole batch against the next candidate. We keep
        // this all-or-nothing semantic so callers never see a half-
        // classified result set.
        const moderate = narrowAs<{
          moderate: (m: Model, p: { text: string }) => Promise<{
            flagged: boolean;
            categories: ModerationResult['results'][number]['categories'];
            category_scores: ModerationResult['results'][number]['category_scores'];
          }>;
        }>(adapter).moderate;
        // Promise.all preserves the "any failure throws" semantic above (it
        // rejects on the first rejection) AND preserves input order in the
        // output array — same contract as the sequential loop, but inputs run
        // concurrently against the provider instead of one request at a time.
        const out = await Promise.all(
          inputs.map(async (input) => {
            const r = await moderate(selectedModel, { text: input });
            return {
              flagged: r.flagged,
              categories: r.categories,
              category_scores: r.category_scores,
            };
          }),
        );
        return out;
      },
      log,
      requestId,
      startTime,
    });

    return {
      results: result.response,
      modelUsed: result.selectedModel.name,
      provider: result.selectedModel.provider,
      durationMs: result.durationMs,
      attempts: result.attempts,
    };
  }

  /**
   * Rank moderation candidates by domain-specific signal:
   *  - multi-language support (more languages = better)
   *  - category coverage (more categories = better)
   *  - cost efficiency (cheaper = better)
   *  - latency (faster = better)
   * This is consumed as the input order to executeWithFallback; tier ranking
   * runs on top with stable tiebreaking.
   */
  private rankModerationCandidates(models: Model[]): Model[] {
    const score = (model: Model): number => {
      let s = 0;
      const metadata = model.metadata || {};
      const supportedLanguages = metadata.supported_languages as string[] | undefined;
      if (supportedLanguages && supportedLanguages.length > 10) s += 20;
      const categories = metadata.moderation_categories as string[] | undefined;
      if (categories) s += Math.min(categories.length * 3, 30);
      const pricing = metadata.pricing as { inputCostPer1M?: number } | undefined;
      const costPer1M = pricing?.inputCostPer1M ?? 0;
      if (costPer1M < 100) s += 25;
      else if (costPer1M < 500) s += 15;
      else if (costPer1M < 1000) s += 5;
      const avgLatency = (metadata.provider_metadata as { avgLatency?: number } | undefined)
        ?.avgLatency;
      if (avgLatency !== undefined && avgLatency < 500) s += 15;
      else if (avgLatency !== undefined && avgLatency < 1000) s += 10;
      if (model.status === 'active') s += 5;
      return s;
    };
    return [...models].sort((a, b) => score(b) - score(a));
  }
}

