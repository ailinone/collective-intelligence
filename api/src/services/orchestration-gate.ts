// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared admission gate for orchestration entrypoints.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /v1/chat/completions` was for a long time the only orchestration
 * entrypoint that ran the quota + governance checks (see the inline block at
 * `chat-routes.ts:797-858`). Every other route that reaches the orchestration
 * engine — `/v1/responses`, `/v1/chat/completions/extended-thinking`,
 * `/ultra-thinking` — executed real, provider-billed inference with no admission
 * control at all. This module is the single place those checks live so a new
 * entrypoint has one obvious thing to call instead of a 60-line block to copy
 * (and to copy subtly wrong).
 *
 * SCOPE NOTE (2026-08-03). This workstream originally covered five entrypoints.
 * `/v1/chat/completions/intelligent` and `/v1/analyze-requirements` were deleted
 * outright by #271 (they were unfinished, their model selection never reached
 * execution, and a six-month access-log census found zero organic consumers), so
 * the three above are the entire surviving set. Nothing here is
 * `/intelligent`-specific; the helper is route-agnostic by construction.
 *
 * THREE HARD INVARIANTS — do not break these without reading the whole file.
 *
 * 1. CHECK-ONLY. THIS MODULE NEVER RECORDS USAGE.
 *    Recording stays at the single existing chokepoint `trackChatUsage`
 *    (`billing-usage-tracker.ts:68`), which fans out to `debitChatRequest`,
 *    `recordUsageEvents` and `recordQuotaUsage` in one `Promise.all`
 *    (`billing-usage-tracker.ts:88-137`). ALL THREE routes this gate is wired
 *    into ALREADY call `trackChatUsage`, on both their streaming and their
 *    non-streaming paths — `/v1/responses` (`responses-routes.ts:871`,
 *    `:1691`) and both thinking routes (`extended-thinking-routes.ts:803`,
 *    `:1095`). None of them passes `accounting`, so all four call sites run at
 *    the default `full` mode: wallet debit + analytics event + quota
 *    increment. If this module also recorded, those routes would double-debit
 *    the wallet and double-increment the quota counter. Check here, record
 *    there. Always.
 *
 * 2. IT NEVER TOUCHES `reply`.
 *    It returns `{ status, body }` and lets the caller send, mirroring
 *    `WalletGateResult` (`prepaid-wallet-gate.ts:83-93`) and how
 *    `chat-routes.ts:856-858` consumes it. This keeps the gate out of the
 *    `FST_ERR_REP_ALREADY_SENT` class of bugs, which matters most on the
 *    streaming routes where headers may already be committed.
 *
 * 3. NO WALLET, NO PRICING TIER — AND THAT IS ENFORCED STRUCTURALLY.
 *    `OrchestrationGateInput` carries only `model` and `strategy`. It has no
 *    `messages`, no `max_tokens`, no `ailin_alias` and no `ChatRequest`
 *    anywhere in its type. `gateChatRequest` (`prepaid-wallet-gate.ts:101`)
 *    needs `req.messages` (via `estimatePromptTokens`, `:64-81`),
 *    `req.max_tokens` (`:109`) and `req.ailin_alias` (via `resolveTier`,
 *    `:56-61`), so calling it from in here does not typecheck. Same for
 *    `gateTierRequest`, which needs `estimatePromptTokens(chatRequest.messages)`
 *    (`chat-routes.ts:902`). This is deliberate: a `wallet: false` default
 *    boolean would be flippable in a one-line diff; a missing field is not.
 *
 *    The reason is not stylistic. `PREPAID_WALLET_GATE_ENABLED` is a known
 *    landmine on exactly these routes: `normalizeChatRequest` rewrites every
 *    `ailin-*` alias to the literal model `'auto'`, and `resolveTier` reads
 *    `req.model` FIRST (`prepaid-wallet-gate.ts:56-58`), so `'auto'` matches a
 *    real chargeable pricing cell. A separate PR owns that fix. Spreading the
 *    wallet gate to more routes before it lands would multiply the blast
 *    radius. `orchestration-gate-wallet-exclusion.test.ts` asserts this file
 *    imports neither `prepaid-wallet-gate` nor `pricing-tier-billing`.
 *
 * GATE PRECEDENCE — PINNED. Do not reorder without changing this comment.
 *
 *    [future: anonymous] -> [future: free-tier] -> org quota -> governance
 *
 * The gates run concurrently (they read independent data sources and neither
 * depends on the other's result) and precedence is applied to the resolved
 * results AFTERWARDS, exactly as `chat-routes.ts:797-858` does. The array is
 * deliberately a list of independent thunks so PR #263's free-tier and
 * anonymous quota gates can be appended without restructuring anything: add the
 * flags to `OrchestrationGateInput.gates`, add the thunks to the `Promise.all`,
 * and slot the checks in at the head of the precedence chain. Free-tier and
 * anonymous denials belong AHEAD of org quota because they are the more
 * specific and more actionable 429.
 *
 * FAIL-OPEN, DELIBERATELY.
 * `checkQuota` (`quota-service.ts:70-98`) has no try/catch of its own, and on
 * the reference route the `Promise.all` sits at `chat-routes.ts:797` — ABOVE
 * that handler's `try {` at `:920`. A transient Prisma error there becomes a
 * 500. That is an accident of placement, not a decision, and copying it to more
 * routes would multiply a DB-hiccup-to-500 path across the whole API.
 * Here `checkQuota` is wrapped and failures resolve to ALLOW with a structured
 * error log. `evaluateGovernance` is already fail-open end to end
 * (`org-governance-service.ts:446-452`). Net effect: a route that works today
 * cannot start 500ing because this gate was added to it.
 *
 * NO SIDE EFFECTS AT DEFAULT FLAGS — INCLUDING WRITES.
 * "Shadow mode is a no-op" has to be true at the storage layer too, not just at
 * the response layer. `checkQuota`'s default path calls
 * `getOrCreateCurrentQuota`, which INSERTs a `usage_quotas` row when the org has
 * none for the period. This module therefore passes `createIfMissing: false`
 * (see `safeCheckQuota`) and reads a missing row as unlimited.
 *
 * The justification is the flat principle that a check must not write. It is
 * NOT "these routes never touch `usage_quotas`" — do not restate it that way.
 * All three ALREADY increment that table on every successful request via their
 * existing `trackChatUsage` calls (see invariant 1). `safeCheckQuota` spells out
 * what passing `false` still buys given that.
 *
 * The governance leg is likewise bounded by a short-TTL decision cache so adding
 * it to these routes does not multiply the month-to-date spend aggregate across
 * the whole request path.
 *
 * WHAT THIS MODULE OWNS THAT IS *NOT* A GATE: `resolveMeteringMode`.
 * Invariant 1 still holds — nothing here records. But the routes that this
 * workstream newly meters need one shared, documented answer to "how much
 * accounting is switched on", because turning metering ON is itself a
 * cross-route behaviour change: the quota counters it increments are read by an
 * ALREADY-ENFORCING gate on `/v1/chat/completions`, a route this change does not
 * touch. That switch lives next to the gate mode so an operator has one place to
 * look and one kill switch (`ORCHESTRATION_GATE_MODE=off`) that covers both. See
 * `MeteringMode` for the full argument.
 */

import { checkQuota } from '@/services/quota-service';
import { evaluateGovernance } from '@/services/org-governance-service';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { logger } from '@/utils/logger';
import type { QuotaCheckResult } from '@/types';
import type { GovernanceDecision } from '@/services/org-governance-service';

const log = logger.child({ component: 'orchestration-gate' });

/**
 * - `off`     — total no-op. No DB round-trips at all, returns allow immediately.
 * - `shadow`  — gates evaluate, denials are LOGGED and never enforced (default).
 * - `enforce` — denials are returned to the caller as 429 / 403.
 */
export type GateMode = 'off' | 'shadow' | 'enforce';

export const DEFAULT_GATE_MODE: GateMode = 'shadow';

/**
 * How much accounting a newly-metered orchestration route performs.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ STATUS (2026-08-03): NO PRODUCTION CALL SITES. `ORCHESTRATION_METERING_-  │
 * │ MODE` currently controls NOTHING — do not document it to operators as an │
 * │ active switch.                                                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * This existed for the two routes that needed NEW metering,
 * `/v1/chat/completions/intelligent` and `/v1/analyze-requirements`. #271 deleted
 * both. The three routes this gate now covers (`/v1/responses` and the two
 * thinking routes) were ALREADY metered before this change and keep their
 * existing `trackChatUsage` calls untouched, so none of them passes `accounting`
 * and none of them reads this mode.
 *
 * It is retained rather than deleted because the next route wired to this gate
 * will face exactly the problem it solves, and because the reasoning below is the
 * load-bearing argument for why metering a previously-uncounted route is not a
 * local change. Deleting it would delete the argument with it. `resolveGateMode`
 * and everything above this line ARE live.
 *
 * - `off`       — no `trackChatUsage` call at all. Byte-for-byte the pre-PR
 *                 behaviour, for rollback without a revert.
 * - `analytics` — DEFAULT. Attributed `chat.completion` usage events with real
 *                 cost/token numbers, but NO `usage_quotas` increment and NO
 *                 prepaid-wallet debit.
 * - `full`      — everything, including the quota counter and the wallet debit.
 *
 * WHY THE DEFAULT IS `analytics` AND NOT `full`
 * ---------------------------------------------
 * Metering a previously-uncounted route is NOT a locally-contained change.
 * `trackChatUsage` -> `recordQuotaUsage` (`billing-usage-tracker.ts`) atomically
 * increments `usage_quotas.requestCount/tokenCount/costUsd`
 * (`quota-service.ts:117-125`), and those are the exact columns `checkQuota`
 * compares in `calculateRemaining`. `POST /v1/chat/completions` — a route this
 * change does not touch — enforces a hard 429 on that result with NO feature
 * flag of its own (`chat-routes.ts:798-820`).
 *
 * So an org with an explicitly configured quota that today splits traffic
 * between `/v1/responses` (uncounted on its streaming path) and
 * `/v1/chat/completions` (counted) would, at `full`, start burning its cap at
 * the combined rate the moment this deploys, and could begin receiving
 * `quota_exceeded` on a route that works today. `ORCHESTRATION_GATE_MODE`
 * would NOT have protected against that: `shadow` only disables denial inside
 * this helper, and `off` disables the gate but not the metering.
 *
 * The same argument applies to the wallet: `trackChatUsage` also calls
 * `debitChatRequest`, so `full` would make a newly-metered route a wallet DEBIT
 * site with no wallet RESERVE (no `gateChatRequest`, so `holdId` is undefined
 * and the unreserved-debit branch is taken). That is inert only while
 * `PREPAID_WALLET_GATE_ENABLED` is false; the alias landmine
 * (`ailin-*` -> `'auto'` -> a real chargeable `STRATEGY_POLICY` cell) makes it
 * live the moment that flag flips. The wallet fix is a separate PR's job, and
 * this one must not widen its blast radius.
 *
 * `analytics` closes the actual revenue hole — the traffic becomes visible and
 * attributable, with real cost — while moving no counter that anything else
 * enforces on. Promotion to `full` is then a deliberate act, taken once the
 * operator has confirmed (per the PR body's pre-deploy queries) that no live org
 * would be tipped over its cap by it.
 */
export type MeteringMode = 'off' | 'analytics' | 'full';

export const DEFAULT_METERING_MODE: MeteringMode = 'analytics';

export interface OrchestrationGateInput {
  /**
   * Tenant to gate. An empty string is TOLERATED and returns `{ allowed: true }`
   * immediately — `/v1/responses` authenticates with `authenticateRequest` and no
   * `requireTenantContext`, so an org-less principal is expected there, and
   * turning a revenue hole into a 500 for those callers would be a strictly
   * worse outcome.
   */
  organizationId: string;
  userId: string;
  /** Route path, e.g. `/v1/responses`. Audit metadata, shadow-log key, and the per-endpoint enforcement key. */
  endpoint: string;
  requestId: string;
  /** Resolved model, post-normalization / post-`buildChatRequest`. */
  model?: string | null;
  /** Canonical strategy, post-normalization. */
  strategy?: string | null;
  /** Both default to true. */
  gates?: { quota?: boolean; governance?: boolean };
}

export type OrchestrationGateResult =
  | {
      allowed: true;
      /**
       * Present when the gate WOULD have denied but the endpoint is in shadow
       * mode. Callers should ignore it; it exists so tests and the shadow log
       * can assert on the would-be outcome.
       */
      shadowDenial?: { code: string; status: number };
    }
  | { allowed: false; status: number; body: unknown };

const ALLOW: OrchestrationGateResult = { allowed: true };

function parseMode(raw: string | undefined): GateMode | null {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'off':
      return 'off';
    case 'shadow':
      return 'shadow';
    case 'enforce':
      return 'enforce';
    default:
      return null;
  }
}

/**
 * Resolve the effective mode for one endpoint.
 *
 * - `ORCHESTRATION_GATE_MODE` is the global default (`shadow` when unset or
 *   unparseable — the safe value, since shadow cannot deny).
 * - `ORCHESTRATION_GATE_ENFORCE_ENDPOINTS` is a comma-separated allowlist that
 *   upgrades individual endpoints to `enforce`. `*` upgrades all of them. This
 *   is what makes the staged rollout a per-route env flip with no code change.
 * - `off` ALWAYS wins. It is the incident kill switch, so an operator who sets
 *   it does not also have to remember to clear the allowlist.
 *
 * Read per call rather than cached at module load (a deliberate divergence from
 * `prepaid-wallet-gate.ts:31`): the cost is two `process.env` reads, and it
 * makes the per-endpoint rollout directly testable.
 */
export function resolveGateMode(endpoint: string): GateMode {
  const globalMode = parseMode(process.env.ORCHESTRATION_GATE_MODE) ?? DEFAULT_GATE_MODE;
  if (globalMode === 'off') {
    return 'off';
  }

  const allowlist = (process.env.ORCHESTRATION_GATE_ENFORCE_ENDPOINTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (allowlist.includes('*') || allowlist.includes(endpoint)) {
    return 'enforce';
  }

  return globalMode;
}

function parseMeteringMode(raw: string | undefined): MeteringMode | null {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'off':
      return 'off';
    case 'analytics':
      return 'analytics';
    case 'full':
      return 'full';
    default:
      return null;
  }
}

/**
 * Resolve the accounting mode for the routes this change newly meters.
 *
 * `ORCHESTRATION_METERING_MODE` selects it (`analytics` when unset or
 * unparseable). `ORCHESTRATION_GATE_MODE=off` forces `off` — it is the single
 * incident kill switch for this whole workstream, so an operator who reaches for
 * it gets the metering turned off too, without having to know a second variable
 * exists.
 */
export function resolveMeteringMode(): MeteringMode {
  if (parseMode(process.env.ORCHESTRATION_GATE_MODE) === 'off') {
    return 'off';
  }
  return parseMeteringMode(process.env.ORCHESTRATION_METERING_MODE) ?? DEFAULT_METERING_MODE;
}

/**
 * Convenience for route call sites: `undefined` means "do not call
 * `trackChatUsage` at all", otherwise the value to pass as its `accounting`
 * option. Keeps the mode-to-option mapping in one place rather than repeated
 * inline at every newly-metered route.
 */
export function resolveUsageAccounting(): 'full' | 'analytics-only' | undefined {
  const mode = resolveMeteringMode();
  if (mode === 'off') return undefined;
  return mode === 'full' ? 'full' : 'analytics-only';
}

/**
 * `checkQuota` with a fail-OPEN wrapper. Returns null when the check could not
 * be completed, which the caller treats as "no opinion" (allow).
 */
async function safeCheckQuota(
  organizationId: string,
  userId: string,
  endpoint: string,
  requestId: string
): Promise<QuotaCheckResult | null> {
  try {
    return await checkQuota(
      organizationId,
      {
        organizationId,
        userId,
        operation: { requests: 1 },
      },
      // A CHECK MUST NOT WRITE. That is the whole justification, and it does
      // not depend on what the route does elsewhere. `checkQuota`'s default
      // path calls `getOrCreateCurrentQuota`, which INSERTs a `usage_quotas`
      // row when none exists for the period.
      //
      // DO NOT reintroduce the argument that these routes have no
      // `recordQuotaUsage` path. They all have one, at DEFAULT flags: none of
      // the three passes an `accounting` option to `trackChatUsage`, so each
      // runs at its default `full` mode and already flows
      // `trackChatUsage` -> `recordQuotaUsage` -> `getOrCreateCurrentQuota`,
      // incrementing `requestCount`/`tokenCount`/`costUsd` on every successful
      // request. That includes `/v1/responses` STREAMING, at
      // `responses-routes.ts:871`. The "route with no quota interaction"
      // premise described `/v1/chat/completions/intelligent` and
      // `/v1/analyze-requirements` — the two entrypoints that would have needed
      // NEW metering, and that #271 deleted.
      //
      // This matters for anyone sizing an enforcement flip: do not read this
      // gate's quota check as these routes' only `usage_quotas` touchpoint, and
      // do not estimate headroom from that assumption. Read the table.
      //
      // What `createIfMissing: false` still buys, given all that:
      //   (a) No row for a request that never reaches `trackChatUsage`. The
      //       gate runs at the top of the handler and the recording runs at the
      //       end; everything in between can fail. Otherwise a request that
      //       produced no usage would still change what `listQuotas` and
      //       `getQuotaUsage` report to admins.
      //   (b) No race on `@@unique([organizationId, period, periodStart])`
      //       between concurrent first-requests-of-period, which produces an
      //       ERROR log per collision.
      //
      // A missing row is read as unlimited, which is what the auto-created row
      // meant anyway (`requestLimit: INT_MAX`, null token/cost caps).
      { createIfMissing: false }
    );
  } catch (error) {
    log.error(
      {
        error: error instanceof Error ? error.message : String(error),
        organizationId,
        endpoint,
        requestId,
      },
      'Quota check failed — failing open (allow)'
    );
    return null;
  }
}

// ─── Governance micro-cache ──────────────────────────────────────────────────
//
// `evaluateGovernance` is NOT one round-trip for an org that has a budget
// configured. It is `organization.findUnique` (`getGovernanceConfig`,
// `org-governance-service.ts:170-173`) and then, SEQUENTIALLY, a
// `requestLog.aggregate({_sum: costUsd})` over the whole current month for that
// org (`:288-291`). That second query is index-supported
// (`@@index([organizationId, createdAt(sort: Desc)])`) but is still a range SUM
// over every request-log row the org produced this month — for a high-volume
// org, tens of thousands of rows, on every request.
//
// This gate ADDS that cost to three routes that never paid it, at DEFAULT flags,
// and on `/v1/responses` streaming it lands directly in TTFB (the gate runs
// before `setupSSEHeaders`). A monthly budget cap does not change meaningfully
// inside a few seconds, so a short TTL trades a bounded enforcement delay for a
// bounded query rate — at 10s an org doing 200 rps costs 0.1 aggregate/s instead
// of 200/s. Set `ORCHESTRATION_GATE_GOVERNANCE_CACHE_MS=0` to disable.
//
// The cache holds only the DECISION. Shadow-denial logging happens in
// `finalize()`, outside it, so the enforcement-readiness metric is still emitted
// once per request and is not deflated by cache hits.

const DEFAULT_GOVERNANCE_CACHE_TTL_MS = 10_000;
const GOVERNANCE_CACHE_MAX_ENTRIES = 5_000;

const governanceCache = new Map<string, { expiresAt: number; decision: GovernanceDecision }>();

function governanceCacheTtlMs(): number {
  const raw = process.env.ORCHESTRATION_GATE_GOVERNANCE_CACHE_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_GOVERNANCE_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_GOVERNANCE_CACHE_TTL_MS;
  }
  return parsed;
}

/** Test-only. Governance decisions are cached per process; tests must not leak across cases. */
export function __resetOrchestrationGateCaches(): void {
  governanceCache.clear();
}

async function cachedEvaluateGovernance(
  organizationId: string,
  request: { strategy?: string | null; model?: string | null }
): Promise<GovernanceDecision> {
  const ttl = governanceCacheTtlMs();
  if (ttl <= 0) {
    return await evaluateGovernance(organizationId, request);
  }

  // Model and strategy are part of the key because `evaluatePolicy` branches on
  // both — caching by org alone would let one model's verdict answer for another.
  const key = `${organizationId}\0${request.model ?? ''}\0${request.strategy ?? ''}`;
  const now = Date.now();

  const hit = governanceCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.decision;
  }

  const decision = await evaluateGovernance(organizationId, request);

  // Crude bound rather than an LRU: this is a 10-second window, so the working
  // set is "orgs active in the last 10s". Blowing past 5k of those means the
  // cache is not helping anyway, and dropping it costs one extra query per org.
  if (governanceCache.size >= GOVERNANCE_CACHE_MAX_ENTRIES) {
    governanceCache.clear();
  }
  governanceCache.set(key, { expiresAt: now + ttl, decision });

  return decision;
}

/**
 * Run the admission gates for an orchestration entrypoint.
 *
 * Never records usage, never touches `reply`, never evaluates wallet or pricing
 * tier. See the file header for why each of those is a hard invariant.
 */
export async function evaluateOrchestrationGate(
  input: OrchestrationGateInput
): Promise<OrchestrationGateResult> {
  const { organizationId, userId, endpoint, requestId } = input;

  const mode = resolveGateMode(endpoint);
  if (mode === 'off') {
    return ALLOW;
  }

  // No tenant => nothing org-scoped to check. Both gates key on organizationId,
  // so this is genuinely nothing to evaluate rather than a silent skip.
  //
  // DEBUG, not WARN, deliberately. `/v1/responses` authenticates with
  // `authenticateRequest` and no `requireTenantContext`, so '' is the EXPECTED
  // value for any org-less principal on that route — at WARN this would be a
  // per-request warning line
  // in production for traffic that is behaving exactly as designed. The
  // operational question it answers ("how much traffic escapes the gate for lack
  // of a tenant?") is answered instead by the counter below, which is emitted
  // once per request at debug and is the thing to aggregate.
  if (!organizationId) {
    log.debug(
      { event: 'orchestration_gate.skipped_no_org', endpoint, requestId, userId },
      'Orchestration gate skipped — request has no organization context'
    );
    return ALLOW;
  }

  const runQuota = input.gates?.quota !== false;
  const runGovernance = input.gates?.governance !== false;

  // Independent data sources (quota counters vs. org governance settings), so
  // one round-trip in wall-clock time instead of two. Precedence is applied
  // below, on the resolved results — see the pinned order in the file header.
  const [quotaCheck, governanceDecision]: [QuotaCheckResult | null, GovernanceDecision | null] =
    await Promise.all([
      runQuota
        ? safeCheckQuota(organizationId, userId, endpoint, requestId)
        : Promise.resolve(null),
      runGovernance
        ? cachedEvaluateGovernance(organizationId, {
            strategy: input.strategy,
            model: input.model,
          })
        : Promise.resolve(null),
    ]);

  // ── 1. Org quota ───────────────────────────────────────────────────────────
  // (anonymous and free-tier gates slot in ahead of this — see file header)
  if (quotaCheck && !quotaCheck.allowed) {
    return finalize(mode, input, {
      code: 'quota_exceeded',
      status: 429,
      body: {
        error: {
          code: 'quota_exceeded',
          message: quotaCheck.reason ?? 'Organization quota exceeded for chat completions.',
          remaining: quotaCheck.remaining,
          reset_at: quotaCheck.resetAt,
        },
      },
    });
  }

  // ── 2. Governance: monthly budget cap + access policy ──────────────────────
  // Fail-OPEN by construction: orgs without governance configured are
  // unaffected (`org-governance-service.ts:430-432`).
  if (governanceDecision && !governanceDecision.allowed) {
    const code = governanceDecision.code ?? 'policy_violation';
    return finalize(
      mode,
      input,
      {
        code,
        status: 403,
        body: {
          error: {
            code: governanceDecision.code,
            message: governanceDecision.message,
            ...(governanceDecision.details ?? {}),
          },
        },
      },
      async () => {
        await recordSecurityEvent({
          eventType:
            governanceDecision.code === 'organization_budget_exceeded'
              ? 'governance.budget.blocked'
              : 'governance.policy.blocked',
          severity: 'warning',
          message: governanceDecision.message ?? 'Request denied by organization governance.',
          userId,
          organizationId,
          metadata: {
            code: governanceDecision.code,
            endpoint,
            requestedModel: input.model,
            requestedStrategy: input.strategy,
            ...(governanceDecision.details ?? {}),
          },
        });
      }
    );
  }

  return ALLOW;
}

/**
 * Turn a would-be denial into a result according to the endpoint's mode.
 *
 * In `shadow` the request is ALLOWED and one structured line is emitted —
 * `orchestration_gate.shadow_denial` is the enforcement-readiness metric: an
 * endpoint whose shadow-denial rate sits at ~zero for a full observation window
 * is safe to move into `ORCHESTRATION_GATE_ENFORCE_ENDPOINTS`.
 *
 * `onEnforce` (the governance security-audit write) runs only when the denial is
 * real, so shadow mode never writes audit rows for requests it let through.
 */
async function finalize(
  mode: GateMode,
  input: OrchestrationGateInput,
  denial: { code: string; status: number; body: unknown },
  onEnforce?: () => Promise<void>
): Promise<OrchestrationGateResult> {
  if (mode !== 'enforce') {
    log.warn(
      {
        event: 'orchestration_gate.shadow_denial',
        endpoint: input.endpoint,
        organizationId: input.organizationId,
        userId: input.userId,
        requestId: input.requestId,
        code: denial.code,
        status: denial.status,
        requestedModel: input.model,
        requestedStrategy: input.strategy,
      },
      'Orchestration gate would have denied this request (shadow mode — allowed)'
    );
    return { allowed: true, shadowDenial: { code: denial.code, status: denial.status } };
  }

  if (onEnforce) {
    await onEnforce();
  }

  log.warn(
    {
      event: 'orchestration_gate.denied',
      endpoint: input.endpoint,
      organizationId: input.organizationId,
      userId: input.userId,
      requestId: input.requestId,
      code: denial.code,
      status: denial.status,
    },
    'Orchestration gate denied request'
  );

  return { allowed: false, status: denial.status, body: denial.body };
}
