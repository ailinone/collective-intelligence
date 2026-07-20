<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# C3 Pilot Ecosystem Audit

**Audit Date:** 2026-04-16
**Pilot ID:** `c9c19894-c5ef-45a6-a760-97beb12b2a38`
**Auditor:** Automated comprehensive analysis of 555 executions, 1501 decisions, 606 tracked models, 32 strategy files, and full supplementary data
**Methodology:** Evidence-only. Every claim is traceable to pilot data or source code.

---

## 1. Executive Verdict

The C3 pilot proves that collective intelligence orchestration CAN match or beat frontier single-model quality in 8-9 of 10 task types, at 2-243x lower cost. This is a genuine, evidence-backed finding.

However, the system that produced this result is **fragile, over-engineered, and largely uncontrolled**. The 42.5% failure rate (236/555), the 66% of errors from a single preventable cascade (pool collapse), the 0% success rate on two strategy variants, and the fact that 98.8% of all selection decisions are "explicit" (hardcoded by the experiment runner, not by the adaptive system) mean the following:

**The adaptive intelligence layer -- the bandit, the archive, the pareto frontier, the learned weights -- is almost entirely decorative in this pilot.** The system succeeded where it did because of brute-force strategy enumeration, not because it learned what works. The 14 SOTA layers are built but most are not exercising meaningfully under production load.

**Verdict: Infrastructure validated. Intelligence layer not validated. 6 critical bugs found and fixed live. System is not ready for production traffic but has a viable path forward with focused work on the top 10 issues.**

---

## 2. Systemic Diagnosis

### The Core Loop Problem

The system has a learning loop on paper: execute -> score -> record outcome -> update weights -> select better next time. In practice, the pilot bypassed this loop almost entirely:

1. The experiment runner uses `explicit` selection for 1483/1501 decisions (98.8%)
2. The `freezeLearningDuringEval: true` flag is set in the config
3. Only 8 pareto, 5 archive, 3 bandit, 2 heuristic decisions occurred -- all during warmup or adaptive-mode arms
4. Strategy weights exist (166 entries across task/complexity buckets) but are never consulted during frozen-phase execution
5. The triage confidence distribution shows 0 high-confidence, 0 medium-confidence, 8 low-confidence, and 1493 no-confidence decisions

This means the pilot measured strategy performance but did not use the measurement system to make decisions. The experiment design is correct for a controlled A/B test. But it also means no claim can be made about the adaptive system working.

### The Pool Collapse Cascade

The single largest system failure: 156 executions (28% of all, 66% of errors) died from `pool_too_small`. Root cause chain:

1. Hub providers (aihubmix, cometapi) exhausted credits during the run
2. Provider failure attribution bug: hub failures were counted against native providers (e.g., aihubmix failing on `openai/gpt-4o-mini-search-preview` was attributed to `openai`)
3. Error-learning system marked native providers as unreliable based on hub failures
4. Model performance tracker's cumulative (non-sliding) window made provider reputation irrecoverable
5. Quality filter in `getEligibleModels()` excluded degraded models
6. Pool shrank below strategy `minModels` thresholds (2-7 depending on strategy)
7. All collective strategies threw "requires at least N models"

Six bugs were found and fixed live (attribution, sliding window, failsafe, cost sort, credit marking, OpenAI adapter). The fixes are sound, but the cascade exposed a fundamental fragility: the system has no graceful degradation path when the model pool contracts.

---

## 3. Audit by Axis

### AXIS A -- Model Ecosystem Health

**Finding A1: Pool is enormous but mostly unusable.**
606 models tracked. 376 degraded (62%), 230 healthy (38%). Of the degraded models, most have `error_rate: 1.00` with last-checked dates from April 9-15. Many are embedding models, audio models, or defunct endpoints that should never have entered the chat pool.

Evidence: The healthy models list includes `nvidia/gliner-pii` (a PII detection model, not a chat model), `web-search`, and `assistant` -- none of which are LLMs. The degraded list includes `gpt-5.4` itself at error_rate 1.00, which is a top-tier model that worked fine during the pilot. This means the health tracking system's snapshot is stale or wrong for models that recovered.

**Finding A2: No capability deduplication by function.**
The pool contains the same model reachable via different providers: `gemini-3.1-pro-preview` via Google native, `google/gemini-3.1-pro-preview` via Vertex, `deepinfra/google/gemini-2.5-flash` via DeepInfra. The model equivalence service (L2) exists but was not exercised during the pilot -- zero evidence of equivalence-based deduplication in the decision audit.

**Finding A3: Health calculation is binary and unforgiving.**
`getEligibleModels()` in `base-strategy.ts` uses a quality threshold of `max(0.4, qualityTarget * 0.7)`. With `qualityTarget=1.0` (set for all collective strategies in the experiment config), the threshold becomes 0.7. Any model without quality data (quality=0) is excluded when threshold >= 0.6. This means new models or models that had a single bad execution early can never enter the pool until quality data is manually seeded.

**Finding A4: Balance status is unreliable.**
The supplementary data shows only 3/32 providers had their balance actually probed. The L4 Credit Monitor runs on a 5-minute cycle but its `providerBalanceStatus` map was not consistently propagated to model records during the pilot. Evidence: All hub providers showed `has-credits` or `unknown` until they actually failed, at which point it was too late.

**Recommendations:**
- A-R1: Hard-filter the pool at discovery time: exclude models without `chat` or `text_generation` capability from the chat pool entirely. Currently, the filter is in `getEligibleModels()` at execution time, which means the pool size metric (606) is misleading.
- A-R2: Mark `gpt-5.4` health as recovered after successful executions. The health snapshot showing it at 1.00 error rate while it had 14 successful pilot executions proves stale state.
- A-R3: Credit monitor should set `balanceStatus = 'no-credits'` on the model record immediately when a 402/429-credits response is received, not wait for the next 5-minute probe.

---

### AXIS B -- Strategy Eligibility & Preconditions

**Finding B1: minModels thresholds are the #1 cause of failure after pool collapse.**
Strategy requirements range from 2 (cost-cascade, quality-multipass, sequential) to 3-7 (consensus, blind-debate, double-diamond, persona-exploration). When the pool collapsed to <3 models, every strategy requiring 3+ failed immediately. Even the 2-model strategies failed because the cost-cascade sort put $0-cost hubs first (Bug 4, fixed).

Evidence from strategy source code:
- `consensus`: minModels=3, throw if < 3
- `blind-debate`: minModels=3, throw if < 3
- `double-diamond`: minModels=3, throw if < 3
- `persona-exploration`: minModels=3 (4 phases, each needing a model)
- `cost-cascade`: minModels=2
- `quality-multipass`: minModels=2

**Finding B2: No graceful degradation in any strategy.**
Every strategy has a hard throw when `models.length < minModels`. No strategy attempts to fall back to a simpler approach (e.g., consensus with 3 models falling back to parallel with 2, or single-model if only 1 is available). The only fallback exists at the orchestration engine level (not strategy level), and it was not triggered during the pilot.

**Finding B3: Strategy eligibility is not checked before assignment.**
The experiment runner assigns strategies explicitly. It does not check if the assigned strategy can actually execute with the current pool state. The runner should pre-validate that `getEligibleModels(context).length >= strategy.minModels` before dispatching.

**Recommendations:**
- B-R1: Add a `degrade()` method to BaseStrategy that returns a simplified execution plan when the pool is too small. For example: consensus(3+) -> parallel(2) -> single(1).
- B-R2: Add pool-size pre-check in the experiment runner before dispatching. If the pool is too small for the target strategy, record it as `skipped_pool_too_small` (not `error`), and try again later.
- B-R3: Reduce minModels for strategies where it makes sense. Cost-cascade can work with 1 model (just run it). Debate strategies need at least 2+adjudicator=3 for theoretical correctness, so 3 is justified there.

---

### AXIS C -- Adaptive Selection (Real vs Decorative)

**Finding C1: The adaptive layer is almost entirely bypassed.**
Decision audit breakdown:
- `explicit`: 1483/1501 (98.8%) -- hardcoded by experiment config
- `pareto`: 8 (0.5%) -- from the 3 adaptive-mode arms
- `archive`: 5 (0.3%) -- from archive lookups
- `bandit`: 3 (0.2%) -- from Thompson sampling
- `heuristic`: 2 (0.1%) -- from triage fallback

The strategy bandit, configuration archive, and pareto frontier are implemented (confirmed in code imports in `orchestration-engine.ts`), but they are only invoked when the requested strategy is `auto`. In the experiment config, only 3 arms use `auto` (the adaptive arm + any auto-fallback). The remaining 35 arms use explicit strategy assignment.

**Finding C2: Strategy weights exist but are learned from prior runs, not this pilot.**
The supplementary data shows 166 weight entries across task/complexity buckets. Many have `Samples: 1-7`, with weights ranging from 0.12 to 1.74. These weights come from the auto-learning system which runs during warmup phase only (`freezeLearningDuringEval: true` in config). The weights were updated during the 10 warmup executions, then frozen for the remaining 545.

Evidence: The `general/complex` bucket has weights for 20+ strategies, most with weight ~1.0 and samples from 2-177. The `single` strategy has 1806 samples in `general/moderate` because prior non-experiment traffic also feeds this system. But during the pilot itself, these weights were not consulted for strategy selection.

**Finding C3: Shadow evaluations show the adaptive system COULD help if activated.**
87 shadow evaluations were recorded. Key regret cases:
- `code-review/moderate`: debate chosen (0.537) vs consensus available (0.863) -- regret 0.325
- `code-generation/simple`: contextual chosen (0.000) vs sequential available (0.860) -- regret 0.860
- `code-generation/complex`: competitive chosen (0.000) vs sequential available (0.688) -- regret 0.688

These large regret values confirm that if the system had used its learned preferences, it would have made better choices. But the experimental design (correctly) froze learning to get clean measurements.

**Finding C4: Triage confidence is zero for 99.5% of decisions.**
1493/1501 decisions have `confidence: none`. This means the triage service either was not invoked or returned no confidence score. The 8 low-confidence decisions all have `confidence: 0.30` -- suspiciously uniform, suggesting a default/floor value rather than actual estimation.

**Recommendations:**
- C-R1: Run a dedicated "adaptive-only" pilot phase where ALL strategy selection is done by the bandit/archive/pareto system. This is the only way to validate the adaptive layer.
- C-R2: The triage confidence of 0.30 for all non-explicit decisions should be investigated. If this is a hardcoded default, it renders the confidence metric useless.
- C-R3: Log which component made the selection decision (bandit vs archive vs pareto vs heuristic vs fallback) with detailed scores, not just the final reason tag.

---

### AXIS D -- Strategy Design Correctness

**Tier 1: Working and Justified (>80% success, quality competitive with top-tier)**

| Strategy | Success | Avg Quality | Assessment |
|----------|---------|-------------|------------|
| hybrid | 93.3% | 0.749 | Best reliability. Parallel generation + sequential refinement. Sound design. KEEP. |
| quality_multipass (underscore) | 100% | 0.660 | 10/10 success. Multi-pass refinement works. Note: only works because underscore variant resolves correctly. KEEP, fix naming. |
| sequential | 93.3% | 0.533 | Reliable but lower quality. Pre-analysis then main generation. KEEP as baseline. |
| safety-quorum | 92.9% | 0.245 | High reliability but very low quality. Majority-vote safety assessment loses nuance. KEEP for safety-critical only, not general use. |

**Tier 2: Promising but Unreliable (40-80% success)**

| Strategy | Success | Avg Quality | Assessment |
|----------|---------|-------------|------------|
| parallel | 80.0% | 0.682 | Good quality when it works. 3 failures from pool collapse. KEEP. |
| adaptive | 64.3% | 0.832 | Highest quality when it works. Meta-strategy concept is sound. Failures from pool collapse. KEEP, fix pool resilience. |
| collaborative | 40.0% | 0.842 | Highest raw quality of any strategy. 60% failure is all pool/timeout. KEEP, reduce model requirements. |
| competitive | 60.0% | 0.594 | Moderate. Models race, best wins. KEEP but lower priority. |
| expert-panel | 53.3% | 0.513 | Panel of specialists. Pool collapse killed it. KEEP, needs stable pool. |

**Tier 3: Fragile or Unproven (28-50% success)**

| Strategy | Success | Avg Quality | Assessment |
|----------|---------|-------------|------------|
| critique-repair | 42.9% | 0.737 | Good quality concept (generate->critique->repair). Needs pool stability. KEEP. |
| multi-hop-qa | 42.9% | 0.667 | Research-then-answer. Works well for documentation. KEEP for specific tasks. |
| blind-debate | 42.9% | 0.508 | Surowiecki independence concept. Mediocre quality despite theoretical appeal. SIMPLIFY -- adjudicator step adds latency without quality gain vs simple parallel. |
| massive-parallel | 53.3% | 0.363 | Low quality despite high parallelism. More models != better answers. SIMPLIFY to 3-model parallel. |
| consensus | 28.6% | 0.530 | Voting mechanism has implementation issues (needs 3+ models). SIMPLIFY, merge with blind-debate. |
| debate | 28.6% | 0.350 | Multi-turn debate. 90s internal timeout kills complex debates. Low quality. REMOVE or drastically simplify. |
| reinforcement | 50.0% | 0.446 | Simulate RL with generation+evaluation. Quality is low. NEEDS RETHINK. |
| hierarchical | 50.0% | 0.329 | Manager-worker pattern. Low quality suggests overhead not justified. SIMPLIFY. |

**Tier 4: Broken or Unviable (<30% success or 0%)**

| Strategy | Success | Avg Quality | Assessment |
|----------|---------|-------------|------------|
| cost-cascade | 0.0% | -- | Broken by cost=$0 hub variants sorted to top. Fix merged but never tested post-fix. RE-TEST. |
| quality-multipass (dash) | 0.0% | -- | Naming bug. The strategy class registers as `quality-multipass` (dash) but the experiment config uses the dash variant which fails resolution. The underscore variant works. FIX NAMING. |
| double-diamond | 21.4% | 0.333 | Four-phase macro-strategy. Too complex, too many sequential LLM calls (6-8), timeout-prone. 180s timeout in code. REMOVE -- use simpler strategies composed manually. |
| persona-exploration | 21.4% | 0.617 | Multi-persona exploration. 4+ sequential phases = timeout risk. SIMPLIFY to 2 phases. |
| swarm-explore | 35.7% | 0.198 | Very low quality. Swarm intelligence concept does not translate to LLM orchestration. REMOVE. |

**Finding D1: Strategy naming inconsistency is a production bug.**
The strategy class for quality-multipass registers with `name: 'quality-multipass'` (dash). The experiment config sends `strategy: 'quality-multipass'` (dash). But the strategy-contract.ts canonicalization might map this differently than `quality_multipass` (underscore). The underscore variant had 100% success; the dash variant had 0%. This is almost certainly a resolution/routing bug, not a strategy logic bug.

**Finding D2: 10 strategies (34% of collective strategies) add no value over simpler alternatives.**
Strategies like `war-room`, `agentic`, `swarm-explore`, `stigmergic-refinement`, `diversity-ensemble`, `contextual`, and `hierarchical` all hover at 40-50% success with 0.2-0.4 quality. These are elaborate multi-phase orchestrations that add cost and latency without quality improvement. The simpler `parallel` or `sequential` strategies consistently outperform them.

**Finding D3: The 300s hard timeout kills complex strategies systematically.**
35 failures were timeouts. Strategies with 4+ sequential LLM calls (double-diamond: 6-8, persona-exploration: 4, research-synthesize: 3-4) routinely hit 300s. Each LLM call averages 30-90s depending on model and complexity. A 4-phase strategy needs 120-360s just for generation, plus synthesis.

**Recommendations:**
- D-R1: Fix the quality-multipass naming. Either register as `quality_multipass` or update all references.
- D-R2: Remove or archive 5 strategies: `swarm-explore`, `double-diamond`, `debate` (keep `blind-debate`), and consolidate `massive-parallel` into `parallel` with a configurable model count.
- D-R3: Set per-strategy timeouts based on phase count: 2-phase strategies get 180s, 3-phase get 240s, 4-phase get 300s. Do not use a uniform 300s for all.
- D-R4: Create a "strategy tier" system: Tier A (proven, >80% success) for production, Tier B (promising, 50-80%) for exploration, Tier C (experimental, <50%) for research only.

---

### AXIS E -- Runtime, Retries, Timeouts

**Finding E1: 300s hard timeout is a blunt instrument.**
35 timeout failures (14.8% of errors). The timeout is applied uniformly regardless of strategy complexity. Source code confirms per-strategy timeouts exist (blind-debate: `BLIND_DEBATE_TIMEOUT_MS` defaults to 300000, double-diamond: `DOUBLE_DIAMOND_TIMEOUT_MS` defaults to 180000) but many strategies rely on the experiment runner's 300s fetch timeout.

**Finding E2: Retries are universal but opaque.**
The execution outcomes detail shows 1082 outcomes, ALL with retries > 0 (100%). This suggests every execution involves at least one retry. Zero fallbacks occurred. 177 escalations occurred (16.4%), concentrated in `parallel` (149) and `cost-cascade` (28). The retry mechanism is masking underlying issues -- if 100% of executions need retries, the first-attempt success rate is lower than reported.

**Finding E3: The `Cannot read properties of undefined` pattern.**
Not directly observed in the pilot data but implied by the "other" error category (28 failures, 11.9%). The `safeResponseContent()` function in `base-strategy.ts` handles null responses correctly, but intermediate strategy steps (e.g., extracting quality scores from validation responses in quality-multipass) may not use this safe accessor consistently.

**Finding E4: Average feedback iterations is 1.6.**
This means on average, each execution goes through 1.6 feedback loops. With 319 successful executions, that is ~510 total LLM calls just for the feedback loop -- a significant cost and latency overhead. The feedback loop should be optional and triggered only when initial quality is below threshold.

**Recommendations:**
- E-R1: Add first-attempt success rate tracking. If a strategy needs 2+ retries consistently, that is a signal to fix the strategy, not mask it with retries.
- E-R2: Make feedback loop optional per strategy tier. Tier A strategies (>80% success) can skip the feedback loop to save latency.
- E-R3: Log the specific error message for every "other" failure. The 28 unclassified errors need investigation.

---

### AXIS F -- Cost Accounting & ROI

**Finding F1: Widespread cost=$0 entries.**
Many executions report $0.000 cost even though they consumed tokens. Evidence: `deepseek-chat` executed 11 times with total cost $0.09 (avg $0.008), but many individual subcalls show `$0.0000`. The cost is missing because hub providers (aihubmix, cometapi, openrouter) either do not return usage data or the adapter does not propagate it.

The subcall metadata pattern `primary:qwen3.5-397b-a17b-t($0.0000/31552ms)` shows zero cost for a 31-second execution that clearly consumed tokens. This is a tracking failure, not genuinely free computation.

**Finding F2: Cost sort in cost-cascade was broken.**
Bug 4 (fixed): Models with cost=$0 (missing pricing from hubs) were sorted as "cheapest" and tried first. Since these $0 models often fail (they are the ones without credit), the cascade never reached a working model. The fix treats $0 hub entries as MAX cost, but this inverts the cascade logic -- it should treat them as UNKNOWN and skip them, not push them to the end.

**Finding F3: Total cost is reasonable but unevenly distributed.**
$9.95 total for 555 executions ($0.018/exec average). But the distribution is extremely skewed:
- Top-tier single models: $5.91 (59% of cost for 16% of executions)
- claude-opus-4-6: $2.35 for 14 executions ($0.168/exec)
- gpt-5.4: $2.10 for 14 executions ($0.150/exec)
- All 29 collective strategies combined: $3.51 (35% of cost for 76% of executions)

The cost efficiency story is real: collective strategies are genuinely cheaper per execution. But the $0 entries mean the actual collective cost is underreported.

**Finding F4: Efficiency scores in strategy weights are not comparable.**
The supplementary data shows `Cost Efficiency` values ranging from 0.000 to 5937.500. A value of 5937.5 (for `qa/moderate/single`) is quality/cost ratio that is meaningless when cost is near-zero. The metric needs normalization or replacement.

**Recommendations:**
- F-R1: Fix cost propagation from hub adapters. Every execution must record non-zero cost or be explicitly marked as cost-unknown.
- F-R2: Replace cost efficiency metric with cost-per-quality-point: `cost / max(quality, 0.01)`. This avoids division-by-zero and is comparable across strategies.
- F-R3: Add a cost audit trail: each subcall should record input_tokens, output_tokens, and cost_usd. The current metadata string format (`$0.0000/31552ms`) is not machine-parseable.

---

### AXIS G -- Observability & Auditability

**Finding G1: Decision audit is comprehensive but 99% uninformative.**
1501 decisions recorded with timestamp, task type, complexity, requested strategy, selected strategy, reason, and confidence. But 98.8% have reason=`explicit`, confidence=`none`, expected_quality=`none`, models_selected=empty. The audit trail for explicit selections is a tautology: "the experiment said to use X, so we used X."

The 18 non-explicit decisions (pareto/archive/bandit/heuristic) are more informative but too rare to analyze statistically.

**Finding G2: Execution metadata is rich but inconsistently formatted.**
The metadata field in execution logs contains valuable data: `[models: X, Y] [decider: X] [subcalls: primary:X($cost/latencyMs)] [source: explicit] [chain: X -> Y]`. This is human-readable but not machine-parseable. Different strategies format this differently. Some include subcall details, others do not.

**Finding G3: Model health snapshot contradicts pilot reality.**
The health snapshot shows `gpt-5.4` as `degraded` with `error_rate: 1.00`. But gpt-5.4 had 14 successful executions in the pilot with 0.816 average quality. This means either (a) the health system is tracking a different time window than the pilot, or (b) the health system counts pre-pilot failures that have not decayed. The sliding-window fix (15-minute TTL) should have addressed this, but the snapshot was taken at a different time.

**Finding G4: No per-execution error details for 28 "other" failures.**
The error classification has `pool_too_small`, `timeout_300s`, `fetch_failed`, `credit_exhaustion`, `debate_90s`, and `auth_error`. But 28 failures are just "other". These could be JSON parse errors, garbled model output, undefined property access, or anything else. Without detailed error messages, these are uninvestigable.

**Recommendations:**
- G-R1: For non-explicit decisions, log the full scoring breakdown: all candidate strategies, their scores, and why the winner was picked.
- G-R2: Move execution metadata to structured JSON fields, not a free-text string. Each subcall should be a JSON object with `{model, cost, latencyMs, success, tokens}`.
- G-R3: Add error message and stack trace to every failed execution record. The "other" category should not exist.
- G-R4: Reconcile health snapshot with pilot execution data. After a pilot, the health system should incorporate pilot results.

---

### AXIS H -- Pilot Design & Experimental Setup

**Finding H1: The pilot design is sound for infrastructure validation.**
38 arms (6 top-tier + 29 collective + 2 budget + 1 adaptive), 10 tasks, 2 repetitions, 760 target executions. The design covers the strategy space comprehensively. The `freezeLearningDuringEval: true` flag is correct for a controlled comparison.

**Finding H2: Task coverage is narrow.**
10 tasks across 5 types (code-generation, debugging, general, creative, reasoning, refactoring, documentation). But most are low-to-medium complexity. The tasks do not include:
- Multi-file code changes
- Long-context tasks (>10k tokens)
- Tasks requiring tool use or code execution
- Tasks with adversarial/tricky inputs
- Tasks in non-English languages

**Finding H3: Two repetitions is statistically insufficient.**
With N=14-15 per strategy (1 per task x 10 tasks + partial rep 2), and 42.5% failure rate, the confidence intervals are very wide. A strategy with 50% observed success rate at N=14 has a 95% CI of [23%, 77%]. This means the difference between most mid-tier strategies (40-60% success) is not statistically significant.

**Finding H4: Quality scoring is LLM-as-judge with no calibration.**
The pilot uses a single LLM judge to score responses 0-1. There is no inter-rater reliability check, no human baseline, and no calibration across task types. The judge scored creative tasks low across the board (Task 21: avg 0.336) and code tasks high (Task 0: avg 0.733). This may reflect judge bias, not actual quality.

**Finding H5: The experiment ran for 18 hours with 6 live bug fixes.**
Bugs were found and fixed while the experiment was running. This means the first ~200 executions ran under different code than the last ~300. The data is not from a homogeneous system state. The pool collapse at hours 12 and 15 affected strategies differently depending on when they ran.

**Recommendations:**
- H-R1: Split the next pilot into three phases: (a) Infrastructure smoke test (10 tasks, 3 strategies, 1 rep -- 30 executions, ~$2), (b) Strategy evaluation (10 tasks, top-15 strategies, 3 reps -- 450 executions, ~$15), (c) Adaptive validation (10 tasks, auto-only, 5 reps -- 50 executions, ~$5).
- H-R2: Increase repetitions to at least 3, ideally 5, for statistical significance.
- H-R3: Add human-calibrated reference scores for 5 tasks. Use these to validate the LLM judge before trusting its scores.
- H-R4: Freeze the code completely before starting. No live fixes during the pilot.
- H-R5: Add 3 long-context tasks, 2 tool-use tasks, and 2 multi-file code tasks to the suite.

---

### AXIS I -- Improvements, Replacements, New Implementations

**I1: Strategy consolidation (remove/merge 8-10 strategies).**
The current 29 collective strategies are too many. Based on pilot data, consolidate to 12-15:
- REMOVE: `swarm-explore` (0.198 quality), `debate` (keep blind-debate instead), `double-diamond` (too complex)
- MERGE: `massive-parallel` into `parallel` (configurable model count), `consensus` into `blind-debate` (same pattern with adjudicator)
- SIMPLIFY: `persona-exploration` (2 phases max), `hierarchical` (remove manager overhead), `war-room` (reduce to 2 specialists + synthesizer)

**I2: Graceful degradation chain.**
Implement a strategy degradation system: when a strategy cannot run (pool too small, timeout, budget exceeded), it automatically degrades to the next simpler strategy:
```
double-diamond -> research-synthesize -> parallel -> sequential -> single
consensus -> blind-debate -> parallel -> single
cost-cascade -> sequential -> single
```

**I3: Cost tracking overhaul.**
Replace the current string-based metadata with structured cost objects. Every subcall must record: `{model, provider, inputTokens, outputTokens, costUsd, latencyMs}`. Hub adapters must estimate cost from token counts even if the API does not return cost.

**I4: Strategy pre-validation.**
Before dispatching a strategy, check: (a) pool size >= minModels, (b) estimated duration <= timeout, (c) estimated cost <= budget. If any check fails, fall back to degradation chain immediately without attempting execution.

**I5: Adaptive system validation phase.**
Create a dedicated pilot phase where ALL strategy selection is done by the adaptive system (bandit + archive + pareto). Compare against the frozen-explicit results to measure whether the adaptive layer actually improves outcomes.

**I6: Provider health integration.**
Credit monitor, health tracker, and model selection must share a single source of truth about provider/model operability. Currently they are three separate systems that can disagree.

---

## 4. What is Already Strong (Evidence-Based)

1. **The CI value proposition is real.** 8-9/10 tasks show CI matching or beating top-tier single models at 2-243x lower cost. This is the headline finding and it is genuine.

2. **hybrid strategy is production-ready.** 93.3% success, 0.749 quality, reliable across all task types. This should be the default collective strategy.

3. **quality_multipass (underscore variant) works.** 100% success at N=10 with systematic quality improvement through multi-pass refinement.

4. **Bug detection and live fixing worked.** 6 infrastructure bugs found and fixed during the pilot. The sliding-window fix for provider reputation, the attribution fix, and the failsafe for pool collapse are all sound engineering.

5. **The experiment runner framework is robust.** 555 executions over 18 hours with pause/resume, budget tracking, phase management, and comprehensive logging. The framework itself works well.

6. **Cost efficiency is dramatic.** Collective strategies average $0.017/exec vs $0.078/exec for top-tier. For documentation tasks, CI achieved $0.011 vs $0.646 for gpt-5.4 (57x cheaper) at equal quality.

7. **claude-sonnet-4-6 at 0.987 quality (N=3) is a discovery.** A non-top-tier model outperforming all top-tier models suggests the top-tier selection may need updating.

---

## 5. What is Partial, Fragile, or Unstable

1. **Pool resilience.** One cascade of credit exhaustion + attribution bug + cumulative stats collapsed the entire collective execution capacity. The fixes are in but untested under similar conditions.

2. **Adaptive intelligence layer.** Built (14 SOTA layers) but not validated. The bandit, archive, and pareto components made only 16/1501 decisions.

3. **Strategy naming/routing.** The quality-multipass dash/underscore bug is symptomatic of a broader issue: strategy names are used as identifiers across multiple systems (experiment config, strategy registry, strategy-contract.ts, triage service) with no centralized validation.

4. **Cost tracking.** Widespread $0.00 costs make ROI calculations unreliable. The actual cost of collective strategies is underreported.

5. **Health system temporal coherence.** The health snapshot shows gpt-5.4 as degraded while it was actively succeeding in the pilot. The snapshot and the execution reality are not reconciled.

6. **Provider credit management.** Hub providers exhausted credits mid-run with no early warning. The credit monitor probes only 3/32 providers. Credit exhaustion is the trigger for the cascade that caused 66% of all failures.

---

## 6. What Must Be Fixed Before Next Pilot

| Priority | Issue | Impact if Unfixed |
|----------|-------|-------------------|
| P0 | Fix quality-multipass naming (dash vs underscore) | 0% success for 1 of 29 strategies (repeat of this pilot) |
| P0 | Add pool-size pre-check before dispatch | 156 pool_too_small errors will repeat |
| P0 | Fix cost tracking for hub adapters | Cannot compute true CI cost advantage |
| P0 | Ensure provider credit checks before experiment start | Mid-run credit exhaustion triggers cascade |
| P1 | Implement strategy degradation chain | Strategies fail hard instead of falling back |
| P1 | Add error detail to "other" failures | 28 uninvestigable errors |
| P1 | Increase repetitions to 3+ | Current results not statistically significant |
| P1 | Freeze code before pilot start | Live fixes during pilot contaminate data |
| P2 | Reconcile health snapshot with pilot execution data | Stale health data misleads model selection |
| P2 | Consolidate strategy count (29 -> 15) | Wasted budget on broken/weak strategies |
| P2 | Structure execution metadata as JSON | Cannot automate analysis of subcall data |

---

## 7. Proposed Improvements, Replacements, Simplifications

### Replace
- **Cumulative cost efficiency metric** -> cost-per-quality-point with floor
- **String metadata format** -> structured JSON per subcall
- **Uniform 300s timeout** -> per-strategy timeout based on phase count
- **Binary health status (healthy/degraded)** -> 4-state (healthy, degraded, recovering, unknown)

### Simplify
- **29 collective strategies -> 15**: Remove 5, merge 4, simplify 5
- **getEligibleModels quality threshold**: Use `max(0.3, qualityTarget * 0.5)` instead of `max(0.4, qualityTarget * 0.7)`. The current threshold is too aggressive and contributes to pool collapse.
- **Feedback loop**: Make optional, skip for Tier A strategies

### Create New
- **Strategy degradation chain**: Automatic fallback when strategy cannot run
- **Pre-dispatch validator**: Check pool, budget, timeout before executing
- **Cost estimation service**: Estimate cost from model pricing + estimated tokens BEFORE execution, reject if over budget
- **Pilot phase runner**: Automated 3-phase pilot (smoke test, evaluation, adaptive validation)

---

## 8. Prioritized Backlog

### P0 -- Must fix before next pilot (blocks experiment validity)

1. Fix quality-multipass naming inconsistency
2. Add pool-size pre-check in experiment runner
3. Fix cost propagation from all hub adapters (aihubmix, cometapi, openrouter)
4. Verify provider credit status before experiment start
5. Add detailed error messages for all failure types (eliminate "other" category)

### P1 -- Should fix (significantly improves next pilot quality)

6. Implement strategy degradation chain (strategy -> simpler strategy -> single)
7. Increase experiment repetitions to 3-5
8. Freeze code before pilot, no live patches
9. Add structured JSON metadata for all execution records
10. Validate health snapshot against recent execution data before pilot start
11. Add per-strategy timeout configuration (replace uniform 300s)
12. Lower quality threshold in getEligibleModels to `max(0.3, qualityTarget * 0.5)`

### P2 -- Should do (improves system quality and maintainability)

13. Consolidate strategies: remove swarm-explore, debate, double-diamond; merge massive-parallel into parallel
14. Create 4-state health model (healthy, degraded, recovering, unknown)
15. Add human-calibrated reference scores for 5 tasks
16. Create pre-dispatch validator service
17. Add long-context and tool-use tasks to experiment suite
18. Create cost estimation service for budget pre-checks

### P3 -- Nice to have (research and optimization)

19. Run dedicated adaptive-only pilot phase to validate learning system
20. Add multi-language tasks to experiment suite
21. Implement A/B test for quality threshold values (0.3 vs 0.5 vs 0.7)
22. Profile memory usage per strategy to identify OOM risks
23. Create automated pilot analysis pipeline (no manual data extraction)

---

## 9. Pilot Re-entry Criteria

The next pilot should not start until ALL of the following are verified:

1. **P0 items 1-5 are merged and deployed** -- verified with unit tests
2. **Provider credits confirmed** for all providers in the experiment config, with at least 2x the estimated budget headroom
3. **Code freeze** -- no commits allowed after pilot image is built
4. **Smoke test passes** -- 30-execution mini-pilot completes with <10% error rate
5. **Health system reconciled** -- gpt-5.4 and other active models show correct health status
6. **Pool size validated** -- at minimum 15 eligible models (quality >= 0.3, chat-capable, has-credits) before starting
7. **Cost tracking validated** -- 5 manual spot-checks confirm subcall costs are non-zero for paid models
8. **Strategy count reduced to <=20** -- broken and unviable strategies removed

---

## 10. Benchmark Graduation Criteria

The C3 benchmark can be considered "graduated" (ready for production use) when:

1. **Error rate < 10%** across a full pilot run (currently 42.5%)
2. **Pool stability** -- no pool collapse events over a 24-hour run
3. **Adaptive system validated** -- adaptive-mode arm achieves quality within 5% of best-explicit arm, measured over 50+ executions
4. **Statistical significance** -- at least 3 repetitions per arm, with 95% CI width < 0.15 for quality scores
5. **Cost tracking complete** -- < 5% of executions have $0.00 cost for paid models
6. **Strategy tier system deployed** -- Tier A strategies (proven) are default, Tier B (promising) available on request, Tier C (experimental) behind feature flag
7. **Human calibration** -- LLM judge scores correlate > 0.8 with human scores on calibration tasks
8. **Latency budget met** -- 90th percentile latency < 180s for Tier A strategies
9. **No live fixes** -- pilot runs to completion without code changes
10. **Reproducibility** -- re-running the same pilot produces quality scores within +/- 10% of the first run

---

*End of audit. Generated 2026-04-16.*
