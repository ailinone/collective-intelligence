<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# C3 v4 Benchmark — Operator Runbook

**Purpose:** run the confirmation benchmark that the audit identified as the
single remaining blocker to a defensible "collective beats single, cheaper"
claim. Everything below is wired to existing code — no new infrastructure is
required, only credits and an execution window.

**Owner decision required before starting:** provider credits (~$100–200) and
a ~50–70h run window. There are no remaining engineering blockers.

---

## 0. What v4 fixes relative to v3

The v3 run (experiment `5cf023a1`) was **inconclusive** — not because the
thesis is wrong, but because the run was broken: 84.5% of the frozen phase
failed on credit exhaustion, the judge floated (`model: 'auto'`), and cost
accounting under-counted both arms. v4 closes each of those, and all the
machinery is already in the tree:

| v3 failure | v4 fix | Where |
|---|---|---|
| 84.5% frozen error (credit exhaustion) | guaranteed credits + budget guard + provider-error exclusion from quality stats | this runbook §1; `experiment-report.ts:83` |
| floating judge (`auto`) | pinned + calibrated judge (inter-rater gate) | §2; `EXPERIMENT_JUDGE_MODEL`, `pnpm calibrate:judge` |
| cost under-counting (both arms) | synthesizer+triage+judge folded into `totalCost`; missing prices normalized | already merged (TIER-0 cost integrity) |
| no go/no-go discipline | formal GO/NO-GO engine with pre-set thresholds | §4; `go-no-go-engine.ts`, `DEFAULT_THRESHOLDS` |
| learning churned during measurement | `freezeLearningDuringEval: true` | config default |

---

## 1. Pre-flight (credits + environment)

**Top up provider credits first.** v3's dominant failure was 402/insufficient-
credit. Fund the providers the arms will route through (EdenAI, AIML,
OpenRouter, xAI, plus the native Tier-1 hubs). The driver's budget guard
pauses at +5% over `MAX_BUDGET_USD`, but it cannot create credit.

Export on the **API process** (so the judge and arms resolve) and in the shell
that runs the driver:

```bash
# Pinned, stable, JSON-mode-capable judge — NOT 'auto'. Use a model that is
# NOT one of the competitor arms (avoid judge↔contestant family overlap).
export EXPERIMENT_JUDGE_MODEL="openai/gpt-4o-2024-11-20"   # example

# Driver auth/target — the driver only ever calls /v1/admin/experiment/* and
# /v1/admin/operability/*, which are not part of the public contract (2026-07-14).
# Use the internal service DNS name (or localhost:3000 on the host) — never
# the public hostname.
export API_BASE="http://ci-api:3000"
export ADMIN_TOKEN="<admin-or-owner-bearer>"

# Protocol knobs (defaults shown)
export CONFIG_KEY="c3-main-comparison"
export REPETITIONS=3
export MAX_BUDGET_USD=200
export JUDGE_CALIBRATION_RUNS=20
export JUDGE_MAX_STDDEV=0.1
```

A template lives at `api/.env.c3-v4.example`.

### 1.1 Re-validate providers after topping up (recommended)

Provider status in `docs/provider-runtime-matrix.csv` is a stale snapshot. After
recharging keys, run a **live** re-probe to confirm which providers are actually
green before spending benchmark budget on dead arms:

```bash
pnpm providers:revalidate     # needs API_BASE + ADMIN_TOKEN (same as the driver)
```

It forces a fresh discovery probe (`/v1/admin/operability/discover-now`), reads
the per-provider result, diffs against the snapshot, and writes
`reports/provider-revalidation-<ts>.md` listing **red→green** flips and what is
**still red** (key/saldo/infra pending). Green here is measured — `/models`
actually returned ≥1 model under the current keys. Re-run after each top-up wave.

---

## 2. Judge calibration gate (mandatory)

A noisy judge makes every downstream number unpublishable. The driver runs
this automatically and **aborts** if the judge fails; to run it standalone:

```bash
pnpm calibrate:judge 20      # 20 scorings per fixed case
```

Pass criterion: `maxStdDev ≤ 0.1` (`reliable: true`). If it fails, pick a more
deterministic judge or lower its temperature — do not proceed.

---

## 3. Run

One command drives the whole protocol (calibrate → create → run → poll →
GO/NO-GO), against the deployed API:

```bash
pnpm c3:v4
```

It will:
1. refuse to start if an experiment is already `running`;
2. gate on judge calibration;
3. create `c3-main-comparison` (the canonical arm matrix — see §3.1) with your
   `REPETITIONS`/`MAX_BUDGET_USD`;
4. start it and poll `/status`, printing `completed/total` and running cost;
5. pause if spend exceeds budget +5%;
6. on completion, fetch the GO/NO-GO report and write it to
   `reports/experiments/c3-v4-go-no-go-<id>.json`.

Resume after a pause/restart by re-running with the same env (the engine
resumes the active experiment).

### 3.1 Arm matrix (`buildC3MainComparison`)

Generated dynamically from the registry, no hardcoded subset:

- **Tier-1 singles** — each top-tier model individually (quality target 0.95)
- **Own singles** — each `own/*` model alone (only if `OWN_MODEL_ENABLED=true`)
- **Collective** — every registered collective strategy (quality target 1.0)
- **Mixed Collective (the core thesis arm)** — forced pool of
  `[own + 2 cheapest budget]` under `consensus` and `sensitivity-consensus`;
  this is the direct **H-B** test (cheap models cooperating vs top-tier alone).
  Present only when an own model is served.
- **Budget singles** — cheapest model per provider (quality target 0.30)
- **Adaptive** — bandit-routed arm, measured **on** (weights frozen, routing live)

Phases per arm: `sanity-check → warmup (10) → frozen → confirmation`. Only
frozen+confirmation feed the verdict; provider errors (402/403/404/429) are
excluded from quality stats and reported separately as success-rate.

### 3.2 Ablations (after the main run)

To attribute the orchestration gain to components, run the ablation configs
(each toggles one mechanism off):

```bash
CONFIG_KEY=c3-ablation-debate    pnpm c3:v4
CONFIG_KEY=c3-ablation-consensus pnpm c3:v4
```

---

## 4. GO / NO-GO criteria

Decided by `generateGoNoGoReport` using `DEFAULT_THRESHOLDS`
(`experiment-types.ts:634`). A collective approach earns **GO** only if, per
usage profile:

| Threshold | Value | Meaning |
|---|---|---|
| `minQualityGainForCollective` | **+0.07** | quality must beat the Tier-1 baseline by ≥7pp |
| `maxCostMultiplierForCollective` | **1.5×** | all-in cost ≤ 1.5× the single baseline |
| `maxLatencyMultiplierForCollective` | **2.0×** | latency ≤ 2× the single baseline |
| `qualityFloor` | **0.75** | absolute quality floor |
| `successRateFloor` | **0.95** | must complete reliably |
| `consistencyFloor` | **0.70** | low variance across tasks |
| `minSamplesHighConfidence` | **50** | n per cell for HIGH confidence |
| `minSamplesModerateConfidence` | **20** | n per cell for MODERATE; below → INCONCLUSIVE |

Verdicts: `GO | CONDITIONAL-GO | NO-GO | INCONCLUSIVE`. The headline
`conclusions.collectiveVsTier1` reports the verdict, qualityDelta, costMultiplier
and confidence.

**This is honest by construction:** if the data doesn't clear the bars, the
engine says NO-GO/INCONCLUSIVE. A NO-GO is a valid, publishable result — it
tells you collective routing isn't justified on the tested profile, which is
exactly what the audit asked the experiment to settle.

### Hypotheses the run adjudicates

- **H-A (quality ceiling):** consensus/debate > best single in
  factual-QA/debugging/reasoning (expect large effect, smaller n needed).
- **H-B (cost-quality frontier — the strongest thesis):** Mixed Collective
  (own + 2 budget) ≥ Tier-1 quality at ≤50% cost. Backed by the v3 signal
  that orchestration over budget models gave **+77%, d=0.919**.
- **H-C (conditional routing):** adaptive arm > all-single and > all-CI on
  quality-adjusted cost.

---

## 5. Acceptance criteria (publishability)

The run is publishable when:

1. frozen error rate **< 10%** (vs v3's 84.5%);
2. **n ≥ 50** per major arm (HIGH-confidence threshold);
3. judge calibration recorded `reliable: true`;
4. ≤ 5% zero-cost executions (cost accounting intact);
5. GO/NO-GO report produced with Welch p-values + Cohen's d per arm;
6. at least **H-A or H-B** reaches a HIGH/MODERATE-confidence verdict.

Raw outputs and the GO/NO-GO JSON land in `reports/experiments/`.

---

## 6. Stopping / no-go rules during the run

- **Budget:** auto-pause at spend > `MAX_BUDGET_USD × 1.05` (driver).
- **Zombie guard:** experiments stuck `running` > 6h are auto-failed by the
  create path before a new run starts.
- **Manual abort:** `POST /v1/admin/experiment/pause`; resume by re-running
  `pnpm c3:v4` with the same env.
- **Judge drift:** if calibration fails, the run never starts.

---

## 7. After the run

1. Read `reports/experiments/c3-v4-go-no-go-<id>.json`.
2. Cross-check `conclusions.collectiveVsTier1` and `adaptiveValue`.
3. Update `docs/architecture/collective-intelligence.md` and
   `docs/ARTICLE-CI-BENCHMARK.md` with the **v4** numbers (replacing the v3
   caveated figures) — keep the honesty contract: report verdict, n, p, and
   confidence, never a bare headline.
4. If H-B is GO, the proprietary-model story (own + budget collective) becomes
   the lead — and the model-stack P4 work (own specialists) gets its first
   data-backed justification.
