<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Model Aliases and Routing

Aliases let a user pick an Ailin "model name" while runtime chooses concrete provider models dynamically.

## Built-In Aliases

- `ailin-auto`
- `ailin-best`
- `ailin-fast`
- `ailin-economy`
- `ailin-consensus`

## Composite `<strategy>:<tier>` ids

In addition to the preset aliases, a request can name a **collective product** directly as
`<strategy>:<tier>` — for example `consensus:large`, `expert-panel:extra`, `economy:small`. The
**strategy** picks the mechanism and the **tier** picks the budget/quality + the published per-token
price. The tier is clamped into the strategy's valid range, and only execution-ready strategies route.
See [Pricing, Billing, and Margin](./pricing-billing-margin.md) for the tier rate card and how prices are
calibrated from the benchmark frontier. The legacy `ailin-*` presets keep their exact prior behaviour —
the composite scheme only activates on a `:tier` suffix or a non-preset strategy name.

## How Alias Resolution Works

1. Client sends `model: "ailin-..."` or `model: "<strategy>:<tier>"`.
2. Alias resolves to orchestration profile (preset) or a strategy + tier (composite).
3. Runtime applies strategy + constraints; composite ids also attach the tier rate for billing.
4. Real models are selected dynamically from discovered inventory.
5. Final decider metadata is returned in `ailin_metadata`.

No provider model is hardcoded by alias.

## Profile Inputs

You can configure alias profiles through environment settings:

- `AILIN_AUTO_MODEL_ALIASES` (simple alias list)
- `AILIN_VIRTUAL_MODEL_PROFILES` (full JSON profile list)

## Supported Profile Fields

- `id`, `displayName`, `description`
- `strategy`, `qualityTarget`, `maxCost`, `taskType`
- `constraints`:
  - `requiredCapabilities`
  - `requiredTools`
  - `requiredEndpoint`
  - `preferredProviders`
  - `excludedProviders`
  - `maxInputCostPer1k`
  - `maxOutputCostPer1k`
  - `maxAverageCostPer1k`
  - `minContextWindow`
- `billing`:
  - `inputMarkupMultiplier`
  - `outputMarkupMultiplier`
  - `minInputCostPer1kUsd`
  - `minOutputCostPer1kUsd`
  - `flatFeeUsd`
  - `minimumChargeUsd`
  - `maximumChargeUsd`

## Example Profile

```json
[
  {
    "id": "ailin-code-pro",
    "strategy": "quality-multipass",
    "qualityTarget": 0.94,
    "constraints": {
      "requiredCapabilities": ["chat", "reasoning", "code_generation"],
      "maxAverageCostPer1k": 0.008
    },
    "billing": {
      "inputMarkupMultiplier": 1.25,
      "outputMarkupMultiplier": 1.35,
      "minimumChargeUsd": 0.001
    },
    "endpoints": ["chat_completions", "responses"]
  }
]
```

## Decision Metadata

For multi-model strategies, rely on:

- `models_used` for full participants
- `final_decider_*` for final decision authority
