// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Benchmark Evaluator
 *
 * Executes benchmark tasks against the CI/API and evaluates results
 * using multiple scoring methods. Includes reward integrity cross-validation
 * to detect gaming of the heuristic quality scorer (OI-02).
 *
 * Evaluation methods:
 * - pattern-match: Regex/exact match against expected output
 * - rubric-checklist: LLM checks specific items (most reproducible)
 * - llm-judge: Open LLM evaluation (least reproducible, used for creative tasks)
 * - diff-format: Validates code diffs are well-formed
 * - composite: Combines multiple methods
 */

import { logger } from '@/utils/logger';
import {
  recordBenchmarkRun,
  recordBenchmarkTask,
} from '@/observability/ci-metrics';
import type {
  BenchmarkTask,
  BenchmarkExecutionResult,
  BenchmarkRun,
  BenchmarkConfig,
  CategoryScore,
  StrategyScore,
  RewardIntegrityResult,
  GamingSignal,
  ChecklistResult,
  BenchmarkCategory,
  BenchmarkTrend,
} from './types';

const log = logger.child({ component: 'benchmark-evaluator' });

// ─── Default Configuration ───────────────────────────────────────────────────

export function loadBenchmarkConfig(): BenchmarkConfig {
  return {
    enabled: process.env.CI_BENCHMARK_HARNESS_ENABLED !== 'false',
    cronSchedule: process.env.CI_BENCHMARK_HARNESS_CRON || '0 4 * * *',
    apiBase: process.env.BOOTSTRAP_API_BASE
      ?? (process.env.EVAL_API_BASE_URL
        ? `${process.env.EVAL_API_BASE_URL}/v1/chat/completions`
        : 'http://localhost:3000/v1/chat/completions'),
    bearerToken: process.env.BOOTSTRAP_BEARER_TOKEN ?? process.env.EVAL_BEARER_TOKEN ?? '',
    delayBetweenCallsMs: parseInt(process.env.CI_BENCHMARK_HARNESS_DELAY_MS || '2000', 10),
    maxTasksPerRun: parseInt(process.env.CI_BENCHMARK_HARNESS_MAX_TASKS || '30', 10),
    enableRewardIntegrity: process.env.CI_BENCHMARK_REWARD_INTEGRITY !== 'false',
    rewardIntegritySampleRate: parseFloat(process.env.CI_BENCHMARK_INTEGRITY_RATE || '0.15'),
    driftCorrelationThreshold: parseFloat(process.env.CI_BENCHMARK_DRIFT_THRESHOLD || '0.7'),
    maxBudgetPerRun: parseFloat(process.env.CI_BENCHMARK_MAX_BUDGET || '25.0'),
    persistResults: process.env.CI_BENCHMARK_PERSIST !== 'false',
  };
}

// ─── Benchmark Evaluator ─────────────────────────────────────────────────────

export class BenchmarkEvaluator {
  private config: BenchmarkConfig;
  private totalCostAccumulated = 0;

  constructor(config?: Partial<BenchmarkConfig>) {
    this.config = { ...loadBenchmarkConfig(), ...config };
  }

  /**
   * Execute a full benchmark run
   */
  async executeRun(
    tasks: BenchmarkTask[],
    previousRun?: BenchmarkRun
  ): Promise<BenchmarkRun> {
    const runId = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    this.totalCostAccumulated = 0;

    log.info({ runId, taskCount: tasks.length }, 'Starting benchmark run');

    const results: BenchmarkExecutionResult[] = [];

    for (const task of tasks) {
      // Budget guard
      if (this.totalCostAccumulated >= this.config.maxBudgetPerRun) {
        log.warn({ accumulated: this.totalCostAccumulated, budget: this.config.maxBudgetPerRun },
          'Budget limit reached — stopping benchmark run');
        break;
      }

      for (const strategy of task.strategies) {
        const result = await this.executeTask(task, strategy);
        results.push(result);
        this.totalCostAccumulated += result.costUsd;
        await this.delay(this.config.delayBetweenCallsMs);
      }
    }

    // Calculate aggregates
    const categoryScores = this.calculateCategoryScores(results);
    const strategyScores = this.calculateStrategyScores(results);
    const overallScore = this.calculateOverallScore(results);

    // Reward integrity cross-validation
    let rewardIntegrity: RewardIntegrityResult | undefined;
    if (this.config.enableRewardIntegrity) {
      rewardIntegrity = await this.runRewardIntegrityCheck(results);
    }

    // Trend comparison
    let trend: BenchmarkTrend | undefined;
    if (previousRun) {
      trend = this.calculateTrend(previousRun, overallScore, categoryScores);
    }

    const completedAt = new Date().toISOString();
    const run: BenchmarkRun = {
      runId,
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      results,
      categoryScores,
      strategyScores,
      overallScore,
      totalCostUsd: this.totalCostAccumulated,
      rewardIntegrity,
      trend,
    };

    log.info({
      runId,
      overallScore: overallScore.toFixed(3),
      totalCost: this.totalCostAccumulated.toFixed(4),
      resultsCount: results.length,
      driftDetected: rewardIntegrity?.driftDetected,
      trend: trend?.verdict,
    }, 'Benchmark run completed');

    // ─── Emit Prometheus metrics ──────────────────────────────────────────────
    try {
      recordBenchmarkRun({
        verdict: trend?.verdict ?? 'stable',
        overallScore,
        durationMs: run.durationMs,
        totalCostUsd: run.totalCostUsd,
        categoryScores: categoryScores.map(cs => ({
          category: cs.category,
          averageScore: cs.avgQuality,
        })),
        rewardCorrelation: rewardIntegrity?.correlation,
        driftDetected: rewardIntegrity?.driftDetected,
        gamingSignals: rewardIntegrity?.gamingSignals?.map(gs => ({
          type: gs.type,
          severity: gs.severity,
        })),
      });

      // Per-task metrics
      for (const result of results) {
        if (!result.success) continue;
        const prefix = result.taskId.split('-')[0];
        const catMap: Record<string, string> = {
          'cg': 'coding-generate', 'ce': 'coding-edit', 'cd': 'coding-debug',
          'cr': 'coding-review', 'at': 'analysis-technical', 'ad': 'analysis-data',
          'ax': 'analysis-text', 'fq': 'factual-qa', 'cv': 'creative',
          'ms': 'multi-step', 'rs': 'reasoning',
        };
        recordBenchmarkTask({
          category: catMap[prefix] ?? 'unknown',
          difficulty: 'medium',
          strategy: result.strategy,
          qualityScore: result.heuristicScore,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
        });
      }
    } catch (metricsErr) {
      log.warn({ error: String(metricsErr) }, 'Failed to emit benchmark metrics');
    }

    return run;
  }

  /**
   * Execute a single task with a specific strategy
   */
  private async executeTask(
    task: BenchmarkTask,
    strategy: string
  ): Promise<BenchmarkExecutionResult> {
    const startMs = Date.now();

    try {
      // Call the CI/API
      const messages: Array<{ role: string; content: string }> = [];
      if (task.systemPrompt) {
        messages.push({ role: 'system', content: task.systemPrompt });
      }
      messages.push({ role: 'user', content: task.prompt });

      const resp = await fetch(this.config.apiBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'auto',
          strategy,
          messages,
        }),
        signal: AbortSignal.timeout(task.maxLatencyMs ?? 30000),
      });

      const durationMs = Date.now() - startMs;
      const json = await resp.json() as {
        error?: { message: string };
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        ailin_metadata?: { total_cost?: number; models_used?: string[] };
      };

      if (json.error || !resp.ok) {
        return this.failedResult(task, strategy, durationMs, json.error?.message ?? `HTTP ${resp.status}`);
      }

      const content = json.choices?.[0]?.message?.content ?? '';
      if (!content) {
        return this.failedResult(task, strategy, durationMs, 'Empty response content');
      }

      // Evaluate using the task's evaluation method
      const evaluation = await this.evaluateResponse(task, content);
      const costUsd = json.ailin_metadata?.total_cost ?? this.estimateCost(json.usage);
      const modelsUsed = json.ailin_metadata?.models_used;

      return {
        taskId: task.id,
        strategy,
        modelsUsed,
        responseContent: content.slice(0, 5000), // Cap storage
        heuristicScore: evaluation.heuristicScore,
        llmJudgeScore: evaluation.llmJudgeScore,
        dimensions: evaluation.dimensions,
        checklistResults: evaluation.checklistResults,
        diffFormatCompliance: evaluation.diffFormatCompliance,
        success: true,
        durationMs,
        costUsd,
        tokenUsage: json.usage ? {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
          total: json.usage.total_tokens ?? 0,
        } : undefined,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return this.failedResult(task, strategy, Date.now() - startMs,
        err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Evaluate a response using the task's specified method
   */
  private async evaluateResponse(task: BenchmarkTask, content: string): Promise<{
    heuristicScore: number;
    llmJudgeScore?: number;
    dimensions?: BenchmarkExecutionResult['dimensions'];
    checklistResults?: ChecklistResult[];
    diffFormatCompliance?: number;
  }> {
    switch (task.evaluationMethod) {
      case 'pattern-match':
        return this.evaluatePatternMatch(task, content);

      case 'rubric-checklist':
        return this.evaluateChecklist(task, content);

      case 'llm-judge':
        return this.evaluateLLMJudge(task, content);

      case 'diff-format':
        return this.evaluateDiffFormat(task, content);

      case 'composite':
        return this.evaluateComposite(task, content);

      default:
        return { heuristicScore: 0.5 };
    }
  }

  /**
   * Pattern match evaluation — exact or regex match
   */
  private evaluatePatternMatch(task: BenchmarkTask, content: string): {
    heuristicScore: number;
  } {
    if (!task.expectedPattern) return { heuristicScore: 0 };

    const regex = new RegExp(task.expectedPattern, 'is');
    const matches = regex.test(content);
    return { heuristicScore: matches ? 1.0 : 0.0 };
  }

  /**
   * Rubric checklist evaluation — LLM checks specific items
   * This is the most reproducible LLM-based evaluation method.
   */
  private async evaluateChecklist(task: BenchmarkTask, content: string): Promise<{
    heuristicScore: number;
    llmJudgeScore: number;
    checklistResults: ChecklistResult[];
  }> {
    if (!task.checklistItems?.length) {
      return { heuristicScore: 0.5, llmJudgeScore: 0.5, checklistResults: [] };
    }

    // Build checklist prompt
    const itemsList = task.checklistItems
      .map((item, i) => `${i + 1}. ${item}`)
      .join('\n');

    const checkPrompt = `You are evaluating an AI response against a specific checklist.

TASK DESCRIPTION: ${task.name}
TASK PROMPT: ${task.prompt.slice(0, 500)}

RESPONSE TO EVALUATE:
${content.slice(0, 3000)}

CHECKLIST ITEMS:
${itemsList}

For each checklist item, determine if the response satisfies it.
Respond ONLY with JSON in this exact format:
{
  "items": [
    { "index": 1, "passed": true, "evidence": "brief quote or reason" },
    { "index": 2, "passed": false, "evidence": "missing X" }
  ]
}`;

    try {
      const resp = await fetch(this.config.apiBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'auto',
          strategy: 'single',
          messages: [{ role: 'user', content: checkPrompt }],
          temperature: 0.1,
          max_tokens: 1000,
        }),
      });

      const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const judgeContent = json.choices?.[0]?.message?.content ?? '';

      const parsed = this.parseJSONFromContent(judgeContent) as {
        items?: Array<{ index: number; passed: boolean; evidence?: string }>;
      };

      if (!parsed?.items) {
        return { heuristicScore: 0.5, llmJudgeScore: 0.5, checklistResults: [] };
      }

      const checklistResults: ChecklistResult[] = task.checklistItems.map((item, i) => {
        const result = parsed.items?.find(r => r.index === i + 1);
        return {
          item,
          passed: result?.passed ?? false,
          evidence: result?.evidence,
        };
      });

      const passedCount = checklistResults.filter(r => r.passed).length;
      const score = passedCount / checklistResults.length;

      return {
        heuristicScore: score,
        llmJudgeScore: score,
        checklistResults,
      };
    } catch (err) {
      log.warn({ taskId: task.id, error: String(err) }, 'Checklist evaluation failed');
      return { heuristicScore: 0.5, llmJudgeScore: 0.5, checklistResults: [] };
    }
  }

  /**
   * Open LLM judge evaluation — for creative/subjective tasks
   */
  private async evaluateLLMJudge(task: BenchmarkTask, content: string): Promise<{
    heuristicScore: number;
    llmJudgeScore: number;
    dimensions: BenchmarkExecutionResult['dimensions'];
  }> {
    const judgePrompt = `RUBRIC:\n${task.judgeRubric}\n\nRESPONSE:\n${content.slice(0, 3000)}\n\nEvaluate the response. Respond ONLY with JSON:\n{"score": 0.0-1.0, "correctness": 0.0-1.0, "completeness": 0.0-1.0, "clarity": 0.0-1.0, "relevance": 0.0-1.0}`;

    try {
      const resp = await fetch(this.config.apiBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'auto',
          strategy: 'single',
          messages: [{ role: 'user', content: judgePrompt }],
          temperature: 0.1,
          max_tokens: 500,
        }),
      });

      const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const judgeContent = json.choices?.[0]?.message?.content ?? '';

      const parsed = this.parseJSONFromContent(judgeContent) as {
        score?: number;
        correctness?: number;
        completeness?: number;
        clarity?: number;
        relevance?: number;
      };

      const score = this.clamp(parsed?.score ?? 0.5);

      return {
        heuristicScore: score,
        llmJudgeScore: score,
        dimensions: {
          correctness: this.clamp(parsed?.correctness ?? score),
          completeness: this.clamp(parsed?.completeness ?? score),
          clarity: this.clamp(parsed?.clarity ?? score),
          efficiency: 0.5, // LLM can't judge this
          relevance: this.clamp(parsed?.relevance ?? score),
        },
      };
    } catch {
      return {
        heuristicScore: 0.5,
        llmJudgeScore: 0.5,
        dimensions: { correctness: 0.5, completeness: 0.5, clarity: 0.5, efficiency: 0.5, relevance: 0.5 },
      };
    }
  }

  /**
   * Diff format compliance evaluation — for coding edit tasks
   */
  private evaluateDiffFormat(task: BenchmarkTask, content: string): {
    heuristicScore: number;
    diffFormatCompliance: number;
  } {
    // Check for diff markers
    const hasDiffBlock = /```diff\n/.test(content);
    const hasUnifiedDiff = /^[-+]{3}\s/m.test(content) || /^@@\s/m.test(content);
    const hasAddRemove = /^\+[^+]/m.test(content) && /^-[^-]/m.test(content);

    let compliance = 0;
    if (hasDiffBlock) compliance += 0.4;
    if (hasUnifiedDiff) compliance += 0.3;
    if (hasAddRemove) compliance += 0.3;

    return {
      heuristicScore: compliance,
      diffFormatCompliance: compliance,
    };
  }

  /**
   * Composite evaluation — combines diff-format + checklist
   */
  private async evaluateComposite(task: BenchmarkTask, content: string): Promise<{
    heuristicScore: number;
    llmJudgeScore?: number;
    checklistResults?: ChecklistResult[];
    diffFormatCompliance?: number;
  }> {
    const checklist = await this.evaluateChecklist(task, content);
    const diffFormat = this.evaluateDiffFormat(task, content);

    // Weighted average: 70% checklist (substance) + 30% format (compliance)
    const heuristicScore = checklist.heuristicScore * 0.7 + diffFormat.heuristicScore * 0.3;

    return {
      heuristicScore,
      llmJudgeScore: checklist.llmJudgeScore,
      checklistResults: checklist.checklistResults,
      diffFormatCompliance: diffFormat.diffFormatCompliance,
    };
  }

  // ─── Reward Integrity Cross-Validation (OI-02) ────────────────────────────

  /**
   * Cross-validate heuristic scores against LLM judge scores
   * to detect potential reward hacking or metric gaming.
   */
  private async runRewardIntegrityCheck(
    results: BenchmarkExecutionResult[]
  ): Promise<RewardIntegrityResult> {
    // Select results that have BOTH heuristic and LLM judge scores
    const crossValidatable = results.filter(
      r => r.success && r.heuristicScore !== undefined && r.llmJudgeScore !== undefined
    );

    if (crossValidatable.length < 5) {
      return {
        sampleCount: crossValidatable.length,
        correlation: 1.0,
        meanAbsoluteDiff: 0,
        divergentTasks: [],
        driftDetected: false,
        gamingSignals: [],
      };
    }

    // Calculate Pearson correlation
    const hScores = crossValidatable.map(r => r.heuristicScore);
    const jScores = crossValidatable.map(r => r.llmJudgeScore!);
    const correlation = this.pearsonCorrelation(hScores, jScores);

    // Calculate mean absolute difference
    const diffs = crossValidatable.map(r => Math.abs(r.heuristicScore - (r.llmJudgeScore ?? r.heuristicScore)));
    const meanAbsoluteDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;

    // Find divergent tasks (diff > 0.3)
    const divergentTasks = crossValidatable
      .filter(r => Math.abs(r.heuristicScore - (r.llmJudgeScore ?? r.heuristicScore)) > 0.3)
      .map(r => ({
        taskId: r.taskId,
        heuristicScore: r.heuristicScore,
        llmJudgeScore: r.llmJudgeScore!,
        diff: r.heuristicScore - r.llmJudgeScore!,
      }));

    // Detect gaming signals
    const gamingSignals = this.detectGamingSignals(results);

    const driftDetected = correlation < this.config.driftCorrelationThreshold;

    if (driftDetected) {
      log.error({
        correlation: correlation.toFixed(3),
        threshold: this.config.driftCorrelationThreshold,
        divergentCount: divergentTasks.length,
        gamingSignalCount: gamingSignals.length,
      }, 'REWARD INTEGRITY DRIFT DETECTED — heuristic scores diverge from LLM judge');
    }

    return {
      sampleCount: crossValidatable.length,
      correlation,
      meanAbsoluteDiff,
      divergentTasks,
      driftDetected,
      gamingSignals,
    };
  }

  /**
   * Detect specific gaming patterns in responses
   */
  private detectGamingSignals(results: BenchmarkExecutionResult[]): GamingSignal[] {
    const signals: GamingSignal[] = [];

    for (const result of results) {
      if (!result.success) continue;
      const content = result.responseContent;

      // Long-low-info: response is very long but quality score from judge is low
      if (content.length > 2000 && (result.llmJudgeScore ?? 1) < 0.4) {
        signals.push({
          type: 'long-low-info',
          taskId: result.taskId,
          evidence: `Response length ${content.length} chars but judge score ${result.llmJudgeScore?.toFixed(2)}`,
          severity: 'high',
        });
      }

      // Repetitive padding: same phrases repeated
      const sentences = content.split(/[.!?\n]/).filter(s => s.trim().length > 20);
      const uniqueSentences = new Set(sentences.map(s => s.trim().toLowerCase()));
      if (sentences.length > 5 && uniqueSentences.size < sentences.length * 0.6) {
        signals.push({
          type: 'repetitive-padding',
          taskId: result.taskId,
          evidence: `${sentences.length} sentences but only ${uniqueSentences.size} unique (${(uniqueSentences.size / sentences.length * 100).toFixed(0)}%)`,
          severity: 'medium',
        });
      }

      // Keyword stuffing: excessive use of scoring-trigger keywords
      const keywordPattern = /\b(correct|comprehensive|complete|accurate|efficient|relevant|clear|robust|secure|optimal)\b/gi;
      const keywordMatches = content.match(keywordPattern);
      if (keywordMatches && keywordMatches.length > 15) {
        signals.push({
          type: 'keyword-stuffing',
          taskId: result.taskId,
          evidence: `${keywordMatches.length} scoring-trigger keywords found`,
          severity: 'medium',
        });
      }

      // Format without substance: lots of formatting (headers, bullets) but low actual content
      const formattingChars = (content.match(/[#*\-`>|]/g) || []).length;
      const totalChars = content.length;
      if (totalChars > 500 && formattingChars / totalChars > 0.15) {
        signals.push({
          type: 'format-without-substance',
          taskId: result.taskId,
          evidence: `${(formattingChars / totalChars * 100).toFixed(1)}% formatting characters`,
          severity: 'low',
        });
      }
    }

    return signals;
  }

  // ─── Aggregation ───────────────────────────────────────────────────────────

  private calculateCategoryScores(results: BenchmarkExecutionResult[]): CategoryScore[] {
    const byCategory = new Map<string, BenchmarkExecutionResult[]>();
    for (const r of results) {
      const _category = r.taskId.split('-').slice(0, 2).join('-') as string;
      // Map task ID prefix to category
      const categoryMap: Record<string, BenchmarkCategory> = {
        'cg': 'coding-generate', 'ce': 'coding-edit', 'cd': 'coding-debug',
        'cr': 'coding-review', 'at': 'analysis-technical', 'ad': 'analysis-data',
        'ax': 'analysis-text', 'fq': 'factual-qa', 'cv': 'creative',
        'ms': 'multi-step', 'rs': 'reasoning',
      };
      const prefix = r.taskId.split('-')[0];
      const cat = categoryMap[prefix] ?? 'coding-generate';
      const existing = byCategory.get(cat) ?? [];
      existing.push(r);
      byCategory.set(cat, existing);
    }

    return [...byCategory.entries()].map(([category, categoryResults]) => ({
      category: category as BenchmarkCategory,
      avgQuality: this.avg(categoryResults.filter(r => r.success).map(r => r.llmJudgeScore ?? r.heuristicScore)),
      avgLatencyMs: this.avg(categoryResults.map(r => r.durationMs)),
      avgCostUsd: this.avg(categoryResults.map(r => r.costUsd)),
      successRate: categoryResults.filter(r => r.success).length / categoryResults.length,
      taskCount: categoryResults.length,
    }));
  }

  private calculateStrategyScores(results: BenchmarkExecutionResult[]): StrategyScore[] {
    const byStrategy = new Map<string, BenchmarkExecutionResult[]>();
    for (const r of results) {
      const existing = byStrategy.get(r.strategy) ?? [];
      existing.push(r);
      byStrategy.set(r.strategy, existing);
    }

    return [...byStrategy.entries()].map(([strategy, stratResults]) => ({
      strategy,
      avgQuality: this.avg(stratResults.filter(r => r.success).map(r => r.llmJudgeScore ?? r.heuristicScore)),
      avgLatencyMs: this.avg(stratResults.map(r => r.durationMs)),
      avgCostUsd: this.avg(stratResults.map(r => r.costUsd)),
      successRate: stratResults.filter(r => r.success).length / stratResults.length,
      taskCount: stratResults.length,
    }));
  }

  private calculateOverallScore(results: BenchmarkExecutionResult[]): number {
    const successful = results.filter(r => r.success);
    if (successful.length === 0) return 0;
    return this.avg(successful.map(r => r.llmJudgeScore ?? r.heuristicScore));
  }

  private calculateTrend(
    previous: BenchmarkRun,
    currentOverall: number,
    currentCategories: CategoryScore[]
  ): BenchmarkTrend {
    const delta = currentOverall - previous.overallScore;
    const alerts: string[] = [];

    const categoryDeltas = currentCategories.map(current => {
      const prev = previous.categoryScores.find(p => p.category === current.category);
      const prevScore = prev?.avgQuality ?? 0;
      const catDelta = current.avgQuality - prevScore;

      if (catDelta < -0.05) {
        alerts.push(`${current.category}: degraded by ${(catDelta * 100).toFixed(1)}pp`);
      }

      return {
        category: current.category,
        previous: prevScore,
        current: current.avgQuality,
        delta: catDelta,
      };
    });

    let verdict: 'improved' | 'degraded' | 'stable';
    if (delta > 0.02) verdict = 'improved';
    else if (delta < -0.02) verdict = 'degraded';
    else verdict = 'stable';

    return {
      previousOverallScore: previous.overallScore,
      currentOverallScore: currentOverall,
      delta,
      categoryDeltas,
      verdict,
      alerts,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private failedResult(
    task: BenchmarkTask,
    strategy: string,
    durationMs: number,
    error: string
  ): BenchmarkExecutionResult {
    return {
      taskId: task.id,
      strategy,
      responseContent: '',
      heuristicScore: 0,
      success: false,
      error,
      durationMs,
      costUsd: 0,
      timestamp: new Date().toISOString(),
    };
  }

  private parseJSONFromContent(content: string): unknown {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content;
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  private estimateCost(usage?: { prompt_tokens?: number; completion_tokens?: number }): number {
    if (!usage) return 0.001; // Minimum estimate
    const promptCost = (usage.prompt_tokens ?? 0) * 0.000003;  // ~$3/M tokens avg
    const completionCost = (usage.completion_tokens ?? 0) * 0.000015; // ~$15/M tokens avg
    return promptCost + completionCost;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 3) return 1;

    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;

    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const denom = Math.sqrt(denomX * denomY);
    if (denom === 0) return 1;
    return numerator / denom;
  }

  private clamp(v: number, min = 0, max = 1): number {
    return Math.max(min, Math.min(max, v));
  }

  private avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
