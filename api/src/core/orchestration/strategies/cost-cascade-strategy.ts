// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';
import { getTtftTracker } from '@/core/selection/ttft-tracker';
import { degradedSynthesisTotal } from '@/observability/ci-metrics';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  ModelRole,
} from '@/types';

/**
 * Cost-Optimized Cascade Strategy
 *
 * Tries cheaper models first, escalates to expensive ones only if needed.
 * Maximizes cost savings while ensuring quality requirements are met.
 *
 * Best for: Cost-sensitive tasks with flexible quality requirements
 *
 * Process:
 * 1. Sort models by cost (cheapest first)
 * 2. Try cheapest model
 * 3. Evaluate quality of response
 * 4. If quality sufficient → Done (massive savings)
 * 5. If quality insufficient → Escalate to next tier
 * 6. Continue until quality threshold met or budget exhausted
 *
 * Quality Evaluation:
 * - Length (comprehensive responses preferred)
 * - Structure (code blocks, lists, headers)
 * - Completeness (addresses all aspects of request)
 * - Confidence indicators (hedging language vs confident)
 *
 * Example Flow:
 * 1. Try DeepSeek Chat ($0.00014/1k) → Quality: 0.75 (good enough) → Done!
 * 2. If not: Try Gemini Flash ($0.000075/1k) → Quality: 0.82 → Done!
 * 3. If not: Try GPT-4o Mini ($0.00015/1k) → Quality: 0.87 → Done!
 * 4. Last resort: GPT-4o ($0.005/1k) → Quality: 0.95 → Done
 *
 * Typical Savings: 70-95% cost reduction vs always using premium models
 */
// Ladder TTL cache (P0.8): see buildCascadeCandidates() for rationale.
const cascadeLadderCache: {
  key: string | null;
  models: Model[];
  expiresAt: number;
} = { key: null, models: [], expiresAt: 0 };

export class CostCascadeStrategy extends BaseStrategy {
  private readonly QUALITY_THRESHOLD_BASE = 0.7; // Minimum acceptable quality
  private readonly QUALITY_INCREMENT = 0.05; // Quality must improve by this much to justify cost

  getMetadata(): StrategyMetadata {
    return {
      id: 'cost-cascade',
      name: 'cost-cascade',
      displayName: 'Cost-Optimized Cascade',
      description:
        'Try cheap models first, escalate to expensive ones only if needed. Optimizes for maximum cost savings while meeting quality requirements.',
      minModels: 2, // Need at least 2 tiers
      maxModels: 5, // Up to 5 escalation tiers
      estimatedCostMultiplier: 0.3, // 70% savings on average
      estimatedQualityBoost: 0.0, // Quality varies (meets threshold)
      estimatedDurationMultiplier: 1.3, // Slightly slower (multiple attempts)
      suitableFor: ['general', 'code-generation', 'documentation', 'analysis', 'qa'],
      // minModels here is an "at least 2 cost tiers must exist to escalate
      // through" requirement, not a signal that models collaborate -- only
      // ONE candidate's output is ever used per request. See
      // StrategyMetadata.isCascading's doc comment for why this matters
      // (orchestration-engine.ts derives collective-vs-solo prompt framing
      // from minModels>1 otherwise, misclassifying every cascade rung).
      isCascading: true,
    };
  }

  /**
   * TEMPORARILY REVERTED to the base-class default (false) — 2026-08-14.
   *
   * This was briefly `true` (#308, #310): cost-cascade tries candidates
   * SEQUENTIALLY and moves on when one fails, which in principle is exactly
   * the fault tolerance a self-hosted candidate occasionally needs, and
   * effectiveCost() below already treats self-hosted/ollama/local-* models
   * as free and sorts them first.
   *
   * Reverted after live verification (post-#310, which capped the cascade to
   * at most one self-hosted rung) showed the ONE self-hosted candidate
   * (ollama/qwen2.5:3b) still took the full ~25-46s "give up waiting" window
   * before the cascade moved on, AND the underlying HTTP call itself
   * actually took 60+s to resolve in the background (confirmed via
   * candidate-trace logs: latencyMs:60014) -- i.e. boundModelExecution()'s
   * per-call timeout only stops the orchestration layer from WAITING, it
   * never aborts the real request (no AbortController wired into the
   * fetch() chain; tracked as a separate, in-progress fix). Net effect: with
   * self-hosted included, EVERY ailin-economy request now burns 25-46+
   * seconds on a single doomed rung before ever reaching
   * recoverEmptyFinalResponse() -- worse than the pre-#308 behavior, where
   * cost-cascade's cost-sorted candidates (Google/xAI, currently broken)
   * near-instantly near-zero-skip past each other and recovery kicks in
   * within a few seconds, reliably landing on a fast, working Qwen-hub
   * candidate.
   *
   * Re-enable once the AbortController fix lands (it will make a stuck
   * self-hosted candidate fail in ~1s instead of 25-60s, at which point
   * self-hosted-first genuinely is a latency win, not a regression). Until
   * then, self-hosted's real-world performance here is worse than not using
   * it, so this reverts to the safe, previously-working default.
   */

  /**
   * Build the cost-sorted, context-window-filtered, self-hosted-deduped,
   * pin-honored candidate list — shared by execute() and executeStream()
   * so the two paths can't silently diverge (see the file-level history on
   * self-hosted dedup / context-window filter / pin-honoring: each was a
   * separately-dated fix, and a second, independently-written candidate
   * list in executeStream() would risk missing one of them).
   */
  private buildCascadeCandidates(context: OrchestrationContext): Model[] {
    // Ladder TTL cache (P0.8, 2026-08-18): even with the eligible-pool cache
    // (#376), building the ladder costs ~200ms per request (52k-candidate
    // decorate pass: breakerRank x2 hub lookups + envelope + TTFT tracker per
    // model, then the provider-diversified interleave). The ladder only moves
    // when the pool, breaker state or TTFT history do — minute scale. Short
    // TTL keeps rung demotion fresh enough while taking the whole build off
    // the first-token path. Keyed on the two request-dependent inputs
    // (context-size bucket — the context-window filter — and the pinned
    // model). Cache hits return a shallow copy; 0 disables.
    const ladderTtlMs = Number(process.env.CASCADE_LADDER_CACHE_TTL_MS ?? 3000);
    const ladderKey = `${Math.ceil((context.contextSize ?? 0) / 1024)}|${context.preferredModelIds?.[0] ?? ''}`;
    const ladderNow = Date.now();
    if (
      ladderTtlMs > 0 &&
      cascadeLadderCache.key === ladderKey &&
      ladderNow < cascadeLadderCache.expiresAt
    ) {
      return [...cascadeLadderCache.models];
    }
    const built = this.buildCascadeCandidatesUncached(context);
    if (ladderTtlMs > 0) {
      cascadeLadderCache.key = ladderKey;
      cascadeLadderCache.models = built;
      cascadeLadderCache.expiresAt = ladderNow + ladderTtlMs;
    }
    return built;
  }

  private buildCascadeCandidatesUncached(context: OrchestrationContext): Model[] {
    const eligibleModels = this.getEligibleModels(context);

    // Context-window filter (2026-08-13, companion to the self-hosted-
    // inclusion fix above): getEligibleModels()/PoolBuilder has no
    // context-window check at all, and effectiveCost() ranks self-hosted
    // models as free regardless of their (often much smaller, 4k-8k token)
    // context window — so once self-hosted candidates are in the pool they
    // become rung 1 for EVERY request, including long conversations that
    // obviously won't fit. That's not just a wasted attempt:
    //  - Ollama receives no context-size hint from ci-api (no num_ctx sent)
    //    and MAY silently truncate the oldest messages rather than error on
    //    overflow (server-dependent behavior this repo doesn't control or
    //    verify) — the cascade would see a normal, non-empty response and
    //    stop at rung 1, silently returning a context-blind answer with no
    //    error surfaced anywhere.
    //  - Even when the provider DOES cleanly reject (safely classified as a
    //    request-scoped, non-retryable failure — see error-classification.ts
    //    CONTEXT_EXCEEDED_KEYWORDS — so this never poisons cross-request
    //    health state on its own), the shared per-adapter circuit breaker
    //    (distributed-circuit-breaker.ts) has no awareness of that
    //    classification: 5 consecutive context-length rejections against
    //    the same host trip it open for 30s, fast-failing even short,
    //    valid requests that would have fit.
    // Filtering candidates whose contextWindow can't hold the actual
    // conversation BEFORE the cascade ever tries them avoids both failure
    // modes, using the same context.contextSize estimate (from
    // buildContext()'s estimateContextSize()) the constraint-filtering in
    // buildContext() already uses for the equivalent runtimeConstraints.
    // minContextWindow check. Permissive on unknown/missing contextWindow
    // (0 or undefined) -- treated as "unknown, don't exclude" rather than
    // guilty until proven fitting, consistent with effectiveCost()'s own
    // "missing data isn't grounds for exclusion" philosophy a few lines
    // below.
    const contextFitModels = eligibleModels.filter(
      (m) => !m.contextWindow || m.contextWindow >= context.contextSize
    );

    // De-duplicate self-hosted candidates (2026-08-14): effectiveCost() below
    // treats EVERY self-hosted/ollama/local-* model as free (cost=0) with no
    // per-host cap, so if a self-hosted provider has multiple model variants
    // registered (e.g. one host serving several Qwen sizes), several of the
    // cascade's top-N cost-sorted rungs can all land on the SAME physical
    // host. Confirmed live: two back-to-back requests both landed on the same
    // self-hosted host; the first took 24s and the second got NO response at
    // all within a 60s window — consistent with the host serializing
    // generation requests server-side while ci-api's per-rung timeout only
    // stops WAITING on a stalled call rather than aborting it (a separate,
    // deeper fix — the HTTP call itself has no AbortController wired in —
    // tracked separately, out of scope for this contained change). Keeping
    // at most the single best (first, given the pool is already
    // quality-then-cost sorted by PoolBuilder) self-hosted candidate bounds
    // that exposure to one rung: if it's healthy, the cascade still gets it
    // for free; if it's slow/down, the cascade moves on to a (typically
    // fast-failing, per error-classification.ts's near-zero-skip) paid
    // candidate after a single timeout instead of potentially several.
    let keptOneSelfHosted = false;
    const models = contextFitModels.filter((m) => {
      if (this.effectiveCost(m) !== 0) return true;
      if (keptOneSelfHosted) return false;
      keptOneSelfHosted = true;
      return true;
    });

    if (models.length < this.getMetadata().minModels!) {
      throw new Error(
        `Cost Cascade requires at least ${this.getMetadata().minModels} models (${models.length} available)`
      );
    }

    // 1. Sort models by cost (cheapest first), honoring user pin if any.
    //    Caminho-C Q2 cross-strategy honor (2026-04-29): if the user
    //    pinned a model via request.model, that model becomes the FIRST
    //    cascade attempt — even if it's expensive — because the user's
    //    intent overrides cost optimization. The escalation logic still
    //    applies: if pinned model fails the quality threshold, the
    //    cascade continues through the remaining cost-sorted candidates.
    //    If pinned id isn't in the operational pool, log warn and fall
    //    through to legacy cost-only sort.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          poolSize: models.length,
        },
        'Cost cascade: requested model not in operational pool — falling back to cost-sort cascade'
      );
    }
    // Cap cascade depth at the strategy's declared maxModels (2026-07-04,
    // c3-v4 defect C): the cascade used to walk the ENTIRE eligible pool
    // sequentially — with hub models tying at $0 the cost-sort degenerates to
    // pool order, and two dead rungs (~180s each through adapter retries)
    // already blow any client budget. 5 bounded rungs either reach a live
    // model or fail fast.
    const maxRungs = Math.min(models.length, this.getMetadata().maxModels ?? 5);
    // Breaker-aware rung demotion (RC-2, 2026-08-17; tightened RC-3 same day).
    // With several providers simultaneously unhealthy (empty credentials,
    // exhausted billing — the exact state of 2026-08-16/17 production), the
    // cheapest rungs can all sit on dead providers: the cascade then burns a
    // full per-rung wait on each before escalating.
    //
    // RC-3 tightening, from a live 2026-08-17 incident (100% of anonymous
    // ailin-economy requests degraded): a permanently-dead provider's circuit
    // OSCILLATES — OPEN for retryAfter (30s), then HALF_OPEN, then one probe
    // fails (401/403, ~70–500ms), then OPEN again. RC-2 demoted only OPEN, so
    // every ~30s window the next request sampled the circuit in HALF_OPEN,
    // did NOT demote it, and burned rungs on it again. Confirmed live: a
    // single request's 5-rung ladder was google (HALF_OPEN, 401) + four xai
    // models (403/OPEN) while 52k healthy models sat unused behind them →
    // "All synthesizers failed — emitting degraded synthesis".
    //
    // HALF_OPEN is now demoted too, but ONE tier below OPEN, not equally:
    // demotion is a stable 3-tier rank (healthy < half-open < open), so a
    // healing HALF_OPEN circuit still gets probe traffic — just only after
    // healthy candidates — and circuit healing still happens whenever the
    // healthy rungs are exhausted (which, in the all-dead world this guards
    // against, is always).
    //
    // DEMOTION, never removal: a pool that would drop below minModels must
    // still throw (engine-level recovery depends on that contract), and an
    // all-OPEN pool keeps its original ordering — a stale local cache must
    // not be able to make the strategy throw where it would have succeeded.
    // Names are normalized to the adapter convention (`${name}-api`,
    // lowercase) and checked against both Model.provider and Model.providerId,
    // since catalog rows are not guaranteed to carry the adapter-registered
    // spelling.
    //
    // Zero I/O: both snapshots read each breaker's local cache only.
    const openCircuits = distributedCircuitBreakerManager.getRecentOpenCircuitNames();
    const halfOpenCircuits = distributedCircuitBreakerManager.getRecentCircuitNamesByState(
      'HALF_OPEN'
    );
    // Quarantine tier (Workstream F, 2026-08-17): the operability hub knows a
    // provider is auth_failed/no_credits (AUTH_INVALID / AUTH_MISSING /
    // BILLING_EXHAUSTED / ACCOUNT_RESTRICTED in the typed taxonomy). The
    // pool builder already EXCLUDES such providers (filterByOperability);
    // this rank is the belt-and-suspenders for candidates that reach the
    // cascade anyway (preselected context.models, hub overlay expiring
    // mid-request, fallback pools). Demotion-not-removal still holds: rank 3
    // sorts below open circuits, and the minModels throw contract is intact.
    // Zero I/O — hub state reads the in-memory overlay/rings only.
    const operabilityHub = getProviderOperabilityHub();
    const isQuarantined = (m: Model): boolean => {
      const byProvider = operabilityHub.getProviderState(m.provider).operabilityState;
      if (byProvider === 'auth_failed' || byProvider === 'no_credits') return true;
      const byProviderId = operabilityHub.getProviderState(m.providerId).operabilityState;
      return byProviderId === 'auth_failed' || byProviderId === 'no_credits';
    };
    const breakerRank = (m: Model): number => {
      if (isQuarantined(m)) {
        return 3;
      }
      const providerKey = m.provider.toLowerCase();
      const providerIdKey = m.providerId.toLowerCase();
      if (
        openCircuits.has(`${providerKey}-api`) ||
        openCircuits.has(`${providerIdKey}-api`)
      ) {
        return 2;
      }
      // Route-error demotion (2026-08-18, from live anonymous-chat evidence):
      // a free-tier model with zero cost sits at the TOP of the cost sort,
      // so a route that has failed EVERY recent attempt (featherless-ai
      // first-chunk timeouts, groq 404-model-not-found) keeps capturing rung
      // 1 on every request — cost is primary and the latency tie-break never
      // crosses a cost boundary. The TTFT tracker is updated in-memory at the
      // moment the fallback fires, so this is deterministic on the replica
      // that observed the failure, with NO dependency on the distributed
      // breaker's cross-replica sync window. Demotion floor is rank 1 (same
      // tier as HALF_OPEN): a route with a majority of recent failures sorts
      // after every candidate with no observed failures, but still ahead of
      // OPEN/quarantined providers, and one transient failure alone (single
      // attempt) is NOT enough to demote.
      const routeFailures = ttft.errorRate(m.provider, m.id);
      if (routeFailures >= 0.5 && ttft.attemptCount(m.provider, m.id) >= 2) {
        return 1;
      }
      if (
        halfOpenCircuits.has(`${providerKey}-api`) ||
        halfOpenCircuits.has(`${providerIdKey}-api`)
      ) {
        return 1;
      }
      return 0;
    };

    // Provider-diversified ladder (RC-3, 2026-08-17): the same live incident
    // showed a 5-rung ladder drawn from only TWO providers (google + xai) —
    // when both share a failure cause (stale creds, correlated outage), the
    // whole ladder dies together. Round-robin interleave across providers
    // over the (rank, cost)-sorted pool guarantees maxModels rungs span as
    // many distinct providers as the pool allows, while preserving cost
    // order WITHIN each provider. The cheapest single provider can no longer
    // monopolize the ladder — a deliberate resilience-over-cheapness
    // tradeoff bounded to at most 5 rungs.
    // Latency-aware tie-break (Workstream G, 2026-08-17): within a breaker
    // rank, cost stays the PRIMARY key (cost policy is unchanged), but
    // candidates whose effective cost differs by at most
    // COLLECTIVE_LATENCY_COST_TIE_USD (default $0.0001/1k — i.e. within the
    // same cheap tier) are re-ordered by the TTFT tracker's EWMA-predicted
    // first-chunk latency, with UNKNOWN latency sorting after known. A
    // cheap-but-3s model is not cheap: an anonymous "oi" burning a 3s window
    // on rung 1 costs more in degraded TTFT than the fractional-cent
    // difference between cheap tiers. Zero I/O — the tracker is in-memory.
    const ttft = getTtftTracker();
    const costTieUsd = Number(process.env.COLLECTIVE_LATENCY_COST_TIE_USD ?? 0.0001);
    // Cost-envelope TTFT-first rung 1 (P0.8, 2026-08-18): warm anonymous TTFT
    // plateaued at ~4.2-4.7s because cost is the PRIMARY key across the whole
    // pool — the latency tie-break never crosses a cost boundary, so the
    // cheapest healthy route (whose EWMA TTFT is seconds) captures rung 1 on
    // every request. Fix: rank-0 candidates within a cost ENVELOPE of the
    // cheapest healthy candidate (multiplier X, with an absolute floor so a
    // $0-min pool still spans near-free tiers, and an absolute cap so the
    // envelope can never reach premium pricing) are re-grouped FIRST and
    // ordered by predicted TTFT — rung 1 becomes the proven-fastest model in
    // the cheap tier, not the cheapest model regardless of speed. Cold start
    // is unchanged: with no tracker history every envelope candidate ties on
    // latency and falls back to cost order. Env knobs (all optional):
    //   COLLECTIVE_TTFT_ENVELOPE_X          (default 10)
    //   COLLECTIVE_TTFT_ENVELOPE_FLOOR_USD  (default 0.0005 per-1k avg)
    //   COLLECTIVE_TTFT_ENVELOPE_CAP_USD    (default 0.001 per-1k avg)
    const envelopeX = Math.max(1, Number(process.env.COLLECTIVE_TTFT_ENVELOPE_X ?? 10) || 10);
    const envelopeFloorUsd = Math.max(0, Number(process.env.COLLECTIVE_TTFT_ENVELOPE_FLOOR_USD ?? 0.0005));
    const envelopeCapUsd = Math.max(0, Number(process.env.COLLECTIVE_TTFT_ENVELOPE_CAP_USD ?? 0.001));
    const candidateCosts = new Map<Model, number>();
    for (const candidate of preference.fallbackPool) {
      candidateCosts.set(candidate, this.effectiveCost(candidate));
    }
    let healthyMinCost = Number.MAX_SAFE_INTEGER;
    for (const candidate of preference.fallbackPool) {
      if (breakerRank(candidate) !== 0) continue;
      const cost = candidateCosts.get(candidate) ?? Number.MAX_SAFE_INTEGER;
      if (cost < healthyMinCost) healthyMinCost = cost;
    }
    // envelopeMax = clamp(min*X, min+floor, max(cap, min)) — the max(..., min)
    // guard keeps the envelope non-empty when the cap is below the pool floor.
    const envelopeMax = Math.min(
      Math.max(healthyMinCost * envelopeX, healthyMinCost + envelopeFloorUsd),
      Math.max(envelopeCapUsd, healthyMinCost)
    );
    const inEnvelope = (m: Model): boolean =>
      breakerRank(m) === 0 && (candidateCosts.get(m) ?? Number.MAX_SAFE_INTEGER) <= envelopeMax;
    const predictedTtft = (m: Model): number | null => {
      const t = ttft.predictedTtftMs(m.provider, m.id);
      if (t === null) return null;
      // Error-rate penalty: a route failing half its attempts is effectively
      // "slow" for ranking purposes even when its successes are fast.
      const errorRate = ttft.errorRate(m.provider, m.id);
      return errorRate >= 0.5 ? t * 2 : t;
    };
    // Unknown latency sorts AFTER known (prefer the proven-fast within a
    // cost tie) but never across the cost boundary above.
    //
    // NOTE (2026-08-18): do NOT add explore-when-slow here (unknown before
    // known-slow) — it was tried and reverted: when NO in-envelope route is
    // fast, every request re-explores an untried (often dead) route and the
    // cascade burns its full ladder (observed 60s requests). Exploration is
    // done OUT-OF-BAND by the ttft-probe job (jobs/ttft-probe-job.ts), which
    // seeds the tracker synthetically so user traffic always rides the
    // known-best route.
    // (latencyCompare/costCompare were folded into the decorated sort below
    // when the comparator was made O(1) per comparison — see the decorate
    // comment there for the preserved ordering semantics.)
    // Decorate-sort-undecorate (P0.8, 2026-08-18): the comparator below
    // recomputed breakerRank (2 operability-hub lookups), the cost map get and
    // the TTFT-tracker lookups on EVERY comparison. At the production pool
    // size (52k+ models × ~16 comparisons each in a comparator-based sort,
    // times the rank/envelope/cost passes) that is hundreds of millions of
    // Map/Set hits per request — measured as seconds of pure CPU between
    // "Context built" and the strategy's first yield on anonymous traffic.
    // Precompute each candidate's rank/envelope/cost/predicted-TTFT exactly
    // ONCE (O(n) lookups total) and sort on the precomputed numeric keys.
    // Ordering semantics are identical to the old comparator: rank asc →
    // envelope-first → within envelope predicted-TTFT asc (unknown last) with
    // cost as final tie-break → outside envelope cost asc with the
    // COLLECTIVE_LATENCY_COST_TIE_USD latency tie-break. Null predicted TTFT
    // maps to Infinity so "unknown sorts after known-slow" survives.
    const SORT_UNKNOWN_TTFT = Number.POSITIVE_INFINITY;
    // Infinity - Infinity is NaN and would corrupt Array.sort — equal keys
    // (both unknown) must compare as 0.
    const ttftDiff = (a: number, b: number): number => (a === b ? 0 : a - b);
    // Hot-route preference within the envelope (P0.8, 2026-08-19): prod rung-1
    // traces showed free-tier HF/featherless SERVERLESS routes capturing rung 1 —
    // they are $0 (always in-envelope) and their tracker EWMA (~1-4s of cold
    // starts) is still the best KNOWN latency because faster paid routes were
    // never sampled (unknown sorts after known). A cold serverless container is
    // exactly what the hub's isRouteHot (success within the keep-warm window)
    // exists to detect: sort PROVEN-HOT routes ahead of non-hot ones inside the
    // envelope, before predicted-TTFT. Zero I/O — hub state is in-memory. When
    // no route is hot the ordering degrades to the previous TTFT-first rule.
    const operabilityHubForHeat = getProviderOperabilityHub();
    // Free-tier-last within the envelope (P0.8, 2026-08-19): post-#382 rung-1
    // traces still showed huggingface:Qwen3-4B (hot but 1.5-2.5s serverless
    // TTFT) capturing rung 1 — a $0 route is ALWAYS in-envelope and stays hot
    // because every slow success refreshes its heat. Cheap PAID routes (aiml,
    // cometapi, ...) have real sub-second TTFTs but were outranked. Within the
    // envelope, sort paid routes ahead of $0 ones (env kill-switch
    // RUNG1_FREE_LAST=0); free-tier routes remain immediately behind as
    // escalation rungs — still used, never lost.
    const freeLast = process.env.RUNG1_FREE_LAST !== '0';
    const decorated = preference.fallbackPool.map((m) => ({
      m,
      rank: breakerRank(m),
      env: inEnvelope(m),
      cost: candidateCosts.get(m) ?? Number.MAX_SAFE_INTEGER,
      ttft: predictedTtft(m) ?? SORT_UNKNOWN_TTFT,
      hot: operabilityHubForHeat.isRouteHot(m.provider, m.id) ? 1 : 0,
      free: (candidateCosts.get(m) ?? Number.MAX_SAFE_INTEGER) <= 0 ? 1 : 0,
    }));
    const sortedByHealthThenCost = decorated
      .sort((a, b) => {
        const rankDelta = a.rank - b.rank;
        if (rankDelta !== 0) return rankDelta;
        // Envelope group leads its rank so rung 1 is the fastest in-envelope
        // candidate; outside the envelope cost stays primary (unchanged).
        if (a.env !== b.env) return a.env ? -1 : 1;
        if (a.env)
          return (
            (freeLast ? a.free - b.free : 0) ||
            b.hot - a.hot ||
            ttftDiff(a.ttft, b.ttft) ||
            a.cost - b.cost
          );
        if (Math.abs(a.cost - b.cost) > costTieUsd) return a.cost - b.cost;
        return ttftDiff(a.ttft, b.ttft);
      })
      .map((d) => d.m);
    const providerQueues = new Map<string, Model[]>();
    for (const candidate of sortedByHealthThenCost) {
      const key = candidate.provider.toLowerCase();
      const queue = providerQueues.get(key);
      if (queue) queue.push(candidate);
      else providerQueues.set(key, [candidate]);
    }
    const queues = [...providerQueues.values()];
    const diversified: Model[] = [];
    let exhausted = false;
    while (diversified.length < maxRungs && !exhausted) {
      exhausted = true;
      // One pass over the queues yields one rung per provider per round.
      for (let i = 0; i < queues.length && diversified.length < maxRungs; i++) {
        const next = queues[i].shift();
        if (next) {
          diversified.push(next);
          exhausted = false;
        }
      }
    }
    return withPreferredFirst(preference, diversified);
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const sortedModels = this.buildCascadeCandidates(context);

    // 2. Determine quality threshold
    const qualityThreshold = context.qualityTarget || this.QUALITY_THRESHOLD_BASE;

    // Observer: start
    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: sortedModels.slice(0, 3).map((m) => m.name || m.id),
      summary: `Cost cascade: trying cheapest first, escalating if needed.`,
    });

    // 3. Cascade through models until quality met
    interface ExecutionAttempt {
      model: Model;
      modelId: string;
      modelName: string;
      response: ChatResponse;
      startTime: number;
      endTime: number;
      duration: number;
      cost: number;
      durationMs: number;
      success: boolean;
      qualityScore?: number;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      error?: string;
    }
    const attempts: ExecutionAttempt[] = [];
    let bestExecution: ExecutionAttempt | null = null;
    let qualityMet = false;

    for (const model of sortedModels) {
      // Try this model
      const execution = await this.tryModel(model, request, context);
      attempts.push(execution);

      // Evaluate quality - convert to ModelExecution for calculateQualityScore
      const modelExecution: ModelExecution = {
        modelId: execution.modelId,
        modelName: execution.modelName,
        role: 'primary',
        request,
        response: execution.response,
        cost: execution.cost,
        durationMs: execution.durationMs,
        success: execution.success,
        error: execution.error,
      };
      const qualityScore = this.calculateQualityScore(modelExecution);
      execution.qualityScore = qualityScore;

      // Only consider successful executions
      if (!execution.success) {
        continue; // Skip failed executions
      }

      // Check if quality threshold met
      if (qualityScore >= qualityThreshold) {
        bestExecution = execution;
        qualityMet = true;
        this.log.info(
          {
            model: model.id,
            qualityScore,
            qualityThreshold,
            cost: execution.cost,
            attemptNumber: attempts.length,
          },
          'Quality threshold met, stopping cascade'
        );
        break;
      }

      // Check if improvement justifies next tier
      if (bestExecution) {
        const improvement = qualityScore - (bestExecution.qualityScore || 0);
        const costIncrease = execution.cost - bestExecution.cost;

        this.log.info(
          {
            model: model.id,
            qualityScore,
            improvement,
            costIncrease,
          },
          'Evaluating next tier'
        );
      }

      // Track best so far (only successful executions)
      if (!bestExecution || qualityScore > (bestExecution.qualityScore || 0)) {
        bestExecution = execution;
      }

      // Stop if budget exhausted
      const totalCost = attempts.reduce((sum, exec) => sum + exec.cost, 0);
      if (context.budget && totalCost >= context.budget) {
        this.log.warn(
          {
            totalCost,
            budget: context.budget,
          },
          'Budget exhausted, stopping cascade'
        );
        break;
      }
    }

    if (!bestExecution) {
      throw new Error('No successful executions in cost cascade');
    }

    // 4. Calculate metrics
    const duration = Date.now() - startTime;
    const totalCost = attempts.reduce((sum, exec) => sum + exec.cost, 0);
    const avgCost = totalCost / attempts.length;

    // Calculate savings vs premium model
    const premiumModel = sortedModels[sortedModels.length - 1]; // Most expensive
    const premiumCost = this.estimateCost(
      premiumModel,
      bestExecution.usage.prompt_tokens,
      bestExecution.usage.completion_tokens
    );
    const savingsPercent = premiumCost > 0 ? ((premiumCost - totalCost) / premiumCost) * 100 : 0;

    const allExecutions: ModelExecution[] = attempts.map((exec) => {
      const role: ModelRole = exec === bestExecution ? 'primary' : 'secondary';
      const execution: ModelExecution = {
        modelId: exec.model.id,
        modelName: exec.model.name,
        role,
        request,
        response: exec.response,
        cost: exec.cost,
        durationMs: exec.durationMs,
        success: exec.success,
      };
      if (exec.error) {
        execution.error = exec.error;
      }
      return execution;
    });

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: allExecutions,
      finalResponse: bestExecution.response,
      totalCost,
      totalDuration: duration,
      qualityScore: bestExecution.qualityScore || 0,
      metadata: {
        cascadeLevels: attempts.length,
        qualityThreshold,
        qualityMet,
        bestModel: bestExecution.model.id,
        bestQualityScore: bestExecution.qualityScore,
        avgCostPerAttempt: avgCost,
        totalSavings: premiumCost - totalCost,
        savingsPercent: Math.round(savingsPercent * 100) / 100,
        premiumModelCost: premiumCost,
        allAttempts: attempts.map((exec) => ({
          model: exec.modelId || exec.model?.id || 'unknown',
          qualityScore: exec.qualityScore || 0,
          cost: exec.cost,
          success: exec.success,
        })),
        ...(this.isReasoningEnabled(request) && allExecutions.some((e) => e.reasoning)
          ? {
              reasoning_traces: allExecutions
                .filter((e) => e.reasoning)
                .map((e) => ({
                  model_id: e.modelId,
                  model_name: e.modelName,
                  role: e.role,
                  reasoning: e.reasoning,
                  reasoning_tokens: e.reasoningTokens,
                })),
            }
          : {}),
      },
    };
  }

  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Real token streaming for cost-cascade.
   *
   * At the DEFAULT quality threshold (0.7 — every ailin-economy /
   * ailin-* alias request, since none set request.quality_target), a
   * successful rung can NEVER fail the quality gate: calculateQualityScore()
   * floors every non-empty successful response at 0.7 (base-strategy.ts),
   * and 0.7 >= 0.7. So at the default threshold, "try rung 1, transparently
   * fall back to rung 2 on PRE-content failure, commit once content starts"
   * — exactly streamSynthesisWithFallback()'s existing contract — already IS
   * cost-cascade's real cascade behavior. No extra fallback loop is needed;
   * one call with the full cost-sorted candidate list is correct.
   *
   * When context.qualityTarget is explicitly raised above the default (only
   * possible via a direct API call setting request.quality_target — no
   * ailin-* alias ever does), a genuine content-based reject-and-escalate
   * requirement exists. Rung 1's content can't be "unshown" once streamed,
   * so speculatively streaming it and correcting after scoring would splice
   * two different answers into one response — the exact failure mode
   * streamSynthesisWithFallback's own contract (base-strategy.ts, see its
   * doc comment) exists to avoid. For that (rare, non-ailin-*) case, this
   * falls back to the existing buffered execute() and emits its decided
   * winner as a single chunk — identical to cost-cascade's behavior before
   * this change, for traffic that isn't the P0's target.
   */
  async *executeStream(
    request: ChatRequest,
    context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const qualityThreshold = context.qualityTarget || this.QUALITY_THRESHOLD_BASE;

    if (qualityThreshold > this.QUALITY_THRESHOLD_BASE) {
      // Elevated quality bar: content-based escalation is a live requirement
      // here, and it cannot be done live-streamed (see doc comment above).
      // Reuse execute()'s buffered cascade logic as-is — same candidate
      // list, same escalation, same quality gate — then emit the already-
      // decided winner as a single chunk.
      const result = await this.execute(request, context);
      // Memory parity (2026-08-16): the engine records episodic memory only on
      // its buffered branch (orchestration-engine.ts:3130), which needs an
      // OrchestrationResult the streaming branch never produces — so a
      // streaming strategy must record its own or every SSE-delivered answer
      // is silently dropped from memory. This branch HAS a real result.
      this.recordExecution(context, result).catch(() => {});
      yield this.bufferedResultAsChunk(result);
      return;
    }

    // Fast path — this is 100% of ailin-economy / anonymous traffic (no
    // ailin-* alias profile sets qualityTarget; see ailin-virtual-model-
    // service.ts).
    const startedAt = Date.now();
    const wfBuildT0 = Date.now();
    const sortedModels = this.buildCascadeCandidates(context);
    this.log.info(
      {
        component: 'latency-waterfall',
        requestId: context.requestId,
        buildCascadeCandidatesMs: Date.now() - wfBuildT0,
        candidateCount: sortedModels.length,
      },
      'cost-cascade buildCascadeCandidates duration'
    );

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: sortedModels.slice(0, 3).map((m) => m.name || m.id),
      summary: `Cost cascade: trying cheapest first, escalating if needed.`,
    });
    yield this.progressChunk('Cost cascade: trying cheapest first...', 0, 1);

    const candidates: Array<{ adapter: ProviderAdapter; model: Model }> = [];
    const wfAdaptersT0 = Date.now();
    for (const model of sortedModels) {
      // Same tolerance tryModel() has for a missing adapter — skip and let
      // the fallback chain move on rather than hard-failing the whole cascade.
      const adapter = this.getAdapterForModel
        ? await this.getAdapterForModel(model, context)
        : null;
      if (adapter) candidates.push({ adapter, model });
    }
    this.log.info(
      {
        component: 'latency-waterfall',
        requestId: context.requestId,
        adapterResolutionMs: Date.now() - wfAdaptersT0,
        rungsResolved: candidates.length,
        rung1: candidates[0]
          ? `${candidates[0].adapter.getName()}:${candidates[0].model.id}`
          : null,
      },
      'cost-cascade adapter resolution duration'
    );

    // firstChunkTimeoutMs (RC-2, 2026-08-17): TIGHT window for rung 1,
    // full collective window for the escalation rungs. Rung 1 is the
    // cheapest model — small and fast when healthy (sub-2s TTFB in
    // practice), so a generous window only serves to hide a dead/hanging
    // rung 1 behind 25s of client-visible silence. The escalation rungs
    // behind it are often LARGER/SLOWER models the cascade escalates TO,
    // and those keep today's full window so the tightening is never a
    // behavior change for them. See firstChunkTimeoutFor().

    // Total-failure sentinel. streamSynthesisWithFallback() invokes
    // fallbackContent() at exactly one place — base-strategy.ts:635, after
    // EVERY candidate failed pre-content — so this closure is a precise "what
    // follows is the degraded placeholder, not an answer" signal. Without it
    // the placeholder (54 chars, and calculateQualityScore()'s 0.7 floor)
    // clears both of recordExecution()'s gates and gets written to episodic
    // memory as a high-quality answer, poisoning future retrievals.
    let allCandidatesFailed = false;
    const degradedContent = (): string => {
      allCandidatesFailed = true;
      degradedSynthesisTotal.inc({ strategy: 'cost-cascade', reason: 'all_candidates_failed' });
      return 'All available models were unavailable for this request.';
    };

    let streamedText = '';
    let winner: { adapter: ProviderAdapter; model: Model } | undefined;
    let lastUsage: ChatResponse['usage'] | undefined;
    // Completeness sentinel (2026-08-16 follow-up). `allCandidatesFailed` only
    // covers TOTAL pre-content failure. streamSynthesisWithFallback() returns
    // NORMALLY on two further paths that leave `streamedText` TRUNCATED:
    //   1. a provider dying after the first chunk (base-strategy.ts:600-606,
    //      "keeping partial output") — the answer stops mid-sentence;
    //   2. the idle-timeout closing a straggling stream (base-strategy.ts:
    //      555-573) — usually the full answer, but not provably so.
    // In both, allCandidatesFailed stays false, so without this the half
    // answer is wrapped with finish_reason:'stop' / success:true /
    // qualityScore>=0.7 by streamedResultForMemory() and written to episodic
    // memory as a complete, high-quality answer — poisoning every future
    // retrieval with truncated content.
    //
    // A terminal finish_reason is the only in-band signal that the PROVIDER
    // considered the answer finished, so require having seen one. Accepted
    // cost: a provider that never emits finish_reason (and the idle-timeout
    // path, where a straggler legitimately may not have sent one) yields a
    // complete answer to the client that is simply NOT recorded to memory.
    // That is the deliberate trade — silently skipping a memory write is
    // recoverable; a permanently-stored truncated "good" answer is not.
    let sawTerminalFinishReason = false;

    for await (const chunk of this.streamSynthesisWithFallback(
      request,
      candidates,
      degradedContent,
      { firstChunkTimeoutMs: this.firstChunkTimeoutFor(), throwOnTotalFailure: false }
    )) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        streamedText += delta;
        // Attribute to the rung the provider itself names; the helper does not
        // report which candidate it committed to. Falls back to rung 1, which
        // is the committed candidate in every case except a pre-content
        // fallback, and only affects the memory record's metadata.
        winner ??=
          candidates.find((c) => c.model.id === chunk.model || c.model.name === chunk.model) ??
          candidates[0];
      }
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (typeof finishReason === 'string' && finishReason.length > 0) {
        sawTerminalFinishReason = true;
      }
      if (chunk.usage) lastUsage = chunk.usage;
      yield chunk;
    }

    // Recorded only on NORMAL, PROVIDER-TERMINATED completion: a consumer that
    // aborts mid-stream exits this loop via a return completion, and a
    // truncated/straggling provider stream never sets sawTerminalFinishReason
    // — so neither is ever written to memory.
    if (!allCandidatesFailed && sawTerminalFinishReason && streamedText.trim().length > 0) {
      // The memory tail must NEVER be able to corrupt an already-successful
      // response. streamedResultForMemory() is built SYNCHRONOUSLY and calls
      // winner.adapter.calculateCost() — a throw there (bad pricing metadata,
      // an adapter that assumes fields a streamed model row lacks) would
      // escape executeStream() AFTER content already reached the client,
      // making the engine rethrow and sendSSEError append raw error text onto
      // the user's completed answer. The .catch() below only ever covered the
      // recordExecution PROMISE, not this construction.
      let memoryResult: OrchestrationResult | undefined;
      try {
        memoryResult = this.streamedResultForMemory(
          request,
          streamedText,
          winner,
          candidates,
          lastUsage,
          startedAt
        );
      } catch (err) {
        this.log.warn(
          {
            requestId: context.requestId,
            model: winner?.model?.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to build the streamed memory record — skipping memory write (response already delivered intact)'
        );
      }
      if (memoryResult) {
        this.recordExecution(context, memoryResult).catch(() => {});
      }
    }
  }

  /**
   * Convert a buffered OrchestrationResult into the single streaming chunk
   * the elevated-quality-target branch of executeStream() emits. Mirrors
   * what orchestration-engine's non-streaming-strategy branch already does
   * when it yields `result.finalResponse` directly for a buffered strategy
   * result (the full ChatResponse, message.content rather than
   * delta.content, IS an accepted "chunk" shape — downstream SSE consumers
   * already handle both).
   */
  private bufferedResultAsChunk(result: OrchestrationResult): ChatResponse {
    return result.finalResponse;
  }

  /**
   * Rebuild the OrchestrationResult that recordExecution() (base-strategy.ts:2810)
   * needs from a stream that was delivered incrementally. Only the fields
   * recordExecution() actually reads are populated, with real values:
   *  - finalResponse.choices[0].message.content — the concatenated deltas
   *    (message, not delta: recordExecution → safeResponseContent reads
   *    choices[0].message.content);
   *  - modelsUsed[0].request — REQUIRED, or the memory row's "Q:" line is empty;
   *  - qualityScore — via the same calculateQualityScore() call execute() makes
   *    at cost-cascade-strategy.ts:267, not a hardcoded constant.
   */
  private streamedResultForMemory(
    request: ChatRequest,
    content: string,
    winner: { adapter: ProviderAdapter; model: Model } | undefined,
    candidates: Array<{ adapter: ProviderAdapter; model: Model }>,
    usage: ChatResponse['usage'] | undefined,
    startTime: number
  ): OrchestrationResult {
    const model = winner?.model;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const response: ChatResponse = {
      id: `cascade-stream-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model?.id ?? this.getMetadata().name,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage?.total_tokens ?? promptTokens + completionTokens,
      },
    };
    const durationMs = Date.now() - startTime;
    // Streaming chunks often carry no usage block at all; report 0 rather than
    // a fabricated estimate (the memory row's costUsd is informational).
    const cost =
      winner && usage
        ? Math.max(0, winner.adapter.calculateCost(winner.model, promptTokens, completionTokens))
        : 0;
    const execution: ModelExecution = {
      modelId: model?.id ?? 'unknown',
      modelName: model?.name ?? model?.id ?? 'unknown',
      role: 'primary',
      request,
      response,
      cost,
      durationMs,
      success: true,
    };
    const rung = winner ? candidates.indexOf(winner) + 1 : 1;
    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: [execution],
      finalResponse: response,
      totalCost: cost,
      totalDuration: durationMs,
      qualityScore: this.calculateQualityScore(execution),
      metadata: {
        streamed: true,
        cascadeLevels: rung > 0 ? rung : 1,
        qualityThreshold: this.QUALITY_THRESHOLD_BASE,
        qualityMet: true,
        bestModel: model?.id,
      },
    };
  }

  /**
   * Sort models by cost (cheapest first).
   *
   * Important: `cost = 0` is AMBIGUOUS in this codebase — it means either:
   *   1. Genuinely free (local / self-hosted / ollama)
   *   2. Missing pricing metadata (common on cloud hub variants where the
   *      discovery step didn't populate input/output prices)
   *
   * Treating case (2) as "cheapest" was the root cause of hubs with ZEROED
   * OUT accounts being tried first while native providers with real pricing
   * (and real credit) never got a chance. The cascade would exhaust itself
   * on HTTP 402/403 from all dead hubs before reaching the working native.
   *
   * Fix: keep case (1) at the top (truly free = preferred), but push case
   * (2) to the BOTTOM (unknown cost = treat as expensive until proven
   * otherwise). Case (1) is detected by the provider name — self-hosted,
   * local, ollama all indicate actually-free models.
   */
  private sortModelsByCost(models: Model[]): Model[] {
    return [...models].sort((a, b) => {
      const aCost = this.effectiveCost(a);
      const bCost = this.effectiveCost(b);
      return aCost - bCost;
    });
  }

  private effectiveCost(model: Model): number {
    const rawCost = (Number(model.inputCostPer1k) + Number(model.outputCostPer1k)) / 2;
    if (rawCost > 0) return rawCost;
    // Ambiguous zero — decide based on provider type.
    const provider = (model.provider || '').toLowerCase();
    const isTrulyFree =
      provider === 'self-hosted' ||
      provider === 'ollama' ||
      provider.startsWith('local-') ||
      provider.includes('local');
    if (isTrulyFree) return 0;
    // Unknown-cost cloud model — push to the bottom of the cascade so
    // models with real pricing (and, usually, real credit) are tried first.
    return Number.MAX_SAFE_INTEGER;
  }

  /**
   * Pre-flight cost estimate for orchestration-engine's explicit-strategy budget
   * gate (selectStrategyCore -> "strategy_budget_exceeded").
   *
   * The base-class implementation SUMS the cost of every model it's given —
   * correct for strategies like parallel/consensus that genuinely invoke
   * `maxModels` candidates and pay for all of them. Cost-cascade does not: it
   * tries candidates SEQUENTIALLY and stops at the first one that succeeds,
   * so it only ever pays for ONE. The caller passes an arbitrary maxModels-sized
   * (5) slice of context.models — not even cost-sorted — so the base formula
   * was estimating "5 models' worth of tokens" for a strategy that spends on
   * exactly 1, at whatever those 5 happened to cost (sometimes premium
   * providers). Confirmed in production: the estimate scaled with conversation
   * length and which candidates happened to be in that slice, exceeding the
   * maxCost ceiling on longer conversations even though real spend (the
   * cheapest candidate that actually succeeds) stayed pennies.
   *
   * Fix: estimate using only the cheapest candidate — the one the cascade
   * will actually try (and, absent a provider outage, pay for) first.
   */
  calculateEstimatedCost(
    models: Model[],
    estimatedInputTokens: number,
    estimatedOutputTokens: number
  ): number {
    if (models.length === 0) return 0;
    const [cheapest] = this.sortModelsByCost(models);
    return super.calculateEstimatedCost([cheapest], estimatedInputTokens, estimatedOutputTokens);
  }

  /**
   * Per-attempt first-chunk deadline policy for executeStream() (RC-2 +
   * Workstream G dynamic budget, 2026-08-17).
   *
   * Attempt 0 — the first rung — gets a TTFB window sized from HISTORY when
   * enough of it exists for that exact provider/model route:
   * clamp(EWMA-window p95 × factor, floor, ceiling) — see
   * ttft-tracker.computeFirstChunkBudgetMs. With insufficient history it
   * falls back to the static pin (COLLECTIVE_FIRST_RUNG_TTFB_MS, prod pins
   * 3000ms) so cold-start behavior is exactly today's.
   *
   * Escalation attempts (2026-08-18, P0.8): previously kept the full
   * collective window (collectiveModelTimeoutMs(), 25s default) — live prod
   * evidence showed the anonymous tail outliers at ~51s = 3s rung 1 + two
   * 25s escalation rungs on routes that never delivered a first chunk. For
   * an INTERACTIVE cascade, a rung that cannot produce a first chunk within
   * a few seconds is useless regardless of tier. Later rungs now get a
   * dynamic budget too: measured p95 when known, else a static escalation
   * budget (COLLECTIVE_LATER_RUNG_TTFB_MS, default 8000ms — larger models
   * legitimately need more than rung 1's cheap-tier 3s, but not 25s).
   * Env COLLECTIVE_LATER_RUNG_TTFB_MS=0 restores the old 25s behavior.
   *
   * A pinned executor is still attempt 0; bounding its first-chunk wait is
   * intended behavior (a pinned-but-dead provider should not stall TTFT
   * either — the cascade continues and the user still gets an answer).
   */
  protected firstChunkTimeoutFor(): (
    attemptIndex: number,
    candidate?: { adapter: ProviderAdapter; model: Model }
  ) => number {
    // Unknown-route budget (P0.8, 2026-08-18): default lowered 8000→3000ms.
    // Live prod evidence: the cheap tier is dominated by ~40k free HF/
    // featherless routes, so almost every rung 1 is a route with <5 tracker
    // samples — it got the FULL 8s static budget and burned it on a serverless
    // backend that never delivers a first chunk (8s silent gap measured inside
    // anonymous "oi" requests before the observer fallback). A healthy cheap
    // model produces its first chunk well under 3s; known-good routes are
    // unaffected (their budget comes from measured p95, not this fallback).
    // Operators can restore the old behavior with COLLECTIVE_FIRST_RUNG_TTFB_MS.
    const raw = Number(process.env.COLLECTIVE_FIRST_RUNG_TTFB_MS ?? 3000);
    const firstRungFallbackMs = Number.isFinite(raw) && raw > 0 ? raw : 3000;
    const laterRaw = Number(process.env.COLLECTIVE_LATER_RUNG_TTFB_MS ?? 8000);
    const laterFallbackMs =
      Number.isFinite(laterRaw) && laterRaw > 0 ? laterRaw : this.collectiveModelTimeoutMs();
    const ttft = getTtftTracker();
    return (attemptIndex, candidate) => {
      if (attemptIndex !== 0) {
        if (candidate) {
          return ttft.computeFirstChunkBudgetMs(candidate.adapter.getName(), candidate.model.id, {
            staticFallbackMs: laterFallbackMs,
          });
        }
        return laterFallbackMs;
      }
      if (!candidate) return firstRungFallbackMs;
      return ttft.computeFirstChunkBudgetMs(candidate.adapter.getName(), candidate.model.id, {
        staticFallbackMs: firstRungFallbackMs,
      });
    };
  }

  /**
   * Try a single model
   * Returns internal execution format with extra fields
   */
  private async tryModel(
    model: Model,
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<{
    model: Model;
    modelId: string;
    modelName: string;
    response: ChatResponse;
    startTime: number;
    endTime: number;
    duration: number;
    cost: number;
    durationMs: number;
    success: boolean;
    qualityScore?: number;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    error?: string;
  }> {
    const execStart = Date.now();

    try {
      if (!this.getAdapterForModel) {
        throw new Error('getAdapterForModel not injected by orchestration engine');
      }
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) {
        throw new Error(`No adapter found for model: ${model.id}`);
      }
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      const reasoningEnabled = this.isReasoningEnabled(request);
      // Per-rung deadline (2026-07-04, c3-v4 defect C): the cascade is
      // SEQUENTIAL, so an unbounded rung rides the adapter's internal
      // ~60s×3-retry budget (~180s) and one dead route burns the caller's
      // whole window (all 32 normal-task cost-cascade rows timed out at
      // ~300s with $0). boundModelExecution returns a failed ModelExecution
      // on timeout; hasUsableAssistantResponse below then escalates to the
      // next rung. Worst case: maxRungs × collectiveModelTimeoutMs.
      const exec = await this.boundModelExecution(
        (signal) =>
          hasTools
            ? this.executeModelWithTools(adapter, model, request, 'primary', undefined, signal)
            : reasoningEnabled
              ? this.executeModelWithReasoning(adapter, model, request, 'primary', signal)
              : this.executeModel(adapter, model, request, 'primary', signal),
        { adapter, model, request, role: 'primary' },
        this.collectiveModelTimeoutMs(),
        context.signal
      );
      const response = exec.response;
      const execEnd = Date.now();
      const usage = {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      };
      const cost = Math.max(
        0,
        adapter.calculateCost(model, usage.prompt_tokens, usage.completion_tokens)
      );
      const hasUsableResponse = this.hasUsableAssistantResponse(response);
      const executionError = hasUsableResponse
        ? undefined
        : 'Provider returned empty assistant response';

      // Internal execution format
      const execution = {
        model,
        modelId: model.id,
        modelName: model.name,
        response,
        startTime: execStart,
        endTime: execEnd,
        duration: execEnd - execStart,
        usage,
        cost,
        durationMs: execEnd - execStart,
        success: hasUsableResponse,
        error: executionError,
        qualityScore: 0, // Will be set later
      };

      return execution;
    } catch (error: unknown) {
      const execEnd = Date.now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.log.error(
        {
          model: model.id,
          error: errorMessage,
        },
        'Model execution failed in cascade'
      );

      // Internal execution format for errors
      const errorObj = error instanceof Error ? error : new Error(errorMessage);
      const execution = {
        model,
        modelId: model.id,
        modelName: model.name,
        response: this.createErrorResponse(model, errorObj),
        startTime: execStart,
        endTime: execEnd,
        duration: execEnd - execStart,
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        cost: 0,
        durationMs: execEnd - execStart,
        success: false,
        error: errorMessage,
        qualityScore: 0,
      };

      return execution;
    }
  }

  /**
   * Estimate cost for a model
   */
  private estimateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Math.max(0, Number(model.inputCostPer1k) || 0);
    const outputRate = Math.max(0, Number(model.outputCostPer1k) || 0);
    const cost = (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
    return Math.max(0, cost);
  }

  /**
   * Create error response
   */
  private createErrorResponse(model: Model, error: Error): ChatResponse {
    return {
      id: `error-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `Error: ${error.message}`,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }
}
