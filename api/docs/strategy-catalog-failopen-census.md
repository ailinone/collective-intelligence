<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Strategy Catalog Phase 1 — Fail-Open Census

Scope: the fail-open sites the strategy-catalog Phase 1 layers sit on top of —
the chat gate chain (`evaluateTargetPolicyGate` → `gateChatRequest`) and the
catalog resolution paths (`/v1/models*`). Written per phase-1-plan.md item D5:
every point where the system chooses "allow / degrade" under a broken
dependency is inventoried with its disposition, so Phase 2 tightening decisions
(enforce-mode flips, matrix entries, wallet hard-gating) start from a complete
map instead of a grep.

Legend for disposition:

- **justified** — deliberate, documented, and correct for Phase 1; revisit only
  if the threat model changes.
- **Phase-2 target** — acceptable now (shadow mode / gated exposure), must be
  re-decided before the corresponding Phase 2 enforcement ships.
- **fixed in Phase 1** — was an undocumented silent fail-open; this phase
  changed it.

---

## 1. Wallet gate reserve — `prepaid-wallet-gate.ts` `gateChatRequest` catch (~:245-252)

**Behavior:** if the store's atomic `reserve` throws (Postgres down, timeout,
pool exhausted), the request is **allowed with no hold and no debit** —
`log.error(... 'wallet gate reserve failed — allowing (fail-open)')` plus the
`noteFailOpen('prepaid_wallet_reserve', ...)` counter.

**Disposition: justified for Phase 1; Phase-2 target before paid strategy
exposure widens.** The fail-open is bounded by construction: it only fires for
composite `<family>:<tier>` targets carrying the server-set tier carrier
(`resolveTier` miss ⇒ no-op anyway), i.e. exactly the strategies the catalog
sells. The failure mode is "unbilled generation", not "wrong charge" — the
money-correctness invariant (never double-charge, never charge without a hold
that settled) is unaffected. When Phase 2 turns the wallet gate from guardrail
into the primary billing path for higher fan-out families, this site must
become a *counted + alerted* fail-open with a per-org circuit breaker (it
already has the counter hook); a silent one is no longer enough.

## 2. Governance evaluation — `org-governance-service.ts` `evaluateGovernance` catch (:446-452)

**Behavior:** any error resolving governance config, evaluating policy, or
querying monthly spend ⇒ `return ALLOW` with a structured error log
("Governance evaluation failed — failing open (allow)"). Additionally the
no-config fast path (:430-432) returns ALLOW for every org without a
budget/policy row — that one is not a failure mode at all, just the default.

**Disposition: justified (deliberate, documented).** Governance denial is an
administrator-intent overlay; failing closed there would make an admin's
misconfiguration take down all chat for the org — strictly worse than a missed
policy denial. The A3 target-policy gate was deliberately wired AFTER this
call in the chat gate chain, inheriting the same philosophy but re-deriving it
per risk class (see §4) — governance staying fail-open does not weaken A3.

## 3. Billing entitlements — `billing-entitlements-client.ts` unconfigured/failed resolution

**Was:** every resolution failure path (Redis read error :129, billing HTTP
error :227/:251/:262/:273, and the **unconfigured-credentials early return**
:311) collapsed to `null` entitlements with no distinction between "billing
says no", "billing is down", and "billing was never wired up". The last case —
a deployment misconfiguration — was completely silent: the platform ran
"permanently failing open to local tier config" with zero log output.

**Disposition: fixed in Phase 1 (A3).** Three changes:

1. The unconfigured-credentials early return now emits
   `log.warn('billing entitlements resolve skipped: BILLING_SERVICE_URL/BILLING_API_SECRET_KEY not configured -- permanently failing open to local tier config')`
   — a config accident is observable on the first request.
2. New `resolveTenantEntitlements` returns an availability-aware
   `{entitlements, basis: 'fresh' | 'stale' | 'unavailable'}` instead of a bare
   null, so callers can *decide* per risk class instead of uniformly failing
   open. It also reads the new stale last-known-good key
   (`billing:entitlements:stale:<org>`, written alongside the primary cache
   with `BILLING_ENTITLEMENTS_STALE_TTL_SECONDS`, default 86400) so a billing
   outage during business hours decides on the last fresh answer.
3. The A3 policy (`strategy-target-policy.ts`) consumes that basis with the
   §4 asymmetry: low-risk families allow on `unavailable` (billing must not be
   an SPOF for default chat), high-risk fan-out families **deny**
   (`unavailable_deny` — no free first fan-out). Enforce mode with missing
   billing credentials is a **boot refusal** (`assertTargetPolicyBootConfiguration`
   via `config/index.ts::validateConfig`), making the worst silent fail-open
   structurally impossible in enforce mode.

Remaining known-open edge (accepted): the stale key is only as good as its
last successful write; a long-lived outage past the stale TTL degrades to the
risk-class defaults above. That is the documented design, not an oversight.

## 4. A3 target-policy itself — `strategy-target-policy.ts` unavailable-basis defaults

Listed for completeness because it is a fail-open *introduced* by this phase:
on billing `unavailable` with no stale snapshot, low-risk families
(auto/best/fast/economy/single) allow with reason
`unavailable_low_risk_default`, planId null. **Justified** — it is the explicit
§4/§8 design table (test #5/#6), every decision is logged with its basis, and
the deny-rate counters (`TARGET_POLICY_ALERT_DENY_RATE`) alert when the
fail-open rate itself becomes the incident. Shadow mode additionally never
denies for any reason (`shadow_would_deny`), by design.

## 5. Explicit-model existence guard — `explicit-model-guard.ts` `checkExplicitModelExists` catch (:105)

**Behavior:** if the model-existence lookup fails, the request is admitted
with the pinned model ("Explicit-model existence check failed; admitting the
request (fail-open)") — the guard only *rejects* provably-unknown ids, never
blocks on an outage.

**Disposition: justified (deliberate per the module's own doc).** The guard's
purpose is catching typos/phantom ids at the API boundary, not being an
availability gate. Interaction with the strategy catalog is nil: composite
`<family>:<tier>` targets resolve server-side via
`ailin-virtual-model-service` before this guard matters, and the catalog
descriptor route (`/v1/models/strategies`) never consults it. No Phase 2
action required; re-examine only if pinned-model routing ever becomes
billable per-target.

---

### Summary

| # | Site | Old behavior | Disposition |
|---|------|--------------|-------------|
| 1 | `gateChatRequest` reserve catch | fail-open, logged + counted | justified; Phase-2 target (alerting/circuit breaker) |
| 2 | `evaluateGovernance` catch | fail-open, logged | justified |
| 3 | `billing-entitlements-client` nulls (incl. silent unconfigured path) | uniform silent fail-open | **fixed in Phase 1** (warn log, basis-aware resolution, stale key, boot refusal) |
| 4 | A3 unavailable-basis default | n/a (new) | justified (design §4 table + telemetry) |
| 5 | explicit-model guard catch | fail-open, logged | justified |

No other fail-open path was touched by Phase 1; the composite dispatch shares
the exact pipeline fail-open posture of the legacy `ailin-*` preset dispatch
(see `strategy-media-pipeline-characterization.test.ts` for the pinned
equivalence).
