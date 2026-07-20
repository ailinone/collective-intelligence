<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# First 30 Minutes

30-minute checklist to validate auth, model discovery, and first response.

## Step 1: Health Check (0-10 min)

```bash
curl https://api.ailin.one/v1/status/health
```

## Step 2: Model Discovery & Capabilities (10-20 min)

```bash
curl -H "Authorization: Bearer $AILIN_TOKEN" \
  https://api.ailin.one/v1/models
```

```bash
curl -H "Authorization: Bearer $AILIN_TOKEN" \
  https://api.ailin.one/v1/provider-capabilities
```

## Step 3: First Response with Decision Metadata (20-30 min)

```bash
curl -X POST https://api.ailin.one/v1/responses \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-auto",
    "input": "Create a deployment checklist for enterprise APIs."
  }'
```

Inspect these fields in `ailin_metadata`:

- `final_decider_model_id`
- `final_decider_model_name`
- `final_decider_role`

These fields show which model made the final decision and why — core to understanding Ailin's orchestration.

1. Check health.
2. List models and provider capabilities.
3. Send a `/v1/responses` request with `model: "ailin-auto"`.
4. Confirm `final_decider_*` fields in `ailin_metadata`.
