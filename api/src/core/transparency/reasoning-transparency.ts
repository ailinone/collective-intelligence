// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Reasoning Transparency
 *
 * Provides visibility into how the Collective Intelligence system
 * makes decisions about model selection, strategy choice, and response generation.
 *
 * Key Features:
 * - Decision tracing: Why was this model/strategy selected?
 * - Confidence explanation: How confident is the system in its choices?
 * - Alternative analysis: What other options were considered?
 * - Cost/quality trade-off visibility
 *
 * This transparency is crucial for:
 * - Debugging and troubleshooting
 * - User trust and understanding
 * - System optimization
 * - Regulatory compliance (explainable AI)
 */

import type {
  ChatRequest,
  Model,
  OrchestrationContext,
  OrchestrationResult,
} from '@/types';
import { logger } from '@/utils/logger';
import type { SelectedModel } from '@/core/selection/dynamic-model-selector';

// Extended context type for transparency
// Note: requiredCapabilities and preferQuality are now in OrchestrationContext base
interface ExtendedContext extends OrchestrationContext {
  complexity?: string;
}

const log = logger.child({ component: 'reasoning-transparency' });

/**
 * Model selection reasoning
 */
export interface ModelSelectionReasoning {
  selectedModel: string;
  selectionScore: number;
  selectionCriteria: {
    criterion: string;
    weight: number;
    score: number;
    contribution: number;
  }[];
  alternativesConsidered: {
    model: string;
    score: number;
    reason: string;
  }[];
  constraints: {
    constraint: string;
    impact: 'required' | 'preferred' | 'filtered';
    satisfied: boolean;
  }[];
  timeToSelect: number;
}

/**
 * Strategy selection reasoning
 */
export interface StrategySelectionReasoning {
  selectedStrategy: string;
  selectionScore: number;
  taskAnalysis: {
    taskType: string;
    complexity: string;
    estimatedTokens: number;
    specialRequirements: string[];
  };
  strategyFit: {
    strategy: string;
    fitScore: number;
    pros: string[];
    cons: string[];
  }[];
  costEstimate: {
    estimated: number;
    budget: number | null;
    withinBudget: boolean;
  };
  qualityEstimate: {
    expected: number;
    target: number;
    meetsTarget: boolean;
  };
}

/**
 * Complete reasoning trace
 */
export interface ReasoningTrace {
  requestId: string;
  timestamp: number;
  request: {
    model: string;
    messageCount: number;
    hasTools: boolean;
    hasSystemPrompt: boolean;
    estimatedTokens: number;
  };
  triage: {
    intent: string;
    complexity: string;
    priority: string;
    confidence: number;
  } | null;
  modelSelection: ModelSelectionReasoning;
  strategySelection: StrategySelectionReasoning;
  execution: {
    modelsUsed: string[];
    totalDuration: number;
    totalCost: number;
    iterations: number;
    fallbacksUsed: number;
  };
  quality: {
    score: number;
    dimensions: Record<string, number>;
    meetsThreshold: boolean;
  } | null;
  summary: string;
}

/**
 * Reasoning Transparency Service
 */
export class ReasoningTransparencyService {
  private traces: Map<string, Partial<ReasoningTrace>> = new Map();
  private maxTraces = 1000;

  /**
   * Start tracing for a request
   */
  startTrace(requestId: string, request?: ChatRequest): void {
    const trace: Partial<ReasoningTrace> = {
      requestId,
      timestamp: Date.now(),
      request: {
        model: request?.model || 'auto',
        messageCount: request?.messages?.length || 0,
        hasTools: !!(request?.tools && request.tools.length > 0),
        hasSystemPrompt: request?.messages?.some((m) => m.role === 'system') || false,
        estimatedTokens: request ? this.estimateTokens(request) : 0,
      },
    };

    this.traces.set(requestId, trace);
    this.pruneOldTraces();
  }

  /**
   * Record triage results
   */
  recordTriage(
    requestId: string,
    triage: {
      intent: string;
      complexity: string;
      priority: string;
      confidence: number;
    }
  ): void {
    const trace = this.traces.get(requestId);
    if (trace) {
      trace.triage = triage;
    }
  }

  /**
   * Record model selection decision
   */
  recordModelSelection(
    requestId: string,
    selected: SelectedModel,
    alternatives: SelectedModel[],
    context: ExtendedContext,
    selectionTime: number
  ): void {
    const trace = this.traces.get(requestId);
    if (!trace) return;

    const criteria = [
      { name: 'quality', weight: 0.35 },
      { name: 'cost', weight: 0.25 },
      { name: 'latency', weight: 0.2 },
      { name: 'capability_match', weight: 0.2 },
    ];

    trace.modelSelection = {
      selectedModel: selected.model.id,
      selectionScore: selected.score,
      selectionCriteria: criteria.map((c) => {
        const score = this.extractCriterionScore(selected, c.name, context);
        return {
          criterion: c.name,
          weight: c.weight,
          score,
          contribution: c.weight * score,
        };
      }),
      alternativesConsidered: alternatives.slice(0, 5).map((alt) => ({
        model: alt.model.id,
        score: alt.score,
        reason: this.getAlternativeReason(alt, selected),
      })),
      constraints: this.extractConstraints(context),
      timeToSelect: selectionTime,
    };
  }

  /**
   * Record strategy selection decision
   */
  recordStrategySelection(
    requestId: string,
    selectedStrategy: string,
    context: ExtendedContext,
    alternatives: Array<{ strategy: string; score: number }>
  ): void {
    const trace = this.traces.get(requestId);
    if (!trace) return;

    // Calculate selection score based on selected strategy score vs alternatives
    const selectedStrategyScore = alternatives.find(a => a.strategy === selectedStrategy)?.score ?? 0.5;
    const maxAlternativeScore = alternatives.length > 0 
      ? Math.max(...alternatives.map(a => a.score))
      : selectedStrategyScore;
    // Normalize score: 0-1 based on how close selected is to best alternative
    const selectionScore = maxAlternativeScore > 0 
      ? selectedStrategyScore / maxAlternativeScore
      : 0.5;

    trace.strategySelection = {
      selectedStrategy,
      selectionScore,
      taskAnalysis: {
        taskType: context.taskType || 'general',
        complexity: context.triage?.complexity || 'medium',
        estimatedTokens: context.contextSize || 1000,
        specialRequirements: this.extractSpecialRequirements(context),
      },
      strategyFit: [
        {
          strategy: selectedStrategy,
          fitScore: 0.9,
          pros: this.getStrategyPros(selectedStrategy),
          cons: this.getStrategyCons(selectedStrategy),
        },
        ...alternatives.slice(0, 3).map((alt) => ({
          strategy: alt.strategy,
          fitScore: alt.score,
          pros: this.getStrategyPros(alt.strategy),
          cons: this.getStrategyCons(alt.strategy),
        })),
      ],
      costEstimate: {
        estimated: context.maxCost || 0.01,
        budget: context.maxCost || null,
        withinBudget: true,
      },
      qualityEstimate: {
        expected: 0.85,
        target: context.qualityTarget || 0.8,
        meetsTarget: true,
      },
    };
  }

  /**
   * Record execution results
   */
  recordExecution(
    requestId: string,
    result: OrchestrationResult
  ): void {
    const trace = this.traces.get(requestId);
    if (!trace) return;

    trace.execution = {
      modelsUsed: result.modelsUsed.map((m) => m.modelId),
      totalDuration: result.totalDuration,
      totalCost: result.totalCost,
      iterations: result.modelsUsed.length,
      fallbacksUsed: result.modelsUsed.filter((m) => m.role === 'secondary').length,
    };
  }

  /**
   * Record quality assessment
   */
  recordQuality(
    requestId: string,
    quality: {
      score: number;
      dimensions: Record<string, number>;
      threshold: number;
    }
  ): void {
    const trace = this.traces.get(requestId);
    if (!trace) return;

    trace.quality = {
      score: quality.score,
      dimensions: quality.dimensions,
      meetsThreshold: quality.score >= quality.threshold,
    };
  }

  /**
   * Complete trace and generate summary
   */
  completeTrace(requestId: string): ReasoningTrace | null {
    const trace = this.traces.get(requestId);
    if (!trace) return null;

    // Generate human-readable summary
    trace.summary = this.generateSummary(trace as ReasoningTrace);

    log.debug({ requestId }, 'Reasoning trace completed');

    return trace as ReasoningTrace;
  }

  /**
   * Get trace by request ID
   */
  getTrace(requestId: string): ReasoningTrace | null {
    const trace = this.traces.get(requestId);
    return trace as ReasoningTrace | null;
  }

  /**
   * Export trace for external analysis
   */
  exportTrace(requestId: string): string | null {
    const trace = this.getTrace(requestId);
    if (!trace) return null;

    return JSON.stringify(trace, null, 2);
  }

  /**
   * Generate human-readable reasoning explanation
   */
  explainDecision(requestId: string): string {
    const trace = this.getTrace(requestId);
    if (!trace) return 'No trace available for this request.';

    const parts: string[] = [];

    // Request overview
    parts.push(`## Request Analysis`);
    parts.push(`- Model requested: ${trace.request?.model || 'auto'}`);
    parts.push(`- Messages: ${trace.request?.messageCount || 0}`);
    parts.push(`- Estimated tokens: ${trace.request?.estimatedTokens || 0}`);

    // Triage
    if (trace.triage) {
      parts.push(`\n## Triage Results`);
      parts.push(`- Intent: ${trace.triage.intent}`);
      parts.push(`- Complexity: ${trace.triage.complexity}`);
      parts.push(`- Confidence: ${(trace.triage.confidence * 100).toFixed(0)}%`);
    }

    // Model selection
    if (trace.modelSelection) {
      parts.push(`\n## Model Selection`);
      parts.push(`- Selected: ${trace.modelSelection.selectedModel}`);
      parts.push(`- Score: ${(trace.modelSelection.selectionScore * 100).toFixed(0)}%`);
      parts.push(`- Selection time: ${trace.modelSelection.timeToSelect}ms`);
      
      if (trace.modelSelection.alternativesConsidered.length > 0) {
        parts.push(`\n### Alternatives Considered`);
        for (const alt of trace.modelSelection.alternativesConsidered) {
          parts.push(`- ${alt.model}: ${(alt.score * 100).toFixed(0)}% (${alt.reason})`);
        }
      }
    }

    // Strategy selection
    if (trace.strategySelection) {
      parts.push(`\n## Strategy Selection`);
      parts.push(`- Selected: ${trace.strategySelection.selectedStrategy}`);
      parts.push(`- Task type: ${trace.strategySelection.taskAnalysis.taskType}`);
      parts.push(`- Complexity: ${trace.strategySelection.taskAnalysis.complexity}`);
    }

    // Execution
    if (trace.execution) {
      parts.push(`\n## Execution`);
      parts.push(`- Models used: ${trace.execution.modelsUsed.join(', ')}`);
      parts.push(`- Duration: ${trace.execution.totalDuration}ms`);
      parts.push(`- Cost: $${trace.execution.totalCost.toFixed(4)}`);
      parts.push(`- Fallbacks: ${trace.execution.fallbacksUsed}`);
    }

    // Quality
    if (trace.quality) {
      parts.push(`\n## Quality Assessment`);
      parts.push(`- Overall score: ${(trace.quality.score * 100).toFixed(0)}%`);
      parts.push(`- Meets threshold: ${trace.quality.meetsThreshold ? 'Yes' : 'No'}`);
    }

    return parts.join('\n');
  }

  /**
   * Estimate token count for request
   */
  private estimateTokens(request: ChatRequest): number {
    let total = 0;

    for (const message of request.messages || []) {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      // Rough estimate: 1 token per 4 characters
      total += Math.ceil(content.length / 4);
    }

    return total;
  }

  /**
   * Extract score for a specific criterion
   */
  private extractCriterionScore(selected: SelectedModel, criterion: string, context?: ExtendedContext): number {
    switch (criterion) {
      case 'quality':
        return selected.model.performance?.quality || 0.7;
      case 'cost':
        return 1 - Math.min(1, (selected.model.outputCostPer1k || 0) * 1000);
      case 'latency':
        return 1 - Math.min(1, (selected.model.performance?.latencyMs || 1000) / 5000);
      case 'capability_match':
        return this.calculateCapabilityMatchScore(selected.model, context);
      default:
        return 0.5;
    }
  }

  /**
   * Calculate capability match score based on how many required capabilities the model has
   */
  private calculateCapabilityMatchScore(model: Model, context?: ExtendedContext): number {
    if (!context?.requiredCapabilities || context.requiredCapabilities.length === 0) {
      // If no specific capabilities required, default to good match
      return 0.8;
    }

    const requiredCaps = context.requiredCapabilities;
    const modelCaps = model.capabilities || [];

    // Count how many required capabilities the model has
    const matchingCaps = requiredCaps.filter(reqCap => 
      modelCaps.some(modelCap => modelCap === reqCap)
    ).length;

    // Score: percentage of required capabilities that are matched
    // Higher score = better match
    return matchingCaps > 0 ? matchingCaps / requiredCaps.length : 0;
  }

  /**
   * Get reason why alternative was not selected
   */
  private getAlternativeReason(alt: SelectedModel, selected: SelectedModel): string {
    if (alt.score < selected.score * 0.8) {
      return 'Lower overall score';
    }
    if ((alt.model.performance?.quality || 0) < (selected.model.performance?.quality || 0)) {
      return 'Lower quality';
    }
    if ((alt.model.outputCostPer1k || 0) > (selected.model.outputCostPer1k || 0) * 1.5) {
      return 'Higher cost';
    }
    return 'Similar but not optimal';
  }

  /**
   * Extract constraints from context
   */
  private extractConstraints(context: ExtendedContext): Array<{
    constraint: string;
    impact: 'required' | 'preferred' | 'filtered';
    satisfied: boolean;
  }> {
    const constraints: Array<{
      constraint: string;
      impact: 'required' | 'preferred' | 'filtered';
      satisfied: boolean;
    }> = [];

    if (context.maxCost) {
      constraints.push({
        constraint: `Max cost: $${context.maxCost}`,
        impact: 'required',
        satisfied: true,
      });
    }

    if (context.qualityTarget) {
      constraints.push({
        constraint: `Min quality: ${(context.qualityTarget * 100).toFixed(0)}%`,
        impact: 'required',
        satisfied: true,
      });
    }

    if (context.requiredCapabilities && context.requiredCapabilities.length > 0) {
      constraints.push({
        constraint: `Capabilities: ${context.requiredCapabilities.join(', ')}`,
        impact: 'required',
        satisfied: true,
      });
    }

    return constraints;
  }

  /**
   * Extract special requirements from context
   */
  private extractSpecialRequirements(context: ExtendedContext): string[] {
    const requirements: string[] = [];

    if (context.preferSpeed) {
      requirements.push('Speed priority');
    }
    if (context.preferQuality) {
      requirements.push('Quality priority');
    }
    if (context.requiredCapabilities && context.requiredCapabilities.length > 0) {
      requirements.push(...context.requiredCapabilities);
    }

    return requirements;
  }

  /**
   * Get pros for a strategy
   */
  private getStrategyPros(strategy: string): string[] {
    const pros: Record<string, string[]> = {
      'single-model': ['Fast', 'Low cost', 'Simple'],
      'parallel': ['Fast', 'Multiple perspectives', 'Redundancy'],
      'collaborative': ['High quality', 'Error correction', 'Comprehensive'],
      'consensus': ['Reduces bias', 'Democratic', 'Reliable'],
      'debate': ['Deep analysis', 'Multiple viewpoints', 'Thorough'],
    };
    return pros[strategy] || ['Optimized for task'];
  }

  /**
   * Get cons for a strategy
   */
  private getStrategyCons(strategy: string): string[] {
    const cons: Record<string, string[]> = {
      'single-model': ['Single point of failure', 'May miss nuance'],
      'parallel': ['Higher cost', 'Needs aggregation'],
      'collaborative': ['Slower', 'Higher cost'],
      'consensus': ['Slower', 'May average out brilliance'],
      'debate': ['Slowest', 'Highest cost'],
    };
    return cons[strategy] || ['Resource intensive'];
  }

  /**
   * Generate summary of reasoning
   */
  private generateSummary(trace: ReasoningTrace): string {
    const parts: string[] = [];

    if (trace.modelSelection) {
      parts.push(
        `Selected ${trace.modelSelection.selectedModel} ` +
        `(${(trace.modelSelection.selectionScore * 100).toFixed(0)}% match)`
      );
    }

    if (trace.strategySelection) {
      parts.push(
        `using ${trace.strategySelection.selectedStrategy} strategy ` +
        `for ${trace.strategySelection.taskAnalysis.complexity} ${trace.strategySelection.taskAnalysis.taskType} task`
      );
    }

    if (trace.execution) {
      parts.push(
        `completed in ${trace.execution.totalDuration}ms ` +
        `costing $${trace.execution.totalCost.toFixed(4)}`
      );
    }

    if (trace.quality) {
      parts.push(
        `with ${(trace.quality.score * 100).toFixed(0)}% quality`
      );
    }

    return parts.join(', ') + '.';
  }

  /**
   * Prune old traces to prevent memory leaks
   */
  private pruneOldTraces(): void {
    if (this.traces.size > this.maxTraces) {
      const oldest = Array.from(this.traces.entries())
        .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0))
        .slice(0, this.traces.size - this.maxTraces + 100);

      for (const [key] of oldest) {
        this.traces.delete(key);
      }
    }
  }
}

/**
 * Singleton instance
 */
let transparencyServiceInstance: ReasoningTransparencyService | null = null;

/**
 * Get transparency service instance
 */
export function getReasoningTransparency(): ReasoningTransparencyService {
  if (!transparencyServiceInstance) {
    transparencyServiceInstance = new ReasoningTransparencyService();
  }
  return transparencyServiceInstance;
}

// Export alias for backward compatibility with tests
export { ReasoningTransparencyService as ReasoningTransparency };

