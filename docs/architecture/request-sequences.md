<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Request Sequences

Sequence guarantees deterministic response envelope while preserving multi-model execution provenance. The triage-strategy-selection pipeline dynamically resolves how many models participate and how their outputs are synthesized into a final decision.

```mermaid
sequenceDiagram
  participant Client
  participant API as API Gateway
  participant Auth as Auth & Policy
  participant Triage as Triage
  participant Strategy as Strategy Engine
  participant Selector as Model Selector
  participant Provider as Provider(s)
  participant Synth as Synthesis
  participant Obs as Observability

  Client->>API: POST /v1/chat/completions
  API->>Auth: validate token, tenant, quota
  Auth-->>API: authorized
  API->>Triage: classify intent & complexity
  Triage->>Strategy: resolve execution strategy
  Strategy->>Selector: select candidate models
  Selector->>Provider: execute (1..N models)
  Provider-->>Synth: model responses
  Synth->>Synth: aggregate, score, decide
  Synth-->>API: final response + provenance
  API->>Obs: emit traces, usage, audit
  API-->>Client: response + ailin_metadata
```
