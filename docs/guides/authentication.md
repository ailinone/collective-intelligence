<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Authentication

The OpenAPI contract supports two authentication schemes:

- Bearer token (`Authorization: Bearer <jwt>`)
- API key (`X-API-Key: <api_key>`)

## OpenAPI Semantics (Important)

In OpenAPI, authentication semantics depend on the shape of `security`:

- `security` as an array means **OR**
- a single object with multiple schemes means **AND**

Example used globally in this API:

```yaml
security:
  - bearerAuth: []
  - apiKeyAuth: []
```

This means clients can authenticate with **Bearer OR API Key**. Sending both is not required.

## Bearer Token

```http
Authorization: Bearer <jwt>
```

Recommended for user/session flows and tenant-scoped requests.

## API Key

```http
X-API-Key: <api_key>
```

Recommended for service-to-service integrations and automated workloads.

Use `X-API-Key` as the canonical header in docs/examples. Header names are case-insensitive in HTTP, but docs stay standardized on this casing.

## Public vs Authenticated Endpoints

Operations that declare `security: []` are public and override global auth defaults.

Examples of public endpoints:

- `GET /v1/models`
- `GET /v1/models/list`
- `GET /v1/models/{id}`
- `POST /v1/auth/login`
- `POST /v1/auth/email-challenge`
- `GET /v1/status`
- `GET /v1/status/ready`
- `GET /v1/status/health`

Refer to `docs/reference/endpoints-catalog.md` for the complete public/authenticated split.

## Best Practices

- Never store plaintext tokens/keys in the repository.
- Use a secret manager for runtime injection.
- Rotate credentials periodically.
- Enforce least privilege and tenant isolation checks.
