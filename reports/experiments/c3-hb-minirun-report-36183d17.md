<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# C3 H-B Mixed Mini-Run — Report (experiment `36183d17-6307-4435-a900-e350b238cbb1`)

**Date:** 2026-07-06 · **Config:** `c3-hb-mixed-minirun` · **Judge:** pinned
`EXPERIMENT_JUDGE_MODEL=deepseek-v4-pro` (serving id `deepseek-ai/DeepSeek-V4-Flash`,
proof call logged before create) · **State:** completed 03:25Z ·
**283/456 executions, $25.12 recorded spend, 454 skips (all accounted).**

## 1. What this run was supposed to test (pre-registered H-B)

H-B: *a mixed collective of an own/self-hosted model plus cheap external
models matches or beats a strong external single at lower cost.* Arms:

| arm | intent |
|---|---|
| `single:qwen3:8b` | own model (Ollama on the VPS), solo |
| `single:llama3.2:3b` | own model (Ollama on the VPS), solo |
| `single:openrouter/auto` | cheapest external single (baseline) |
| `collective-tier1:consensus` | Mixed forced pool **[qwen3:8b + openrouter/auto + alibaba/qwen3.7-plus]** |
| `collective-tier1:sensitivity-consensus` | same forced pool, sensitivity variant |
| `collective:consensus` | dynamic consensus (router-chosen pool, baseline) |

38 tasks (stratified 28 ∪ verifiable 10), 2 reps, $20 cap, 2 warmups.

## 2. HEADLINE: H-B was NOT exercised on the wire

**Routing-fidelity audit: 0 of 283 executions were served by the local
Ollama models.** `models_used` for the own arms shows external
equivalence-matched substitutes:

- `single:qwen3:8b` (n=39): `Qwen/Qwen2.5-Coder-32B-Instruct` ×10,
  `Qwen/Qwen3-8B` (serverless) ×6, `meta-llama/Llama-3.3-70B-Instruct` ×6,
  `Qwen/Qwen3-Coder-30B-A3B-Instruct` ×5, `deepseek-ai/DeepSeek-V4-Flash` ×4, …
- `single:llama3.2:3b` (n=15): `Qwen/Qwen3-8B` ×6, `DeepSeek-V4-Flash` ×4, …
- Mixed forced pools: voters served by `qwen-coder-plus`, `qwen-plus-*`
  (Alibaba), `deepseek/deepseek-v4-flash`, `deepseek-r1-0528:free` — no
  ollama ids anywhere (regex + literal sweep over all phases: 0 hits).

**Mechanism (working hypothesis, consistent with code read):** the chat
path resolves the requested model id through the model-equivalence index
(`model-catalog-service.getAllEntriesForModel` → equivalence groups built
after discovery), which maps `qwen3:8b` to same-family entries on external
providers; provider selection then steers to healthy/fast serverless
providers. The single-arm silent-fallback defect (filed in round 1) is the
same class; H-B makes it fatal because the hypothesis's key ingredient is
*which infrastructure serves the tokens*.

**Consequence:** H-B remains **NOT INSTANTIATED**. This run is reclassified
as a *budget-pool mini-run served entirely by cheap external models* and is
adjudicated as such below (it still replicates the campaign's quality
mechanism — third independent run).

What DID land (infrastructure, all verified):

1. Ollama service on the swarm (`ci_ollama`, volume-backed), `qwen3:8b` +
   `llama3.2:3b` pulled (run 28760661958 logs).
2. Discovery fix (PR #68): `OLLAMA_URL` `/v1`-suffix normalization — ollama
   models materialize in the DB and resolve into configs (create response
   named both own models).
3. Resolver + config + workflow gates + tests (PR #67).

## 3. Objective checker — verifiable tasks 116–125 (as-served arms)

Judge-free scoring over answer tails (same SPECS as
`c3-campaign-objective-ha-final.py`; DEGRADED and self-review-contaminated
rows classified separately, rate excludes DEGRADED):

| arm (as served) | PASS | FAIL | DEGRADED | CONTAM. | rate |
|---|---|---|---|---|---|
| dynamic consensus | **11** | 0 | 0 | 0 | **100%** |
| Mixed forced-pool consensus | **10** | 1 (t121) | 0 | 0 | **91%** |
| single qwen3:8b (as-served external) | 7 | 0 | 1 | 3 | 70% |
| Mixed sensitivity-consensus | 6 | 4 (t118/120/121/124) | 0 | 0 | 60% |
| single openrouter/auto | 6 | 1 (t123) | 1 | 3 | 60% |
| single llama3.2:3b (as-served) | 1 | 0 | 0 | 0 | n=1 only |

**The campaign's core quality finding replicates a third time**: consensus
collectives 91–100% vs singles 60–70% on machine-verifiable tasks
(campaign: consensus 97% vs flagships 68–82%). Caveats: n=10–11 per arm
(mini-run); tier1's t121 miss is on the format-sensitive "5,5" answer
inside a 300-char tail (same caveat as documented in the campaign);
sensitivity-consensus fails are dominated by its known 0-round
"insufficient valid signals / max cost" stub mode (t118/120/124 tails are
coordination stubs, not answers).

Known defects resurfacing, with receipts in the tails CSV:

- **DEGRADED-as-success** (filed): 2 rows (t116 singles, `success=t`,
  0 tokens, `[DEGRADED] All execution attempts failed`).
- **Self-review contamination** (filed in round 1): 6 single rows
  (t119/120/122/123) where the recorded tail is a self-review of a prior
  response rather than the task answer.

## 4. Judge scores (full suite, pinned deepseek-v4-pro)

| arm | n | ok | judge avg |
|---|---|---|---|
| Mixed forced consensus | 40 | 39 | 0.528–0.554 |
| dynamic consensus | 42 | 33 | 0.524–0.667 |
| single openrouter/auto | 42 | 40 | ~0.45–0.50 |
| single qwen3:8b (as-served) | 39 | 38 | ~0.39–0.46 |
| Mixed sensitivity-consensus | 38 | 37 | 0.357–0.377 |
| single llama3.2:3b (as-served) | 15 | 15 | ~0.44 |

Same judge×checker divergence as the campaign (judge under-scores terse
`FINAL:`-style answers); the objective metric on verifiable tasks is §3.

## 5. Budget autopsy — why the run stopped at 283/456

`progress`: `totalCostUsd=25.12`, skipped 454
(`experiment_budget_exceeded` 422, `arm_budget_exceeded:llama3.2:3b` 29,
consensus 1, sensitivity-consensus 2). The skip-accounting fix from round 1
worked — nothing silent this time.

The **dynamic arm torched the budget**: its router-chosen strategies
recorded `quality_multipass` $12.78 for 4 executions and
`stigmergic-refinement` $5.37 for 3 — $18+ of the $20 cap on 7 rows —
while the forced Mixed consensus arm did 42 rows for $2.73 and the singles
102 rows for pennies. Recorded costs carry the already-filed
catalog-pricing caveat (the same rows' $/exec fails list-price sanity),
which means the *budget governor itself* is exposed to pricing-metadata
distortion: bad prices don't just misreport cost — they starve arms.

## 6. Verdict and next steps

- **H-B: NOT INSTANTIATED** (routing infidelity 100%). No claim about own
  infrastructure is supported by this run, in either direction.
- **Quality mechanism: replicated** on as-served cheap external arms
  (third independent run; consensus 91–100% vs singles 60–70%).
- **New P0 defect:** own-model arms need a provider-pinned execution path
  (equivalence/fallback must be disabled for `ollama*`-provider models in
  experiment arms — e.g. provider-scoped ids or a `forceProvider` flag on
  the chat request, mirroring how the judge is pinned).
- **Rerun plan (H-B v2):** after the pin lands — forced pools only (drop
  the dynamic arm), $40 cap or per-arm floors, verifiable-first task
  order, and a start-gate proof call that asserts `models_used` contains
  an ollama id before the frozen phase begins.

## 7. Artifacts

- `c3-hb-executions-36183d17.csv` — 283 rows, per-execution
  (`models_used` is the fidelity evidence).
- `c3-hb-answer-tails-36183d17.csv` — 55 verifiable-range tails scored in §3.
- Workflow runs: setup 28760661958 (failed, root-caused), deploy+start
  28762239142, status 28763333684/28764361137/28765803344/28767015586,
  check 28767138568, exports 28767296678/28767506406.
- PRs: #67 (H-B instantiation), #68 (discovery URL fix).
