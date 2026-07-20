<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# C3 Pilot — Supplementary Data

**Companion to:** c3-pilot-full-execution-log.md  
**Generated:** 2026-04-16 01:50 UTC  

---

## 1. Experiment Configuration

```json
{
  "name": "C3 Pilot — Infrastructure Validation",
  "modes": [
    {
      "mode": "single-model",
      "modelId": "gpt-5.4",
      "displayName": "gpt-5.4 (aihubmix)",
      "qualityTarget": 0.95,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-model",
      "modelId": "claude-opus-4-6",
      "displayName": "claude-opus-4-6 (aihubmix)",
      "qualityTarget": 0.95,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-model",
      "modelId": "gemini-3.1-pro-preview",
      "displayName": "gemini-3.1-pro-preview (aihubmix)",
      "qualityTarget": 0.95,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-model",
      "modelId": "grok-4",
      "displayName": "grok-4 (aihubmix)",
      "qualityTarget": 0.95,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-model",
      "modelId": "deepseek-chat",
      "displayName": "deepseek-chat (aihubmix)",
      "qualityTarget": 0.95,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-model",
      "modelId": "mistral-large-latest",
      "displayName": "mistral-large-latest (aihubmix)",
      "qualityTarget": 0.95,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "collaborative",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "parallel",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "sequential",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "hybrid",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "competitive",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "expert-panel",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "massive-parallel",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "cost-cascade",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "quality-multipass",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "adaptive",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "contextual",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "hierarchical",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "consensus",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "reinforcement",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "debate",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "war-room",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "blind-debate",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "devil-advocate-consensus",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "safety-quorum",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "diversity-ensemble",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "stigmergic-refinement",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "swarm-explore",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "clarification-first",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "research-synthesize",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "critique-repair",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "double-diamond",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "multi-hop-qa",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "persona-exploration",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "collective",
      "strategy": "agentic",
      "qualityTarget": 1,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-budget",
      "modelId": "openrouter/bodybuilder",
      "displayName": "Budget: Body Builder (beta)",
      "qualityTarget": 0.3,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "single-budget",
      "modelId": "jamba-large",
      "displayName": "Budget: jamba-large",
      "qualityTarget": 0.3,
      "requiredCapabilities": [
        "chat"
      ]
    },
    {
      "mode": "adaptive",
      "requiredCapabilities": [
        "chat"
      ]
    }
  ],
  "description": "Mini-run to validate C3 infrastructure: scoring path, ablation flags, diversity measurement, ROI recording, budget governance.",
  "repetitions": 2,
  "taskIndices": [
    0,
    1,
    10,
    11,
    20,
    21,
    30,
    31,
    40,
    41
  ],
  "maxBudgetUsd": 25,
  "maxConcurrency": 3,
  "warmupExecutions": 10,
  "delayBetweenCallsMs": 2000,
  "freezeLearningDuringEval": true
}
```

---

## 2. Strategy Weights (Learned)

These weights represent the system's learned preferences per (task_type, complexity) pair.

### analysis / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| debate | 1.3500 | 1.000 | 0.276 | 49.280 | 16 |
| single | 1.3500 | 1.000 | 0.089 | 554.624 | 22 |
| cost-cascade | 0.5000 | 1.000 | 0.364 | 0.000 | 7 |
| quality-multipass | 0.2375 | 1.000 | 0.182 | 3459.716 | 1 |

### analysis / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.552 | 49.154 | 16 |
| debate | 0.7125 | 0.780 | 0.400 | 0.550 | 5 |

### analysis / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.648 | 457.537 | 28 |

### analysis / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5638 | 1.000 | 0.733 | 83.343 | 1 |
| consensus | 1.2350 | 0.820 | 0.730 | 0.700 | 5 |

### analysis / moderate

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1250 | 1.000 | 0.091 | 83.058 | 1 |

### analysis / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 1.3500 | 1.000 | 0.203 | 464.220 | 28 |
| cost-cascade | 0.5000 | 1.000 | 0.404 | 0.000 | 13 |
| quality-multipass | 0.2375 | 1.000 | 0.170 | 131.021 | 1 |

### chat / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1187 | 1.000 | 0.082 | 1472.540 | 2 |

### code-generation / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| parallel | 1.5000 | 1.000 | 0.590 | 693.893 | 62 |
| sequential | 1.3500 | 1.000 | 0.317 | 160.201 | 14 |
| single | 0.1187 | 1.000 | 0.081 | 2108.469 | 4 |

### code-generation / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5586 | 1.000 | 0.610 | 517.491 | 3 |
| parallel | 1.4250 | 0.850 | 0.780 | 0.720 | 5 |

### code-generation / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.757 | 968.415 | 85 |
| single | 0.1375 | 0.900 | 0.090 | 0.950 | 5 |

### code-generation / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.590 | 661.339 | 62 |
| quality-multipass | 0.3325 | 0.830 | 0.205 | 0.650 | 5 |

### code-generation / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| parallel | 1.5000 | 1.000 | 0.775 | 1398.674 | 36 |
| single | 1.3500 | 1.000 | 0.255 | 991.305 | 79 |
| cost-cascade | 0.5000 | 1.000 | 0.466 | 0.000 | 50 |
| sequential | 0.4512 | 1.000 | 0.350 | 170.387 | 2 |
| quality-multipass | 0.2375 | 1.000 | 0.205 | 957.066 | 7 |

### code-review / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| debate | 0.7600 | 0.800 | 0.410 | 0.580 | 5 |

### code-review / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.671 | 720.215 | 30 |
| single | 0.1375 | 0.900 | 0.087 | 0.930 | 5 |

### code-review / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.663 | 181.027 | 14 |
| consensus | 1.3300 | 0.840 | 0.760 | 0.680 | 5 |

### code-review / moderate

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| consensus | 1.5000 | 1.000 | 0.898 | 1485.071 | 15 |
| single | 1.3500 | 1.000 | 0.266 | 354.468 | 41 |
| debate | 1.3500 | 1.000 | 0.270 | 11.123 | 27 |
| cost-cascade | 0.5000 | 1.000 | 0.488 | 0.000 | 42 |
| quality-multipass | 0.2375 | 1.000 | 0.198 | 235.136 | 2 |

### debugging / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.5000 | 1.000 | 0.098 | 0.000 | 15 |

### debugging / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| collaborative | 1.3300 | 0.830 | 0.790 | 0.650 | 5 |
| balanced | 0.5000 | 1.000 | 0.527 | 0.000 | 15 |

### debugging / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.6772 | 1.000 | 0.665 | 628.507 | 3 |

### debugging / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.6022 | 1.000 | 0.718 | 0.000 | 2 |
| collaborative | 1.2350 | 0.820 | 0.760 | 0.680 | 5 |

### debugging / moderate

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| collaborative | 0.9500 | 1.000 | 0.620 | 110.478 | 1 |
| cost-cascade | 0.5000 | 1.000 | 0.390 | 0.000 | 1 |
| single | 0.1250 | 1.000 | 0.099 | 72.872 | 1 |

### debugging / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| cost-cascade | 0.5000 | 1.000 | 0.350 | 0.000 | 3 |
| single | 0.1250 | 1.000 | 0.221 | 525.953 | 7 |

### documentation / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| stigmergic-refinement | 1.0000 | 1.000 | 0.740 | 0.000 | 5 |
| single | 0.1187 | 1.000 | 0.084 | 102.698 | 1 |

### documentation / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 0.8678 | 0.636 | 0.416 | 190.912 | 11 |

### documentation / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1375 | 0.880 | 0.089 | 0.910 | 5 |

### documentation / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1250 | 1.000 | 0.086 | 349.018 | 7 |

### general / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| consensus | 1.5000 | 1.000 | 0.698 | 95.272 | 28 |
| parallel | 1.5000 | 1.000 | 0.702 | 208.405 | 177 |
| cost-cascade | 1.5000 | 1.000 | 0.458 | 336.187 | 85 |
| debate | 1.3500 | 1.000 | 0.299 | 128.706 | 78 |
| single | 1.3500 | 1.000 | 0.309 | 330.239 | 1806 |
| sequential | 1.3500 | 1.000 | 0.361 | 70.049 | 93 |
| quality-multipass | 1.2250 | 1.000 | 0.237 | 178.140 | 40 |
| safety-quorum | 1.0000 | 1.000 | 0.777 | 0.000 | 9 |
| collaborative | 1.0000 | 1.000 | 0.738 | 4.781 | 6 |
| persona-exploration | 1.0000 | 1.000 | 0.690 | 0.000 | 2 |
| research-synthesize | 1.0000 | 1.000 | 0.705 | 4999.999 | 2 |
| multi-hop-qa | 1.0000 | 1.000 | 0.757 | 9.832 | 6 |
| contextual | 1.0000 | 1.000 | 0.784 | 0.000 | 5 |
| massive-parallel | 1.0000 | 1.000 | 0.800 | 0.000 | 5 |
| critique-repair | 1.0000 | 1.000 | 0.713 | 86.617 | 7 |
| double-diamond | 1.0000 | 1.000 | 0.592 | 37.155 | 6 |
| adaptive | 1.0000 | 1.000 | 0.691 | 0.000 | 7 |
| expert-panel | 1.0000 | 1.000 | 0.793 | 2.338 | 7 |
| hierarchical | 1.0000 | 1.000 | 0.794 | 0.000 | 5 |
| hybrid | 1.0000 | 1.000 | 0.717 | 2.851 | 9 |

### general / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.612 | 567.591 | 89 |

### general / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.7379 | 1.000 | 0.626 | 1571.935 | 369 |
| single | 0.1500 | 0.900 | 0.090 | 0.950 | 5 |

### general / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5638 | 1.000 | 0.618 | 1275.424 | 4 |

### general / moderate

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| consensus | 1.5000 | 1.000 | 0.778 | 159.795 | 19 |
| single | 1.3500 | 1.000 | 0.302 | 1332.205 | 814 |
| debate | 1.3500 | 1.000 | 0.304 | 743.060 | 92 |
| expert-panel | 1.3000 | 1.000 | 0.664 | 101.321 | 11 |
| stigmergic-refinement | 1.3000 | 1.000 | 0.702 | 90.231 | 11 |
| swarm-explore | 1.3000 | 1.000 | 0.676 | 59.275 | 15 |
| war-room | 1.3000 | 1.000 | 0.676 | 59.495 | 11 |
| contextual | 1.3000 | 1.000 | 0.702 | 81.726 | 12 |
| blind-debate | 1.3000 | 1.000 | 0.711 | 61.780 | 11 |
| devil-advocate-consensus | 1.3000 | 1.000 | 0.740 | 90.980 | 11 |
| clarification-first | 1.3000 | 1.000 | 0.698 | 34.835 | 13 |
| quality-multipass | 1.2250 | 1.000 | 0.377 | 451.996 | 34 |
| adaptive | 1.2000 | 1.000 | 0.705 | 161.557 | 11 |
| competitive | 1.2000 | 1.000 | 0.666 | 96.112 | 10 |
| reinforcement | 1.2000 | 1.000 | 0.674 | 95.580 | 10 |
| hierarchical | 1.2000 | 1.000 | 0.685 | 98.019 | 10 |
| safety-quorum | 1.2000 | 1.000 | 0.719 | 79.706 | 12 |
| diversity-ensemble | 1.2000 | 1.000 | 0.737 | 101.715 | 10 |
| massive-parallel | 1.2000 | 1.000 | 0.655 | 102.078 | 10 |
| agentic | 1.0000 | 1.000 | 0.680 | 121.696 | 9 |

### general / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| consensus | 1.5000 | 1.000 | 0.802 | 589.975 | 21 |
| parallel | 1.5000 | 1.000 | 0.650 | 2275.279 | 133 |
| debate | 1.3500 | 1.000 | 0.297 | 1891.294 | 280 |
| single | 1.3500 | 1.000 | 0.182 | 3034.676 | 1173 |
| quality-multipass | 1.2250 | 1.000 | 0.274 | 987.774 | 133 |
| adaptive | 1.1025 | 1.000 | 0.815 | 391.269 | 17 |
| agentic | 1.0000 | 1.000 | 0.798 | 0.000 | 5 |
| collaborative | 1.0000 | 1.000 | 0.858 | 2090.169 | 6 |
| massive-parallel | 1.0000 | 1.000 | 0.784 | 16.028 | 8 |
| contextual | 1.0000 | 1.000 | 0.811 | 0.000 | 8 |
| clarification-first | 1.0000 | 1.000 | 0.816 | 0.000 | 7 |
| hierarchical | 1.0000 | 1.000 | 0.814 | 0.000 | 8 |
| expert-panel | 1.0000 | 1.000 | 0.826 | 17.461 | 8 |
| devil-advocate-consensus | 1.0000 | 1.000 | 0.817 | 24.190 | 10 |
| reinforcement | 1.0000 | 1.000 | 0.777 | 0.000 | 8 |
| blind-debate | 1.0000 | 1.000 | 0.814 | 111.151 | 9 |
| war-room | 1.0000 | 1.000 | 0.788 | 9.171 | 9 |
| persona-exploration | 1.0000 | 1.000 | 0.520 | 0.000 | 1 |
| diversity-ensemble | 1.0000 | 1.000 | 0.785 | 68.681 | 8 |
| multi-hop-qa | 1.0000 | 1.000 | 0.790 | 84.015 | 6 |

### qa / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1187 | 1.000 | 0.081 | 65.741 | 4 |

### qa / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.4682 | 1.000 | 0.695 | 100.695 | 1 |

### qa / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5000 | 1.000 | 0.613 | 3155.942 | 62 |
| single | 0.1500 | 0.910 | 0.087 | 0.960 | 5 |

### qa / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1375 | 0.890 | 0.089 | 0.900 | 5 |

### qa / moderate

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1250 | 1.000 | 0.071 | 5937.500 | 3 |

### qa / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 1.3500 | 1.000 | 0.114 | 3276.526 | 60 |

### refactoring / complex

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| expert-panel | 1.0000 | 1.000 | 0.800 | 0.000 | 2 |
| sequential | 0.4512 | 1.000 | 0.370 | 611.601 | 3 |
| quality-multipass | 0.2256 | 1.000 | 0.147 | 419.335 | 3 |
| single | 0.1187 | 1.000 | 0.099 | 948.339 | 2 |

### refactoring / high

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5173 | 1.000 | 0.589 | 421.919 | 3 |
| quality-multipass | 0.3563 | 0.820 | 0.207 | 0.600 | 5 |

### refactoring / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.6747 | 1.000 | 0.794 | 952.632 | 2 |

### refactoring / medium

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.1182 | 0.600 | 0.445 | 367.749 | 5 |
| quality-multipass | 0.3088 | 0.800 | 0.200 | 0.630 | 5 |

### testing / low

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| balanced | 1.5539 | 1.000 | 0.603 | 1824.089 | 2 |

### testing / simple

| Strategy | Weight | Success Rate | Avg Quality | Cost Efficiency | Samples |
|----------|--------|-------------|-------------|-----------------|--------|
| single | 0.1187 | 1.000 | 0.076 | 1833.786 | 2 |

---

## 3. Shadow Evaluations (Regret Analysis)

Each row compares the chosen strategy vs a shadow (alternative) strategy.  
**quality_regret** = how much quality was lost by not picking the shadow.

| Task Type | Complexity | Chosen | Chosen Q | Shadow | Shadow Q | Regret | Winner |
|-----------|-----------|--------|----------|--------|----------|--------|--------|
| general | complex | consensus | 0.720 | single | 0.640 | 0.000 | consensus |
| code-generation | simple | cost-cascade | 0.752 | single | 0.713 | 0.000 | cost-cascade |
| code-generation | simple | cost-cascade | 0.882 | single | 0.840 | 0.000 | cost-cascade |
| analysis | complex | debate | 0.520 | cost-cascade | 0.770 | 0.250 | cost-cascade |
| qa | simple | debate | 0.535 | single | 0.545 | 0.010 | debate |
| code-generation | simple | single | 0.573 | cost-cascade | 0.605 | 0.033 | cost-cascade |
| code-generation | simple | debate | 0.537 | cost-cascade | 0.620 | 0.083 | cost-cascade |
| code-generation | simple | single | 0.833 | cost-cascade | 0.895 | 0.063 | cost-cascade |
| analysis | complex | cost-cascade | 0.550 | single | 0.730 | 0.180 | single |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | simple | single | 0.645 | cost-cascade | 0.590 | 0.000 | single |
| analysis | complex | cost-cascade | 0.650 | single | 0.585 | 0.000 | cost-cascade |
| code-generation | simple | single | 0.610 | cost-cascade | 0.615 | 0.005 | single |
| code-generation | simple | single | 0.713 | cost-cascade | 0.752 | 0.040 | cost-cascade |
| code-generation | complex | single | 0.618 | sequential | 0.603 | 0.000 | single |
| analysis | simple | single | 0.652 | cost-cascade | 0.785 | 0.133 | cost-cascade |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | simple | debate | 0.537 | cost-cascade | 0.698 | 0.160 | cost-cascade |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | complex | sequential | 0.642 | parallel | 0.650 | 0.007 | sequential |
| code-generation | simple | cost-cascade | 0.752 | parallel | 0.807 | 0.055 | parallel |
| code-generation | simple | single | 0.838 | cost-cascade | 0.887 | 0.050 | cost-cascade |
| code-generation | complex | single | 0.637 | sequential | 0.603 | 0.000 | single |
| code-generation | simple | single | 0.660 | cost-cascade | 0.590 | 0.000 | single |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | complex | single | 0.637 | sequential | 0.555 | 0.000 | single |
| code-generation | simple | single | 0.917 | cost-cascade | 0.860 | 0.000 | single |
| code-review | moderate | debate | 0.537 | consensus | 0.863 | 0.325 | consensus |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | simple | debate | 0.537 | cost-cascade | 0.698 | 0.160 | cost-cascade |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | complex | single | 0.642 | sequential | 0.555 | 0.000 | single |
| code-generation | complex | single | 0.662 | sequential | 0.603 | 0.000 | single |
| code-generation | complex | single | 0.637 | sequential | 0.603 | 0.000 | single |
| code-generation | simple | debate | 0.537 | cost-cascade | 0.698 | 0.160 | cost-cascade |
| code-generation | complex | sequential | 0.748 | parallel | 0.627 | 0.000 | sequential |
| code-generation | simple | debate | 0.537 | cost-cascade | 0.838 | 0.300 | cost-cascade |
| code-generation | simple | single | 0.652 | cost-cascade | 0.840 | 0.188 | cost-cascade |
| code-generation | simple | cost-cascade | 0.738 | quality-multipass | 0.838 | 0.100 | quality-multipass |
| code-generation | complex | single | 0.618 | sequential | 0.603 | 0.000 | single |
| analysis | complex | single | 0.670 | debate | 0.520 | 0.000 | single |
| code-generation | simple | quality-multipass | 0.667 | parallel | 0.573 | 0.000 | quality-multipass |
| qa | simple | parallel | 0.570 | single | 0.570 | 0.000 | parallel |
| qa | simple | debate | 0.535 | single | 0.570 | 0.035 | single |
| code-generation | simple | single | 0.630 | quality-multipass | 0.695 | 0.065 | quality-multipass |
| analysis | complex | single | 0.632 | debate | 0.520 | 0.000 | single |
| analysis | complex | single | 0.630 | debate | 0.520 | 0.000 | single |
| code-generation | simple | quality-multipass | 0.858 | parallel | 0.887 | 0.030 | parallel |
| code-generation | complex | single | 0.613 | sequential | 0.510 | 0.000 | single |
| code-generation | complex | competitive | 0.000 | sequential | 0.688 | 0.688 | sequential |
| code-generation | complex | contextual | 0.000 | sequential | 0.860 | 0.860 | sequential |
| code-generation | complex | critique-repair | 0.772 | sequential | 0.853 | 0.080 | sequential |
| code-generation | complex | single | 0.795 | sequential | 0.840 | 0.045 | sequential |
| analysis | complex | single | 0.590 | debate | 0.520 | 0.000 | single |
| analysis | complex | single | 0.555 | debate | 0.520 | 0.000 | single |
| code-generation | complex | single | 0.777 | sequential | 0.777 | 0.000 | single |
| code-generation | simple | contextual | 0.000 | parallel | 0.795 | 0.795 | parallel |
| code-generation | simple | adaptive | 0.865 | parallel | 0.895 | 0.030 | parallel |
| code-generation | simple | reinforcement | 0.000 | parallel | 0.815 | 0.815 | parallel |
| analysis | complex | single | 0.580 | debate | 0.495 | 0.000 | single |
| code-generation | complex | single | 0.735 | sequential | 0.700 | 0.000 | single |
| analysis | complex | single | 0.517 | debate | 0.520 | 0.003 | single |
| analysis | complex | single | 0.515 | debate | 0.520 | 0.005 | single |
| code-generation | complex | single | 0.650 | sequential | 0.610 | 0.000 | single |
| analysis | complex | single | 0.595 | debate | 0.495 | 0.000 | single |
| general | complex | single | 0.593 | safety-quorum | 0.557 | 0.000 | single |
| analysis | complex | cost-cascade | 0.547 | single | 0.537 | 0.000 | cost-cascade |
| code-generation | complex | single | 0.642 | parallel | 0.532 | 0.000 | single |
| analysis | complex | cost-cascade | 0.497 | single | 0.482 | 0.000 | cost-cascade |
| analysis | complex | single | 0.615 | cost-cascade | 0.640 | 0.025 | cost-cascade |
| code-generation | simple | single | 0.777 | parallel | 0.880 | 0.102 | parallel |
| analysis | complex | single | 0.655 | cost-cascade | 0.495 | 0.000 | single |
| code-generation | simple | contextual | 0.868 | parallel | 0.795 | 0.000 | contextual |
| code-generation | complex | single | 0.713 | parallel | 0.713 | 0.000 | single |
| code-generation | simple | single | 0.875 | parallel | 0.902 | 0.028 | parallel |
| code-generation | simple | war-room | 0.620 | parallel | 0.902 | 0.282 | parallel |
| code-generation | complex | single | 0.682 | parallel | 0.405 | 0.000 | single |
| code-generation | simple | quality-multipass | 0.825 | parallel | 0.895 | 0.070 | parallel |
| code-generation | complex | single | 0.675 | parallel | 0.733 | 0.058 | parallel |
| analysis | complex | single | 0.640 | cost-cascade | 0.605 | 0.000 | single |
| code-generation | simple | quality-multipass | 0.887 | parallel | 0.902 | 0.015 | quality-multipass |
| code-generation | complex | single | 0.627 | parallel | 0.588 | 0.000 | single |
| code-generation | simple | single | 0.723 | parallel | 0.890 | 0.168 | parallel |
| code-generation | simple | single | 0.887 | parallel | 0.868 | 0.000 | single |
| code-generation | simple | multi-hop-qa | 0.735 | parallel | 0.825 | 0.090 | parallel |
| analysis | complex | single | 0.667 | cost-cascade | 0.615 | 0.000 | single |
| code-generation | simple | quality-multipass | 0.917 | parallel | 0.895 | 0.000 | quality-multipass |

---

## 4. Model Health Snapshot

Total tracked: 606 | Healthy: 230 | Degraded: 376

### Degraded Models (top 50 by error rate)

| Model | Status | Error Rate | Latency (ms) | Last Checked |
|-------|--------|-----------|-------------|-------------|
| gpt-5.4 | degraded | 1.00 | — | 2026-04-15T07:06:15 |
| z-ai/glm-5.1 | degraded | 1.00 | — | 2026-04-10T02:07:41 |
| deepseek-reasoner | degraded | 1.00 | — | 2026-04-15T18:01:17 |
| ahm-Phi-3-medium-128k | degraded | 1.00 | — | 2026-04-09T18:20:04 |
| aion-1.0-mini | degraded | 1.00 | — | 2026-04-09T19:01:04 |
| abab5.5s-chat | degraded | 1.00 | — | 2026-04-09T18:13:04 |
| act_two | degraded | 1.00 | — | 2026-04-09T18:46:04 |
| speakleash/bielik-11b-v2.3-instruct | degraded | 1.00 | — | 2026-04-11T15:47:03 |
| vertex/gemini-2.5-flash-lite@europe-west1 | degraded | 1.00 | — | 2026-04-14T12:08:44 |
| x-ai/grok-4-1-fast-non-reasoning | degraded | 1.00 | — | 2026-04-09T18:43:04 |
| xai/grok-4-1-fast | degraded | 1.00 | — | 2026-04-14T01:54:34 |
| zhipu/glm-ocr | degraded | 1.00 | — | 2026-04-09T18:45:04 |
| aai/slam-1 | degraded | 1.00 | — | 2026-04-09T18:45:04 |
| aai/universal | degraded | 1.00 | — | 2026-04-09T18:45:04 |
| abab6.5t-chat | degraded | 1.00 | — | 2026-04-09T18:46:04 |
| abab6-chat | degraded | 1.00 | — | 2026-04-09T18:46:04 |
| abab7-chat-preview | degraded | 1.00 | — | 2026-04-09T18:46:04 |
| rakuten/rakutenai-7b-instruct | degraded | 1.00 | — | 2026-04-11T15:46:03 |
| snowflake/arctic-embed-l | degraded | 1.00 | — | 2026-04-11T15:47:03 |
| xai/grok-4.20-multi-agent-beta-0309 | degraded | 1.00 | — | 2026-04-14T01:55:32 |
| xai/grok-4-fast-reasoning | degraded | 1.00 | — | 2026-03-30T04:01:34 |
| gemini-3.1-flash-lite | degraded | 1.00 | — | 2026-04-15T18:00:18 |
| anyscale@mistralai/Mistral-7B-Instruct-v0.1 | degraded | 1.00 | — | 2026-04-15T15:23:14 |
| anyscale@meta-llama/Llama-2-70b-chat-hf | degraded | 1.00 | — | 2026-04-15T15:26:14 |
| microsoft/phi-3-mini-128k-instruct | degraded | 1.00 | — | 2026-04-14T00:52:28 |
| meta/llama-4-scout-17b-16e-instruct | degraded | 1.00 | — | 2026-04-15T15:26:14 |
| zai-org/GLM-5.1 | degraded | 1.00 | — | 2026-04-14T02:59:54 |
| anthropic/claude-opus-4-5 | degraded | 1.00 | — | 2026-04-15T18:32:55 |
| anthropic/claude-opus-4-1 | degraded | 1.00 | — | 2026-04-15T18:33:55 |
| zai-glm-4.5-air | degraded | 1.00 | — | 2026-04-14T02:35:53 |
| google@meta/llama-4-scout-17b-16e-instruct-maas | degraded | 1.00 | — | 2026-04-15T15:31:14 |
| google/codegemma-1.1-7b | degraded | 1.00 | — | 2026-04-14T00:59:28 |
| openai/gpt-5.2 | degraded | 1.00 | — | 2026-04-14T01:58:35 |
| nvidia/nemotron-nano-3-30b-a3b | degraded | 1.00 | — | 2026-04-14T01:08:28 |
| writer/palmyra-med-70b-32k | degraded | 1.00 | — | 2026-04-15T17:13:17 |
| sao10k/l3-lunaris-8b | degraded | 1.00 | — | 2026-04-14T03:00:59 |
| sophnet-minimax-m2.5 | degraded | 1.00 | — | 2026-04-14T01:11:29 |
| deepseek/deepseek-chat-v3.1 | degraded | 1.00 | — | 2026-04-15T17:13:17 |
| x-ai/grok-code-fast-1 | degraded | 1.00 | — | 2026-03-30T06:06:53 |
| openai-responses/gpt-5-codex | degraded | 1.00 | — | 2026-04-14T12:08:44 |
| huggingface@EleutherAI/gpt-neox-20b | degraded | 1.00 | — | 2026-04-15T15:31:14 |
| vertex/claude-opus-4-5@europe-west1 | degraded | 1.00 | — | 2026-04-14T12:09:47 |
| vertex/claude-opus-4-6@us-east5 | degraded | 1.00 | — | 2026-04-14T12:09:47 |
| vertex/claude-opus-4-5@us-east5 | degraded | 1.00 | — | 2026-04-14T12:09:47 |
| gpt-5.3-codex | degraded | 1.00 | — | 2026-04-14T01:19:29 |
| togetherai@meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8 | degraded | 1.00 | — | 2026-04-15T15:31:14 |
| gpt-realtime-mini-2025-12-15 | degraded | 1.00 | — | 2026-04-14T01:19:29 |
| jina-ai/jina-reranker-v1-tiny-en | degraded | 1.00 | — | 2026-04-14T00:53:28 |
| zai-glm-4.5v | degraded | 1.00 | — | 2026-04-14T02:53:06 |
| xai/grok-4.20-beta-0309-reasoning | degraded | 1.00 | — | 2026-04-14T01:55:33 |

### Healthy Models (top 50 by latency)

| Model | Status | Error Rate | Latency (ms) | Last Checked |
|-------|--------|-----------|-------------|-------------|
| nvidia/gliner-pii | healthy | 0.00 | 170 | 2026-04-15T16:43:44 |
| devstral-small-latest | healthy | 0.00 | 781 | 2026-04-14T01:17:30 |
| amazon/nova-micro-v1 | healthy | 0.00 | 1078 | 2026-03-30T06:53:38 |
| allenai/olmo-3.1-32b-instruct | healthy | 0.00 | 1152 | 2026-04-02T10:03:44 |
| fireworks/minimax-m2.5 | healthy | 0.00 | 1265 | 2026-04-10T03:50:53 |
| llama-4-maverick | healthy | 0.00 | 1519 | 2026-04-15T03:07:14 |
| bytedance-seed/seed-1.6-flash | healthy | 0.00 | 1616 | 2026-03-30T06:17:53 |
| amazon/nova-lite-v1 | healthy | 0.20 | 1665 | 2026-04-02T04:57:58 |
| google/gemma-4-26b-a4b-it | healthy | 0.00 | 1795 | 2026-04-15T07:09:15 |
| openai/gpt-4o-mini-search-preview | healthy | 0.00 | 1800 | 2026-04-09T18:14:04 |
| deepinfra/google/gemini-2.5-flash | healthy | 0.00 | 1846 | 2026-04-15T07:05:15 |
| openai/gpt-4o | healthy | 0.00 | 2181 | 2026-04-15T09:34:31 |
| amazon/qwen.qwen3-32b-v1:0 | healthy | 0.10 | 2235 | 2026-04-15T02:30:32 |
| z-ai/glm-4-32b | healthy | 0.00 | 2282 | 2026-03-30T05:50:51 |
| anthropic/claude-3.7-sonnet | healthy | 0.00 | 2290 | 2026-04-09T18:36:04 |
| xiaomi/mimo-v2-omni | healthy | 0.00 | 2463 | 2026-03-30T06:22:53 |
| claude-3-haiku-20240307 | healthy | 0.22 | 2471 | 2026-04-15T13:58:19 |
| pixtral-large-latest | healthy | 0.00 | 2474 | 2026-04-14T12:07:44 |
| devstral-medium-latest | healthy | 0.00 | 2490 | 2026-04-16T01:07:58 |
| nousresearch/hermes-4-70b | healthy | 0.00 | 2590 | 2026-04-14T02:42:49 |
| nousresearch/hermes-2-pro-llama-3-8b | healthy | 0.07 | 2600 | 2026-04-14T01:00:28 |
| THUDM/GLM-4-32B-0414 | healthy | 0.00 | 2605 | 2026-04-15T02:27:32 |
| mistral-medium-2505 | healthy | 0.00 | 2632 | 2026-04-14T02:57:54 |
| anthropic/claude-3.5-haiku | healthy | 0.00 | 2678 | 2026-03-30T04:01:33 |
| baidu/ernie-4.5-21B-a3b | healthy | 0.00 | 2692 | 2026-04-14T00:54:28 |
| abacusai/dracarys-llama-3.1-70b-instruct | healthy | 0.00 | 2753 | 2026-04-10T17:33:38 |
| qwen/qwen3-coder-480b-a35b-instruct | healthy | 0.00 | 2844 | 2026-04-15T03:11:14 |
| deepinfra/mistralai/Mistral-Small-3.2-24B-Instruct-2506 | healthy | 0.00 | 3085 | 2026-04-15T08:37:17 |
| mistral-large-2512 | healthy | 0.01 | 3155 | 2026-04-14T01:25:29 |
| mistral-small-2501 | healthy | 0.00 | 3198 | 2026-04-14T02:59:54 |
| google/gemini-3.1-flash-image-preview | healthy | 0.00 | 3327 | 2026-04-14T01:23:29 |
| meta/llama-3.1-8b-instruct | healthy | 0.00 | 3389 | 2026-04-15T07:51:17 |
| amazon/qwen.qwen3-coder-30b-a3b-v1:0 | healthy | 0.00 | 3448 | 2026-04-15T08:32:17 |
| baidu/ernie-4.5-vl-28b-a3b-thinking | healthy | 0.00 | 3618 | 2026-04-15T02:13:31 |
| ministral-3b-2512 | healthy | 0.00 | 3644 | 2026-04-16T01:44:16 |
| qwen/qwen3-coder-next | healthy | 0.00 | 3680 | 2026-04-14T01:27:32 |
| undi95/remm-slerp-l2-13b | healthy | 0.17 | 4012 | 2026-04-15T12:18:51 |
| liquid/lfm-2.5-1.2b-thinking:free | healthy | 0.29 | 4245 | 2026-04-15T12:32:51 |
| brave-pro | healthy | 0.09 | 4471 | 2026-04-15T08:31:17 |
| amazon/amazon.nova-lite-v1:0 | healthy | 0.00 | 4998 | 2026-04-15T07:43:17 |
| amazon/mistral.voxtral-mini-3b-2507 | healthy | 0.00 | 5111 | 2026-04-15T02:34:32 |
| claude-sonnet-4-5-20250929 | healthy | 0.00 | 5342 | 2026-04-15T17:58:17 |
| google/gemini-flash-lite-latest | healthy | 0.10 | 5353 | 2026-04-15T09:48:32 |
| web-search | healthy | 0.00 | 5358 | 2026-04-15T07:57:18 |
| mistral-large-pixtral-2411 | healthy | 0.00 | 5386 | 2026-04-14T01:30:31 |
| nvidia/nemotron-3-nano-30b-a3b:free | healthy | 0.00 | 5794 | 2026-04-15T12:37:51 |
| assistant | healthy | 0.00 | 5932 | 2026-04-15T03:34:14 |
| mistralai/mixtral-8x7b-instruct-v0.1 | healthy | 0.00 | 5988 | 2026-04-15T08:26:17 |
| mistral-small-2506 | healthy | 0.00 | 6022 | 2026-04-16T01:36:15 |
| baidu/ernie-4.5-21B-a3b-thinking | healthy | 0.00 | 6070 | 2026-04-11T07:06:00 |

---

## 5. Execution Outcomes Detail

Total outcomes recorded: 1082

| Metric | Value |
|--------|-------|
| With retries (>0) | 1082 (100.0%) |
| With fallback | 0 (0.0%) |
| With escalation | 177 (16.4%) |
| Avg feedback iterations | 1.6 |

### Per-Strategy Outcome Details

| Strategy | OK | Err | Retries | Fallbacks | Escalations |
|----------|----|----|---------|-----------|------------|
| single | 587 | 0 | 587 | 0 | 0 |
| parallel | 166 | 2 | 168 | 0 | 149 |
| quality-multipass | 34 | 0 | 34 | 0 | 0 |
| cost-cascade | 30 | 0 | 30 | 0 | 28 |
| adaptive | 20 | 0 | 20 | 0 | 0 |
| sequential | 16 | 1 | 17 | 0 | 0 |
| hybrid | 16 | 0 | 16 | 0 | 0 |
| safety-quorum | 5 | 10 | 15 | 0 | 0 |
| war-room | 12 | 2 | 14 | 0 | 0 |
| devil-advocate-consensus | 11 | 2 | 13 | 0 | 0 |
| stigmergic-refinement | 9 | 4 | 13 | 0 | 0 |
| expert-panel | 9 | 3 | 12 | 0 | 0 |
| swarm-explore | 9 | 3 | 12 | 0 | 0 |
| collaborative | 11 | 0 | 11 | 0 | 0 |
| blind-debate | 10 | 1 | 11 | 0 | 0 |
| competitive | 8 | 2 | 10 | 0 | 0 |
| clarification-first | 6 | 3 | 9 | 0 | 0 |
| massive-parallel | 4 | 4 | 8 | 0 | 0 |
| hierarchical | 5 | 3 | 8 | 0 | 0 |
| reinforcement | 5 | 3 | 8 | 0 | 0 |
| diversity-ensemble | 6 | 2 | 8 | 0 | 0 |
| agentic | 6 | 2 | 8 | 0 | 0 |
| contextual | 6 | 2 | 8 | 0 | 0 |
| consensus | 7 | 0 | 7 | 0 | 0 |
| critique-repair | 7 | 0 | 7 | 0 | 0 |
| debate | 5 | 1 | 6 | 0 | 0 |
| multi-hop-qa | 5 | 1 | 6 | 0 | 0 |
| double-diamond | 6 | 0 | 6 | 0 | 0 |
| persona-exploration | 5 | 0 | 5 | 0 | 0 |
| research-synthesize | 5 | 0 | 5 | 0 | 0 |

---

## 6. Decision Audit

Total decisions recorded: 1501

### Selection Reason Distribution

| Reason | Count |
|--------|-------|
| explicit | 1483 |
| pareto | 8 |
| archive | 5 |
| bandit | 3 |
| heuristic | 2 |

### Selected Strategy Distribution

| Strategy | Times Selected |
|----------|---------------|
| single | 819 |
| debate | 63 |
| quality-multipass | 48 |
| safety-quorum | 32 |
| blind-debate | 30 |
| devil-advocate-consensus | 30 |
| persona-exploration | 30 |
| research-synthesize | 27 |
| cost-cascade | 26 |
| double-diamond | 26 |
| adaptive | 25 |
| war-room | 24 |
| swarm-explore | 23 |
| parallel | 22 |
| stigmergic-refinement | 22 |
| expert-panel | 20 |
| agentic | 20 |
| collaborative | 19 |
| hybrid | 19 |
| sequential | 18 |
| diversity-ensemble | 17 |
| clarification-first | 17 |
| multi-hop-qa | 17 |
| competitive | 16 |
| contextual | 16 |
| consensus | 16 |
| massive-parallel | 15 |
| hierarchical | 15 |
| critique-repair | 15 |
| reinforcement | 14 |

### Triage Confidence Distribution

| Confidence | Count |
|-----------|-------|
| high (>0.8) | 0 |
| medium (0.5-0.8) | 0 |
| low (<0.5) | 8 |
| none | 1493 |

### Full Decision Audit Log

| # | Time | Task Type | Complexity | Requested | Selected | Reason | Confidence | Expected Q | Models Selected |
|---|------|-----------|-----------|-----------|----------|--------|------------|------------|----------------|
| 1 | 07:04:04 | general | simple | single | single | explicit | — | — |  |
| 2 | 07:04:53 | general | simple | single | single | explicit | — | — |  |
| 3 | 07:05:30 | general | moderate | single | single | explicit | — | — |  |
| 4 | 07:05:30 | general | moderate | single | single | explicit | — | — |  |
| 5 | 07:05:31 | general | moderate | single | single | explicit | — | — |  |
| 6 | 07:07:15 | reasoning | complex | single | single | explicit | — | — |  |
| 7 | 07:07:25 | analysis | complex | single | single | explicit | — | — |  |
| 8 | 07:07:39 | code-generation | complex | single | single | explicit | — | — |  |
| 9 | 07:08:07 | general | moderate | single | single | explicit | — | — |  |
| 10 | 07:08:15 | analysis | complex | single | single | explicit | — | — |  |
| 11 | 07:08:32 | code-generation | complex | single | single | explicit | — | — |  |
| 12 | 07:09:06 | analysis | complex | single | single | explicit | — | — |  |
| 13 | 07:09:25 | general | moderate | single | single | explicit | — | — |  |
| 14 | 07:10:07 | general | moderate | single | single | explicit | — | — |  |
| 15 | 07:12:09 | code-generation | complex | single | single | explicit | — | — |  |
| 16 | 07:12:41 | general | moderate | single | single | explicit | — | — |  |
| 17 | 07:13:09 | general | moderate | collaborative | collaborative | explicit | — | — |  |
| 18 | 07:13:56 | architecture | complex | single | single | explicit | — | — |  |
| 19 | 07:14:57 | architecture | complex | single | single | explicit | — | — |  |
| 20 | 07:16:08 | architecture | complex | single | single | explicit | — | — |  |
| 21 | 07:16:27 | general | moderate | parallel | parallel | explicit | — | — |  |
| 22 | 07:17:29 | code-generation | complex | single | single | explicit | — | — |  |
| 23 | 07:17:56 | general | moderate | single | single | explicit | — | — |  |
| 24 | 07:18:26 | general | moderate | sequential | sequential | explicit | — | — |  |
| 25 | 07:18:39 | code-generation | complex | single | single | explicit | — | — |  |
| 26 | 07:19:36 | code-generation | complex | single | single | explicit | — | — |  |
| 27 | 07:20:03 | code-generation | complex | single | single | explicit | — | — |  |
| 28 | 07:20:37 | general | moderate | hybrid | hybrid | explicit | — | — |  |
| 29 | 07:21:02 | code-generation | complex | single | single | explicit | — | — |  |
| 30 | 07:21:47 | analysis | complex | single | single | explicit | — | — |  |
| 31 | 07:22:37 | code-generation | complex | single | single | explicit | — | — |  |
| 32 | 07:22:48 | analysis | complex | single | single | explicit | — | — |  |
| 33 | 07:22:58 | general | moderate | competitive | competitive | explicit | — | — |  |
| 34 | 07:23:05 | code-generation | complex | single | single | explicit | — | — |  |
| 35 | 07:23:48 | analysis | complex | single | single | explicit | — | — |  |
| 36 | 07:24:00 | general | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 37 | 07:24:15 | analysis | complex | single | single | explicit | — | — |  |
| 38 | 07:24:34 | analysis | complex | single | single | explicit | — | — |  |
| 39 | 07:25:08 | analysis | complex | single | single | explicit | — | — |  |
| 40 | 07:25:52 | general | moderate | massive-parallel | massive-parallel | explicit | — | — |  |
| 41 | 07:26:14 | analysis | complex | single | single | explicit | — | — |  |
| 42 | 07:27:08 | analysis | complex | single | single | explicit | — | — |  |
| 43 | 07:27:15 | code-generation | complex | single | single | explicit | — | — |  |
| 44 | 07:28:15 | code-generation | complex | single | single | explicit | — | — |  |
| 45 | 07:28:26 | general | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 46 | 07:29:11 | general | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 47 | 07:29:15 | code-generation | complex | single | single | explicit | — | — |  |
| 48 | 07:30:15 | code-generation | complex | single | single | explicit | — | — |  |
| 49 | 07:31:31 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 50 | 07:33:39 | general | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 51 | 07:34:28 | general | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 52 | 07:35:18 | code-generation | complex | single | single | explicit | — | — |  |
| 53 | 07:36:24 | general | moderate | adaptive | adaptive | explicit | — | — |  |
| 54 | 07:37:48 | code-generation | complex | single | single | explicit | — | — |  |
| 55 | 07:38:36 | general | moderate | contextual | contextual | explicit | — | — |  |
| 56 | 07:38:44 | general | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 57 | 07:38:52 | analysis | complex | single | single | explicit | — | — |  |
| 58 | 07:39:20 | analysis | complex | single | single | explicit | — | — |  |
| 59 | 07:39:31 | general | moderate | hierarchical | hierarchical | explicit | — | — |  |
| 60 | 07:41:36 | analysis | complex | single | single | explicit | — | — |  |
| 61 | 07:42:25 | general | moderate | reinforcement | reinforcement | explicit | — | — |  |
| 62 | 07:43:32 | general | moderate | debate | debate | explicit | — | — |  |
| 63 | 07:43:55 | analysis | complex | single | single | explicit | — | — |  |
| 64 | 07:44:37 | code-generation | complex | single | single | explicit | — | — |  |
| 65 | 07:44:50 | general | moderate | war-room | war-room | explicit | — | — |  |
| 66 | 07:45:02 | general | moderate | debate | debate | explicit | — | — |  |
| 67 | 07:45:03 | general | moderate | blind-debate | blind-debate | explicit | — | — |  |
| 68 | 07:46:33 | general | moderate | debate | debate | explicit | — | — |  |
| 69 | 07:48:09 | general | moderate | debate | debate | explicit | — | — |  |
| 70 | 07:49:37 | code-generation | complex | single | single | explicit | — | — |  |
| 71 | 07:49:47 | general | moderate | debate | debate | explicit | — | — |  |
| 72 | 07:49:55 | general | moderate | war-room | war-room | explicit | — | — |  |
| 73 | 07:50:02 | general | moderate | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 74 | 07:51:42 | code-generation | complex | single | single | explicit | — | — |  |
| 75 | 07:52:18 | analysis | complex | single | single | explicit | — | — |  |
| 76 | 07:52:43 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 77 | 07:53:11 | general | moderate | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 78 | 07:53:36 | code-generation | complex | single | single | explicit | — | — |  |
| 79 | 07:54:24 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 80 | 07:54:27 | architecture | complex | single | single | explicit | — | — |  |
| 81 | 07:55:02 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 82 | 07:55:03 | analysis | complex | single | single | explicit | — | — |  |
| 83 | 07:56:03 | analysis | complex | single | single | explicit | — | — |  |
| 84 | 07:56:08 | code-generation | complex | single | single | explicit | — | — |  |
| 85 | 07:56:58 | general | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 86 | 07:57:08 | code-generation | complex | single | single | explicit | — | — |  |
| 87 | 07:58:08 | code-generation | complex | single | single | explicit | — | — |  |
| 88 | 07:59:08 | code-generation | complex | single | single | explicit | — | — |  |
| 89 | 07:59:50 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 90 | 08:00:10 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 91 | 08:00:54 | general | complex | single | single | explicit | — | — |  |
| 92 | 08:01:41 | general | moderate | critique-repair | critique-repair | explicit | — | — |  |
| 93 | 08:02:11 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 94 | 08:04:12 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 95 | 08:05:05 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 96 | 08:05:15 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 97 | 08:06:46 | general | moderate | critique-repair | critique-repair | explicit | — | — |  |
| 98 | 08:06:58 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 99 | 08:07:15 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 100 | 08:08:56 | analysis | complex | single | single | explicit | — | — |  |
| 101 | 08:09:26 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 102 | 08:09:44 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 103 | 08:10:05 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 104 | 08:10:07 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 105 | 08:10:30 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 106 | 08:12:08 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 107 | 08:12:30 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 108 | 08:12:45 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 109 | 08:14:09 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 110 | 08:14:31 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 111 | 08:14:49 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 112 | 08:15:06 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 113 | 08:15:12 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 114 | 08:15:32 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 115 | 08:15:46 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 116 | 08:17:32 | code-generation | complex | single | single | explicit | — | — |  |
| 117 | 08:17:41 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 118 | 08:17:51 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 119 | 08:18:34 | general | moderate | agentic | agentic | explicit | — | — |  |
| 120 | 08:19:39 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 121 | 08:20:04 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 122 | 08:20:37 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 123 | 08:20:51 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 124 | 08:22:38 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 125 | 08:23:05 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 126 | 08:23:20 | general | moderate | agentic | agentic | explicit | — | — |  |
| 127 | 08:23:39 | general | moderate | agentic | agentic | explicit | — | — |  |
| 128 | 08:23:58 | code-generation | complex | single | single | explicit | — | — |  |
| 129 | 08:24:38 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 130 | 08:24:59 | code-generation | complex | single | single | explicit | — | — |  |
| 131 | 08:25:07 | general | moderate | single | single | explicit | — | — |  |
| 132 | 08:25:38 | code-generation | complex | single | single | explicit | — | — |  |
| 133 | 08:25:52 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 134 | 08:25:59 | general | moderate | single | single | explicit | — | — |  |
| 135 | 08:26:06 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 136 | 08:26:25 | analysis | complex | single | single | explicit | — | — |  |
| 137 | 08:26:44 | code-generation | complex | single | single | explicit | — | — |  |
| 138 | 08:27:14 | general | moderate | auto | safety-quorum | pareto | — | — |  |
| 139 | 08:27:38 | code-generation | complex | single | single | explicit | — | — |  |
| 140 | 08:27:58 | architecture | complex | single | single | explicit | — | — |  |
| 141 | 08:28:07 | reasoning | complex | single | single | explicit | — | — |  |
| 142 | 08:28:38 | code-generation | complex | single | single | explicit | — | — |  |
| 143 | 08:29:35 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 144 | 08:29:40 | reasoning | complex | single | single | explicit | — | — |  |
| 145 | 08:30:41 | reasoning | complex | single | single | explicit | — | — |  |
| 146 | 08:30:49 | reasoning | complex | single | single | explicit | — | — |  |
| 147 | 08:30:54 | reasoning | complex | single | single | explicit | — | — |  |
| 148 | 08:31:09 | reasoning | complex | single | single | explicit | — | — |  |
| 149 | 08:31:21 | reasoning | complex | single | single | explicit | — | — |  |
| 150 | 08:32:13 | reasoning | complex | single | single | explicit | — | — |  |
| 151 | 08:32:19 | reasoning | complex | single | single | explicit | — | — |  |
| 152 | 08:32:56 | reasoning | complex | single | single | explicit | — | — |  |
| 153 | 08:33:03 | reasoning | complex | collaborative | collaborative | explicit | — | — |  |
| 154 | 08:33:44 | reasoning | complex | single | single | explicit | — | — |  |
| 155 | 08:33:48 | reasoning | complex | single | single | explicit | — | — |  |
| 156 | 08:34:05 | reasoning | complex | parallel | parallel | explicit | — | — |  |
| 157 | 08:34:34 | reasoning | complex | single | single | explicit | — | — |  |
| 158 | 08:35:08 | code-generation | complex | single | single | explicit | — | — |  |
| 159 | 08:35:34 | reasoning | complex | single | single | explicit | — | — |  |
| 160 | 08:35:39 | reasoning | complex | sequential | sequential | explicit | — | — |  |
| 161 | 08:36:23 | reasoning | complex | single | single | explicit | — | — |  |
| 162 | 08:36:32 | reasoning | complex | hybrid | hybrid | explicit | — | — |  |
| 163 | 08:36:34 | reasoning | complex | single | single | explicit | — | — |  |
| 164 | 08:36:40 | reasoning | complex | competitive | competitive | explicit | — | — |  |
| 165 | 08:36:56 | reasoning | complex | single | single | explicit | — | — |  |
| 166 | 08:37:56 | reasoning | complex | single | single | explicit | — | — |  |
| 167 | 08:38:23 | reasoning | complex | single | single | explicit | — | — |  |
| 168 | 08:38:31 | reasoning | complex | single | single | explicit | — | — |  |
| 169 | 08:38:56 | reasoning | complex | single | single | explicit | — | — |  |
| 170 | 08:39:11 | reasoning | complex | expert-panel | expert-panel | explicit | — | — |  |
| 171 | 08:39:23 | reasoning | complex | single | single | explicit | — | — |  |
| 172 | 08:39:31 | reasoning | complex | single | single | explicit | — | — |  |
| 173 | 08:39:34 | reasoning | complex | massive-parallel | massive-parallel | explicit | — | — |  |
| 174 | 08:39:40 | reasoning | complex | cost-cascade | cost-cascade | explicit | — | — |  |
| 175 | 08:39:49 | general | moderate | single | single | explicit | — | — |  |
| 176 | 08:40:25 | reasoning | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 177 | 08:44:16 | reasoning | complex | expert-panel | expert-panel | explicit | — | — |  |
| 178 | 08:44:45 | reasoning | complex | cost-cascade | cost-cascade | explicit | — | — |  |
| 179 | 08:45:20 | reasoning | complex | single | single | explicit | — | — |  |
| 180 | 08:45:29 | reasoning | complex | adaptive | adaptive | explicit | — | — |  |
| 181 | 08:45:31 | reasoning | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 182 | 08:46:30 | reasoning | complex | single | single | explicit | — | — |  |
| 183 | 08:46:51 | reasoning | complex | contextual | contextual | explicit | — | — |  |
| 184 | 08:47:55 | reasoning | complex | single | single | explicit | — | — |  |
| 185 | 08:48:03 | reasoning | complex | hierarchical | hierarchical | explicit | — | — |  |
| 186 | 08:57:40 | general | simple | single | single | explicit | — | — |  |
| 187 | 09:07:04 | general | simple | single | single | explicit | — | — |  |
| 188 | 09:07:09 | general | simple | single | single | explicit | — | — |  |
| 189 | 09:08:00 | reasoning | complex | debate | debate | explicit | — | — |  |
| 190 | 09:08:38 | reasoning | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 191 | 09:08:39 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 192 | 09:10:11 | reasoning | complex | debate | debate | explicit | — | — |  |
| 193 | 09:11:44 | reasoning | complex | debate | debate | explicit | — | — |  |
| 194 | 09:13:41 | reasoning | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 195 | 09:13:41 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 196 | 09:13:42 | reasoning | complex | debate | debate | explicit | — | — |  |
| 197 | 09:15:14 | reasoning | complex | debate | debate | explicit | — | — |  |
| 198 | 09:16:28 | code-generation | complex | single | single | explicit | — | — |  |
| 199 | 09:16:45 | reasoning | complex | debate | debate | explicit | — | — |  |
| 200 | 09:17:27 | code-generation | complex | single | single | explicit | — | — |  |
| 201 | 09:18:28 | code-generation | complex | single | single | explicit | — | — |  |
| 202 | 09:18:32 | reasoning | complex | debate | debate | explicit | — | — |  |
| 203 | 09:18:53 | reasoning | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 204 | 09:19:27 | code-generation | complex | single | single | explicit | — | — |  |
| 205 | 09:20:04 | reasoning | complex | debate | debate | explicit | — | — |  |
| 206 | 09:20:30 | reasoning | complex | war-room | war-room | explicit | — | — |  |
| 207 | 09:21:37 | reasoning | complex | debate | debate | explicit | — | — |  |
| 208 | 09:23:12 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 209 | 09:23:56 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 210 | 09:25:36 | reasoning | complex | war-room | war-room | explicit | — | — |  |
| 211 | 09:28:16 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 212 | 09:29:01 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 213 | 09:30:49 | reasoning | complex | war-room | war-room | explicit | — | — |  |
| 214 | 09:31:11 | reasoning | complex | single | single | explicit | — | — |  |
| 215 | 09:31:28 | reasoning | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 216 | 09:33:03 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 217 | 09:33:18 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 218 | 09:33:29 | reasoning | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 219 | 09:33:31 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 220 | 09:34:02 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 221 | 09:34:15 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 222 | 09:35:32 | reasoning | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 223 | 09:36:34 | reasoning | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 224 | 09:38:05 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 225 | 09:38:34 | reasoning | complex | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 226 | 09:38:36 | reasoning | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 227 | 09:39:04 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 228 | 09:39:17 | reasoning | complex | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 229 | 09:39:17 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 230 | 09:41:06 | reasoning | complex | single | single | explicit | — | — |  |
| 231 | 09:41:14 | reasoning | complex | swarm-explore | swarm-explore | explicit | — | — |  |
| 232 | 09:41:56 | reasoning | complex | single | single | explicit | — | — |  |
| 233 | 09:42:06 | reasoning | complex | clarification-first | clarification-first | explicit | — | — |  |
| 234 | 09:42:49 | reasoning | complex | single | single | explicit | — | — |  |
| 235 | 09:42:57 | reasoning | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 236 | 09:42:59 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 237 | 09:43:13 | reasoning | complex | single | single | explicit | — | — |  |
| 238 | 09:44:13 | reasoning | complex | single | single | explicit | — | — |  |
| 239 | 09:44:23 | reasoning | complex | single | single | explicit | — | — |  |
| 240 | 09:45:13 | reasoning | complex | single | single | explicit | — | — |  |
| 241 | 09:45:23 | reasoning | complex | single | single | explicit | — | — |  |
| 242 | 09:45:33 | reasoning | complex | critique-repair | critique-repair | explicit | — | — |  |
| 243 | 09:45:39 | reasoning | complex | double-diamond | double-diamond | explicit | — | — |  |
| 244 | 09:45:54 | reasoning | complex | single | single | explicit | — | — |  |
| 245 | 09:46:03 | reasoning | complex | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 246 | 09:47:23 | reasoning | complex | single | single | explicit | — | — |  |
| 247 | 09:47:36 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 248 | 09:47:53 | reasoning | complex | single | single | explicit | — | — |  |
| 249 | 09:48:02 | reasoning | complex | agentic | agentic | explicit | — | — |  |
| 250 | 09:49:39 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 251 | 09:50:04 | reasoning | complex | single | single | explicit | — | — |  |
| 252 | 09:51:05 | reasoning | complex | single | single | explicit | — | — |  |
| 253 | 09:51:14 | reasoning | complex | single | single | explicit | — | — |  |
| 254 | 09:51:40 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 255 | 09:52:14 | reasoning | complex | single | single | explicit | — | — |  |
| 256 | 09:52:28 | reasoning | complex | single | single | explicit | — | — |  |
| 257 | 09:52:41 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 258 | 09:53:04 | reasoning | complex | agentic | agentic | explicit | — | — |  |
| 259 | 09:53:07 | reasoning | complex | agentic | agentic | explicit | — | — |  |
| 260 | 09:53:39 | reasoning | complex | single | single | explicit | — | — |  |
| 261 | 09:54:33 | documentation | complex | auto | stigmergic-refinement | pareto | 0.30 | — |  |
| 262 | 09:54:43 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 263 | 09:56:16 | general | complex | single | single | explicit | — | — |  |
| 264 | 09:58:15 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 265 | 09:58:16 | reasoning | complex | single | single | explicit | — | — |  |
| 266 | 09:58:17 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 267 | 09:58:17 | general | complex | single | single | explicit | — | — |  |
| 268 | 09:58:29 | general | moderate | single | single | explicit | — | — |  |
| 269 | 09:58:37 | general | moderate | single | single | explicit | — | — |  |
| 270 | 09:59:15 | architecture | complex | single | single | explicit | — | — |  |
| 271 | 10:00:01 | general | moderate | single | single | explicit | — | — |  |
| 272 | 10:00:15 | analysis | complex | single | single | explicit | — | — |  |
| 273 | 10:01:34 | analysis | complex | single | single | explicit | — | — |  |
| 274 | 10:01:57 | reasoning | complex | single | single | explicit | — | — |  |
| 275 | 10:02:05 | general | moderate | single | single | explicit | — | — |  |
| 276 | 10:02:26 | general | moderate | single | single | explicit | — | — |  |
| 277 | 10:02:46 | architecture | complex | single | single | explicit | — | — |  |
| 278 | 10:03:01 | general | moderate | single | single | explicit | — | — |  |
| 279 | 10:04:10 | architecture | complex | single | single | explicit | — | — |  |
| 280 | 10:04:17 | general | moderate | collaborative | collaborative | explicit | — | — |  |
| 281 | 10:05:40 | architecture | complex | single | single | explicit | — | — |  |
| 282 | 10:05:48 | general | moderate | parallel | parallel | explicit | — | — |  |
| 283 | 10:06:42 | reasoning | complex | single | single | explicit | — | — |  |
| 284 | 10:06:50 | general | moderate | sequential | sequential | explicit | — | — |  |
| 285 | 10:08:34 | general | moderate | hybrid | hybrid | explicit | — | — |  |
| 286 | 10:08:35 | analysis | complex | single | single | explicit | — | — |  |
| 287 | 10:09:42 | analysis | complex | single | single | explicit | — | — |  |
| 288 | 10:10:04 | analysis | complex | single | single | explicit | — | — |  |
| 289 | 10:10:30 | analysis | complex | single | single | explicit | — | — |  |
| 290 | 10:10:35 | analysis | complex | single | single | explicit | — | — |  |
| 291 | 10:10:58 | general | moderate | competitive | competitive | explicit | — | — |  |
| 292 | 10:11:31 | analysis | complex | single | single | explicit | — | — |  |
| 293 | 10:11:35 | reasoning | complex | single | single | explicit | — | — |  |
| 294 | 10:11:37 | analysis | complex | single | single | explicit | — | — |  |
| 295 | 10:13:11 | analysis | complex | single | single | explicit | — | — |  |
| 296 | 10:13:16 | general | moderate | massive-parallel | massive-parallel | explicit | — | — |  |
| 297 | 10:13:16 | general | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 298 | 10:14:10 | general | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 299 | 10:16:18 | analysis | complex | single | single | explicit | — | — |  |
| 300 | 10:16:34 | analysis | complex | single | single | explicit | — | — |  |
| 301 | 10:16:45 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 302 | 10:17:17 | analysis | complex | single | single | explicit | — | — |  |
| 303 | 10:18:17 | analysis | complex | single | single | explicit | — | — |  |
| 304 | 10:18:30 | general | moderate | adaptive | adaptive | explicit | — | — |  |
| 305 | 10:19:16 | reasoning | complex | single | single | explicit | — | — |  |
| 306 | 10:20:10 | reasoning | complex | single | single | explicit | — | — |  |
| 307 | 10:20:12 | general | moderate | contextual | contextual | explicit | — | — |  |
| 308 | 10:20:18 | general | moderate | hierarchical | hierarchical | explicit | — | — |  |
| 309 | 10:21:43 | analysis | complex | single | single | explicit | — | — |  |
| 310 | 10:21:55 | general | moderate | consensus | consensus | explicit | — | — |  |
| 311 | 10:23:15 | reasoning | complex | single | single | explicit | — | — |  |
| 312 | 10:24:15 | reasoning | complex | single | single | explicit | — | — |  |
| 313 | 10:24:30 | reasoning | complex | single | single | explicit | — | — |  |
| 314 | 10:25:12 | general | moderate | reinforcement | reinforcement | explicit | — | — |  |
| 315 | 10:25:25 | reasoning | complex | single | single | explicit | — | — |  |
| 316 | 10:25:32 | general | moderate | debate | debate | explicit | — | — |  |
| 317 | 10:26:12 | analysis | complex | single | single | explicit | — | — |  |
| 318 | 10:26:47 | code-generation | complex | single | single | explicit | — | — |  |
| 319 | 10:27:03 | general | moderate | debate | debate | explicit | — | — |  |
| 320 | 10:27:12 | analysis | complex | single | single | explicit | — | — |  |
| 321 | 10:27:23 | general | moderate | war-room | war-room | explicit | — | — |  |
| 322 | 10:27:42 | reasoning | moderate | single | single | explicit | — | — |  |
| 323 | 10:27:49 | general | moderate | blind-debate | blind-debate | explicit | — | — |  |
| 324 | 10:28:12 | analysis | complex | single | single | explicit | — | — |  |
| 325 | 10:28:35 | general | moderate | debate | debate | explicit | — | — |  |
| 326 | 10:29:12 | general | moderate | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 327 | 10:30:12 | general | moderate | debate | debate | explicit | — | — |  |
| 328 | 10:31:09 | analysis | complex | single | single | explicit | — | — |  |
| 329 | 10:31:44 | general | moderate | debate | debate | explicit | — | — |  |
| 330 | 10:32:09 | analysis | complex | single | single | explicit | — | — |  |
| 331 | 10:33:09 | analysis | complex | single | single | explicit | — | — |  |
| 332 | 10:33:18 | general | moderate | debate | debate | explicit | — | — |  |
| 333 | 10:33:23 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 334 | 10:33:59 | analysis | complex | single | single | explicit | — | — |  |
| 335 | 10:34:59 | analysis | complex | single | single | explicit | — | — |  |
| 336 | 10:35:05 | general | moderate | debate | debate | explicit | — | — |  |
| 337 | 10:35:09 | general | moderate | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 338 | 10:35:25 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 339 | 10:36:37 | general | moderate | debate | debate | explicit | — | — |  |
| 340 | 10:37:40 | analysis | complex | single | single | explicit | — | — |  |
| 341 | 10:38:19 | general | moderate | debate | debate | explicit | — | — |  |
| 342 | 10:38:28 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 343 | 10:38:39 | analysis | complex | single | single | explicit | — | — |  |
| 344 | 10:38:54 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 345 | 10:39:39 | analysis | complex | single | single | explicit | — | — |  |
| 346 | 10:39:53 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 347 | 10:40:31 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 348 | 10:40:40 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 349 | 10:42:33 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 350 | 10:43:45 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 351 | 10:44:55 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 352 | 10:44:59 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 353 | 10:45:44 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 354 | 10:45:47 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 355 | 10:45:47 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 356 | 10:47:50 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 357 | 10:48:47 | general | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 358 | 10:50:14 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 359 | 10:51:02 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 360 | 10:53:51 | general | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 361 | 10:55:16 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 362 | 10:56:03 | general | moderate | critique-repair | critique-repair | explicit | — | — |  |
| 363 | 10:57:18 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 364 | 10:57:36 | analysis | complex | single | single | explicit | — | — |  |
| 365 | 10:58:36 | analysis | complex | single | single | explicit | — | — |  |
| 366 | 10:59:06 | general | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 367 | 10:59:35 | analysis | complex | single | single | explicit | — | — |  |
| 368 | 11:00:02 | analysis | complex | single | single | explicit | — | — |  |
| 369 | 11:00:36 | analysis | complex | single | single | explicit | — | — |  |
| 370 | 11:01:02 | analysis | complex | single | single | explicit | — | — |  |
| 371 | 11:01:18 | analysis | complex | single | single | explicit | — | — |  |
| 372 | 11:01:37 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 373 | 11:02:02 | analysis | complex | single | single | explicit | — | — |  |
| 374 | 11:02:17 | analysis | complex | single | single | explicit | — | — |  |
| 375 | 11:02:46 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 376 | 11:03:17 | analysis | complex | single | single | explicit | — | — |  |
| 377 | 11:04:17 | analysis | complex | single | single | explicit | — | — |  |
| 378 | 11:04:29 | analysis | complex | single | single | explicit | — | — |  |
| 379 | 11:05:10 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 380 | 11:05:19 | general | moderate | agentic | agentic | explicit | — | — |  |
| 381 | 11:06:43 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 382 | 11:07:14 | general | complex | single | single | explicit | — | — |  |
| 383 | 11:08:19 | general | complex | single | single | explicit | — | — |  |
| 384 | 11:08:35 | general | moderate | single | single | explicit | — | — |  |
| 385 | 11:09:09 | general | complex | single | single | explicit | — | — |  |
| 386 | 11:09:22 | architecture | complex | single | single | explicit | — | — |  |
| 387 | 11:09:23 | general | moderate | single | single | explicit | — | — |  |
| 388 | 11:09:30 | general | moderate | auto | contextual | pareto | — | — |  |
| 389 | 11:09:44 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 390 | 11:10:56 | analysis | complex | single | single | explicit | — | — |  |
| 391 | 11:11:52 | general | complex | single | single | explicit | — | — |  |
| 392 | 11:11:56 | analysis | complex | single | single | explicit | — | — |  |
| 393 | 11:12:03 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 394 | 11:12:09 | code-generation | simple | single | single | explicit | — | — |  |
| 395 | 11:12:39 | code-generation | complex | single | single | explicit | — | — |  |
| 396 | 11:12:46 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 397 | 11:12:55 | analysis | complex | single | single | explicit | — | — |  |
| 398 | 11:13:06 | code-generation | simple | single | single | explicit | — | — |  |
| 399 | 11:13:55 | analysis | complex | single | single | explicit | — | — |  |
| 400 | 11:14:04 | code-generation | complex | single | single | explicit | — | — |  |
| 401 | 11:14:41 | code-generation | simple | single | single | explicit | — | — |  |
| 402 | 11:14:57 | code-generation | simple | single | single | explicit | — | — |  |
| 403 | 11:15:36 | code-generation | complex | single | single | explicit | — | — |  |
| 404 | 11:16:25 | code-generation | simple | single | single | explicit | — | — |  |
| 405 | 11:17:01 | code-generation | simple | single | single | explicit | — | — |  |
| 406 | 11:17:27 | code-generation | complex | single | single | explicit | — | — |  |
| 407 | 11:17:43 | code-generation | complex | single | single | explicit | — | — |  |
| 408 | 11:18:01 | code-generation | complex | single | single | explicit | — | — |  |
| 409 | 11:18:27 | code-generation | complex | single | single | explicit | — | — |  |
| 410 | 11:18:40 | code-generation | complex | single | single | explicit | — | — |  |
| 411 | 11:19:01 | code-generation | complex | single | single | explicit | — | — |  |
| 412 | 11:19:21 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 413 | 11:19:39 | code-generation | complex | single | single | explicit | — | — |  |
| 414 | 11:19:59 | code-generation | complex | single | single | explicit | — | — |  |
| 415 | 11:20:38 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 416 | 11:20:59 | code-generation | complex | single | single | explicit | — | — |  |
| 417 | 11:21:37 | code-generation | complex | single | single | explicit | — | — |  |
| 418 | 11:22:00 | code-generation | complex | single | single | explicit | — | — |  |
| 419 | 11:22:03 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 420 | 11:22:41 | code-generation | complex | single | single | explicit | — | — |  |
| 421 | 11:23:01 | code-generation | simple | hybrid | hybrid | explicit | — | — |  |
| 422 | 11:23:10 | code-generation | complex | single | single | explicit | — | — |  |
| 423 | 11:23:37 | code-generation | complex | single | single | explicit | — | — |  |
| 424 | 11:24:12 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 425 | 11:24:37 | code-generation | complex | single | single | explicit | — | — |  |
| 426 | 11:24:46 | analysis | complex | single | single | explicit | — | — |  |
| 427 | 11:25:29 | analysis | complex | single | single | explicit | — | — |  |
| 428 | 11:25:38 | code-generation | simple | expert-panel | expert-panel | explicit | — | — |  |
| 429 | 11:25:40 | code-generation | simple | massive-parallel | massive-parallel | explicit | — | — |  |
| 430 | 11:25:41 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 431 | 11:26:51 | code-generation | complex | single | single | explicit | — | — |  |
| 432 | 11:27:51 | code-generation | complex | single | single | explicit | — | — |  |
| 433 | 11:28:20 | analysis | complex | single | single | explicit | — | — |  |
| 434 | 11:28:47 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 435 | 11:28:50 | code-generation | complex | single | single | explicit | — | — |  |
| 436 | 11:29:46 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 437 | 11:30:46 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 438 | 11:30:56 | code-generation | complex | single | single | explicit | — | — |  |
| 439 | 11:31:05 | code-generation | complex | single | single | explicit | — | — |  |
| 440 | 11:31:57 | code-generation | complex | single | single | explicit | — | — |  |
| 441 | 11:32:57 | code-generation | simple | contextual | contextual | explicit | — | — |  |
| 442 | 11:33:07 | code-generation | complex | single | single | explicit | — | — |  |
| 443 | 11:33:52 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 444 | 11:34:04 | code-generation | complex | single | single | explicit | — | — |  |
| 445 | 11:34:52 | code-generation | simple | hierarchical | hierarchical | explicit | — | — |  |
| 446 | 11:36:00 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 447 | 11:36:01 | code-generation | complex | single | single | explicit | — | — |  |
| 448 | 11:37:01 | code-generation | complex | single | single | explicit | — | — |  |
| 449 | 11:38:01 | code-generation | complex | single | single | explicit | — | — |  |
| 450 | 11:38:05 | code-generation | complex | single | single | explicit | — | — |  |
| 451 | 11:39:05 | code-generation | simple | consensus | consensus | explicit | — | — |  |
| 452 | 11:39:06 | code-generation | complex | single | single | explicit | — | — |  |
| 453 | 11:40:00 | code-generation | simple | reinforcement | reinforcement | explicit | — | — |  |
| 454 | 11:40:14 | code-generation | complex | single | single | explicit | — | — |  |
| 455 | 11:40:49 | code-generation | complex | single | single | explicit | — | — |  |
| 456 | 11:41:02 | code-generation | simple | debate | debate | explicit | — | — |  |
| 457 | 11:41:12 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 458 | 11:41:49 | code-generation | complex | single | single | explicit | — | — |  |
| 459 | 11:41:52 | code-generation | complex | single | single | explicit | — | — |  |
| 460 | 11:42:41 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 461 | 11:42:49 | code-generation | complex | single | single | explicit | — | — |  |
| 462 | 11:42:59 | code-generation | complex | single | single | explicit | — | — |  |
| 463 | 11:43:08 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 464 | 11:43:50 | code-generation | complex | single | single | explicit | — | — |  |
| 465 | 11:44:14 | code-generation | complex | single | single | explicit | — | — |  |
| 466 | 11:44:30 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 467 | 11:44:34 | code-generation | complex | single | single | explicit | — | — |  |
| 468 | 11:44:42 | code-generation | complex | single | single | explicit | — | — |  |
| 469 | 11:44:55 | code-generation | complex | single | single | explicit | — | — |  |
| 470 | 11:44:59 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 471 | 11:45:04 | code-generation | simple | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 472 | 11:45:08 | code-generation | complex | single | single | explicit | — | — |  |
| 473 | 11:45:16 | code-generation | simple | swarm-explore | swarm-explore | explicit | — | — |  |
| 474 | 11:45:19 | code-generation | complex | single | single | explicit | — | — |  |
| 475 | 11:45:24 | code-generation | simple | clarification-first | clarification-first | explicit | — | — |  |
| 476 | 11:45:29 | code-generation | complex | single | single | explicit | — | — |  |
| 477 | 11:45:34 | code-generation | simple | research-synthesize | research-synthesize | explicit | — | — |  |
| 478 | 11:45:39 | code-generation | simple | critique-repair | critique-repair | explicit | — | — |  |
| 479 | 11:46:09 | code-generation | complex | single | single | explicit | — | — |  |
| 480 | 11:46:17 | code-generation | complex | single | single | explicit | — | — |  |
| 481 | 11:46:35 | code-generation | simple | double-diamond | double-diamond | explicit | — | — |  |
| 482 | 11:46:41 | code-generation | simple | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 483 | 11:46:45 | code-generation | complex | single | single | explicit | — | — |  |
| 484 | 11:46:54 | code-generation | simple | persona-exploration | persona-exploration | explicit | — | — |  |
| 485 | 11:46:56 | code-generation | complex | single | single | explicit | — | — |  |
| 486 | 11:47:24 | code-generation | simple | agentic | agentic | explicit | — | — |  |
| 487 | 11:49:12 | code-generation | complex | single | single | explicit | — | — |  |
| 488 | 11:49:28 | code-generation | complex | single | single | explicit | — | — |  |
| 489 | 11:50:12 | code-generation | complex | single | single | explicit | — | — |  |
| 490 | 11:50:27 | code-generation | simple | agentic | agentic | explicit | — | — |  |
| 491 | 11:50:29 | code-generation | complex | single | single | explicit | — | — |  |
| 492 | 11:51:12 | code-generation | complex | single | single | explicit | — | — |  |
| 493 | 11:51:27 | code-generation | complex | single | single | explicit | — | — |  |
| 494 | 11:51:55 | code-generation | complex | single | single | explicit | — | — |  |
| 495 | 11:52:12 | code-generation | complex | single | single | explicit | — | — |  |
| 496 | 11:52:28 | code-generation | complex | single | single | explicit | — | — |  |
| 497 | 11:52:55 | code-generation | complex | single | single | explicit | — | — |  |
| 498 | 11:52:59 | code-generation | simple | single | single | explicit | — | — |  |
| 499 | 11:53:13 | code-generation | simple | single | single | explicit | — | — |  |
| 500 | 11:53:40 | code-generation | simple | auto | parallel | archive | 0.30 | — |  |
| 501 | 11:53:55 | code-generation | complex | single | single | explicit | — | — |  |
| 502 | 11:54:04 | code-generation | complex | single | single | explicit | — | — |  |
| 503 | 11:54:18 | code-generation | simple | single | single | explicit | — | — |  |
| 504 | 11:54:24 | code-generation | complex | single | single | explicit | — | — |  |
| 505 | 11:54:35 | code-generation | simple | single | single | explicit | — | — |  |
| 506 | 11:55:07 | code-generation | simple | single | single | explicit | — | — |  |
| 507 | 11:55:09 | code-generation | complex | single | single | explicit | — | — |  |
| 508 | 11:55:37 | code-generation | simple | single | single | explicit | — | — |  |
| 509 | 11:56:22 | code-generation | complex | single | single | explicit | — | — |  |
| 510 | 11:56:47 | code-generation | simple | single | single | explicit | — | — |  |
| 511 | 11:57:33 | code-generation | complex | single | single | explicit | — | — |  |
| 512 | 11:57:49 | code-generation | simple | single | single | explicit | — | — |  |
| 513 | 11:58:02 | analysis | complex | single | single | explicit | — | — |  |
| 514 | 11:58:42 | code-generation | complex | single | single | explicit | — | — |  |
| 515 | 11:58:48 | code-generation | complex | single | single | explicit | — | — |  |
| 516 | 11:59:05 | analysis | complex | single | single | explicit | — | — |  |
| 517 | 11:59:11 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 518 | 11:59:21 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 519 | 11:59:34 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 520 | 12:00:00 | code-generation | complex | single | single | explicit | — | — |  |
| 521 | 12:00:25 | code-generation | simple | hybrid | hybrid | explicit | — | — |  |
| 522 | 12:00:43 | code-generation | complex | single | single | explicit | — | — |  |
| 523 | 12:01:06 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 524 | 12:01:13 | general | moderate | single | single | explicit | — | — |  |
| 525 | 12:01:37 | code-generation | complex | single | single | explicit | — | — |  |
| 526 | 12:01:55 | code-generation | simple | expert-panel | expert-panel | explicit | — | — |  |
| 527 | 12:02:01 | general | moderate | single | single | explicit | — | — |  |
| 528 | 12:02:12 | general | moderate | single | single | explicit | — | — |  |
| 529 | 12:03:01 | general | moderate | single | single | explicit | — | — |  |
| 530 | 12:03:14 | general | moderate | single | single | explicit | — | — |  |
| 531 | 12:04:00 | general | moderate | single | single | explicit | — | — |  |
| 532 | 12:04:13 | general | moderate | single | single | explicit | — | — |  |
| 533 | 12:04:18 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 534 | 12:05:01 | general | moderate | single | single | explicit | — | — |  |
| 535 | 12:05:14 | code-generation | simple | massive-parallel | massive-parallel | explicit | — | — |  |
| 536 | 12:05:35 | general | moderate | single | single | explicit | — | — |  |
| 537 | 12:06:02 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 538 | 12:06:36 | general | moderate | single | single | explicit | — | — |  |
| 539 | 12:07:08 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 540 | 12:09:32 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 541 | 12:11:08 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 542 | 12:12:13 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 543 | 12:14:33 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 544 | 12:15:48 | code-generation | complex | single | single | explicit | — | — |  |
| 545 | 12:16:13 | code-generation | complex | single | single | explicit | — | — |  |
| 546 | 12:16:16 | code-generation | simple | contextual | contextual | explicit | — | — |  |
| 547 | 12:16:24 | general | moderate | single | single | explicit | — | — |  |
| 548 | 12:16:44 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 549 | 12:16:54 | code-generation | simple | hierarchical | hierarchical | explicit | — | — |  |
| 550 | 12:17:02 | code-generation | simple | consensus | consensus | explicit | — | — |  |
| 551 | 12:17:30 | general | moderate | single | single | explicit | — | — |  |
| 552 | 12:17:39 | code-generation | simple | reinforcement | reinforcement | explicit | — | — |  |
| 553 | 12:18:16 | general | moderate | single | single | explicit | — | — |  |
| 554 | 12:18:21 | code-generation | simple | debate | debate | explicit | — | — |  |
| 555 | 12:19:02 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 556 | 12:20:18 | code-generation | simple | debate | debate | explicit | — | — |  |
| 557 | 12:21:25 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 558 | 12:21:50 | code-generation | simple | debate | debate | explicit | — | — |  |
| 559 | 12:23:23 | code-generation | simple | debate | debate | explicit | — | — |  |
| 560 | 12:24:07 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 561 | 12:24:55 | code-generation | simple | debate | debate | explicit | — | — |  |
| 562 | 12:26:28 | code-generation | simple | debate | debate | explicit | — | — |  |
| 563 | 12:26:30 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 564 | 12:26:31 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 565 | 12:28:15 | code-generation | simple | debate | debate | explicit | — | — |  |
| 566 | 12:29:22 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 567 | 12:29:48 | code-generation | simple | debate | debate | explicit | — | — |  |
| 568 | 12:31:22 | code-generation | simple | debate | debate | explicit | — | — |  |
| 569 | 12:31:34 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 570 | 12:31:45 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 571 | 12:32:57 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 572 | 12:34:25 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 573 | 12:36:26 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 574 | 12:36:42 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 575 | 12:36:47 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 576 | 12:37:24 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 577 | 12:38:01 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 578 | 12:38:29 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 579 | 12:38:43 | general | moderate | single | single | explicit | — | — |  |
| 580 | 12:39:41 | code-generation | simple | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 581 | 12:39:45 | code-generation | simple | swarm-explore | swarm-explore | explicit | — | — |  |
| 582 | 12:39:49 | code-generation | simple | clarification-first | clarification-first | explicit | — | — |  |
| 583 | 12:39:54 | code-generation | simple | research-synthesize | research-synthesize | explicit | — | — |  |
| 584 | 12:39:58 | code-generation | simple | critique-repair | critique-repair | explicit | — | — |  |
| 585 | 12:40:02 | code-generation | simple | double-diamond | double-diamond | explicit | — | — |  |
| 586 | 12:40:06 | code-generation | simple | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 587 | 12:40:09 | code-generation | simple | persona-exploration | persona-exploration | explicit | — | — |  |
| 588 | 12:40:14 | code-generation | simple | agentic | agentic | explicit | — | — |  |
| 589 | 12:40:18 | code-generation | simple | single | single | explicit | — | — |  |
| 590 | 12:40:46 | code-generation | complex | single | single | explicit | — | — |  |
| 591 | 12:41:45 | code-generation | complex | single | single | explicit | — | — |  |
| 592 | 12:41:50 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 593 | 12:41:56 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 594 | 12:41:57 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 595 | 12:42:00 | code-generation | simple | single | single | explicit | — | — |  |
| 596 | 12:42:26 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 597 | 12:42:32 | code-generation | complex | single | single | explicit | — | — |  |
| 598 | 12:42:45 | code-generation | complex | single | single | explicit | — | — |  |
| 599 | 12:43:03 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 600 | 12:43:15 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 601 | 12:43:20 | debugging | simple | auto | single | archive | 0.30 | — |  |
| 602 | 12:43:32 | code-generation | complex | single | single | explicit | — | — |  |
| 603 | 12:43:45 | code-generation | complex | single | single | explicit | — | — |  |
| 604 | 12:44:00 | analysis | complex | single | single | explicit | — | — |  |
| 605 | 12:44:38 | code-generation | complex | single | single | explicit | — | — |  |
| 606 | 12:44:46 | code-generation | complex | single | single | explicit | — | — |  |
| 607 | 12:44:50 | code-generation | complex | single | single | explicit | — | — |  |
| 608 | 12:45:09 | code-generation | complex | single | single | explicit | — | — |  |
| 609 | 12:45:20 | code-generation | complex | single | single | explicit | — | — |  |
| 610 | 12:45:32 | code-generation | complex | single | single | explicit | — | — |  |
| 611 | 12:46:01 | code-generation | complex | single | single | explicit | — | — |  |
| 612 | 12:46:12 | code-generation | complex | single | single | explicit | — | — |  |
| 613 | 12:46:35 | code-generation | complex | single | single | explicit | — | — |  |
| 614 | 12:47:01 | code-generation | complex | single | single | explicit | — | — |  |
| 615 | 12:47:12 | code-generation | complex | single | single | explicit | — | — |  |
| 616 | 12:47:58 | code-generation | complex | single | single | explicit | — | — |  |
| 617 | 12:48:05 | code-generation | complex | single | single | explicit | — | — |  |
| 618 | 12:48:23 | code-generation | complex | single | single | explicit | — | — |  |
| 619 | 12:48:37 | code-generation | complex | single | single | explicit | — | — |  |
| 620 | 12:48:38 | code-generation | complex | single | single | explicit | — | — |  |
| 621 | 12:48:57 | code-generation | complex | single | single | explicit | — | — |  |
| 622 | 12:49:16 | code-generation | complex | collaborative | collaborative | explicit | — | — |  |
| 623 | 12:49:23 | code-generation | complex | parallel | parallel | explicit | — | — |  |
| 624 | 12:49:37 | code-generation | complex | single | single | explicit | — | — |  |
| 625 | 12:49:50 | code-generation | complex | single | single | explicit | — | — |  |
| 626 | 12:50:02 | code-generation | complex | sequential | sequential | explicit | — | — |  |
| 627 | 12:50:34 | code-generation | complex | single | single | explicit | — | — |  |
| 628 | 12:50:46 | code-generation | complex | single | single | explicit | — | — |  |
| 629 | 12:50:54 | code-generation | complex | single | single | explicit | — | — |  |
| 630 | 12:51:36 | code-generation | complex | single | single | explicit | — | — |  |
| 631 | 12:51:46 | code-generation | complex | single | single | explicit | — | — |  |
| 632 | 12:51:53 | code-generation | complex | single | single | explicit | — | — |  |
| 633 | 12:52:05 | code-generation | complex | hybrid | hybrid | explicit | — | — |  |
| 634 | 12:52:16 | code-generation | complex | competitive | competitive | explicit | — | — |  |
| 635 | 12:52:18 | code-generation | complex | expert-panel | expert-panel | explicit | — | — |  |
| 636 | 12:52:19 | code-generation | complex | massive-parallel | massive-parallel | explicit | — | — |  |
| 637 | 12:52:23 | code-generation | complex | cost-cascade | cost-cascade | explicit | — | — |  |
| 638 | 12:52:26 | code-generation | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 639 | 12:52:28 | code-generation | complex | adaptive | adaptive | explicit | — | — |  |
| 640 | 12:52:34 | code-generation | complex | contextual | contextual | explicit | — | — |  |
| 641 | 12:52:43 | code-generation | complex | hierarchical | hierarchical | explicit | — | — |  |
| 642 | 12:52:48 | code-generation | complex | single | single | explicit | — | — |  |
| 643 | 12:52:50 | code-generation | complex | consensus | consensus | explicit | — | — |  |
| 644 | 12:52:56 | code-generation | complex | reinforcement | reinforcement | explicit | — | — |  |
| 645 | 12:52:56 | code-generation | complex | single | single | explicit | — | — |  |
| 646 | 12:53:01 | code-generation | complex | debate | debate | explicit | — | — |  |
| 647 | 12:53:10 | code-generation | complex | war-room | war-room | explicit | — | — |  |
| 648 | 12:53:18 | code-generation | complex | blind-debate | blind-debate | explicit | — | — |  |
| 649 | 12:53:22 | code-generation | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 650 | 12:53:27 | code-generation | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 651 | 12:53:34 | code-generation | complex | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 652 | 12:53:36 | code-generation | complex | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 653 | 12:53:37 | general | moderate | single | single | explicit | — | — |  |
| 654 | 12:54:00 | code-generation | complex | swarm-explore | swarm-explore | explicit | — | — |  |
| 655 | 12:54:01 | code-generation | complex | clarification-first | clarification-first | explicit | — | — |  |
| 656 | 12:54:06 | code-generation | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 657 | 12:54:06 | code-generation | complex | critique-repair | critique-repair | explicit | — | — |  |
| 658 | 12:54:14 | code-generation | complex | double-diamond | double-diamond | explicit | — | — |  |
| 659 | 12:54:15 | code-generation | complex | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 660 | 12:54:18 | code-generation | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 661 | 12:54:21 | code-generation | complex | agentic | agentic | explicit | — | — |  |
| 662 | 12:54:22 | code-generation | complex | single | single | explicit | — | — |  |
| 663 | 12:54:28 | code-generation | complex | single | single | explicit | — | — |  |
| 664 | 12:54:31 | refactoring | complex | auto | expert-panel | heuristic | 0.30 | — |  |
| 665 | 12:54:57 | general | moderate | single | single | explicit | — | — |  |
| 666 | 12:55:01 | analysis | complex | single | single | explicit | — | — |  |
| 667 | 12:55:54 | general | moderate | single | single | explicit | — | — |  |
| 668 | 12:56:00 | analysis | complex | single | single | explicit | — | — |  |
| 669 | 12:56:04 | code-generation | complex | single | single | explicit | — | — |  |
| 670 | 12:56:58 | general | complex | single | single | explicit | — | — |  |
| 671 | 12:56:59 | analysis | complex | single | single | explicit | — | — |  |
| 672 | 12:57:05 | code-generation | complex | single | single | explicit | — | — |  |
| 673 | 12:57:48 | general | complex | single | single | explicit | — | — |  |
| 674 | 12:57:49 | general | complex | single | single | explicit | — | — |  |
| 675 | 12:59:59 | analysis | complex | single | single | explicit | — | — |  |
| 676 | 13:00:29 | general | complex | single | single | explicit | — | — |  |
| 677 | 13:00:33 | code-generation | complex | single | single | explicit | — | — |  |
| 678 | 13:01:09 | general | complex | single | single | explicit | — | — |  |
| 679 | 13:02:51 | general | complex | single | single | explicit | — | — |  |
| 680 | 13:04:45 | code-generation | complex | single | single | explicit | — | — |  |
| 681 | 13:04:59 | reasoning | complex | single | single | explicit | — | — |  |
| 682 | 13:05:24 | general | complex | single | single | explicit | — | — |  |
| 683 | 13:05:24 | general | complex | collaborative | collaborative | explicit | — | — |  |
| 684 | 13:05:51 | general | complex | parallel | parallel | explicit | — | — |  |
| 685 | 13:08:02 | analysis | complex | single | single | explicit | — | — |  |
| 686 | 13:08:42 | general | complex | single | single | explicit | — | — |  |
| 687 | 13:09:02 | analysis | complex | single | single | explicit | — | — |  |
| 688 | 13:10:01 | code-generation | complex | single | single | explicit | — | — |  |
| 689 | 13:10:09 | analysis | complex | single | single | explicit | — | — |  |
| 690 | 13:10:28 | general | complex | sequential | sequential | explicit | — | — |  |
| 691 | 13:11:02 | analysis | complex | single | single | explicit | — | — |  |
| 692 | 13:11:38 | general | complex | hybrid | hybrid | explicit | — | — |  |
| 693 | 13:11:43 | reasoning | complex | single | single | explicit | — | — |  |
| 694 | 13:12:24 | code-generation | complex | single | single | explicit | — | — |  |
| 695 | 13:12:43 | reasoning | complex | single | single | explicit | — | — |  |
| 696 | 13:12:52 | general | complex | competitive | competitive | explicit | — | — |  |
| 697 | 13:12:56 | general | complex | expert-panel | expert-panel | explicit | — | — |  |
| 698 | 13:12:59 | general | complex | massive-parallel | massive-parallel | explicit | — | — |  |
| 699 | 13:13:02 | general | complex | cost-cascade | cost-cascade | explicit | — | — |  |
| 700 | 13:13:04 | general | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 701 | 13:13:07 | general | complex | adaptive | adaptive | explicit | — | — |  |
| 702 | 13:13:15 | general | complex | hierarchical | hierarchical | explicit | — | — |  |
| 703 | 13:13:15 | general | complex | contextual | contextual | explicit | — | — |  |
| 704 | 13:15:51 | general | simple | single | single | explicit | — | — |  |
| 705 | 13:16:03 | general | simple | single | single | explicit | — | — |  |
| 706 | 13:16:12 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 707 | 13:16:13 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 708 | 13:16:13 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 709 | 13:21:17 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 710 | 13:21:17 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 711 | 13:21:18 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 712 | 13:22:53 | code-generation | complex | single | single | explicit | — | — |  |
| 713 | 13:23:52 | code-generation | complex | single | single | explicit | — | — |  |
| 714 | 13:24:25 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 715 | 13:26:31 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 716 | 13:26:31 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 717 | 13:29:34 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 718 | 13:31:44 | general | complex | adaptive | adaptive | explicit | — | — |  |
| 719 | 13:31:46 | general | complex | consensus | consensus | explicit | — | — |  |
| 720 | 13:33:30 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 721 | 13:33:30 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 722 | 13:35:29 | general | simple | single | single | explicit | — | — |  |
| 723 | 13:35:42 | general | simple | single | single | explicit | — | — |  |
| 724 | 13:35:48 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 725 | 13:35:49 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 726 | 13:35:49 | general | complex | adaptive | adaptive | explicit | — | — |  |
| 727 | 13:37:58 | code-generation | complex | single | single | explicit | — | — |  |
| 728 | 13:38:19 | code-generation | complex | single | single | explicit | — | — |  |
| 729 | 13:38:59 | code-generation | complex | single | single | explicit | — | — |  |
| 730 | 13:39:20 | code-generation | complex | single | single | explicit | — | — |  |
| 731 | 13:39:59 | general | complex | consensus | consensus | explicit | — | — |  |
| 732 | 13:40:00 | code-generation | complex | single | single | explicit | — | — |  |
| 733 | 13:40:19 | code-generation | complex | single | single | explicit | — | — |  |
| 734 | 13:41:00 | code-generation | complex | single | single | explicit | — | — |  |
| 735 | 13:41:19 | code-generation | complex | single | single | explicit | — | — |  |
| 736 | 13:42:02 | code-generation | complex | single | single | explicit | — | — |  |
| 737 | 13:42:21 | general | complex | reinforcement | reinforcement | explicit | — | — |  |
| 738 | 13:42:36 | code-generation | complex | single | single | explicit | — | — |  |
| 739 | 13:43:20 | code-generation | complex | single | single | explicit | — | — |  |
| 740 | 13:43:40 | code-generation | complex | single | single | explicit | — | — |  |
| 741 | 13:43:58 | code-generation | complex | single | single | explicit | — | — |  |
| 742 | 13:44:15 | general | complex | debate | debate | explicit | — | — |  |
| 743 | 13:46:19 | general | simple | single | single | explicit | — | — |  |
| 744 | 13:46:23 | general | simple | single | single | explicit | — | — |  |
| 745 | 13:46:32 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 746 | 13:46:32 | general | complex | consensus | consensus | explicit | — | — |  |
| 747 | 13:46:33 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 748 | 13:51:37 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 749 | 13:51:37 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 750 | 13:51:37 | general | complex | consensus | consensus | explicit | — | — |  |
| 751 | 13:54:42 | code-generation | complex | single | single | explicit | — | — |  |
| 752 | 13:55:14 | general | complex | debate | debate | explicit | — | — |  |
| 753 | 13:56:00 | code-generation | complex | single | single | explicit | — | — |  |
| 754 | 13:56:12 | analysis | complex | single | single | explicit | — | — |  |
| 755 | 13:56:45 | general | complex | debate | debate | explicit | — | — |  |
| 756 | 13:56:56 | analysis | complex | single | single | explicit | — | — |  |
| 757 | 13:56:58 | code-generation | complex | single | single | explicit | — | — |  |
| 758 | 13:57:22 | code-generation | complex | single | single | explicit | — | — |  |
| 759 | 13:57:38 | general | complex | war-room | war-room | explicit | — | — |  |
| 760 | 13:57:56 | analysis | complex | single | single | explicit | — | — |  |
| 761 | 13:58:07 | general | complex | blind-debate | blind-debate | explicit | — | — |  |
| 762 | 13:58:16 | general | complex | debate | debate | explicit | — | — |  |
| 763 | 14:01:50 | general | simple | single | single | explicit | — | — |  |
| 764 | 14:01:55 | general | simple | single | single | explicit | — | — |  |
| 765 | 14:02:04 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 766 | 14:02:04 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 767 | 14:02:05 | general | complex | debate | debate | explicit | — | — |  |
| 768 | 14:03:36 | general | complex | debate | debate | explicit | — | — |  |
| 769 | 14:05:07 | general | complex | debate | debate | explicit | — | — |  |
| 770 | 14:06:44 | general | complex | debate | debate | explicit | — | — |  |
| 771 | 14:07:07 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 772 | 14:07:07 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 773 | 14:08:15 | general | complex | debate | debate | explicit | — | — |  |
| 774 | 14:09:47 | general | complex | debate | debate | explicit | — | — |  |
| 775 | 14:11:58 | general | complex | debate | debate | explicit | — | — |  |
| 776 | 14:12:23 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 777 | 14:12:24 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 778 | 14:13:29 | general | complex | debate | debate | explicit | — | — |  |
| 779 | 14:15:00 | general | complex | debate | debate | explicit | — | — |  |
| 780 | 14:16:33 | general | complex | war-room | war-room | explicit | — | — |  |
| 781 | 14:17:24 | general | complex | blind-debate | blind-debate | explicit | — | — |  |
| 782 | 14:17:25 | general | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 783 | 14:21:37 | general | complex | war-room | war-room | explicit | — | — |  |
| 784 | 14:22:07 | general | moderate | single | single | explicit | — | — |  |
| 785 | 14:22:11 | general | moderate | single | single | explicit | — | — |  |
| 786 | 14:22:29 | general | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 787 | 14:22:29 | general | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 788 | 14:22:29 | general | complex | blind-debate | blind-debate | explicit | — | — |  |
| 789 | 14:23:51 | code-generation | complex | single | single | explicit | — | — |  |
| 790 | 14:23:59 | general | complex | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 791 | 14:24:06 | code-generation | complex | single | single | explicit | — | — |  |
| 792 | 14:24:18 | general | complex | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 793 | 14:26:15 | code-generation | complex | single | single | explicit | — | — |  |
| 794 | 14:26:57 | general | complex | swarm-explore | swarm-explore | explicit | — | — |  |
| 795 | 14:27:01 | analysis | complex | single | single | explicit | — | — |  |
| 796 | 14:28:01 | analysis | complex | single | single | explicit | — | — |  |
| 797 | 14:29:01 | analysis | complex | single | single | explicit | — | — |  |
| 798 | 14:29:18 | general | complex | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 799 | 14:29:23 | general | complex | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 800 | 14:30:01 | reasoning | complex | single | single | explicit | — | — |  |
| 801 | 14:30:02 | analysis | complex | single | single | explicit | — | — |  |
| 802 | 14:31:00 | reasoning | complex | single | single | explicit | — | — |  |
| 803 | 14:31:03 | general | complex | clarification-first | clarification-first | explicit | — | — |  |
| 804 | 14:31:06 | code-generation | complex | single | single | explicit | — | — |  |
| 805 | 14:32:00 | reasoning | complex | single | single | explicit | — | — |  |
| 806 | 14:32:08 | code-generation | complex | single | single | explicit | — | — |  |
| 807 | 14:33:00 | reasoning | complex | single | single | explicit | — | — |  |
| 808 | 14:33:07 | general | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 809 | 14:33:12 | analysis | complex | single | single | explicit | — | — |  |
| 810 | 14:33:34 | general | complex | critique-repair | critique-repair | explicit | — | — |  |
| 811 | 14:33:35 | general | complex | double-diamond | double-diamond | explicit | — | — |  |
| 812 | 14:34:14 | code-generation | complex | single | single | explicit | — | — |  |
| 813 | 14:34:22 | general | complex | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 814 | 14:35:08 | general | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 815 | 14:35:22 | code-generation | complex | single | single | explicit | — | — |  |
| 816 | 14:35:44 | code-generation | complex | single | single | explicit | — | — |  |
| 817 | 14:35:53 | code-generation | complex | single | single | explicit | — | — |  |
| 818 | 14:36:03 | general | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 819 | 14:36:14 | general | complex | agentic | agentic | explicit | — | — |  |
| 820 | 14:37:09 | general | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 821 | 14:38:13 | general | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 822 | 14:39:36 | general | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 823 | 14:40:11 | general | complex | agentic | agentic | explicit | — | — |  |
| 824 | 14:40:30 | general | moderate | single | single | explicit | — | — |  |
| 825 | 14:40:33 | general | moderate | single | single | explicit | — | — |  |
| 826 | 14:41:42 | general | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 827 | 14:41:42 | general | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 828 | 14:41:42 | general | moderate | single | single | explicit | — | — |  |
| 829 | 14:41:43 | analysis | complex | single | single | explicit | — | — |  |
| 830 | 14:41:54 | general | complex | single | single | explicit | — | — |  |
| 831 | 14:42:34 | general | moderate | single | single | explicit | — | — |  |
| 832 | 14:42:43 | analysis | complex | single | single | explicit | — | — |  |
| 833 | 14:43:36 | general | complex | single | single | explicit | — | — |  |
| 834 | 14:43:39 | general | complex | auto | single | bandit | — | — |  |
| 835 | 14:46:51 | general | complex | single | single | explicit | — | — |  |
| 836 | 14:47:19 | code-generation | complex | single | single | explicit | — | — |  |
| 837 | 14:48:20 | code-generation | complex | single | single | explicit | — | — |  |
| 838 | 14:48:44 | general | complex | auto | single | bandit | — | — |  |
| 839 | 14:49:19 | code-generation | complex | single | single | explicit | — | — |  |
| 840 | 14:50:31 | code-generation | complex | single | single | explicit | — | — |  |
| 841 | 14:50:33 | qa | moderate | single | single | explicit | — | — |  |
| 842 | 14:51:31 | code-generation | complex | single | single | explicit | — | — |  |
| 843 | 14:51:46 | analysis | complex | single | single | explicit | — | — |  |
| 844 | 14:51:56 | qa | moderate | single | single | explicit | — | — |  |
| 845 | 14:52:32 | code-generation | complex | single | single | explicit | — | — |  |
| 846 | 14:53:32 | code-generation | complex | single | single | explicit | — | — |  |
| 847 | 14:53:59 | general | complex | auto | single | bandit | — | — |  |
| 848 | 14:54:33 | qa | moderate | single | single | explicit | — | — |  |
| 849 | 14:57:02 | qa | moderate | single | single | explicit | — | — |  |
| 850 | 14:59:17 | qa | moderate | single | single | explicit | — | — |  |
| 851 | 14:59:38 | qa | moderate | single | single | explicit | — | — |  |
| 852 | 15:02:01 | analysis | complex | single | single | explicit | — | — |  |
| 853 | 15:02:42 | analysis | complex | single | single | explicit | — | — |  |
| 854 | 15:03:42 | analysis | complex | single | single | explicit | — | — |  |
| 855 | 15:03:58 | analysis | complex | single | single | explicit | — | — |  |
| 856 | 15:04:22 | qa | moderate | single | single | explicit | — | — |  |
| 857 | 15:04:42 | analysis | complex | single | single | explicit | — | — |  |
| 858 | 15:05:47 | analysis | complex | single | single | explicit | — | — |  |
| 859 | 15:05:48 | qa | moderate | single | single | explicit | — | — |  |
| 860 | 15:05:58 | analysis | complex | single | single | explicit | — | — |  |
| 861 | 15:06:59 | analysis | complex | single | single | explicit | — | — |  |
| 862 | 15:08:01 | qa | moderate | single | single | explicit | — | — |  |
| 863 | 15:09:11 | reasoning | complex | single | single | explicit | — | — |  |
| 864 | 15:09:41 | analysis | complex | single | single | explicit | — | — |  |
| 865 | 15:09:42 | qa | moderate | single | single | explicit | — | — |  |
| 866 | 15:10:11 | reasoning | complex | single | single | explicit | — | — |  |
| 867 | 15:10:30 | analysis | complex | single | single | explicit | — | — |  |
| 868 | 15:10:49 | qa | moderate | collaborative | collaborative | explicit | — | — |  |
| 869 | 15:11:31 | analysis | complex | single | single | explicit | — | — |  |
| 870 | 15:12:03 | qa | moderate | parallel | parallel | explicit | — | — |  |
| 871 | 15:13:08 | reasoning | complex | single | single | explicit | — | — |  |
| 872 | 15:14:08 | reasoning | complex | single | single | explicit | — | — |  |
| 873 | 15:15:07 | reasoning | complex | single | single | explicit | — | — |  |
| 874 | 15:15:29 | qa | moderate | sequential | sequential | explicit | — | — |  |
| 875 | 15:15:54 | qa | moderate | collaborative | collaborative | explicit | — | — |  |
| 876 | 15:17:09 | qa | moderate | parallel | parallel | explicit | — | — |  |
| 877 | 15:19:15 | qa | moderate | hybrid | hybrid | explicit | — | — |  |
| 878 | 15:19:57 | qa | moderate | competitive | competitive | explicit | — | — |  |
| 879 | 15:21:09 | qa | moderate | collaborative | collaborative | explicit | — | — |  |
| 880 | 15:21:30 | reasoning | moderate | single | single | explicit | — | — |  |
| 881 | 15:21:38 | qa | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 882 | 15:21:59 | reasoning | moderate | single | single | explicit | — | — |  |
| 883 | 15:22:18 | qa | moderate | massive-parallel | massive-parallel | explicit | — | — |  |
| 884 | 15:22:28 | reasoning | moderate | single | single | explicit | — | — |  |
| 885 | 15:22:47 | qa | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 886 | 15:23:02 | analysis | complex | single | single | explicit | — | — |  |
| 887 | 15:23:31 | qa | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 888 | 15:23:34 | qa | moderate | adaptive | adaptive | explicit | — | — |  |
| 889 | 15:23:37 | qa | moderate | contextual | contextual | explicit | — | — |  |
| 890 | 15:25:18 | reasoning | complex | single | single | explicit | — | — |  |
| 891 | 15:26:11 | qa | moderate | hierarchical | hierarchical | explicit | — | — |  |
| 892 | 15:26:30 | reasoning | moderate | single | single | explicit | — | — |  |
| 893 | 15:26:30 | reasoning | complex | single | single | explicit | — | — |  |
| 894 | 15:26:38 | qa | moderate | consensus | consensus | explicit | — | — |  |
| 895 | 15:27:18 | reasoning | complex | single | single | explicit | — | — |  |
| 896 | 15:27:19 | qa | moderate | reinforcement | reinforcement | explicit | — | — |  |
| 897 | 15:27:22 | reasoning | moderate | single | single | explicit | — | — |  |
| 898 | 15:27:29 | qa | moderate | debate | debate | explicit | — | — |  |
| 899 | 15:27:52 | qa | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 900 | 15:28:18 | reasoning | complex | single | single | explicit | — | — |  |
| 901 | 15:28:44 | qa | moderate | war-room | war-room | explicit | — | — |  |
| 902 | 15:29:11 | reasoning | complex | single | single | explicit | — | — |  |
| 903 | 15:29:45 | qa | moderate | blind-debate | blind-debate | explicit | — | — |  |
| 904 | 15:30:13 | architecture | complex | single | single | explicit | — | — |  |
| 905 | 15:30:27 | qa | moderate | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 906 | 15:30:50 | reasoning | moderate | single | single | explicit | — | — |  |
| 907 | 15:31:00 | analysis | complex | single | single | explicit | — | — |  |
| 908 | 15:31:49 | reasoning | moderate | single | single | explicit | — | — |  |
| 909 | 15:31:56 | qa | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 910 | 15:31:59 | analysis | complex | single | single | explicit | — | — |  |
| 911 | 15:32:55 | qa | moderate | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 912 | 15:33:07 | qa | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 913 | 15:34:11 | reasoning | moderate | single | single | explicit | — | — |  |
| 914 | 15:34:11 | reasoning | moderate | single | single | explicit | — | — |  |
| 915 | 15:34:20 | qa | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 916 | 15:34:21 | reasoning | moderate | single | single | explicit | — | — |  |
| 917 | 15:34:28 | qa | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 918 | 15:34:29 | reasoning | moderate | single | single | explicit | — | — |  |
| 919 | 15:34:38 | qa | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 920 | 15:34:39 | reasoning | moderate | single | single | explicit | — | — |  |
| 921 | 15:34:48 | qa | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 922 | 15:34:51 | qa | moderate | critique-repair | critique-repair | explicit | — | — |  |
| 923 | 15:34:54 | qa | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 924 | 15:34:54 | qa | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 925 | 15:34:57 | qa | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 926 | 15:34:57 | qa | moderate | agentic | agentic | explicit | — | — |  |
| 927 | 15:34:58 | reasoning | moderate | single | single | explicit | — | — |  |
| 928 | 15:34:59 | qa | moderate | single | single | explicit | — | — |  |
| 929 | 15:35:05 | qa | moderate | single | single | explicit | — | — |  |
| 930 | 15:35:10 | qa | moderate | auto | single | heuristic | — | — |  |
| 931 | 15:35:17 | code-generation | simple | single | single | explicit | — | — |  |
| 932 | 15:35:41 | code-generation | complex | single | single | explicit | — | — |  |
| 933 | 15:36:07 | reasoning | complex | single | single | explicit | — | — |  |
| 934 | 15:36:41 | code-generation | complex | single | single | explicit | — | — |  |
| 935 | 15:36:44 | code-generation | simple | single | single | explicit | — | — |  |
| 936 | 15:37:42 | code-generation | complex | single | single | explicit | — | — |  |
| 937 | 15:38:03 | reasoning | complex | single | single | explicit | — | — |  |
| 938 | 15:38:16 | code-generation | simple | single | single | explicit | — | — |  |
| 939 | 15:38:41 | code-generation | complex | single | single | explicit | — | — |  |
| 940 | 15:38:44 | code-generation | simple | single | single | explicit | — | — |  |
| 941 | 15:38:57 | code-generation | complex | single | single | explicit | — | — |  |
| 942 | 15:39:43 | code-generation | simple | single | single | explicit | — | — |  |
| 943 | 15:39:54 | code-generation | complex | single | single | explicit | — | — |  |
| 944 | 15:39:57 | code-generation | complex | single | single | explicit | — | — |  |
| 945 | 15:40:25 | code-generation | simple | single | single | explicit | — | — |  |
| 946 | 15:40:54 | code-generation | complex | single | single | explicit | — | — |  |
| 947 | 15:41:13 | code-generation | complex | single | single | explicit | — | — |  |
| 948 | 15:41:25 | code-generation | complex | single | single | explicit | — | — |  |
| 949 | 15:41:54 | code-generation | complex | single | single | explicit | — | — |  |
| 950 | 15:42:06 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 951 | 15:42:09 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 952 | 15:42:13 | code-generation | complex | single | single | explicit | — | — |  |
| 953 | 15:42:54 | code-generation | complex | single | single | explicit | — | — |  |
| 954 | 15:43:13 | code-generation | complex | single | single | explicit | — | — |  |
| 955 | 15:43:56 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 956 | 15:44:13 | code-generation | complex | single | single | explicit | — | — |  |
| 957 | 15:46:36 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 958 | 15:46:39 | code-generation | simple | expert-panel | expert-panel | explicit | — | — |  |
| 959 | 15:46:42 | code-generation | simple | massive-parallel | massive-parallel | explicit | — | — |  |
| 960 | 15:46:44 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 961 | 15:46:47 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 962 | 15:46:49 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 963 | 15:47:14 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 964 | 15:47:49 | code-generation | complex | single | single | explicit | — | — |  |
| 965 | 15:48:49 | code-generation | complex | single | single | explicit | — | — |  |
| 966 | 15:49:01 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 967 | 15:49:39 | code-generation | simple | contextual | contextual | explicit | — | — |  |
| 968 | 15:49:41 | code-generation | simple | hierarchical | hierarchical | explicit | — | — |  |
| 969 | 15:49:44 | code-generation | simple | consensus | consensus | explicit | — | — |  |
| 970 | 15:49:46 | code-generation | simple | reinforcement | reinforcement | explicit | — | — |  |
| 971 | 15:49:51 | code-generation | simple | debate | debate | explicit | — | — |  |
| 972 | 15:49:54 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 973 | 15:49:56 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 974 | 15:50:05 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 975 | 15:50:08 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 976 | 15:50:09 | code-generation | moderate | single | single | explicit | — | — |  |
| 977 | 15:51:10 | code-generation | moderate | single | single | explicit | — | — |  |
| 978 | 15:51:54 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 979 | 15:52:09 | code-generation | moderate | single | single | explicit | — | — |  |
| 980 | 15:53:09 | code-generation | moderate | single | single | explicit | — | — |  |
| 981 | 15:54:12 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 982 | 15:54:15 | code-generation | simple | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 983 | 15:54:16 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 984 | 15:54:23 | code-generation | simple | swarm-explore | swarm-explore | explicit | — | — |  |
| 985 | 15:54:25 | code-generation | simple | clarification-first | clarification-first | explicit | — | — |  |
| 986 | 15:54:28 | code-generation | simple | research-synthesize | research-synthesize | explicit | — | — |  |
| 987 | 15:54:30 | code-generation | simple | critique-repair | critique-repair | explicit | — | — |  |
| 988 | 15:54:33 | code-generation | simple | double-diamond | double-diamond | explicit | — | — |  |
| 989 | 15:54:35 | code-generation | simple | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 990 | 15:54:38 | code-generation | simple | persona-exploration | persona-exploration | explicit | — | — |  |
| 991 | 15:54:41 | code-generation | simple | agentic | agentic | explicit | — | — |  |
| 992 | 15:54:43 | code-generation | simple | single | single | explicit | — | — |  |
| 993 | 15:56:27 | code-generation | complex | single | single | explicit | — | — |  |
| 994 | 15:57:09 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 995 | 15:57:27 | code-generation | complex | single | single | explicit | — | — |  |
| 996 | 15:58:28 | code-generation | complex | single | single | explicit | — | — |  |
| 997 | 15:59:30 | code-generation | complex | single | single | explicit | — | — |  |
| 998 | 15:59:48 | code-generation | simple | single | single | explicit | — | — |  |
| 999 | 16:00:29 | code-generation | simple | single | single | explicit | — | — |  |
| 1000 | 16:00:48 | code-generation | complex | single | single | explicit | — | — |  |
| 1001 | 16:02:41 | code-generation | simple | single | single | explicit | — | — |  |
| 1002 | 16:03:31 | code-generation | simple | expert-panel | expert-panel | explicit | — | — |  |
| 1003 | 16:03:35 | code-generation | complex | single | single | explicit | — | — |  |
| 1004 | 16:04:21 | code-generation | moderate | single | single | explicit | — | — |  |
| 1005 | 16:05:04 | code-generation | simple | single | single | explicit | — | — |  |
| 1006 | 16:05:12 | code-generation | simple | single | single | explicit | — | — |  |
| 1007 | 16:05:28 | code-generation | complex | single | single | explicit | — | — |  |
| 1008 | 16:05:34 | code-generation | moderate | single | single | explicit | — | — |  |
| 1009 | 16:06:05 | code-generation | simple | single | single | explicit | — | — |  |
| 1010 | 16:06:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1011 | 16:06:28 | code-generation | complex | single | single | explicit | — | — |  |
| 1012 | 16:07:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1013 | 16:08:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1014 | 16:08:28 | code-generation | complex | single | single | explicit | — | — |  |
| 1015 | 16:08:56 | code-generation | complex | single | single | explicit | — | — |  |
| 1016 | 16:13:01 | code-generation | simple | single | single | explicit | — | — |  |
| 1017 | 16:13:02 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 1018 | 16:13:03 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 1019 | 16:13:20 | code-generation | complex | single | single | explicit | — | — |  |
| 1020 | 16:13:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1021 | 16:14:21 | code-generation | complex | single | single | explicit | — | — |  |
| 1022 | 16:14:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1023 | 16:15:01 | code-generation | complex | single | single | explicit | — | — |  |
| 1024 | 16:15:22 | code-generation | complex | single | single | explicit | — | — |  |
| 1025 | 16:15:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1026 | 16:16:01 | code-generation | complex | single | single | explicit | — | — |  |
| 1027 | 16:16:21 | code-generation | complex | single | single | explicit | — | — |  |
| 1028 | 16:16:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1029 | 16:17:01 | code-generation | complex | single | single | explicit | — | — |  |
| 1030 | 16:19:42 | code-generation | simple | massive-parallel | massive-parallel | explicit | — | — |  |
| 1031 | 16:19:44 | general | moderate | single | single | explicit | — | — |  |
| 1032 | 16:19:48 | general | moderate | single | single | explicit | — | — |  |
| 1033 | 16:19:48 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 1034 | 16:19:55 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 1035 | 16:19:58 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 1036 | 16:19:59 | code-generation | simple | contextual | contextual | explicit | — | — |  |
| 1037 | 16:20:00 | general | moderate | single | single | explicit | — | — |  |
| 1038 | 16:20:05 | code-generation | simple | hierarchical | hierarchical | explicit | — | — |  |
| 1039 | 16:20:06 | general | moderate | single | single | explicit | — | — |  |
| 1040 | 16:20:10 | code-generation | simple | consensus | consensus | explicit | — | — |  |
| 1041 | 16:20:13 | code-generation | simple | reinforcement | reinforcement | explicit | — | — |  |
| 1042 | 16:20:15 | general | moderate | single | single | explicit | — | — |  |
| 1043 | 16:20:19 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1044 | 16:20:21 | general | moderate | single | single | explicit | — | — |  |
| 1045 | 16:20:25 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 1046 | 16:20:26 | general | moderate | single | single | explicit | — | — |  |
| 1047 | 16:20:31 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 1048 | 16:20:32 | general | moderate | single | single | explicit | — | — |  |
| 1049 | 16:20:43 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1050 | 16:20:45 | general | moderate | single | single | explicit | — | — |  |
| 1051 | 16:20:49 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 1052 | 16:20:50 | general | moderate | single | single | explicit | — | — |  |
| 1053 | 16:20:55 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 1054 | 16:20:57 | general | moderate | single | single | explicit | — | — |  |
| 1055 | 16:21:04 | code-generation | simple | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 1056 | 16:21:06 | general | moderate | single | single | explicit | — | — |  |
| 1057 | 16:21:12 | code-generation | complex | single | single | explicit | — | — |  |
| 1058 | 16:21:12 | code-generation | simple | swarm-explore | swarm-explore | explicit | — | — |  |
| 1059 | 16:21:14 | general | moderate | single | single | explicit | — | — |  |
| 1060 | 16:21:19 | code-generation | simple | clarification-first | clarification-first | explicit | — | — |  |
| 1061 | 16:21:20 | general | moderate | single | single | explicit | — | — |  |
| 1062 | 16:21:26 | code-generation | simple | research-synthesize | research-synthesize | explicit | — | — |  |
| 1063 | 16:24:32 | code-generation | simple | research-synthesize | research-synthesize | explicit | — | — |  |
| 1064 | 16:24:32 | code-generation | simple | double-diamond | double-diamond | explicit | — | — |  |
| 1065 | 16:24:36 | code-generation | simple | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 1066 | 16:24:59 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 1067 | 16:25:02 | code-generation | simple | persona-exploration | persona-exploration | explicit | — | — |  |
| 1068 | 16:25:05 | code-generation | simple | agentic | agentic | explicit | — | — |  |
| 1069 | 16:25:07 | code-generation | simple | single | single | explicit | — | — |  |
| 1070 | 16:25:11 | code-generation | complex | single | single | explicit | — | — |  |
| 1071 | 16:25:15 | code-generation | moderate | single | single | explicit | — | — |  |
| 1072 | 16:25:18 | code-generation | moderate | single | single | explicit | — | — |  |
| 1073 | 16:26:11 | code-generation | complex | single | single | explicit | — | — |  |
| 1074 | 16:26:15 | code-generation | moderate | single | single | explicit | — | — |  |
| 1075 | 16:26:19 | code-generation | moderate | single | single | explicit | — | — |  |
| 1076 | 16:27:11 | code-generation | complex | single | single | explicit | — | — |  |
| 1077 | 16:27:15 | code-generation | moderate | single | single | explicit | — | — |  |
| 1078 | 16:27:18 | code-generation | moderate | single | single | explicit | — | — |  |
| 1079 | 16:28:11 | code-generation | complex | single | single | explicit | — | — |  |
| 1080 | 16:28:15 | code-generation | moderate | single | single | explicit | — | — |  |
| 1081 | 16:28:18 | code-generation | moderate | single | single | explicit | — | — |  |
| 1082 | 16:29:13 | code-generation | simple | single | single | explicit | — | — |  |
| 1083 | 16:29:20 | general | moderate | single | single | explicit | — | — |  |
| 1084 | 16:29:25 | general | simple | auto | adaptive | archive | 0.30 | — |  |
| 1085 | 16:29:56 | code-generation | moderate | single | single | explicit | — | — |  |
| 1086 | 16:30:55 | code-generation | moderate | single | single | explicit | — | — |  |
| 1087 | 16:30:56 | analysis | complex | single | single | explicit | — | — |  |
| 1088 | 16:31:17 | general | moderate | single | single | explicit | — | — |  |
| 1089 | 16:31:48 | code-generation | complex | single | single | explicit | — | — |  |
| 1090 | 16:31:55 | code-generation | moderate | single | single | explicit | — | — |  |
| 1091 | 16:32:48 | code-generation | complex | single | single | explicit | — | — |  |
| 1092 | 16:32:55 | code-generation | moderate | single | single | explicit | — | — |  |
| 1093 | 16:33:32 | reasoning | complex | single | single | explicit | — | — |  |
| 1094 | 16:33:36 | general | moderate | single | single | explicit | — | — |  |
| 1095 | 16:33:48 | code-generation | complex | single | single | explicit | — | — |  |
| 1096 | 16:33:52 | general | moderate | single | single | explicit | — | — |  |
| 1097 | 16:34:48 | code-generation | complex | single | single | explicit | — | — |  |
| 1098 | 16:35:51 | general | moderate | single | single | explicit | — | — |  |
| 1099 | 16:36:06 | code-generation | complex | single | single | explicit | — | — |  |
| 1100 | 16:38:08 | general | moderate | single | single | explicit | — | — |  |
| 1101 | 16:38:40 | code-generation | complex | single | single | explicit | — | — |  |
| 1102 | 16:39:07 | architecture | complex | single | single | explicit | — | — |  |
| 1103 | 16:39:33 | general | moderate | collaborative | collaborative | explicit | — | — |  |
| 1104 | 16:39:35 | general | moderate | parallel | parallel | explicit | — | — |  |
| 1105 | 16:39:40 | code-generation | complex | single | single | explicit | — | — |  |
| 1106 | 16:40:07 | architecture | complex | single | single | explicit | — | — |  |
| 1107 | 16:40:40 | code-generation | complex | single | single | explicit | — | — |  |
| 1108 | 16:41:07 | architecture | complex | single | single | explicit | — | — |  |
| 1109 | 16:41:40 | code-generation | complex | single | single | explicit | — | — |  |
| 1110 | 16:42:07 | architecture | complex | single | single | explicit | — | — |  |
| 1111 | 16:42:42 | general | moderate | sequential | sequential | explicit | — | — |  |
| 1112 | 16:43:09 | general | moderate | hybrid | hybrid | explicit | — | — |  |
| 1113 | 16:44:06 | code-generation | complex | single | single | explicit | — | — |  |
| 1114 | 16:45:01 | general | complex | single | single | explicit | — | — |  |
| 1115 | 16:45:06 | code-generation | complex | single | single | explicit | — | — |  |
| 1116 | 16:45:16 | general | moderate | competitive | competitive | explicit | — | — |  |
| 1117 | 16:45:19 | general | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 1118 | 16:45:21 | general | moderate | massive-parallel | massive-parallel | explicit | — | — |  |
| 1119 | 16:45:24 | general | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 1120 | 16:45:26 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 1121 | 16:45:29 | general | moderate | adaptive | adaptive | explicit | — | — |  |
| 1122 | 16:45:55 | general | complex | single | single | explicit | — | — |  |
| 1123 | 16:46:06 | code-generation | complex | single | single | explicit | — | — |  |
| 1124 | 16:46:11 | general | moderate | contextual | contextual | explicit | — | — |  |
| 1125 | 16:46:15 | general | moderate | hierarchical | hierarchical | explicit | — | — |  |
| 1126 | 16:46:18 | general | moderate | consensus | consensus | explicit | — | — |  |
| 1127 | 16:46:21 | general | moderate | reinforcement | reinforcement | explicit | — | — |  |
| 1128 | 16:46:23 | general | moderate | debate | debate | explicit | — | — |  |
| 1129 | 16:46:26 | general | moderate | war-room | war-room | explicit | — | — |  |
| 1130 | 16:46:29 | general | moderate | blind-debate | blind-debate | explicit | — | — |  |
| 1131 | 16:46:31 | general | moderate | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1132 | 16:46:34 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 1133 | 16:46:35 | architecture | moderate | single | single | explicit | — | — |  |
| 1134 | 16:46:45 | general | moderate | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 1135 | 16:46:48 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 1136 | 16:46:50 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 1137 | 16:46:53 | general | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 1138 | 16:46:55 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 1139 | 16:46:58 | general | moderate | critique-repair | critique-repair | explicit | — | — |  |
| 1140 | 16:47:00 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 1141 | 16:47:03 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 1142 | 16:47:05 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 1143 | 16:47:06 | code-generation | complex | single | single | explicit | — | — |  |
| 1144 | 16:47:08 | general | moderate | agentic | agentic | explicit | — | — |  |
| 1145 | 16:47:11 | general | moderate | single | single | explicit | — | — |  |
| 1146 | 16:47:54 | architecture | complex | single | single | explicit | — | — |  |
| 1147 | 16:48:10 | general | moderate | single | single | explicit | — | — |  |
| 1148 | 16:48:46 | code-generation | complex | single | single | explicit | — | — |  |
| 1149 | 16:48:56 | architecture | complex | single | single | explicit | — | — |  |
| 1150 | 16:49:46 | code-generation | complex | single | single | explicit | — | — |  |
| 1151 | 16:49:54 | architecture | complex | single | single | explicit | — | — |  |
| 1152 | 16:50:34 | general | moderate | adaptive | adaptive | explicit | — | — |  |
| 1153 | 16:50:47 | code-generation | complex | single | single | explicit | — | — |  |
| 1154 | 16:50:54 | architecture | complex | single | single | explicit | — | — |  |
| 1155 | 16:51:46 | code-generation | complex | single | single | explicit | — | — |  |
| 1156 | 16:51:55 | general | moderate | auto | hybrid | pareto | — | — |  |
| 1157 | 16:52:49 | reasoning | complex | single | single | explicit | — | — |  |
| 1158 | 16:55:35 | code-generation | complex | single | single | explicit | — | — |  |
| 1159 | 16:55:49 | general | moderate | adaptive | adaptive | explicit | — | — |  |
| 1160 | 16:56:35 | code-generation | complex | single | single | explicit | — | — |  |
| 1161 | 16:57:36 | code-generation | complex | single | single | explicit | — | — |  |
| 1162 | 16:57:53 | reasoning | complex | single | single | explicit | — | — |  |
| 1163 | 16:58:37 | code-generation | complex | single | single | explicit | — | — |  |
| 1164 | 16:59:38 | reasoning | complex | single | single | explicit | — | — |  |
| 1165 | 17:00:52 | reasoning | complex | single | single | explicit | — | — |  |
| 1166 | 17:02:04 | reasoning | complex | single | single | explicit | — | — |  |
| 1167 | 17:03:03 | reasoning | complex | single | single | explicit | — | — |  |
| 1168 | 17:03:08 | reasoning | complex | single | single | explicit | — | — |  |
| 1169 | 17:04:03 | reasoning | complex | single | single | explicit | — | — |  |
| 1170 | 17:05:05 | reasoning | complex | single | single | explicit | — | — |  |
| 1171 | 17:05:56 | reasoning | complex | single | single | explicit | — | — |  |
| 1172 | 17:06:06 | reasoning | complex | single | single | explicit | — | — |  |
| 1173 | 17:08:10 | reasoning | complex | single | single | explicit | — | — |  |
| 1174 | 17:09:29 | reasoning | complex | single | single | explicit | — | — |  |
| 1175 | 17:10:29 | reasoning | complex | single | single | explicit | — | — |  |
| 1176 | 17:10:48 | reasoning | complex | single | single | explicit | — | — |  |
| 1177 | 17:11:10 | reasoning | complex | single | single | explicit | — | — |  |
| 1178 | 17:12:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1179 | 17:13:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1180 | 17:13:15 | reasoning | complex | single | single | explicit | — | — |  |
| 1181 | 17:14:01 | reasoning | complex | single | single | explicit | — | — |  |
| 1182 | 17:15:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1183 | 17:16:02 | reasoning | complex | collaborative | collaborative | explicit | — | — |  |
| 1184 | 17:16:25 | reasoning | complex | single | single | explicit | — | — |  |
| 1185 | 17:18:32 | reasoning | complex | single | single | explicit | — | — |  |
| 1186 | 17:19:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1187 | 17:20:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1188 | 17:21:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1189 | 17:21:27 | reasoning | complex | parallel | parallel | explicit | — | — |  |
| 1190 | 17:22:00 | reasoning | complex | single | single | explicit | — | — |  |
| 1191 | 17:23:02 | reasoning | complex | sequential | sequential | explicit | — | — |  |
| 1192 | 17:23:33 | reasoning | complex | hybrid | hybrid | explicit | — | — |  |
| 1193 | 17:25:03 | reasoning | complex | single | single | explicit | — | — |  |
| 1194 | 17:26:03 | reasoning | complex | single | single | explicit | — | — |  |
| 1195 | 17:27:03 | reasoning | complex | single | single | explicit | — | — |  |
| 1196 | 17:27:23 | reasoning | complex | single | single | explicit | — | — |  |
| 1197 | 17:28:01 | reasoning | complex | competitive | competitive | explicit | — | — |  |
| 1198 | 17:28:07 | reasoning | complex | sequential | sequential | explicit | — | — |  |
| 1199 | 17:28:23 | reasoning | complex | single | single | explicit | — | — |  |
| 1200 | 17:29:23 | reasoning | complex | single | single | explicit | — | — |  |
| 1201 | 17:30:05 | reasoning | complex | single | single | explicit | — | — |  |
| 1202 | 17:30:24 | reasoning | complex | single | single | explicit | — | — |  |
| 1203 | 17:31:05 | reasoning | complex | single | single | explicit | — | — |  |
| 1204 | 17:31:25 | reasoning | complex | expert-panel | expert-panel | explicit | — | — |  |
| 1205 | 17:32:05 | reasoning | complex | single | single | explicit | — | — |  |
| 1206 | 17:32:19 | reasoning | complex | single | single | explicit | — | — |  |
| 1207 | 17:33:05 | reasoning | complex | single | single | explicit | — | — |  |
| 1208 | 17:33:19 | reasoning | complex | single | single | explicit | — | — |  |
| 1209 | 17:34:07 | reasoning | complex | massive-parallel | massive-parallel | explicit | — | — |  |
| 1210 | 17:34:10 | reasoning | complex | cost-cascade | cost-cascade | explicit | — | — |  |
| 1211 | 17:34:12 | reasoning | complex | quality-multipass | quality-multipass | explicit | — | — |  |
| 1212 | 17:34:15 | reasoning | complex | adaptive | adaptive | explicit | — | — |  |
| 1213 | 17:34:17 | reasoning | complex | contextual | contextual | explicit | — | — |  |
| 1214 | 17:34:19 | reasoning | complex | single | single | explicit | — | — |  |
| 1215 | 17:34:20 | reasoning | complex | hierarchical | hierarchical | explicit | — | — |  |
| 1216 | 17:34:22 | reasoning | complex | consensus | consensus | explicit | — | — |  |
| 1217 | 17:34:25 | reasoning | complex | reinforcement | reinforcement | explicit | — | — |  |
| 1218 | 17:34:28 | reasoning | complex | debate | debate | explicit | — | — |  |
| 1219 | 17:34:30 | reasoning | complex | war-room | war-room | explicit | — | — |  |
| 1220 | 17:34:33 | reasoning | complex | blind-debate | blind-debate | explicit | — | — |  |
| 1221 | 17:34:35 | reasoning | complex | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1222 | 17:34:38 | reasoning | complex | safety-quorum | safety-quorum | explicit | — | — |  |
| 1223 | 17:34:38 | general | moderate | single | single | explicit | — | — |  |
| 1224 | 17:34:54 | reasoning | complex | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 1225 | 17:34:56 | reasoning | complex | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 1226 | 17:34:59 | reasoning | complex | swarm-explore | swarm-explore | explicit | — | — |  |
| 1227 | 17:35:01 | reasoning | complex | clarification-first | clarification-first | explicit | — | — |  |
| 1228 | 17:35:04 | reasoning | complex | research-synthesize | research-synthesize | explicit | — | — |  |
| 1229 | 17:35:06 | reasoning | complex | critique-repair | critique-repair | explicit | — | — |  |
| 1230 | 17:35:09 | reasoning | complex | double-diamond | double-diamond | explicit | — | — |  |
| 1231 | 17:35:12 | reasoning | complex | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 1232 | 17:35:14 | reasoning | complex | persona-exploration | persona-exploration | explicit | — | — |  |
| 1233 | 17:35:17 | reasoning | complex | agentic | agentic | explicit | — | — |  |
| 1234 | 17:35:19 | reasoning | complex | single | single | explicit | — | — |  |
| 1235 | 17:35:19 | reasoning | complex | single | single | explicit | — | — |  |
| 1236 | 17:36:21 | reasoning | complex | single | single | explicit | — | — |  |
| 1237 | 17:36:30 | reasoning | complex | expert-panel | expert-panel | explicit | — | — |  |
| 1238 | 17:36:40 | documentation | complex | auto | stigmergic-refinement | pareto | 0.30 | — |  |
| 1239 | 17:36:49 | reasoning | complex | single | single | explicit | — | — |  |
| 1240 | 17:36:50 | general | moderate | single | single | explicit | — | — |  |
| 1241 | 17:36:55 | general | moderate | single | single | explicit | — | — |  |
| 1242 | 17:37:48 | reasoning | complex | single | single | explicit | — | — |  |
| 1243 | 17:37:57 | architecture | complex | single | single | explicit | — | — |  |
| 1244 | 17:38:42 | reasoning | complex | single | single | explicit | — | — |  |
| 1245 | 17:38:48 | reasoning | complex | single | single | explicit | — | — |  |
| 1246 | 17:38:58 | architecture | complex | single | single | explicit | — | — |  |
| 1247 | 17:39:42 | reasoning | complex | single | single | explicit | — | — |  |
| 1248 | 17:39:48 | reasoning | complex | single | single | explicit | — | — |  |
| 1249 | 17:39:57 | architecture | complex | single | single | explicit | — | — |  |
| 1250 | 17:40:42 | reasoning | complex | single | single | explicit | — | — |  |
| 1251 | 17:40:50 | general | moderate | single | single | explicit | — | — |  |
| 1252 | 17:40:57 | architecture | complex | single | single | explicit | — | — |  |
| 1253 | 17:41:42 | reasoning | complex | single | single | explicit | — | — |  |
| 1254 | 17:42:01 | general | moderate | single | single | explicit | — | — |  |
| 1255 | 17:42:19 | analysis | complex | single | single | explicit | — | — |  |
| 1256 | 17:42:42 | analysis | complex | single | single | explicit | — | — |  |
| 1257 | 17:42:45 | general | moderate | single | single | explicit | — | — |  |
| 1258 | 17:42:57 | analysis | complex | single | single | explicit | — | — |  |
| 1259 | 17:43:11 | analysis | complex | single | single | explicit | — | — |  |
| 1260 | 17:43:44 | general | moderate | single | single | explicit | — | — |  |
| 1261 | 17:47:04 | general | moderate | single | single | explicit | — | — |  |
| 1262 | 17:47:50 | general | moderate | single | single | explicit | — | — |  |
| 1263 | 17:48:49 | general | moderate | single | single | explicit | — | — |  |
| 1264 | 17:52:19 | general | moderate | single | single | explicit | — | — |  |
| 1265 | 17:53:05 | general | moderate | single | single | explicit | — | — |  |
| 1266 | 17:53:17 | general | moderate | single | single | explicit | — | — |  |
| 1267 | 17:53:43 | general | moderate | collaborative | collaborative | explicit | — | — |  |
| 1268 | 17:53:46 | general | moderate | parallel | parallel | explicit | — | — |  |
| 1269 | 17:54:06 | general | moderate | single | single | explicit | — | — |  |
| 1270 | 17:54:33 | reasoning | complex | single | single | explicit | — | — |  |
| 1271 | 17:55:33 | reasoning | complex | single | single | explicit | — | — |  |
| 1272 | 17:56:34 | reasoning | complex | single | single | explicit | — | — |  |
| 1273 | 17:56:49 | general | moderate | sequential | sequential | explicit | — | — |  |
| 1274 | 17:57:08 | architecture | moderate | single | single | explicit | — | — |  |
| 1275 | 17:57:13 | general | moderate | hybrid | hybrid | explicit | — | — |  |
| 1276 | 17:58:01 | reasoning | complex | single | single | explicit | — | — |  |
| 1277 | 17:58:32 | general | moderate | competitive | competitive | explicit | — | — |  |
| 1278 | 17:58:35 | general | moderate | expert-panel | expert-panel | explicit | — | — |  |
| 1279 | 17:58:37 | general | moderate | massive-parallel | massive-parallel | explicit | — | — |  |
| 1280 | 17:58:40 | general | moderate | cost-cascade | cost-cascade | explicit | — | — |  |
| 1281 | 17:58:42 | general | moderate | quality-multipass | quality-multipass | explicit | — | — |  |
| 1282 | 17:58:45 | general | moderate | adaptive | adaptive | explicit | — | — |  |
| 1283 | 17:58:51 | general | moderate | parallel | parallel | explicit | — | — |  |
| 1284 | 17:59:01 | general | moderate | contextual | contextual | explicit | — | — |  |
| 1285 | 17:59:03 | general | moderate | hierarchical | hierarchical | explicit | — | — |  |
| 1286 | 17:59:07 | general | moderate | consensus | consensus | explicit | — | — |  |
| 1287 | 17:59:08 | general | moderate | reinforcement | reinforcement | explicit | — | — |  |
| 1288 | 17:59:10 | general | moderate | debate | debate | explicit | — | — |  |
| 1289 | 17:59:11 | general | moderate | war-room | war-room | explicit | — | — |  |
| 1290 | 17:59:13 | general | moderate | blind-debate | blind-debate | explicit | — | — |  |
| 1291 | 17:59:13 | general | moderate | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1292 | 17:59:15 | general | moderate | safety-quorum | safety-quorum | explicit | — | — |  |
| 1293 | 17:59:16 | general | moderate | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 1294 | 17:59:16 | architecture | moderate | single | single | explicit | — | — |  |
| 1295 | 17:59:19 | general | moderate | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 1296 | 17:59:19 | general | moderate | swarm-explore | swarm-explore | explicit | — | — |  |
| 1297 | 17:59:21 | general | moderate | clarification-first | clarification-first | explicit | — | — |  |
| 1298 | 17:59:22 | general | moderate | research-synthesize | research-synthesize | explicit | — | — |  |
| 1299 | 17:59:24 | general | moderate | critique-repair | critique-repair | explicit | — | — |  |
| 1300 | 17:59:24 | general | moderate | double-diamond | double-diamond | explicit | — | — |  |
| 1301 | 17:59:27 | general | moderate | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 1302 | 17:59:27 | general | moderate | persona-exploration | persona-exploration | explicit | — | — |  |
| 1303 | 17:59:29 | general | moderate | agentic | agentic | explicit | — | — |  |
| 1304 | 17:59:30 | general | moderate | single | single | explicit | — | — |  |
| 1305 | 17:59:32 | general | moderate | single | single | explicit | — | — |  |
| 1306 | 17:59:45 | architecture | moderate | single | single | explicit | — | — |  |
| 1307 | 17:59:59 | reasoning | complex | single | single | explicit | — | — |  |
| 1308 | 18:00:15 | architecture | moderate | single | single | explicit | — | — |  |
| 1309 | 18:01:14 | reasoning | complex | single | single | explicit | — | — |  |
| 1310 | 18:01:24 | reasoning | complex | single | single | explicit | — | — |  |
| 1311 | 18:01:33 | architecture | moderate | single | single | explicit | — | — |  |
| 1312 | 18:02:14 | reasoning | complex | single | single | explicit | — | — |  |
| 1313 | 18:02:24 | reasoning | complex | single | single | explicit | — | — |  |
| 1314 | 18:02:31 | general | moderate | auto | hybrid | pareto | — | — |  |
| 1315 | 18:03:12 | reasoning | complex | single | single | explicit | — | — |  |
| 1316 | 18:03:24 | reasoning | complex | single | single | explicit | — | — |  |
| 1317 | 18:04:00 | code-generation | simple | single | single | explicit | — | — |  |
| 1318 | 18:04:26 | reasoning | complex | single | single | explicit | — | — |  |
| 1319 | 18:05:13 | code-generation | simple | single | single | explicit | — | — |  |
| 1320 | 18:05:58 | code-generation | complex | single | single | explicit | — | — |  |
| 1321 | 18:06:11 | code-generation | simple | single | single | explicit | — | — |  |
| 1322 | 18:06:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1323 | 18:06:39 | code-generation | simple | single | single | explicit | — | — |  |
| 1324 | 18:07:24 | code-generation | complex | single | single | explicit | — | — |  |
| 1325 | 18:07:36 | general | moderate | auto | hybrid | pareto | — | — |  |
| 1326 | 18:07:37 | code-generation | simple | single | single | explicit | — | — |  |
| 1327 | 18:08:20 | code-generation | complex | single | single | explicit | — | — |  |
| 1328 | 18:08:39 | code-generation | simple | single | single | explicit | — | — |  |
| 1329 | 18:08:57 | code-generation | complex | single | single | explicit | — | — |  |
| 1330 | 18:09:23 | code-generation | complex | single | single | explicit | — | — |  |
| 1331 | 18:09:35 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 1332 | 18:09:36 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 1333 | 18:09:38 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 1334 | 18:10:20 | code-generation | complex | single | single | explicit | — | — |  |
| 1335 | 18:10:47 | code-generation | simple | hybrid | hybrid | explicit | — | — |  |
| 1336 | 18:11:16 | code-generation | complex | single | single | explicit | — | — |  |
| 1337 | 18:12:16 | code-generation | complex | single | single | explicit | — | — |  |
| 1338 | 18:12:51 | general | moderate | auto | hybrid | pareto | — | — |  |
| 1339 | 18:13:16 | code-generation | complex | single | single | explicit | — | — |  |
| 1340 | 18:14:16 | code-generation | complex | single | single | explicit | — | — |  |
| 1341 | 18:15:05 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 1342 | 18:15:07 | code-generation | simple | expert-panel | expert-panel | explicit | — | — |  |
| 1343 | 18:15:09 | code-generation | simple | massive-parallel | massive-parallel | explicit | — | — |  |
| 1344 | 18:15:12 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 1345 | 18:15:14 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 1346 | 18:15:16 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 1347 | 18:15:52 | code-generation | simple | hybrid | hybrid | explicit | — | — |  |
| 1348 | 18:16:34 | code-generation | complex | single | single | explicit | — | — |  |
| 1349 | 18:16:49 | code-generation | simple | contextual | contextual | explicit | — | — |  |
| 1350 | 18:16:51 | code-generation | simple | hierarchical | hierarchical | explicit | — | — |  |
| 1351 | 18:16:54 | code-generation | simple | consensus | consensus | explicit | — | — |  |
| 1352 | 18:16:56 | code-generation | simple | reinforcement | reinforcement | explicit | — | — |  |
| 1353 | 18:16:58 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1354 | 18:17:01 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 1355 | 18:17:04 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 1356 | 18:17:06 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1357 | 18:17:08 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 1358 | 18:17:23 | code-generation | complex | single | single | explicit | — | — |  |
| 1359 | 18:17:27 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 1360 | 18:17:29 | code-generation | simple | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 1361 | 18:17:32 | code-generation | simple | swarm-explore | swarm-explore | explicit | — | — |  |
| 1362 | 18:17:34 | code-generation | simple | clarification-first | clarification-first | explicit | — | — |  |
| 1363 | 18:17:36 | code-generation | simple | research-synthesize | research-synthesize | explicit | — | — |  |
| 1364 | 18:17:39 | code-generation | simple | critique-repair | critique-repair | explicit | — | — |  |
| 1365 | 18:17:39 | code-generation | simple | double-diamond | double-diamond | explicit | — | — |  |
| 1366 | 18:17:41 | code-generation | simple | multi-hop-qa | multi-hop-qa | explicit | — | — |  |
| 1367 | 18:17:41 | code-generation | simple | persona-exploration | persona-exploration | explicit | — | — |  |
| 1368 | 18:17:43 | code-generation | simple | agentic | agentic | explicit | — | — |  |
| 1369 | 18:17:44 | code-generation | simple | single | single | explicit | — | — |  |
| 1370 | 18:17:45 | code-generation | simple | single | single | explicit | — | — |  |
| 1371 | 18:18:20 | code-generation | complex | single | single | explicit | — | — |  |
| 1372 | 18:18:37 | code-generation | complex | single | single | explicit | — | — |  |
| 1373 | 18:19:20 | code-generation | complex | single | single | explicit | — | — |  |
| 1374 | 18:19:33 | code-generation | simple | auto | parallel | archive | 0.30 | — |  |
| 1375 | 18:19:38 | code-generation | complex | single | single | explicit | — | — |  |
| 1376 | 18:20:22 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 1377 | 18:20:38 | code-generation | complex | single | single | explicit | — | — |  |
| 1378 | 18:21:04 | code-generation | complex | single | single | explicit | — | — |  |
| 1379 | 18:21:38 | code-generation | complex | single | single | explicit | — | — |  |
| 1380 | 18:21:56 | code-generation | complex | single | single | explicit | — | — |  |
| 1381 | 18:22:04 | code-generation | complex | single | single | explicit | — | — |  |
| 1382 | 18:22:20 | code-generation | simple | single | single | explicit | — | — |  |
| 1383 | 18:22:41 | code-generation | simple | single | single | explicit | — | — |  |
| 1384 | 18:23:04 | code-generation | complex | single | single | explicit | — | — |  |
| 1385 | 18:25:26 | general | simple | single | single | explicit | — | — |  |
| 1386 | 18:28:15 | general | simple | single | single | explicit | — | — |  |
| 1387 | 18:29:15 | general | simple | single | single | explicit | — | — |  |
| 1388 | 18:57:29 | general | simple | single | single | explicit | — | — |  |
| 1389 | 18:59:57 | general | simple | single | single | explicit | — | — |  |
| 1390 | 00:09:19 | general | simple | single | single | explicit | — | — |  |
| 1391 | 00:10:40 | general | simple | single | single | explicit | — | — |  |
| 1392 | 00:42:08 | general | simple | single | single | explicit | — | — |  |
| 1393 | 00:42:38 | general | simple | single | single | explicit | — | — |  |
| 1394 | 00:42:42 | general | simple | single | single | explicit | — | — |  |
| 1395 | 00:42:55 | code-generation | simple | hybrid | hybrid | explicit | — | — |  |
| 1396 | 00:42:55 | code-generation | simple | single | single | explicit | — | — |  |
| 1397 | 00:43:03 | general | simple | auto | adaptive | archive | 0.30 | — |  |
| 1398 | 00:43:03 | analysis | complex | single | single | explicit | — | — |  |
| 1399 | 00:44:56 | code-generation | moderate | single | single | explicit | — | — |  |
| 1400 | 00:44:56 | analysis | complex | single | single | explicit | — | — |  |
| 1401 | 00:45:15 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 1402 | 00:45:30 | analysis | complex | single | single | explicit | — | — |  |
| 1403 | 00:45:55 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 1404 | 00:46:30 | analysis | complex | single | single | explicit | — | — |  |
| 1405 | 00:46:33 | code-generation | complex | single | single | explicit | — | — |  |
| 1406 | 00:47:09 | code-generation | simple | critique-repair | critique-repair | explicit | — | — |  |
| 1407 | 00:47:30 | analysis | complex | single | single | explicit | — | — |  |
| 1408 | 00:47:58 | analysis | complex | single | single | explicit | — | — |  |
| 1409 | 00:48:19 | code-generation | simple | single | single | explicit | — | — |  |
| 1410 | 00:48:58 | analysis | complex | single | single | explicit | — | — |  |
| 1411 | 00:49:01 | code-generation | complex | single | single | explicit | — | — |  |
| 1412 | 00:50:46 | code-generation | simple | single | single | explicit | — | — |  |
| 1413 | 00:50:46 | analysis | complex | single | single | explicit | — | — |  |
| 1414 | 00:51:09 | analysis | complex | single | single | explicit | — | — |  |
| 1415 | 00:51:44 | code-generation | simple | single | single | explicit | — | — |  |
| 1416 | 00:53:05 | code-generation | simple | single | single | explicit | — | — |  |
| 1417 | 00:53:23 | code-generation | simple | single | single | explicit | — | — |  |
| 1418 | 00:54:33 | code-generation | complex | single | single | explicit | — | — |  |
| 1419 | 00:54:57 | code-generation | simple | single | single | explicit | — | — |  |
| 1420 | 00:56:48 | code-generation | simple | single | single | explicit | — | — |  |
| 1421 | 00:57:42 | code-generation | complex | single | single | explicit | — | — |  |
| 1422 | 00:58:09 | code-generation | simple | single | single | explicit | — | — |  |
| 1423 | 00:58:10 | code-generation | simple | single | single | explicit | — | — |  |
| 1424 | 00:58:28 | code-generation | complex | single | single | explicit | — | — |  |
| 1425 | 00:58:53 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 1426 | 01:01:35 | code-generation | complex | single | single | explicit | — | — |  |
| 1427 | 01:01:44 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 1428 | 01:02:03 | code-generation | simple | single | single | explicit | — | — |  |
| 1429 | 01:03:58 | code-generation | simple | collaborative | collaborative | explicit | — | — |  |
| 1430 | 01:06:49 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 1431 | 01:07:05 | code-generation | simple | sequential | sequential | explicit | — | — |  |
| 1432 | 01:07:31 | code-generation | complex | single | single | explicit | — | — |  |
| 1433 | 01:07:50 | code-generation | simple | hybrid | hybrid | explicit | — | — |  |
| 1434 | 01:07:53 | code-generation | complex | single | single | explicit | — | — |  |
| 1435 | 01:08:06 | code-generation | complex | single | single | explicit | — | — |  |
| 1436 | 01:08:12 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 1437 | 01:08:27 | code-generation | simple | expert-panel | expert-panel | explicit | — | — |  |
| 1438 | 01:11:26 | code-generation | complex | single | single | explicit | — | — |  |
| 1439 | 01:11:30 | code-generation | simple | massive-parallel | massive-parallel | explicit | — | — |  |
| 1440 | 01:12:04 | code-generation | simple | parallel | parallel | explicit | — | — |  |
| 1441 | 01:13:17 | code-generation | simple | competitive | competitive | explicit | — | — |  |
| 1442 | 01:13:29 | code-generation | complex | single | single | explicit | — | — |  |
| 1443 | 01:13:40 | code-generation | complex | single | single | explicit | — | — |  |
| 1444 | 01:13:46 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 1445 | 01:14:09 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 1446 | 01:18:02 | code-generation | simple | adaptive | adaptive | explicit | — | — |  |
| 1447 | 01:19:19 | code-generation | simple | quality-multipass | quality-multipass | explicit | — | — |  |
| 1448 | 01:19:30 | code-generation | simple | cost-cascade | cost-cascade | explicit | — | — |  |
| 1449 | 01:20:36 | analysis | complex | single | single | explicit | — | — |  |
| 1450 | 01:21:28 | analysis | complex | single | single | explicit | — | — |  |
| 1451 | 01:23:45 | code-generation | simple | contextual | contextual | explicit | — | — |  |
| 1452 | 01:23:47 | code-generation | simple | hierarchical | hierarchical | explicit | — | — |  |
| 1453 | 01:24:00 | code-generation | complex | single | single | explicit | — | — |  |
| 1454 | 01:24:32 | code-generation | simple | consensus | consensus | explicit | — | — |  |
| 1455 | 01:24:36 | code-generation | complex | single | single | explicit | — | — |  |
| 1456 | 01:24:38 | code-generation | simple | reinforcement | reinforcement | explicit | — | — |  |
| 1457 | 01:25:13 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1458 | 01:26:32 | analysis | complex | single | single | explicit | — | — |  |
| 1459 | 01:26:44 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1460 | 01:27:32 | analysis | complex | single | single | explicit | — | — |  |
| 1461 | 01:27:42 | code-generation | complex | single | single | explicit | — | — |  |
| 1462 | 01:28:07 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 1463 | 01:28:15 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1464 | 01:28:32 | analysis | complex | single | single | explicit | — | — |  |
| 1465 | 01:29:32 | analysis | complex | single | single | explicit | — | — |  |
| 1466 | 01:29:51 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1467 | 01:30:35 | code-generation | simple | blind-debate | blind-debate | explicit | — | — |  |
| 1468 | 01:31:22 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1469 | 01:32:53 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1470 | 01:33:02 | code-generation | complex | single | single | explicit | — | — |  |
| 1471 | 01:33:14 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 1472 | 01:33:18 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1473 | 01:34:40 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1474 | 01:37:31 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1475 | 01:38:19 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1476 | 01:38:23 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1477 | 01:38:27 | code-generation | simple | war-room | war-room | explicit | — | — |  |
| 1478 | 01:39:02 | code-generation | simple | debate | debate | explicit | — | — |  |
| 1479 | 01:39:42 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 1480 | 01:41:43 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 1481 | 01:43:20 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1482 | 01:43:25 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1483 | 01:43:29 | code-generation | simple | diversity-ensemble | diversity-ensemble | explicit | — | — |  |
| 1484 | 01:43:38 | code-generation | simple | devil-advocate-consensus | devil-advocate-consensus | explicit | — | — |  |
| 1485 | 01:43:44 | code-generation | simple | safety-quorum | safety-quorum | explicit | — | — |  |
| 1486 | 01:44:09 | code-generation | complex | single | single | explicit | — | — |  |
| 1487 | 01:44:27 | code-generation | simple | stigmergic-refinement | stigmergic-refinement | explicit | — | — |  |
| 1488 | 01:44:41 | analysis | complex | single | single | explicit | — | — |  |
| 1489 | 01:45:33 | analysis | complex | single | single | explicit | — | — |  |
| 1490 | 01:45:39 | code-generation | complex | single | single | explicit | — | — |  |
| 1491 | 01:45:42 | analysis | complex | single | single | explicit | — | — |  |
| 1492 | 01:45:49 | code-generation | simple | swarm-explore | swarm-explore | explicit | — | — |  |
| 1493 | 01:46:34 | analysis | complex | single | single | explicit | — | — |  |
| 1494 | 01:46:42 | analysis | complex | single | single | explicit | — | — |  |
| 1495 | 01:46:47 | general | complex | single | single | explicit | — | — |  |
| 1496 | 01:47:33 | analysis | complex | single | single | explicit | — | — |  |
| 1497 | 01:47:42 | analysis | complex | single | single | explicit | — | — |  |
| 1498 | 01:47:47 | general | complex | single | single | explicit | — | — |  |
| 1499 | 01:48:33 | analysis | complex | single | single | explicit | — | — |  |
| 1500 | 01:48:44 | code-generation | simple | clarification-first | clarification-first | explicit | — | — |  |
| 1501 | 01:48:48 | general | complex | single | single | explicit | — | — |  |

---

## 7. Learning Data (Accumulated Patterns)

| Bucket | Task Type | Complexity | Count | Success Count | Avg Quality | Avg Cost | Avg Latency |
|--------|-----------|-----------|-------|--------------|-------------|----------|------------|
| 2026-04-10-18 | analysis | high | 1 | 1 | 0.52 | $0.0351 | 40028ms |
| 2026-04-10-03 | analysis | high | 1 | 1 | 0.52 | $0.0391 | 42415ms |
| 2026-03-30-06 | analysis | high | 1 | 1 | 0.80 | $0.0042 | 61309ms |
| 2026-04-02-04 | analysis | high | 1 | 1 | 0.52 | $0.0616 | 62317ms |
| 2026-03-30-07 | analysis | high | 2 | 2 | 0.64 | $0.0059 | 62093ms |
| 2026-04-02-15 | analysis | high | 2 | 2 | 0.52 | $0.0195 | 32677ms |
| 2026-04-10-21 | analysis | high | 1 | 1 | 0.52 | $0.0000 | 49845ms |
| 2026-04-02-03 | analysis | high | 1 | 1 | 0.52 | $0.0050 | 12990ms |
| 2026-04-11-14 | analysis | high | 1 | 1 | 0.52 | $0.0000 | 55975ms |
| 2026-04-09-19 | analysis | high | 1 | 1 | 0.52 | $0.0118 | 16120ms |
| 2026-04-10-02 | analysis | high | 1 | 1 | 0.52 | $0.0370 | 41094ms |
| 2026-04-11-07 | analysis | high | 1 | 1 | 0.52 | $0.0386 | 41798ms |
| 2026-04-02-10 | analysis | high | 2 | 2 | 0.52 | $0.0160 | 27384ms |
| 2026-04-10-07 | analysis | low | 18 | 18 | 1.00 | $0.0000 | 7610ms |
| 2026-03-18-04 | analysis | low | 2 | 2 | 0.83 | $0.0037 | 3816ms |
| 2026-04-14-00 | analysis | low | 16 | 16 | 1.00 | $0.0000 | 409ms |
| 2026-04-14-03 | analysis | low | 7 | 7 | 1.00 | $0.0000 | 110ms |
| 2026-04-10-05 | analysis | low | 6 | 6 | 1.00 | $0.0000 | 17200ms |
| 2026-04-10-21 | analysis | low | 12 | 12 | 0.98 | $0.0000 | 175628ms |
| 2026-04-09-18 | analysis | low | 3 | 3 | 1.00 | $0.0000 | 7202ms |
| 2026-04-15-16 | analysis | low | 2 | 2 | 1.00 | $0.0000 | 2918ms |
| 2026-03-18-03 | analysis | low | 6 | 6 | 0.86 | $0.0055 | 1137ms |
| 2026-04-15-17 | analysis | low | 7 | 7 | 1.00 | $0.0000 | 1263ms |
| 2026-04-02-15 | analysis | low | 10 | 10 | 1.00 | $-420.0000 | 48899ms |
| 2026-04-15-08 | analysis | low | 2 | 2 | 1.00 | $0.0000 | 2834ms |
| 2026-03-30-06 | analysis | low | 21 | 21 | 1.00 | $0.0035 | 20632ms |
| 2026-04-10-04 | analysis | low | 6 | 6 | 1.00 | $0.0000 | 16105ms |
| 2026-04-15-03 | analysis | low | 11 | 11 | 1.00 | $0.0000 | 18990ms |
| 2026-04-16-01 | analysis | low | 11 | 11 | 1.00 | $0.0000 | 62936ms |
| 2026-04-10-06 | analysis | low | 10 | 10 | 1.00 | $0.0000 | 7541ms |
| 2026-03-20-16 | analysis | low | 2 | 2 | 0.84 | $0.0010 | 5707ms |
| 2026-04-10-02 | analysis | low | 11 | 11 | 1.00 | $0.0012 | 40099ms |
| 2026-04-02-04 | analysis | low | 5 | 5 | 1.00 | $0.0000 | 2665ms |
| 2026-02-19-17 | analysis | low | 3 | 3 | 0.62 | $0.0142 | 6092ms |
| 2026-04-11-14 | analysis | low | 9 | 9 | 1.00 | $0.0000 | 21705ms |
| 2026-02-18-00 | analysis | low | 2 | 2 | 0.60 | $0.0016 | 2837ms |
| 2026-04-15-12 | analysis | low | 5 | 5 | 1.00 | $0.0000 | 65987ms |
| 2026-04-10-01 | analysis | low | 3 | 3 | 1.00 | $0.0000 | 6795ms |
| 2026-04-14-02 | analysis | low | 31 | 31 | 1.00 | $0.0000 | 43294ms |
| 2026-04-15-14 | analysis | low | 7 | 7 | 1.00 | $0.0000 | 2477ms |
| 2026-03-20-14 | analysis | low | 2 | 2 | 0.80 | $0.0009 | 4910ms |
| 2026-04-15-07 | analysis | low | 20 | 20 | 1.00 | $0.0000 | 2793ms |
| 2026-04-14-01 | analysis | low | 81 | 81 | 1.00 | $0.0000 | 28798ms |
| 2026-04-10-03 | analysis | low | 16 | 16 | 0.98 | $0.0000 | 275156ms |
| 2026-04-15-13 | analysis | low | 13 | 13 | 1.00 | $0.0000 | 26ms |
| 2026-04-02-14 | analysis | low | 6 | 6 | 1.00 | $0.0000 | 9066ms |
| 2026-04-02-10 | analysis | low | 16 | 16 | 1.00 | $0.0000 | 18854ms |
| 2026-04-02-03 | analysis | low | 12 | 12 | 1.00 | $0.0000 | 7189ms |
| 2026-04-10-23 | analysis | low | 3 | 3 | 1.00 | $0.0000 | 17626ms |
| 2026-04-11-08 | analysis | low | 3 | 3 | 1.00 | $0.0000 | 13387ms |
| 2026-04-10-22 | analysis | low | 5 | 5 | 1.00 | $0.0000 | 2313ms |
| 2026-04-10-18 | analysis | low | 18 | 18 | 0.98 | $0.0000 | 169062ms |
| 2026-04-11-06 | analysis | low | 4 | 4 | 1.00 | $0.0000 | 5705ms |
| 2026-03-30-05 | analysis | low | 2 | 2 | 1.00 | $0.0102 | 11590ms |
| 2026-04-15-02 | analysis | low | 9 | 9 | 1.00 | $0.0000 | 2228ms |
| 2026-04-15-10 | analysis | low | 30 | 30 | 1.00 | $0.0000 | 10038ms |
| 2026-04-16-00 | analysis | low | 16 | 16 | 1.00 | $0.0000 | 1313ms |
| 2026-04-09-19 | analysis | low | 15 | 15 | 1.00 | $0.0009 | 8709ms |
| 2026-04-10-17 | analysis | low | 7 | 7 | 1.00 | $0.0000 | 17953ms |
| 2026-04-11-07 | analysis | low | 14 | 14 | 1.00 | $0.0000 | 2521ms |
| 2026-04-15-11 | analysis | low | 27 | 27 | 1.00 | $0.0000 | 7015ms |
| 2026-03-30-07 | analysis | low | 16 | 16 | 0.98 | $-111.9375 | 29286ms |
| 2026-04-15-15 | analysis | low | 18 | 18 | 1.00 | $0.0000 | 5908ms |
| 2026-04-02-09 | analysis | low | 4 | 4 | 1.00 | $0.0000 | 1977ms |
| 2026-04-10-23 | analysis | medium | 6 | 6 | 0.00 | $0.0000 | 18457ms |
| 2026-04-11-14 | analysis | medium | 4 | 4 | 0.67 | $0.0000 | 87799ms |
| 2026-04-02-03 | analysis | medium | 2 | 1 | 0.00 | $0.0000 | 221ms |
| 2026-04-10-05 | analysis | medium | 6 | 6 | 0.00 | $0.0000 | 4811ms |
| 2026-03-18-02 | analysis | medium | 2 | 0 | 0.00 | $0.0000 | 4539ms |
| 2026-04-16-01 | analysis | medium | 10 | 10 | 0.00 | $0.0000 | 41ms |
| 2026-04-14-01 | analysis | medium | 2 | 2 | 0.00 | $0.0000 | 316ms |
| 2026-03-30-06 | analysis | medium | 2 | 1 | 0.00 | $0.0088 | 90188ms |
| 2026-04-16-00 | analysis | medium | 21 | 21 | 0.00 | $0.0000 | 34ms |
| 2026-02-28-12 | analysis | medium | 1 | 0 | 0.00 | $0.0000 | 10904ms |
| 2026-04-02-15 | analysis | medium | 2 | 2 | 0.00 | $0.0000 | 220ms |
| 2026-04-15-10 | analysis | medium | 16 | 16 | 0.00 | $0.0000 | 147ms |
| 2026-04-15-11 | analysis | medium | 4 | 4 | 0.00 | $0.0000 | 321ms |
| 2026-04-02-14 | analysis | medium | 4 | 4 | 0.00 | $0.0000 | 41910ms |
| 2026-04-02-10 | analysis | medium | 5 | 5 | 0.00 | $0.0000 | 247ms |
| 2026-04-10-07 | analysis | medium | 6 | 6 | 0.00 | $0.0000 | 13576ms |
| 2026-04-10-17 | analysis | medium | 2 | 2 | 0.00 | $0.0000 | 287ms |
| 2026-04-02-05 | analysis | medium | 8 | 8 | 0.50 | $0.0000 | 2031ms |
| 2026-04-11-07 | analysis | medium | 3 | 3 | 0.50 | $0.0000 | 6008ms |
| 2026-04-15-17 | analysis | medium | 1 | 1 | 0.00 | $0.0000 | 85ms |
| 2026-04-10-03 | analysis | medium | 1 | 1 | 0.00 | $0.0000 | 222ms |
| 2026-04-15-14 | analysis | medium | 11 | 10 | 0.00 | $0.0000 | 126ms |
| 2026-04-15-02 | analysis | medium | 8 | 8 | 0.00 | $0.0000 | 284ms |
| 2026-04-10-21 | analysis | medium | 1 | 1 | 0.00 | $0.0000 | 252ms |
| 2026-04-10-18 | analysis | medium | 5 | 5 | 0.00 | $0.0000 | 255ms |
| 2026-04-10-02 | analysis | medium | 1 | 1 | 0.00 | $0.0000 | 241ms |
| 2026-03-30-07 | analysis | medium | 6 | 2 | 0.00 | $0.0000 | 90349ms |
| 2026-04-15-07 | analysis | medium | 32 | 32 | 0.00 | $0.0000 | 264ms |
| 2026-03-18-04 | analysis | medium | 1 | 0 | 0.00 | $0.0000 | 5237ms |
| 2026-04-15-03 | analysis | medium | 4 | 4 | 0.00 | $0.0000 | 17ms |
| 2026-04-11-15 | analysis | medium | 12 | 12 | 0.50 | $0.0000 | 4540ms |
| 2026-04-10-04 | analysis | medium | 6 | 6 | 0.00 | $0.0000 | 34159ms |
| 2026-04-10-01 | analysis | medium | 5 | 5 | 0.00 | $0.0000 | 502ms |
| 2026-04-15-08 | analysis | medium | 4 | 4 | 0.00 | $0.0000 | 315ms |
| 2026-03-18-03 | analysis | medium | 1 | 0 | 0.00 | $0.0000 | 5039ms |
| 2026-04-14-00 | analysis | medium | 8 | 7 | 0.88 | $0.0000 | 6635ms |
| 2026-04-02-04 | analysis | medium | 1 | 1 | 0.00 | $0.0000 | 589ms |
| 2026-04-15-15 | analysis | medium | 83 | 83 | 0.20 | $0.0000 | 1939ms |
| 2026-04-09-19 | analysis | medium | 12 | 12 | 0.00 | $0.0000 | 246ms |
| 2026-04-15-13 | analysis | medium | 6 | 6 | 0.00 | $0.0000 | 131ms |
| 2026-04-14-02 | analysis | medium | 3 | 3 | 0.00 | $0.0000 | 8292ms |
| 2026-04-15-10 | architecture | low | 5 | 5 | 1.00 | $0.0000 | 1891ms |
| 2026-04-14-02 | architecture | low | 2 | 2 | 1.00 | $0.0000 | 2716ms |
| 2026-04-15-08 | architecture | low | 1 | 1 | 1.00 | $0.0000 | 2318ms |
| 2026-04-15-07 | architecture | low | 4 | 4 | 1.00 | $0.0000 | 84609ms |
| 2026-04-14-03 | architecture | low | 7 | 7 | 1.00 | $0.0000 | 5691ms |
| 2026-04-15-02 | architecture | low | 7 | 7 | 1.00 | $0.0000 | 2772ms |
| 2026-04-14-12 | architecture | low | 51 | 50 | 1.00 | $0.0000 | 18380ms |
| 2026-04-15-18 | architecture | low | 8 | 8 | 1.00 | $0.0000 | 653059ms |
| 2026-04-15-11 | architecture | low | 2 | 2 | 1.00 | $0.0000 | 2235ms |
| 2026-04-14-01 | architecture | low | 23 | 23 | 1.00 | $0.0000 | 7490ms |
| 2026-04-15-16 | architecture | low | 24 | 24 | 1.00 | $0.0000 | 28841ms |
| 2026-04-15-09 | architecture | low | 1 | 1 | 1.00 | $0.0000 | 16550ms |
| 2026-04-15-15 | architecture | low | 2 | 2 | 1.00 | $0.0000 | 3338ms |
| 2026-04-14-00 | architecture | low | 17 | 17 | 1.00 | $0.0000 | 82ms |
| 2026-04-15-17 | architecture | low | 8 | 8 | 1.00 | $0.0000 | 28375ms |
| 2026-04-14-01 | architecture | medium | 16 | 16 | 0.50 | $0.0000 | 5725ms |
| 2026-04-15-02 | architecture | medium | 1 | 0 | 0.00 | $0.0000 | 21445ms |
| 2026-04-14-00 | architecture | medium | 11 | 9 | 0.00 | $0.0000 | 176ms |
| 2026-04-14-12 | architecture | medium | 5 | 4 | 0.75 | $0.0000 | 10823ms |
| 2026-03-20-14 | chat | low | 5 | 5 | 1.00 | $0.0000 | 1779ms |
| 2026-03-20-16 | chat | low | 1 | 1 | 1.00 | $0.0000 | 3181ms |
| 2026-03-20-16 | chat | medium | 2 | 2 | 0.50 | $0.0000 | 586ms |
| 2026-04-15-16 | code-generation | high | 178 | 178 | 0.14 | $0.0000 | 2534ms |
| 2026-02-20-04 | code-generation | high | 1 | 1 | 0.61 | $0.0011 | 2911ms |
| 2026-02-20-05 | code-generation | high | 2 | 2 | 0.61 | $0.0012 | 3264ms |
| 2026-04-02-04 | code-generation | low | 35 | 35 | 1.00 | $0.0000 | 2154ms |
| 2026-04-10-01 | code-generation | low | 32 | 32 | 1.00 | $0.0000 | 2624ms |
| 2026-04-15-17 | code-generation | low | 6 | 6 | 1.00 | $0.0000 | 1968ms |
| 2026-04-10-03 | code-generation | low | 28 | 28 | 1.00 | $0.0004 | 30328ms |
| 2026-04-11-15 | code-generation | low | 42 | 42 | 1.00 | $0.0000 | 2222ms |
| 2026-03-18-07 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 518ms |
| 2026-04-14-01 | code-generation | low | 382 | 382 | 1.00 | $0.0000 | 11559ms |
| 2026-04-14-00 | code-generation | low | 11 | 11 | 1.00 | $0.0000 | 2861ms |
| 2026-03-18-08 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 1260ms |
| 2026-04-10-05 | code-generation | low | 43 | 43 | 1.00 | $0.0000 | 3267ms |
| 2026-04-10-04 | code-generation | low | 24 | 24 | 1.00 | $0.0000 | 2556ms |
| 2026-04-10-06 | code-generation | low | 45 | 45 | 1.00 | $0.0000 | 7271ms |
| 2026-04-11-14 | code-generation | low | 20 | 20 | 1.00 | $0.0000 | 4086ms |
| 2026-04-11-07 | code-generation | low | 58 | 58 | 1.00 | $0.0000 | 1417ms |
| 2026-04-11-08 | code-generation | low | 1 | 1 | 1.00 | $0.0000 | 2013ms |
| 2026-04-11-06 | code-generation | low | 18 | 18 | 1.00 | $0.0000 | 1892ms |
| 2026-04-10-07 | code-generation | low | 29 | 29 | 1.00 | $0.0000 | 2698ms |
| 2026-03-18-14 | code-generation | low | 3 | 3 | 1.00 | $0.0000 | 505ms |
| 2026-04-10-17 | code-generation | low | 35 | 35 | 1.00 | $0.0000 | 2333ms |
| 2026-04-10-18 | code-generation | low | 19 | 19 | 1.00 | $0.0000 | 2476ms |
| 2026-04-10-21 | code-generation | low | 23 | 23 | 1.00 | $0.0000 | 5047ms |
| 2026-04-10-22 | code-generation | low | 41 | 41 | 1.00 | $0.0000 | 1756ms |
| 2026-03-18-09 | code-generation | low | 6 | 6 | 1.00 | $0.0000 | 455ms |
| 2026-03-18-20 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 751ms |
| 2026-03-18-10 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 459ms |
| 2026-03-18-15 | code-generation | low | 3 | 3 | 1.00 | $0.0000 | 469ms |
| 2026-03-18-11 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 337ms |
| 2026-03-18-12 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 480ms |
| 2026-03-18-13 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 2075ms |
| 2026-03-18-17 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 448ms |
| 2026-03-18-16 | code-generation | low | 5 | 5 | 1.00 | $0.0000 | 513ms |
| 2026-03-18-18 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 425ms |
| 2026-03-18-21 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 687ms |
| 2026-03-18-19 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 563ms |
| 2026-04-15-11 | code-generation | low | 253 | 253 | 1.00 | $0.0000 | 30342ms |
| 2026-03-18-22 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 5788ms |
| 2026-03-18-23 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 7718ms |
| 2026-03-19-00 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 857ms |
| 2026-03-19-01 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 463ms |
| 2026-03-19-02 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 537ms |
| 2026-03-19-03 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 458ms |
| 2026-03-19-13 | code-generation | low | 1 | 1 | 1.00 | $0.0000 | 1175ms |
| 2026-03-19-04 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 1018ms |
| 2026-03-19-09 | code-generation | low | 6 | 6 | 1.00 | $0.0000 | 497ms |
| 2026-03-19-05 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 457ms |
| 2026-03-19-06 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 520ms |
| 2026-03-19-07 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 551ms |
| 2026-03-19-10 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 455ms |
| 2026-03-19-08 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 446ms |
| 2026-03-19-11 | code-generation | low | 1 | 1 | 1.00 | $0.0000 | 1880ms |
| 2026-04-15-13 | code-generation | low | 116 | 116 | 1.00 | $0.0000 | 4641ms |
| 2026-03-19-12 | code-generation | low | 1 | 1 | 1.00 | $0.0000 | 1344ms |
| 2026-04-15-12 | code-generation | low | 192 | 192 | 1.00 | $0.0000 | 2087ms |
| 2026-03-20-14 | code-generation | low | 3 | 3 | 1.00 | $0.0004 | 19580ms |
| 2026-02-20-05 | code-generation | low | 5 | 5 | 0.67 | $0.0034 | 3942ms |
| 2026-03-20-15 | code-generation | low | 2 | 2 | 1.00 | $0.0012 | 3669ms |
| 2026-04-15-10 | code-generation | low | 1 | 1 | 1.00 | $0.0000 | 18277ms |
| 2026-04-15-08 | code-generation | low | 15 | 15 | 1.00 | $0.0000 | 2647ms |
| 2026-04-16-00 | code-generation | low | 39 | 39 | 1.00 | $0.0000 | 185329ms |
| 2026-02-20-04 | code-generation | low | 7 | 7 | 0.66 | $0.0027 | 3754ms |
| 2026-04-15-16 | code-generation | low | 136 | 136 | 1.00 | $0.0000 | 129ms |
| 2026-04-16-01 | code-generation | low | 207 | 207 | 1.00 | $0.0000 | 18983ms |
| 2026-02-19-17 | code-generation | low | 7 | 7 | 0.66 | $0.0028 | 4216ms |
| 2026-03-18-02 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 1205ms |
| 2026-03-30-05 | code-generation | low | 56 | 56 | 1.00 | $0.0011 | 18633ms |
| 2026-04-15-09 | code-generation | low | 8 | 8 | 1.00 | $0.0000 | 19045ms |
| 2026-03-30-06 | code-generation | low | 21 | 21 | 1.00 | $0.0010 | 6074ms |
| 2026-02-18-00 | code-generation | low | 5 | 5 | 0.67 | $0.0025 | 3185ms |
| 2026-03-30-07 | code-generation | low | 13 | 13 | 1.00 | $0.0013 | 26872ms |
| 2026-02-18-01 | code-generation | low | 1 | 1 | 0.65 | $0.0050 | 4918ms |
| 2026-04-15-14 | code-generation | low | 63 | 63 | 1.00 | $0.0000 | 2567ms |
| 2026-04-02-03 | code-generation | low | 28 | 28 | 1.00 | $0.0046 | 4532ms |
| 2026-04-15-07 | code-generation | low | 41 | 41 | 1.00 | $0.0000 | 6392ms |
| 2026-04-02-09 | code-generation | low | 29 | 29 | 1.00 | $0.0000 | 2555ms |
| 2026-04-15-03 | code-generation | low | 80 | 80 | 1.00 | $0.0000 | 15259ms |
| 2026-03-18-03 | code-generation | low | 1 | 1 | 1.00 | $0.0000 | 4507ms |
| 2026-04-15-18 | code-generation | low | 77 | 77 | 1.00 | $0.0000 | 112ms |
| 2026-04-15-02 | code-generation | low | 12 | 12 | 1.00 | $0.0000 | 2658ms |
| 2026-04-02-10 | code-generation | low | 32 | 32 | 1.00 | $0.0040 | 7433ms |
| 2026-03-18-06 | code-generation | low | 2 | 2 | 1.00 | $0.0000 | 1179ms |
| 2026-04-02-14 | code-generation | low | 61 | 61 | 1.00 | $0.0013 | 6446ms |
| 2026-04-02-15 | code-generation | low | 4 | 4 | 1.00 | $0.0000 | 5634ms |
| 2026-04-15-15 | code-generation | low | 53 | 53 | 1.00 | $0.0000 | 240ms |
| 2026-02-20-08 | code-generation | low | 4 | 4 | 0.62 | $0.0024 | 12829ms |
| 2026-03-18-05 | code-generation | low | 3 | 3 | 1.00 | $0.0000 | 416ms |
| 2026-04-14-03 | code-generation | low | 67 | 67 | 1.00 | $0.0000 | 894ms |
| 2026-04-14-02 | code-generation | low | 384 | 384 | 1.00 | $0.0000 | 28789ms |
| 2026-04-09-18 | code-generation | low | 33 | 33 | 1.00 | $0.0000 | 2217ms |
| 2026-04-14-12 | code-generation | low | 6 | 6 | 1.00 | $0.0000 | 2459ms |
| 2026-04-10-02 | code-generation | low | 23 | 23 | 1.00 | $0.0021 | 1499ms |
| 2026-04-09-19 | code-generation | low | 22 | 22 | 1.00 | $0.0021 | 2311ms |
| 2026-04-14-03 | code-generation | medium | 11 | 11 | 0.67 | $0.0000 | 7769ms |
| 2026-04-15-18 | code-generation | medium | 44 | 40 | 0.00 | $0.0000 | 168ms |
| 2026-03-19-09 | code-generation | medium | 3 | 3 | 0.59 | $0.0022 | 12970ms |
| 2026-04-11-15 | code-generation | medium | 9 | 9 | 0.00 | $0.0000 | 306ms |
| 2026-04-15-15 | code-generation | medium | 14 | 10 | 0.75 | $0.0000 | 383ms |
| 2026-03-18-10 | code-generation | medium | 2 | 2 | 0.60 | $0.0016 | 3026ms |
| 2026-03-18-09 | code-generation | medium | 6 | 6 | 0.18 | $0.0017 | 5083ms |
| 2026-04-14-01 | code-generation | medium | 126 | 122 | 0.00 | $0.0000 | 551ms |
| 2026-04-15-16 | code-generation | medium | 501 | 500 | 0.00 | $0.0000 | 27ms |
| 2026-04-10-22 | code-generation | medium | 10 | 10 | 0.00 | $0.0000 | 1602ms |
| 2026-03-18-14 | code-generation | medium | 3 | 3 | 0.38 | $0.0009 | 827ms |
| 2026-04-02-04 | code-generation | medium | 12 | 12 | 0.00 | $0.0000 | 1368ms |
| 2026-04-02-09 | code-generation | medium | 18 | 12 | 0.00 | $0.0000 | 1339ms |
| 2026-03-19-13 | code-generation | medium | 2 | 2 | 0.29 | $0.0001 | 786ms |
| 2026-04-10-06 | code-generation | medium | 7 | 7 | 0.00 | $0.0000 | 222ms |
| 2026-03-30-05 | code-generation | medium | 3 | 0 | 0.00 | $0.0000 | 78173ms |
| 2026-03-18-03 | code-generation | medium | 2 | 2 | 0.00 | $0.0021 | 123ms |
| 2026-04-10-17 | code-generation | medium | 9 | 9 | 0.00 | $0.0000 | 1656ms |
| 2026-03-19-05 | code-generation | medium | 2 | 2 | 0.59 | $0.0017 | 4465ms |
| 2026-03-19-02 | code-generation | medium | 2 | 2 | 0.63 | $0.0016 | 6762ms |
| 2026-04-15-03 | code-generation | medium | 5 | 5 | 0.00 | $0.0000 | 570ms |
| 2026-04-10-01 | code-generation | medium | 8 | 8 | 0.00 | $0.0000 | 219ms |
| 2026-03-18-05 | code-generation | medium | 3 | 3 | 0.00 | $0.0015 | 5960ms |
| 2026-04-02-14 | code-generation | medium | 19 | 12 | 0.00 | $0.0000 | 2914ms |
| 2026-04-10-07 | code-generation | medium | 1 | 1 | 0.00 | $0.0000 | 225ms |
| 2026-04-14-02 | code-generation | medium | 46 | 45 | 0.00 | $0.0000 | 9413ms |
| 2026-04-11-07 | code-generation | medium | 9 | 9 | 0.00 | $0.0000 | 1758ms |
| 2026-03-19-06 | code-generation | medium | 2 | 2 | 0.57 | $0.0020 | 9419ms |
| 2026-03-30-06 | code-generation | medium | 1 | 0 | 0.00 | $0.0000 | 1756ms |
| 2026-03-19-07 | code-generation | medium | 2 | 2 | 0.56 | $0.0017 | 4895ms |
| 2026-04-09-18 | code-generation | medium | 8 | 8 | 0.00 | $0.0000 | 230ms |
| 2026-03-19-08 | code-generation | medium | 2 | 2 | 0.59 | $0.0019 | 16820ms |
| 2026-03-18-02 | code-generation | medium | 1 | 1 | 0.60 | $0.0009 | 11540ms |
| 2026-03-19-01 | code-generation | medium | 2 | 2 | 0.56 | $0.0016 | 6128ms |
| 2026-03-19-04 | code-generation | medium | 2 | 2 | 0.56 | $0.0019 | 7609ms |
| 2026-03-19-10 | code-generation | medium | 2 | 2 | 0.58 | $0.0016 | 5937ms |
| 2026-03-19-11 | code-generation | medium | 2 | 2 | 0.33 | $0.0001 | 1003ms |
| 2026-04-16-01 | code-generation | medium | 25 | 11 | 0.00 | $0.0000 | 240476ms |
| 2026-03-19-00 | code-generation | medium | 1 | 1 | 0.55 | $0.0009 | 18691ms |
| 2026-04-15-11 | code-generation | medium | 31 | 30 | 0.67 | $0.0000 | 91902ms |
| 2026-03-18-06 | code-generation | medium | 1 | 1 | 0.69 | $0.0008 | 6653ms |
| 2026-03-18-23 | code-generation | medium | 1 | 1 | 0.56 | $0.0008 | 8863ms |
| 2026-04-16-00 | code-generation | medium | 12 | 12 | 0.33 | $0.0000 | 203ms |
| 2026-03-18-22 | code-generation | medium | 1 | 1 | 0.66 | $0.0008 | 7436ms |
| 2026-03-19-03 | code-generation | medium | 2 | 2 | 0.56 | $0.0017 | 5325ms |
| 2026-03-19-12 | code-generation | medium | 2 | 2 | 0.31 | $0.0001 | 938ms |
| 2026-03-18-20 | code-generation | medium | 1 | 1 | 0.55 | $0.0008 | 19537ms |
| 2026-04-15-12 | code-generation | medium | 45 | 21 | 0.86 | $0.0000 | 4714ms |
| 2026-03-18-19 | code-generation | medium | 2 | 2 | 0.56 | $0.0018 | 6909ms |
| 2026-03-18-21 | code-generation | medium | 1 | 1 | 0.55 | $0.0008 | 8249ms |
| 2026-04-15-13 | code-generation | medium | 1 | 0 | 0.00 | $0.0000 | 183936ms |
| 2026-03-18-18 | code-generation | medium | 2 | 2 | 0.61 | $0.0017 | 3856ms |
| 2026-04-10-05 | code-generation | medium | 8 | 8 | 0.00 | $0.0000 | 227ms |
| 2026-03-18-16 | code-generation | medium | 7 | 7 | 0.09 | $0.0011 | 4258ms |
| 2026-04-10-03 | code-generation | medium | 3 | 3 | 0.00 | $0.0000 | 215ms |
| 2026-03-18-17 | code-generation | medium | 2 | 2 | 0.59 | $0.0017 | 18368ms |
| 2026-04-10-04 | code-generation | medium | 5 | 5 | 0.00 | $0.0000 | 230ms |
| 2026-03-18-07 | code-generation | medium | 1 | 1 | 0.58 | $0.0008 | 1545ms |
| 2026-04-15-14 | code-generation | medium | 7 | 7 | 0.40 | $0.0000 | 2527ms |
| 2026-04-14-00 | code-generation | medium | 5 | 5 | 0.00 | $0.0000 | 74ms |
| 2026-03-18-13 | code-generation | medium | 2 | 2 | 0.57 | $0.0016 | 6492ms |
| 2026-03-18-08 | code-generation | medium | 1 | 1 | 0.63 | $0.0009 | 18617ms |
| 2026-03-18-12 | code-generation | medium | 2 | 2 | 0.55 | $0.0017 | 14010ms |
| 2026-03-18-11 | code-generation | medium | 2 | 2 | 0.65 | $0.0018 | 2640ms |
| 2026-03-18-15 | code-generation | medium | 3 | 3 | 0.41 | $0.0010 | 2768ms |
| 2026-04-11-06 | code-review | low | 6 | 6 | 1.00 | $0.0212 | 35875ms |
| 2026-03-20-16 | code-review | low | 2 | 2 | 1.00 | $0.0009 | 2505ms |
| 2026-04-02-10 | code-review | low | 15 | 15 | 1.00 | $0.0042 | 16089ms |
| 2026-04-11-07 | code-review | low | 5 | 5 | 1.00 | $0.0000 | 67143ms |
| 2026-04-10-18 | code-review | low | 11 | 11 | 1.00 | $0.0386 | 160118ms |
| 2026-04-10-06 | code-review | low | 11 | 11 | 1.00 | $0.0319 | 83155ms |
| 2026-03-20-14 | code-review | low | 2 | 2 | 1.00 | $0.0009 | 3114ms |
| 2026-04-02-14 | code-review | low | 16 | 16 | 1.00 | $0.0081 | 15975ms |
| 2026-04-10-21 | code-review | low | 11 | 11 | 1.00 | $0.0000 | 68957ms |
| 2026-04-10-03 | code-review | low | 10 | 10 | 1.00 | $0.0346 | 85589ms |
| 2026-03-30-07 | code-review | low | 17 | 17 | 1.00 | $0.0024 | 52956ms |
| 2026-03-30-06 | code-review | low | 27 | 27 | 1.00 | $0.0002 | 66292ms |
| 2026-04-02-15 | code-review | low | 1 | 1 | 1.00 | $0.0000 | 60024ms |
| 2026-04-10-02 | code-review | low | 11 | 11 | 1.00 | $0.0199 | 82104ms |
| 2026-04-02-03 | code-review | low | 17 | 17 | 1.00 | $0.0018 | 73758ms |
| 2026-03-30-05 | code-review | low | 54 | 54 | 1.00 | $0.0000 | 3277ms |
| 2026-04-10-07 | code-review | low | 12 | 12 | 1.00 | $0.0183 | 35221ms |
| 2026-04-09-19 | code-review | low | 11 | 11 | 1.00 | $0.0316 | 52592ms |
| 2026-04-11-14 | code-review | low | 11 | 11 | 1.00 | $0.0000 | 76487ms |
| 2026-03-30-05 | code-review | medium | 7 | 0 | 0.00 | $0.0000 | 90190ms |
| 2026-04-02-03 | code-review | medium | 7 | 7 | 0.13 | $0.0022 | 6182ms |
| 2026-03-30-06 | code-review | medium | 2 | 1 | 0.45 | $0.0013 | 24972ms |
| 2026-03-30-07 | code-review | medium | 3 | 3 | 0.50 | $0.0005 | 10727ms |
| 2026-04-11-07 | code-review | medium | 2 | 2 | 0.00 | $0.0401 | 216ms |
| 2026-04-10-03 | code-review | medium | 4 | 4 | 0.13 | $0.0116 | 11590ms |
| 2026-04-10-21 | code-review | medium | 4 | 4 | 0.13 | $0.0000 | 9733ms |
| 2026-04-10-18 | code-review | medium | 4 | 4 | 0.13 | $0.0116 | 14038ms |
| 2026-04-10-07 | code-review | medium | 4 | 4 | 0.00 | $0.0147 | 504ms |
| 2026-04-11-06 | code-review | medium | 2 | 2 | 0.00 | $0.0000 | 228ms |
| 2026-04-02-10 | code-review | medium | 7 | 7 | 0.13 | $0.0023 | 6627ms |
| 2026-04-10-02 | code-review | medium | 4 | 4 | 0.13 | $0.0113 | 12864ms |
| 2026-04-02-14 | code-review | medium | 7 | 7 | 0.12 | $0.0025 | 6905ms |
| 2026-04-11-14 | code-review | medium | 6 | 6 | 0.00 | $0.0000 | 265ms |
| 2026-04-10-06 | code-review | medium | 4 | 4 | 0.00 | $0.0150 | 247ms |
| 2026-04-09-19 | code-review | medium | 4 | 4 | 0.13 | $0.0111 | 13380ms |
| 2026-04-06-18 | debugging | high | 8 | 8 | 0.52 | $0.0000 | 58595ms |
| 2026-04-07-12 | debugging | high | 6 | 6 | 0.56 | $0.0000 | 88226ms |
| 2026-04-08-19 | debugging | high | 1 | 1 | 0.47 | $0.0000 | 30175ms |
| 2026-03-30-07 | debugging | high | 52 | 52 | 0.50 | $0.0000 | 1183ms |
| 2026-04-06-23 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 1853ms |
| 2026-04-08-07 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 3183ms |
| 2026-03-30-06 | debugging | low | 210 | 210 | 1.00 | $0.0000 | 4102ms |
| 2026-04-14-01 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 42379ms |
| 2026-04-07-11 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 2851ms |
| 2026-04-02-09 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 3834ms |
| 2026-04-08-14 | debugging | low | 2 | 2 | 1.00 | $0.0000 | 1937ms |
| 2026-04-15-12 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 27361ms |
| 2026-04-07-12 | debugging | low | 6 | 6 | 1.00 | $0.0000 | 109077ms |
| 2026-03-20-14 | debugging | low | 2 | 2 | 0.85 | $0.0004 | 4692ms |
| 2026-04-04-10 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 8506ms |
| 2026-03-20-15 | debugging | low | 2 | 2 | 0.84 | $0.0004 | 11460ms |
| 2026-03-19-13 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 2704ms |
| 2026-04-08-19 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 30173ms |
| 2026-03-30-05 | debugging | low | 69 | 69 | 1.00 | $0.0005 | 1129ms |
| 2026-04-03-07 | debugging | low | 3 | 3 | 1.00 | $0.0000 | 22208ms |
| 2026-04-02-04 | debugging | low | 4 | 4 | 1.00 | $0.0000 | 5072ms |
| 2026-03-18-16 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 948ms |
| 2026-04-04-12 | debugging | low | 2 | 2 | 1.00 | $0.0000 | 8953ms |
| 2026-04-02-14 | debugging | low | 1 | 1 | 1.00 | $0.0000 | 3855ms |
| 2026-03-23-16 | debugging | low | 3 | 3 | 1.00 | $0.0000 | 16266ms |
| 2026-03-18-09 | debugging | low | 3 | 3 | 1.00 | $0.0000 | 949ms |
| 2026-03-30-07 | debugging | low | 208 | 208 | 1.00 | $0.0000 | 10325ms |
| 2026-04-06-18 | debugging | low | 9 | 9 | 1.00 | $0.0000 | 55707ms |
| 2026-04-06-18 | debugging | medium | 11 | 0 | 0.00 | $0.0000 | 3525ms |
| 2026-04-06-15 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 15514ms |
| 2026-04-06-17 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 16450ms |
| 2026-04-15-12 | debugging | medium | 2 | 2 | 0.00 | $0.0000 | 178ms |
| 2026-04-10-22 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 7004ms |
| 2026-04-07-12 | debugging | medium | 3 | 0 | 0.00 | $0.0000 | 2883ms |
| 2026-04-10-06 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 11662ms |
| 2026-04-11-15 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 3057ms |
| 2026-04-11-07 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 11508ms |
| 2026-04-06-23 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 5161ms |
| 2026-04-10-03 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 13599ms |
| 2026-03-30-07 | debugging | medium | 49 | 33 | 0.00 | $0.0000 | 647ms |
| 2026-04-10-05 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 9082ms |
| 2026-04-10-01 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 11305ms |
| 2026-04-05-07 | debugging | medium | 3 | 0 | 0.00 | $0.0000 | 4541ms |
| 2026-04-07-11 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 3093ms |
| 2026-04-08-14 | debugging | medium | 2 | 0 | 0.00 | $0.0000 | 3612ms |
| 2026-04-08-19 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 3870ms |
| 2026-04-09-18 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 3388ms |
| 2026-03-30-06 | debugging | medium | 136 | 123 | 0.33 | $0.0000 | 5443ms |
| 2026-04-08-07 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 5267ms |
| 2026-04-14-01 | debugging | medium | 2 | 2 | 0.00 | $0.0000 | 640ms |
| 2026-03-30-05 | debugging | medium | 9 | 5 | 0.00 | $0.0000 | 6656ms |
| 2026-04-10-17 | debugging | medium | 1 | 0 | 0.00 | $0.0000 | 13349ms |
| 2026-03-20-14 | documentation | low | 1 | 1 | 1.00 | $0.0000 | 6276ms |
| 2026-03-30-07 | documentation | low | 2 | 2 | 1.00 | $0.0030 | 6617ms |
| 2026-03-18-04 | documentation | low | 2 | 2 | 0.83 | $0.0033 | 4582ms |
| 2026-03-30-06 | documentation | low | 2 | 2 | 1.00 | $0.0035 | 7526ms |
| 2026-04-14-02 | documentation | low | 2 | 1 | 0.50 | $0.0000 | 73ms |
| 2026-04-14-12 | documentation | low | 2 | 1 | 1.00 | $0.0000 | 83ms |
| 2026-04-14-01 | documentation | low | 2 | 1 | 1.00 | $0.0000 | 38ms |
| 2026-04-15-09 | documentation | low | 1 | 1 | 0.51 | $0.0000 | 133465ms |
| 2026-03-30-05 | documentation | low | 2 | 2 | 1.00 | $0.0033 | 6780ms |
| 2026-02-20-04 | documentation | low | 1 | 1 | 0.56 | $0.0036 | 12875ms |
| 2026-02-18-00 | documentation | low | 1 | 1 | 0.65 | $0.0006 | 9881ms |
| 2026-04-15-17 | documentation | low | 2 | 1 | 1.00 | $0.0000 | 167ms |
| 2026-03-20-16 | documentation | low | 1 | 1 | 1.00 | $0.0000 | 3948ms |
| 2026-04-15-09 | documentation | medium | 4 | 4 | 0.75 | $0.0000 | 31347ms |
| 2026-02-18-00 | general | high | 7 | 7 | 0.62 | $0.0010 | 3128ms |
| 2026-02-20-07 | general | high | 13 | 13 | 0.60 | $0.0013 | 4850ms |
| 2026-02-20-08 | general | high | 12 | 12 | 0.60 | $0.0013 | 8184ms |
| 2026-04-15-17 | general | high | 14 | 14 | 0.57 | $0.0000 | 256ms |
| 2026-02-20-06 | general | high | 29 | 29 | 0.60 | $0.0013 | 3419ms |
| 2026-02-20-04 | general | high | 8 | 8 | 0.63 | $0.0012 | 3681ms |
| 2026-02-20-05 | general | high | 15 | 15 | 0.60 | $0.0013 | 3233ms |
| 2026-02-19-17 | general | high | 4 | 4 | 0.63 | $0.0014 | 4989ms |
| 2026-02-18-01 | general | high | 1 | 1 | 0.62 | $0.0013 | 3359ms |
| 2026-02-17-17 | general | low | 2 | 2 | 0.57 | $0.0001 | 7956ms |
| 2026-02-17-18 | general | low | 5 | 5 | 0.57 | $0.0001 | 5859ms |
| 2026-02-20-04 | general | low | 38 | 38 | 0.63 | $0.0006 | 5153ms |
| 2026-02-19-17 | general | low | 31 | 31 | 0.60 | $0.0003 | 4344ms |
| 2026-02-18-00 | general | low | 38 | 38 | 0.62 | $-7.1837 | 4054ms |
| 2026-02-18-01 | general | low | 7 | 7 | 0.61 | $0.0005 | 3941ms |
| 2026-02-27-14 | general | low | 22 | 22 | 1.00 | $0.0000 | 3940ms |
| 2026-02-20-05 | general | low | 68 | 68 | 0.62 | $0.0006 | 4911ms |
| 2026-02-20-06 | general | low | 115 | 115 | 0.62 | $0.0006 | 4801ms |
| 2026-02-27-09 | general | low | 12 | 12 | 1.00 | $0.0010 | 37582ms |
| 2026-02-27-20 | general | low | 2 | 2 | 1.00 | $0.0000 | 1693ms |
| 2026-02-27-21 | general | low | 1 | 1 | 1.00 | $0.0000 | 20968ms |
| 2026-02-27-22 | general | low | 6 | 6 | 1.00 | $0.0017 | 13835ms |
| 2026-02-27-23 | general | low | 3 | 3 | 1.00 | $0.0000 | 6041ms |
| 2026-02-28-12 | general | low | 13 | 13 | 0.94 | $0.0002 | 4437ms |
| 2026-03-16-08 | general | low | 2 | 2 | 1.00 | $0.0000 | 9239ms |
| 2026-03-03-22 | general | low | 8 | 8 | 1.00 | $0.0000 | 10461ms |
| 2026-03-17-01 | general | low | 2 | 2 | 1.00 | $0.0000 | 6773ms |
| 2026-03-17-17 | general | low | 1 | 1 | 1.00 | $0.0000 | 1185ms |
| 2026-03-05-15 | general | low | 12 | 12 | 1.00 | $0.0000 | 1753ms |
| 2026-03-05-16 | general | low | 4 | 4 | 1.00 | $0.0000 | 4139ms |
| 2026-03-06-22 | general | low | 2 | 2 | 1.00 | $0.0000 | 10862ms |
| 2026-03-01-17 | general | low | 27 | 27 | 1.00 | $0.0000 | 140ms |
| 2026-03-09-18 | general | low | 2 | 2 | 1.00 | $0.0000 | 7381ms |
| 2026-03-18-02 | general | low | 2 | 2 | 1.00 | $0.0028 | 755ms |
| 2026-03-03-20 | general | low | 9 | 9 | 1.00 | $0.0000 | 8988ms |
| 2026-03-10-14 | general | low | 6 | 6 | 1.00 | $0.0000 | 12983ms |
| 2026-03-16-04 | general | low | 2 | 2 | 1.00 | $0.0000 | 10286ms |
| 2026-03-03-21 | general | low | 6 | 6 | 1.00 | $0.0000 | 11684ms |
| 2026-03-16-07 | general | low | 8 | 8 | 1.00 | $0.0000 | 7708ms |
| 2026-03-18-03 | general | low | 15 | 15 | 0.91 | $0.0066 | 4181ms |
| 2026-03-18-05 | general | low | 2 | 2 | 0.82 | $0.0030 | 4958ms |
| 2026-03-18-04 | general | low | 28 | 28 | 0.94 | $0.0079 | 6260ms |
| 2026-03-18-07 | general | low | 4 | 4 | 0.81 | $0.0000 | 2854ms |
| 2026-03-18-08 | general | low | 2 | 2 | 0.86 | $0.0000 | 4735ms |
| 2026-03-18-17 | general | low | 2 | 2 | 0.83 | $0.0018 | 2391ms |
| 2026-03-19-00 | general | low | 4 | 4 | 0.81 | $0.0000 | 1986ms |
| 2026-03-19-12 | general | low | 4 | 4 | 0.81 | $0.0000 | 2108ms |
| 2026-03-19-13 | general | low | 5 | 5 | 0.93 | $0.0091 | 4190ms |
| 2026-03-20-09 | general | low | 85 | 85 | 1.00 | $0.0000 | 104781ms |
| 2026-03-20-14 | general | low | 2 | 2 | 1.00 | $0.0000 | 25698ms |
| 2026-03-23-19 | general | low | 7 | 7 | 1.00 | $0.0000 | 5707ms |
| 2026-03-20-15 | general | low | 7 | 7 | 1.00 | $0.0000 | 5253ms |
| 2026-03-20-16 | general | low | 1 | 1 | 1.00 | $0.0000 | 4746ms |
| 2026-03-20-19 | general | low | 1 | 1 | 1.00 | $0.0000 | 6311ms |
| 2026-03-20-20 | general | low | 1 | 1 | 1.00 | $0.0000 | 17155ms |
| 2026-03-21-15 | general | low | 2 | 2 | 1.00 | $0.0000 | 13595ms |
| 2026-03-21-18 | general | low | 8 | 8 | 1.00 | $0.0000 | 5142ms |
| 2026-03-21-19 | general | low | 3 | 3 | 1.00 | $0.0000 | 3497ms |
| 2026-03-24-01 | general | low | 1 | 1 | 1.00 | $0.0000 | 4271ms |
| 2026-03-22-04 | general | low | 9 | 9 | 1.00 | $0.0000 | 3483ms |
| 2026-03-30-04 | general | low | 171 | 171 | 1.00 | $0.0000 | 22880ms |
| 2026-03-23-16 | general | low | 4 | 4 | 1.00 | $0.0000 | 23894ms |
| 2026-03-23-17 | general | low | 3 | 3 | 1.00 | $0.0000 | 7040ms |
| 2026-03-23-18 | general | low | 4 | 4 | 1.00 | $0.0000 | 4729ms |
| 2026-03-24-03 | general | low | 9 | 9 | 1.00 | $0.0000 | 4457ms |
| 2026-03-24-04 | general | low | 3 | 3 | 1.00 | $0.0000 | 5926ms |
| 2026-03-24-18 | general | low | 1 | 1 | 1.00 | $0.0000 | 7346ms |
| 2026-03-30-03 | general | low | 6 | 6 | 1.00 | $0.0000 | 327ms |
| 2026-03-30-05 | general | low | 57 | 57 | 1.00 | $0.0000 | 17248ms |
| 2026-03-30-16 | general | low | 6 | 6 | 1.00 | $0.0000 | 1693ms |
| 2026-03-30-19 | general | low | 1 | 1 | 1.00 | $0.0000 | 1233ms |
| 2026-03-30-07 | general | low | 2 | 2 | 1.00 | $0.0000 | 1012ms |
| 2026-03-30-20 | general | low | 2 | 2 | 1.00 | $0.0000 | 1250ms |
| 2026-03-31-16 | general | low | 1 | 1 | 1.00 | $0.0000 | 12233ms |
| 2026-03-31-17 | general | low | 3 | 3 | 1.00 | $0.0000 | 26876ms |
| 2026-03-31-18 | general | low | 1 | 1 | 1.00 | $0.0000 | 13467ms |
| 2026-03-31-19 | general | low | 1 | 1 | 1.00 | $0.0000 | 2908ms |
| 2026-03-31-20 | general | low | 1 | 1 | 1.00 | $0.0000 | 11542ms |
| 2026-04-01-09 | general | low | 1 | 1 | 1.00 | $0.0000 | 1145ms |
| 2026-04-01-10 | general | low | 2 | 2 | 1.00 | $0.0000 | 13823ms |
| 2026-04-01-14 | general | low | 2 | 2 | 1.00 | $0.0000 | 1735ms |
| 2026-04-01-15 | general | low | 1 | 1 | 1.00 | $0.0000 | 1548ms |
| 2026-04-01-17 | general | low | 4 | 4 | 1.00 | $0.0000 | 992ms |
| 2026-04-02-01 | general | low | 1 | 1 | 1.00 | $0.0000 | 1585ms |
| 2026-04-02-03 | general | low | 2 | 2 | 1.00 | $0.0000 | 1350ms |
| 2026-04-02-10 | general | low | 24 | 24 | 1.00 | $0.0000 | 4550ms |
| 2026-04-02-13 | general | low | 1 | 1 | 1.00 | $0.0000 | 1186ms |
| 2026-04-02-09 | general | low | 42 | 42 | 1.00 | $0.0000 | 3952ms |
| 2026-04-02-04 | general | low | 48 | 48 | 1.00 | $0.0000 | 2261ms |
| 2026-04-02-14 | general | low | 58 | 58 | 1.00 | $0.0000 | 3121ms |
| 2026-04-02-15 | general | low | 1 | 1 | 1.00 | $0.0000 | 2231ms |
| 2026-04-03-14 | general | low | 1 | 1 | 1.00 | $0.0000 | 1448ms |
| 2026-04-03-17 | general | low | 2 | 2 | 1.00 | $0.0000 | 4905ms |
| 2026-04-03-20 | general | low | 1 | 1 | 1.00 | $0.0000 | 1645ms |
| 2026-04-03-22 | general | low | 1 | 1 | 1.00 | $0.0000 | 1290ms |
| 2026-04-04-02 | general | low | 2 | 2 | 1.00 | $0.0000 | 1215ms |
| 2026-04-04-10 | general | low | 1 | 1 | 1.00 | $0.0000 | 1704ms |
| 2026-04-04-11 | general | low | 1 | 1 | 1.00 | $0.0000 | 2076ms |
| 2026-04-04-12 | general | low | 2 | 2 | 1.00 | $0.0000 | 1811ms |
| 2026-04-05-06 | general | low | 1 | 1 | 1.00 | $0.0000 | 1846ms |
| 2026-04-05-07 | general | low | 1 | 1 | 1.00 | $0.0000 | 1980ms |
| 2026-04-09-18 | general | low | 55 | 55 | 1.00 | $0.0000 | 1226ms |
| 2026-04-10-01 | general | low | 57 | 57 | 1.00 | $0.0000 | 1638ms |
| 2026-04-09-19 | general | low | 12 | 12 | 1.00 | $0.0000 | 1647ms |
| 2026-04-10-02 | general | low | 2 | 2 | 1.00 | $0.0000 | 3950ms |
| 2026-04-10-05 | general | low | 79 | 79 | 1.00 | $0.0000 | 4525ms |
| 2026-04-10-03 | general | low | 17 | 17 | 1.00 | $0.0000 | 8297ms |
| 2026-04-10-04 | general | low | 52 | 52 | 1.00 | $0.0000 | 7660ms |
| 2026-04-10-06 | general | low | 26 | 26 | 1.00 | $0.0000 | 5435ms |
| 2026-04-10-07 | general | low | 38 | 38 | 1.00 | $0.0000 | 7438ms |
| 2026-04-10-17 | general | low | 70 | 70 | 1.00 | $0.0000 | 6084ms |
| 2026-04-10-18 | general | low | 10 | 10 | 1.00 | $0.0000 | 14253ms |
| 2026-04-10-22 | general | low | 55 | 55 | 1.00 | $0.0000 | 3019ms |
| 2026-04-11-07 | general | low | 66 | 66 | 1.00 | $0.0000 | 1730ms |
| 2026-04-10-23 | general | low | 17 | 17 | 1.00 | $0.0000 | 8207ms |
| 2026-04-11-08 | general | low | 31 | 31 | 1.00 | $0.0000 | 3137ms |
| 2026-04-11-15 | general | low | 94 | 94 | 1.00 | $0.0000 | 6202ms |
| 2026-04-14-00 | general | low | 92 | 92 | 1.00 | $0.0000 | 124ms |
| 2026-04-14-01 | general | low | 489 | 489 | 1.00 | $0.0000 | 26086ms |
| 2026-04-15-01 | general | low | 4 | 4 | 1.00 | $0.0000 | 55333ms |
| 2026-04-14-02 | general | low | 368 | 368 | 1.00 | $0.0001 | 3725ms |
| 2026-04-14-03 | general | low | 26 | 26 | 1.00 | $0.0000 | 1529ms |
| 2026-04-14-12 | general | low | 76 | 76 | 1.00 | $0.0000 | 2291ms |
| 2026-04-15-07 | general | low | 138 | 138 | 1.00 | $0.0000 | 35316ms |
| 2026-04-15-02 | general | low | 68 | 68 | 1.00 | $0.0000 | 19683ms |
| 2026-04-15-03 | general | low | 6 | 6 | 1.00 | $0.0000 | 39102ms |
| 2026-04-15-11 | general | low | 72 | 72 | 1.00 | $0.0000 | 42210ms |
| 2026-04-15-10 | general | low | 148 | 148 | 1.00 | $0.0000 | 48839ms |
| 2026-04-15-08 | general | low | 68 | 68 | 1.00 | $0.0000 | 1990ms |
| 2026-04-15-09 | general | low | 20 | 20 | 1.00 | $0.0000 | 13276ms |
| 2026-04-15-12 | general | low | 29 | 29 | 1.00 | $0.0000 | 74534ms |
| 2026-04-15-13 | general | low | 87 | 87 | 1.00 | $0.0000 | 57128ms |
| 2026-04-15-17 | general | low | 78 | 78 | 1.00 | $0.0000 | 28035ms |
| 2026-04-15-19 | general | low | 2 | 2 | 1.00 | $0.0000 | 283875ms |
| 2026-04-15-16 | general | low | 65 | 65 | 1.00 | $0.0000 | 158116ms |
| 2026-04-15-15 | general | low | 6 | 6 | 1.00 | $0.0000 | 40844ms |
| 2026-04-15-14 | general | low | 111 | 111 | 1.00 | $0.0000 | 506692ms |
| 2026-04-16-00 | general | low | 17 | 17 | 0.98 | $0.0012 | 26842ms |
| 2026-04-15-18 | general | low | 9 | 9 | 1.00 | $0.0000 | 71382ms |
| 2026-03-18-22 | general | medium | 3 | 0 | 0.00 | $0.0000 | 10109ms |
| 2026-03-20-09 | general | medium | 9 | 3 | 0.50 | $0.0000 | 502ms |
| 2026-04-15-02 | general | medium | 14 | 9 | 0.00 | $0.0000 | 90319ms |
| 2026-04-15-15 | general | medium | 1 | 0 | 0.00 | $0.0000 | 1689898ms |
| 2026-04-14-02 | general | medium | 41 | 41 | 0.00 | $0.0000 | 94ms |
| 2026-04-15-16 | general | medium | 23 | 19 | 0.88 | $0.0000 | 324ms |
| 2026-02-28-12 | general | medium | 2 | 2 | 0.00 | $0.0000 | 122ms |
| 2026-04-09-19 | general | medium | 30 | 30 | 0.00 | $0.0000 | 7488ms |
| 2026-03-18-03 | general | medium | 25 | 11 | 0.33 | $0.0000 | 5394ms |
| 2026-04-14-03 | general | medium | 14 | 14 | 0.38 | $0.0000 | 32724ms |
| 2026-03-18-05 | general | medium | 2 | 0 | 0.00 | $0.0000 | 6059ms |
| 2026-04-09-18 | general | medium | 52 | 52 | 0.00 | $0.0000 | 1448ms |
| 2026-03-18-06 | general | medium | 3 | 0 | 0.00 | $0.0000 | 6808ms |
| 2026-04-08-02 | general | medium | 2 | 0 | 0.00 | $0.0000 | 25862ms |
| 2026-04-15-14 | general | medium | 22 | 7 | 0.67 | $0.0000 | 42299ms |
| 2026-04-05-07 | general | medium | 2 | 2 | 0.50 | $0.0000 | 695ms |
| 2026-02-19-17 | general | medium | 1 | 1 | 0.56 | $0.0004 | 5424ms |
| 2026-04-06-14 | general | medium | 6 | 4 | 0.50 | $0.0000 | 1040ms |
| 2026-04-15-13 | general | medium | 2 | 0 | 0.00 | $0.0000 | 90432ms |
| 2026-02-27-21 | general | medium | 1 | 1 | 0.67 | $0.0006 | 21121ms |
| 2026-03-18-20 | general | medium | 3 | 0 | 0.00 | $0.0000 | 8897ms |
| 2026-04-14-12 | general | medium | 8 | 8 | 0.50 | $0.0000 | 16099ms |
| 2026-03-18-21 | general | medium | 3 | 0 | 0.00 | $0.0000 | 11513ms |
| 2026-03-19-14 | general | medium | 6 | 0 | 0.00 | $0.0000 | 6271ms |
| 2026-04-15-12 | general | medium | 6 | 6 | 0.00 | $0.0000 | 249368ms |
| 2026-04-02-14 | general | medium | 73 | 69 | 0.50 | $0.0000 | 1246ms |
| 2026-04-02-10 | general | medium | 53 | 53 | 0.00 | $0.0000 | 93669ms |
| 2026-03-18-23 | general | medium | 3 | 0 | 0.00 | $0.0000 | 10100ms |
| 2026-03-19-09 | general | medium | 1 | 0 | 0.00 | $0.0000 | 24364ms |
| 2026-04-10-03 | general | medium | 4 | 4 | 0.00 | $0.0000 | 221ms |
| 2026-04-11-16 | general | medium | 6 | 6 | 0.50 | $0.0000 | 2629ms |
| 2026-04-02-09 | general | medium | 18 | 15 | 0.00 | $0.0000 | 1903ms |
| 2026-03-19-11 | general | medium | 9 | 0 | 0.00 | $0.0000 | 7677ms |
| 2026-02-27-22 | general | medium | 2 | 2 | 0.00 | $0.0000 | 293ms |
| 2026-04-02-05 | general | medium | 55 | 55 | 0.50 | $0.0000 | 1297ms |
| 2026-04-15-07 | general | medium | 9 | 5 | 0.00 | $0.0000 | 90280ms |
| 2026-04-02-04 | general | medium | 100 | 100 | 0.50 | $0.0000 | 1354ms |
| 2026-03-19-13 | general | medium | 10 | 3 | 0.67 | $0.0000 | 7522ms |
| 2026-04-15-17 | general | medium | 56 | 52 | 0.75 | $0.0000 | 2857ms |
| 2026-04-15-11 | general | medium | 3 | 0 | 0.00 | $0.0000 | 341641ms |
| 2026-04-15-10 | general | medium | 24 | 3 | 0.00 | $0.0000 | 121907ms |
| 2026-03-30-04 | general | medium | 25 | 8 | 0.00 | $0.0000 | 90375ms |
| 2026-03-30-05 | general | medium | 17 | 7 | 0.67 | $0.0000 | 17803ms |
| 2026-03-20-15 | general | medium | 1 | 1 | 0.00 | $0.0000 | 440ms |
| 2026-04-15-08 | general | medium | 44 | 12 | 0.00 | $0.0000 | 116732ms |
| 2026-02-18-00 | general | medium | 2 | 2 | 0.63 | $0.0006 | 4261ms |
| 2026-03-01-17 | general | medium | 15 | 4 | 0.00 | $0.0000 | 1275ms |
| 2026-04-10-04 | general | medium | 74 | 74 | 0.00 | $0.0000 | 9756ms |
| 2026-04-10-23 | general | medium | 42 | 42 | 0.00 | $0.0000 | 4279ms |
| 2026-04-10-07 | general | medium | 75 | 75 | 0.00 | $0.0000 | 4331ms |
| 2026-04-11-15 | general | medium | 84 | 84 | 0.00 | $0.0000 | 2422ms |
| 2026-04-11-08 | general | medium | 52 | 52 | 0.00 | $0.0000 | 3060ms |
| 2026-04-10-18 | general | medium | 11 | 11 | 0.00 | $0.0000 | 24069ms |
| 2026-04-16-00 | general | medium | 9 | 9 | 0.00 | $0.0000 | 109ms |
| 2026-04-10-06 | general | medium | 8 | 8 | 0.00 | $0.0000 | 221ms |
| 2026-04-10-17 | general | medium | 71 | 71 | 0.00 | $0.0000 | 19974ms |
| 2026-04-10-22 | general | medium | 37 | 37 | 0.00 | $0.0000 | 2546ms |
| 2026-04-14-01 | general | medium | 113 | 105 | 0.00 | $0.0000 | 143ms |
| 2026-04-14-00 | general | medium | 14 | 10 | 0.00 | $0.0000 | 212ms |
| 2026-04-10-02 | general | medium | 6 | 6 | 0.00 | $0.0000 | 18739ms |
| 2026-04-10-01 | general | medium | 86 | 86 | 0.50 | $0.0000 | 1468ms |
| 2026-03-18-02 | general | medium | 8 | 0 | 0.00 | $0.0000 | 2632ms |
| 2026-04-15-18 | general | medium | 8 | 8 | 0.00 | $0.0000 | 75ms |
| 2026-04-11-07 | general | medium | 12 | 12 | 0.00 | $0.0000 | 1045ms |
| 2026-04-10-05 | general | medium | 74 | 74 | 0.00 | $0.0000 | 2042ms |
| 2026-03-18-01 | general | medium | 3 | 0 | 0.00 | $0.0000 | 2397ms |
| 2026-03-18-04 | general | medium | 12 | 4 | 0.00 | $0.0000 | 7511ms |
| 2026-03-18-04 | qa | high | 1 | 1 | 0.70 | $0.0069 | 2954ms |
| 2026-04-15-17 | qa | high | 35 | 35 | 0.14 | $0.0000 | 5677ms |
| 2026-03-19-13 | qa | low | 2 | 2 | 0.86 | $0.0060 | 9674ms |
| 2026-04-15-14 | qa | low | 3 | 3 | 1.00 | $0.0000 | 28807ms |
| 2026-02-27-09 | qa | low | 1 | 1 | 1.00 | $0.0000 | 37176ms |
| 2026-04-10-01 | qa | low | 31 | 31 | 1.00 | $0.0000 | 2953ms |
| 2026-03-30-05 | qa | low | 10 | 10 | 0.96 | $0.0001 | 888ms |
| 2026-03-20-14 | qa | low | 1 | 1 | 1.00 | $0.0000 | 14278ms |
| 2026-04-09-18 | qa | low | 35 | 35 | 1.00 | $0.0001 | 2203ms |
| 2026-04-15-15 | qa | low | 93 | 93 | 1.00 | $0.0000 | 1736104ms |
| 2026-03-20-16 | qa | low | 1 | 1 | 1.00 | $0.0000 | 6310ms |
| 2026-04-11-08 | qa | low | 9 | 9 | 1.00 | $0.0000 | 70702ms |
| 2026-04-10-07 | qa | low | 8 | 8 | 1.00 | $0.0000 | 3086ms |
| 2026-02-20-06 | qa | low | 6 | 6 | 0.57 | $0.0036 | 12235ms |
| 2026-03-18-04 | qa | low | 1 | 1 | 1.00 | $0.0000 | 2953ms |
| 2026-04-10-05 | qa | low | 48 | 48 | 1.00 | $0.0001 | 1008ms |
| 2026-04-10-17 | qa | low | 30 | 30 | 1.00 | $0.0000 | 1776ms |
| 2026-04-10-03 | qa | low | 15 | 15 | 1.00 | $0.0000 | 6895ms |
| 2026-04-11-07 | qa | low | 32 | 32 | 1.00 | $0.0000 | 1334ms |
| 2026-02-20-04 | qa | low | 5 | 5 | 0.60 | $0.0031 | 7346ms |
| 2026-04-02-04 | qa | low | 29 | 29 | 1.00 | $0.0000 | 1922ms |
| 2026-02-18-00 | qa | low | 9 | 9 | 0.66 | $0.0006 | 3684ms |
| 2026-04-10-04 | qa | low | 21 | 21 | 1.00 | $0.0000 | 1219ms |
| 2026-04-10-06 | qa | low | 19 | 19 | 1.00 | $0.0000 | 6108ms |
| 2026-03-18-08 | qa | low | 2 | 2 | 0.78 | $0.0000 | 1571ms |
| 2026-02-19-17 | qa | low | 7 | 7 | 0.64 | $0.0019 | 4269ms |
| 2026-04-02-14 | qa | low | 24 | 24 | 1.00 | $0.0000 | 3582ms |
| 2026-04-14-01 | qa | low | 118 | 118 | 1.00 | $0.0000 | 14232ms |
| 2026-04-02-10 | qa | low | 2 | 2 | 1.00 | $0.0000 | 2344ms |
| 2026-04-14-02 | qa | low | 63 | 63 | 1.00 | $0.0000 | 219794ms |
| 2026-02-28-12 | qa | low | 1 | 1 | 1.00 | $0.0000 | 1926ms |
| 2026-04-02-09 | qa | low | 24 | 24 | 1.00 | $0.0000 | 1923ms |
| 2026-04-15-17 | qa | low | 6 | 6 | 1.00 | $0.0000 | 39284ms |
| 2026-04-10-22 | qa | low | 34 | 34 | 1.00 | $0.0000 | 566ms |
| 2026-03-30-07 | qa | low | 12 | 12 | 1.00 | $0.0001 | 2867ms |
| 2026-04-11-15 | qa | low | 30 | 30 | 1.00 | $0.0000 | 2722ms |
| 2026-03-30-06 | qa | low | 9 | 9 | 1.00 | $0.0001 | 2074ms |
| 2026-04-10-17 | qa | medium | 6 | 5 | 0.00 | $0.0000 | 293ms |
| 2026-04-10-06 | qa | medium | 6 | 4 | 0.00 | $0.0000 | 226ms |
| 2026-04-10-05 | qa | medium | 4 | 4 | 0.00 | $0.0000 | 241ms |
| 2026-04-10-03 | qa | medium | 5 | 3 | 0.00 | $0.0000 | 586ms |
| 2026-04-11-15 | qa | medium | 4 | 4 | 0.00 | $0.0000 | 219ms |
| 2026-04-10-04 | qa | medium | 1 | 1 | 0.00 | $0.0000 | 230ms |
| 2026-04-10-01 | qa | medium | 4 | 4 | 0.00 | $0.0000 | 227ms |
| 2026-04-09-18 | qa | medium | 4 | 4 | 0.00 | $0.0000 | 239ms |
| 2026-04-14-01 | qa | medium | 13 | 13 | 0.00 | $0.0000 | 1146ms |
| 2026-04-14-02 | qa | medium | 2 | 0 | 0.00 | $0.0000 | 201579ms |
| 2026-04-02-14 | qa | medium | 8 | 4 | 0.00 | $0.0000 | 2298ms |
| 2026-04-02-09 | qa | medium | 8 | 4 | 0.00 | $0.0000 | 2421ms |
| 2026-04-02-04 | qa | medium | 3 | 3 | 0.00 | $0.0000 | 238ms |
| 2026-04-15-17 | qa | medium | 49 | 49 | 0.00 | $0.0000 | 47ms |
| 2026-03-19-13 | qa | medium | 2 | 0 | 0.00 | $0.0000 | 4360ms |
| 2026-03-18-04 | qa | medium | 1 | 0 | 0.00 | $0.0000 | 4972ms |
| 2026-04-15-15 | qa | medium | 6 | 6 | 0.50 | $0.0000 | 637058ms |
| 2026-03-18-03 | qa | medium | 1 | 0 | 0.00 | $0.0000 | 4953ms |
| 2026-04-11-07 | qa | medium | 6 | 5 | 0.00 | $0.0000 | 220ms |
| 2026-04-10-22 | qa | medium | 5 | 4 | 0.00 | $0.0000 | 222ms |
| 2026-04-15-17 | reasoning | high | 38 | 38 | 0.63 | $0.0000 | 321ms |
| 2026-04-14-02 | reasoning | high | 88 | 88 | 0.50 | $0.0000 | 9477ms |
| 2026-04-15-15 | reasoning | low | 31 | 31 | 1.00 | $0.0000 | 14140ms |
| 2026-04-10-01 | reasoning | low | 15 | 15 | 1.00 | $0.0000 | 1754ms |
| 2026-04-10-06 | reasoning | low | 2 | 2 | 1.00 | $0.0000 | 2784ms |
| 2026-04-14-00 | reasoning | low | 5 | 5 | 1.00 | $0.0000 | 1285ms |
| 2026-04-15-13 | reasoning | low | 3 | 3 | 1.00 | $0.0000 | 938ms |
| 2026-04-02-09 | reasoning | low | 31 | 31 | 1.00 | $0.0000 | 21117ms |
| 2026-04-15-10 | reasoning | low | 52 | 52 | 1.00 | $0.0000 | 3186ms |
| 2026-04-10-21 | reasoning | low | 1 | 1 | 1.00 | $0.0000 | 2678ms |
| 2026-04-11-08 | reasoning | low | 22 | 22 | 1.00 | $0.0000 | 1672ms |
| 2026-04-11-07 | reasoning | low | 12 | 12 | 1.00 | $0.0000 | 2237ms |
| 2026-04-02-10 | reasoning | low | 5 | 5 | 1.00 | $0.0000 | 6594ms |
| 2026-04-15-02 | reasoning | low | 4 | 4 | 1.00 | $0.0000 | 4305ms |
| 2026-04-10-22 | reasoning | low | 19 | 19 | 1.00 | $0.0000 | 1748ms |
| 2026-04-15-16 | reasoning | low | 2 | 2 | 1.00 | $0.0000 | 5384ms |
| 2026-04-15-09 | reasoning | low | 196 | 196 | 1.00 | $0.0000 | 1955ms |
| 2026-04-14-12 | reasoning | low | 18 | 18 | 1.00 | $0.0000 | 87015ms |
| 2026-04-15-07 | reasoning | low | 2 | 2 | 1.00 | $0.0000 | 2413ms |
| 2026-04-02-14 | reasoning | low | 33 | 33 | 1.00 | $0.0000 | 7400ms |
| 2026-04-10-17 | reasoning | low | 17 | 17 | 1.00 | $0.0000 | 1939ms |
| 2026-04-10-05 | reasoning | low | 16 | 16 | 1.00 | $0.0000 | 2155ms |
| 2026-04-14-02 | reasoning | low | 272 | 272 | 1.00 | $0.0000 | 13649ms |
| 2026-04-02-15 | reasoning | low | 2 | 2 | 1.00 | $0.0000 | 28581ms |
| 2026-04-11-15 | reasoning | low | 50 | 50 | 1.00 | $0.0000 | 2285ms |
| 2026-04-10-07 | reasoning | low | 22 | 22 | 1.00 | $0.0000 | 1861ms |
| 2026-04-10-03 | reasoning | low | 3 | 3 | 1.00 | $0.0000 | 2841ms |
| 2026-04-15-17 | reasoning | low | 160 | 160 | 1.00 | $0.0000 | 5291ms |
| 2026-04-15-18 | reasoning | low | 17 | 17 | 1.00 | $0.0000 | 475722ms |
| 2026-04-14-03 | reasoning | low | 12 | 12 | 1.00 | $0.0000 | 4016ms |
| 2026-04-15-14 | reasoning | low | 7 | 7 | 1.00 | $0.0000 | 86443ms |
| 2026-04-02-04 | reasoning | low | 41 | 41 | 1.00 | $0.0000 | 6146ms |
| 2026-04-15-08 | reasoning | low | 99 | 99 | 1.00 | $0.0000 | 29329ms |
| 2026-04-09-18 | reasoning | low | 39 | 39 | 1.00 | $0.0000 | 1203ms |
| 2026-04-14-01 | reasoning | low | 215 | 215 | 1.00 | $0.0000 | 1822ms |
| 2026-04-09-19 | reasoning | low | 1 | 1 | 1.00 | $0.0000 | 1534ms |
| 2026-04-10-04 | reasoning | low | 20 | 20 | 1.00 | $0.0000 | 1987ms |
| 2026-04-10-17 | reasoning | medium | 26 | 18 | 0.00 | $0.0000 | 6688ms |
| 2026-04-15-09 | reasoning | medium | 25 | 0 | 0.00 | $0.0000 | 149834ms |
| 2026-04-02-03 | reasoning | medium | 3 | 0 | 0.00 | $0.0000 | 3150ms |
| 2026-04-02-04 | reasoning | medium | 8 | 8 | 0.00 | $0.0000 | 279ms |
| 2026-04-02-09 | reasoning | medium | 16 | 16 | 0.00 | $0.0000 | 279ms |
| 2026-04-02-14 | reasoning | medium | 16 | 16 | 0.00 | $0.0000 | 247ms |
| 2026-04-14-12 | reasoning | medium | 19 | 15 | 0.76 | $0.0000 | 1183ms |
| 2026-04-15-17 | reasoning | medium | 66 | 62 | 0.00 | $0.0000 | 151ms |
| 2026-04-14-02 | reasoning | medium | 145 | 145 | 0.50 | $0.0000 | 26085ms |
| 2026-04-09-18 | reasoning | medium | 14 | 9 | 0.75 | $0.0000 | 561ms |
| 2026-04-11-07 | reasoning | medium | 7 | 7 | 0.00 | $0.0000 | 239ms |
| 2026-04-10-01 | reasoning | medium | 19 | 3 | 0.00 | $0.0000 | 5838ms |
| 2026-04-10-02 | reasoning | medium | 1 | 0 | 0.00 | $0.0000 | 8902ms |
| 2026-04-14-01 | reasoning | medium | 48 | 48 | 0.50 | $0.0000 | 3232ms |
| 2026-04-11-06 | reasoning | medium | 2 | 0 | 0.00 | $0.0000 | 2678ms |
| 2026-04-10-22 | reasoning | medium | 28 | 18 | 0.00 | $0.0000 | 5914ms |
| 2026-04-10-04 | reasoning | medium | 25 | 14 | 0.00 | $0.0000 | 6899ms |
| 2026-04-11-15 | reasoning | medium | 17 | 12 | 0.50 | $0.0000 | 1094ms |
| 2026-04-10-05 | reasoning | medium | 31 | 18 | 0.00 | $0.0000 | 8004ms |
| 2026-04-14-00 | reasoning | medium | 3 | 2 | 0.67 | $0.0000 | 9358ms |
| 2026-04-10-07 | reasoning | medium | 22 | 14 | 0.00 | $0.0000 | 6133ms |
| 2026-04-10-18 | reasoning | medium | 2 | 0 | 0.00 | $0.0000 | 9062ms |
| 2026-02-18-00 | refactoring | high | 1 | 1 | 0.68 | $0.0010 | 3068ms |
| 2026-02-20-04 | refactoring | high | 2 | 2 | 0.54 | $0.0057 | 16345ms |
| 2026-04-15-12 | refactoring | low | 4 | 4 | 1.00 | $0.0000 | 0ms |
| 2026-03-20-15 | refactoring | low | 2 | 2 | 1.00 | $0.0010 | 2930ms |
| 2026-03-20-14 | refactoring | low | 2 | 2 | 1.00 | $0.0007 | 2991ms |
| 2026-04-14-01 | refactoring | low | 4 | 4 | 1.00 | $0.0000 | 0ms |
| 2026-02-19-17 | refactoring | medium | 1 | 1 | 0.70 | $0.0020 | 15828ms |
| 2026-04-14-01 | refactoring | medium | 1 | 0 | 0.00 | $0.0000 | 1139ms |
| 2026-02-20-05 | refactoring | medium | 1 | 1 | 0.72 | $0.0006 | 13056ms |
| 2026-02-18-00 | refactoring | medium | 1 | 1 | 0.80 | $0.0026 | 8590ms |
| 2026-04-15-12 | refactoring | medium | 1 | 0 | 0.00 | $0.0000 | 180ms |
| 2026-03-20-14 | testing | low | 3 | 3 | 1.00 | $0.0003 | 2460ms |
| 2026-03-20-15 | testing | low | 2 | 2 | 1.00 | $0.0003 | 2805ms |

---

## 8. Learning Validation Reports

### Report 1: strategy / single

| Field | Value |
|-------|-------|
| Scope | strategy / single |
| Baseline Window | 2026-03-27 |
| Comparison Window | 2026-04-02 |
| Learning Velocity | -0.0785 |
| Stability Index | 0.5582 |
| Validated | false |
| Verdict | **degrading** |
| Date | 2026-04-03T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.07846166666666665,
  "successRate": 0,
  "costImprovement": 538.0086083886163,
  "latencyImprovement": -0.3803303303303303
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -0.3803303303303303,
    "metric": "latency",
    "severity": "critical"
  }
]
```
</details>

### Report 2: strategy / single

| Field | Value |
|-------|-------|
| Scope | strategy / single |
| Baseline Window | 2026-03-31 |
| Comparison Window | 2026-04-06 |
| Learning Velocity | -0.1060 |
| Stability Index | 0.6840 |
| Validated | false |
| Verdict | **degrading** |
| Date | 2026-04-07T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.1059686732186732,
  "successRate": 0,
  "costImprovement": 0,
  "latencyImprovement": -3.149616368286445
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -0.1059686732186732,
    "metric": "quality",
    "severity": "warning"
  },
  {
    "delta": -3.149616368286445,
    "metric": "latency",
    "severity": "critical"
  }
]
```
</details>

### Report 3: strategy / single

| Field | Value |
|-------|-------|
| Scope | strategy / single |
| Baseline Window | 2026-04-03 |
| Comparison Window | 2026-04-09 |
| Learning Velocity | 0.1207 |
| Stability Index | 0.4254 |
| Validated | false |
| Verdict | **improving** |
| Date | 2026-04-10T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": 0.12070942442312682,
  "successRate": 0,
  "costImprovement": -101.63239280265883,
  "latencyImprovement": 0.7793244092434285
}
```
</details>

### Report 4: strategy / debate

| Field | Value |
|-------|-------|
| Scope | strategy / debate |
| Baseline Window | 2026-04-04 |
| Comparison Window | 2026-04-10 |
| Learning Velocity | 0.0005 |
| Stability Index | 0.9826 |
| Validated | false |
| Verdict | **inconclusive** |
| Date | 2026-04-11T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": 0.000517676767676778,
  "successRate": 0,
  "costImprovement": 0.2685103289871546,
  "latencyImprovement": -0.19723110808117889
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -0.19723110808117889,
    "metric": "latency",
    "severity": "warning"
  }
]
```
</details>

### Report 5: strategy / single

| Field | Value |
|-------|-------|
| Scope | strategy / single |
| Baseline Window | 2026-04-04 |
| Comparison Window | 2026-04-10 |
| Learning Velocity | 0.0078 |
| Stability Index | 0.4630 |
| Validated | false |
| Verdict | **stable** |
| Date | 2026-04-11T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": 0.007769432934315534,
  "successRate": 0,
  "costImprovement": -0.3421984113138581,
  "latencyImprovement": 0.008632738633560798
}
```
</details>

### Report 6: strategy / cost-cascade

| Field | Value |
|-------|-------|
| Scope | strategy / cost-cascade |
| Baseline Window | 2026-04-04 |
| Comparison Window | 2026-04-10 |
| Learning Velocity | -0.0070 |
| Stability Index | 0.1624 |
| Validated | false |
| Verdict | **inconclusive** |
| Date | 2026-04-11T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.006961206896551664,
  "successRate": 0,
  "costImprovement": -1.191531114223132,
  "latencyImprovement": -0.2725428542448524
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -0.2725428542448524,
    "metric": "latency",
    "severity": "warning"
  }
]
```
</details>

### Report 7: strategy / debate

| Field | Value |
|-------|-------|
| Scope | strategy / debate |
| Baseline Window | 2026-04-05 |
| Comparison Window | 2026-04-11 |
| Learning Velocity | -0.0002 |
| Stability Index | 0.9762 |
| Validated | false |
| Verdict | **stable** |
| Date | 2026-04-12T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.00019551544982221447,
  "successRate": 0,
  "costImprovement": 0.338439954083082,
  "latencyImprovement": 0.03652328242492177
}
```
</details>

### Report 8: strategy / single

| Field | Value |
|-------|-------|
| Scope | strategy / single |
| Baseline Window | 2026-04-05 |
| Comparison Window | 2026-04-11 |
| Learning Velocity | -0.0161 |
| Stability Index | 0.4791 |
| Validated | false |
| Verdict | **stable** |
| Date | 2026-04-12T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.01614216819025205,
  "successRate": 0,
  "costImprovement": -0.004844916081991356,
  "latencyImprovement": 0.16429426084086315
}
```
</details>

### Report 9: strategy / quality-multipass

| Field | Value |
|-------|-------|
| Scope | strategy / quality-multipass |
| Baseline Window | 2026-04-05 |
| Comparison Window | 2026-04-11 |
| Learning Velocity | 0.0050 |
| Stability Index | 0.5067 |
| Validated | false |
| Verdict | **stable** |
| Date | 2026-04-12T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": 0.004980769230769289,
  "successRate": 0,
  "costImprovement": -1.9312349391721175,
  "latencyImprovement": 0.08717332845991176
}
```
</details>

### Report 10: strategy / cost-cascade

| Field | Value |
|-------|-------|
| Scope | strategy / cost-cascade |
| Baseline Window | 2026-04-05 |
| Comparison Window | 2026-04-11 |
| Learning Velocity | 0.0675 |
| Stability Index | 0.5447 |
| Validated | true |
| Verdict | **improving** |
| Date | 2026-04-12T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": 0.06752070393374743,
  "successRate": 0,
  "costImprovement": 1,
  "latencyImprovement": -0.007839358836796812
}
```
</details>

### Report 11: strategy / quality-multipass

| Field | Value |
|-------|-------|
| Scope | strategy / quality-multipass |
| Baseline Window | 2026-04-07 |
| Comparison Window | 2026-04-13 |
| Learning Velocity | -0.0029 |
| Stability Index | 0.5919 |
| Validated | false |
| Verdict | **degrading** |
| Date | 2026-04-14T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.002878787878787925,
  "successRate": 0,
  "costImprovement": 1,
  "latencyImprovement": -21.42317571038473
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -21.42317571038473,
    "metric": "latency",
    "severity": "critical"
  }
]
```
</details>

### Report 12: strategy / sequential

| Field | Value |
|-------|-------|
| Scope | strategy / sequential |
| Baseline Window | 2026-04-07 |
| Comparison Window | 2026-04-13 |
| Learning Velocity | 0.0106 |
| Stability Index | 0.0000 |
| Validated | false |
| Verdict | **degrading** |
| Date | 2026-04-14T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": 0.010624999999999996,
  "successRate": -0.050000000000000044,
  "costImprovement": 0.9967094217587716,
  "latencyImprovement": -1.85767550868222
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -1.85767550868222,
    "metric": "latency",
    "severity": "critical"
  }
]
```
</details>

### Report 13: strategy / debate

| Field | Value |
|-------|-------|
| Scope | strategy / debate |
| Baseline Window | 2026-04-07 |
| Comparison Window | 2026-04-13 |
| Learning Velocity | -0.2719 |
| Stability Index | 0.0000 |
| Validated | false |
| Verdict | **degrading** |
| Date | 2026-04-14T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.2718907741251325,
  "successRate": -0.4782608695652174,
  "costImprovement": 0.9844281109242539,
  "latencyImprovement": -2.28650812338121
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -0.2718907741251325,
    "metric": "quality",
    "severity": "critical"
  },
  {
    "delta": -0.4782608695652174,
    "metric": "successRate",
    "severity": "critical"
  },
  {
    "delta": -2.28650812338121,
    "metric": "latency",
    "severity": "critical"
  }
]
```
</details>

### Report 14: strategy / single

| Field | Value |
|-------|-------|
| Scope | strategy / single |
| Baseline Window | 2026-04-07 |
| Comparison Window | 2026-04-13 |
| Learning Velocity | -0.0076 |
| Stability Index | 0.4330 |
| Validated | false |
| Verdict | **degrading** |
| Date | 2026-04-14T04:00:00 |

<details><summary>Improvement Delta</summary>

```json
{
  "quality": -0.007549868315584574,
  "successRate": 0,
  "costImprovement": 0.9535899074288148,
  "latencyImprovement": -2.2463920691319035
}
```
</details>

<details><summary>Regressions</summary>

```json
[
  {
    "delta": -2.2463920691319035,
    "metric": "latency",
    "severity": "critical"
  }
]
```
</details>

---

*End of supplementary data.*
