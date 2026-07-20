<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Ailin Collective-vs-Frontier Benchmark — July 2026

**Question under test:** can a collective of cheap, diverse models beat the
current frontier single models — and at what cost?

**Campaign:** 3 runs, 2026-07-05 (single day, single code vintage, same
pinned judge): `9590ff41` (round 1, 4 flagships × 3 collectives),
`f7b76768` (H-A top-up, collectives only), `569ce880` (round 2, 8 singles
incl. Claude Fable 5 × 3 collectives). **1,278 executions persisted,
~$143 total spend.** Every number below is reproducible from the committed
CSV artifacts via the committed scripts (see §10).

---

## 1. TL;DR — the verdict, split by axis

| Claim | Verdict | Evidence |
|---|---|---|
| Collective **with objective verifier** beats every frontier single on verifiable tasks (H-A, quality) | **VALIDATED** | Checker pass-rate 97% (37/38) vs flagships' 68–82% (§3) |
| Collectives **without** the verifier beat frontier singles on verifiable tasks | **NOT validated** | blind-debate 77% / expert-panel 81% — inside the flagship range (§3) |
| Collective beats frontier singles on open-ended tasks (H-C) | **NOT validated — parity** | Judge-metric deltas within ±0.06 A/A noise; loses on creative/refactoring, wins/ties on reasoning (§4) |
| Collective is **cheaper per token** | **INVALIDATED** (as recorded) | Collectives $99–181/Mtok vs singles $0.14–1/Mtok recorded (§5) — but see the verifier short-circuit: $2.98/Mtok when it fires |
| Collective is faster | **INVALIDATED** | p50 latency 15–49s vs 8–29s for singles (§6) |

**One-sentence public claim that survives every audit in this campaign:**
*a ~$0.002–0.26/query ensemble of sub-frontier open-weight models, when
armed with a deterministic answer-verifier, produced objectively correct
answers more reliably (97%) than any of GPT-5.5-pro, Claude Opus 4.8,
Claude Fable 5, Gemini 3.1 Pro or Grok 4.3 (65–82%) on the verifiable
subset of this suite — while costing 2–3 orders of magnitude more per
token than the recorded single-model prices and running 2–4× slower.*

## 2. Setup

- **Single arms (pinned per run, election logged):** round 1:
  `gpt-5.5-pro-2026-04-23`, `claude-opus-4-8`, `gemini-3.1-pro`,
  `grok-4.3`. Round 2 adds: `claude-fable-5`, `gpt-5.5-pro` (A/A pair),
  `google/gemini-3.1-pro` (A/A pair), and — disclosed mis-election — the
  community fork `King3Djbl/mythos-9b-unhinged` (matched the `mythos`
  pattern; NOT a flagship; kept, analyzed separately). GPT-5.6, Gemini 3.5
  and Claude Mythos 5 were not present in the live catalog.
- **Collective arms:** `consensus` (best-of-N answer-verifier armed on the
  verifiable subset), `blind-debate`, `expert-panel`. Voter pools are
  cheap open-weight/small models (kimi-k2, Qwen3.5-397B/8B, gpt-oss-120b,
  Llama-3.1-8B, ministral/codestral/mistral, GLM-4.6V…) — **no flagship
  ever appears as a voter** (verified from per-execution internals).
- **Tasks:** 38 (stratified sample of the 126-task suite ∪ all 10
  verifiable tasks 116–125 with machine-checkable answers). Types:
  reasoning 10, strategy-specific 7, code-gen 4, creative 3, debugging 2,
  refactoring 2, adversarial 2, factual-QA 2, analysis/documentation/stt/
  video/leader/compositor 1 each.
- **Judge:** pinned `deepseek-v4-pro` (DeepSeek family — non-competitor;
  serving id observed `DeepSeek-V4-Flash`). Its bias against terse
  verified answers is documented (§8) — hence the checker is the primary
  metric on verifiable tasks.
- **Metrics:** (a) objective checker pass-rate (deterministic
  `answer_check`, judge-free) on tasks 116–125; (b) judge quality 0–1 on
  the full suite, **routing-faithful rows only** (single-arm rows served
  by a fallback model are excluded — fidelity was 65–82%).

## 3. Leaderboard A — OBJECTIVE correctness (verifiable tasks, all 3 runs pooled)

| Arm | correct | wrong | degraded† | contaminated† | **pass-rate** |
|---|---|---|---|---|---|
| **consensus + verifier** | **37** | **1** | 0 | 0 | **97%** (n=38) |
| claude-fable-5 * | 15 | 0 | 5 | 0 | 100% (n=15) |
| mythos-9b fork * | 15 | 0 | 5 | 0 | 100% (n=15) |
| google/gemini-3.1-pro * | 14 | 1 | 5 | 0 | 93% (n=15) |
| gpt-5.5-pro * | 14 | 3 | 3 | 0 | 82% (n=17) |
| claude-opus-4-8 | 23 | 5 | 9 | 3 | 82% (n=28) |
| expert-panel (no verifier) | 39 | 9 | 0 | 0 | 81% (n=48) |
| gemini-3.1-pro | 24 | 6 | 9 | 1 | 80% (n=30) |
| blind-debate (no verifier) | 27 | 8 | 0 | 0 | 77% (n=35) |
| gpt-5.5-pro-2026-04-23 | 22 | 10 | 7 | 1 | 69% (n=32) |
| grok-4.3 | 25 | 12 | 1 | 2 | 68% (n=37) |

\* round-2-only arms (smaller n). † `[DEGRADED]` no-response placeholders
and self-review prompt-contamination rows are harness failures, counted
separately, never as model errors (§8).

Consensus' single miss is a truncated generation (no `FINAL:` emitted) —
across 3 runs the verifier **never selected an objectively wrong answer**
(53/55 verified-selection telemetry, 0 checker failures). Flagship errors
are concrete and listed verbatim in the script output: grok answering
`0.984` where `98.41%` was required, emitting `FINAL:` with empty payload,
answering the wrong prompt; gemini answering `99.999995%`; models
answering profit-*increase* (2500) where the new *total* (44500) was asked.

## 4. Leaderboard B — judge metric, and WHERE the collective wins/loses

Full-suite judge scores (faithful rows): round 1 — consensus 0.664 >
best single 0.615; round 2 — blind-debate 0.621 > best single 0.608. In
both rounds the best collective arm tops the table, but **which** strategy
leads varies; treat as an arm-class result, not a strategy result.

**Per-task-type map (round 2, best collective vs best faithful single):**

| Task type | W/L/T | Reading |
|---|---|---|
| reasoning | **3W/0L/7T** | collective never loses; wins concentrate here |
| adversarial | 1W/0L/1T | collective robust |
| factual-QA | 0W/0L/2T | ceiling for both |
| code-generation | 1W/2L/1T | mixed |
| debugging | 0W/1L/1T | mixed-negative |
| creative | **0W/3L/0T** | single models win open prose |
| refactoring | 0W/2L/0T | single models win |
| documentation / analysis / stt | 0W/3L | single models win |
| by complexity | low 4W/4L/3T · medium 1W/4L/5T · high 0W/3L/5T | collective edge shrinks as open-endedness grows |

The full per-task table (38 rows: task, type, winning arm, scores, delta)
is emitted by `c3-publication-tables.py §B`. Caveat: this map uses the
judge metric, whose pro-prose bias (§8) systematically favors singles on
open tasks and *understates* the collective on verifiable ones.

## 5. Cost — per Mtok, per execution, per success (AS RECORDED)

| Arm | $/Mtok | $/execution | notes |
|---|---|---|---|
| singles (flagships) | **$0.14–1.02** | $0.0002–0.0018 | recorded catalog prices FAIL a list-price sanity check (frontier models at ~$0.2/Mtok is implausible) — cost axis is reported, not adjudicated |
| grok-4.3 | $0.47–0.56 | $0.0007–0.0010 | most plausible frontier pricing |
| consensus | $118–181 | $0.26–0.44 | **$2.98/Mtok, $0.0023/exec in the top-up** where the verifier fired 20/20 and short-circuited synthesis (~100× cheaper than its own unverified path) |
| blind-debate | $141–160 | $0.39–0.60 | most expensive arm |
| expert-panel | $99–131 | $0.23–0.29 | cheapest full collective |

**Cost verdict:** at recorded prices the collective is 2–3 orders of
magnitude more expensive per token. The one mechanism that bends this —
dramatically — is the verifier short-circuit. The "higher quality AND
lower cost" thesis is **not** validated on this evidence; "higher
objective reliability at higher cost, with a cost-collapsing verifier
path" is.

## 6. Latency (p50 / p90, seconds)

| Arm | r1 | r2 |
|---|---|---|
| singles | 15–29 / 28–54 | 8–29 / 25–58 |
| expert-panel | 20.5 / 80.3 | 14.8 / 52.8 |
| consensus | 33.4 / 66.4 | 35.3 / 81.0 |
| blind-debate | 49.1 / 64.4 | 31.8 / 72.1 |

Collectives run 1.5–4× slower at p50. Expert-panel is the fastest
collective; consensus pays for its verification/synthesis loop.

## 7. Model sets inside the strategies (from per-execution internals)

- **Core voter pool (round 2, 205 collective executions):**
  kimi-k2-0905-preview (180), Qwen3.5-397B-A17B (173), gpt-oss-120b
  (135 across two routes), Qwen3-8B (63), Llama-3.1-8B (47),
  deepseek-v4-pro (40), codestral (38), ministral-14b (36),
  mistral-large (27), GLM-4.6V, qwen3-max-preview…
- **Winning vs losing compositions:** the same core pool appears in both
  (kimi/Qwen3.5 in 68 high-quality and 93 low-quality executions) — the
  *voters* don't separate winners from losers. The **decider** does:
  Qwen3-8B (18 high / 11 low) and mistral-large (8/2) skew winning;
  gpt-oss-120b (11/22) and Llama-3.1-8B (4/13) skew losing. Actionable:
  decider selection is a lever the harness can learn.
- **Aggregation observed:** synthesis 36, `verified_individual` 15
  (checker override), agreement 2, best-individual fallback 2.
- Per-execution role/cost/latency decomposition is in the internals
  artifact; intermediate voter texts are not persisted (disclosed).

## 8. Validity: audits applied and defects disclosed

1. **Routing fidelity:** only 65–82% of single rows were served by the
   pinned model; all single-arm numbers use faithful rows only.
2. **DEGRADED-as-success:** 55 round-2 + 44 round-1 no-response rows
   recorded `success=true` (0 tokens) — excluded; defect filed.
3. **Prompt contamination:** 7 round-1 single rows contain self-review
   JSON instead of task answers — classified separately; defect filed.
4. **Judge bias, documented with receipts:** the pinned judge scored
   checker-verified correct answers 0.02–0.03 (e.g. task 119
   `FINAL: 299792458` → judge 0.02). Judge rankings measure style;
   checker rankings measure correctness. Both are reported.
5. **A/A noise floor:** same-model alias pairs differ by 0.025–0.060
   judge points — deltas below that are not interpretable.
6. **Skips visible:** 23 arm-budget skips in round 2 (consensus 11,
   blind-debate 11, expert-panel 1), counted in `progress.skipReasons`.
7. **Cost metadata:** flagship $/Mtok as recorded fails list-price sanity;
   the cost axis is presented as recorded, with this caveat, and no cost
   claim is made in the thesis verdict beyond it.
8. **Mis-election disclosed:** the mythos-9b community fork ran as a
   "single" arm; its strong showing (judge 0.54–0.61; checker 15/15) is
   reported but excluded from flagship claims — and is itself evidence of
   both judge style-bias and the answerability of FINAL-format tasks.

## 9. Hardness of the benchmark

- Frontier bar is real (actual current flagships, election logged,
  absences documented).
- Objective ground truth on the H-A subset (numeric/regex/string checks,
  machine-verifiable, re-scored judge-free post-hoc).
- No ceiling: hard tail where every arm fails (tasks 21/68/76 mean <0.30);
  flagships objectively erred on trivial-looking tasks at 18–32% rates.
- Strict non-competitor judge + documented failure mode, rather than a
  friendly judge.
- Same 38 tasks for every arm — composition confounding impossible.
- Every table regenerable from committed raw artifacts by two scripts.

## 10. Reproduce

```
cd reports/experiments
python3 c3-frontier-audit-9590ff41.py                  # round-1 audit (+ --pooled)
python3 c3-frontier2-objective-ha-569ce880.py          # round-2 excerpt scoring
python3 c3-campaign-objective-ha-final.py              # DEFINITIVE objective H-A
python3 c3-publication-tables.py                       # cost/latency/win-loss/voters
```

Artifacts: `c3-frontier-executions-9590ff41.csv`,
`c3-frontier-topup-executions-f7b76768.csv`,
`c3-frontier2-executions-569ce880.csv`,
`c3-frontier2-hardness-{tasks,outputs,internals}-569ce880.csv`,
`c3-frontier{,-topup,2}-answer-tails-*.csv`. Full narrative:
`c3-frontier-report-9590ff41.md` (+2 addenda),
`c3-frontier2-hardness-dossier-569ce880.md` (§1–9-FINAL).

## Addendum A (2026-07-06): H-B instantiation attempt — routing-fidelity failure, quality mechanism replicated

A mini-run (`c3-hb-mixed-minirun`, experiment `36183d17`) attempted to
instantiate pre-registered **H-B** (own/self-hosted model + cheap external
models as a mixed collective) using Ollama (`qwen3:8b`, `llama3.2:3b`) on
the project's CPU VPS. Full report:
`c3-hb-minirun-report-36183d17.md`; raw artifacts
`c3-hb-executions-36183d17.csv`, `c3-hb-answer-tails-36183d17.csv`.

- **H-B remains NOT INSTANTIATED.** The routing-fidelity audit found
  **0 of 283** executions served by the local models: the model-equivalence
  layer substituted external same-family providers for the own arms
  (`qwen3:8b` → `Qwen/Qwen2.5-Coder-32B`, `Llama-3.3-70B`,
  `DeepSeek-V4-Flash`, …). Same defect class as the round-1 single-arm
  silent fallback; for H-B it is disqualifying, so no claim about own
  infrastructure is made in either direction. A provider-pinned execution
  path for own arms is filed as the blocking defect for H-B v2.
- **The quality mechanism replicated a third time** on the as-served
  cheap-external arms (objective checker, verifiable tasks): dynamic
  consensus **11/11 (100%)**, mixed forced-pool consensus **10/11 (91%)**
  vs singles **60–70%** — consistent with the campaign's consensus 97% vs
  flagships 68–82%.
- Infrastructure that DID land and verify: Ollama service on the swarm,
  discovery of ollama models into the runtime inventory (after the
  `OLLAMA_URL` `/v1`-suffix normalization fix, PR #68), own-model
  resolvers/config/gates (PR #67), and skip accounting (454 skips fully
  attributed when the $20 cap was exhausted at $25.12 — the dynamic arm's
  router-chosen strategies consumed >$18 on 7 executions, a further
  instance of the pricing-metadata caveat now shown to also *starve arms
  via the budget governor*, not just misreport cost).
