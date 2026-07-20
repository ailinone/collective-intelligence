<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Persona: Platform SRE

SRE baseline: deterministic alerts, retry policy validation, and production-safe rollback strategy.

## Goals

Ensure availability, cost predictability, and secure operations.

## Key Resources

- **Health & Readiness:** `/v1/status/health`, `/v1/status/ready`
- **Observability:** Request/correlation ID logging and tracing
- **Resilience:** `docs/guides/errors-rate-limits.md`
- **Simulations:** Operational chaos engineering in staging

## Operational Runbook

1. **Confirm Status & Dominant Error**
   - Check `/v1/status/health` and `/v1/status/ready` endpoints
   - Identify error pattern (429, 503, timeout, auth)

2. **Classify Error Type**
   - `429` (rate limit) → Apply backoff strategy
   - `503` (provider degraded) → Route to fallback providers
   - Timeout → Investigate circuit breaker state
   - Auth failure → Verify token and tenant isolation

3. **Apply Resilience Controls**
   - Activate circuit breaker for degraded providers
   - Adjust strategy preferences (single vs consensus)
   - Scale down concurrent requests if needed

4. **Validate Recovery in Staging**
   - Test failover path in canary deployment
   - Verify cost impact under degradation
   - Confirm automatic recovery without manual intervention
