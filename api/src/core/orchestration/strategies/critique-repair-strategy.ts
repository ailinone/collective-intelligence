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
  Model,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { answerForScope } from '../verification/best-of-n-verifier';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'critique-repair-strategy' });
const MAX_ITERATIONS = Number(process.env.CRITIQUE_REPAIR_MAX_ITERATIONS ?? 3);
const PLATEAU_EPSILON = Number(process.env.CRITIQUE_REPAIR_PLATEAU_EPSILON ?? 0.05);
const DEFAULT_QUALITY_TARGET = 0.85;
// Non-regressive repair gate (2026-07): oracle-free, a repair must beat the
// pre-repair output's re-score by AT LEAST this margin to be committed —
// otherwise the primary/current best is kept. Env-overridable like the consts
// above so the floor can be tuned without a code change.
const REPAIR_IMPROVEMENT_EPSILON = Number(process.env.CRITIQUE_REPAIR_IMPROVEMENT_EPSILON ?? 0.02);

interface CritiqueResult {
  qualityScore: number;
  issues: Array<{ severity: string; location: string; description: string; suggested_fix: string }>;
}

/**
 * Extract the name of the FIRST top-level function definition in a candidate,
 * used by the non-regressive repair gate to reject a repair that silently
 * renames the primary function (the count_nums→count_numss /
 * words_in_sentence→filter_prime_length_words breakage observed on HumanEval,
 * which turns correct code into a wrong-signature failure).
 *
 * Python is the primary target (HumanEval is Python): the first top-level
 * `def <name>(` at column 0 — indented/nested helpers never match. The common
 * top-level JS forms (`function <name>`, `const <name> =`) are handled too as a
 * best-effort. Returns null when NO top-level definition is present (prose /
 * documentation answers) — the caller then SKIPS the structural guard, so
 * non-code repairs are never affected.
 *
 * CAVEAT (see repair gate): only the FIRST top-level definition is inspected. A
 * solution with two top-level functions (a helper defined before the entry
 * point) keys on the helper, so a repair that legitimately reorders or
 * introduces a top-level helper could be false-rejected. HumanEval's canonical
 * single top-level entry point makes this rare in the target workload.
 */
export function extractPrimaryDefName(code: string): string | null {
  if (typeof code !== 'string' || code.length === 0) return null;
  // Python: first top-level `def name(` (column 0 — nested/indented helpers,
  // which start with whitespace, are intentionally not matched).
  const py = /^def\s+([A-Za-z_]\w*)\s*\(/m.exec(code);
  if (py) return py[1];
  // Common top-level JS forms (best-effort; HumanEval itself is Python).
  const fn = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/m.exec(code);
  if (fn) return fn[1];
  const cst = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/m.exec(code);
  if (cst) return cst[1];
  return null;
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

    const initialContent = genExec.response?.choices?.[0]?.message?.content;
    let currentContent: string = typeof initialContent === 'string' ? initialContent : '';
    let currentResponse = genExec.response;
    // Non-regressive floor (2026-07): the tracked best is SEEDED with the
    // primary generation and only displaced by a repair that STRICTLY beats it
    // on re-evaluation (see the repair-accept gate in the loop below). Under
    // that gate `currentContent`/`currentResponse` only ever advance to a
    // repair that won, so they stay in lock-step with the best triple —
    // `bestContent` is read as the baseline the repair must beat, so a repair
    // that merely LOOKS better to the subjective critic, or that renames the
    // primary function, can never overwrite a good primary.
    let bestResponse = currentResponse;
    let bestContent = currentContent;
    let bestScore = 0;
    const scoreHistory: number[] = [];

    // Objective verifier gate (oracle path). When the request carries an
    // `answerVerifier` (verifiable task, e.g. HumanEval code_execution), a
    // repair may only displace the current best if it PASSES the checker while
    // the pre-repair output did NOT — a verifier-passing output is never
    // replaced by an unverified one. Mirrors how consensus applies the checker
    // (answerForScope honors `answerVerifierScope`: 'full' for code, 'final'
    // for short answers). Never throws — a throwing/absent checker yields false.
    const verifyContent = (content: string): boolean => {
      const verifier = context.answerVerifier;
      if (!verifier) return false;
      const scoped = answerForScope(content, context.answerVerifierScope);
      if (scoped == null) return false;
      try {
        return verifier(scoped) === true;
      } catch {
        return false;
      }
    };

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

      // Critique the CURRENT best via the shared critic path (runCritique) —
      // the same path used to re-score a repair below, so the pre/post-repair
      // scores are directly comparable.
      const { critique, exec: critiqueExec } = await this.runCritique(currentContent, request, criticAdapter, critic, context);
      executions.push(critiqueExec);

      scoreHistory.push(critique.qualityScore);

      // Track best response (the score-corresponding content lives inside
      // bestResponse.choices[0].message.content). Seeds the primary as the
      // hard floor on iteration 1 (bestScore starts at 0) and re-confirms a
      // committed repair; `currentContent` only ever holds the current best,
      // so bestContent stays in lock-step with it.
      if (critique.qualityScore > bestScore) {
        bestScore = critique.qualityScore;
        bestResponse = currentResponse;
        bestContent = currentContent;
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
          // NON-REGRESSIVE REPAIR GATE (2026-07). The old code committed ANY
          // non-empty repair, which let a blind overwrite replace correct code
          // with a lower-quality — or wrong-signature — repair (HumanEval:
          // −0.194 quality; count_nums→count_numss). A repair is now committed
          // ONLY if it provably beats the current best; otherwise the current
          // best is kept untouched. `currentContent`/`bestContent` are equal
          // here (invariant), so the pre-repair baseline is the current best.
          const preRepairContent = bestContent;
          const preRepairScore = critique.qualityScore;

          // (3) Structural guard FIRST (no model call): reject a repair that
          // renames the primary top-level function. Only applies when the
          // pre-repair output actually defines one (code); prose answers (null)
          // skip the guard so non-code repairs are unaffected.
          const preName = extractPrimaryDefName(preRepairContent);
          const repairedName = preName === null ? null : extractPrimaryDefName(repaired);
          if (preName !== null && repairedName !== preName) {
            log.info(
              { iteration, from: preName, to: repairedName },
              'Repair discarded: primary function renamed/removed — keeping current best',
            );
          } else {
            // Re-score the repair via the SAME critic path as the pre-repair
            // score above, so the two are directly comparable. Used by both the
            // verifier-blind fallback and the oracle-free improvement gate.
            const { critique: repairedCritique, exec: reScoreExec } =
              await this.runCritique(repaired, request, criticAdapter, critic, context);
            executions.push(reScoreExec);
            const repairedScore = repairedCritique.qualityScore;

            let accept: boolean;
            if (context.answerVerifier) {
              // (2a) Oracle path: commit only if the repair PASSES the checker
              // and the pre-repair did NOT — never replace a verifier-passing
              // output with an unverified one. When neither passes (verifier
              // blind) fall back to the strict re-score improvement so the loop
              // can still improve a still-failing output without regression risk.
              const preVerified = verifyContent(preRepairContent);
              const repairedVerified = verifyContent(repaired);
              if (repairedVerified && !preVerified) {
                accept = true;
              } else if (!preVerified && !repairedVerified) {
                accept = repairedScore > preRepairScore + REPAIR_IMPROVEMENT_EPSILON;
              } else {
                // pre-repair already verified (or repair lost verification) —
                // keep the verified output.
                accept = false;
              }
            } else {
              // (2b) Oracle-free path: require a strict re-score improvement
              // over the pre-repair score by at least the epsilon margin.
              accept = repairedScore > preRepairScore + REPAIR_IMPROVEMENT_EPSILON;
            }

            if (accept) {
              currentContent = repaired;
              currentResponse = repairExec.response;
              bestContent = repaired;
              bestResponse = repairExec.response;
              bestScore = repairedScore;
              log.info(
                { iteration, preRepairScore, repairedScore },
                'Repair accepted: strictly beats current best',
              );
            } else {
              log.info(
                { iteration, preRepairScore, repairedScore },
                'Repair discarded: does not beat current best — keeping it',
              );
            }
          }
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

  /**
   * Run the critic over a candidate and parse its JSON verdict. Extracted so
   * the loop's top-of-iteration critique and the repair re-score share ONE
   * critic path (same adapter/model/prompt/params) — that makes the pre-repair
   * score and the repaired re-score directly comparable, which the
   * non-regressive gate depends on. Cross-provider failover on a failed critic
   * call is handled inside executeModelWithRetry. Never throws: a malformed or
   * missing verdict falls back to a neutral 0.5 / no-issues default.
   */
  private async runCritique(
    content: string,
    request: ChatRequest,
    criticAdapter: ProviderAdapter,
    critic: Model,
    context: OrchestrationContext,
  ): Promise<{ critique: CritiqueResult; exec: ModelExecution }> {
    const critiqueReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.critiqueEvaluator },
        { role: 'user', content: `ORIGINAL REQUEST:\n${request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n')}\n\nRESPONSE TO EVALUATE:\n${content}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
      temperature: 0.1,
    };
    const exec = await this.executeModelWithRetry(criticAdapter, critic, critiqueReq, 'critic', context);

    // Parse critique. JSON.parse returns `unknown` — narrow each accessed
    // field, fall back to defaults if shape doesn't match.
    let critique: CritiqueResult = { qualityScore: 0.5, issues: [] };
    try {
      const critiqueContent = exec.response?.choices?.[0]?.message?.content;
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
      log.debug({ phase: 'critique-parse' }, 'Failed to parse critique JSON, using defaults');
    }
    return { critique, exec };
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
