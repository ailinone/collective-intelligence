<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-026: Real Code Execution for `code_interpreter` — the Container Sandbox, Extended

**Status**: Proposed (flagged off by default; requires human security review before enabling anywhere)
**Date**: 2026-09
**Context**: closes ADR-024's own documented open follow-up #2 ("`code_interpreter` migration" — see that document's "Deliberately out of scope") and the production incident fixed in `fix(orchestration): honest degradation for code-execution requests` (`code-execution-honesty.ts`).
**Related**: ADR-024 (`ADR-024-agentic-capability-execution.md` — the container sandbox this document extends), `docs/audit/04-security-assessment.md` **[SEC-04]**, `reports/provider-integration-gap-register.json` (GAP-AP-14b, still open for the untouched `/v1/code/execute` surface).

---

## Context

Two separate facts motivate this document:

1. **The plain chat path has no real code-execution pipeline at all.** A production incident (2026-09) showed a request like "execute this Python code and show me the real output" getting a single garbage letter as its entire response, because the model was told (via the capability-awareness section) that `tool_use`/`function_calling` were "available" purely from an execute-shaped verb in the request text, with no real tool behind that claim. The fix that shipped (`code-execution-honesty.ts`, `capability-inference.ts`'s `detectCodeExecutionIntent`) is a targeted HONESTY fix, not an execution capability: it tells the model to reason the answer out itself and say so, explicitly documenting that building real sandboxed execution was "a multi-day architectural effort, out of scope for a hotfix."

2. **`code_interpreter`'s only existing execution path (`sandbox_workflow` → `CodeExecutionService` → `MultiBackendSandbox`) is the exact isolation gap ADR-024 was written to avoid repeating.** `MultiBackendSandbox` tries `e2b` → `daytona` → `local`, and the `local` backend (`LocalProcessSandbox`) is `child_process.spawn` **on the API host**: it inherits the full `process.env` (provider keys, `JWT_SECRET`, `DATABASE_URL`), has no memory limit, and no network restriction. ADR-024 built a real, isolated Docker sandbox specifically because handing an agentic loop that primitive "would be handing it remote code execution" — but ADR-024 deliberately did NOT extend that sandbox to `code_interpreter`, listing "`code_interpreter` migration" as open follow-up #2 under "Deliberately out of scope": *"The `local` backend remains a host process, untouched by this reconciliation. Migrating it onto the new container sandbox... is a follow-up, not silently bundled here."*

This document is that follow-up, closing it the same way ADR-024 closed the equivalent gap for `computer_use`/`agents`/`mcp`: build on the SAME isolated Docker sandbox, ship it flagged off, and never make the new attack surface reachable except through an explicit, reviewed opt-in.

## Decision

**Extend `core/sandbox/container-sandbox.ts` (ADR-024) with the minimum needed to run a real interpreter, and add a new, narrowly-scoped `code-execution.ts` caller — not a second sandbox implementation.** Gate the whole thing behind `CODE_EXECUTION_SANDBOX_ENABLED`, its own independent flag, default `false`.

### Why reuse `container-sandbox.ts` rather than build a second Docker wrapper

`container-sandbox.ts` already provides, and this document does not re-derive: `--network none` by default, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a fixed non-root user, `--memory`/`--memory-swap`/`--cpus`/`--pids-limit`, a size-capped noexec `/tmp`, no Docker-socket mount, a hard host-enforced wall-clock timeout (`docker kill`), output-size capping while streaming, and a structured audit trail with Prometheus metrics. Reusing it means code execution inherits a SINGLE, already-reviewed isolation floor instead of standing up a second one a reviewer would have to independently re-verify line by line.

### What had to change in the shared primitive, and why each change is additive

`container-sandbox.ts`'s existing design was built for computer_use/agents/mcp's tool-call shape (a bare command + argv, executed against a bind-mounted scope directory), which does not fit code execution as-is. Three additive changes, each preserving the EXISTING contract for every current caller:

1. **`SandboxExecOptions.stdin`** — the program travels over the container's stdin (`python3 -` / `node -` both read their program from stdin), not as an argv element and not via the `/workspace` bind mount. Two reasons:
   - `assertArgAllowed` caps a single argv element at 4096 bytes — real programs routinely exceed that.
   - `container-sandbox.ts`'s own documentation (`ensureScopeWritable`'s doc comment) records an **unresolved** host-process-filesystem-vs-Docker-daemon-filesystem split on this project's actual CI runner topology: a file the API process writes to a session's scope directory via `fs.writeFile` is not reliably visible to a container reading that same path on that runner, and the reverse direction fails identically. Delivering the source over stdin sidesteps that specific, already-known-broken path entirely — the code never touches `session.scopePath` from the host side. `buildDockerArgs` gained a matching `interactive` flag (adds `-i`) so the container can actually read what is piped to it; every existing caller omits it and is byte-for-byte unaffected (see `container-sandbox-args.test.ts`'s "omits -i by default" test).
2. **`SandboxExecOptions.commandAllowlist`** — a per-call override to `assertCommandAllowed`. `container-sandbox.ts`'s SHARED default allowlist deliberately excludes every interpreter and shell (`DEFAULT_COMMAND_ALLOWLIST`'s own doc comment: "any interpreter that trivially re-implements them" would make the computer_use allowlist decorative). Code execution's entire purpose is running an interpreter, so it cannot use that default without weakening computer_use's contract. The override lets `code-execution.ts` allow EXACTLY the one interpreter binary a given call needs (`python3` or `node`), enforced through the identical `assertCommandAllowed` choke point, without ever touching or widening the shared default (pinned by `sandbox-policy.test.ts`'s "the computer_use default allowlist is UNCHANGED" test). There is no `CODE_EXECUTION_COMMAND_ALLOWLIST` env var — unlike the computer_use allowlist, an operator has no legitimate reason to widen this fixed, two-entry map.
3. **`SandboxExecOptions.image`** — a per-call override to the image `buildDockerArgs` uses. The shared default (`alpine:3.20`) ships neither interpreter; code execution runs `python:3.12-alpine` or `node:20-alpine` (operator-pinnable via `CODE_EXECUTION_PYTHON_IMAGE`/`CODE_EXECUTION_NODE_IMAGE`) instead. Every other resource limit (memory/cpu/pids/timeout/output cap/network mode) stays the ONE shared, centrally-tuned envelope every sandboxed exec is bound by — only the image differs.

None of these three options are read by existing callers (computer_use/agents/mcp tools), so their behaviour is provably unchanged — see the "omits -i by default" / allowlist-default tests above.

### Container-per-call, deliberately NOT session-cached

`sandbox-session-manager.ts` (ADR-024) deliberately caches one scope directory per caller identity across MULTIPLE tool calls, because a multi-step computer_use/agent run needs `computer_write_file` then a later `computer_shell cat` to see the same files. Code execution has no such contract: each `executeCode()` call is one complete, self-contained run. `code-execution.ts` therefore calls `createSandboxSession()`/`disposeSandboxSession()` directly around exactly one `execInSandbox()` call — never through the session manager's cache — guaranteeing a **fresh scope directory and a fresh container (`--rm`, always) for every single request**, with nothing shared across requests or tenants. Verified for real against Docker in `code-execution-adversarial.integration.test.ts`'s CE-13 (a file written in one call is invisible in the next).

### Threat model — inherited from ADR-024, deltas only

Every threat T1–T10 in ADR-024's table applies unchanged (same container, same flags, same audit). The deltas specific to code execution:

| # | Threat | Code-execution-specific note |
|---|---|---|
| T1 (host RCE) | The interpreter itself IS the "arbitrary command" — but it only ever runs inside the same ephemeral, `--network none`, `--read-only`, non-root container as every other sandboxed exec. No fallback to a host process (`SandboxUnavailableError` on no Docker), same as ADR-024. |
| T2 (credential exfiltration) | Unchanged: no `-e`/`--env-file`, read-only root, no network. Verified live (CE-8): the API process's own env, including a planted canary secret, is invisible inside the interpreter. |
| T3 (network exfiltration) | Verified live through the ACTUAL surface a model-written script would use — Python's `urllib`/Node's `http`, not just a CLI tool like `wget` (CE-4, CE-5) — rather than re-relying solely on ADR-024's `wget`-based proof. |
| T4 (path escape) | Narrower here than for computer_use: there are no caller-supplied FILE paths at all — the only "path" concept is the fixed `/workspace` mount, used purely as the script's own internal scratch space within a single container invocation. `resolveScopedPath` is not invoked by this module because there is nothing for a caller to name a path for. |
| T5 (resource exhaustion) | Same limits, verified again specifically through the stdin invocation path (CE-10 memory, CE-11 wall-clock) in case the stdin/interactive change introduced a gap the existing ADR-024 tests (which exec a bare command, not an interpreter fed a program) would not catch. |
| T6 (sandbox escape) | Unchanged. |
| new: **wrong-interpreter execution** | Mitigated at the extraction layer, not the sandbox: `capability-inference.ts`'s `extractExecutableCodeBlock` returns `null` — never a guess — for an untagged or unrecognized fenced-code-block language tag, so a request is either run as the language it was explicitly and recognizably tagged with, or not run at all. |

Residual risks accepted are the same as ADR-024's (container escape via kernel 0-day; the isolation is container-level, not VM-level).

### Feature flag

| Flag | Default | Gates |
|---|---|---|
| `CODE_EXECUTION_SANDBOX_ENABLED` | `false` | Real execution for `code_interpreter`, both the chat-path pre-step (`code-execution-orchestration.ts`) and the REST dispatch (`code_execution_sandbox` mode in `capabilities-routes.ts`). |

Same strict-opt-in parsing as every ADR-024 flag: only the exact string `'true'` enables it (`sandbox-policy.test.ts` pins this). Deliberately independent of `AGENTIC_COMPUTER_USE_ENABLED`/`AGENTIC_AGENTS_ENABLED`/`MCP_CLIENT_ENABLED` — enabling code execution does not imply consent to system control, and vice versa.

Operator-tunable, all optional, all defaulting to values that ship the interpreters used:

- `CODE_EXECUTION_PYTHON_IMAGE` (default `python:3.12-alpine`)
- `CODE_EXECUTION_NODE_IMAGE` (default `node:20-alpine`)
- `CODE_EXECUTION_MAX_SOURCE_BYTES` (default `200_000`, clamped `[1_000, 2_000_000]`)

Resource/network/timeout/output-size limits are the SAME shared knobs ADR-024 already defines (`SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `SANDBOX_EXEC_TIMEOUT_MS`, `SANDBOX_NETWORK_MODE`, `SANDBOX_MAX_OUTPUT_BYTES`, ...) — one envelope, one place to tune it for every sandboxed execution kind.

### Two integration points, one primitive

1. **Chat path** (`execution-system-prompt.ts` / `capability-inference.ts` / new `code-execution-orchestration.ts`): `orchestration-engine.ts` calls `maybeExecuteDetectedCode(request, context)` immediately before building the execution system prompt. With the flag off, this is a single boolean check and nothing else — no regex runs, the sandbox module is never imported into the hot path's execution. With the flag on and genuine, extractable intent (`resolveExecutableCodeRequest`), it runs the code for real and sets `context.codeExecutionResult`; `execution-system-prompt.ts` then reports the REAL result instead of injecting `CODE_EXECUTION_HONESTY_DIRECTIVE`. Any failure in this pre-step (including `SandboxUnavailableError`) is caught and logged, never thrown — the honesty directive is always there as a safe fallback.
2. **REST** (`capabilities-routes.ts`): `code_interpreter`'s `executionPath` becomes `['code_execution_sandbox', 'sandbox_workflow', 'orchestration']`. With the flag off, `executeCodeExecutionSandboxMode` checks `isCodeExecutionSandboxEnabled()` itself and throws before ever calling `executeCode` — a deliberate defense-in-depth duplicate of the same check `executeCode` also performs internally (`CodeExecutionDisabledError`, before creating a session or touching Docker), so the route-level gate does not rely on `executeCode`'s own check surviving every call path. Either check failing lets the dispatcher's existing try/catch-and-continue loop fall through to `sandbox_workflow` (`CodeExecutionService`, untouched) exactly as it did before this ADR — the SAME byte-for-byte-identical-when-disabled contract ADR-024 established for `computer_use`/`agents`/`mcp`. A genuine request-validation error (missing `code`, an unsupported `language`) is a 400 and is propagated immediately instead of triggering that fallthrough — a malformed request would fail the exact same way in every other mode, so trying them only delays and obscures the real error.

`buildExecutionSystemPrompt` itself was deliberately kept fully synchronous with an unchanged signature (still `(request, context) => string | null`) — the pre-step runs BEFORE it, mutating `context` in place (the same idiom `orchestration-engine.ts` already uses for `context.isCollectiveStrategy`), so none of that function's ~15 existing call sites/tests needed to change.

## What was verified, and how

- **Hermetic unit tests** (no Docker; run in the standard CI unit gate): `sandbox-policy.test.ts` (flag gating, language config, per-call allowlist override, byte-ceiling clamping), `container-sandbox-args.test.ts` (the `-i` flag, the allowlist override reaching `execInSandbox`'s policy gate), `code-execution.test.ts` (the `executeCode` request/response contract: disabled/validation errors, and — via a mocked `container-sandbox` module — that the right command/args/stdin/allowlist/image reach `execInSandbox`), `code-execution-extraction.test.ts` (language/code extraction, including the "never guess" invariant), `code-execution-orchestration.test.ts` (the chat-path pre-step's flag-gating and fail-open-to-honesty-directive behaviour), `execution-system-prompt-code-execution-result.test.ts` (byte-for-byte-identical flag-off output; the new branch's content when flag-on), and `code-execution-sandbox-dispatch.test.ts` (REST dispatch fallthrough, with the legacy `CodeExecutionService`/orchestration paths mocked deterministically so the flag-off test never risks touching the pre-existing unsafe `LocalProcessSandbox` chain).
- **Live-Docker adversarial tests** (`code-execution-adversarial.integration.test.ts`, `.integration.test.ts` suffix — excluded from the CI unit gate, requires a real Docker daemon, run via `vitest.integration.config.ts`; a guard test fails loudly rather than skipping quietly if Docker is unreachable): real Python/JS execution via stdin (CE-1, CE-2), a genuine interpreter error surfaced honestly (CE-3), outbound network blocked through the actual stdlib HTTP client of both languages (CE-4, CE-5), the container root filesystem is read-only while `/workspace` remains writable (CE-6, CE-7), no ambient credentials leak into the interpreter (CE-8), non-root execution (CE-9), a memory-limit OOM kill (CE-10), wall-clock timeout enforcement on an infinite loop (CE-11), output truncation at the configured cap (CE-12), and container-per-call isolation — nothing written in one call is visible in the next (CE-13). These were additionally smoke-tested manually against the real Docker daemon available in this development environment before being encoded as the automated suite (network isolation, read-only fs, memory OOM, and both interpreters running via stdin were each independently confirmed with raw `docker run` invocations).
- **What still needs a live environment to fully confirm beyond this development machine**: the exact CI runner's Docker topology (this repository's own `ensureScopeWritable` doc already records that this project's actual CI runner has unusual host-fs/container-fs behavior on ONE specific topology — code execution's stdin-only design was chosen specifically to avoid depending on the affected path, but that has only been proven correct by design/reasoning plus testing on this development machine's Docker Desktop, not yet re-confirmed against that exact runner); behavior under real production concurrency/load (many simultaneous `executeCode` calls competing for host CPU/memory — the per-call container overhead of ~200-600ms ADR-024 measured for its own tool-call shape was not independently re-measured here for the interpreter-image cold-start case, which is likely somewhat higher for `python:3.12-alpine`/`node:20-alpine` than for the minimal `alpine:3.20` computer_use uses); and, per ADR-024's own accepted residual risk, container-escape via a kernel 0-day, which no test suite can prove absent.

## Consequences

**Positive**

- Closes ADR-024's own explicitly-named open follow-up ("`code_interpreter` migration") using the exact isolation floor that ADR already built and had reviewed, rather than a new, separately-reviewable mechanism.
- The chat-path honesty-directive fix (the actual incident fix already in production) is upgraded from "reason it out and say so" to "here is the REAL result" — but ONLY behind an explicit, reviewed, default-off flag; the honesty path remains the unconditional fallback and is provably byte-for-byte unchanged while the flag is off.
- One shared resource envelope (memory/cpu/timeout/network/output-cap) governs every sandboxed execution kind (computer_use, agents, mcp, now code execution), rather than each capability inventing its own tuning surface.

**Negative / accepted**

- The pre-existing `/v1/code/execute` REST route and `CodeExecutionService`'s `LocalProcessSandbox` fallback are UNTOUCHED by this ADR, exactly as ADR-024 left them — [SEC-04]/GAP-AP-14b remain open for that specific surface. `code_interpreter`'s `sandbox_workflow` mode (used only when `CODE_EXECUTION_SANDBOX_ENABLED` is off, matching today's production behaviour) still reaches that same untouched path.
- Docker is now a hard dependency for `code_interpreter` when the flag is on, same trade-off ADR-024 already accepted for computer_use/agents/mcp.
- Per-call container + interpreter-image startup latency (not independently re-measured here; expected to be at or somewhat above ADR-024's ~200-600ms figure) makes this unsuitable for a tight latency budget — acceptable for an explicit "run this code" request, the same judgement ADR-024 already made for agentic steps.
- This is a genuinely NEW attack surface (arbitrary interpreter code, even sandboxed) and ships requiring human security review before the flag is ever set to `true` anywhere, including this repository's own CI/staging environments.

**Deliberately out of scope**

1. **Program-supplied stdin.** The script itself cannot currently receive runtime stdin input (the stdin channel carries the PROGRAM, not data for it to read) — a future iteration could add a separate `input` field once there is a safe way to route it that doesn't collide with program delivery.
2. **Downloadable output files.** A script's writes to `/workspace` are not read back by the host after execution (only stdout/stderr/exit code are returned) — this deliberately avoids depending on the same unresolved host-fs/container-fs disjunction `container-sandbox.ts` documents for `computer_use`'s file tools. Closing this requires either that disjunction being fixed at the infrastructure level, or routing readback through Docker itself rather than a bare host `fs` call.
3. **Languages beyond Python/JavaScript.** Deliberately small: these are the two `capability-inference.ts`/`execution-system-prompt.ts` already advertise for code generation. Adding a language means adding one entry to `sandbox-policy.ts`'s fixed language map and one alias mapping in `capability-inference.ts` — by design, not a structural change.
4. **Migrating `/v1/code/execute` / `CodeExecutionService` itself onto this sandbox.** Left exactly where ADR-024 left it — a distinct, not-silently-bundled follow-up.
