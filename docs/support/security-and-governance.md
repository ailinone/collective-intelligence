<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Security and Governance

This page defines exposure rules and governance boundaries for `ci/api`.

## Security Model

- Authentication: bearer token and API key schemes
- Authorization: tenant, organization, and role checks
- Policy enforcement: quota, content policy, and operation-level constraints
- Observability: request and correlation IDs for audit and incident triage
- Data minimization: retention and redaction rules by scope

## Endpoint Exposure Policy

### Public contract endpoints

- Defined in OpenAPI (`ci/openapi-spec.yaml` and `ci/openapi-spec.json`)
- Intended for customer/client integration
- Versioned and monitored for compatibility

### Operator-restricted endpoints

- Used by platform operations or controlled maintenance workflows
- Must require authenticated/admin context
- May be hidden from public OpenAPI when not intended for clients

### Internal infrastructure endpoints

- Probe/metrics/internal status routes
- Exposed only behind internal network boundaries and platform controls

## Security-Driven Exclusions

The following categories may be excluded or hidden from public API docs by design:

- Debug and direct diagnostics endpoints (example: `POST /v1/auth/test-db`)
- Internal status routes (example: `GET /internal/jwks/status`)
- Infra probe routes (example: `GET /health/startup`)
- Platform ingest/webhook receiver endpoints (example: `POST /v1/billing/webhooks/stripe`)
- Raw metrics endpoints (example: `GET /metrics`)

These remain implementation details unless explicitly promoted to public contract.

## Governance Controls

- Tenant isolation is mandatory across all request paths
- Request execution must preserve provenance (`requestId` and `correlationId`)
- Policy outcomes must be auditable and reproducible
- Cost, quota, and safety decisions must be enforceable before model execution

## Operational Guidance

- Rotate credentials and keys periodically
- Keep secrets in managed secret stores, never in source control
- Restrict operator endpoints by auth scope and network policy
- Monitor `401`, `403`, `429`, and `5xx` trends with alerting
