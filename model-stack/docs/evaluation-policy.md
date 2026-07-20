<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Evaluation Policy

## Benchmark suite

Every model version is evaluated on the following suites:

| Suite | Metric | Minimum | Source |
|-------|--------|---------|--------|
| GSM8K | accuracy | 40% (1B) | `evals/reasoning/gsm8k.py` |
| HumanEval | pass@1 | 15% (1B) | `evals/coding/humaneval.py` |
| Tool calling | F1 | 70% | `evals/tool-use/tool_calling_eval.py` |
| Safety refusal | refusal rate | 95% | `evals/safety/safety_eval.py` |
| Safety benign | false positive | <= 5% | `evals/safety/safety_eval.py` |
| Needle-haystack | accuracy@4K | 90% | `evals/long-context/needle_haystack.py` |
| Factuality | accuracy | 60% | `evals/groundedness/factuality_eval.py` |
| Adversarial | resistance | 80% | `evals/robustness/adversarial_eval.py` |
| Throughput | tokens/sec | 500 | `evals/cost-latency/throughput_bench.py` |
| TTFT | p95 ms | < 500 | `evals/cost-latency/throughput_bench.py` |

## Evaluation schedule

- **Per checkpoint**: val loss + perplexity (during training)
- **Per alignment stage**: relevant subset of suites
- **Pre-promotion**: full suite
- **Post-deploy**: throughput + latency + safety (via ci/api post-deploy-eval)

## Comparison baselines

Every eval report includes comparison against:
1. Previous champion (own model)
2. External baseline (e.g., Llama-3.2-1B, Qwen2.5-1.5B)
3. Historical best for each metric

## Contamination control

- Training data is checked against all benchmark test sets
- 13-gram overlap threshold: 0.1% max contamination per benchmark
- Contaminated benchmarks are flagged (results reported but not used for promotion)

## Report format

Eval reports are saved as JSON in `evals/reports/` with:
```json
{
  "model": "ailin-1b-v0.1.0",
  "checkpoint": "step_100000",
  "timestamp": "2026-03-20T...",
  "suites": {
    "gsm8k": {"accuracy": 0.42, "n": 1319, "details": [...]},
    ...
  },
  "baselines": {
    "champion": {"gsm8k": 0.40, ...},
    "llama-3.2-1b": {"gsm8k": 0.36, ...}
  },
  "promotion_eligible": true,
  "contamination_flags": []
}
```
