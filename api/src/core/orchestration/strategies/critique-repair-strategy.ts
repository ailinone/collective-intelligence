// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Critique-Repair Loop Strategy
 *
 * Theoretical foundations:
 * - Iterative Refinement: successive approximation to quality target
 * - Red Team / Blue Team: adversarial quality improvement
 * - Kaizen: continuous small improvements
 *
 * Adaptive loop: generate → critique (with JSON issues) → repair specific issues → re-validate.
 * Stops when quality_score >= target OR plateau detected OR max iterations reached.
 *
 * Key advantage over quality-multipass: focused repairs instead of full rewrites,
 * adaptive stopping instead of fixed passes, plateau detection to avoid waste.
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import { PROMPTS } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
} from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'critique-repair-strategy' });
const MAX_ITERATIONS = Number(process.env.CRITIQUE_REPAIR_MAX_ITERATIONS ?? 3);
const PLATEAU_EPSILON = Number(process.env.CRITIQUE_REPAIR_PLATEAU_EPSILON ?? 0.05);
const DEFAULT_QUALITY_TARGET = 0.85;

interface CritiqueResult {
  qualityScore: number;
  issues: Array<{ severity: string; location: string; description: string; suggested_fix: string }>;
}

export class CritiqueRepairStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'critique-repair',
      name: 'critique-repair',
      displayName: 'Critique-Repair Loop',
      description:
        'Adaptive refinement: generate → critique → repair → re-validate until quality target met. Stops on plateau or max iterations.',
      minModels: 2,
      maxModels: 3,
      estimatedCostMultiplier: 3.0,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 3.0,
      suitableFor: ['code-generation', 'documentation', 'analysis', 'refactoring', 'creative'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);
    if (models.length < 2) throw new Error('Critique-Repair requires at least 2 models');

    // Caminho-C Q2 cross-strategy honor (2026-04-29): pin biases the
    // GENERATOR slot only. The critic always comes from the next-best
    // quality candidate in the fallback pool — critic must be a peer-
    // grade model so its critique carries weight, and pinning it would
    // collapse the diversity that makes the loop work. If the pinned
    // id isn't in the operational pool, log warn and fall through to
    // legacy quality-sort selection.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          poolSize: models.length,
        },
        'Critique-repair: requested model not in operational pool — falling back to quality-sorted generator',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    // Generator and critic MUST be different models — the adversarial
    // review property collapses if both slots map to the same provider.
    // `let` bindings allow walk-through-sorted rebinding below.
    let generator = sorted[0];
    let critic = sorted[1] || sorted[0];
    const qualityTarget = context.qualityTarget || DEFAULT_QUALITY_TARGET;
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');

    // Single-candidate-bail bug fix: walk `sorted` to find a generator
    // with an operational adapter rather than hard-failing on sorted[0].
    // A partial-coverage outage on the highest-quality model used to
    // kill the strategy before it could even start; now degrades through
    // the pool.
    let genAdapter = await this.getAdapterForModel(generator, context);
    if (!genAdapter) {
      for (let i = 1; i < sorted.length; i++) {
        const candidate = sorted[i];
        const adapter = await this.getAdapterForModel(candidate, context);
        if (adapter) {
          log.warn(
            { requestId: context.requestId, primary: sorted[0].name, fallback: candidate.name },
            'Critique-repair generator: primary had no adapter, using fallback from sorted pool'
          );
          generator = candidate;
          genAdapter = adapter;
          break;
        }
      }
    }
    if (!genAdapter) throw new Error('No operational generator in candidate pool');

    // Walk for critic, preferring a different model than the generator
    // to preserve adversarial review. If only one operational model
    // remains, fall back to using the same model as critic (degraded
    // but functional — better than dropping the critique loop entirely).
    let criticAdapter = await this.getAdapterForModel(critic, context);
    if (!criticAdapter || critic.id === generator.id) {
      let foundDistinct = false;
      for (let i = 0; i < sorted.length; i++) {
        const candidate = sorted[i];
        if (candidate.id === generator.id) continue; // skip generator
        const adapter = await this.getAdapterForModel(candidate, context);
        if (adapter) {
          if (!criticAdapter) {
            log.warn(
              { requestId: context.requestId, primary: sorted[1]?.name, fallback: candidate.name },
              'Critique-repair critic: primary had no adapter, using fallback from sorted pool'
            );
          }
          critic = candidate;
          criticAdapter = adapter;
          foundDistinct = true;
          break;
        }
      }
      if (!foundDistinct && !criticAdapter) {
        // Last resort: critic = generator (same adapter)
        log.warn(
          { requestId: context.requestId, generator: generator.name },
          'Critique-repair: only one operational model available — critic falls back to generator (degraded adversarial review)'
        );
        critic = generator;
        criticAdapter = genAdapter;
      }
    }
    if (!criticAdapter) throw new Error('No operational critic in candidate pool');

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: [generator, critic].map(m => m.name || m.id),
      summary: `Critique-Repair loop: target quality ${(qualityTarget * 100).toFixed(0)}%, max ${MAX_ITERATIONS} iterations.`,
    });

    // Phase 1: Initial generation
    // Initial generation: self-critique loop produces higher-quality starting point
    // then external critic further refines. Tool-aware if request has tools.
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    let genExec = hasTools
      ? await this.executeModelWithTools(genAdapter, generator, this.withPeerReviewPrompt(request), 'primary')
      : await this.selfCritiqueLoop(genAdapter, generator, this.withPeerReviewPrompt(request), 'primary', qualityTarget);

    // Fallback if initial generation failed (provider error, etc.)
    if (!genExec.success) {
      this.log.warn({ model: generator.name }, 'Generator failed, trying fallback');
      genExec = await this.executeModelWithRetry(genAdapter, generator, this.withPeerReviewPrompt(request), 'primary', context);
    }
    executions.push(genExec);

    if (!genExec.success) throw new Error('Initial generation failed');

    let currentContent = genExec.response?.choices?.[0]?.message?.content ?? '';
    let currentResponse = genExec.response;
    // `bestContent` was tracked but never read directly (we return
    // bestResponse, which carries the same content). Track without binding
    // to a variable, but mark intent in comments.
    let bestResponse = currentResponse;
    let bestScore = 0;
    const scoreHistory: number[] = [];

    // C3 P0.2: Skip critique loop when ablated — return initial generation directly
    const critiqueAblated = context.ablationFlags?.disabled?.has('critique');
    const effectiveMaxIterations = critiqueAblated ? 0 : MAX_ITERATIONS;

    // Critique-Repair Loop
    for (let iteration = 1; iteration <= effectiveMaxIterations; iteration++) {
      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: iteration,
        totalRounds: MAX_ITERATIONS,
        summary: `Iteration ${iteration}: critiquing current response.`,
      });

      // Critique
      const critiqueReq: ChatRequest = {
        ...request,
        messages: [
          { role: 'system', content: PROMPTS.critiqueEvaluator },
          { role: 'user', content: `ORIGINAL REQUEST:\n${request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n')}\n\nRESPONSE TO EVALUATE:\n${currentContent}` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1000,
        temperature: 0.1,
      };
      // executeModelWithRetry handles cross-provider failover when the
      // critic call itself fails. The critic running cold against
      // unrelated providers is a normal occurrence — diversity is the
      // point — so transient failures should walk the pool rather than
      // tank the iteration.
      const critiqueExec = await this.executeModelWithRetry(criticAdapter, critic, critiqueReq, 'critic', context);
      executions.push(critiqueExec);

      // Parse critique. JSON.parse returns `unknown` — narrow each accessed
      // field, fall back to defaults if shape doesn't match.
      let critique: CritiqueResult = { qualityScore: 0.5, issues: [] };
      try {
        const critiqueContent = critiqueExec.response?.choices?.[0]?.message?.content;
        if (typeof critiqueContent === 'string') {
          const parsed: unknown = JSON.parse(critiqueContent);
          if (typeof parsed === 'object' && parsed !== null) {
            const obj = parsed as { quality_score?: unknown; issues?: unknown };
            const qualityScore = typeof obj.quality_score === 'number' ? obj.quality_score : 0.5;
            const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
            const issues = rawIssues.filter(
              (issue): issue is CritiqueResult['issues'][number] =>
                typeof issue === 'object' &&
                issue !== null &&
                typeof (issue as { severity?: unknown }).severity === 'string',
            );
            critique = { qualityScore, issues };
          }
        }
      } catch {
        log.debug({ iteration }, 'Failed to parse critique JSON, using defaults');
      }

      scoreHistory.push(critique.qualityScore);

      // Track best response (the score-corresponding content lives inside
      // bestResponse.choices[0].message.content — no need to track separately).
      if (critique.qualityScore > bestScore) {
        bestScore = critique.qualityScore;
        bestResponse = currentResponse;
      }

      log.info({
        iteration,
        qualityScore: critique.qualityScore,
        criticalIssues: critique.issues.filter(i => i.severity === 'CRITICAL').length,
        majorIssues: critique.issues.filter(i => i.severity === 'MAJOR').length,
        target: qualityTarget,
      }, 'Critique iteration complete');

      // Check stopping criteria
      if (critique.qualityScore >= qualityTarget) {
        log.info({ iteration, score: critique.qualityScore, target: qualityTarget }, 'Quality target met');
        this.emitObserverEvent(context, { type: 'quality_assessment', summary: `Quality target met: ${(critique.qualityScore * 100).toFixed(0)}% >= ${(qualityTarget * 100).toFixed(0)}%.` });
        break;
      }

      if (critique.issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'MAJOR').length === 0) {
        log.info({ iteration, score: critique.qualityScore }, 'No critical/major issues, accepting');
        this.emitObserverEvent(context, { type: 'quality_assessment', summary: `No critical issues remaining. Score: ${(critique.qualityScore * 100).toFixed(0)}%.` });
        break;
      }

      // Plateau detection
      if (scoreHistory.length >= 2) {
        const delta = Math.abs(scoreHistory[scoreHistory.length - 1] - scoreHistory[scoreHistory.length - 2]);
        if (delta < PLATEAU_EPSILON) {
          log.info({ iteration, delta, epsilon: PLATEAU_EPSILON }, 'Quality plateau detected, stopping');
          this.emitObserverEvent(context, { type: 'quality_assessment', summary: `Quality plateau detected (delta ${delta.toFixed(3)} < ${PLATEAU_EPSILON}). Accepting best version.` });
          break;
        }
      }

      if (iteration >= MAX_ITERATIONS) {
        this.emitObserverEvent(context, { type: 'quality_assessment', summary: `Max iterations (${MAX_ITERATIONS}) reached. Best score: ${(bestScore * 100).toFixed(0)}%.` });
        break;
      }

      // Repair: fix specific issues
      const issuesText = critique.issues
        .filter(i => i.severity === 'CRITICAL' || i.severity === 'MAJOR')
        .map((i, idx) => `${idx + 1}. [${i.severity}] ${i.location}: ${i.description}\n   Fix: ${i.suggested_fix}`)
        .join('\n');

      const repairReq: ChatRequest = {
        ...request,
        messages: [
          { role: 'system', content: PROMPTS.critiqueRepairer },
          { role: 'user', content: `ORIGINAL REQUEST:\n${request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n')}\n\nCURRENT RESPONSE:\n${currentContent}\n\nISSUES TO FIX:\n${issuesText}\n\nProduce the COMPLETE fixed version.` },
        ],
      };
      // Default branch uses executeModelWithRetry for cross-provider
      // failover on repair failure. The reasoning branch keeps its
      // dedicated helper because it has specialized response-shape
      // handling (reasoning_content extraction) that retry doesn't wrap.
      const repairExec = reasoningEnabled
        ? await this.executeModelWithReasoning(genAdapter, generator, repairReq, 'repairer')
        : await this.executeModelWithRetry(genAdapter, generator, repairReq, 'repairer', context);
      executions.push(repairExec);

      if (repairExec.success) {
        const repaired = repairExec.response?.choices?.[0]?.message?.content;
        if (typeof repaired === 'string' && repaired.trim()) {
          currentContent = repaired;
          currentResponse = repairExec.response;
        }
      }
    }

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Critique-Repair complete. Final score: ${(bestScore * 100).toFixed(0)}%, ${scoreHistory.length} iterations.` });

    const reasoningTraces = reasoningEnabled
      ? executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens }))
      : undefined;

    return {
      finalResponse: bestResponse,
      strategyUsed: 'critique-repair',
      modelsUsed: executions,
      totalCost: executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      qualityScore: bestScore,
      metadata: {
        strategy: 'critique-repair',
        iterations: scoreHistory.length,
        scoreHistory,
        finalScore: bestScore,
        qualityTarget,
        plateauDetected: scoreHistory.length >= 2 && Math.abs(scoreHistory[scoreHistory.length - 1] - scoreHistory[scoreHistory.length - 2]) < PLATEAU_EPSILON,
        ...(reasoningTraces?.length ? { reasoning_traces: reasoningTraces } : {}),
      },
    };
  }

  // Intentionally buffered, not real per-token streaming (audited
  // 2026-07-11 alongside the other 12 strategies): `bestResponse` is
  // picked post-hoc by comparing critique scores ACROSS iterations — an
  // earlier iteration can win over the current/last one (see the
  // `critique.qualityScore > bestScore` tracking above). Streaming any
  // single iteration's repair call live would risk the client receiving
  // tokens for an answer the loop later discards in favor of an earlier
  // draft, and already-sent tokens can't be un-sent. Progress chunks
  // still stream per-iteration so the client sees activity.
  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 2) throw new Error('Critique-Repair requires at least 2 models');
    // Pin/sort/adapter resolution happens inside execute() below.
    // Stream wrapper only owns observer-event progress + final yield.
    const qualityTarget = context.qualityTarget || DEFAULT_QUALITY_TARGET;

    this.emitObserverEvent(context, { type: 'phase_start', summary: `Critique-Repair: target ${(qualityTarget * 100).toFixed(0)}%.` });
    yield this.progressChunk('Generating initial response...', 0, MAX_ITERATIONS + 1);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Run full execute() for the critique loop (non-streaming iterations)
    const result = await this.execute(request, context);
    const iterations = (result.metadata as { iterations?: number }).iterations ?? 1;

    yield this.progressChunk(`${iterations} iteration(s) complete, score: ${((result.qualityScore ?? 0) * 100).toFixed(0)}%`, iterations, MAX_ITERATIONS + 1);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Yield the best response directly. Streaming-helper resolution
    // happens inside execute() — no need to re-resolve adapters here.
    // (Previous version fetched genAdapter then never used it; cleaned
    // up to remove the dead path that would have hard-failed when the
    // primary generator's adapter was null even though execute() had
    // already produced a result via fallback.)
    yield result.finalResponse;

    for (const c of await this.drainObserverChunks(context)) yield c;
  }
}
