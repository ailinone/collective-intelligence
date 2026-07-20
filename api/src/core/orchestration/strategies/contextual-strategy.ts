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

/**
 * Contextual Switching Strategy
 *
 * Dynamically selects execution approach based on context (budget, time, quality targets).
 * Optimizes for the specific constraints and goals of each request.
 *
 * Best for: Requests with specific constraints or targets
 */
export class ContextualStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'contextual',
      name: 'contextual',
      displayName: 'Contextual Switching',
      description:
        'Dynamically adapts strategy based on context (budget, quality targets, time constraints).',
      minModels: 1,
      maxModels: 5,
      estimatedCostMultiplier: 1.0,
      estimatedQualityBoost: 0.12,
      estimatedDurationMultiplier: 1.0,
      suitableFor: ['general', 'code-generation', 'analysis'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();

    // Select model based on context
    const model = this.selectContextualModel(context);
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(model, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${model.id}`);
    }

    this.emitObserverEvent(context, { type: 'phase_start', models: [model.name || model.id], summary: 'Contextual: executing with context-selected model.' });

    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const reasoningEnabled = this.isReasoningEnabled(request);
    const execution = hasTools
      ? await this.executeModelWithTools(adapter, model, request, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, request, 'primary')
        : await this.executeModel(adapter, model, request, 'primary');

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Contextual execution complete.' });

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: [execution],
      finalResponse: execution.response,
      totalCost: execution.cost,
      totalDuration: Date.now() - startTime,
      qualityScore: 0.82,
      metadata: {
        selectedModel: model.id,
        selectionReason: this.getSelectionReason(context),
        ...(execution.reasoning ? { reasoning_traces: [{ model_id: execution.modelId, model_name: execution.modelName, role: execution.role, reasoning: execution.reasoning, reasoning_tokens: execution.reasoningTokens }] } : {}),
      },
    };
  }

  private selectContextualModel(context: OrchestrationContext): Model {
    const models = this.getEligibleModels(context);

    // Pin biases the single-model decision. User intent overrides
    // budget/quality heuristics — if the user explicitly pinned a
    // model that's eligible, use it. Pin-not-in-pool falls through
    // to the existing heuristic ordering.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible — falling back to contextual heuristic.',
      );
    }
    if (preference.pinnedExecutor) {
      return preference.pinnedExecutor;
    }

    // Budget-constrained
    if (context.budget && context.budget < 0.01) {
      return [...models].sort((a, b) => {
        const aCost = Number(a.inputCostPer1k) + Number(a.outputCostPer1k);
        const bCost = Number(b.inputCostPer1k) + Number(b.outputCostPer1k);
        return aCost - bCost;
      })[0];
    }

    // Quality-focused
    if (context.qualityTarget && context.qualityTarget > 0.9) {
      return [...models].sort(
        (a, b) => (b.performance?.quality || 0.8) - (a.performance?.quality || 0.8)
      )[0];
    }

    // Balanced default
    return models[0];
  }

  private getSelectionReason(context: OrchestrationContext): string {
    if (context.preferredModelIds && context.preferredModelIds.length > 0) {
      return 'user-pinned';
    }
    if (context.budget && context.budget < 0.01) return 'budget-optimized';
    if (context.qualityTarget && context.qualityTarget > 0.9) return 'quality-optimized';
    return 'balanced';
  }
}
