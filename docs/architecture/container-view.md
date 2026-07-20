<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Container View

Routing and governance are centralized in orchestration; capability execution, persistence, billing, learning, and observability are isolated containers. The orchestration core follows a triage-strategy-selection-execution-aggregation pipeline.

```mermaid
flowchart TB
  Gateway["API Gateway\n& Request Handling"]
  AuthPolicy["Auth, Policy\n& Tenant Isolation"]

  subgraph Core["Orchestration Core"]
    Triage["Triage &\nSemantic Classification"]
    StrategyEngine["Strategy\nEngine"]
    ModelSelector["Model\nSelection"]
    Aggregator["Response\nAggregation"]
  end

  subgraph Intelligence["Intelligence Layer"]
    CapabilityRegistry["Capability &\nModel Registry"]
    ProviderExec["Provider\nExecution Layer"]
    QualityScoring["Quality Scoring\n& Critique"]
  end

  subgraph Support["Platform Services"]
    Memory["Memory, Cache\n& Retrieval"]
    BillingQuota["Billing, Quota\n& Usage"]
    Observability["Observability\n& Audit Trail"]
    LearningLoop["Learning &\nAdaptation"]
  end

  Persistence[("Persistence\n(Relational + KV + Vector)")]

  Gateway --> AuthPolicy
  AuthPolicy --> Triage
  Triage --> StrategyEngine
  StrategyEngine --> ModelSelector
  ModelSelector --> ProviderExec
  ProviderExec --> Aggregator
  Aggregator --> Gateway

  StrategyEngine --> CapabilityRegistry
  ModelSelector --> CapabilityRegistry
  ProviderExec --> QualityScoring

  Triage --> Memory
  Aggregator --> Memory
  ProviderExec --> BillingQuota
  Gateway --> Observability
  Aggregator --> Observability
  QualityScoring --> LearningLoop

  Memory --> Persistence
  BillingQuota --> Persistence
  Observability --> Persistence
  LearningLoop --> Persistence
```

## Control-Plane vs Execution-Plane

Conceptual separation between declarative governance and runtime execution.

```mermaid
flowchart TB
  subgraph ControlPlane["Control Plane"]
    direction LR
    AuthConfig["Auth &\nTenant Config"]
    PolicyRules["Policy &\nGovernance Rules"]
    ModelRegistry["Model &\nCapability Registry"]
    StrategyConfig["Strategy\nProfiles"]
    BillingRules["Billing &\nQuota Rules"]
    LearningState["Learning\nState"]
  end

  subgraph ExecutionPlane["Execution Plane"]
    direction LR
    RequestHandling["Request\nHandling"]
    TriageExec["Triage\nExecution"]
    StrategyExec["Strategy\nExecution"]
    ProviderExec["Provider\nCalls"]
    SynthesisExec["Response\nSynthesis"]
    UsageEmit["Usage &\nTrace Emission"]
  end

  AuthConfig -.->|"enforces"| RequestHandling
  PolicyRules -.->|"constrains"| TriageExec
  ModelRegistry -.->|"informs"| StrategyExec
  StrategyConfig -.->|"configures"| StrategyExec
  BillingRules -.->|"meters"| ProviderExec
  LearningState -.->|"optimizes"| TriageExec
  LearningState -.->|"optimizes"| StrategyExec

  RequestHandling --> TriageExec
  TriageExec --> StrategyExec
  StrategyExec --> ProviderExec
  ProviderExec --> SynthesisExec
  SynthesisExec --> UsageEmit
```

The control plane holds declarative configuration and learned state. The execution plane processes requests procedurally, constrained by control-plane rules at every stage.
