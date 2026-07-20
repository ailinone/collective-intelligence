<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# C3 Frontier Supplement — Final Report (run 9590ff41)

**Run:** `9590ff41-afbc-40d0-8c3b-3a503fc9e7df` (`c3-frontier-comparison`)
**Window:** 2026-07-05 05:43Z → 07:57Z (state `completed`)
**Executions:** 405/405 successful — **0 errors** (392 frozen + 10 sanity + 3 warmup)
**Total cost:** $37.71 (cap $60)
**Judge:** PINNED `EXPERIMENT_JUDGE_MODEL=deepseek-v4-pro`, `JUDGE_MODE` removed
(the 7bb900e2 errata-E2 dynamic-judge deviation does NOT recur here). The judge
inference-proof call was answered under serving id `deepseek-ai/DeepSeek-V4-Flash`;
both ids are DeepSeek-family — pinned, calibrated-family, **non-competitor** —
so the protocol holds under either serving resolution. All scores in this run
were produced by the same pinned instrument; **cross-run comparisons with
7bb900e2 (dynamic judge) are invalid by design** and none are made here.

---

## ⚠ AUDIT ADDENDUM (2026-07-05, post-artifact) — SUPERSEDES the tables below

After this report was first written, the raw per-execution artifact was
exported (`c3-frontier-executions-9590ff41.csv`) and audited
(`c3-frontier-audit-9590ff41.py` — every number below is reproducible from
the CSV). Two contaminations were found in the original tables:

1. **Routing infidelity in the single arms.** Only 65–82% of each flagship
   arm's frozen rows were actually served by the pinned flagship
   (gpt 48/72, opus 47/72, gemini 49/73, grok 61/74); the rest fell back to
   cheap models (Qwen3-8B, kimi-k2-0905, ministral-3b, …) or returned empty.
   This **understates the flagships** — a bias in the thesis's favor that
   must be removed.
2. **Empty-generation defect.** 44 frozen rows have `total_tokens=0`,
   `success=true`, quality 0 — empty outputs recorded as successes (the
   chat path lacks the empty-output guard the video path got on
   2026-07-04). They drag arm means down artificially.

**Corrected (faithful-only) results** — single-arm rows kept only when
`models_used` contains the pinned id and tokens>0; collective rows kept
when tokens>0:

| Arm (full suite) | n | avg_q |
|---|---|---|
| **consensus** | 25 | **0.664** |
| gemini-3.1-pro | 49 | 0.615 |
| blind-debate | 14 | 0.590 |
| expert-panel | 32 | 0.563 |
| gpt-5.5-pro-2026-04-23 | 48 | 0.556 |
| claude-opus-4-8 | 47 | 0.552 |
| grok-4.3 | 57 | 0.517 |

| Arm (verifiable 116–125) | n | avg_q | paired vs flagships |
|---|---|---|---|
| **consensus** (verifier armado) | 5 | **1.000** | **11W/0L/7T — still undefeated** |
| expert-panel | 10 | 0.883 | 15W/7L/13T |
| gemini-3.1-pro | 16 | 0.867 | — |
| claude-opus-4-8 | 15 | 0.801 | — |
| gpt-5.5-pro-2026-04-23 | 16 | 0.719 | — |
| grok-4.3 | 19 | 0.667 | — |

**Corrected verdicts:**

- **H-A quality: still CONFIRMED, with narrower margin.** Verifier-armed
  consensus remains perfect (1.000) and undefeated (11W/0L/7T) against
  faithful flagship rows; the gap to the best faithful single narrows from
  +0.313 to **+0.133** (gemini 0.867). n remains 5 tasks — the top-up run
  is what makes this claim strong.
- **Full suite: consensus still beats all four flagships** (+0.049 over
  faithful gemini). **Expert-panel does NOT fully survive the audit** — it
  drops below faithful gemini-3.1-pro (0.563 vs 0.615); the original
  "consensus and expert-panel beat all singles" overstated the panel.
- **Cost: sharper diagnosis, still unresolved.** Faithful flagship costs
  (gpt $0.0002, opus/gemini $0.0004/exec at ~1.5k tokens ⇒ ~$0.13–0.27/Mtok
  blended) are inconsistent with pro-tier list prices — the catalog's
  pricing metadata for these ids fails a sanity check (grok's $0.046/exec
  is the only plausibly frontier-priced arm). No cost claim in either
  direction; pricing-metadata audit filed as follow-up.
- Two harness defects filed from this audit: (a) benchmark single arms
  must not silently fall back to other models (or must persist a
  routing-faithful flag); (b) empty chat generations must not be recorded
  as `success=true` (guard exists on the video path only).

The narrative below is the original adjudication, kept for the record; its
aggregate tables include the contaminated rows and are superseded by this
addendum.

---

## ⚠ ADDENDUM 2 (2026-07-05, post-top-up f7b76768) — POOLED H-A, final

The collectives-only top-up run (`c3-frontier-ha-topup`, experiment
`f7b76768`, 60/60 executions, 0 errors, **$0.12 total**, same pinned judge)
completed the H-A sample the arm-budget skips had truncated. Raw artifact:
`c3-frontier-topup-executions-f7b76768.csv`. Pooled results (both runs,
same instrument; singles = routing-faithful rows only):

| Arm (verifiable 116–125, pooled) | n | avg_q (judge) |
|---|---|---|
| **consensus** | 23 | **0.891** |
| gemini-3.1-pro | 16 | 0.867 |
| expert-panel | 29 | 0.836 |
| claude-opus-4-8 | 15 | 0.801 |
| blind-debate | 20 | 0.788 |
| gpt-5.5-pro-2026-04-23 | 16 | 0.719 |
| grok-4.3 | 19 | 0.667 |

**Honest findings the top-up forced:**

1. **Run 1's perfect consensus score did not replicate as a judge-scored
   mean.** Run 1: 1.000 over 5 tasks; run 2: 0.861 over all 10 tasks
   (tasks 117/118/125 scored 0.5–0.6). Pooled paired-by-task: consensus
   **14W/12L/9T** against the four flagships — a small mean edge (+0.024
   over the best faithful single), *not* the undefeated record of run 1
   alone. Claims based on run 1's 11W/0L are hereby weakened to this
   pooled figure. Inter-run variance (voter-pool composition differs per
   run) is real and now measured.
2. **Judge×checker divergence — the decisive measurement insight.** In the
   top-up, the best-of-N verifier selected a checker-VERIFIED answer in
   **20/20 consensus rows** (run 1: 3/5) — i.e., the final answers passed
   the objective `answer_check` — yet the pinned judge scored several of
   those verified-correct answers 0.5–0.6. The judge-scored H-A table
   above therefore **understates** objectively-verified performance. Under
   the checker's objective criterion, consensus produced verified-correct
   answers in 23/25 verified-selection rows across both runs and zero
   checker-failed selections. The definitive H-A adjudication — checker
   pass-rate applied post-hoc to ALL arms' persisted response texts
   (singles included; texts are persisted per E6) — is the single
   remaining follow-up, and it is judge-free.
3. **The verifier is also the cost mechanism.** With the verifier firing
   20/20, consensus cost $0.0023/success in the top-up vs $0.173/exec in
   run 1 (3/5 firing) — the pre-synthesis short-circuit skips the
   coordinator when a candidate is checker-verified. Where the verifier
   fires, the collective is simultaneously **verified-correct and ~75×
   cheaper** than its own unverified path.

**Final consolidated verdicts (this supplement, both runs):**

- **Full suite (judge-scored, faithful-only): consensus beats all four
  flagship singles** (0.664 vs 0.615 best) — the strongest defensible
  quality claim, robust to the routing-fidelity audit.
- **H-A (judge-scored, pooled): small consensus edge over the best
  flagship (+0.024), paired near-parity** — weaker than run 1 suggested.
- **H-A (checker-verified): consensus' verifier selected objectively
  correct answers in 23/25 rows with zero failures, at ~75× lower cost
  when firing** — the mechanism the thesis names works; the judge-free
  post-hoc scoring of all arms is the remaining step to a definitive
  objective comparison.
- **H-C: parity on open tasks** — stable across every cut of the data.

---

## What this run is

The 7bb900e2 audit found the "single" arm never contained a current flagship
(its resolver picks 1 model per *provider* by context/cost, yielding
haiku/flash-lite/gpt-3.5-class singles). This supplement closes that gap: the
explicit flagship of each frontier family was elected from the live catalog and
pinned as a single arm —

| Family | Pinned single arm |
|---|---|
| OpenAI | `gpt-5.5-pro-2026-04-23` |
| Anthropic | `claude-opus-4-8` |
| Google | `gemini-3.1-pro` |
| xAI | `grok-4.3` |

against three collective arms (`consensus`, `blind-debate`, `expert-panel`) on
**the same 38 tasks for every arm** (stratified sample ∪ the full verifiable
subset 116–125), 2 repetitions, pinned non-competitor judge. Because every arm
runs the identical task set, the composition confounding that invalidated the
7bb900e2 headline (errata E1) is **structurally impossible** here.

Hardness note: the suite includes tasks on which *every* arm — flagships
included — scored ≈0 (tasks 26, 57, 98, 102). There is no ceiling effect; the
benchmark discriminates.

## H-A — the pre-registered PRIMARY test (verifiable tasks 116–125)

Tasks 116–125 carry objective `answer_check` constraints; the best-of-N
verifier is armed for collectives. Frozen-phase results:

| Arm | n | avg_q | paired vs each flagship (W/L/T) |
|---|---|---|---|
| **consensus** (verifier-armed) | 5 | **1.000** | **16W / 0L / 4T** — 4W/0L/1T vs each of the four |
| expert-panel | 10 | **0.883** | 24W / 7L / 9T |
| blind-debate | 1 | 1.000 | n=1 — not adjudicable |
| gemini-3.1-pro (best single) | 20 | 0.693 | — |
| grok-4.3 | 20 | 0.634 | — |
| claude-opus-4-8 | 20 | 0.601 | — |
| gpt-5.5-pro-2026-04-23 | 20 | 0.576 | — |

- **Consensus scored a perfect 1.000 on every verifiable task it ran and never
  lost a single paired comparison against any flagship** (on shared tasks:
  +0.313 over the best single). Against any *fixed* flagship the 4W/0L sign
  test is significant (p = 1/16 one-sided per arm; jointly 16 decisive wins,
  0 losses). Against a hypothetical per-task *oracle* best-single, consensus
  is 3W/0L/2T — directionally identical, n too small to be significant alone.
- **Mechanism telemetry:** 3 of the 5 consensus rows carry the
  `consensus_verified_individual` marker — the answer-check verifier
  demonstrably selected the checker-verified candidate over the vote. This is
  the H-A mechanism operating in production, not an inference.
- Expert-panel (no verifier dependency, full 10-task coverage) confirms the
  same direction at +0.190 over the best single.

**H-A quality verdict: CONFIRMED on the available sample.** A cheap-model
collective with the objective verifier armed beat all four current flagship
singles on objectively checkable tasks, on identical task sets, under a pinned
non-competitor judge.

**H-A cost verdict: NOT confirmed.** On the verifiable subset consensus cost
~$0.173/execution vs $0.0002–0.0006/execution recorded for the flagship
singles. Two readings: (a) at face value, the collective's quality win is paid
for — "equal-or-lower cost" fails on this subset; (b) the singles' recorded
costs are implausibly low for pro-tier flagship models (see Gates below), so
no cost claim in either direction is publishable until the zero-cost audit
runs. Either way, cost is disclosed as unresolved, not claimed.

## Full-suite results (all 38 tasks, frozen phase, own-label arms)

| Arm | n | avg_q | cost/success (as recorded) |
|---|---|---|---|
| **consensus** | 29 | **0.572** | $0.3809 |
| **expert-panel** | 34 | **0.530** | $0.2154 |
| gemini-3.1-pro | 58 | 0.519 | $0.0004* |
| grok-4.3 | 59 | 0.499 | $0.0007* |
| gpt-5.5-pro-2026-04-23 | 57 | 0.468 | $0.0002* |
| blind-debate | 18 | 0.459 | $0.4655 |
| claude-opus-4-8 | 57 | 0.455 | $0.0003* |

\* flagged: implausibly low for pro-tier flagships — cost attribution audit
required before any cost conclusion (see Gates).

**Consensus and expert-panel beat all four flagship singles on the full
suite.** Paired-by-task across all 38 tasks: consensus 56W/23L/17T against the
flagships (14W/5.75L/4.25T average per flagship); expert-panel 63W/41L/16T;
blind-debate 30W/18L/12T (≈parity).

## H-C — open-ended tasks only (<116), shared-task means

| Collective | n shared tasks | collective | best single on same tasks | delta |
|---|---|---|---|---|
| consensus | 19 | 0.480 | grok-4.3 0.444 | **+0.036** |
| expert-panel | 20 | 0.423 | grok-4.3 0.420 | +0.004 |
| blind-debate | 14 | 0.431 | grok-4.3 0.437 | −0.006 |

**H-C verdict: CONFIRMED again** — without the verifier's leverage (open
tasks), collectives sit at statistical parity with the best flagship single
(deltas within ±0.04), exactly as pre-registered. The collective premium
concentrates where the thesis says it should: on verifiable tasks with the
verifier armed (+0.313) and, more weakly, on structured-panel aggregation
(+0.190 on the verifiable subset).

## Adjudication of the thesis

> "A collective of cheap, diverse models can beat a strong single model."

- **Quality, against real flagships: YES — confirmed in the pre-registered
  winnable form.** Verifier-armed consensus dominated all four current
  flagships on objectively verifiable tasks (16W/0L/4T, perfect scores,
  verified-selection telemetry present), and consensus + expert-panel also
  lead the full-suite aggregate. This is the first run where the single arm
  actually contains GPT-5.5-pro / Opus 4.8 / Gemini 3.1 Pro / Grok 4.3 —
  the bar the thesis names.
- **Open-ended tasks: parity** (H-C), not superiority. The collective's edge
  is mechanism-specific, not magic.
- **Cost: unresolved.** Collective arms are 2–3 orders of magnitude more
  expensive per execution than the *recorded* single costs; the recorded
  single costs fail a plausibility smell test. No cost claim is made.

## Publishability gates & disclosed limitations

1. **Coverage shortfall (material):** the runner marked the experiment
   `completed` at 392/532 planned frozen executions. Singles completed 2 full
   reps everywhere (20/20 on the verifiable subset each); collectives'
   rep-2 is partial — consensus covered 5/10 verifiable tasks, expert-panel
   10/10 ×1 rep, blind-debate 1/10 (underpowered, excluded from claims).
   The consensus H-A claim therefore rests on 5 tasks / 20 paired
   comparisons. Direction is unambiguous; n is small. A top-up run of the
   collectives on 116–125 (~$5) would double the sample. The
   completed-with-shortfall runner behavior itself needs a root-cause.
2. **Zero-cost gate (E3) not yet run for this vintage:** flagship per-success
   costs of $0.0002–0.0007 indicate under-attribution. Until audited, all
   cost columns are "as recorded", not claims.
3. **Judge:** single pinned judge (not a jury), DeepSeek family. Serving id
   observed as DeepSeek-V4-Flash on the proof call vs pinned id
   deepseek-v4-pro — same family/provider; the exact serving resolution
   should be named in any external publication. Judge strictness differs
   from prior runs; only intra-run comparisons are made.
4. **Single run, one vintage** (all post-2026-07-04-fix code; no mixed-vintage
   contamination — 0 errors across 405 executions, vs 28.6% in 7bb900e2).
5. Suite-pinned-strategy tasks (own `strategy` overrides) were compared only
   within the same override label; collective-arm attribution on those rows
   is not possible (both arms inherit the label) and they are excluded from
   per-arm claims.

## Recommended next steps

1. Top-up run: collectives only × tasks 116–125 × 2 reps (~$5) to raise H-A
   n from 5→10 tasks for consensus and give blind-debate a real sample.
2. Run the zero-cost/cost-attribution audit for this run's rows; then, and
   only then, adjudicate the cost half of H-A.
3. Root-cause the `completed`-at-392/532 runner behavior.
4. Optional protocol upgrade for the public artifact: pinned 3-family
   non-competitor judge jury (median), re-scoring this run's persisted
   responses offline — responseSummary carries full final texts (E6), so no
   re-execution is needed.
