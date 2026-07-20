<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Persona: Product and Ops

Product/Ops success: predictable quality-cost tradeoff with measurable reliability and clear pricing strategy.

## Goals

Transform AI capabilities into operational offerings with margin control and SLA guarantees.

## Key Capabilities

- **Ailin Virtual Aliases** (`ailin-reasoning`, `ailin-creative`, `ailin-cost-optimized`)
- **Strategy-Based Routing** (single, consensus, debate, cost-cascade per use case)
- **Cost Controls** (max_cost, quality_target per request)
- **Fallback Chains** (graceful degradation under provider failure)
- **Observability** (per-endpoint metrics and cost tracking)

## Key Metrics to Monitor

- **Success Rate** — % of requests completing without error
- **Average Cost per Token** — Cost efficiency trends
- **Latency (p95/p99)** — User experience percentiles
- **Fallback Rate** — How often cascade/fallback activated
- **Cost per Quality Point** — Efficiency of quality-cost tradeoff
- **SLA Uptime** — Availability guarantees to customers

## Pricing Strategy

- Set `max_cost` ceiling per request type
- Use `quality_target` to trigger strategy escalation
- Monitor cost impact of strategy selection (consensus costs more)
- Adjust aliases over time based on cost-quality data
- Publish SLAs based on measured p95 latency and success rates
