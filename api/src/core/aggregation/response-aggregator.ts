// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Response Aggregator
 *
 * Intelligently combines multiple model responses using:
 * 1. Voting: Democratic selection (majority wins)
 * 2. Merging: Combine complementary insights
 * 3. Synthesis: Meta-model creates best-of-all
 * 4. Ranking: Quality-based selection
 *
 * Enterprise-ready, production-grade implementation
 */

import type { ChatResponse, TextContent, ToolCall } from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { nanoid } from 'nanoid';
import { PROMPTS } from '@/core/orchestration/prompts/sota-system-prompts';

const log = logger.child({ component: 'response-aggregator' });

/** Normalize a tool_call's arguments so semantically-equal calls compare equal
 *  (top-level key order ignored). */
function normalizeToolArgs(raw: unknown): string {
  if (typeof raw !== 'string') return JSON.stringify(raw ?? null);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify(parsed, Object.keys(parsed ?? {}).sort());
  } catch {
    return raw.trim();
  }
}

/**
 * Elo 3 QUORUM (option B): return the tool_call that a STRICT MAJORITY of the
 * given (successful) voter responses agree on — same function name + normalized
 * args — or null. Only the primary (first) tool_call per voter is considered.
 * This is what lets a collective fire exactly ONE billable modality generation,
 * and only when the collective agrees.
 */
function computeQuorumToolCall(responses: ModelResponse[]): ToolCall | null {
  const n = responses.length;
  if (n === 0) return null;
  const groups = new Map<string, { call: ToolCall; count: number }>();
  for (const r of responses) {
    const calls = r.response?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const call = calls[0];
    const key = `${call.function?.name ?? ''}::${normalizeToolArgs(call.function?.arguments)}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { call, count: 1 });
  }
  let best: { call: ToolCall; count: number } | null = null;
  for (const group of groups.values()) {
    if (!best || group.count > best.count) best = group;
  }
  if (!best) return null;
  const majority = Math.floor(n / 2) + 1; // strict majority of all successful voters
  return best.count >= majority ? best.call : null;
}

/**
 * Model response with metadata
 */
export interface ModelResponse {
  modelId: string;
  modelName: string;
  response: ChatResponse;
  cost: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

/**
 * Aggregation context
 */
export interface AggregationContext {
  requestId: string;
  taskType: string;
  qualityThreshold: number;
  maxCost?: number;
  preferSpeed?: boolean;
  /** Client-requested max_tokens for the SYNTHESIZED answer. When set (>0) the
   *  coordinator honors it (capped at COORDINATOR_MAX_TOKENS_CEILING) instead of
   *  the historical hardcoded 2000 — a client asking for a 128k answer gets it. */
  maxTokens?: number;
}

/** Absolute ceiling for the coordinator's output (128k = 131_072 tokens),
 *  mirroring the triage plan's MAX_TOKENS_CEILING. */
const COORDINATOR_MAX_TOKENS_CEILING = 131_072;

/**
 * Resolve the coordinator (synthesis) max_tokens: honor a positive client value
 * up to the 128k ceiling; otherwise derive from the COORDINATOR MODEL's OWN
 * declared output capability (frontier-parity, per-model) — so the collective's
 * final synthesis is never capped BELOW what a frontier single could emit. Only
 * when neither is available does it fall back to CONSENSUS_SYNTHESIS_MAX_TOKENS
 * (env, historical 2000). Pure; exported for tests.
 */
export function resolveCoordinatorMaxTokens(
  clientMaxTokens?: number,
  coordinatorModelMaxOutput?: number,
): number {
  const requested = Number(clientMaxTokens);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), COORDINATOR_MAX_TOKENS_CEILING);
  }
  const modelCap = Number(coordinatorModelMaxOutput);
  if (Number.isFinite(modelCap) && modelCap > 0) {
    return Math.min(modelCap, COORDINATOR_MAX_TOKENS_CEILING);
  }
  const fallback = Number(process.env.CONSENSUS_SYNTHESIS_MAX_TOKENS) || 2000;
  return Math.min(fallback, COORDINATOR_MAX_TOKENS_CEILING);
}

/**
 * Aggregation method
 */
export type AggregationMethod = 'voting' | 'merging' | 'synthesis' | 'ranking';

/**
 * Aggregated response result
 */
export interface AggregatedResponse {
  response: ChatResponse;
  method: AggregationMethod;
  confidence: number; // 0-1
  /**
   * Billable cost (USD) of the coordinator/synthesizer LLM call, when this
   * aggregation made one (synthesis method). The synthesizer is a real paid
   * sub-call; callers must add this into the request's totalCost (cost-accounting
   * integrity — see consensus-strategy.ts). Undefined for non-LLM methods.
   */
  cost?: number;
  /** Token usage of the coordinator/synthesizer LLM call (when applicable). */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Identity of the coordinator/synthesizer model used (when an LLM coordinator ran). */
  coordinator?: { id: string; name: string };
  metadata: {
    sourcesUsed: string[];
    totalSources: number;
    aggregationTime: number;
    [key: string]: unknown;
  };
}

/**
 * Internal result of an LLM-coordinator synthesis call, carrying the billable
 * cost/usage of the coordinator sub-call so it can be accounted upstream.
 */
interface SynthesisResult {
  response: ChatResponse;
  cost: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  coordinator?: { id: string; name: string };
}

/**
 * Decision extracted from response
 */
interface Decision {
  type: string;
  description: string;
  confidence: number;
  source: string;
}

/**
 * Insight extracted from response
 */
interface Insight {
  category: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  location?: string;
  source: string;
}

/**
 * Response quality score
 */
interface QualityScore {
  overall: number; // 0-100
  correctness: number;
  completeness: number;
  clarity: number;
  efficiency: number;
  breakdown: Record<string, number>;
}

/**
 * Response Aggregator
 */
export class ResponseAggregator {
  /**
   * Aggregate multiple model responses
   */
  async aggregate(
    responses: ModelResponse[],
    method: AggregationMethod,
    context: AggregationContext
  ): Promise<AggregatedResponse> {
    const startTime = Date.now();

    log.info(
      {
        requestId: context.requestId,
        method,
        responseCount: responses.length,
      },
      'Starting response aggregation'
    );

    // Filter successful responses
    const successful = responses.filter((r) => r.success);

    if (successful.length === 0) {
      throw new Error('No successful responses to aggregate');
    }

    if (successful.length === 1) {
      // Only one response, return it directly
      return {
        response: successful[0].response,
        method,
        confidence: 1.0,
        metadata: {
          sourcesUsed: [successful[0].modelName],
          totalSources: responses.length,
          aggregationTime: Date.now() - startTime,
        },
      };
    }

    let result: AggregatedResponse;

    switch (method) {
      case 'voting':
        result = await this.votingAggregation(successful, context);
        break;

      case 'merging':
        result = await this.mergingAggregation(successful, context);
        break;

      case 'synthesis':
        result = await this.synthesisAggregation(successful, context);
        break;

      case 'ranking':
        result = await this.rankingAggregation(successful, context);
        break;

      default:
        throw new Error(`Unknown aggregation method: ${method}`);
    }

    result.metadata.aggregationTime = Date.now() - startTime;

    log.info(
      {
        requestId: context.requestId,
        method,
        confidence: result.confidence,
        aggregationTime: result.metadata.aggregationTime,
      },
      'Response aggregation completed'
    );

    // Elo 3 (option B, 2026-06-11): QUORUM policy for tool_calls in collective
    // synthesis. The synthesizer otherwise drops tool_calls entirely. We
    // preserve exactly ONE tool_call, and only when a strict majority of the
    // successful voters emit the SAME (name + normalized args) call — so a
    // collective `generate_video` fires exactly ONE billable generation, and
    // only when the collective agrees. Below quorum → stays text-only.
    const quorumCall = computeQuorumToolCall(successful);
    if (quorumCall) {
      const choice = result.response?.choices?.[0];
      if (choice?.message) {
        choice.message.tool_calls = [quorumCall];
        choice.finish_reason = 'tool_calls';
        result.metadata.quorumToolCall = quorumCall.function?.name;
      }
    }

    return result;
  }

  /**
   * Voting Aggregation
   *
   * Multiple models vote on the best approach.
   * Majority wins. Reduces individual model bias.
   */
  private async votingAggregation(
    responses: ModelResponse[],
    context: AggregationContext
  ): Promise<AggregatedResponse> {
    log.debug({ requestId: context.requestId }, 'Executing voting aggregation');

    // 1. Extract decisions from each response
    const decisions = responses.map((r) => this.extractDecisions(r));

    // 2. Flatten all decisions
    const allDecisions = decisions.flat();

    // 3. Group similar decisions
    const grouped = this.groupSimilarDecisions(allDecisions);

    // 4. Count votes for each decision group
    const votes = grouped.map((group) => ({
      decision: group[0],
      votes: group.length,
      votePercentage: (group.length / responses.length) * 100,
      sources: group.map((d) => d.source),
    }));

    // 5. Sort by votes (descending)
    votes.sort((a, b) => b.votes - a.votes);

    // 6. Select winner (most votes)
    const winner = votes[0];

    // 7. Find response that best implements winner
    const bestResponse = this.findBestImplementation(responses, winner.decision);

    return {
      response: bestResponse.response,
      method: 'voting',
      confidence: winner.votePercentage / 100,
      metadata: {
        sourcesUsed: winner.sources,
        totalSources: responses.length,
        aggregationTime: 0, // Will be set by caller
        votingResults: {
          winner: winner.decision.description,
          winnerVotes: winner.votes,
          totalVotes: responses.length,
          alternatives: votes.slice(1, 3).map((v) => ({
            decision: v.decision.description,
            votes: v.votes,
          })),
        },
      },
    };
  }

  /**
   * Merging Aggregation
   *
   * Combines complementary insights from multiple models.
   * Each model contributes unique perspectives.
   */
  private async mergingAggregation(
    responses: ModelResponse[],
    context: AggregationContext
  ): Promise<AggregatedResponse> {
    log.debug({ requestId: context.requestId }, 'Executing merging aggregation');

    // 1. Extract insights from each response
    const insights = responses.map((r) => this.extractInsights(r));

    // 2. Flatten all insights
    const allInsights = insights.flat();

    // 3. Deduplicate similar insights
    const uniqueInsights = this.deduplicateInsights(allInsights);

    // 4. Group by category
    const grouped = this.groupInsightsByCategory(uniqueInsights);

    // 5. Merge into comprehensive response
    const merged = this.mergeInsights(grouped, responses[0].response);

    // 6. Calculate confidence based on insight overlap
    const confidence = this.calculateMergeConfidence(insights);

    return {
      response: merged,
      method: 'merging',
      confidence,
      metadata: {
        sourcesUsed: responses.map((r) => r.modelName),
        totalSources: responses.length,
        aggregationTime: 0,
        mergingResults: {
          totalInsights: allInsights.length,
          uniqueInsights: uniqueInsights.length,
          categories: Object.keys(grouped),
          deduplicationRate:
            ((allInsights.length - uniqueInsights.length) / allInsights.length) * 100,
        },
      },
    };
  }

  /**
   * Synthesis Aggregation
   * ✅ PRODUCTION: Uses LLM coordinator for intelligent synthesis
   * Meta-analysis creates best-of-all response.
   * Combines strengths, avoids weaknesses.
   */
  private async synthesisAggregation(
    responses: ModelResponse[],
    context: AggregationContext
  ): Promise<AggregatedResponse> {
    log.debug({ requestId: context.requestId }, 'Executing synthesis aggregation with LLM coordinator');

    // 1. Analyze strengths/weaknesses of each response
    const analysis = this.analyzeResponses(responses);

    // 2. Select best parts from each response
    const bestParts = this.selectBestParts(responses, analysis);

    // 3. Use LLM coordinator for intelligent synthesis
    const synthesized = await this.llmSynthesizeResponse(bestParts, responses, context);

    // 4. Calculate confidence based on analysis
    const confidence = this.calculateSynthesisConfidence(analysis);

    return {
      response: synthesized.response,
      method: 'synthesis',
      confidence,
      // Cost-accounting integrity: the coordinator/synthesizer is a real paid
      // LLM sub-call. Surface its cost/usage/identity so the strategy can fold
      // it into totalCost AND track it as a ModelExecution.
      cost: synthesized.cost,
      usage: synthesized.usage,
      coordinator: synthesized.coordinator,
      metadata: {
        sourcesUsed: bestParts.map((p) => p.source),
        totalSources: responses.length,
        aggregationTime: 0,
        synthesisResults: {
          strengthsUsed: analysis.strengths.length,
          weaknessesAvoided: analysis.weaknesses.length,
          partsSelected: bestParts.length,
          coordinatorUsed: 'llm',
        },
      },
    };
  }

  /**
   * LLM-based synthesis using coordinator model
   * ✅ PRODUCTION: Real LLM coordination for best-of-all synthesis
   *
   * Returns the synthesized response plus the coordinator's billable cost/usage
   * (cost-accounting integrity). On any fallback path (no coordinator / no
   * adapter / error) NO paid call is made, so cost is 0 and usage/coordinator
   * are undefined.
   */
  private async llmSynthesizeResponse(
    parts: Array<{ source: string; content: string }>,
    responses: ModelResponse[],
    context: AggregationContext
  ): Promise<SynthesisResult> {
    try {
      // Select high-quality model for coordination (dynamic selection based on capabilities)
      const { getProviderRegistry } = await import('@/providers/provider-registry.js');
      const registry = getProviderRegistry();
      const allModels = await registry.getAllModels();

      // Find best coordinator model (high quality, supports long context)
      const coordinator = allModels
        .filter((m) => m.contextWindow >= 32000 && m.performance?.quality >= 0.85)
        .sort((a, b) => b.performance.quality - a.performance.quality)[0];

      if (!coordinator) {
        log.warn('No suitable coordinator model found, using simple synthesis');
        return { response: this.synthesizeResponse(parts, responses[0].response), cost: 0 };
      }

      const result = await registry.findModel(coordinator.id);
      if (!result) {
        return { response: this.synthesizeResponse(parts, responses[0].response), cost: 0 };
      }

      const { adapter } = result;

      // Build coordination prompt
      const coordinationPrompt = this.buildCoordinationPrompt(parts, responses, context, coordinator.contextWindow);

      // Call coordinator LLM
      const coordinatedResponse = await adapter.chatCompletion({
        model: coordinator.id,
        messages: [
          {
            // Canonical catalog MERGE prompt (was an inline literal that drifted
            // from the catalog AND lacked LANGUAGE_MIRROR_DIRECTIVE, so this
            // synthesis path could answer in English for a non-English user).
            // Using PROMPTS.collectiveSynthesizer also makes the consensus
            // plan-fingerprint attest the prompt that is actually executed.
            role: 'system',
            content: PROMPTS.collectiveSynthesizer,
          },
          {
            role: 'user',
            content: coordinationPrompt,
          },
        ],
        temperature: 0.3, // Balanced creativity
        // Honor the client's max_tokens (up to 128k); else derive from the
        // coordinator model's OWN output capability (frontier-parity, per-model)
        // — never a static 2000 that clips the collective below a frontier single.
        max_tokens: resolveCoordinatorMaxTokens(context.maxTokens, coordinator.maxOutputTokens),
      });

      // Cost-accounting integrity: the coordinator call is billable. Compute its
      // cost via the same mechanism BaseStrategy uses for any chatCompletion
      // (adapter.calculateCost(model, promptTokens, completionTokens)). Missing
      // usage ⇒ treat as 0 (never throw).
      const usage = coordinatedResponse.usage;
      const cost = adapter.calculateCost(
        coordinator,
        usage?.prompt_tokens ?? 0,
        usage?.completion_tokens ?? 0
      );

      log.info(
        {
          requestId: context.requestId,
          coordinator: coordinator.name,
          sourcesIntegrated: parts.length,
          coordinatorCost: cost,
        },
        'LLM coordinator synthesis completed'
      );

      return {
        response: coordinatedResponse,
        cost: Math.max(0, cost) || 0,
        usage: usage
          ? {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            }
          : undefined,
        coordinator: { id: coordinator.id, name: coordinator.name },
      };
    } catch (error) {
      log.error(
        { requestId: context.requestId, error: getErrorMessage(error) },
        'LLM synthesis failed, falling back to simple synthesis'
      );
      // Fallback to simple synthesis — no paid call was completed, cost 0.
      return { response: this.synthesizeResponse(parts, responses[0].response), cost: 0 };
    }
  }

  /**
   * Build coordination prompt for LLM coordinator
   */
  private buildCoordinationPrompt(
    parts: Array<{ source: string; content: string }>,
    responses: ModelResponse[],
    context: AggregationContext,
    coordinatorContextWindow?: number,
  ): string {
    let prompt = `Task: ${context.taskType}\n\n`;
    prompt += `I have ${responses.length} solutions from different AI models. Please synthesize them into a single, high-quality response.\n\n`;

    // Per-voter excerpt budget, SCALED to the coordinator model's own context
    // window (dynamic, not a static char cap). The old hardcoded 1500 chars let
    // the coordinator see only a fraction of each frontier-length answer — a
    // structural handicap for the collective. Now: share ~70% of the window
    // (≈4 chars/token) across the voters, with the env value as a floor.
    const excerptChars = (() => {
      const envFloor = Number(process.env.CONSENSUS_VOTER_EXCERPT_CHARS) || 12_000;
      const ctx = Number(coordinatorContextWindow);
      if (!Number.isFinite(ctx) || ctx <= 0) return envFloor;
      const inputCharBudget = Math.floor(ctx * 4 * 0.7);
      const perVoter = Math.floor(inputCharBudget / Math.max(1, parts.length));
      return Math.max(envFloor, perVoter);
    })();
    parts.forEach((part, index) => {
      prompt += `=== SOLUTION ${index + 1} (from ${part.source}) ===\n`;
      prompt += `${part.content.substring(0, excerptChars)}\n\n`;
    });

    prompt += `\nYour synthesis should:\n`;
    prompt += `1. Integrate the best insights from all solutions\n`;
    prompt += `2. Resolve any conflicts (choose the most accurate approach)\n`;
    prompt += `3. Provide a cohesive, professional response\n`;
    prompt += `4. Include code examples if relevant\n`;
    prompt += `5. Be actionable and clear\n\n`;
    prompt += `Create a unified response that represents the best of all solutions.`;

    return prompt;
  }

  /**
   * Ranking Aggregation
   *
   * Quality-based selection.
   * Scores each response on multiple dimensions.
   */
  private async rankingAggregation(
    responses: ModelResponse[],
    context: AggregationContext
  ): Promise<AggregatedResponse> {
    log.debug({ requestId: context.requestId }, 'Executing ranking aggregation');

    // 1. Score each response
    const scores = responses.map((r) => ({
      response: r,
      score: this.scoreResponse(r, context),
    }));

    // 2. Sort by score (descending)
    scores.sort((a, b) => b.score.overall - a.score.overall);

    // 3. Select highest-ranked response
    const winner = scores[0];

    return {
      response: winner.response.response,
      method: 'ranking',
      confidence: winner.score.overall / 100,
      metadata: {
        sourcesUsed: [winner.response.modelName],
        totalSources: responses.length,
        aggregationTime: 0,
        rankingResults: {
          rankings: scores.map((s, i) => ({
            rank: i + 1,
            model: s.response.modelName,
            score: s.score.overall,
            breakdown: s.score.breakdown,
          })),
        },
      },
    };
  }

  /**
   * Extract decisions from response
   */
  private extractDecisions(response: ModelResponse): Decision[] {
    const content = this.getResponseContent(response.response);
    const decisions: Decision[] = [];

    // Extract decisions based on patterns
    // For code: Extract method, inline variable, etc.
    // For analysis: Approach A, Approach B, etc.

    // Simple implementation: Extract first sentence as decision
    const firstSentence = content.split(/[.!?]/)[0];
    if (firstSentence) {
      decisions.push({
        type: 'primary',
        description: firstSentence.trim(),
        confidence: 0.8,
        source: response.modelName,
      });
    }

    return decisions;
  }

  /**
   * Group similar decisions
   */
  private groupSimilarDecisions(decisions: Decision[]): Decision[][] {
    const groups: Decision[][] = [];

    for (const decision of decisions) {
      // Find existing group with similar decision
      let found = false;
      for (const group of groups) {
        if (this.areSimilarDecisions(decision, group[0])) {
          group.push(decision);
          found = true;
          break;
        }
      }

      if (!found) {
        groups.push([decision]);
      }
    }

    return groups;
  }

  /**
   * Check if two decisions are similar
   */
  private areSimilarDecisions(a: Decision, b: Decision): boolean {
    // Simple similarity: Check if descriptions overlap by >50%
    const aWords = new Set(a.description.toLowerCase().split(/\s+/));
    const bWords = new Set(b.description.toLowerCase().split(/\s+/));

    const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
    const union = new Set([...aWords, ...bWords]);

    const similarity = intersection.size / union.size;

    return similarity > 0.5;
  }

  /**
   * Find response that best implements decision
   */
  private findBestImplementation(responses: ModelResponse[], decision: Decision): ModelResponse {
    // Find response from same source as decision
    const fromSource = responses.find((r) => r.modelName === decision.source);
    if (fromSource) {
      return fromSource;
    }

    // Fallback: Return first response
    return responses[0];
  }

  /**
   * Extract insights from response
   */
  private extractInsights(response: ModelResponse): Insight[] {
    const content = this.getResponseContent(response.response);
    const insights: Insight[] = [];

    // Extract insights based on patterns
    // For code review: Security, performance, style issues
    // For analysis: Key findings, recommendations

    // Simple implementation: Extract sentences as insights
    const sentences = content.split(/[.!?]/).filter((s) => s.trim().length > 10);

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed) {
        insights.push({
          category: this.categorizeInsight(trimmed),
          description: trimmed,
          severity: this.assessSeverity(trimmed),
          source: response.modelName,
        });
      }
    }

    return insights;
  }

  /**
   * Categorize insight
   */
  private categorizeInsight(text: string): string {
    const lower = text.toLowerCase();

    if (lower.includes('security') || lower.includes('vulnerability')) {
      return 'security';
    }
    if (lower.includes('performance') || lower.includes('slow') || lower.includes('optimize')) {
      return 'performance';
    }
    if (lower.includes('style') || lower.includes('format') || lower.includes('convention')) {
      return 'style';
    }
    if (lower.includes('bug') || lower.includes('error') || lower.includes('fix')) {
      return 'correctness';
    }

    return 'general';
  }

  /**
   * Assess insight severity
   */
  private assessSeverity(text: string): 'low' | 'medium' | 'high' | 'critical' {
    const lower = text.toLowerCase();

    if (lower.includes('critical') || lower.includes('severe') || lower.includes('dangerous')) {
      return 'critical';
    }
    if (lower.includes('important') || lower.includes('significant') || lower.includes('major')) {
      return 'high';
    }
    if (lower.includes('minor') || lower.includes('small')) {
      return 'low';
    }

    return 'medium';
  }

  /**
   * Deduplicate insights
   */
  private deduplicateInsights(insights: Insight[]): Insight[] {
    const unique: Insight[] = [];

    for (const insight of insights) {
      // Check if similar insight already exists
      const exists = unique.some((u) => this.areSimilarInsights(u, insight));

      if (!exists) {
        unique.push(insight);
      }
    }

    return unique;
  }

  /**
   * Check if two insights are similar
   */
  private areSimilarInsights(a: Insight, b: Insight): boolean {
    // Same category and similar description
    if (a.category !== b.category) {
      return false;
    }

    const aWords = new Set(a.description.toLowerCase().split(/\s+/));
    const bWords = new Set(b.description.toLowerCase().split(/\s+/));

    const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
    const union = new Set([...aWords, ...bWords]);

    const similarity = intersection.size / union.size;

    return similarity > 0.6;
  }

  /**
   * Group insights by category
   */
  private groupInsightsByCategory(insights: Insight[]): Record<string, Insight[]> {
    const grouped: Record<string, Insight[]> = {};

    for (const insight of insights) {
      if (!grouped[insight.category]) {
        grouped[insight.category] = [];
      }
      grouped[insight.category].push(insight);
    }

    return grouped;
  }

  /**
   * Merge insights into comprehensive response
   */
  private mergeInsights(grouped: Record<string, Insight[]>, template: ChatResponse): ChatResponse {
    // Build merged content
    let mergedContent = '';

    // Sort categories by severity
    const categories = Object.keys(grouped).sort((a, b) => {
      const aSeverity = this.getCategorySeverity(grouped[a]);
      const bSeverity = this.getCategorySeverity(grouped[b]);
      return bSeverity - aSeverity;
    });

    for (const category of categories) {
      const insights = grouped[category];

      mergedContent += `\n\n## ${this.formatCategory(category)}\n\n`;

      // Sort insights by severity
      insights.sort((a, b) => {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
      });

      for (const insight of insights) {
        const severityEmoji = this.getSeverityEmoji(insight.severity);
        mergedContent += `${severityEmoji} ${insight.description}\n`;
        if (insight.location) {
          mergedContent += `   Location: ${insight.location}\n`;
        }
        mergedContent += `   Source: ${insight.source}\n\n`;
      }
    }

    // Create merged response
    return {
      ...template,
      id: nanoid(),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: mergedContent.trim(),
          },
          finish_reason: 'stop',
        },
      ],
    };
  }

  /**
   * Get category severity (for sorting)
   */
  private getCategorySeverity(insights: Insight[]): number {
    const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    const maxSeverity = Math.max(...insights.map((i) => severityOrder[i.severity]));
    return maxSeverity;
  }

  /**
   * Format category name
   */
  private formatCategory(category: string): string {
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  /**
   * Get severity emoji
   */
  private getSeverityEmoji(severity: Insight['severity']): string {
    const emojis = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢',
    };
    return emojis[severity];
  }

  /**
   * Calculate merge confidence
   */
  private calculateMergeConfidence(insights: Insight[][]): number {
    // Confidence based on insight overlap
    const allInsights = insights.flat();
    const uniqueInsights = this.deduplicateInsights(allInsights);

    const overlapRate = (allInsights.length - uniqueInsights.length) / allInsights.length;

    // Higher overlap = higher confidence (models agree)
    return Math.min(1, 0.5 + overlapRate * 0.5);
  }

  /**
   * Analyze responses for synthesis
   */
  private analyzeResponses(responses: ModelResponse[]): {
    strengths: Array<{ source: string; strength: string }>;
    weaknesses: Array<{ source: string; weakness: string }>;
  } {
    const strengths: Array<{ source: string; strength: string }> = [];
    const weaknesses: Array<{ source: string; weakness: string }> = [];

    for (const response of responses) {
      const content = this.getResponseContent(response.response);

      // Analyze content length
      if (content.length > 500) {
        strengths.push({
          source: response.modelName,
          strength: 'Comprehensive and detailed',
        });
      } else if (content.length < 100) {
        weaknesses.push({
          source: response.modelName,
          weakness: 'Too brief, lacks detail',
        });
      }

      // Analyze code blocks
      const codeBlocks = (content.match(/```/g) || []).length / 2;
      if (codeBlocks > 0) {
        strengths.push({
          source: response.modelName,
          strength: 'Includes code examples',
        });
      }
    }

    return { strengths, weaknesses };
  }

  /**
   * Select best parts from responses
   */
  private selectBestParts(
    responses: ModelResponse[],
    analysis: ReturnType<typeof this.analyzeResponses>
  ): Array<{ source: string; content: string }> {
    const parts: Array<{ source: string; content: string }> = [];

    // Select from responses with strengths
    const strongSources = new Set(analysis.strengths.map((s) => s.source));

    for (const response of responses) {
      if (strongSources.has(response.modelName)) {
        parts.push({
          source: response.modelName,
          content: this.getResponseContent(response.response),
        });
      }
    }

    // If no strong sources, use all
    if (parts.length === 0) {
      for (const response of responses) {
        parts.push({
          source: response.modelName,
          content: this.getResponseContent(response.response),
        });
      }
    }

    return parts;
  }

  /**
   * Synthesize response from parts
   */
  private synthesizeResponse(
    parts: Array<{ source: string; content: string }>,
    template: ChatResponse
  ): ChatResponse {
    // Simple synthesis: Concatenate parts with attribution
    let synthesized = '';

    for (const part of parts) {
      synthesized += `### From ${part.source}\n\n${part.content}\n\n`;
    }

    return {
      ...template,
      id: nanoid(),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: synthesized.trim(),
          },
          finish_reason: 'stop',
        },
      ],
    };
  }

  /**
   * Calculate synthesis confidence
   */
  private calculateSynthesisConfidence(analysis: ReturnType<typeof this.analyzeResponses>): number {
    const totalAnalysis = analysis.strengths.length + analysis.weaknesses.length;
    if (totalAnalysis === 0) {
      return 0.5;
    }

    const strengthRatio = analysis.strengths.length / totalAnalysis;
    return Math.min(1, 0.3 + strengthRatio * 0.7);
  }

  /**
   * Score response quality
   */
  private scoreResponse(response: ModelResponse, context: AggregationContext): QualityScore {
    const content = this.getResponseContent(response.response);

    // Score dimensions
    const correctness = this.scoreCorrectness(content, context);
    const completeness = this.scoreCompleteness(content, context);
    const clarity = this.scoreClarity(content);
    const efficiency = this.scoreEfficiency(response);

    // Weighted overall score
    const overall = correctness * 0.4 + completeness * 0.3 + clarity * 0.2 + efficiency * 0.1;

    return {
      overall,
      correctness,
      completeness,
      clarity,
      efficiency,
      breakdown: {
        correctness,
        completeness,
        clarity,
        efficiency,
      },
    };
  }

  /**
   * Score correctness
   */
  private scoreCorrectness(content: string, context: AggregationContext): number {
    let score = 50; // Base score

    // Check for code blocks (if code task)
    if (context.taskType.includes('code')) {
      const hasCodeBlocks = content.includes('```');
      score += hasCodeBlocks ? 20 : -10;
    }

    // Check for errors/warnings
    const hasErrors = /error|warning|issue/i.test(content);
    score += hasErrors ? -10 : 10;

    // Check for validation keywords
    const hasValidation = /valid|correct|works|tested/i.test(content);
    score += hasValidation ? 10 : 0;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Score completeness
   */
  private scoreCompleteness(content: string, context: AggregationContext): number {
    let score = 50; // Base score

    // Length-based scoring
    if (content.length > 500) {
      score += 20;
    } else if (content.length < 100) {
      score -= 20;
    }

    // Check for examples
    const hasExamples = /example|for instance|such as/i.test(content);
    score += hasExamples ? 15 : 0;

    // Check for explanations
    const hasExplanations = /because|since|therefore|thus/i.test(content);
    score += hasExplanations ? 15 : 0;

    // Task-aware adjustments
    if (context.taskType.includes('analysis')) {
      const referencesEvidence = /data|evidence|metric|observation|chart/i.test(content);
      score += referencesEvidence ? 10 : -10;
    }

    if (context.taskType.includes('documentation') || context.taskType.includes('doc')) {
      const hasHeadings = /^#{1,6}\s/m.test(content);
      const hasOrderedSteps = /^[0-9]+\./m.test(content);
      if (hasHeadings) {
        score += 10;
      }
      if (hasOrderedSteps) {
        score += 10;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Score clarity
   */
  private scoreClarity(content: string): number {
    let score = 50; // Base score

    // Check for structure (headings, lists)
    const hasStructure = /^#{1,6}\s|^[-*]\s/m.test(content);
    score += hasStructure ? 20 : 0;

    // Check for formatting
    const hasFormatting = /```|`[^`]+`|\*\*[^*]+\*\*/g.test(content);
    score += hasFormatting ? 15 : 0;

    // Penalize very long sentences
    const sentences = content.split(/[.!?]/);
    const avgLength = sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length;
    if (avgLength > 200) {
      score -= 15;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Score efficiency (cost/time)
   */
  private scoreEfficiency(response: ModelResponse): number {
    let score = 50; // Base score

    // Prefer faster responses
    if (response.durationMs < 1000) {
      score += 25;
    } else if (response.durationMs > 5000) {
      score -= 15;
    }

    // Prefer cheaper responses
    if (response.cost < 0.001) {
      score += 25;
    } else if (response.cost > 0.01) {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get response content
   */
  private getResponseContent(response: ChatResponse | null | undefined): string {
    if (!response?.choices) return '';
    const choice = response.choices[0];
    if (!choice) {
      return '';
    }

    const message = choice.message || choice.delta;
    if (!message) {
      return '';
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }

    return '';
  }
}

/**
 * Singleton instance
 */
let aggregatorInstance: ResponseAggregator | null = null;

/**
 * Get aggregator instance
 */
export function getResponseAggregator(): ResponseAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new ResponseAggregator();
  }
  return aggregatorInstance;
}
