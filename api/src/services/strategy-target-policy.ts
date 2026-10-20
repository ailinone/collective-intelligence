// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-target-policy.ts — A3, the minimal per-target deny matrix
 * (ENT-001 Phase 1). Implements a3-deny-matrix-design.md §2–§8 EXACTLY:
 * a decision function keyed `(organizationId, family)` consuming the org's
 * `BillingEntitlements.planId` (NO billing contract changes), with the
 * failure-mode table per risk class, the stale-read path, and the
 * off|shadow|enforce mode surface.
 *
 * ## Scope (design §1)
 *
 * Phase 1 decides STRATEGY FAMILIES only, and only for composite
 * `<family>:<tier>` targets — the request shapes where
 * `resolveRequestStrategyFamily` (strategy-family.ts) returns a family.
 * Legacy `ailin-*` presets, raw provider ids and `auto` are not composite
 * targets and pass through untouched (the gate never fires for them). The
 * matrix ships EMPTY (`PLAN_FAMILY_MATRIX`): every plan gets `DEFAULT_ACCESS`
 * (all-allow, the resolved commercial decision of 2026-10-01 — default-allow +
 * telemetry). Phase 2 tightens by adding matrix entries — a config-shaped
 * change, no redeploy of this gate.
 *
 * ## Failure philosophy (design §4 — the asymmetry is deliberate)
 *
 * `billing-entitlements-client.ts`'s philosophy ("billing indisponível não
 * pode travar a plataforma") is preserved PER RISK CLASS, not globally:
 *   - low-risk families (fan-out ≤ 1.5, the platform default `auto` among
 *     them) ALLOW on billing-unavailable-with-no-stale — billing must not
 *     become an SPOF for every default chat;
 *   - high-risk families (fan-out collectives, Phase 2 exposure) DENY in that
 *     same situation — a never-seen org running a 6× fan-out during an outage
 *     is an unpriced-cost hole ("no free first fan-out");
 *   - both classes decide on the STALE planId when one exists
 *     (`stale_allow`).
 *
 * ## Mode surface (design §6)
 *
 * `TARGET_POLICY_MODE` (default `shadow`): `off` never computes/enforces;
 * `shadow` computes + logs (`shadow_would_deny`) but always allows; `enforce`
 * returns real denials. The deploy sequence starts in shadow and flips to
 * enforce before the Phase 1 exit drill. Enforce + unconfigured billing
 * credentials is a BOOT REFUSAL (assertTargetPolicyBootConfiguration, wired in
 * config/index.ts::validateConfig) — a silent global allow/deny driven by a
 * config accident is structurally impossible in enforce mode.
 *
 * ## Gate order (design §2)
 *
 * Wired in chat-routes.ts AFTER `evaluateGovernance` and BEFORE
 * `gateChatRequest`/the wallet hold — a denied target must NEVER create a
 * hold. The decision consumes ONLY the server-resolved family (the client's
 * raw model string was stripped/re-stamped by normalizeChatRequest).
 */

import { logger } from '@/utils/logger';
import { recordTargetPolicyDecision } from '@/utils/metrics';
import { resolveTenantEntitlements } from '@/services/billing-entitlements-client';
import {
  resolveRequestStrategyFamily,
  targetPolicyModeFromEnv,
  type StrategyFamily,
  type TargetPolicyMode,
} from '@/services/strategy-family';

const log = logger.child({ component: 'strategy-target-policy' });

export type { StrategyFamily, TargetPolicyMode };

/**
 * Blast-radius classes (design §3). Low-risk = fan-out ≤ 1.5, short-horizon —
 * the Phase 1 exposure set. High-risk = the fan-out collectives (their
 * `fanoutFactor` in STRATEGY_POLICY is 2.5–6); they are exposed but the
 * asymmetry below is written NOW and arms when they start being sold.
 */
const LOW_RISK_FAMILIES: ReadonlySet<StrategyFamily> = new Set([
  'auto',
  'best',
  'fast',
  'economy',
  'single',
]);

export function isLowRiskFamily(family: StrategyFamily): boolean {
  return LOW_RISK_FAMILIES.has(family);
}

/**
 * Phase 1 scaffold: no per-plan entries — every plan gets DEFAULT. Phase 2
 * tightens by adding entries (config change, no redeploy of the gate).
 * Keyed by `planId` as billing's `/v1/plans/resolve` reports it; an unknown
 * planId falls through to `DEFAULT_ACCESS` (never an implicit deny — design
 * test #3).
 */
const PLAN_FAMILY_MATRIX: Record<string, Partial<Record<StrategyFamily, boolean>>> = {};

const DEFAULT_ACCESS: Record<StrategyFamily, boolean> = {
  auto: true,
  best: true,
  fast: true,
  economy: true,
  single: true, // Phase 1 intent presets: default-allow (design §9)
  parallel: true,
  consensus: true,
  'expert-panel': true, // tightened in Phase 2 with fan-out telemetry
  // media-planner: default-allow at the ACCESS layer, but it is deliberately
  // NOT in LOW_RISK_FAMILIES (high-risk class — one invocation fans out into
  // multiple billable generations) AND its runtime gate stays the
  // MEDIA_PLANNER_ENABLED / per-org canary flag inside the orchestration
  // engine, so a sold cell still executes nothing while that flag is off.
  'media-planner': true,
};

/**
 * Test hook (and Phase 2 rehearsal): installs a temporary PLAN_FAMILY_MATRIX
 * so the matrix-lookup paths (matrix_allow / matrix_deny) are reachable in
 * tests even though the shipped Phase 1 matrix is EMPTY. Production code
 * never calls this; the design's test matrix (§8 #1/#2) is the consumer.
 */
export function __setPlanFamilyMatrixForTests(
  matrix: Record<string, Partial<Record<StrategyFamily, boolean>>>
): void {
  for (const key of Object.keys(PLAN_FAMILY_MATRIX)) {
    delete PLAN_FAMILY_MATRIX[key];
  }
  for (const [planId, row] of Object.entries(matrix)) {
    PLAN_FAMILY_MATRIX[planId] = { ...row };
  }
}

/** Test hook: empties the matrix again (restores the shipped Phase 1 state). */
export function __resetPlanFamilyMatrixForTests(): void {
  __setPlanFamilyMatrixForTests({});
}

/** The decision for `(planId, family)` straight from the matrix + DEFAULT
 * fallback. `matchedMatrix=false` means the DEFAULT row decided. */
function matrixDecision(
  planId: string | null,
  family: StrategyFamily
): { allowed: boolean; matchedMatrix: boolean } {
  if (planId !== null) {
    const row: Partial<Record<StrategyFamily, boolean>> | undefined = PLAN_FAMILY_MATRIX[planId];
    if (row) {
      const entry = row[family];
      if (entry !== undefined) return { allowed: entry, matchedMatrix: true };
    }
  }
  return { allowed: DEFAULT_ACCESS[family], matchedMatrix: false };
}

/** Core decision shape (design §3) — `mode` and logging are layered on top. */
export interface TargetPolicyDecision {
  allowed: boolean;
  reason:
    | 'matrix_allow'
    | 'matrix_deny'
    | 'default_allow'
    | 'stale_allow'
    | 'unavailable_low_risk_default'
    | 'unavailable_deny'
    | 'shadow_would_deny';
  planId: string | null;
  basis: 'fresh' | 'stale' | 'unavailable';
}

/**
 * The availability + matrix decision for one (org, family), WITHOUT the mode
 * layer. Computes the entitlement basis (fresh/stale/unavailable), then:
 *   - unavailable → per-risk-class default (`unavailable_low_risk_default`
 *     allow / `unavailable_deny` deny), planId null;
 *   - fresh/stale → matrix lookup with the DEFAULT fallback; a stale-basis
 *     ALLOW is reported as `stale_allow` (design test #4). A stale DENY keeps
 *     its matrix reason: a deny is not softened by being stale.
 *
 * `source` is the billing entitlements' own `source` field
 * (`subscription` | `fallback_sandbox`), null when billing was unreachable —
 * threaded through for the decision log only.
 */
export async function decideTargetAccess(
  organizationId: string,
  family: StrategyFamily
): Promise<TargetPolicyDecision & { source: 'subscription' | 'fallback_sandbox' | null }> {
  const { entitlements, basis } = await resolveTenantEntitlements(organizationId);
  const planId = entitlements?.planId ?? null;
  const source = entitlements?.source ?? null;

  if (basis === 'unavailable') {
    return isLowRiskFamily(family)
      ? { allowed: true, reason: 'unavailable_low_risk_default', planId: null, basis, source }
      : { allowed: false, reason: 'unavailable_deny', planId: null, basis, source };
  }

  const { allowed, matchedMatrix } = matrixDecision(planId, family);
  if (!allowed) {
    return { allowed: false, reason: 'matrix_deny', planId, basis, source };
  }
  if (basis === 'stale') {
    return { allowed: true, reason: 'stale_allow', planId, basis, source };
  }
  return {
    allowed: true,
    reason: matchedMatrix ? 'matrix_allow' : 'default_allow',
    planId,
    basis,
    source,
  };
}

// ── Deny-rate observability (design §6: TARGET_POLICY_ALERT_DENY_RATE) ─────
// Wired to OPS-001: an in-process counter pair plus a threshold log here, and
// every decision mirrored as Prometheus series via utils/metrics
// (ailin_dev_target_policy_decisions_total / _shadow_would_deny_total — the
// scraped signal the named prod alert reads; runbook:
// api/docs/runbooks/strategy-catalog.md).

const counters = { evaluations: 0, denies: 0, shadowWouldDeny: 0 };
let lastAlertAtMs = 0;
const ALERT_MIN_INTERVAL_MS = 60_000;

function denyAlertThreshold(): number | null {
  const raw = process.env.TARGET_POLICY_ALERT_DENY_RATE;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : null;
}

/** Test-only: resets the in-process deny-rate counters. */
export function __resetTargetPolicyCountersForTests(): void {
  counters.evaluations = 0;
  counters.denies = 0;
  counters.shadowWouldDeny = 0;
  lastAlertAtMs = 0;
}

/** Test-only snapshot of the deny-rate counters. */
export function targetPolicyCountersForTests(): {
  evaluations: number;
  denies: number;
  shadowWouldDeny: number;
} {
  return { ...counters };
}

function maybeAlertDenyRate(mode: TargetPolicyMode): void {
  const threshold = denyAlertThreshold();
  if (threshold === null) return;
  if (counters.evaluations < 20) return; // warm-up: a rate over 3 requests is noise
  const rate = (counters.denies + counters.shadowWouldDeny) / counters.evaluations;
  if (rate < threshold) return;
  const now = Date.now();
  if (now - lastAlertAtMs < ALERT_MIN_INTERVAL_MS) return;
  lastAlertAtMs = now;
  log.error(
    { mode, denyRate: Number(rate.toFixed(3)), threshold, counters: { ...counters } },
    'target-policy deny-rate crossed TARGET_POLICY_ALERT_DENY_RATE — a policy or billing incident is likely (OPS-001 alert source)'
  );
}

/**
 * The full evaluate flow (design §3): entitlements → matrix → decision, with
 * the mode layer applied and every decision logged
 * `{orgId, family, planId, source, basis, decision, mode}`.
 *
 * `source` mirrors the entitlements client's own field (`subscription` /
 * `fallback_sandbox`) so a shadow-mode log line reads exactly like the billing
 * resolve it was computed from; `null` when billing was unreachable.
 */
export async function evaluateTargetPolicy(
  organizationId: string,
  family: StrategyFamily
): Promise<TargetPolicyDecision> {
  const mode = targetPolicyModeFromEnv();

  if (mode === 'off') {
    // Compute-free: mode off means the operator opted out entirely — no
    // billing round-trip, no log noise. The decision is a structural allow.
    return { allowed: true, reason: 'default_allow', planId: null, basis: 'unavailable' };
  }

  const { source, ...decision } = await decideTargetAccess(organizationId, family);
  counters.evaluations += 1;
  if (!decision.allowed) counters.denies += 1;

  log.info(
    {
      orgId: organizationId,
      family,
      planId: decision.planId,
      source,
      basis: decision.basis,
      decision: decision.allowed ? 'allow' : 'deny',
      mode,
    },
    'strategy target policy decision'
  );

  // OPS-001a: the same decision as a scraped Prometheus series (the named
  // alert reads this, not the logs). One increment per evaluation — a shadow
  // would-be deny is recorded as `shadow_would_deny`, never double-counted
  // as `deny`. `family_risk` is the design §3 blast-radius class.
  const familyRisk = isLowRiskFamily(family) ? ('low' as const) : ('high' as const);

  if (mode === 'shadow' && !decision.allowed) {
    // Design §6: in shadow a would-be deny is LOGGED and the request ALLOWED.
    counters.shadowWouldDeny += 1;
    recordTargetPolicyDecision({
      decision: 'shadow_would_deny',
      mode,
      basis: decision.basis,
      familyRisk,
    });
    log.warn(
      { orgId: organizationId, family, planId: decision.planId, basis: decision.basis, mode },
      'shadow_would_deny — target policy would deny this (org, family) in enforce mode; allowing (shadow mode)'
    );
    maybeAlertDenyRate(mode);
    return { ...decision, allowed: true, reason: 'shadow_would_deny' };
  }

  recordTargetPolicyDecision({
    decision: decision.allowed ? 'allow' : 'deny',
    mode,
    basis: decision.basis,
    familyRisk,
  });
  maybeAlertDenyRate(mode);
  return decision;
}

// ── Route-level gate ───────────────────────────────────────────────────────

/** The structured deny payload (design/Phase-1 contract): 403 with
 * `{code:"target_policy_denied", family, planId|null, reason}`. */
export function targetPolicyDenyBody(decision: TargetPolicyDecision, family: StrategyFamily): {
  code: 'target_policy_denied';
  family: StrategyFamily;
  planId: string | null;
  reason: TargetPolicyDecision['reason'];
  message: string;
} {
  return {
    code: 'target_policy_denied',
    family,
    planId: decision.planId,
    reason: decision.reason,
    message: `The '${family}' strategy is not available for this organization's plan (policy: ${decision.reason}).`,
  };
}

/**
 * What the chat route consumes. `applied: false` = the request is not a
 * composite `<family>:<tier>` target (legacy preset / raw id / `auto`) — the
 * gate structurally never fires for those (guardrail #3), and the route
 * proceeds exactly as before.
 */
export type TargetPolicyGateResult =
  | { applied: false; allowed: true }
  | { applied: true; allowed: true; family: StrategyFamily; decision: TargetPolicyDecision }
  | {
      applied: true;
      allowed: false;
      family: StrategyFamily;
      decision: TargetPolicyDecision;
      status: 403;
      body: ReturnType<typeof targetPolicyDenyBody>;
    };

/**
 * The single call site for the chat gate chain: derive the server-resolved
 * family, run the policy when one exists, shape the 403 otherwise. Fails
 * CLOSED on an unresolvable family name (a family string outside the enum can
 * only appear through resolver drift — it must never silently execute).
 */
export async function evaluateTargetPolicyGate(
  organizationId: string,
  req: {
    ailin_tier?: unknown;
    ailin_alias?: unknown;
    strategy?: unknown;
  }
): Promise<TargetPolicyGateResult> {
  const tierCarrierPresent = req.ailin_tier !== undefined && req.ailin_tier !== null;
  const family = resolveRequestStrategyFamily(req);
  if (!tierCarrierPresent || family === null) {
    return { applied: false, allowed: true };
  }
  const decision = await evaluateTargetPolicy(organizationId, family);
  if (decision.allowed) {
    return { applied: true, allowed: true, family, decision };
  }
  return {
    applied: true,
    allowed: false,
    family,
    decision,
    status: 403,
    body: targetPolicyDenyBody(decision, family),
  };
}
