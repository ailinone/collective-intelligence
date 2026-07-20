<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Errors and Rate Limits

## HTTP Status Model

- `200/201/202`: success
- `400`: invalid request shape or parameters
- `401`: missing/invalid auth
- `403`: forbidden by policy or scope
- `404`: resource not found
- `409`: conflict
- `422`: semantically invalid payload
- `429`: rate limit or quota pressure
- `500/502/503`: server/provider/transient failures

## Error Payload Contract

Standard error responses are aligned to `components.schemas.ErrorResponse`.

Required fields:

- `error.code`
- `error.message`
- `requestId`
- `correlationId`
- `timestamp`

Notes:

- `x-error-code` in `components.responses.*` is an OpenAPI extension (`x-*`) in the contract metadata.
- `x-error-code` is not a guaranteed JSON field in runtime payloads.

## Retry Guidance

Retry only when safe and idempotent enough for your operation.

- `429`: exponential backoff with jitter
- `5xx`: bounded retries with jitter and circuit logic
- `4xx`: fix payload/auth first, then retry

## Suggested Backoff Policy

1. Base delay: 250ms
2. Exponential factor: 2
3. Max delay: 10s
4. Max attempts: 5
5. Add random jitter (20-30%)

## Observability Headers

Capture these headers in clients and logs:

- `X-Request-Id`
- `X-Correlation-Id`

They are required for root-cause analysis across distributed services.

## Handling Provider Variance

Different providers can fail differently.
Rely on platform-level normalized error responses and metadata instead of provider-specific parsing in client code.
