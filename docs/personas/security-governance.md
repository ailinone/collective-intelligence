<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Persona: Security and Governance

Governance success: clear public contract boundaries, enforceable policies, and auditable provenance.

## Goals

Validate privacy boundaries, enforce audit controls, and maintain compliance posture.

## Critical Control Points

- **Tenant Isolation** — Per-tenant data boundaries
- **Authentication & Scope** — Role-based access control (RBAC)
- **Public vs Internal APIs** — Only published endpoints in OpenAPI spec
- **Audit Trail** — Full provenance via `X-Request-Id` and `X-Correlation-Id`
- **Data Retention & Erasure** — Compliant right-to-be-forgotten
- **Observability Controls** — Sensitive data redaction in logs

## Recommended Audit Checklist

### 1. Public API Contract Review
- [ ] Verify `openapi-spec.yaml` contains only public endpoints
- [ ] Confirm internal endpoints (`/admin/*`, `/_internal/*`) are excluded
- [ ] Validate authentication schema (Bearer token, API key)
- [ ] Audit error messages for information leakage

### 2. Retention and Redaction Policies
- [ ] Review request/response log retention limits
- [ ] Audit PII redaction in audit trails
- [ ] Verify deletion compliance (GDPR right-to-be-forgotten)
- [ ] Validate sensitive field masking

### 3. Observability Headers
- [ ] Ensure `X-Request-Id` generation on all requests
- [ ] Verify `X-Correlation-Id` propagation across systems
- [ ] Audit that tracing doesn't expose sensitive data
- [ ] Confirm log levels don't leak credentials

### 4. Webhook and API Key Management
- [ ] Rotate API keys on schedule
- [ ] Audit webhook delivery logs
- [ ] Verify webhook signature validation
- [ ] Confirm no credentials in URLs or query parameters
