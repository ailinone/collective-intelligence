// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `computer_use` — the tool surface (ADR-024).
 *
 * SCOPE, stated plainly: this is SYSTEM control (allowlisted shell commands
 * plus file I/O confined to one directory), not GUI control. The ontology
 * aliases `gui_control` / `browser_use` are NOT satisfied by this module.
 * Screenshots, clicks and keyboard synthesis need a sandboxed headless
 * browser, which is a materially larger attack surface (GPU/DRM access, a
 * second network stack, font and codec parsers) and cannot honestly be
 * shipped in the same change that establishes the isolation floor.
 *
 * Every tool here executes inside the ephemeral container from
 * `container-sandbox.ts`. None of them can reach the network while
 * `SANDBOX_NETWORK_MODE` is `none` (the default). File content in
 * particular never touches the API host's filesystem at all — the write/
 * read/list tools move bytes through Docker
 * (`writeFileInSandbox`/`readFileInSandbox`/`listFilesInSandbox`), not
 * `node:fs` against the scope directory, because on this project's actual CI
 * runner the API host process and a container mounting the identical scope
 * path do not reliably see the same files there (see `container-sandbox.ts`
 * for the full story). `resolveScopedPath` still runs first and still is a
 * host-side check — it is proving a REQUESTED PATH cannot escape the scope
 * before any container starts, which needs no agreement with what a
 * container sees, not reading or writing scope content.
 *
 * Registration is gated on `AGENTIC_COMPUTER_USE_ENABLED === 'true'`. With the
 * flag off, `registerComputerUseTools()` registers nothing at all — the tools
 * do not exist in the registry, so the model cannot see them, the triage LLM
 * cannot attach them, and no strategy can call them.
 */

import { isAbsolute, relative, sep } from 'node:path';
import type { ToolRegistration } from '@/core/tools/tool-registry';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { ToolResult, ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import { logger } from '@/utils/logger';
import {
  execInSandbox,
  listFilesInSandbox,
  readFileInSandbox,
  writeFileInSandbox,
  SandboxUnavailableError,
} from './container-sandbox';
import { acquireSession } from './sandbox-session-manager';
import {
  isComputerUseEnabled,
  resolveCommandAllowlist,
  resolveScopedPath,
  SandboxPolicyError,
} from './sandbox-policy';
import { newAuditId, recordSandboxExec } from './sandbox-audit';
import { resolveSandboxLimits } from './sandbox-policy';

const log = logger.child({ component: 'computer-use-tools' });

/** Guard so repeated bootstraps do not re-register. */
let registered = false;

/** Test-only: allow a suite to re-run registration. */
export function __resetComputerUseRegistrationForTest(): void {
  registered = false;
}

function ok(toolCallId: string, output: string, metadata?: Record<string, unknown>): ToolResult {
  return { tool_call_id: toolCallId, success: true, output, metadata };
}

function fail(toolCallId: string, error: string, metadata?: Record<string, unknown>): ToolResult {
  return { tool_call_id: toolCallId, success: false, error, metadata };
}

/**
 * Audit a refusal that happened in a file tool, before any container ran.
 *
 * File tools resolve paths on the host, so a `path_escape` can be caught
 * without spawning anything. It still has to reach the audit trail and bump
 * `sandbox_policy_violation_total` — a blocked escape that leaves no trace is
 * the failure mode this whole module exists to avoid.
 */
function auditPathRefusal(params: {
  sessionId: string;
  scopePath: string;
  tool: string;
  requestedPath: string;
  err: SandboxPolicyError;
  context: ToolExecutionContext;
}): void {
  recordSandboxExec({
    auditId: newAuditId(),
    sessionId: params.sessionId,
    command: params.tool,
    args: [params.requestedPath],
    scopePath: params.scopePath,
    limits: resolveSandboxLimits(),
    outcome: 'blocked',
    violation: params.err.violation,
    durationMs: 0,
    reason: params.err.message,
    organizationId: params.context.organizationId,
    userId: params.context.userId,
  });
}

function scopeKeyFrom(context: ToolExecutionContext): {
  organizationId?: string;
  userId?: string;
} {
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Validate a caller-supplied path (host-side, via `resolveScopedPath`) and
 * return it relative to the scope root, for handing to
 * `writeFileInSandbox`/`readFileInSandbox`/`listFilesInSandbox`.
 *
 * The absolute path `resolveScopedPath` resolves to is intentionally NOT
 * used to touch the filesystem directly (see `container-sandbox.ts`'s module
 * header on why): it exists here purely to prove the request cannot escape
 * the scope BEFORE any container runs, exactly as before. Once proven safe,
 * only the relative portion crosses into the container-side helpers, which
 * re-root it under `/workspace` themselves.
 *
 * `resolveScopedPath` proves containment against the REALPATH of
 * `session.scopePath` (defeating a symlink escape); re-deriving a path
 * relative to the RAW `session.scopePath` — the string actually passed to
 * `docker run -v` — is equivalent whenever the two agree, which they always
 * do for a directory this module creates itself with `mkdtemp`. The `..`
 * check below is defense in depth for the one case they would not: a
 * temp-dir root that is itself a symlink.
 */
function resolveInScopePath(
  session: { scopePath: string },
  requested: string
): string {
  const absolute = resolveScopedPath(session.scopePath, requested);
  const rel = relative(session.scopePath, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SandboxPolicyError(
      'path_escape',
      `Path escapes the sandbox scope: '${requested}'`
    );
  }
  return rel;
}

/** Map a sandbox exec result onto a ToolResult. */
function resultFromExec(
  toolCallId: string,
  exec: Awaited<ReturnType<typeof execInSandbox>>
): ToolResult {
  const metadata = {
    auditId: exec.auditId,
    outcome: exec.outcome,
    exitCode: exec.exitCode,
    durationMs: exec.durationMs,
    truncated: exec.truncated,
  };
  if (exec.outcome === 'ok') {
    return ok(toolCallId, exec.stdout, metadata);
  }
  const detail = exec.stderr.trim() || exec.stdout.trim();
  return fail(
    toolCallId,
    `${exec.reason ?? `Sandbox execution ${exec.outcome}`}${detail ? `: ${detail}` : ''}`,
    metadata
  );
}

/** Wrap a handler so `SandboxUnavailableError` becomes a clean tool failure. */
async function guarded(
  toolCallId: string,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SandboxUnavailableError) {
      // Fail closed and SAY SO. The caller must not read this as "the command
      // failed" and retry somewhere less isolated.
      return fail(toolCallId, `computer_use is unavailable: ${err.message}`, {
        outcome: 'unavailable',
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'computer_use tool failed');
    return fail(toolCallId, message);
  }
}

/**
 * The tool registrations.
 *
 * All four are `safeForStrategies: true` (they are sandboxed, which is the
 * bar the registry sets for strategy use) but `autoRecommendable: false` —
 * the triage LLM must never attach system control to a request that did not
 * ask for it. `category: 'code'` puts them outside
 * `AUTO_RECOMMENDABLE_CATEGORIES` already; the explicit `false` states the
 * intent so a future category change cannot silently opt them in.
 */
export function buildComputerUseRegistrations(): ToolRegistration[] {
  return [
    {
      name: 'computer_shell',
      description:
        'Run an allowlisted, non-interactive command inside an isolated container. ' +
        'No network access. The only writable location is the /workspace scope directory. ' +
        'The command must be a bare program name; arguments are passed verbatim without a shell.',
      category: 'code',
      safeForStrategies: true,
      autoRecommendable: false,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: `Program to run. Allowed: ${[...resolveCommandAllowlist()].sort().join(', ')}`,
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments passed verbatim (no shell interpretation).',
          },
        },
        required: ['command'],
      },
      handler: async (args, toolCallId, context) =>
        guarded(toolCallId, async () => {
          const command = typeof args.command === 'string' ? args.command : '';
          const rawArgs = Array.isArray(args.args) ? args.args : [];
          const argv = rawArgs.map((entry) => String(entry));
          const session = await acquireSession(scopeKeyFrom(context));
          const exec = await execInSandbox(session, command, argv, {
            organizationId: context.organizationId,
            userId: context.userId,
          });
          return resultFromExec(toolCallId, exec);
        }),
    },
    {
      name: 'computer_write_file',
      description:
        'Write a UTF-8 text file inside the sandbox scope directory. ' +
        'The path must be relative and cannot escape the scope.',
      category: 'code',
      safeForStrategies: true,
      autoRecommendable: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the scope root.' },
          content: { type: 'string', description: 'File content (UTF-8).' },
        },
        required: ['path', 'content'],
      },
      handler: async (args, toolCallId, context) =>
        guarded(toolCallId, async () => {
          const session = await acquireSession(scopeKeyFrom(context));
          const requested = typeof args.path === 'string' ? args.path : '';
          const content = typeof args.content === 'string' ? args.content : '';
          let inScopePath: string;
          try {
            inScopePath = resolveInScopePath(session, requested);
          } catch (err) {
            if (err instanceof SandboxPolicyError) {
              auditPathRefusal({
                sessionId: session.sessionId,
                scopePath: session.scopePath,
                tool: 'computer_write_file',
                requestedPath: requested,
                err,
                context,
              });
              return fail(toolCallId, err.message, { violation: err.violation });
            }
            throw err;
          }
          const result = await writeFileInSandbox(session, inScopePath, content);
          if (!result.ok) {
            return fail(toolCallId, result.reason ?? 'Sandbox write failed');
          }
          return ok(toolCallId, `Wrote ${Buffer.byteLength(content)} bytes to ${requested}`);
        }),
    },
    {
      name: 'computer_read_file',
      description: 'Read a UTF-8 text file from the sandbox scope directory.',
      category: 'code',
      safeForStrategies: true,
      autoRecommendable: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the scope root.' },
        },
        required: ['path'],
      },
      handler: async (args, toolCallId, context) =>
        guarded(toolCallId, async () => {
          const session = await acquireSession(scopeKeyFrom(context));
          const requested = typeof args.path === 'string' ? args.path : '';
          let inScopePath: string;
          try {
            inScopePath = resolveInScopePath(session, requested);
          } catch (err) {
            if (err instanceof SandboxPolicyError) {
              auditPathRefusal({
                sessionId: session.sessionId,
                scopePath: session.scopePath,
                tool: 'computer_read_file',
                requestedPath: requested,
                err,
                context,
              });
              return fail(toolCallId, err.message, { violation: err.violation });
            }
            throw err;
          }
          const result = await readFileInSandbox(session, inScopePath);
          if (!result.ok) {
            return fail(toolCallId, result.reason ?? 'Sandbox read failed');
          }
          return ok(toolCallId, result.stdout, { truncated: result.truncated });
        }),
    },
    {
      name: 'computer_list_files',
      description: 'List entries in a directory inside the sandbox scope.',
      category: 'code',
      safeForStrategies: true,
      autoRecommendable: false,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory relative to the scope root. Defaults to the root.',
          },
        },
      },
      handler: async (args, toolCallId, context) =>
        guarded(toolCallId, async () => {
          const session = await acquireSession(scopeKeyFrom(context));
          const requested = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
          let inScopePath: string;
          try {
            inScopePath = resolveInScopePath(session, requested);
          } catch (err) {
            if (err instanceof SandboxPolicyError) {
              auditPathRefusal({
                sessionId: session.sessionId,
                scopePath: session.scopePath,
                tool: 'computer_list_files',
                requestedPath: requested,
                err,
                context,
              });
              return fail(toolCallId, err.message, { violation: err.violation });
            }
            throw err;
          }
          const result = await listFilesInSandbox(session, inScopePath);
          if (!result.ok) {
            return fail(toolCallId, result.reason ?? 'Sandbox list failed');
          }
          // `ls -1p` (run inside listFilesInSandbox) appends `/` to directory
          // entries; translate that back into the tool's existing
          // `dir `/`file ` prefix format so callers see no shape change.
          const listing = result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((entry) =>
              entry.endsWith('/') ? `dir  ${entry.slice(0, -1)}` : `file ${entry}`
            )
            .join('\n');
          return ok(toolCallId, listing || '(empty)');
        }),
    },
  ];
}

/**
 * Register the `computer_use` tools — ONLY when the capability is enabled.
 *
 * Idempotent, and safe to call unconditionally at bootstrap: the flag check
 * lives here so callers do not each have to remember it.
 */
export function registerComputerUseTools(): void {
  if (registered) return;
  if (!isComputerUseEnabled()) {
    log.info(
      'computer_use disabled (set AGENTIC_COMPUTER_USE_ENABLED=true to enable) — no tools registered'
    );
    return;
  }
  const registrations = buildComputerUseRegistrations();
  toolRegistry.registerAll(registrations);
  registered = true;
  log.warn(
    { tools: registrations.map((entry) => entry.name) },
    'computer_use ENABLED — sandboxed system-control tools registered'
  );
}
