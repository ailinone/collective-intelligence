<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Strategy Catalog & Target Policy — Runbook (ENT-001 Phase 1 / OPS-001)

Scope: the versioned collective-strategy catalog (`GET /v1/models/strategies`,
`GET /v1/models/:id` for `<family>:<tier>` composites) and the A3 per-target
deny matrix that gates composite targets in the chat gate chain.

**What it is, in one paragraph:** the catalog publishes every executionReady
`<strategy>:<tier>` pricing cell as a versioned descriptor (`catalogVersion:
"v1"`) that chat's BFF consumes and fails closed on; the target policy
(`strategy-target-policy.ts`) is the decision point keyed `(organizationId,
family)` that consults the org's billing planId and allows/denies the target —
Phase 1 ships an EMPTY matrix (default-allow + telemetry; restricting a family
is a Phase 2 config entry, no redeploy). Design + test matrix:
`docs/plans/2026-10-01-model-catalog-enterprise-delivery/` (a3-deny-matrix-design.md,
phase-1-plan.md) in the chat repo; fail-open inventory:
`api/docs/strategy-catalog-failopen-census.md`.

## Quick Reference

| Component | Health Check | Key Metric | Alert Threshold |
|-----------|-------------|------------|-----------------|
| Catalog endpoint | `GET /v1/models/strategies` → 200, `catalogVersion:"v1"` | `ailin_dev_http_request_duration_seconds{route="/v1/models/strategies"}` | p95 > 5s for 5min |
| Target policy (A3) | decision log lines "strategy target policy decision" | `ailin_dev_target_policy_decisions_total` | decisions stop incrementing for 10min while tiered traffic flows |
| Shadow would-deny | warn logs "shadow_would_deny" | `ailin_dev_target_policy_shadow_would_deny_total` | see alert spec below |
| Deny rate (in-process) | error log "deny-rate crossed TARGET_POLICY_ALERT_DENY_RATE" | same counters | in-process alert when `(denies + shadow_would_deny) / evaluations` > `TARGET_POLICY_ALERT_DENY_RATE` (after 20 evaluations, ≥60s between firings) |
| Post-deploy smoke | `scripts/smoke-strategy-catalog.mjs` (exit 0) | — | any non-zero exit |

## Flag Surface

| Flag | Default | Effect |
|------|---------|--------|
| `TARGET_POLICY_MODE` | `shadow` | `off`: gate never computes (structural allow, no billing call, NO metrics). `shadow`: computes + logs + counts, ALWAYS allows — a would-be deny is logged as `shadow_would_deny`. `enforce`: real 403s (`target_policy_denied`). Unrecognized values fall back to `shadow`. |
| `CHAT_SERVICE_MODELS_KEY` | unset (guard inert) | The dedicated chat M2M identity value. Set ⇒ the chat credential is refused bulk catalog exports (`?all=true`/`?scope=all` → 403 `catalog_bulk_forbidden`) on the model list routes. Unset ⇒ the chat identity does not exist and the ban never fires. |
| `BILLING_ENTITLEMENTS_STALE_TTL_SECONDS` | `86400` (24h) | How long a stale entitlement snapshot remains a valid decision basis during a billing outage (`stale_allow`). Beyond it, decisions land on the `unavailable_*` failure path. |

## Deploy Sequence: shadow → enforce

Phase 1 deploys with `TARGET_POLICY_MODE=shadow` (or unset — same thing).
Enforce is a separate, deliberate flip gated on the 4-step checklist
(owner decision 2026-10-03):

1. **Billing creds verified in prod** — `BILLING_SERVICE_URL` +
   `BILLING_API_SECRET_KEY` set and a real entitlements resolve observed
   (decision logs carry `basis:"fresh"` and a real `planId`, not
   `basis:"unavailable"`). Note: `enforce` with missing credentials is a BOOT
   REFUSAL (`assertTargetPolicyBootConfiguration`) — the process will not
   start, by design.
2. **Accumulated `shadow_would_deny` analysis** — review
   `ailin_dev_target_policy_shadow_would_deny_total` (and the warn logs) over a
   representative window; every would-deny must be explainable (expected deny
   per the matrix, or a Phase 2 matrix-entry candidate). Unexplained spikes =
   do not flip.
3. **OPS-001 telemetry WITH alert in place** — the decision series scraped and
   the deny-rate alert below wired on the SRE side. Flipping enforce without
   the alert means an over-aggressive matrix is invisible until users report it.
4. **Flip + monitor 24–48h** — set `TARGET_POLICY_MODE=enforce`, restart, and
   watch `ailin_dev_target_policy_decisions_total{decision="deny"}` and the 403
   rate on tiered chat traffic for 24–48h before declaring the flip done.

## Rollback

| Situation | Action | In-flight behavior |
|-----------|--------|--------------------|
| Enforce denies too much | `TARGET_POLICY_MODE=shadow`, restart | In-flight requests that already passed the gate complete; new would-deny requests are allowed and logged as `shadow_would_deny` |
| Telemetry/logging noise or billing outage makes shadow itself undesirable | `TARGET_POLICY_MODE=off`, restart | Gate never fires; composite targets pass through exactly as pre-catalog (billing call is skipped) |
| Chat hammering bulk exports | Unset `CHAT_SERVICE_MODELS_KEY` (disables the identity) — or fix chat's proxy; prefer the latter | The ban is per-request; nothing in flight is affected |
| Bad descriptor shipped | Bump `catalogVersion` (consumers fail closed on unknown versions) and roll back the deploy | Chat BFF rejects the unknown version — catalog silently absent, no mispriced dispatch |

Rollback of the mode flags is config-only; no migration, no data cleanup.

## Failure Modes (A3 design §4 — billing outage behaviors per risk class)

Decision basis comes from `resolveTenantEntitlements`
(`billing-entitlements-client.ts`):

| Basis | Low-risk family (`auto, best, fast, economy, single`) | High-risk family (`parallel, consensus, expert-panel`) |
|-------|--------------------------------------------------------|--------------------------------------------------------|
| `fresh` (billing answered) | matrix lookup, DEFAULT row = allow (`default_allow` / `matrix_allow`) | same |
| `stale` (snapshot within TTL) | decide on the stale planId (`stale_allow`) | same — a stale DENY keeps `matrix_deny` (a deny is never softened by staleness) |
| `unavailable` (outage, no/expired snapshot) | ALLOW (`unavailable_low_risk_default`) — billing must not be an SPOF for default chat | DENY (`unavailable_deny`) — "no free first fan-out"; an unpriced 6× fan-out during an outage is a cost hole |

In shadow mode, every deny in the table is converted to
`shadow_would_deny` + allow; the conversion is visible in the metrics.

## Metrics & Alerts

Series (exported on `GET /metrics`, Prometheus text format):

- `ailin_dev_target_policy_decisions_total{decision, mode, basis, family_risk}`
  — one increment per gated decision. `decision` ∈ `allow | deny |
  shadow_would_deny` (a shadow would-be deny is never counted as `deny`);
  `mode` ∈ `off | shadow | enforce` (mode `off` emits nothing); `basis` ∈
  `fresh | stale | unavailable`; `family_risk` ∈ `low | high`.
- `ailin_dev_target_policy_shadow_would_deny_total` — the dedicated alert
  series (same events as `decision="shadow_would_deny"`, no labels).

### Alert THRESHOLD SPEC (for the SRE — wire in the Prometheus/Alertmanager rules repo; ci has no in-repo alert config)

| Field | Value |
|-------|-------|
| Alert name | `StrategyTargetPolicyShadowWouldDenySpike` |
| Metric | `ailin_dev_target_policy_shadow_would_deny_total` |
| Condition | `increase(...[1h]) > 5` AND (secondary signal, same window) `increase(ailin_dev_target_policy_decisions_total{basis="unavailable"}[1h]) / clamp_min(increase(ailin_dev_target_policy_decisions_total[1h]), 1) > 0.1` |
| Rationale | Legitimate Phase 1 traffic has an EMPTY matrix, so `shadow_would_deny` must be ~0; sustained rate means a billing outage is pushing orgs onto the `unavailable_*` path (low-risk families allowed, high-risk absorbed denials) or the matrix drifted |
| Severity | `warning` in shadow (no customer impact — requests are allowed); `critical` if the mode is `enforce` (check `ailin_dev_target_policy_decisions_total{mode="enforce",decision="deny"}` increasing — customers are being 403'd) |
| Runbook | this file — start at "Failure Modes" above; check billing health, then roll the mode back per "Rollback" |

Complementary (enforce flip monitoring): alert on
`increase(ailin_dev_target_policy_decisions_total{mode="enforce",decision="deny"}[1h]) > 5`
— that is the customer-impacting signal after step 4 of the deploy sequence.

## Synthetic Smoke (post-deploy)

```bash
# from api/
node scripts/smoke-strategy-catalog.mjs https://api.<env>.ailin.one
# full round-trip incl. the chat-identity bulk refusal:
CHAT_SERVICE_MODELS_KEY=<key> node scripts/smoke-strategy-catalog.mjs https://api.<env>.ailin.one
```

Asserts: `/health` 200; `/v1/models/strategies` 200 with `catalogVersion` and
≥1 selectable descriptor carrying every required contract field;
`/v1/models/best:medium` resolves with the merged descriptor; and — only when
`CHAT_SERVICE_MODELS_KEY` is provided — the chat identity's `?all=true` is
refused with 403 `catalog_bulk_forbidden`. Exits non-zero on any failure; wire
into the deploy pipeline after each strategy-catalog deploy.
