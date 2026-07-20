// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor } from './preferred-model-helper';
import type {
  ChatRequest,
  OrchestrationContext,
  OrchestrationResult,
  Model,
} from '@/types';
import { logger } from '@/utils/logger';

/**
 * Hierarchical Delegation Strategy — HONEST SINGLE-MODEL STUB (2026-07-11)
 *
 * The manager→worker delegation this strategy is *named* for is NOT implemented.
 * `execute()` runs ONLY the manager (the single pinned / highest-quality model)
 * against the original request. No worker is ever dispatched and there is no
 * manager synthesis of worker output. It is, today, a single-model passthrough.
 *
 * The metadata now reports that honestly instead of advertising a fake plan and
 * a `workers` list of models that never run:
 *   - `planCreated: false` — no real plan drives execution
 *   - `stub: true`         — delegation not implemented
 *   - no `workers` key      — nothing but the manager executes
 *   - `minModels: 1`        — so the router does NOT classify it as a real
 *                             collective (orchestration-engine sets
 *                             isCollectiveStrategy = minModels > 1), which in
 *                             turn suppresses collective framing, the streaming
 *                             observer, and single-vs-CI divergence handling.
 *
 * It is already excluded from the c3 benchmark arms via
 * NON_COLLECTIVE_BENCHMARK_STRATEGIES, so this is product-path honesty only.
 *
 * When real delegation lands, restore the collective metadata (planCreated:true,
 * a real workers list, minModels>=2) alongside the dispatch + synthesis logic.
 */
export class HierarchicalStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'hierarchical',
      name: 'hierarchical',
      displayName: 'Hierarchical Delegation',
      description:
        'STUB: currently runs a single manager model (worker delegation not yet implemented).',
      // Single-model passthrough today. minModels:1 keeps the router from
      // treating it as a real collective (isCollectiveStrategy = minModels > 1).
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 1.0, // one model runs
      estimatedQualityBoost: 0.0, // no collective boost — single model
      estimatedDurationMultiplier: 1.0,
      suitableFor: ['code-generation', 'refactoring', 'analysis'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);
    const requestLog = logger.child({ strategy: 'hierarchical', requestId: context.requestId });

    if (models.length < 1) {
      throw new Error('Hierarchical strategy requires at least 1 model');
    }

    // Pin biases the manager slot — the only model that actually runs today.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      requestLog.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible — falling back to quality-sorted manager.',
      );
    }
    const manager = preference.pinnedExecutor ?? this.selectManager(models);

    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(manager, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${manager.id}`);
    }
    this.emitObserverEvent(context, { type: 'phase_start', models: [manager.name || manager.id], summary: `Hierarchical: manager executing task.` });

    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const reasoningEnabled = this.isReasoningEnabled(request);
    const execution = hasTools
      ? await this.executeModelWithTools(adapter, manager, request, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, manager, request, 'primary')
        : await this.executeModel(adapter, manager, request, 'primary');

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Hierarchical execution complete.' });

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: [execution],
      finalResponse: execution.response,
      totalCost: execution.cost,
      totalDuration: Date.now() - startTime,
      qualityScore: 0.85,
      metadata: {
        manager: manager.id,
        // HONEST metadata: single-model stub. No plan drives execution and no
        // worker is dispatched, so we do NOT advertise planCreated:true or a
        // `workers` list of models that never ran (see class doc).
        planCreated: false,
        stub: true,
        ...(execution.reasoning ? { reasoning_traces: [{ model_id: execution.modelId, model_name: execution.modelName, role: execution.role, reasoning: execution.reasoning, reasoning_tokens: execution.reasoningTokens }] } : {}),
      },
    };
  }

  private selectManager(models: Model[]): Model {
    return [...models].sort(
      (a, b) => (b.performance?.quality || 0.8) - (a.performance?.quality || 0.8)
    )[0];
  }
}
