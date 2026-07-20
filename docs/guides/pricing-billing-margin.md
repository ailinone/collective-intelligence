<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Pricing, Billing, and Margin

`ci/api` separates **what a provider costs us (COGS)** from **what the customer is billed**.
There are two billing modes, picked by the model id the request asks for:

| Mode | Triggered by | Billed on | Margin source |
| --- | --- | --- | --- |
| **Passthrough** | a specific upstream model id (e.g. `openai/gpt-5.5`) | the real provider cost × markup | the markup multiplier |
| **Collective tier** | a CI product id `<strategy>:<tier>` (e.g. `consensus:large`) | the **user's own tokens** at the published tier rate | the band-aware margin guard |

The thesis — *custo ≤ top-tier com entrega igual ou superior* — is expressible **per token** in the
collective-tier mode: the price is metered on the user's prompt + the final synthesised answer, **never**
on the internal fan-out. So a `consensus:large` request that fans out to five models still bills the
`large` per-token rate, and the COGS guard keeps the fan-out within margin.

---

## 1. Two orthogonal axes: `<strategy>:<tier>`

A collective product id composes two independent choices (`api/src/services/pricing-tiers.ts`):

- **TIER** — *how much* (budget / quality target / price). Neutral size labels: `tiny · small · base ·
  medium · large · extra`. The tier sets the published per-token rate and the quality floor.
- **STRATEGY** — *how* (the collective mechanism). `auto · best · fast · economy · single · parallel ·
  consensus · expert-panel · …`. The strategy *spends* the tier's COGS budget; it does **not** change the
  price. So `consensus:large` and `expert-panel:large` both bill the `large` rate.

Each strategy has a valid tier range (a heavy mechanism needs budget); an out-of-range request is
**clamped** (`war-room:tiny` → `war-room:large`). Shadow-wired strategies (`debate`, `war-room`, …) are
recognised but **not** offered until they ship a distinct execution.

`resolveAilinVirtualModelAlias('consensus:large')` returns the execution strategy + quality target + the
tier rate. The legacy `ailin-*` preset aliases keep their exact prior behaviour — the composite scheme
only activates on a `:tier` suffix or a non-preset strategy name.

---

## 2. The tier rate card

Rates are USD per **1M user tokens**, integers, rounded up. Output carries the differentiation,
mirroring the *“80% cliff”* — above ~80% quality, single top-tier models jump 12–25× in price, which is
exactly where the collective's ensemble wins.

| Tier | Quality target | Margin floor | Pricing band |
| --- | --- | --- | --- |
| `tiny` | 0.65 | 30% | passthrough (resell cheap leaders) |
| `small` | 0.70 | 35% | passthrough |
| `base` | 0.75 | 40% | passthrough |
| `medium` | 0.80 | 50% | passthrough |
| `large` | 0.88 | 55% | collective (undercut the frontier) |
| `extra` | 0.94 | 55% | collective |

The **rates themselves are not hand-set** — they are derived from the live benchmark frontier (next
section). The hand-set values in `TIERS` are only the static fallback (`STATIC_RATE_CARD`).

---

## 3. Benchmark-driven calibration (the anchor self-corrects)

`api/src/services/pricing-calibrator.ts` derives the rate card from CI's own measured `(quality, cost)`
signal, so prices **track the market** instead of being guessed.

**Inputs.** CI already measures quality per model — fetched (Artificial Analysis, BenchLM, LMArena),
run internally (`pnpm c3:v4`), and observed live (the LLM-judge on `RequestLog.qualityScore`) — merged
into `ModelQualityCalibrationSnapshot`. `pricing-snapshot-loader.ts` joins that quality with the catalog
cost (`Model.inputCostPer1k`/`outputCostPer1k` × 1000) into benchmark points.

**Derivation.** For each tier:

1. Compute the cost↔quality **Pareto frontier** (`core/pareto/cost-quality-frontier.ts`).
2. **Anchor** on the cheapest frontier single that meets the tier's quality target.
3. Decide the **band** from the anchor's price, and set the rate + margin accordingly:
   - **passthrough** (cheap leader, output ≤ `$6/1M`): **dynamic markup** — take up to `targetMarkupPct`
     (the 100% goal → 2× COGS, a 50% margin), but never price above the **next-cheapest qualifying
     single** (the competitive cap), and never below `floorMarkupPct`. So the full 100% is realised
     wherever the spread to the next option allows it (e.g. right at the quality “cliff”), and the price
     stays market-competitive everywhere else. The margin is then **measured** from the published integer
     rate vs the provider (anchor) cost — not assumed.
   - **collective** (expensive frontier): rate = anchor × (1 − discount). The ensemble hits the same
     quality for a COGS far below the frontier single, so the price lands **below top-tier** and the
     margin stays fat.

The knobs (`passthroughOutputThresholdPer1MUsd`, `targetMarkupPct`, `floorMarkupPct`,
`competitiveUndercutPct`, `collectiveDiscountPct`) **are** the pricing strategy and are owned by the
operator in `DEFAULT_CALIBRATOR_POLICY` (default: threshold `$6`, target markup `100%`, floor `20%`,
undercut `5%`, collective discount `20%`).

> **Worked example** (operator leaderboard + Grok 4.3 @ $1.25/$2.50; target markup 100%, undercut 5%,
> collective discount 20%):
>
> | Tier | Anchor | Band | Rate (in/out per 1M) | Measured margin |
> | --- | --- | --- | --- | --- |
> | `tiny`/`small` | DeepSeek V3.2 | passthrough | `$1 / $2` | 54% |
> | `base` | MiniMax M2.5 | passthrough | `$1 / $2` | 50% |
> | `medium` | DeepSeek-V4 | passthrough | `$1 / $3` | 38% |
> | `large` | Opus 4.8 ($5/$25) | collective | `$4 / $20` | 55% |
> | `extra` | Fable 5 ($10/$50) | collective | `$8 / $40` | 55% |
>
> `medium` lands at **$1 / $3** — cheaper input than Grok 4.3 and at output parity, *with* routing,
> reliability, and fallback. On this dense leaderboard the cheap tiers' competitive cap binds, so the
> dynamic markup yields a **measured 38–54%** margin (not the full 100%) while staying below the next
> qualifying single; where a wide gap opens to the next option (the quality “cliff”), the same logic
> takes the full 100% markup automatically. The collective tiers undercut $25/$50 top-tier singles to
> $20/$40 at a 55% margin. When a cheaper-but-strong model enters the leaderboard, it joins the frontier
> and the affected tiers **re-anchor down automatically** — the calibrator is self-correcting.

---

## 4. Billing on user tokens + the COGS guard

After execution, a tiered request is charged on the user's real tokens (`pricing-tiers.ts`):

- `tierBilledCostUsd(tier, promptTokens, completionTokens, rateCard)` → the **debit** (the price).
- `cogsBudgetUsd(tier, …)` / `cogsBudgetForAnchor(anchor, …)` → the **spend cap** fed to the
  credit-governor (`core/budget/credit-governor.ts`). The collective may spend up to this on the fan-out;
  if it can't hit the quality target within it, the strategy **degrades** (fewer models) rather than
  eating the margin.
- `quoteTierCharge(...)` returns both in one call.

The COGS margin is **band-aware**: a passthrough tier can't carry a 55% margin (its COGS *is* the cheap
provider), so its guard ≈ the provider price; only collective tiers carry the fat margin.

---

## 5. Prepaid wallet

`api/src/services/prepaid-wallet.ts` adds a prepaid credit balance:

1. **HOLD** — `estimateMaxChargeUsd(...)` prices the worst case (prompt + `max_tokens` at the tier rate);
   `evaluateSpendGate(...)` rejects with **402** if the balance can't cover it.
2. **RUN** — the COGS guard keeps the fan-out within margin.
3. **DEBIT** — the actual charge (real tokens) is debited; it is always ≤ the hold.

Top-ups credit the balance; every movement appends to a `credit_transaction` ledger. The durable store
(`prepaid-wallet-prisma-store.ts`) uses atomic upsert-with-increment so concurrent debits/top-ups can't
race. The domain logic is storage-agnostic (`BalanceStore` port; `InMemoryBalanceStore` for tests).

---

## 6. Passthrough billing profile (specific models)

For a specific upstream model, billing is driven by the alias profile (`ailin_billing`):

- `inputMarkupMultiplier` / `outputMarkupMultiplier`
- `minInputCostPer1kUsd` / `minOutputCostPer1kUsd`
- `flatFeeUsd`, `minimumChargeUsd`, `maximumChargeUsd`

Charging order: split base cost by prompt/completion share → apply markups → enforce per-1k floors → add
flat fee → clamp to min/max. Usage metadata carries `provider_cost_usd`, `billed_cost_usd`,
`total_cost_usd`.

---

## 7. Rollout (operator-gated)

- **Pricing engine, resolver, /v1/models surfacing, calibrator, loader** — code-complete, type-checked,
  unit-tested. The calibrated rate card flows through every call site (default = `STATIC_RATE_CARD`).
- **Prepaid wallet tables** — ship in `prisma/migrations/20260619000000_prepaid_wallet/`. Apply with
  `prisma migrate deploy` (creates `organization_balance` + `credit_transaction`); then regenerate the
  client. The wallet is **not** wired into the request path until the migration is applied.
- **Top-up funding** (Stripe/credit producer) is the remaining operator infrastructure step.

## Governance recommendations

- keep provider cost and billed cost both logged; add periodic margin reports by tier, strategy, tenant.
- re-run the calibrator whenever the quality snapshot refreshes, so anchors track the market.
- maintain guardrails for extreme bills (`maximumChargeUsd`, the spend gate).
