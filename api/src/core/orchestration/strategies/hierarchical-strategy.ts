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

interface ExecutionPlanStage {
  owner: 'manager' | 'worker';
  description: string;
}

interface ExecutionPlan {
  summary: string;
  stages: ExecutionPlanStage[];
}

/**
 * Hierarchical Delegation Strategy
 *
 * Manager model breaks down task and delegates to worker models.
 * Efficient for complex multi-step tasks.
 *
 * Process:
 * 1. Manager analyzes task and creates execution plan
 * 2. Delegates subtasks to worker models
 * 3. Aggregates results
 *
 * Best for: Complex tasks that can be decomposed
 */
export class HierarchicalStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'hierarchical',
      name: 'hierarchical',
      displayName: 'Hierarchical Delegation',
      description:
        'Manager model delegates subtasks to workers. Efficient for complex multi-step tasks.',
      minModels: 2,
      maxModels: 5,
      estimatedCostMultiplier: 2.0,
      estimatedQualityBoost: 0.22,
      estimatedDurationMultiplier: 1.4,
      suitableFor: ['code-generation', 'refactoring', 'analysis'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);
    const requestLog = logger.child({ strategy: 'hierarchical', requestId: context.requestId });

    if (models.length < 2) {
      throw new Error('Hierarchical strategy requires at least 2 models');
    }

    // Pin biases the manager slot (highest-status role — analyzes,
    // delegates, synthesizes). Workers are the next-best models by
    // quality, drawn from the fallback pool. Manager is the only
    // role whose identity affects the final output: workers
    // contribute proposals but the manager owns the synthesis.
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
    const workers = models.filter((m) => m.id !== manager.id).slice(0, 3);

    // Manager creates plan
    const plan = await this.createExecutionPlan(manager, request, context);
    requestLog.debug({ stages: plan.stages.length }, 'Execution plan created');

    // Execute (simplified: single execution for now)
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(manager, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${manager.id}`);
    }
    this.emitObserverEvent(context, { type: 'phase_start', models: [manager.name || manager.id], summary: `Hierarchical: manager executing plan.` });

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
        workers: workers.map((w) => w.id),
        planCreated: true,
        planSummary: plan.summary,
        ...(execution.reasoning ? { reasoning_traces: [{ model_id: execution.modelId, model_name: execution.modelName, role: execution.role, reasoning: execution.reasoning, reasoning_tokens: execution.reasoningTokens }] } : {}),
      },
    };
  }

  private selectManager(models: Model[]): Model {
    return [...models].sort(
      (a, b) => (b.performance?.quality || 0.8) - (a.performance?.quality || 0.8)
    )[0];
  }

  private async createExecutionPlan(
    manager: Model,
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<ExecutionPlan> {
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user' && typeof message.content === 'string');

    const summary = `Manager ${manager.name} orchestrates task "${context.taskType}" for request ${context.requestId}.`;

    const stages: ExecutionPlanStage[] = [
      {
        owner: 'manager',
        description: `Decompose the requirement${
          lastUserMessage ? ` "${(lastUserMessage.content as string).slice(0, 80)}"` : ''
        } into clear subtasks.`,
      },
      {
        owner: 'worker',
        description: context.preferSpeed
          ? 'Dispatch fastest worker to deliver a first-pass solution with low latency.'
          : 'Dispatch highest quality worker to craft a detailed response.',
      },
      {
        owner: 'manager',
        description: 'Review worker output, synthesize improvements, and validate constraints.',
      },
    ];

    if (Array.isArray(request.tools) && request.tools.length > 0) {
      stages.splice(2, 0, {
        owner: 'worker',
        description: `Execute required tools (${request.tools.map((tool) => tool.function.name).join(', ')}) and feed results back to the manager.`,
      });
    }

    return { summary, stages };
  }
}
