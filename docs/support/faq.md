<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# FAQ

## Is this OpenAI-compatible?

Yes. Core OpenAI-style endpoints are supported with optional Ailin extensions.

## Are provider models hardcoded?

No. Runtime selection is based on discovered inventory, capabilities, and constraints.

## What is an Ailin model alias?

A product-facing name (`ailin-*`) that maps to an orchestration profile, not a single fixed provider model.

## Can one request use multiple models?

Yes. Multi-model strategies can run multiple executions and produce one final answer.

## Which model should I trust as the final one?

Use:

- `final_decider_model_id`
- `final_decider_model_name`
- `final_decider_role`

These explicitly identify the decision authority for the final output.

## Can I control cost and margin?

Yes. Use alias billing profiles and runtime constraints (`max_cost`, per-1k constraints, markup/floor caps).

## Where is the source API contract?

- `openapi-spec.yaml`
- `openapi-spec.json`
