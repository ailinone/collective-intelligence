<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Resilience and Rate Limit

Resilience combines quota/rate-limit controls, retry hints (`Retry-After`), circuit breakers, provider failover, strategy-level degradation, and adaptive timeouts. Provider health checks gate execution; strategy degradation allows the engine to downgrade to simpler execution modes under pressure.

```mermaid
flowchart LR
  Req["Incoming\nRequest"]
  Auth["Auth &\nPolicy Guard"]
  Quota["Quota &\nRate Limit"]
  Health["Provider\nHealth Check"]
  Route["Strategy\nExecution"]
  Provider["Provider\nExecution"]

  subgraph Resilience["Resilience Mechanisms"]
    Circuit["Circuit\nBreaker"]
    StrategyFallback["Strategy\nDegradation"]
    ProviderFallback["Provider\nFallback"]
    AdaptiveTimeout["Adaptive\nTimeout"]
  end

  Resp["Response"]
  Backoff["429 + Retry-After\nAdvice"]

  Req --> Auth
  Auth --> Quota
  Quota -->|"OK"| Health
  Quota -->|"exceeded"| Backoff
  Health --> Route
  Route --> Provider
  Provider -->|"success"| Resp
  Provider -->|"failure"| Circuit
  Circuit --> ProviderFallback
  ProviderFallback --> Resp
  Route -->|"strategy\nerror"| StrategyFallback
  StrategyFallback --> Route
  Provider --> AdaptiveTimeout
  AdaptiveTimeout --> Circuit
```
