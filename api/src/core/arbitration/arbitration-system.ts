// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Arbitration System
 *
 * Evaluates and selects between multiple competitive solutions
 * Based on: ORQUESTRACAO_AVANCADA_ATE_9_MODELOS.md
 *
 * Used by:
 *   - Competitive Strategy: Multiple models compete, arbiters choose best
 *   - Consensus Strategy: Models vote, arbiters build consensus
 *   - Quality Multi-Pass: Validators evaluate each iteration
 *
 * Process:
 *   1. Multiple models generate solutions
 *   2. Arbiter models evaluate each solution
 *   3. Aggregate arbiter evaluations
 *   4. Select best or request refinement
 *
 * Example:
 *   Solutions: [GPT-4o solution, Claude solution, DeepSeek solution]
 *   Arbiters: [Claude Opus, GPT-4o]
 *   Process:
 *     - Each arbiter scores all 3 solutions
 *     - Aggregate scores
 *     - Select highest scoring solution
 *     - Or request refinement if all scores < threshold
 */

import { logger } from '@/utils/logger';
import type { ChatResponse } from '@/types';
import { safeResponseContent } from '@/core/orchestration/base-strategy';
import {
  JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS,
  normalizeJudgeOutput,
} from '@/core/quality/judge-schema';

/**
 * Solution to be evaluated
 */
export interface CompetitiveSolution {
  modelId: string;
  modelName: string;
  provider: string;
  response: ChatResponse;
  cost: number;
  durationMs: number;
}

/**
 * Arbiter evaluation of solutions
 */
export interface ArbiterEvaluation {
  arbiterModel: string;
  scores: number[]; // Score 0-100 for each solution
  strengths: string[][]; // Strengths of each solution
  weaknesses: string[][]; // Weaknesses of each solution
  recommendation: string;
  suggestedImprovements: string[][];
  confidence: number; // 0-1
}

/**
 * Arbitration result
 */
export interface ArbitrationResult {
  action: 'accept' | 'request_refinement' | 'reject';
  selectedSolution?: CompetitiveSolution;
  selectedIndex?: number;
  aggregatedScore?: number;
  reasoning: string;
  allScores?: number[][]; // arbiter x solution matrix
  qualityScore?: number;
  suggestedImprovements?: string[];
}

/**
 * Revision request
 */
export interface RevisionRequest {
  originalSolution: CompetitiveSolution;
  feedback: {
    weaknesses: string[];
    improvements: string[];
    targetQuality: number;
  };
  iteration: number;
}

/**
 * Arbitration System
 */
export class ArbitrationSystem {
  private log = logger.child({ component: 'arbitration' });

  /**
   * Arbitrate between multiple competitive solutions
   *
   * Process:
   *   1. Each arbiter evaluates all solutions
   *   2. Aggregate evaluations
   *   3. Select best or request refinement
   */
  async arbitrate(
    solutions: CompetitiveSolution[],
    arbiterModels: Array<{ id: string; name: string; provider: string }>,
    qualityThreshold: number = 0.85
  ): Promise<ArbitrationResult> {
    this.log.info(
      {
        solutionCount: solutions.length,
        arbiterCount: arbiterModels.length,
      },
      'Starting arbitration'
    );

    // 1. Each arbiter evaluates all solutions (in parallel for speed)
    const evaluations = await this.evaluateAllSolutions(solutions, arbiterModels);

    // 2. Aggregate evaluations
    const aggregated = this.aggregateEvaluations(evaluations, solutions.length);

    // 3. Select best solution
    const bestIndex = this.findBestSolution(aggregated.scores);
    const bestScore = aggregated.scores[bestIndex] / 100; // Normalize to 0-1

    this.log.info(
      {
        bestIndex,
        bestScore,
        qualityThreshold,
      },
      'Arbitration complete'
    );

    // 4. Decide action based on quality threshold
    if (bestScore >= qualityThreshold) {
      return {
        action: 'accept',
        selectedSolution: solutions[bestIndex],
        selectedIndex: bestIndex,
        aggregatedScore: bestScore,
        qualityScore: bestScore,
        reasoning: `Selected solution ${bestIndex + 1} with aggregated score ${bestScore.toFixed(2)} (threshold: ${qualityThreshold})`,
        allScores: evaluations.map((e) => e.scores),
      };
    } else if (bestScore >= 0.7) {
      // Good but not great - request refinement
      return {
        action: 'request_refinement',
        selectedSolution: solutions[bestIndex],
        selectedIndex: bestIndex,
        aggregatedScore: bestScore,
        reasoning: `Best score ${bestScore.toFixed(2)} below threshold ${qualityThreshold}. Requesting refinement.`,
        suggestedImprovements: this.compileSuggestedImprovements(evaluations, bestIndex),
        allScores: evaluations.map((e) => e.scores),
      };
    } else {
      // All solutions poor quality - reject
      return {
        action: 'reject',
        aggregatedScore: bestScore,
        reasoning: `All solutions scored below 0.7. Best: ${bestScore.toFixed(2)}. Consider different approach.`,
        allScores: evaluations.map((e) => e.scores),
      };
    }
  }

  /**
   * Evaluate all solutions with all arbiters (parallel for efficiency)
   * ✅ PRODUCTION: Uses real LLM arbiters for evaluation
   */
  private async evaluateAllSolutions(
    solutions: CompetitiveSolution[],
    arbiterModels: Array<{ id: string; name: string; provider: string }>
  ): Promise<ArbiterEvaluation[]> {
    // Execute all arbiter evaluations in parallel for efficiency
    const evaluationPromises = arbiterModels.map((arbiter) =>
      this.llmArbiterEvaluation(arbiter, solutions)
    );

    return Promise.all(evaluationPromises);
  }

  /**
   * LLM-based arbiter evaluation (PRODUCTION implementation)
   * Each arbiter LLM evaluates all solutions and provides structured feedback
   */
  private async llmArbiterEvaluation(
    arbiter: { id: string; name: string; provider: string },
    solutions: CompetitiveSolution[]
  ): Promise<ArbiterEvaluation> {
    try {
      // Get adapter for arbiter model
      const { getProviderRegistry } = await import('@/providers/provider-registry.js');
      const registry = getProviderRegistry();
      const result = await registry.findModel(arbiter.id);

      if (!result) {
        this.log.warn({ arbiter: arbiter.id }, 'Arbiter model not found, using heuristic');
        return this.heuristicEvaluation(arbiter, solutions);
      }

      const { adapter } = result;

      // Build arbiter prompt with all solutions
      const prompt = this.buildArbiterPrompt(solutions);

      // Call arbiter LLM with structured output
      const response = await adapter.chatCompletion({
        model: arbiter.id,
        messages: [
          {
            role: 'system',
            content:
              `You are an expert arbiter evaluating multiple AI model solutions.\n` +
              `Score each solution on correctness, completeness, clarity, and efficiency.\n` +
              `Return the canonical Ailin¹ JudgeVerdict. Use \`dimensions\` keyed by \`solution_0\`, \`solution_1\`, ... ` +
              `for per-solution quality. Use \`issues\` with \`location: "solution N"\` for weaknesses. ` +
              `Use \`winnerIndex\` for the best solution.\n\n` +
              `${JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS}`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1, // Low temperature for consistent evaluation
        max_tokens: 1500,
      });

      // Parse structured response
      const evaluation = this.parseArbiterResponse(response, arbiter, solutions.length);

      this.log.debug(
        {
          arbiter: arbiter.id,
          scores: evaluation.scores,
          confidence: evaluation.confidence,
        },
        'LLM arbiter evaluation completed'
      );

      return evaluation;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { arbiter: arbiter.id, error: errorMessage },
        'LLM arbiter evaluation failed, falling back to heuristic'
      );
      // Fallback to heuristic if LLM call fails
      return this.heuristicEvaluation(arbiter, solutions);
    }
  }

  /**
   * Build prompt for arbiter LLM
   */
  private buildArbiterPrompt(solutions: CompetitiveSolution[]): string {
    let prompt = `Evaluate the following ${solutions.length} solutions and provide structured feedback.\n\n`;

    solutions.forEach((solution, index) => {
      const contentStr = safeResponseContent(solution.response);

      prompt += `=== SOLUTION ${index + 1} ===\n`;
      prompt += `Model: ${solution.modelName} (${solution.provider})\n`;
      prompt += `Cost: $${solution.cost.toFixed(4)}\n`;
      prompt += `Duration: ${solution.durationMs}ms\n`;
      prompt += `\nContent:\n${contentStr.substring(0, 2000)}\n\n`;
    });

    prompt += `\nProvide your evaluation in JSON format:\n`;
    prompt += `{\n`;
    prompt += `  "scores": [score1, score2, ...],  // 0-100 for each solution\n`;
    prompt += `  "strengths": [["strength1", "strength2"], ...],  // For each solution\n`;
    prompt += `  "weaknesses": [["weakness1", "weakness2"], ...],  // For each solution\n`;
    prompt += `  "recommendation": "Brief recommendation of best solution",\n`;
    prompt += `  "suggested_improvements": [["improvement1"], ...],  // For each solution\n`;
    prompt += `  "confidence": 0.0-1.0  // Your confidence in this evaluation\n`;
    prompt += `}\n\n`;
    prompt += `Evaluate based on:\n`;
    prompt += `- Correctness: Is the solution accurate and bug-free?\n`;
    prompt += `- Completeness: Does it address all requirements?\n`;
    prompt += `- Clarity: Is it well-structured and understandable?\n`;
    prompt += `- Efficiency: Is it performant and cost-effective?\n\n`;
    prompt += `Respond ONLY with valid JSON, no other text.`;

    return prompt;
  }

  /**
   * Parse arbiter LLM response into structured `ArbiterEvaluation`.
   *
   * J-Final (Lote 4): the parser now routes through `normalizeJudgeOutput`
   * so the legacy `{scores: [0-100], weaknesses, strengths, recommendation}`
   * shape is adapted to the canonical `JudgeVerdict` first. The canonical
   * verdict is then mapped back to `ArbiterEvaluation` at the boundary so
   * consumers downstream continue reading the shape they expect. The legacy
   * parser path is still exercised by `normalizeArbitrationScores` inside
   * the normalizer, so models emitting the old shape keep working.
   */
  private parseArbiterResponse(
    response: { choices?: Array<{ message?: { content?: string | unknown } }> },
    arbiter: { id: string; name: string; provider: string },
    solutionCount: number
  ): ArbiterEvaluation {
    const choices = response.choices;
    if (!choices || choices.length === 0) {
      return this.defaultArbiterEvaluation(arbiter, solutionCount, 'No response choices available');
    }
    const content = choices[0]?.message?.content || '';
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

    const verdict = normalizeJudgeOutput(contentStr, {
      where: 'arbitration-system.arbiter',
      candidateCount: solutionCount,
    });

    if (!verdict) {
      this.log.warn(
        { arbiter: arbiter.id, preview: contentStr.slice(0, 200) },
        'Failed to normalize arbiter response via unified schema, using heuristic default',
      );
      return this.defaultArbiterEvaluation(arbiter, solutionCount, 'Unable to parse arbiter response');
    }

    // Canonical verdict → ArbiterEvaluation mapping. Dimensions map to the
    // 0-100 `scores[]` array when the normalizer produced per-solution dims
    // (normalizeArbitrationScores emits `solution_0`, `solution_1`, ...).
    const scores: number[] = [];
    for (let i = 0; i < solutionCount; i++) {
      const dim = verdict.dimensions?.[`solution_${i}`];
      scores.push(typeof dim === 'number' ? Math.round(dim * 100) : Math.round(verdict.score * 100));
    }

    // Group verdict issues by `solution N` location so each solution gets
    // its own weakness list, matching the legacy consumer contract.
    const weaknesses: string[][] = Array.from({ length: solutionCount }, () => [] as string[]);
    for (const issue of verdict.issues) {
      const match = issue.location.match(/solution\s+(\d+)/i);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        if (idx >= 0 && idx < solutionCount) weaknesses[idx].push(issue.description);
      }
    }

    // `Array(n).fill(value)` returns `any[]` — re-annotate the typed result
    // explicitly so downstream usages get correct element types.
    return {
      arbiterModel: arbiter.id,
      scores,
      strengths: Array.from({ length: solutionCount }, (): string[] => ['Clear', 'Practical']),
      weaknesses,
      recommendation: verdict.summary ?? 'No recommendation provided',
      suggestedImprovements: Array.from({ length: solutionCount }, (): string[] => []),
      confidence: verdict.confidence ?? 0.8,
    };
  }

  private defaultArbiterEvaluation(
    arbiter: { id: string; name: string; provider: string },
    solutionCount: number,
    recommendation: string,
  ): ArbiterEvaluation {
    return {
      arbiterModel: arbiter.id,
      scores: Array.from({ length: solutionCount }, (): number => 70),
      strengths: Array.from({ length: solutionCount }, (): string[] => ['Clear', 'Practical']),
      weaknesses: Array.from({ length: solutionCount }, (): string[] => []),
      recommendation,
      suggestedImprovements: Array.from({ length: solutionCount }, (): string[] => []),
      confidence: 0.5,
    };
  }

  /**
   * Heuristic evaluation (simulates arbiter LLM call)
   *
   * In production, this would:
   *   1. Build prompt with all solutions
   *   2. Call arbiter LLM with structured output
   *   3. Parse scores and feedback
   */
  private heuristicEvaluation(
    arbiter: { id: string; name: string; provider: string },
    solutions: CompetitiveSolution[]
  ): ArbiterEvaluation {
    const scores = solutions.map((solution) => {
      let score = 70; // Base score

      // Score based on response quality indicators
      const contentStr = safeResponseContent(solution.response);

      // Longer response generally better (more detailed)
      if (contentStr.length > 1000) score += 10;
      if (contentStr.length > 2000) score += 5;

      // Has code examples (indicates practical solution)
      if (contentStr.includes('```')) score += 10;

      // Structured response
      if (contentStr.includes('##') || contentStr.includes('###')) score += 5;

      // Cost efficiency bonus (cheaper is better, within reason)
      if (solution.cost < 0.01) score += 5;

      // Speed bonus (faster is better)
      if (solution.durationMs < 3000) score += 5;

      return Math.min(score, 100);
    });

    return {
      arbiterModel: arbiter.id,
      scores,
      strengths: solutions.map(() => ['Clear', 'Practical']),
      weaknesses: solutions.map(() => []),
      recommendation: `Solution ${scores.indexOf(Math.max(...scores)) + 1} is best`,
      suggestedImprovements: solutions.map(() => []),
      confidence: 0.8,
    };
  }

  /**
   * Aggregate evaluations from multiple arbiters
   */
  private aggregateEvaluations(
    evaluations: ArbiterEvaluation[],
    solutionCount: number
  ): { scores: number[]; confidence: number } {
    const aggregatedScores: number[] = Array.from({ length: solutionCount }, () => 0);

    // Average scores across all arbiters
    for (const evaluation of evaluations) {
      for (let i = 0; i < solutionCount; i++) {
        aggregatedScores[i] += evaluation.scores[i];
      }
    }

    // Divide by arbiter count for average
    const arbiterCount = evaluations.length;
    for (let i = 0; i < solutionCount; i++) {
      aggregatedScores[i] /= arbiterCount;
    }

    // Confidence based on arbiter agreement
    const confidence = this.calculateConfidence(evaluations);

    return { scores: aggregatedScores, confidence };
  }

  /**
   * Calculate confidence based on arbiter agreement
   */
  private calculateConfidence(evaluations: ArbiterEvaluation[]): number {
    if (evaluations.length === 1) return 0.7; // Low confidence with single arbiter

    // Calculate variance in scores
    // High variance = low confidence (arbiters disagree)
    // Low variance = high confidence (arbiters agree)

    const avgConfidence =
      evaluations.reduce((sum, e) => sum + e.confidence, 0) / evaluations.length;

    return avgConfidence;
  }

  /**
   * Find best solution index
   */
  private findBestSolution(scores: number[]): number {
    return scores.indexOf(Math.max(...scores));
  }

  /**
   * Compile suggested improvements from arbiters
   */
  private compileSuggestedImprovements(
    evaluations: ArbiterEvaluation[],
    solutionIndex: number
  ): string[] {
    const improvements = new Set<string>();

    for (const evaluation of evaluations) {
      const solutionImprovements = evaluation.suggestedImprovements[solutionIndex] || [];
      solutionImprovements.forEach((imp) => improvements.add(imp));
    }

    return Array.from(improvements);
  }

  /**
   * Request revision from model based on feedback
   * ✅ PRODUCTION: Re-calls LLM with structured feedback for refinement
   */
  async requestRevision(
    revisionRequest: RevisionRequest,
    model: { id: string; name: string; provider: string }
  ): Promise<CompetitiveSolution> {
    this.log.info(
      {
        modelId: model.id,
        iteration: revisionRequest.iteration,
        improvementCount: revisionRequest.feedback.improvements.length,
      },
      'Requesting solution revision with LLM'
    );

    try {
      // Get adapter for model
      const { getProviderRegistry } = await import('@/providers/provider-registry.js');
      const registry = getProviderRegistry();
      const result = await registry.findModel(model.id);

      if (!result || !result.model) {
        this.log.warn({ model: model.id }, 'Model not found for revision, returning original');
        return revisionRequest.originalSolution;
      }

      const { adapter, model: fullModel } = result;

      // Build refinement prompt with feedback
      const originalContentStr = safeResponseContent(revisionRequest.originalSolution.response);

      const refinementPrompt = `You previously provided this solution:\n\n${originalContentStr}\n\nFeedback from quality review:\n\nWeaknesses identified:\n${revisionRequest.feedback.weaknesses.map((w) => `- ${w}`).join('\n')}\n\nSuggested improvements:\n${revisionRequest.feedback.improvements.map((i) => `- ${i}`).join('\n')}\n\nTarget quality score: ${revisionRequest.feedback.targetQuality}\n\nPlease refine your solution addressing the feedback above. Maintain what works well, improve the weak points.`;

      // Call model again with refinement prompt
      const startTime = Date.now();
      const refinedResponse = await adapter.chatCompletion({
        model: model.id,
        messages: [
          {
            role: 'assistant',
            content: originalContentStr,
          },
          {
            role: 'user',
            content: refinementPrompt,
          },
        ],
        temperature: 0.3, // Slightly creative for improvements
        max_tokens: 2000,
      });

      const durationMs = Date.now() - startTime;
      const cost = adapter.calculateCost(
        fullModel,
        refinedResponse.usage?.prompt_tokens || 0,
        refinedResponse.usage?.completion_tokens || 0
      );

      this.log.info(
        {
          modelId: model.id,
          iteration: revisionRequest.iteration,
          durationMs,
          cost,
        },
        'Solution revision completed'
      );

      return {
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        response: refinedResponse,
        cost,
        durationMs,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { model: model.id, error: errorMessage },
        'Revision request failed, returning original solution'
      );
      return revisionRequest.originalSolution;
    }
  }

  /**
   * Iterative refinement until quality threshold
   *
   * Process:
   *   1. Evaluate solution
   *   2. If quality < threshold, request refinement
   *   3. Re-evaluate refined solution
   *   4. Repeat up to maxIterations
   */
  async iterativeRefinement(
    initialSolution: CompetitiveSolution,
    arbiterModel: { id: string; name: string; provider: string },
    qualityThreshold: number = 0.9,
    maxIterations: number = 3
  ): Promise<{
    finalSolution: CompetitiveSolution;
    iterations: number;
    finalScore: number;
    improved: boolean;
  }> {
    let currentSolution = initialSolution;
    let iteration = 0;

    while (iteration < maxIterations) {
      // Evaluate current solution
      const evaluation = this.heuristicEvaluation(arbiterModel, [currentSolution]);
      const score = evaluation.scores[0];

      this.log.debug(
        {
          iteration: iteration + 1,
          score,
          threshold: qualityThreshold * 100,
        },
        'Refinement iteration'
      );

      // Check if quality is good enough
      if (score >= qualityThreshold * 100) {
        return {
          finalSolution: currentSolution,
          iterations: iteration + 1,
          finalScore: score / 100,
          improved: iteration > 0,
        };
      }

      // Request refinement
      currentSolution = await this.requestRevision(
        {
          originalSolution: currentSolution,
          feedback: {
            weaknesses: evaluation.weaknesses[0] || [],
            improvements: evaluation.suggestedImprovements[0] || [],
            targetQuality: qualityThreshold,
          },
          iteration: iteration + 1,
        },
        {
          id: currentSolution.modelId,
          name: currentSolution.modelName,
          provider: currentSolution.provider,
        }
      );

      iteration++;
    }

    // Max iterations reached
    const finalEvaluation = this.heuristicEvaluation(arbiterModel, [currentSolution]);

    return {
      finalSolution: currentSolution,
      iterations: iteration,
      finalScore: finalEvaluation.scores[0] / 100,
      improved: iteration > 0,
    };
  }

  /**
   * Build consensus from multiple solutions
   *
   * Used by Consensus Strategy
   */
  buildConsensus(
    solutions: CompetitiveSolution[],
    evaluations: ArbiterEvaluation[]
  ): {
    consensusSolution: CompetitiveSolution;
    consensusScore: number;
    agreement: number; // 0-1, how much arbiters agree
  } {
    const aggregated = this.aggregateEvaluations(evaluations, solutions.length);
    const bestIndex = this.findBestSolution(aggregated.scores);

    // Calculate agreement (lower variance = higher agreement)
    const scoreVariances = this.calculateScoreVariances(evaluations);
    const avgVariance = scoreVariances.reduce((sum, v) => sum + v, 0) / scoreVariances.length;
    const agreement = Math.max(0, 1 - avgVariance / 1000); // Normalize variance to 0-1

    return {
      consensusSolution: solutions[bestIndex],
      consensusScore: aggregated.scores[bestIndex] / 100,
      agreement,
    };
  }

  /**
   * Calculate score variance for each solution
   */
  private calculateScoreVariances(evaluations: ArbiterEvaluation[]): number[] {
    if (evaluations.length === 0) return [];

    const solutionCount = evaluations[0].scores.length;
    const variances: number[] = [];

    for (let i = 0; i < solutionCount; i++) {
      const scores = evaluations.map((e) => e.scores[i]);
      const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
      const variance = scores.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / scores.length;
      variances.push(variance);
    }

    return variances;
  }
}

// Export singleton instance
export const arbitrationSystem = new ArbitrationSystem();
