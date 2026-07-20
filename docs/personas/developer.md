<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Persona: Developer

Developer success means first production-safe integration with traceability and retry control.

## Goals

1. Integrate quickly and securely
2. Build production-safe error handling
3. Understand request tracing and observability
4. Follow retry and rate-limit best practices

## Key Resources

- **Getting Started:** `docs/getting-started/`
- **Integration Examples:** `docs/integration/` (TypeScript, Python, OpenAI compatibility)
- **API Contracts:** `docs/reference/endpoints/`
- **Error Handling:** `docs/guides/errors-rate-limits.md`

## Delivery Checklist

- ✅ Authenticate via Bearer token or API key
- ✅ Use `model: "ailin-auto"` or a product alias (`ailin-reasoning`, `ailin-cost-optimized`)
- ✅ Include `X-Request-Id` and `X-Correlation-Id` headers for tracing
- ✅ Implement retry logic for `429`/`503` with exponential backoff
- ✅ Log `ailin_metadata` fields to understand orchestration decisions
- ✅ Monitor cost and quality metrics per request
