<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MVP 8C.0 — Shadow Routing Wiring Plan (NOT YET APPLIED)

This file documents the **minimal one-call insertion** required to wire
the shadow routing service into the runtime. Per MVP 8C.0 §5, the
wiring was intentionally NOT applied because the target runtime
workspace has 25+ pre-existing local modifications unrelated to this
MVP (operability/experiments work). The user should review their
in-flight work, decide on a clean commit boundary, and then apply
this patch in a focused commit.

## Pre-conditions before applying

1. Operator has committed (or cleanly set aside) the pre-existing
   modifications in `core/experiment/**`, `core/orchestration/**`,
   `core/pool/**`, `core/operability/**`, `providers/**`.
2. Operator has reviewed env defaults (all OFF) and confirmed they
   want shadow integration.
3. Operator has access to a `Logger` instance that knows where to
   route the `semantic_routing_shadow_decision` event (CloudWatch /
   OpenSearch / Loki / whatever the runtime uses).

## Step 1 — Boot the service ONCE at startup

Insert into `api/src/index.ts` (or the closest startup module):

```typescript
import {
  createShadowRoutingService,
  loadShadowConfigFromEnv,
} from '@/core/semantic-routing-shadow/shadow-routing-service';
import { ShadowRoutingConfig } from '@/core/semantic-routing-shadow/shadow-routing-config';

// Single instance per process.
const shadowConfig: ShadowRoutingConfig = loadShadowConfigFromEnv();
export const shadowRoutingService = createShadowRoutingService({
  config: shadowConfig,
  // logger: yourProductionLogger,     // optional
  // metrics: yourProductionMetrics,   // optional
});
```

## Step 2 — Fire-and-forget call in chat-routes.ts

Insert into `api/src/routes/chat/chat-routes.ts`, RIGHT AFTER the
runtime has determined the actual model/provider/strategy but BEFORE
it executes the call. The exact location is:
- after `orchestrationContext` is built,
- after the strategy resolution,
- before `OrchestrationEngine.execute(...)`.

```typescript
import { shadowRoutingService } from '@/index'; // adjust to actual export

// ... existing legacy selection logic ...
const actualSelection = await orchestrator.resolve(...);

// MVP 8C.0 — fire-and-forget shadow logging. NEVER awaited.
// Flag-gated by SEMANTIC_ROUTING_SHADOW_ENABLED env (default false).
if (shadowRoutingService.isEnabled()) {
  void shadowRoutingService.run({
    requestId,
    routeContext: {
      actualModel: actualSelection.model,
      actualProvider: actualSelection.provider,
      actualStrategy: actualSelection.strategyId,
      actualRouteId: actualSelection.routeId,
    },
    profilerInput: {
      requestId,
      approximateInputTokens: estimateTokenCount(chatRequest.messages),
      messageCount: chatRequest.messages?.length,
      explicitOutputFormat: detectOutputFormat(chatRequest),
      taskTypeHint: 'code-generation', // or derived elsewhere
    },
    metadata: { source: 'chat', timestamp: new Date().toISOString() },
  });
}

// ... legacy execution continues unchanged ...
```

**Key safety properties:**

- `void` — the legacy code path doesn't await shadow
- `isEnabled()` — gated by env flag (default false)
- `actualSelection` is read-only; shadow cannot mutate it
- Shadow's internal timeout is `SEMANTIC_ROUTING_SHADOW_MAX_LATENCY_MS` (default 25ms)
- Shadow errors are caught internally; the chat request continues regardless
- No raw prompt content is passed to shadow — only approximate token count + categorical hints

## Step 3 — Env vars to set when activating

```bash
SEMANTIC_ROUTING_SHADOW_ENABLED=true
SEMANTIC_ROUTING_SHADOW_SAMPLE_RATE=0.05          # start at 5%
SEMANTIC_ROUTING_SHADOW_LOG_LEVEL=info
SEMANTIC_ROUTING_SHADOW_MAX_LATENCY_MS=25
SEMANTIC_ROUTING_SHADOW_TASKTYPES=code-generation
SEMANTIC_ROUTING_SHADOW_WRITE_MODE=log_only
SEMANTIC_ROUTING_DECISION_MODE=legacy             # CRITICAL — keep legacy
```

## Step 4 — Rollback

Trivial: unset `SEMANTIC_ROUTING_SHADOW_ENABLED` (or set to `false`).
The service `isEnabled()` returns false → `run()` short-circuits with
`skippedReason='flag_disabled'`. No code revert needed.

## What this wiring does NOT do (intentionally)

- Does not change which model is called
- Does not change which strategy is run
- Does not change which provider is selected
- Does not alter the response
- Does not retry / replicate / fan-out
- Does not call the Pareto compute (default computer is the deferred
  stub returning `skippedReason='pareto_compute_not_yet_wired'`)

The Pareto compute will be wired in **MVP 8C.0.1** by injecting a
real `ShadowParetoComputer` implementation into the service options.

## Verification after applying

1. Run the chat route tests (existing suite) — should pass unchanged
2. Set `SEMANTIC_ROUTING_SHADOW_ENABLED=true SEMANTIC_ROUTING_SHADOW_SAMPLE_RATE=0.01`
   in a staging env
3. Send 100+ test requests
4. Confirm log events appear under `semantic_routing_shadow_decision`
5. Confirm response latency is unchanged
6. Confirm `skippedReason='pareto_compute_not_yet_wired'` (as expected
   in MVP 8C.0; will become real Pareto plans in MVP 8C.0.1)
