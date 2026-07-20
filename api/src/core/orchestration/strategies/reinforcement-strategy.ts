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
import { narrowAs } from '@/utils/type-guards';
import { modelPerformanceTracker } from '@/core/selection/model-performance-tracker';

/**
 * Quality-Weighted Strategy (formerly "Reinforcement Learning Strategy")
 *
 * Selects the best model using a weighted combination of quality, cost and latency.
 * When learned performance data is available, uses it to refine the selection.
 *
 * Name note: this strategy applies quality-weighted selection informed by historical
 * execution data. It is not a gradient-based RL algorithm.
 *
 * Best for: Tasks with clear quality metrics where model selection matters
 */
export class ReinforcementStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'reinforcement',
      name: 'reinforcement',
      displayName: 'Quality-Weighted Selection',
      description:
        'Selects models via quality/cost/latency weighting informed by historical execution data. Best for tasks where model selection is the main lever.',
      minModels: 2,
      maxModels: 4,
      estimatedCostMultiplier: 1.8,
      estimatedQualityBoost: 0.18,
      estimatedDurationMultiplier: 1.2,
      suitableFor: ['general', 'code-generation', 'analysis'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);

    if (models.length < 2) {
      throw new Error('Quality-weighted strategy requires at least 2 models');
    }

    // Enrich model scores with empirical rolling-average performance data
    const enrichedModels = models.map((m) => modelPerformanceTracker.applyToModel(m));

    const selectedModel = this.selectWithWeightedScore(enrichedModels, context);

    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(selectedModel, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${selectedModel.id}`);
    }
    this.emitObserverEvent(context, { type: 'phase_start', models: [selectedModel.name || selectedModel.id], summary: `Reinforcement: selected ${selectedModel.name} via weighted scoring.` });

    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const reasoningEnabled = this.isReasoningEnabled(request);
    const execution = hasTools
      ? await this.executeModelWithTools(adapter, selectedModel, request, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, selectedModel, request, 'primary')
        : await this.executeModel(adapter, selectedModel, request, 'primary');

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Reinforcement execution complete.' });

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: [execution],
      finalResponse: execution.response,
      totalCost: execution.cost,
      totalDuration: Date.now() - startTime,
      qualityScore: 0.84,
      metadata: {
        selectedModel: selectedModel.id,
        selectionMethod: 'quality-weighted',
        empiricalScoreApplied: !!(narrowAs<Record<string, unknown> | undefined>(selectedModel.performance))?._empirical,
        sampleCount: ((narrowAs<Record<string, unknown> | undefined>(selectedModel.performance))?._sampleCount as number) ?? 0,
        ...(execution.reasoning ? { reasoning_traces: [{ model_id: execution.modelId, model_name: execution.modelName, role: execution.role, reasoning: execution.reasoning, reasoning_tokens: execution.reasoningTokens }] } : {}),
      },
    };
  }

  private selectWithWeightedScore(models: Model[], context: OrchestrationContext): Model {
    const maxCost = context.maxCost ?? Infinity;
    const preferSpeed = context.preferSpeed ?? false;

    // Filter eligible models by cost ceiling first.
    const eligible = models.filter((model) => {
      const estimatedCost = (Number(model.inputCostPer1k) + Number(model.outputCostPer1k)) / 1000;
      return estimatedCost <= maxCost;
    });

    // Pin biases the single-model decision. User intent overrides
    // weighted scoring — if the user pinned a model that passes the
    // cost filter, use it. Otherwise fall back to scored selection.
    const preference = resolvePreferredExecutor(eligible, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible (cost-filtered or not in pool) — using weighted scoring.',
      );
    }
    if (preference.pinnedExecutor) {
      return preference.pinnedExecutor;
    }

    return [...eligible].sort((a, b) => {
      const aLatency = a.performance?.latencyMs ?? 1000;
      const bLatency = b.performance?.latencyMs ?? 1000;
      const latencyWeight = preferSpeed ? 0.15 : 0.05;
      const costWeight = 0.1;
      const qualityWeight = 1 - latencyWeight - costWeight;

      const aScore =
        qualityWeight * (a.performance?.quality || 0.8) -
        costWeight * Number(a.inputCostPer1k) -
        latencyWeight * (aLatency / 1000);
      const bScore =
        qualityWeight * (b.performance?.quality || 0.8) -
        costWeight * Number(b.inputCostPer1k) -
        latencyWeight * (bLatency / 1000);
      return bScore - aScore;
    })[0];
  }
}
