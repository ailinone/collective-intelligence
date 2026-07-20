<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Ailin CI API Documentation

This folder contains functional documentation for the `ci/api` project.

Use this as the primary guide for product, integration, operations, and support.

## Start Here

- Introduction: `ci/docs/getting-started/introduction.md`
- Overview: `ci/docs/getting-started/overview.md`
- Quickstart: `ci/docs/getting-started/quickstart.md`
- Installation: `ci/docs/getting-started/installation.md`
- First 30 Minutes: `ci/docs/getting-started/first-30-minutes.md`
- Collective Intelligence: `ci/docs/architecture/collective-intelligence.md`
- Migration Guide: `ci/docs/guides/migration-guide.md`

## Personas

- Developer: `ci/docs/personas/developer.md`
- Platform SRE: `ci/docs/personas/platform-sre.md`
- Security and Governance: `ci/docs/personas/security-governance.md`
- Product and Ops: `ci/docs/personas/product-ops.md`

## Integration

- Model aliases and routing: `ci/docs/guides/model-aliases-and-routing.md`
- Pricing, billing, and margin: `ci/docs/guides/pricing-billing-margin.md`
- Authentication: `ci/docs/guides/authentication.md`
- Errors and rate limits: `ci/docs/guides/errors-rate-limits.md`
- TypeScript SDK: `ci/docs/integration/typescript-sdk.md`
- Python SDK: `ci/docs/integration/python-sdk.md`
- OpenAI compatibility mapping: `ci/docs/integration/openai-compatibility-mapping.md`

## Use Cases

- Basic chat: `ci/docs/use-cases/basic-chat.md`
- Streaming and tools: `ci/docs/use-cases/streaming-and-tools.md`
- Multi-model consensus: `ci/docs/use-cases/multi-model-consensus.md`
- Cost-capped routing: `ci/docs/use-cases/cost-capped-routing.md`
- Realtime session: `ci/docs/use-cases/realtime-session.md`
- Enterprise governance: `ci/docs/use-cases/enterprise-governance.md`

## Architecture

- System context: `ci/docs/architecture/system-context.md`
- Container view: `ci/docs/architecture/container-view.md`
- Request sequences: `ci/docs/architecture/request-sequences.md`
- Data flow memory/cache: `ci/docs/architecture/data-flow-memory-cache.md`
- Resilience and rate limit: `ci/docs/architecture/resilience-and-rate-limit.md`

## Support

- Troubleshooting: `ci/docs/support/troubleshooting.md`
- FAQ: `ci/docs/support/faq.md`
- Security and governance: `ci/docs/support/security-and-governance.md`

## Simulations

- Local smoke: `ci/docs/simulations/local-smoke.md`
- Staging smoke: `ci/docs/simulations/staging-smoke.md`
- Failure injection: `ci/docs/simulations/failure-injection.md`
- Retry/backoff validation: `ci/docs/simulations/retry-backoff-validation.md`

## API Contract

- API surface summary: `ci/docs/reference/api-surface.md`
- Endpoints catalog (full): `ci/docs/reference/endpoints-catalog.md`
- Endpoints by tag: `ci/docs/reference/endpoints/README.md`
- OpenAPI YAML: `openapi-spec.yaml`
- OpenAPI JSON: `openapi-spec.json`

## Contract Validation

From repository root:

```bash
npm -C ci run check:openapi
npm -C ci run generate:docs
npm -C ci run check:docs
```

This runs lint, bundle, and parity checks for the OpenAPI contract.
