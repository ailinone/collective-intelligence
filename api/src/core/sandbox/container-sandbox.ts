// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Container sandbox — the isolation floor for `computer_use` and for every
 * tool the bounded agent loop runs (ADR-024 §2).
 *
 * WHY THIS IS NOT `runtime/local-process-sandbox.ts`
 * --------------------------------------------------
 * The existing `code_interpreter` sandbox chain (`runtime/sandbox-factory.ts`)
 * ends in `LocalProcessSandbox`, which is `child_process.spawn` on the API
 * host: full parent environment (every provider key, `JWT_SECRET`,
 * `DATABASE_URL`), unrestricted network, unrestricted filesystem, no memory or
 * pid limits. `MultiBackendSandbox` guarantees the LAST backend is always
 * attempted even when every circuit is open, so that host process is not an
 * edge case — it is the reliable floor. Handing an LLM-driven loop that
 * primitive would be handing it remote code execution.
 *
 * So this module does not extend that chain. It has ONE backend, Docker, and
 * NO fallback: if Docker is unavailable the capability fails closed with
 * `SandboxUnavailableError` rather than degrading to a host process. An
 * isolation guarantee with an unisolated fallback is not a guarantee.
 *
 * The container is started with, and this list is the security contract:
 *   --network none          no egress at all (default); `bridge` is
 *                           unreachable from configuration by design
 *   --read-only             root filesystem immutable
 *   -v <scope>:/workspace   exactly one writable location
 *   --cap-drop ALL          no capabilities, including CAP_NET_RAW
 *   --security-opt no-new-privileges   setuid binaries cannot elevate
 *   --user 65534:65534      never root
 *   --memory / --memory-swap (equal → swap disabled) / --cpus / --pids-limit
 *   --rm                    plus an explicit reap in `finally`
 * and the Docker socket is never mounted.
 *
 * One thing runs before that container, per session: `ensureScopeWritable`
 * mounts the same scope directory into a short-lived, equally-locked-down
 * (network none, read-only, no capabilities) but ROOT-default helper
 * container to `chmod 777 /workspace`, because on some Docker topologies
 * (see that function's doc) the API process cannot reliably chmod the right
 * directory from the host side alone. It runs one fixed command with no
 * caller-supplied input.
 *
 * The API process ALSO never touches `session.scopePath` with a bare
 * `node:fs` call for scope CONTENT (as opposed to the directory itself,
 * which `createSandboxSession`/`disposeSandboxSession` still create/remove
 * on the host). `writeFileInSandbox` / `readFileInSandbox` /
 * `listFilesInSandbox` move file content across the exact same `docker run
 * -v <scope>:/workspace` boundary `execInSandbox` uses, for the reason
 * documented on `ensureScopeWritable`: on this project's actual CI runner, a
 * file this process writes with `fs.writeFile` at `session.scopePath` is
 * genuinely invisible to a container mounting that same path string, and
 * vice versa — not a permission problem, a resolved-to-a-different-directory
 * problem, and no chmod or argv change closes it. Only routing that content
 * through Docker itself does.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix as posixPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';
import {
  assertArgAllowed,
  assertCommandAllowed,
  resolveAllowlistNetworkName,
  resolveSandboxLimits,
  SandboxPolicyError,
  type SandboxLimits,
} from './sandbox-policy';
import {
  digest,
  newAuditId,
  recordSandboxExec,
  type SandboxOutcome,
} from './sandbox-audit';

const log = logger.child({ component: 'container-sandbox' });

/**
 * Raised when the sandbox cannot be provided. This is a FAIL-CLOSED signal:
 * callers must surface it, never substitute a less isolated execution path.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export interface SandboxSession {
  readonly sessionId: string;
  /** Host path bound read-write at `/workspace` in the container. */
  readonly scopePath: string;
}

export interface SandboxExecResult {
  outcome: SandboxOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  auditId: string;
  /** Populated for `blocked`, `timeout` and `error`. */
  reason?: string;
  /** Whether output was cut at `maxOutputBytes`. */
  truncated: boolean;
}

export interface SandboxExecOptions {
  runId?: string;
  stepIndex?: number;
  organizationId?: string;
  userId?: string;
  /** Per-call override, still clamped by the resolved policy ceiling. */
  timeoutMs?: number;
}

/** Cached Docker probe. `null` = not probed yet. */
let dockerAvailable: boolean | null = null;

/** Reset the memoised Docker probe. Test-only. */
export function resetDockerProbeForTesting(): void {
  dockerAvailable = null;
}

/**
 * Probe for a usable Docker daemon. Memoised: the answer does not change
 * within a process lifetime often enough to justify probing per execution,
 * and an exec that fails because the daemon died mid-flight is reported as
 * `error` anyway.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    const result = await runHostProcess('docker', ['version', '--format', '{{.Server.Version}}'], 10_000);
    dockerAvailable = result.exitCode === 0;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/**
 * Create a session with a fresh, empty writable scope directory.
 *
 * The directory is chmod 0777 because the container process runs as an
 * unprivileged uid (65534 by default) that does not match the API process's
 * uid, and a bind mount carries host ownership through on Linux. The
 * directory is per-session, ephemeral, created under the OS temp dir with a
 * random name, and removed in `disposeSandboxSession` — so the permissive
 * mode is scoped to a directory whose entire contents are sandbox-owned
 * scratch.
 *
 * This chmod is necessary but NOT sufficient on this project's actual CI
 * runner (a container talking to the *host's* Docker daemon over a shared
 * `docker.sock` — Docker-outside-of-Docker, no nested daemon of its own):
 * a `docker run -v <path>:/workspace` issued from inside that runner
 * container is resolved by the daemon against a filesystem view this
 * process cannot chmod ahead of time, no matter which host directory the
 * path names (confirmed by trying both the runner's own `/tmp` and
 * `RUNNER_TEMP`/`_work` — both failed identically against the real runner;
 * see `ensureScopeWritable` for the fix that actually holds regardless of
 * that topology). Narrowing this chmod (matching uids, or a userns remap)
 * is the cleaner fix and is left as a follow-up in the ADR.
 */
export async function createSandboxSession(): Promise<SandboxSession> {
  const scopePath = await mkdtemp(join(tmpdir(), 'ci-agentic-'));
  try {
    await fs.chmod(scopePath, 0o777);
  } catch (err) {
    if (process.platform === 'win32') {
      // Windows ignores POSIX modes; a failure here is expected and not fatal.
    } else {
      // On a POSIX host the owner of a directory it just created can always
      // chmod it — a failure here means something is genuinely wrong (a
      // read-only temp mount, an LSM denial), not the routine case this
      // function exists to handle. Log it instead of assuming it away, so a
      // future "writes into /workspace fail" report has a lead instead of a
      // silently-swallowed exception.
      log.warn(
        { scopePath, err: err instanceof Error ? err.message : String(err) },
        'Failed to chmod sandbox scope directory to 0777 — container writes to /workspace may be refused'
      );
    }
  }
  return { sessionId: randomUUID(), scopePath };
}

/** Remove a session's scope directory and everything in it. */
export async function disposeSandboxSession(session: SandboxSession): Promise<void> {
  primedSessions.delete(session.sessionId);
  try {
    await rm(session.scopePath, { recursive: true, force: true });
  } catch (err) {
    log.warn(
      { sessionId: session.sessionId, err: err instanceof Error ? err.message : String(err) },
      'Failed to remove sandbox scope directory'
    );
  }
}

/**
 * Build the `docker run` argv.
 *
 * Exported so the security contract can be asserted directly in tests: a
 * regression that drops `--network none` or `--read-only` is then a failing
 * unit test rather than a silently weaker container.
 */
export function buildDockerArgs(params: {
  containerName: string;
  scopePath: string;
  limits: SandboxLimits;
  command: string;
  args: readonly string[];
}): string[] {
  const { containerName, scopePath, limits, command, args } = params;
  const network =
    limits.networkMode === 'allowlist' ? resolveAllowlistNetworkName() : 'none';

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    limits.user,
    '--memory',
    `${limits.memoryMb}m`,
    // Equal to --memory so the container cannot escape the memory cap via swap.
    '--memory-swap',
    `${limits.memoryMb}m`,
    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(limits.pidsLimit),
    // A small, non-executable /tmp so tools needing scratch space work
    // without making the root filesystem writable.
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '-v',
    `${scopePath}:/workspace`,
    '-w',
    '/workspace',
    limits.image,
    command,
    ...args,
  ];
}

/**
 * Build the argv for the priming step (see `ensureScopeWritable`).
 *
 * Deliberately mirrors `buildDockerArgs`'s isolation flags — no network, a
 * read-only root filesystem, no capabilities, no privilege escalation — with
 * exactly one difference: no `--user`, so the container runs as the image's
 * default root, which is the entire point (root bypasses the ownership
 * mismatch outright rather than needing to match it). It runs a single fixed
 * command with no caller-supplied input, so there is nothing here for a
 * model-driven command/arg to smuggle through.
 */
export function buildScopePrimingArgs(params: {
  containerName: string;
  scopePath: string;
  limits: SandboxLimits;
}): string[] {
  const { containerName, scopePath, limits } = params;
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    `${limits.memoryMb}m`,
    '--memory-swap',
    `${limits.memoryMb}m`,
    '--pids-limit',
    String(limits.pidsLimit),
    '-v',
    `${scopePath}:/workspace`,
    limits.image,
    'chmod',
    '777',
    '/workspace',
  ];
}

/** Session ids whose `/workspace` mount has already been proven writable this process. */
const primedSessions = new Set<string>();

/**
 * Prove — and if necessary force — that `/workspace` is writable by the
 * fixed non-root uid the real command will run as, BEFORE that command runs.
 *
 * `createSandboxSession`'s host-side `chmod 0777` is the correct fix when
 * the process creating the scope directory and the Docker daemon mounting it
 * agree on what that path names on disk. They do not always agree: on this
 * project's actual CI runner (itself a container reaching the *host's*
 * Docker daemon over a shared `docker.sock`), a `docker run -v
 * <path>:/workspace` is resolved by the daemon against a filesystem view
 * this process has no visibility into or control over — chmod-ing "the
 * scope directory" beforehand can land on a completely different,
 * default-permission directory than the one actually mounted. That was
 * confirmed against the real runner (ADV-5 failed with the scope directory
 * rooted under both the runner's own `/tmp` AND `RUNNER_TEMP`/`_work` —
 * changing the HOST-SIDE path did not change the outcome).
 *
 * The fix that does not depend on knowing or matching that topology: mount
 * the SAME `-v <scopePath>:/workspace` argument a second time, in a
 * throwaway container that (unlike the real one) runs as root by default,
 * and chmod `/workspace` from inside it. Docker guarantees both `docker run`
 * invocations resolve the identical bind source — whatever and wherever it
 * actually is — so this reaches the real mount every time, with no
 * assumption about runner/daemon topology at all. Root's chmod always
 * succeeds regardless of who (if anyone, if it was auto-vivified) owns the
 * directory, which is exactly the case that defeats the host-side chmod.
 *
 * Idempotent per session (tracked in `primedSessions`): the scope directory
 * does not change ownership back on its own between exec calls, so later
 * calls in the same multi-step agent run skip straight to the real command.
 * Best-effort — a failure here is logged, not thrown; the real command right
 * after it will simply fail with its own `error` outcome if the mount is
 * still not writable, exactly as it did before this existed.
 *
 * SCOPE OF WHAT THIS FIXES, confirmed against the real runner: this makes
 * container-to-container writes/reads of `/workspace` consistent with each
 * other (two separate `docker run -v <samePath>:/workspace` calls always see
 * the same content) — which is what ADV-5's own container-side assertions
 * (the `touch` and the `ls -1` inside the container) correctly prove.
 *
 * It does NOT, on its own, make the API process's own `fs.*` calls agree
 * with what a container sees at that path: on this runner, a file a
 * container writes is invisible to a same-process `fs.readdir
 * (session.scopePath)` right after, and — the other direction — a file
 * written via `fs.writeFile` was invisible to a subsequent
 * `execInSandbox('cat', …)`. That is a
 * host-process-filesystem-vs-Docker-daemon-filesystem split, not a
 * permission problem, and no chmod/argv change on either side of a `docker
 * run` can bridge it by itself.
 *
 * That is why `writeFileInSandbox` / `readFileInSandbox` / `listFilesInSandbox`
 * below never call bare `fs.writeFile` / `fs.readFile` / `fs.readdir` against
 * `session.scopePath` for CONTENT — they mount the identical `-v
 * <scopePath>:/workspace` argument through `docker run`, same as this
 * function, and move bytes across stdin/stdout instead. Reproduced and
 * confirmed fixed with a nested-container rig mirroring the runner's own
 * topology (a container with its own private `/tmp`, reaching a shared
 * `docker.sock`): writing a file with that container's own `fs` and reading
 * it back via `docker run -v <path>:/workspace … cat` fails exactly like the
 * CI regression ("No such file or directory"); writing AND reading through
 * two `docker run` calls against the same `-v` argument succeeds every time,
 * regardless of what the daemon actually resolves that path to. An
 * infrastructure fix to the runner so its own filesystem and its Docker
 * daemon's agree would also close this, but is out of this module's control.
 */
async function ensureScopeWritable(session: SandboxSession, limits: SandboxLimits): Promise<void> {
  if (primedSessions.has(session.sessionId)) return;
  const containerName = `ci-sbx-prime-${randomUUID()}`;
  const primeArgs = buildScopePrimingArgs({
    containerName,
    scopePath: session.scopePath,
    limits,
  });
  try {
    const result = await runHostProcess('docker', primeArgs, 15_000);
    if (result.exitCode === 0) {
      primedSessions.add(session.sessionId);
    } else {
      log.warn(
        { sessionId: session.sessionId, exitCode: result.exitCode, stderr: result.stderr },
        'Failed to prime sandbox scope directory as writable; the real command may fail'
      );
    }
  } catch (err) {
    log.warn(
      { sessionId: session.sessionId, err: err instanceof Error ? err.message : String(err) },
      'Failed to prime sandbox scope directory as writable; the real command may fail'
    );
  } finally {
    void runHostProcess('docker', ['rm', '-f', containerName], 10_000).catch(() => undefined);
  }
}

/**
 * Turn a scope-relative path into the path a container sees at `/workspace`.
 *
 * Callers pass this ONLY after `resolveScopedPath` has already proven the
 * request stays inside the scope, so collapsing `.`/`..` here is just
 * normalisation, not a security boundary. Backslashes are converted to `/`
 * unconditionally — the container is always Linux even when the API host is
 * Windows, so a caller-supplied `notes\todo.txt` must still land at
 * `/workspace/notes/todo.txt`, not a literal file named `notes\todo.txt`.
 */
export function toContainerPath(relPath: string): string {
  const forwardSlash = relPath.replace(/\\/g, '/');
  const normalized = posixPath.normalize(forwardSlash).replace(/^(\.\/)+/, '');
  return normalized === '.' || normalized === '' ? '/workspace' : `/workspace/${normalized}`;
}

/**
 * Build the argv for the internal file-content helper container used by
 * `writeFileInSandbox` / `readFileInSandbox` / `listFilesInSandbox`.
 *
 * Mirrors `buildDockerArgs`'s isolation flags, plus `-i` (stdin stays open,
 * needed to pipe file content in for a write) and `--user limits.user` (the
 * SAME fixed non-root uid `execInSandbox` runs the real command as — unlike
 * `buildScopePrimingArgs`, there is no ownership mismatch to bypass here,
 * only content to move across the boundary `execInSandbox` already
 * crosses). `sh -c` is required to get `mkdir -p` + a redirect (for a write)
 * or a single fixed read in one process, but the script text is entirely
 * fixed by this module — never model input — and the one variable part, the
 * in-scope path, is passed as `sh`'s own `$1` positional parameter after the
 * script (the `sh "$containerPath"` at the end), never interpolated into the
 * script string itself, so it cannot smuggle a second command regardless of
 * its content. File content for a write travels over stdin, never through
 * argv, so it is not subject to argv length or shell-escaping limits either.
 */
export function buildFileIoArgs(params: {
  containerName: string;
  scopePath: string;
  limits: SandboxLimits;
  script: string;
  containerPath: string;
}): string[] {
  const { containerName, scopePath, limits, script, containerPath } = params;
  const network =
    limits.networkMode === 'allowlist' ? resolveAllowlistNetworkName() : 'none';

  return [
    'run',
    '--rm',
    '-i',
    '--name',
    containerName,
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    limits.user,
    '--memory',
    `${limits.memoryMb}m`,
    '--memory-swap',
    `${limits.memoryMb}m`,
    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(limits.pidsLimit),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '-v',
    `${scopePath}:/workspace`,
    '-w',
    '/workspace',
    limits.image,
    'sh',
    '-c',
    script,
    'sh',
    containerPath,
  ];
}

export interface SandboxFileResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  reason?: string;
}

async function runFileIoContainer(
  script: string,
  session: SandboxSession,
  relPath: string,
  opts: { input?: string; maxOutputBytes?: number } = {}
): Promise<SandboxFileResult> {
  const limits = resolveSandboxLimits();
  // See `ensureScopeWritable`'s doc: the priming step, and this function,
  // both have to resolve `-v <scopePath>:/workspace` through the SAME
  // `docker run` path the real sandboxed command uses — a host-side `fs`
  // call cannot substitute for either.
  await ensureScopeWritable(session, limits);
  const containerName = `ci-sbx-io-${randomUUID()}`;
  const args = buildFileIoArgs({
    containerName,
    scopePath: session.scopePath,
    limits,
    script,
    containerPath: toContainerPath(relPath),
  });
  try {
    const result = await runHostProcess('docker', args, limits.timeoutMs, {
      input: opts.input,
      maxOutputBytes: opts.maxOutputBytes ?? limits.maxOutputBytes,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      reason:
        result.exitCode === 0
          ? undefined
          : result.stderr.trim() || `Sandbox file operation exited with code ${result.exitCode}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr: '', truncated: false, reason: message };
  } finally {
    void runHostProcess('docker', ['rm', '-f', containerName], 10_000).catch(() => undefined);
  }
}

/**
 * Write `content` to `relPath` inside the session's scope — through Docker,
 * never through `fs.writeFile` against `session.scopePath` directly. See the
 * module header and `ensureScopeWritable` for why: on this project's actual
 * CI runner, the API process's own filesystem view of `session.scopePath`
 * and the Docker daemon's view of the identical `-v` mount argument are not
 * guaranteed to be the same directory.
 */
export async function writeFileInSandbox(
  session: SandboxSession,
  relPath: string,
  content: string
): Promise<SandboxFileResult> {
  return runFileIoContainer(
    'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
    session,
    relPath,
    { input: content }
  );
}

/** Read `relPath` from inside the session's scope — through Docker; see `writeFileInSandbox`. */
export async function readFileInSandbox(
  session: SandboxSession,
  relPath: string
): Promise<SandboxFileResult> {
  return runFileIoContainer('cat -- "$1"', session, relPath);
}

/**
 * List `relPath` (a directory) inside the session's scope — through Docker;
 * see `writeFileInSandbox`. `ls -1p` appends a trailing `/` to directory
 * entries so the caller can tell them apart from files without a second
 * round trip.
 */
export async function listFilesInSandbox(
  session: SandboxSession,
  relPath: string
): Promise<SandboxFileResult> {
  return runFileIoContainer('ls -1p -- "$1"', session, relPath);
}

/**
 * Execute one command inside an ephemeral container.
 *
 * Never throws for policy or runtime failures — every path returns a typed
 * terminal result and writes an audit record, so a refusal is a value the
 * caller renders rather than an exception that unwinds an agent run.
 * `SandboxUnavailableError` is the single exception, because "no isolation
 * available" must not be confusable with "the command failed".
 */
export async function execInSandbox(
  session: SandboxSession,
  command: string,
  args: readonly string[] = [],
  options: SandboxExecOptions = {}
): Promise<SandboxExecResult> {
  const limits = resolveSandboxLimits();
  const auditId = newAuditId();
  const started = Date.now();

  const audit = (
    outcome: SandboxOutcome,
    extra: Partial<Parameters<typeof recordSandboxExec>[0]> = {}
  ): void => {
    recordSandboxExec({
      auditId,
      sessionId: session.sessionId,
      runId: options.runId,
      stepIndex: options.stepIndex,
      command,
      args,
      scopePath: session.scopePath,
      limits,
      outcome,
      durationMs: Date.now() - started,
      organizationId: options.organizationId,
      userId: options.userId,
      ...extra,
    });
  };

  // ── Policy gate, BEFORE anything is spawned ──────────────────────────
  try {
    assertCommandAllowed(command);
    for (const arg of args) assertArgAllowed(arg);
  } catch (err) {
    if (err instanceof SandboxPolicyError) {
      audit('blocked', { violation: err.violation, reason: err.message });
      return {
        outcome: 'blocked',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        auditId,
        reason: err.message,
        truncated: false,
      };
    }
    throw err;
  }

  if (!(await isDockerAvailable())) {
    // Fail closed. Deliberately NOT a fallback to a host process.
    audit('error', { reason: 'docker_unavailable' });
    throw new SandboxUnavailableError(
      'Agentic sandbox requires a running Docker daemon; refusing to execute without isolation'
    );
  }

  // See `ensureScopeWritable` for why this cannot be done once up front in
  // `createSandboxSession`: it has to go through the same `docker run -v`
  // path resolution the real command below uses, which this process cannot
  // do purely on the host side.
  await ensureScopeWritable(session, limits);

  const timeoutMs = Math.min(
    limits.timeoutMs,
    options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : limits.timeoutMs
  );
  const containerName = `ci-sbx-${auditId}`;
  const dockerArgs = buildDockerArgs({
    containerName,
    scopePath: session.scopePath,
    limits,
    command,
    args,
  });

  let killedByUs = false;
  try {
    const result = await runHostProcess('docker', dockerArgs, timeoutMs, {
      maxOutputBytes: limits.maxOutputBytes,
      onTimeout: () => {
        killedByUs = true;
        // Kill the CONTAINER, not just the local `docker run` client: killing
        // the client alone can leave the container running and holding the
        // scope directory. Best-effort and detached — the outer promise has
        // already resolved as `timeout` by the time this lands.
        void runHostProcess('docker', ['kill', containerName], 10_000).catch(() => undefined);
      },
    });

    const durationMs = Date.now() - started;

    if (result.timedOut) {
      audit('timeout', {
        exitCode: result.exitCode,
        reason: `Execution exceeded ${timeoutMs}ms`,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        stdoutSha256: digest(result.stdout),
        stderrSha256: digest(result.stderr),
      });
      return {
        outcome: 'timeout',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        auditId,
        reason: `Execution exceeded the ${timeoutMs}ms sandbox timeout and was killed`,
        truncated: result.truncated,
      };
    }

    // 137 = SIGKILL. If we did not initiate it, the kernel OOM killer did —
    // a distinction worth keeping, because "the model asked for too much
    // memory" and "the model ran too long" need different operator responses.
    const outcome: SandboxOutcome =
      result.exitCode === 0 ? 'ok' : result.exitCode === 137 && !killedByUs ? 'oom' : 'error';

    audit(outcome, {
      exitCode: result.exitCode,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
      stdoutSha256: digest(result.stdout),
      stderrSha256: digest(result.stderr),
      reason: outcome === 'oom' ? 'Container exceeded its memory limit' : undefined,
    });

    return {
      outcome,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
      auditId,
      reason:
        outcome === 'oom'
          ? 'Container exceeded its memory limit and was killed'
          : outcome === 'error'
            ? `Command exited with code ${result.exitCode}`
            : undefined,
      truncated: result.truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit('error', { reason: message });
    return {
      outcome: 'error',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      auditId,
      reason: message,
      truncated: false,
    };
  } finally {
    // `--rm` normally suffices; this covers the timeout path and any case
    // where the client died before the daemon cleaned up.
    void runHostProcess('docker', ['rm', '-f', containerName], 10_000).catch(() => undefined);
  }
}

// ── Host process helper ───────────────────────────────────────────────────

interface HostProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Run a HOST process (always the `docker` CLI — never user-supplied code) with
 * a hard timeout and bounded output buffers.
 *
 * Output is capped while streaming rather than after the fact, so a command
 * emitting gigabytes cannot exhaust the API process's heap before the
 * container's own limits stop it.
 */
function runHostProcess(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
  opts: { maxOutputBytes?: number; onTimeout?: () => void; input?: string } = {}
): Promise<HostProcessResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? 1_000_000;

  return new Promise<HostProcessResult>((resolvePromise, rejectPromise) => {
    // `shell: false` (the default) is load-bearing: argv elements reach the
    // program verbatim, so shell metacharacters in a model-supplied argument
    // are literal text and cannot become command separators.
    //
    // stdin is only opened (`'pipe'`) when the caller has content to send —
    // `writeFileInSandbox` pipes file content to `docker run -i … cat > …`
    // this way, so that content never has to pass through argv (no length
    // limit, no shell-escaping concerns). Every other caller keeps stdin
    // `'ignore'`d, matching the previous behaviour exactly.
    const child = spawn(cmd, [...args], {
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (opts.input !== undefined) {
      // A container that exits before reading all of stdin (e.g. because the
      // fixed write/read script itself failed) closes the pipe from its end,
      // which would otherwise surface as an unhandled EPIPE `error` event.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(opts.input, 'utf8');
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const append = (target: 'out' | 'err', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (target === 'out') {
        if (Buffer.byteLength(stdout) >= maxOutputBytes) {
          truncated = true;
          return;
        }
        stdout += text;
        if (Buffer.byteLength(stdout) > maxOutputBytes) {
          stdout = stdout.slice(0, maxOutputBytes);
          truncated = true;
        }
      } else {
        if (Buffer.byteLength(stderr) >= maxOutputBytes) {
          truncated = true;
          return;
        }
        stderr += text;
        if (Buffer.byteLength(stderr) > maxOutputBytes) {
          stderr = stderr.slice(0, maxOutputBytes);
          truncated = true;
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      opts.onTimeout?.();
      child.kill('SIGKILL');
      // Resolve rather than reject: a timeout is a normal, expected terminal
      // outcome for a sandboxed action, not an exceptional condition.
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: null, timedOut: true, truncated });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code, timedOut, truncated });
    });
  });
}
