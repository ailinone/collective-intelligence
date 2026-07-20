// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Self-Critique Engine
 *
 * Implements automatic self-critique for AI responses.
 * The system asks the model (or a different model) to critique its own response
 * and then uses the critique to improve the output.
 *
 * Key Features:
 * - Same-model self-critique (introspection)
 * - Cross-model critique (different perspective)
 * - Iterative refinement based on critique
 * - Structured critique format with actionable improvements
 *
 * This is a core component of the Collective Intelligence system,
 * enabling self-improvement and quality assurance.
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  Model,
  OrchestrationContext,
} from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { safeResponseContent } from '@/core/orchestration/base-strategy';

const log = logger.child({ component: 'self-critique-engine' });

/**
 * Critique result structure
 */
export interface CritiqueResult {
  originalResponse: string;
  critique: {
    strengths: string[];
    weaknesses: string[];
    improvements: string[];
    overallAssessment: string;
    qualityScore: number; // 0-1
  };
  improvedResponse?: string;
  iterations: number;
  totalCost: number;
  totalDurationMs: number;
}

/**
 * Critique options
 */
export interface SelfCritiqueOptions {
  enabled: boolean;
  mode: 'same-model' | 'cross-model' | 'both';
  critiqueModel?: string; // Specific model to use for critique
  maxIterations?: number;
  minQualityThreshold?: number;
  includeImprovement?: boolean; // Whether to generate improved response
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: SelfCritiqueOptions = {
  enabled: true,
  mode: 'same-model',
  maxIterations: 2,
  minQualityThreshold: 0.8,
  includeImprovement: true,
};

/**
 * Self-Critique Engine
 */
export class SelfCritiqueEngine {
  private options: SelfCritiqueOptions;

  constructor(options: Partial<SelfCritiqueOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Perform self-critique on a response
   */
  async critique(params: {
    originalRequest: ChatRequest;
    response: ChatResponse;
    context: OrchestrationContext;
    options?: Partial<SelfCritiqueOptions>;
  }): Promise<CritiqueResult> {
    const { originalRequest, response, context, options } = params;
    const mergedOptions = { ...this.options, ...options };

    const startTime = Date.now();
    let totalCost = 0;
    let iterations = 0;

    const originalContent = this.extractContent(response);

    log.info(
      {
        mode: mergedOptions.mode,
        maxIterations: mergedOptions.maxIterations,
        contentLength: originalContent.length,
      },
      'Starting self-critique'
    );

    // Get critique model
    const critiqueModel = await this.selectCritiqueModel(
      originalRequest.model,
      mergedOptions
    );

    // Perform critique
    const critique = await this.performCritique(
      originalRequest,
      originalContent,
      critiqueModel,
      context
    );

    totalCost += critique.cost;
    iterations++;

    let improvedResponse: string | undefined;

    // Generate improved response if enabled and quality is below threshold
    if (
      mergedOptions.includeImprovement &&
      critique.qualityScore < mergedOptions.minQualityThreshold!
    ) {
      const improvement = await this.generateImprovement(
        originalRequest,
        originalContent,
        critique,
        critiqueModel,
        context
      );

      improvedResponse = improvement.content;
      totalCost += improvement.cost;
      iterations++;

      log.info(
        {
          originalScore: critique.qualityScore,
          improvedLength: improvedResponse.length,
        },
        'Generated improved response'
      );
    }

    const result: CritiqueResult = {
      originalResponse: originalContent,
      critique: {
        strengths: critique.strengths,
        weaknesses: critique.weaknesses,
        improvements: critique.improvements,
        overallAssessment: critique.assessment,
        qualityScore: critique.qualityScore,
      },
      improvedResponse,
      iterations,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };

    log.info(
      {
        qualityScore: critique.qualityScore,
        hasImprovement: !!improvedResponse,
        iterations,
        durationMs: result.totalDurationMs,
      },
      'Self-critique completed'
    );

    // Record critique insights for continuous learning
    this.recordCritiqueLearning(
      context,
      critique,
      !!improvedResponse,
      totalCost
    ).catch((err) => log.error({ error: getErrorMessage(err) }, 'Failed to record critique learning'));

    return result;
  }

  /**
   * Perform iterative critique until quality threshold is met
   */
  async critiqueUntilSatisfactory(params: {
    originalRequest: ChatRequest;
    response: ChatResponse;
    context: OrchestrationContext;
    options?: Partial<SelfCritiqueOptions>;
  }): Promise<CritiqueResult> {
    const { originalRequest, response, context, options } = params;
    const mergedOptions = { ...this.options, ...options };

    const startTime = Date.now();
    let totalCost = 0;
    let iterations = 0;
    let currentContent = this.extractContent(response);
    let lastCritique: CritiqueResult['critique'] | null = null;

    const critiqueModel = await this.selectCritiqueModel(
      originalRequest.model,
      mergedOptions
    );

    while (iterations < mergedOptions.maxIterations!) {
      iterations++;

      // Perform critique
      const critique = await this.performCritique(
        originalRequest,
        currentContent,
        critiqueModel,
        context
      );

      totalCost += critique.cost;
      lastCritique = {
        strengths: critique.strengths,
        weaknesses: critique.weaknesses,
        improvements: critique.improvements,
        overallAssessment: critique.assessment,
        qualityScore: critique.qualityScore,
      };

      log.debug(
        {
          iteration: iterations,
          qualityScore: critique.qualityScore,
          threshold: mergedOptions.minQualityThreshold,
        },
        'Critique iteration completed'
      );

      // Check if quality threshold is met
      if (critique.qualityScore >= mergedOptions.minQualityThreshold!) {
        break;
      }

      // Generate improved response
      if (iterations < mergedOptions.maxIterations!) {
        const improvement = await this.generateImprovement(
          originalRequest,
          currentContent,
          critique,
          critiqueModel,
          context
        );

        currentContent = improvement.content;
        totalCost += improvement.cost;
      }
    }

    return {
      originalResponse: this.extractContent(response),
      critique: lastCritique!,
      improvedResponse:
        currentContent !== this.extractContent(response) ? currentContent : undefined,
      iterations,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Select appropriate model for critique
   */
  private async selectCritiqueModel(
    originalModel: string | undefined,
    options: SelfCritiqueOptions
  ): Promise<Model> {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const allModels = await registry.getAllModels();

    // If specific critique model is specified, use it
    if (options.critiqueModel) {
      const specified = allModels.find(
        (m) => m.id === options.critiqueModel || m.name === options.critiqueModel
      );
      if (specified) return specified;
    }

    // For cross-model critique, select a different high-quality model
    if (options.mode === 'cross-model') {
      const different = allModels
        .filter((m) => m.id !== originalModel && m.performance?.quality >= 0.85)
        .sort((a, b) => b.performance.quality - a.performance.quality)[0];
      if (different) return different;
    }

    // For same-model, find the original model
    if (originalModel) {
      const original = allModels.find((m) => m.id === originalModel);
      if (original) return original;
    }

    // Fallback to highest quality model
    const best = allModels
      .filter((m) => m.performance?.quality >= 0.8)
      .sort((a, b) => b.performance.quality - a.performance.quality)[0];

    if (!best) {
      throw new Error('No suitable model found for critique');
    }

    return best;
  }

  /**
   * Perform the critique step
   */
  private async performCritique(
    originalRequest: ChatRequest,
    responseContent: string,
    model: Model,
    context: OrchestrationContext
  ): Promise<{
    strengths: string[];
    weaknesses: string[];
    improvements: string[];
    assessment: string;
    qualityScore: number;
    cost: number;
  }> {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const result = await registry.findModel(model.id);

    if (!result) {
      throw new Error(`Critique model ${model.id} not found`);
    }

    const { adapter } = result;

    // Build critique prompt
    const critiquePrompt = this.buildCritiquePrompt(originalRequest, responseContent, context);

    const critiqueResponse = await adapter.chatCompletion({
      model: model.id,
      messages: [
        {
          role: 'system',
          content: `You are an expert AI response evaluator. Your task is to critically analyze AI responses and provide structured feedback.
Be honest, objective, and constructive. Focus on actionable improvements.
Respond ONLY with valid JSON.`,
        },
        {
          role: 'user',
          content: critiquePrompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const cost = adapter.calculateCost(
      model,
      critiqueResponse.usage?.prompt_tokens || 0,
      critiqueResponse.usage?.completion_tokens || 0
    );

    return this.parseCritiqueResponse(
      this.extractContent(critiqueResponse),
      cost
    );
  }

  /**
   * Generate improved response based on critique
   */
  private async generateImprovement(
    originalRequest: ChatRequest,
    originalContent: string,
    critique: {
      strengths: string[];
      weaknesses: string[];
      improvements: string[];
      assessment: string;
      qualityScore: number;
    },
    model: Model,
    _context: OrchestrationContext
  ): Promise<{ content: string; cost: number }> {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const result = await registry.findModel(model.id);

    if (!result) {
      throw new Error(`Model ${model.id} not found`);
    }

    const { adapter } = result;

    // Build improvement prompt
    const improvementPrompt = this.buildImprovementPrompt(
      originalRequest,
      originalContent,
      critique
    );

    // Use original messages as base
    const messages: ChatMessage[] = [
      ...(originalRequest.messages || []),
      {
        role: 'system' as const,
        content: improvementPrompt,
      },
    ];

    const improvedResponse = await adapter.chatCompletion({
      model: model.id,
      messages,
      temperature: originalRequest.temperature ?? 0.7,
      max_tokens: originalRequest.max_tokens ?? 2000,
    });

    const cost = adapter.calculateCost(
      model,
      improvedResponse.usage?.prompt_tokens || 0,
      improvedResponse.usage?.completion_tokens || 0
    );

    return {
      content: this.extractContent(improvedResponse),
      cost,
    };
  }

  /**
   * Build the critique prompt
   */
  private buildCritiquePrompt(
    originalRequest: ChatRequest,
    responseContent: string,
    context: OrchestrationContext
  ): string {
    // Extract user's original question
    const userMessages = originalRequest.messages
      ?.filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n') || '';

    return `Critically evaluate the following AI response.

=== USER REQUEST ===
${userMessages.substring(0, 1000)}

=== TASK TYPE ===
${context.taskType}

=== AI RESPONSE TO EVALUATE ===
${responseContent.substring(0, 3000)}

=== EVALUATION INSTRUCTIONS ===
Analyze the response and provide structured feedback:

1. STRENGTHS: What does the response do well?
2. WEAKNESSES: What are the problems or shortcomings?
3. IMPROVEMENTS: What specific changes would make it better?
4. OVERALL: A brief assessment summary
5. QUALITY SCORE: A score from 0.0 to 1.0

Respond with JSON in this exact format:
{
  "strengths": ["strength 1", "strength 2", ...],
  "weaknesses": ["weakness 1", "weakness 2", ...],
  "improvements": ["improvement 1", "improvement 2", ...],
  "assessment": "Brief overall assessment",
  "qualityScore": 0.0-1.0
}`;
  }

  /**
   * Build the improvement prompt
   */
  private buildImprovementPrompt(
    originalRequest: ChatRequest,
    originalContent: string,
    critique: {
      strengths: string[];
      weaknesses: string[];
      improvements: string[];
      assessment: string;
    }
  ): string {
    return `Your previous response had the following feedback:

STRENGTHS to maintain:
${critique.strengths.map((s) => `- ${s}`).join('\n')}

WEAKNESSES to fix:
${critique.weaknesses.map((w) => `- ${w}`).join('\n')}

SPECIFIC IMPROVEMENTS needed:
${critique.improvements.map((i) => `- ${i}`).join('\n')}

Please generate an IMPROVED response that:
1. Maintains all the strengths
2. Addresses all the weaknesses
3. Implements the suggested improvements

Your improved response should be better than the original in every way.
Do not mention this critique or that you are improving - just provide the better response.`;
  }

  /**
   * Parse critique response into structured format
   */
  private parseCritiqueResponse(
    content: string,
    cost: number
  ): {
    strengths: string[];
    weaknesses: string[];
    improvements: string[];
    assessment: string;
    qualityScore: number;
    cost: number;
  } {
    try {
      // Extract JSON from response
      let jsonStr = content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        jsonStr = jsonObjectMatch[0];
      }

      // JSON.parse returns `unknown` — narrow each accessed field structurally.
      const parsed: unknown = JSON.parse(jsonStr);
      const parsedObj: { strengths?: unknown; weaknesses?: unknown; improvements?: unknown; assessment?: unknown; overall?: unknown; qualityScore?: unknown } =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { strengths?: unknown; weaknesses?: unknown; improvements?: unknown; assessment?: unknown; overall?: unknown; qualityScore?: unknown })
          : {};

      const stringArray = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      const stringField = (...candidates: unknown[]): string => {
        for (const c of candidates) {
          if (typeof c === 'string' && c.length > 0) return c;
        }
        return 'No assessment';
      };
      const numericField = (v: unknown): number => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const parsedNum = parseFloat(v);
          return Number.isFinite(parsedNum) ? parsedNum : 0.5;
        }
        return 0.5;
      };

      return {
        strengths: stringArray(parsedObj.strengths),
        weaknesses: stringArray(parsedObj.weaknesses),
        improvements: stringArray(parsedObj.improvements),
        assessment: stringField(parsedObj.assessment, parsedObj.overall),
        qualityScore: Math.max(0, Math.min(1, numericField(parsedObj.qualityScore))),
        cost,
      };
    } catch (error) {
      log.warn(
        { error: getErrorMessage(error) },
        'Failed to parse critique response'
      );

      return {
        strengths: [],
        weaknesses: ['Failed to parse critique'],
        improvements: [],
        assessment: 'Critique parsing failed',
        qualityScore: 0.5,
        cost,
      };
    }
  }

  /**
   * Extract text content from response
   */
  private extractContent(response: ChatResponse): string {
    return safeResponseContent(response);
  }

  /**
   * Record critique insights for continuous learning
   * This feeds back into the auto-learning system to improve future model selection
   * and strategy choices based on what types of responses tend to need critique
   */
  private async recordCritiqueLearning(
    context: OrchestrationContext,
    critique: {
      strengths: string[];
      weaknesses: string[];
      improvements: string[];
      assessment: string;
      qualityScore: number;
    },
    wasImproved: boolean,
    cost: number
  ): Promise<void> {
    // Record learning insight about critique patterns. `improvementPatterns`
    // is reserved for future categorization (parallel to `weaknessPatterns`);
    // keep computed for parity but mark intentional non-use.
    const weaknessPatterns = critique.weaknesses.map((w) => w.toLowerCase());
    void critique.improvements.map((i) => i.toLowerCase()); // future: improvement category extraction

    // Identify common issue categories
    const categories: string[] = [];
    if (weaknessPatterns.some((w) => w.includes('incomplete') || w.includes('missing'))) {
      categories.push('completeness');
    }
    if (weaknessPatterns.some((w) => w.includes('incorrect') || w.includes('wrong'))) {
      categories.push('accuracy');
    }
    if (weaknessPatterns.some((w) => w.includes('unclear') || w.includes('confusing'))) {
      categories.push('clarity');
    }
    if (weaknessPatterns.some((w) => w.includes('verbose') || w.includes('long'))) {
      categories.push('conciseness');
    }

    // Log for analysis (could be stored in database for pattern analysis)
    log.info(
      {
        taskType: context.taskType,
        qualityScore: critique.qualityScore,
        wasImproved,
        weaknessCount: critique.weaknesses.length,
        improvementCount: critique.improvements.length,
        issueCategories: categories,
        cost,
      },
      'Critique learning recorded'
    );

    // Could extend to use autoLearningSystem for persistent learning
    // await autoLearningSystem.recordCritiquePattern({
    //   taskType: context.taskType,
    //   initialQuality: critique.qualityScore,
    //   issueCategories: categories,
    //   wasImproved,
    //   cost,
    // });
  }
}

/**
 * Singleton instance
 */
let critiqueEngineInstance: SelfCritiqueEngine | null = null;

/**
 * Get critique engine instance
 */
export function getSelfCritiqueEngine(): SelfCritiqueEngine {
  if (!critiqueEngineInstance) {
    critiqueEngineInstance = new SelfCritiqueEngine();
  }
  return critiqueEngineInstance;
}

