// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Realtime Feedback Loop
 *
 * Validates and corrects strategy executions in realtime, providing
 * automated feedback and re-tries until quality thresholds are met.
 *
 * OI-10 Enhancement: Archive-aware escalation
 * When the feedback loop exhausts all iterations without meeting the quality
 * threshold, it can escalate to an alternative strategy from the configuration
 * archive (OI-06). This turns "best effort with one strategy" into "best effort
 * across proven strategies", leveraging the archive's quality-diversity knowledge.
 */

import type { ChatMessage, ChatRequest, OrchestrationContext, OrchestrationResult } from '@/types';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { getQualityValidator } from '@/core/validation/quality-validator';
import { getQualityScorer, type QualityScore } from '@/core/quality/quality-scorer';
import type { BaseStrategy } from '@/core/orchestration/base-strategy';
import type { ValidationResult } from '@/core/validation/quality-validator';

export interface RealtimeFeedbackConfig {
  qualityThreshold?: number; // 0-1
  maxIterations?: number;
  allowAutoFix?: boolean;
  /** OI-10: Alternative strategy to escalate to when iterations are exhausted */
  escalationStrategy?: BaseStrategy;
  /** OI-10: Context about why escalation was chosen (for logging) */
  escalationReason?: string;
}

interface FeedbackIteration {
  iteration: number;
  validation: ValidationResult;
  quality: QualityScore;
  autoFixApplied: boolean;
}

export class RealtimeFeedbackLoop {
  private log = logger.child({ component: 'realtime-feedback-loop' });
  private validator = getQualityValidator();
  private scorer = getQualityScorer();

  /**
   * Execute strategy with realtime feedback loop
   */
  async executeWithFeedback(
    strategy: BaseStrategy,
    request: ChatRequest,
    context: OrchestrationContext,
    config: RealtimeFeedbackConfig = {}
  ): Promise<OrchestrationResult> {
    const maxIterations = Math.max(1, config.maxIterations ?? 3);
    const qualityThreshold = Math.min(
      1,
      Math.max(0.6, config.qualityThreshold ?? context.qualityTarget ?? 0.85)
    );
    const allowAutoFix = config.allowAutoFix !== false;

    let currentRequest = this.cloneRequest(request);
    let bestResult: OrchestrationResult | null = null;
    const iterations: FeedbackIteration[] = [];
    let iteration = 0;
    let cumulativeCost = 0;
    let cumulativeDuration = 0;
    const aggregatedExecutions: OrchestrationResult['modelsUsed'] = [];

    while (iteration < maxIterations) {
      iteration += 1;

      this.log.info(
        {
          requestId: context.requestId,
          iteration,
          maxIterations,
        },
        'Executing iteration with realtime feedback loop'
      );

      const executionStart = Date.now();
      const result = await strategy.execute(currentRequest, context);
      const duration = Date.now() - executionStart;
      cumulativeCost += result.totalCost;
      cumulativeDuration += result.totalDuration;
      aggregatedExecutions.push(...result.modelsUsed);

      // Determine primary execution (first successful execution)
      const primaryExecution =
        result.modelsUsed.find((exec) => exec.success && exec.role === 'primary') ||
        result.modelsUsed.find((exec) => exec.success) ||
        result.modelsUsed[0];

      // Calculate quality score (guard null response from failed strategies)
      const qualityScore = result.finalResponse?.choices
        ? this.scorer.calculateScore(result.finalResponse, context, primaryExecution)
        : { overall: 0, dimensions: { correctness: 0, completeness: 0, clarity: 0, efficiency: 0, relevance: 0 }, confidence: 0, reasoning: ['No response available'] } as import('@/core/quality/quality-scorer').QualityScore;
      result.qualityScore = qualityScore.overall;
      result.metadata = {
        ...result.metadata,
        quality: {
          score: qualityScore.overall,
          dimensions: qualityScore.dimensions,
          confidence: qualityScore.confidence,
          reasoning: qualityScore.reasoning,
        },
        feedback_duration_ms: duration,
      };

      // Run validation
      const validation = await this.validator.validate(result.finalResponse, {
        requestId: context.requestId ?? '',
        taskType: context.taskType,
        qualityThreshold,
        startTime: Date.now(),
      });

      let autoFixApplied = false;

      if (!validation.valid && allowAutoFix && validation.autoFixable) {
        this.log.debug(
          { requestId: context.requestId, iteration },
          'Attempting auto-fix for validation issues'
        );
        const fixedResponse = await this.validator.autoFix(result.finalResponse, validation.issues);
        const postFixValidation = await this.validator.validate(fixedResponse, {
          requestId: context.requestId,
          taskType: context.taskType,
          qualityThreshold,
          startTime: Date.now(),
        });

        if (postFixValidation.valid) {
          result.finalResponse = fixedResponse;
          result.metadata = {
            ...result.metadata,
            autoFix: {
              applied: true,
              issueCount: validation.issues.length,
            },
          };
          validation.valid = true;
          validation.issues = postFixValidation.issues;
          validation.suggestions = postFixValidation.suggestions;
          validation.metadata = postFixValidation.metadata;
          autoFixApplied = true;
        }
      }

      const iterationRecord: FeedbackIteration = {
        iteration,
        validation,
        quality: qualityScore,
        autoFixApplied,
      };
      iterations.push(iterationRecord);

      const aggregatedResult: OrchestrationResult = {
        ...result,
        modelsUsed: [...aggregatedExecutions],
        totalCost: cumulativeCost,
        totalDuration: cumulativeDuration,
        metadata: {
          ...result.metadata,
          feedback_iterations: iterations,
        },
      };

      // Track best result so far
      if (!bestResult || qualityScore.overall > (bestResult.qualityScore ?? 0)) {
        bestResult = aggregatedResult;
      }

      // Success criteria: Quality and validation
      const meetsQuality = qualityScore.overall >= qualityThreshold;
      if (validation.valid && meetsQuality) {
        this.log.info(
          {
            requestId: context.requestId,
            iteration,
            quality: qualityScore.overall,
            threshold: qualityThreshold,
          },
          'Realtime feedback loop completed successfully'
        );

        return {
          ...aggregatedResult,
          metadata: {
            ...aggregatedResult.metadata,
            feedback_summary: {
              totalIterations: iteration,
              status: 'success',
              reason: 'Quality threshold met',
            },
          },
        };
      }

      if (iteration >= maxIterations) {
        break;
      }

      // Prepare feedback and retry
      const feedbackMessage = this.buildFeedbackMessage(
        iteration,
        validation,
        qualityScore,
        qualityThreshold
      );

      currentRequest = this.augmentRequestWithFeedback(currentRequest, feedbackMessage);
    }

    this.log.warn(
      {
        requestId: context.requestId,
        maxIterations,
        bestQuality: bestResult?.qualityScore,
        qualityThreshold,
      },
      'Realtime feedback loop exhausted iterations without meeting quality threshold'
    );

    // ── OI-10: Archive-aware escalation ─────────────────────────────────
    // When the primary strategy fails to meet quality after all iterations,
    // try an alternative strategy from the configuration archive.
    // This is the "intelligent" part — instead of giving up, we consult
    // the archive for a proven strategy in this niche.
    if (
      config.escalationStrategy &&
      bestResult &&
      (bestResult.qualityScore ?? 0) < qualityThreshold
    ) {
      this.log.info(
        {
          requestId: context.requestId,
          originalQuality: bestResult.qualityScore,
          qualityThreshold,
          escalationStrategy: config.escalationStrategy.getMetadata().name,
          escalationReason: config.escalationReason ?? 'archive-fallback',
        },
        'Escalating to alternative strategy from archive (OI-10)'
      );

      try {
        const escalationStart = Date.now();
        const escalationResult = await config.escalationStrategy.execute(request, context);
        const escalationDuration = Date.now() - escalationStart;

        // Score the escalation result
        const primaryExecution =
          escalationResult.modelsUsed.find((exec) => exec.success && exec.role === 'primary') ||
          escalationResult.modelsUsed.find((exec) => exec.success) ||
          escalationResult.modelsUsed[0];

        const escalationQuality = this.scorer.calculateScore(
          escalationResult.finalResponse,
          context,
          primaryExecution
        );
        escalationResult.qualityScore = escalationQuality.overall;

        // Use escalation result if it's better
        if (escalationQuality.overall > (bestResult.qualityScore ?? 0)) {
          this.log.info(
            {
              requestId: context.requestId,
              originalQuality: bestResult.qualityScore,
              escalationQuality: escalationQuality.overall,
              escalationStrategy: config.escalationStrategy.getMetadata().name,
              escalationDuration,
            },
            'Archive escalation produced better result (OI-10)'
          );

          return {
            ...escalationResult,
            totalCost: cumulativeCost + escalationResult.totalCost,
            totalDuration: cumulativeDuration + escalationDuration,
            metadata: {
              ...escalationResult.metadata,
              feedback_summary: {
                totalIterations: iterations.length,
                status: escalationQuality.overall >= qualityThreshold ? 'escalation-success' : 'escalation-partial',
                reason: `Primary strategy exhausted; escalated to ${config.escalationStrategy.getMetadata().name}`,
              },
              escalation: {
                triggered: true,
                originalStrategy: bestResult.strategyUsed,
                escalationStrategy: config.escalationStrategy.getMetadata().name,
                originalQuality: bestResult.qualityScore,
                escalationQuality: escalationQuality.overall,
                reason: config.escalationReason ?? 'archive-fallback',
              },
              feedback_iterations: iterations,
            },
          };
        } else {
          this.log.debug(
            {
              requestId: context.requestId,
              originalQuality: bestResult.qualityScore,
              escalationQuality: escalationQuality.overall,
            },
            'Archive escalation did not improve quality — keeping original'
          );
        }
      } catch (escalationErr) {
        this.log.warn(
          {
            requestId: context.requestId,
            error: String(escalationErr),
            escalationStrategy: config.escalationStrategy.getMetadata().name,
          },
          'Archive escalation strategy failed (OI-10) — keeping best original result'
        );
      }
    }

    if (bestResult) {
      bestResult.metadata = {
        ...bestResult.metadata,
        feedback_summary: {
          totalIterations: iterations.length,
          status: 'partial',
          reason: 'Max iterations reached without meeting quality threshold',
        },
        feedback_iterations: iterations,
      };
      return bestResult;
    }

    throw new Error('Realtime feedback loop failed to produce any valid result');
  }

  /**
   * Build feedback message based on validation and quality analysis
   */
  private buildFeedbackMessage(
    iteration: number,
    validation: ValidationResult,
    quality: QualityScore,
    qualityThreshold: number
  ): string {
    const lines: string[] = [];
    lines.push(
      `Iteration ${iteration} did not meet quality requirements. Please address the following:`
    );

    const missingDimensions = Object.entries(quality.dimensions)
      .filter(([_, value]) => value < qualityThreshold)
      .map(
        ([dimension, value]) =>
          `- Improve ${dimension} (current: ${(value * 100).toFixed(0)}%, target: ${(qualityThreshold * 100).toFixed(0)}%)`
      );

    if (missingDimensions.length > 0) {
      lines.push('');
      lines.push('Quality Improvements Needed:');
      lines.push(...missingDimensions);
    }

    if (validation.issues.length > 0) {
      lines.push('');
      lines.push('Validation Issues:');
      for (const issue of validation.issues.slice(0, 5)) {
        lines.push(
          `- [${issue.severity.toUpperCase()}][${issue.type}] ${issue.description}${issue.location ? ` (at ${issue.location})` : ''}`
        );
        if (issue.suggestion) {
          lines.push(`  Suggestion: ${issue.suggestion}`);
        }
      }
      if (validation.issues.length > 5) {
        lines.push(`- ...and ${validation.issues.length - 5} more issues`);
      }
    }

    if (validation.suggestions.length > 0) {
      lines.push('');
      lines.push('Action Items:');
      validation.suggestions.slice(0, 5).forEach((suggestion) => {
        lines.push(`- ${suggestion}`);
      });
    }

    lines.push('');
    lines.push(
      'Generate a corrected response addressing all the items above. Focus on improving correctness, completeness, clarity, efficiency, and relevance.'
    );

    return lines.join('\n');
  }

  /**
   * Augment request with feedback for next iteration
   */
  private augmentRequestWithFeedback(request: ChatRequest, feedback: string): ChatRequest {
    const newMessages: ChatMessage[] = [
      ...request.messages,
      {
        role: 'system',
        content: feedback,
      },
    ];

    return {
      ...request,
      messages: newMessages,
    };
  }

  /**
   * Clone chat request to avoid mutating original
   */
  private cloneRequest(request: ChatRequest): ChatRequest {
    return narrowAs<ChatRequest>(JSON.parse(JSON.stringify(request)));
  }
}
