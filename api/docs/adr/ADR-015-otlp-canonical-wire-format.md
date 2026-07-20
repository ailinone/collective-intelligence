<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-015: OTLP/JSON as Canonical Wire Format

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature, serialization strategy

## Context

Broadcast needs to emit traces to 15+ destinations with diverse native formats. Options considered:

1. **Destination-specific serializers** (N formats for N destinations)
2. **Custom canonical JSON** → per-destination transformer
3. **OTLP/JSON** (OpenTelemetry Protocol) as canonical wire format

## Decision

**OTLP/JSON (version 1.5.0+)** is the canonical wire format produced by the serializer. Destinations that don't natively accept OTLP have a thin adapter that maps OTLP → native (at most a field-rename layer).

All traces follow **OpenTelemetry GenAI semantic conventions** (`gen_ai.*` attributes) as the primary span taxonomy.

## Rationale

- **Native interop**: Datadog, Grafana Cloud, New Relic, Ramp, OTLP Collector all accept OTLP natively. Zero translation cost.
- **Future-proof**: new observability platforms converge on OTLP. We get future destinations for free.
- **Ecosystem alignment**: GenAI conventions are the de-facto standard (Langfuse, Phoenix, Arize, Braintrust all support them).
- **Debuggability**: OTLP is well-documented, inspectable with standard tools (otel-cli, tempo).
- **Schema versioning**: OTLP has its own versioning; we piggyback.

## Consequences

### Positive
- Destinations are mostly metadata (endpoint, auth), not transformation code
- Third-party OTEL libraries can validate our payloads
- No lock-in to any vendor's proprietary schema

### Negative
- OTLP/JSON is verbose (~2-3x vs. minimal custom JSON). Mitigated: destinations that charge by ingest volume already expect OTLP.
- Some destinations (PostHog, S3 raw) need custom serializers anyway.

## Implementation Notes

- `serialization/otlp-serializer.ts` is the canonical path.
- `ci/api`-specific fields (`banditState`, `equivalenceGroup`, `candidatesConsidered`) go under `ailin.*` attribute namespace on the generation span.
- User-provided `trace.*` metadata maps to OTEL span attributes (flattened, prefixed `custom.*`).
- Privacy-sensitive fields (`gen_ai.prompt`, `gen_ai.completion`) are the redaction targets per ADR-016.

## References

- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OTLP/JSON Encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
