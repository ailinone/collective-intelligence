<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Introduction

Ailin¹ Collective Intelligence (CI) API is a state-of-the-art orchestration platform powered by proprietary Ailin intelligence. It coordinates 1,251 AI models from 15+ providers worldwide, making real-time decisions about which strategies and models maximize quality, cost efficiency, and resilience for each request.

Standard OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/embeddings`) are preserved for seamless integration, while the platform adds:

- **Collective Intelligence Strategies**: Debate, consensus, collaborative, expert-panel, war-room — dynamically selected per request complexity and task type
- **Semantic Model Discovery**: Triage engine understands request intent and matches it to models with specialized strengths (reasoning, creativity, factual accuracy, code generation, etc.)
- **Real-Time Learning Flywheel**: Quality feedback from every execution trains proprietary Ailin systems that optimize strategy and model selection over time
- **Enterprise-Grade Governance**: Tenant isolation, policy enforcement, cost governance, audit trails, and observable decision-making — compliant-ready design without compromise
- **Virtual Ailin Model Aliases**: `ailin-auto`, `ailin-reasoning`, `ailin-creative` — productized experiences that abstract complexity while delivering superiority

## Why Collective > Single

Early benchmark evidence (v3, 2,394 executions) points to where collective
orchestration earns its keep — a positive **trend that is not yet
statistically significant** (p=0.706) and awaits the v4 re-run:

- **Orchestration multiplies cheap models**: collective strategies over
  budget models scored **+77% quality versus the same models alone**
  (Cohen's d = 0.919) — the strongest, most robust finding to date
- **Consensus (0.863 avg quality, small sample)** scored above every
  individual Tier 1 model measured when it completed; **Debate (0.780)** is
  the best quality-reliability trade-off among collective strategies
- **Aggregate CI vs single Tier 1** trends positive (+2pp, p=0.706); the v3
  cost comparison ("24% cheaper") came from accounting with known bugs
  (since fixed) and is **pending re-measurement** in the v4 benchmark
- **Theoretical foundation**: Condorcet Jury Theorem proves that diverse voters with >50% accuracy converge to truth as group size grows; Page's Diversity Prediction Theorem shows diverse groups outperform homogeneous experts

We publish the method, raw data and limitations alongside the claims — see
`docs/ARTICLE-CI-BENCHMARK.md`.

## Who This Is For

- **Product Teams**: Build AI features that outperform single-model baselines without managing provider complexity
- **Platform Teams**: Centralize multi-provider AI access with one governance layer; seamlessly absorb new providers and models
- **Enterprise Teams**: Policy-driven, cost-predictable, auditable AI infrastructure with compliance-ready design

## Core Principle

Users call one API surface with a stable contract. Ailin decides the best execution strategy and model selection. The client gets superior results while the platform handles provider diversity, fallback chains, learning optimization, and policy enforcement.

## Compatibility & OpenAI Equivalence

- OpenAI-like request/response format is preserved where possible
- Additional fields (strategy hints, capability requirements, metadata inspection) are optional extensions
- Existing OpenAI clients work unchanged; Ailin-specific features are opt-in
- Adapters/providers remain pluggable and dynamically discovered

## Read Next

- **Overview**: Core concepts and high-level flow
- **Quickstart**: First request in 5 minutes
- **Architecture**: Deep dive into collective orchestration, strategy cascade, learning loops
