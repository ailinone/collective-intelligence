// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Quality Scorer
 *
 * Calculates real quality scores for responses based on multiple dimensions.
 * Replaces hardcoded quality scores with objective measurements.
 *
 * Features:
 * - Heuristic-based scoring (fast, no API calls)
 * - LLM-as-Judge scoring (optional, higher accuracy for critical tasks)
 *
 * Enterprise-ready, production-grade implementation
 */

import type {
  ChatResponse,
  OrchestrationContext,
  ModelExecution,
  TextContent,
  ChatRequest,
} from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { safeResponseContent } from '@/core/orchestration/base-strategy';
import { normalizeJudgeOutput } from '@/core/quality/judge-schema';

const log = logger.child({ component: 'quality-scorer' });

/**
 * Quality dimensions
 */
export interface QualityDimensions {
  correctness: number; // 0-1: Syntax, logic, accuracy
  completeness: number; // 0-1: Addresses all requirements
  clarity: number; // 0-1: Readability, structure
  efficiency: number; // 0-1: Performance, resource usage
  relevance: number; // 0-1: Matches request intent
}

/**
 * Quality score result
 */
export interface QualityScore {
  overall: number; // 0-1: Weighted average
  dimensions: QualityDimensions;
  confidence: number; // 0-1: How confident we are in this score
  reasoning: string[];
  method?: 'heuristic' | 'llm-judge'; // Which method was used
}

/**
 * LLM Judge evaluation result (parsed from JSON response)
 */
interface LLMJudgeEvaluation {
  correctness: number;
  completeness: number;
  clarity: number;
  relevance: number;
  overall: number;
  reasoning: string[];
  confidence: number;
  /**
   * Billable cost (USD) of the LLM-judge call. Cost-accounting integrity
   * (TIER 0): the judge is a real paid LLM sub-call whose cost was previously
   * dropped. Populated by evaluateWithLLMJudge; 0 when usage is unavailable.
   */
  costUsd?: number;
  /**
   * TIER 1 (2026-06-11): set true when the judge degraded to a NON-judged
   * neutral score (e.g. the judge output could not be parsed). The learning
   * policy must refuse to learn from a `judgeFailed` result rather than treat
   * the neutral 0.5 as a real verdict. A missing judge MODEL throws instead
   * (the mandatory-policy caller maps that to judgeFailed=true).
   */
  judgeFailed?: boolean;
}

/**
 * Options for LLM-as-Judge scoring
 */
export interface LLMJudgeOptions {
  enabled: boolean;
  judgeModel?: string; // Model to use as judge (defaults to high-quality model)
  originalRequest?: ChatRequest; // Original user request for context
  minScoreThreshold?: number; // Only use LLM judge if heuristic score is below this
}

/**
 * Quality Scorer
 */
export class QualityScorer {
  /**
   * Calculate quality score for response (heuristic-based, fast)
   */
  calculateScore(
    response: ChatResponse,
    _context: OrchestrationContext,
    execution?: ModelExecution
  ): QualityScore {
    const content = this.getResponseContent(response);

    // Calculate each dimension
    const correctness = this.scoreCorrectness(content, _context, execution);
    const completeness = this.scoreCompleteness(content, _context);
    const clarity = this.scoreClarity(content);
    const efficiency = this.scoreEfficiency(execution, _context);
    const relevance = this.scoreRelevance(content, _context);

    // Calculate weighted overall score
    const overall = this.calculateWeightedScore({
      correctness,
      completeness,
      clarity,
      efficiency,
      relevance,
    });

    // Calculate confidence
    const confidence = this.calculateConfidence(
      { correctness, completeness, clarity, efficiency, relevance },
      execution
    );

    // Generate reasoning
    const reasoning = this.generateReasoning({
      correctness,
      completeness,
      clarity,
      efficiency,
      relevance,
    });

    return {
      overall,
      dimensions: {
        correctness,
        completeness,
        clarity,
        efficiency,
        relevance,
      },
      confidence,
      reasoning,
      method: 'heuristic',
    };
  }

  /**
   * Calculate quality score with optional LLM-as-Judge
   * 
   * When enabled, uses an LLM to evaluate the response quality.
   * This provides higher accuracy for critical tasks but incurs additional API cost.
   * 
   * Flow:
   * 1. Calculate heuristic score first (fast)
   * 2. If LLM judge enabled AND heuristic score below threshold, use LLM
   * 3. Combine or replace heuristic score with LLM evaluation
   */
  async calculateScoreWithLLMJudge(
    response: ChatResponse,
    context: OrchestrationContext,
    execution: ModelExecution | undefined,
    options: LLMJudgeOptions
  ): Promise<QualityScore> {
    // Always calculate heuristic score first
    const heuristicScore = this.calculateScore(response, context, execution);

    // Check if LLM judge should be used
    if (!options.enabled) {
      return heuristicScore;
    }

    const threshold = options.minScoreThreshold ?? 0.85;
    
    // Skip LLM judge if heuristic score is already high enough
    if (heuristicScore.overall >= threshold) {
      log.debug(
        {
          heuristicScore: heuristicScore.overall,
          threshold,
        },
        'Skipping LLM judge - heuristic score above threshold'
      );
      return heuristicScore;
    }

    try {
      const llmScore = await this.evaluateWithLLMJudge(
        response,
        context,
        options.originalRequest,
        options.judgeModel
      );

      log.info(
        {
          heuristicScore: heuristicScore.overall,
          llmScore: llmScore.overall,
          method: 'llm-judge',
        },
        'LLM judge evaluation completed'
      );

      // Combine efficiency from heuristic (LLM can't judge this) with LLM evaluation
      return {
        overall: llmScore.overall,
        dimensions: {
          correctness: llmScore.correctness,
          completeness: llmScore.completeness,
          clarity: llmScore.clarity,
          efficiency: heuristicScore.dimensions.efficiency, // Keep heuristic efficiency
          relevance: llmScore.relevance,
        },
        confidence: llmScore.confidence,
        reasoning: llmScore.reasoning,
        method: 'llm-judge',
      };
    } catch (error) {
      log.warn(
        { error: getErrorMessage(error) },
        'LLM judge evaluation failed, falling back to heuristic'
      );
      return heuristicScore;
    }
  }

  /**
   * Use an LLM to evaluate response quality
   * Returns structured evaluation with scores and reasoning
   */
  private async evaluateWithLLMJudge(
    response: ChatResponse,
    context: OrchestrationContext,
    originalRequest?: ChatRequest,
    judgeModel?: string
  ): Promise<LLMJudgeEvaluation> {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const allModels = await registry.getAllModels();

    // Judge routing (2026-06-19): the judge dynamically selects a FUNCTIONAL
    // provider — the same operability/health awareness the main execution path
    // uses, which the judge originally bypassed (audit: "operability filter never
    // imported by the selector/judge"). Signals, in order:
    //   (1) OPERABILITY filter — exclude providers the hub has classified bad
    //       (auth_failed / no_credits / rate_limited), so a provider with an
    //       invalid key or no balance is routed AROUND automatically. The judge
    //       also records its OWN call failures to the hub (see below), so it
    //       self-heals even though only base-strategy normally feeds the hub.
    //   (2) NATIVE preference — prefer openai/anthropic/deepseek-native/… over hub
    //       aggregators (static set, telemetry-independent — holds on a cold hub).
    //   (3) chat-capable + quality/context.
    // Then findModel(id, provider) routes to the selected provider.
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub.js');
    const isNative = (m: { providerId?: string; provider?: string }): boolean => {
      try { return getProviderOperabilityHub().isNativeProvider(m.providerId ?? m.provider ?? ''); }
      catch { return false; }
    };
    // Chat-capability for the JUDGE pool: require an EXPLICIT `chat` capability.
    // Rigorous on purpose — the judge calls chatCompletion, so a completions-only
    // model (davinci-002/babbage-002 = ['completions','text_generation'], NO chat)
    // must NOT enter the pool. Accepting `text_generation` (the generic
    // isChatCapable predicate) let those in and the cascade hit "requires
    // completions endpoint" → judgeFailed. Models that do BOTH (['chat',
    // 'completions']) still qualify because they carry `chat`.
    const isChatModel = (m: { capabilities?: ReadonlyArray<unknown> }): boolean =>
      (m.capabilities ?? []).some((c) => String(c).toLowerCase() === 'chat');
    // (1) Operability-filter the candidate pool — drops providers the hub has
    // classified auth_failed/no_credits/etc. allowUnknown:true keeps unprobed
    // providers (native-preference + the self-feeding failure recording below
    // steer to a working one). Never throws; falls back to the full pool.
    let judgePool = allModels;
    try {
      const { filterModelsByProviderOperability } = await import('@/core/operability/operability-filter.js');
      const { eligible } = await filterModelsByProviderOperability(allModels, {
        reasonPrefix: 'llm_judge',
        // Camada 2: proven-operable judges only. allowUnknown:true let the
        // quality-ranked top pick land on UNPROVEN providers that then time out,
        // exhausting the cascade ("exhausted all operable candidates"). If this
        // filters to empty we fall back to the full pool below (the
        // `eligible.length > 0` guard), so it never starves.
        allowUnknown: false,
      });
      if (eligible.length > 0) judgePool = eligible;
    } catch (operErr) {
      log.warn({ error: getErrorMessage(operErr) }, 'Judge operability filter unavailable — using full model pool');
    }

    // ── Fully DYNAMIC judge with FALLBACK (Camada 2, 2026-06-28): build an
    //    ORDERED, provider-DIVERSE candidate list and try them in sequence
    //    (cascade). NO static model pin: the prior PRODUCTION_JUDGE_MODEL env
    //    soft-pin was REMOVED (no-static-models rule). The judge is now chosen
    //    purely by MEASURED quality (performance.quality is populated for ~72.8k
    //    models) + context + operability + provider diversity. An explicit
    //    judgeModel ARG is still honored as a CONTEXTUAL override (e.g. gold-label
    //    calibration) — caller-driven, not a hardcoded default.
    //   1. Explicit judgeModel arg (contextual override) → soft first preference
    //      (native instance only; a dead hub serves the same id and 401/403s).
    //   2. Dynamic native-preferred ranking by MEASURED quality, then context.
    //   3. Provider diversity so the cascade falls through to a DIFFERENT provider.
    const pinnedJudgeId = judgeModel;
    let pinnedNative: (typeof allModels)[number] | undefined;
    if (pinnedJudgeId) {
      const pinMatches = judgePool.filter((m) => m.id === pinnedJudgeId || m.name === pinnedJudgeId);
      pinnedNative = pinMatches.find(isNative);
      if (!pinnedNative && !judgeModel) {
        const onHubOnly = pinMatches.length > 0;
        log.warn(
          { pinnedJudgeId, onHubOnly },
          onHubOnly
            ? 'PRODUCTION_JUDGE_MODEL has no native-provider instance (hub-only) — using dynamic native pick instead'
            : 'PRODUCTION_JUDGE_MODEL not found in catalog — using dynamic native pick',
        );
      }
    }

    // Rank chat-capable, native-preferred models by MEASURED quality + context.
    // performance.quality is populated for ~72.8k models (Camada 2), so quality —
    // not just the context tiers — drives the ordering (tier gate below + the
    // quality tiebreaker). This is what makes removing the static pin safe: the
    // top of this ranking is a genuinely strong, operable judge.
    const chat = judgePool.filter((m) => isChatModel(m));
    const rankTier = (m: (typeof allModels)[number]): number => {
      const q = m.performance?.quality ?? 0;
      const ctx = m.contextWindow ?? 0;
      if (q >= 0.9 && ctx >= 32000) return 3;
      if (ctx >= 16000) return 2;
      return 1;
    };
    const byQuality = (a: (typeof allModels)[number], b: (typeof allModels)[number]): number =>
      (rankTier(b) - rankTier(a)) ||
      ((b.performance?.quality ?? 0) - (a.performance?.quality ?? 0));

    // Provider DIVERSITY: at most one (best) model per provider, so a failure falls
    // through to a DIFFERENT provider — not another model of the same dead one.
    const provKey = (m: { providerId?: string; provider?: string }): string =>
      (m.providerId ?? m.provider ?? '').toLowerCase();
    const diverseByProvider = (
      arr: (typeof allModels)[number][],
    ): (typeof allModels)[number][] => {
      const seen = new Set<string>();
      const out: (typeof allModels)[number][] = [];
      for (const m of arr) {
        const pk = provKey(m);
        if (!pk || seen.has(pk)) continue;
        seen.add(pk);
        out.push(m);
      }
      return out;
    };

    // INTERLEAVE native + non-native (2026-06-29): native judges are PREFERRED for
    // quality, but premium natives can be UNFUNDED (measured: anthropic 400
    // no_credits) — a native-ONLY pool then exhausts the whole cascade and the judge
    // FAILS, even though operable HF-routed models (deepseek/qwen/glm — the same ones
    // the chat path uses successfully) would judge fine. So build TWO provider-diverse,
    // quality-ranked lists and interleave them: the cascade still tries the top native
    // first (quality), but reaches a funded non-native by ~attempt 2 even on a COLD
    // hub. No static pin — purely quality + operability + diversity. The route-aware
    // reorder below then sinks proven-dead natives so it converges to attempt 1.
    const diverseNative = diverseByProvider([...chat.filter(isNative)].sort(byQuality));
    const diverseExternal = diverseByProvider([...chat.filter((m) => !isNative(m))].sort(byQuality));
    const seenProviders = new Set<string>();
    const candidates: (typeof allModels)[number][] = [];
    const pushCandidate = (m: (typeof allModels)[number] | undefined): void => {
      if (!m) return;
      const pk = provKey(m);
      if (!pk || seenProviders.has(pk)) return;
      seenProviders.add(pk);
      candidates.push(m);
    };
    if (pinnedNative) pushCandidate(pinnedNative);
    const maxLen = Math.max(diverseNative.length, diverseExternal.length);
    for (let i = 0; i < maxLen; i++) {
      pushCandidate(diverseNative[i]);
      pushCandidate(diverseExternal[i]);
    }

    // Camada 2 refinement: ROUTE-AWARE reorder. The pool filter is provider-level,
    // but the cascade records per-ROUTE failures (recordRouteExecution). A
    // quality-top model whose SPECIFIC route just failed (e.g. a heavy model timing
    // out on one provider) would otherwise lead and waste attempt 1. Push routes
    // with a known-bad state to the back — JS sort is stable, so quality order is
    // preserved within each group — so the first attempt lands on a healthy/unknown
    // route. This is what converges the cascade onto attempt 1 over time.
    const routeHub = getProviderOperabilityHub();
    const routeIsBad = (m: (typeof allModels)[number]): boolean => {
      try {
        const st = routeHub.getRouteState(provKey(m), m.id).operabilityState;
        return (
          st === 'auth_failed' ||
          st === 'no_credits' ||
          st === 'rate_limited' ||
          st === 'temporarily_unavailable'
        );
      } catch {
        return false;
      }
    };
    candidates.sort((a, b) => Number(routeIsBad(a)) - Number(routeIsBad(b)));

    if (candidates.length === 0) {
      // No operable judge candidate at all. HARD failure under the mandatory
      // (learning/benchmark) policy: throw so calculatePolicyAwareScore marks the
      // result judgeFailed=true — never silently emit a neutral score.
      log.warn(
        { pinnedJudgeProvided: Boolean(pinnedJudgeId) },
        'No suitable judge model available — judge failed (result will be marked judgeFailed)',
      );
      throw new Error('No suitable judge model available');
    }

    // Build the (candidate-independent) evaluation prompt once.
    const responseContent = this.getResponseContent(response);
    const evaluationPrompt = this.buildLLMJudgePrompt(responseContent, context, originalRequest);
    const judgeSystemPrompt = `You are an expert AI response evaluator. Your task is to objectively evaluate AI-generated responses.
Score each dimension from 0.0 to 1.0 where:
- 0.0-0.3: Poor quality
- 0.3-0.5: Below average
- 0.5-0.7: Average
- 0.7-0.9: Good quality
- 0.9-0.95: Excellent quality
- 0.95-1.0: Flawless — reserve ONLY for a response with nothing left to improve

Calibration: a very good, thorough response that could STILL be marginally
improved (more depth, an edge case, tighter prose) is EXCELLENT (0.9-0.95), NOT
flawless. Do not default to 1.0 for strong answers.

CRITICAL — correctness gates the overall score, but distinguish WRONG from
INCOMPLETE:
- If the response produces an INCORRECT result, is factually wrong, or does not
  address the task, the OVERALL score MUST be <= 0.1, regardless of how clean or
  well-formatted it is. Do not award presentation credit for a wrong answer.
- A response that is CORRECT for the core task but incomplete or basic (e.g.
  omits edge cases, validation, or depth the rubric also asks for) is NOT wrong
  — give proportional partial credit (commonly 0.4-0.7), never a failing score.

COMPLETENESS & COVERAGE (2026-06-30 — rewards genuine synthesis, not verbosity):
- Among CORRECT responses, reward those that cover MORE of what the task genuinely
  needs: more correct sub-points addressed, relevant edge cases handled, valid
  alternative approaches noted, and trade-offs/tensions reconciled — each addition
  must be correct and on-task.
- A correct answer that integrates multiple valid perspectives into ONE coherent,
  well-supported whole is BETTER (score higher) than an equally-correct but
  narrower or shallower answer. This is how a synthesized/collective answer earns
  its score over a single strong model.
- Do NOT reward padding, repetition, hedging, or irrelevant tangents — coverage
  must be correct and relevant. Length alone is NEVER quality, and an incorrect
  addition LOWERS the score (correctness still gates).

Be objective and fair. Consider the context and requirements carefully.
Respond ONLY with valid JSON, no other text.`;

    // Cascade: try operable providers in order; the FIRST to respond wins. Each
    // failed attempt is recorded to the operability hub (classifyError buckets it
    // auth/credit/etc.) so this cascade AND future requests route around it. Bounded
    // to keep the (deferred) judge cost/latency in check — 4 distinct providers is
    // ample over the 1-2 realistically needed.
    // Camada 2: deeper fallback now that there is no static pin leading the cascade
    // — a few extra provider hops make the dynamic judge resilient when the
    // top-ranked picks are momentarily down (the hub then records them and future
    // calls route around them). Configurable; default 6.
    const MAX_JUDGE_PROVIDER_ATTEMPTS = Number(process.env.JUDGE_MAX_PROVIDER_ATTEMPTS) || 6;
    // Per-attempt wall-clock cap so one slow/hung provider cannot stall the cascade.
    // Critical on the SYNCHRONOUS judge paths (benchmark / sync_judge /
    // LEARNING_JUDGE_SYNC) where __finalize is awaited inline and the cascade is on
    // the response path; without it, 4 attempts could each consume the adapter's
    // ~60s timeout (~4 min). The adapter call isn't cancelable here (chatCompletion
    // takes no signal), but its internal timeout settles the abandoned call — we
    // just stop waiting and move to the next operable provider.
    // 30s default (was 10s): a DYNAMIC judge cascade routes to larger/slower
    // models that emit multi-dimension JSON + reasoning; a 10s cap truncated
    // those mid-object → unparseable JSON → judgeFailed. Still env-overridable.
    const JUDGE_ATTEMPT_TIMEOUT_MS = Number(process.env.JUDGE_ATTEMPT_TIMEOUT_MS) || 30000;
    const attempts = candidates.slice(0, MAX_JUDGE_PROVIDER_ATTEMPTS);
    const hub = getProviderOperabilityHub();
    let lastErr: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const cand = attempts[i];
      // Route to the SELECTED (operable) provider, not the catalog default —
      // findModel(id) alone would resolve the dead-hub default for a multi-homed id.
      const found = await registry.findModel(cand.id, cand.provider);
      if (!found) {
        lastErr = new Error(`Judge model ${cand.id} not found in registry`);
        continue;
      }
      const { adapter } = found;
      // The execution provider key the operability hub records against (matches
      // base-strategy's adapter.getName() convention).
      const judgeProviderKey = (adapter as { getName?: () => string }).getName?.() ?? cand.provider;
      try {
        const judgeResponse = await this.callJudgeWithTimeout(
          adapter.chatCompletion({
            model: cand.id,
            messages: [
              { role: 'system', content: judgeSystemPrompt },
              { role: 'user', content: evaluationPrompt },
            ],
            temperature: 0.1, // Low temperature for consistent evaluation
            max_tokens: 1000,
          }),
          JUDGE_ATTEMPT_TIMEOUT_MS,
          `judge attempt timed out after ${JUDGE_ATTEMPT_TIMEOUT_MS}ms (provider ${judgeProviderKey})`,
        );
        // SUCCESS. We deliberately do NOT record judge success: the judge shares the
        // flat provider key with base-strategy, so a success here could falsely clear
        // a base-strategy no_credits/auth_failed on the SAME native provider.
        let judgeCostUsd = 0;
        try {
          const u = judgeResponse.usage;
          judgeCostUsd = Math.max(0, adapter.calculateCost(cand, u?.prompt_tokens || 0, u?.completion_tokens || 0)) || 0;
        } catch { judgeCostUsd = 0; }
        if (i > 0) {
          log.info(
            { judgeProvider: judgeProviderKey, model: cand.id, attempt: i + 1 },
            'LLM judge fell back to an alternate operable provider',
          );
        }
        const parsed = this.parseLLMJudgeResponse(safeResponseContent(judgeResponse));
        parsed.costUsd = judgeCostUsd;
        return parsed;
      } catch (judgeCallErr) {
        // Feed the operability hub so this cascade AND future judge calls route
        // AROUND this provider. The judge calls the adapter directly (base-strategy
        // is the only other writer), so without this a broken provider (e.g. invalid
        // API key) would be re-picked forever.
        try {
          const status = (judgeCallErr as { status?: number; statusCode?: number })?.status
            ?? (judgeCallErr as { statusCode?: number })?.statusCode;
          hub.recordRouteExecution(judgeProviderKey, cand.id, false, status, getErrorMessage(judgeCallErr));
        } catch { /* non-blocking */ }
        lastErr = judgeCallErr;
        // fall through to the next operable provider
      }
    }

    // Every attempted provider failed → HARD judge failure (caller marks judgeFailed).
    log.warn(
      { attempts: attempts.length, lastError: getErrorMessage(lastErr) },
      'LLM judge exhausted all operable provider candidates — judge failed',
    );
    throw lastErr instanceof Error ? lastErr : new Error('All judge provider candidates failed');
  }

  /**
   * Bound a single judge provider call so one slow/hung provider cannot stall the
   * fallback cascade. The adapter's own timeout is ~60s; this caps the per-ATTEMPT
   * wall-clock far lower so the cascade can advance to the next operable provider.
   * Note: chatCompletion takes no AbortSignal, so the abandoned call is not
   * cancelled — we stop waiting and let the adapter's internal timeout settle it.
   * The timer is always cleared so a fast success never leaks a pending timeout.
   */
  private async callJudgeWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Build the prompt for LLM judge evaluation
   */
  private buildLLMJudgePrompt(
    responseContent: string,
    context: OrchestrationContext,
    originalRequest?: ChatRequest
  ): string {
    let prompt = `Evaluate the following AI response for quality.\n\n`;

    // Add original request context if available
    if (originalRequest?.messages) {
      const userMessages = originalRequest.messages
        .filter((m) => m.role === 'user')
        .map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n');
      
      if (userMessages) {
        prompt += `=== ORIGINAL USER REQUEST ===\n${userMessages.substring(0, 1000)}\n\n`;
      }
    }

    prompt += `=== TASK TYPE ===\n${context.taskType}\n\n`;
    prompt += `=== AI RESPONSE TO EVALUATE ===\n${responseContent.substring(0, 3000)}\n\n`;

    prompt += `=== EVALUATION CRITERIA ===\n`;
    prompt += `1. Correctness: Is the response accurate, syntactically correct, and logically sound?\n`;
    prompt += `2. Completeness: Does it fully address the request with sufficient detail?\n`;
    prompt += `3. Clarity: Is it well-structured, readable, and easy to understand?\n`;
    prompt += `4. Relevance: Does it directly address the user's request without being off-topic?\n\n`;

    prompt += `Respond with JSON in this exact format:\n`;
    prompt += `{\n`;
    prompt += `  "correctness": 0.0-1.0,\n`;
    prompt += `  "completeness": 0.0-1.0,\n`;
    prompt += `  "clarity": 0.0-1.0,\n`;
    prompt += `  "relevance": 0.0-1.0,\n`;
    prompt += `  "overall": 0.0-1.0,\n`;
    prompt += `  "reasoning": ["reason 1", "reason 2", ...],\n`;
    prompt += `  "confidence": 0.0-1.0\n`;
    prompt += `}\n`;

    return prompt;
  }

  /**
   * Parse LLM judge response into structured evaluation.
   *
   * J-Final (Lote 4): the parser now routes through `normalizeJudgeOutput`
   * first so the quality pipeline gets canonical verdict metric signal and
   * shared vocabulary. The canonical `dimensions` record carries the
   * quality-scorer's four axes (correctness / completeness / clarity /
   * relevance) when present. The `LLMJudgeEvaluation` internal type is
   * preserved unchanged — we map the canonical verdict back to it at the
   * boundary so every downstream consumer continues reading the shape it
   * expects.
   */
  private parseLLMJudgeResponse(content: string): LLMJudgeEvaluation {
    const verdict = normalizeJudgeOutput(content, { where: 'quality-scorer.llm-judge' });

    if (verdict) {
      const dims = verdict.dimensions ?? {};
      const fallback = verdict.score;
      const pick = (key: string): number =>
        typeof dims[key] === 'number' ? dims[key]! : fallback;
      return {
        correctness: pick('correctness'),
        completeness: pick('completeness'),
        clarity: pick('clarity'),
        relevance: pick('relevance'),
        overall: verdict.score,
        reasoning: verdict.summary
          ? [verdict.summary]
          : verdict.issues.length > 0
            ? verdict.issues.map((i) => i.description)
            : ['LLM evaluation completed'],
        confidence: verdict.confidence ?? 0.8,
      };
    }

    log.warn(
      { content: content.substring(0, 200) },
      'Failed to normalize LLM judge response via unified schema — judge failed (neutral score marked judgeFailed)',
    );

    // Neutral evaluation on unrecoverable parse failure. TIER 1 (2026-06-11):
    // mark judgeFailed=true so the learning policy refuses to learn from this
    // non-judged neutral 0.5 instead of treating it as a real verdict.
    return {
      correctness: 0.5,
      completeness: 0.5,
      clarity: 0.5,
      relevance: 0.5,
      overall: 0.5,
      reasoning: ['Failed to parse LLM evaluation'],
      confidence: 0.3,
      judgeFailed: true,
    };
  }

  /**
   * Score correctness (syntax, logic, accuracy)
   */
  private scoreCorrectness(
    content: string,
    _context: OrchestrationContext,
    execution?: ModelExecution
  ): number {
    let score = 0.5; // Base score

    // Check for code blocks (if code task)
    if (_context.taskType.includes('code')) {
      const hasCodeBlocks = /```[\w]*\n[\s\S]*?```/.test(content);
      score += hasCodeBlocks ? 0.15 : -0.1;

      // Check for balanced braces/brackets/parens
      const balanced = this.checkBalancedSymbols(content);
      score += balanced ? 0.15 : -0.2;

      // Check for syntax keywords
      const hasSyntax = /\b(function|class|const|let|var|def|import|export)\b/.test(content);
      score += hasSyntax ? 0.1 : 0;
    }

    // Check for error indicators
    const hasErrors = /\b(error|exception|failed|invalid|undefined|null)\b/i.test(content);
    score += hasErrors ? -0.15 : 0.1;

    // Check for validation keywords
    const hasValidation = /\b(valid|correct|works|tested|verified)\b/i.test(content);
    score += hasValidation ? 0.1 : 0;

    // Boost if execution was successful
    if (execution?.success) {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score completeness (addresses all requirements)
   */
  private scoreCompleteness(content: string, _context: OrchestrationContext): number {
    let score = 0.5; // Base score

    // Length-based scoring
    if (content.length > 500) {
      score += 0.2;
    } else if (content.length < 100) {
      score -= 0.2;
    }

    // Check for examples
    const hasExamples = /\b(example|for instance|such as|e\.g\.|for example)\b/i.test(content);
    score += hasExamples ? 0.15 : 0;

    // Check for explanations
    const hasExplanations = /\b(because|since|therefore|thus|reason|explanation)\b/i.test(content);
    score += hasExplanations ? 0.1 : 0;

    // Check for multiple sections (structure)
    const sections = (content.match(/^#{1,6}\s/gm) || []).length;
    if (sections >= 3) {
      score += 0.15;
    } else if (sections === 0 && content.length > 300) {
      score -= 0.1; // Long content without structure
    }

    // Check for code + explanation (if code task)
    if (_context.taskType.includes('code')) {
      const hasCode = /```/.test(content);
      const hasText = content.replace(/```[\s\S]*?```/g, '').trim().length > 50;
      if (hasCode && hasText) {
        score += 0.1; // Has both code and explanation
      }
    }

    // Diff format enforcement for code edit/refactor tasks (Aider leaderboard insight)
    // Tasks involving code edits score higher when output is structured as diffs
    const isEditTask = _context.taskType === 'refactoring'
      || _context.taskType === 'code-review'
      || _context.taskType === 'debugging';
    if (isEditTask) {
      const diffCompliance = this.scoreDiffCompliance(content);
      if (diffCompliance > 0.5) {
        score += 0.15; // Good diff format
      } else if (content.length > 500 && diffCompliance < 0.1) {
        score -= 0.1; // Long response for edit task without diff format
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score diff format compliance for coding edit tasks.
   * Based on Aider leaderboard insight: models with 97%+ diff compliance
   * outperform more capable models with free-form output.
   *
   * Returns 0-1 score. Only applies when taskType includes 'code' or 'edit'.
   */
  scoreDiffCompliance(content: string): number {
    let score = 0;

    // Check for diff code block (```diff)
    if (/```diff\n/.test(content)) score += 0.35;

    // Check for unified diff markers (+++ / --- or @@ lines)
    if (/^[-+]{3}\s/m.test(content) || /^@@\s.*@@/m.test(content)) score += 0.30;

    // Check for add/remove lines (+ and - prefixed)
    const hasAdds = /^\+[^+]/m.test(content);
    const hasRemoves = /^-[^-]/m.test(content);
    if (hasAdds && hasRemoves) score += 0.25;
    else if (hasAdds || hasRemoves) score += 0.10;

    // Bonus: file path header present
    if (/^(?:---|\+\+\+)\s+[a-zA-Z]/m.test(content)) score += 0.10;

    return Math.min(1.0, score);
  }

  /**
   * Score clarity (readability, structure)
   */
  private scoreClarity(content: string): number {
    let score = 0.5; // Base score

    // Check for structure (headings, lists)
    const hasStructure = /^#{1,6}\s|^[-*]\s/m.test(content);
    score += hasStructure ? 0.2 : 0;

    // Check for formatting
    const hasFormatting = /```|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/g.test(content);
    score += hasFormatting ? 0.15 : 0;

    // Check sentence length (penalize very long sentences)
    const sentences = content.split(/[.!?]/);
    const avgLength = sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length;
    if (avgLength > 200) {
      score -= 0.15; // Too long
    } else if (avgLength > 100 && avgLength <= 200) {
      score -= 0.05; // Somewhat long
    } else if (avgLength >= 30 && avgLength <= 100) {
      score += 0.1; // Good length
    }

    // Check for clear paragraphs
    const paragraphs = content.split(/\n\n+/);
    if (paragraphs.length >= 3) {
      score += 0.1; // Well-structured
    }

    // Penalize walls of text
    const longestParagraph = Math.max(...paragraphs.map((p) => p.length));
    if (longestParagraph > 1000) {
      score -= 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score efficiency (performance, resource usage)
   */
  private scoreEfficiency(
    execution: ModelExecution | undefined,
    context: OrchestrationContext
  ): number {
    if (!execution) {
      return 0.5; // Neutral if no execution data
    }

    let score = 0.5; // Base score

    // Latency score
    if (execution.durationMs < 1000) {
      score += 0.25; // Very fast
    } else if (execution.durationMs < 3000) {
      score += 0.15; // Fast
    } else if (execution.durationMs > 10000) {
      score -= 0.15; // Slow
    }

    // Cost efficiency
    if (execution.cost < 0.001) {
      score += 0.25; // Very cheap
    } else if (execution.cost < 0.005) {
      score += 0.15; // Cheap
    } else if (execution.cost > 0.02) {
      score -= 0.1; // Expensive
    }

    if (typeof context.maxCost === 'number' && execution.cost > context.maxCost) {
      score -= 0.2;
    }

    // Token efficiency (if available)
    if (execution.response.usage) {
      const totalTokens = execution.response.usage.total_tokens || 0;
      if (totalTokens < 1000) {
        score += 0.1; // Concise
      } else if (totalTokens > 10000) {
        score -= 0.1; // Verbose
      }
    }

    if (context.preferSpeed && execution.durationMs > 3000) {
      score -= 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score relevance (matches request intent)
   */
  private scoreRelevance(content: string, _context: OrchestrationContext): number {
    let score = 0.5; // Base score

    // Check if response addresses the task type
    const taskKeywords: Record<string, string[]> = {
      'code-generation': ['function', 'class', 'const', 'let', 'var', 'def', 'import'],
      'code-review': ['review', 'issue', 'improvement', 'suggestion', 'consider'],
      debugging: ['bug', 'error', 'fix', 'issue', 'problem', 'solution'],
      refactoring: ['refactor', 'improve', 'clean', 'simplify', 'optimize'],
      testing: ['test', 'assert', 'expect', 'should', 'spec', 'describe'],
      documentation: ['documentation', 'docs', 'readme', 'guide', 'tutorial'],
      analysis: ['analysis', 'examine', 'review', 'assess', 'evaluate'],
    };

    const keywords = taskKeywords[_context.taskType] || [];
    const matchCount = keywords.filter((k) => new RegExp(`\\b${k}\\b`, 'i').test(content)).length;

    if (matchCount >= 3) {
      score += 0.3; // Highly relevant
    } else if (matchCount >= 2) {
      score += 0.2; // Relevant
    } else if (matchCount >= 1) {
      score += 0.1; // Somewhat relevant
    } else if (keywords.length > 0) {
      score -= 0.1; // Not relevant
    }

    // Check for direct answer (starts with answer)
    const startsWithAnswer = /^(yes|no|here|the answer|solution|to solve)/i.test(content.trim());
    score += startsWithAnswer ? 0.1 : 0;

    // Penalize if response is off-topic
    const offTopicIndicators = [
      /i (can't|cannot|am unable to|don't have)/i,
      /i'm (sorry|afraid|not able)/i,
      /as an ai/i,
    ];
    const isOffTopic = offTopicIndicators.some((pattern) => pattern.test(content));
    score += isOffTopic ? -0.3 : 0;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Calculate weighted overall score
   */
  private calculateWeightedScore(dimensions: QualityDimensions): number {
    // Weights (total = 1.0)
    const weights = {
      correctness: 0.35, // 35% - Most important
      completeness: 0.25, // 25%
      clarity: 0.15, // 15%
      efficiency: 0.1, // 10%
      relevance: 0.15, // 15%
    };

    const overall =
      dimensions.correctness * weights.correctness +
      dimensions.completeness * weights.completeness +
      dimensions.clarity * weights.clarity +
      dimensions.efficiency * weights.efficiency +
      dimensions.relevance * weights.relevance;

    return Math.max(0, Math.min(1, overall));
  }

  /**
   * Calculate confidence in score
   */
  private calculateConfidence(dimensions: QualityDimensions, execution?: ModelExecution): number {
    let confidence = 0.5; // Base confidence

    // Higher confidence if we have execution data
    if (execution) {
      confidence += 0.2;
    }

    // Higher confidence if dimensions are consistent. Read each numeric
    // dimension explicitly so the array typing stays `number[]` —
    // Object.values widens to `any[]` here under the project's TS config.
    const values: number[] = [
      dimensions.correctness,
      dimensions.completeness,
      dimensions.clarity,
      dimensions.efficiency,
      dimensions.relevance,
    ];
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev < 0.1) {
      confidence += 0.2; // Very consistent
    } else if (stdDev < 0.2) {
      confidence += 0.1; // Somewhat consistent
    } else if (stdDev > 0.4) {
      confidence -= 0.1; // Inconsistent
    }

    // Higher confidence if all dimensions are good or all are bad
    const allGood = values.every((v) => v >= 0.7);
    const allBad = values.every((v) => v <= 0.3);
    if (allGood || allBad) {
      confidence += 0.1;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Generate reasoning for score
   */
  private generateReasoning(dimensions: QualityDimensions): string[] {
    const reasoning: string[] = [];

    // Correctness
    if (dimensions.correctness >= 0.8) {
      reasoning.push('High correctness: syntax and logic appear sound');
    } else if (dimensions.correctness <= 0.4) {
      reasoning.push('Low correctness: potential syntax or logic issues');
    }

    // Completeness
    if (dimensions.completeness >= 0.8) {
      reasoning.push('Comprehensive: addresses all requirements');
    } else if (dimensions.completeness <= 0.4) {
      reasoning.push('Incomplete: missing important details');
    }

    // Clarity
    if (dimensions.clarity >= 0.8) {
      reasoning.push('Clear: well-structured and readable');
    } else if (dimensions.clarity <= 0.4) {
      reasoning.push('Unclear: lacks structure or readability');
    }

    // Efficiency
    if (dimensions.efficiency >= 0.8) {
      reasoning.push('Efficient: fast and cost-effective');
    } else if (dimensions.efficiency <= 0.4) {
      reasoning.push('Inefficient: slow or expensive');
    }

    // Relevance
    if (dimensions.relevance >= 0.8) {
      reasoning.push('Highly relevant: directly addresses request');
    } else if (dimensions.relevance <= 0.4) {
      reasoning.push('Low relevance: may be off-topic');
    }

    return reasoning;
  }

  /**
   * Check balanced symbols (braces, brackets, parens)
   */
  private checkBalancedSymbols(content: string): boolean {
    const pairs = [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ];

    for (const { open, close } of pairs) {
      const openCount = (content.match(new RegExp(`\\${open}`, 'g')) || []).length;
      const closeCount = (content.match(new RegExp(`\\${close}`, 'g')) || []).length;

      if (openCount !== closeCount) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get response content
   */
  private getResponseContent(response: ChatResponse | null | undefined): string {
    if (!response?.choices) return '';
    const choice = response.choices[0];
    if (!choice) return '';

    const message = choice.message || choice.delta;
    if (!message) return '';

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      const content = message.content as TextContent[];
      return content
        .filter((item): item is TextContent => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
    }

    return '';
  }

  /**
   * C3 P0.4: Policy-aware scoring.
   *
   * - 'observability': heuristic only (fast)
   * - 'learning'/'benchmark': LLM-Judge MANDATORY. If judge fails, score is
   *   marked judgeFailed=true and must NOT feed learning systems.
   */
  async calculatePolicyAwareScore(
    response: ChatResponse,
    context: OrchestrationContext,
    execution: ModelExecution | undefined,
    policy: 'observability' | 'learning' | 'benchmark',
    options?: { judgeModel?: string; originalRequest?: ChatRequest }
  ): Promise<{
    overall: number;
    dimensions: QualityDimensions;
    confidence: number;
    reasoning: string[];
    method: 'heuristic' | 'llm-judge' | 'hybrid';
    policy: string;
    judgeFailed?: boolean;
    heuristicScore?: number;
    judgeScore?: number;
    /** Billable cost (USD) of the LLM-judge sub-call. 0 when no judge ran. */
    judgeCostUsd?: number;
  }> {
    // Always compute heuristic (fast, for divergence monitoring)
    const heuristicResult = this.calculateScore(response, context, execution);

    if (policy === 'observability') {
      return {
        overall: heuristicResult.overall,
        dimensions: heuristicResult.dimensions,
        confidence: heuristicResult.confidence,
        reasoning: heuristicResult.reasoning,
        method: 'heuristic',
        policy,
        heuristicScore: heuristicResult.overall,
      };
    }

    // For 'learning' and 'benchmark': LLM-Judge is MANDATORY
    try {
      const judgeResult = await this.evaluateWithLLMJudge(
        response,
        context,
        options?.originalRequest,
        options?.judgeModel
      );

      log.info(
        { policy, heuristic: heuristicResult.overall, judge: judgeResult.overall },
        'Policy-aware scoring: LLM-Judge completed'
      );

      return {
        overall: judgeResult.overall,
        dimensions: {
          correctness: judgeResult.correctness,
          completeness: judgeResult.completeness,
          clarity: judgeResult.clarity,
          efficiency: heuristicResult.dimensions.efficiency,
          relevance: judgeResult.relevance,
        },
        confidence: judgeResult.confidence,
        reasoning: judgeResult.reasoning,
        method: 'llm-judge',
        policy,
        // TIER 1: a parse-failure neutral verdict surfaces judgeFailed here so
        // the learning policy (orchestration-engine __validForLearning) refuses
        // to learn from it, even though no exception was thrown.
        judgeFailed: judgeResult.judgeFailed ?? false,
        heuristicScore: heuristicResult.overall,
        judgeScore: judgeResult.overall,
        judgeCostUsd: judgeResult.costUsd ?? 0,
      };
    } catch (error) {
      log.error(
        { error: getErrorMessage(error), policy },
        'LLM-Judge FAILED under mandatory policy — score invalid for learning'
      );
      return {
        overall: heuristicResult.overall,
        dimensions: heuristicResult.dimensions,
        confidence: 0.1,
        reasoning: [...heuristicResult.reasoning, 'WARNING: LLM-Judge failed'],
        method: 'heuristic',
        policy,
        judgeFailed: true,
        heuristicScore: heuristicResult.overall,
      };
    }
  }
}

/**
 * Singleton instance
 */
let scorerInstance: QualityScorer | null = null;

/**
 * Get scorer instance
 */
export function getQualityScorer(): QualityScorer {
  if (!scorerInstance) {
    scorerInstance = new QualityScorer();
  }
  return scorerInstance;
}
