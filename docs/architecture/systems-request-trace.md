<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Request trace mirrored to ailin.systems

`ci` mirrors the processing history of each request to the operator console
(`ailin.systems`) so an operator can audit a request from triage to output. The
receiving side, access controls and retention are documented in
`ailinone/systems` → `docs/security/AUDIT-TRAIL.md` (ADR-003).

## What is sent

| Plane | Field | Sent when | Contents |
|---|---|---|---|
| Structure | `stages[]` | always (when `SYSTEMS_OPERATIONS_URL` + `SYSTEMS_INGEST_API_KEY` are set) | triage, strategy selection, each participant (role, provider/model, latency, tokens, cost, evaluator verdict / score / outlier), quality scoring, final decision, observer events. Scalars only, on systems' attribute allowlist. Provider errors are reduced to a short code, never the message. |
| Correlation | `correlation_id` | always | the request's `X-Correlation-Id` (ci's own request-context). `chat` sends `chat:<chat_id>:<assistant_message_id>`, which is how an assistant message links to its trace. |
| Content | `trace_payloads[]` | **by default** (kill switch: `SYSTEMS_TRACE_CONTENT`) | the input, each participant's output, narration, reasoning and the final output, at most 400 000 characters per request (final output and input first). Systems seals it (AES-256-GCM) and requires its own switch + dedicated key; with either side off, or the key missing, it drops the content and keeps the structure. |

### Content capture switch

Content capture is **on by default**: `SYSTEMS_TRACE_CONTENT` unset or blank
captures. The switch is a privacy control, so it fails **safe**: any explicit
value that is not affirmative (`true`, `1`, `yes`, `on`, case-insensitive) —
`false`, `0`, `off`, but also a typo such as `flase` — turns capture off.

It retains users' prompts and model outputs in the operator console (30 days by
default, sealed, redacted, every read audited). To stop producing content
without touching systems, set `SYSTEMS_TRACE_CONTENT=false` on the `ci` API
service and redeploy. Content already stored is governed by systems' retention
and erasure endpoints.

## Where it is emitted

| Path | Hook | Notes |
|---|---|---|
| Non-streaming completions | `requestLogger.logOrchestration` → `buildSystemsTrace` → flush → `pushOperationalRequestBatch` | Full stages. `source_request_id` is the request-logger id (as before). |
| Collective SSE streaming (what `chat` uses for strategies) | `orchestrationEngine.executeStream` → `emitStreamTraceToSystems` → `pushOperationalTrace` | Previously invisible to systems (no `request_logs` row). **Still writes no `request_logs` row**, so usage analytics keep their meaning. `source_request_id` is the engine request id (the one `decision_audit`, `execution_outcomes` and `collective_runs` use). |
| Fast single-model streaming | `chat-routes.ts` `logRequest({ systemsTrace })` | One participant stage with the fallback attempts. |

Not covered yet: `/v1/responses`, extended-thinking and ultra-thinking, response-cache hits.

All emission is fire-and-forget and exception-safe: a trace gap never touches a request.
`systemsTrace` is a field of `RequestLogData` that `flush()` never maps into `request_logs`.
