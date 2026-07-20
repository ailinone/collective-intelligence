<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Migration Guide

This guide helps migrate from OpenAI-only usage to Ailin CI API.

## Migration Goals

- keep client contract familiar
- reduce provider lock-in
- add orchestration, fallback, and governance without breaking clients

## Endpoint Mapping

- `POST /v1/chat/completions`: supported
- `POST /v1/responses`: supported
- `GET /v1/models`: supported
- `POST /v1/embeddings`: supported

## Step-by-Step Migration

1. Point base URL to Ailin API.
2. Replace auth header with your Ailin bearer/API key.
3. Keep request shape unchanged.
4. Start with `model: "auto"` or `model: "ailin-auto"`.
5. Validate response compatibility in staging.
6. Enable optional Ailin extensions only after baseline is stable.

## Optional Extensions

- `strategy`
- `quality_target`
- `max_cost`
- alias-driven execution via `model: "ailin-*"`

## Streaming

If you use streaming, validate SSE behavior and timeout/retry policies in your SDK wrapper.

## Error Handling Updates

Treat provider/internal variation as platform-managed.
Your client should still handle:

- `429`: backoff and retry
- `5xx`: retry with jitter/circuit protections
- `4xx`: request correction or auth/policy remediation

## Recommended Rollout

1. Canary by tenant or feature flag.
2. Compare quality/cost/latency metrics.
3. Promote to full traffic after SLO validation.
