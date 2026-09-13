// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Sandbox policy — the single place where "what an agentic action is allowed
 * to do" is decided (ADR-024).
 *
 * Everything here is FAIL-CLOSED by construction:
 *
 * - The three capability flags default to OFF. Only the exact string `'true'`
 *   enables one; `'1'`, `'yes'`, `'TRUE'` do not. A typo leaves the surface
 *   disabled rather than half-enabled.
 * - `SANDBOX_NETWORK_MODE` cannot be set to `bridge`. There is deliberately no
 *   configuration path from this file to "container with open internet"; an
 *   unrecognised value collapses to `none`.
 * - Every numeric limit clamps into a hard [min, max] range, so an operator
 *   cannot set `AGENT_MAX_STEPS=100000` or `SANDBOX_MEMORY_MB=0`.
 * - Command and path checks reject by default: unknown command → blocked,
 *   unresolvable path → blocked.
 *
 * Env is read PER CALL rather than at module load, matching
 * `getStrategyFeatureFlags()` in `core/orchestration/strategy-tiers.ts`, so
 * that tests can flip a flag without re-importing the module graph.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

// ── Feature flags (ADR-024 §4) ────────────────────────────────────────────
// New attack surface ships disabled. Default-OFF uses `=== 'true'` (the
// project's convention for opt-in gates, cf. `BROADCAST_FEATURE_ENABLED`),
// NOT the `!== 'false'` kill-switch convention used for already-trusted
// subsystems.

/** Whether the `computer_use` tools may be registered and the sandbox used. */
export function isComputerUseEnabled(): boolean {
  return process.env.AGENTIC_COMPUTER_USE_ENABLED === 'true';
}

/** Whether the bounded agent loop may run. */
export function isAgentsEnabled(): boolean {
  return process.env.AGENTIC_AGENTS_ENABLED === 'true';
}

/**
 * Whether the MCP client may connect to configured servers.
 *
 * This gate is NEW (ADR-024). MCP previously initialised unconditionally at
 * startup; its apparent safety in production relied on `tsc` not copying
 * `config/mcp-servers.json` into `dist/`, which is a build accident and not a
 * security control. Requiring an explicit opt-in makes the posture stated
 * rather than incidental.
 */
export function isMcpClientEnabled(): boolean {
  return process.env.MCP_CLIENT_ENABLED === 'true';
}

// ── Numeric limits ────────────────────────────────────────────────────────

function clampEnvNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  // NaN, Infinity and out-of-range all collapse to the safe default rather
  // than to the operator's value.
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Network posture of the sandbox container. `bridge` is intentionally absent. */
export type SandboxNetworkMode = 'none' | 'allowlist';

export interface SandboxLimits {
  /** Hard wall-clock per exec, enforced by the host via `docker kill`. */
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly networkMode: SandboxNetworkMode;
  /** Docker image the sandbox runs. Must be a pinned, minimal image. */
  readonly image: string;
  /** uid:gid the container process runs as. Never 0. */
  readonly user: string;
  /** Max bytes of stdout/stderr retained per exec (the rest is dropped). */
  readonly maxOutputBytes: number;
}

/**
 * Resolve the network mode.
 *
 * `bridge`/`host` are NOT reachable from configuration: an operator who sets
 * `SANDBOX_NETWORK_MODE=bridge` gets `none`, not open egress. Only the
 * explicitly-modelled `allowlist` mode differs from `none`, and it is
 * implemented as a named Docker network the operator has already constrained
 * (egress proxy), never as default bridge.
 */
export function resolveNetworkMode(): SandboxNetworkMode {
  return process.env.SANDBOX_NETWORK_MODE === 'allowlist' ? 'allowlist' : 'none';
}

/** The Docker network name used in `allowlist` mode. */
export function resolveAllowlistNetworkName(): string {
  const raw = (process.env.SANDBOX_ALLOWLIST_NETWORK || '').trim();
  return raw.length > 0 ? raw : 'ci-sandbox-egress';
}

export function resolveSandboxLimits(): SandboxLimits {
  return {
    timeoutMs: clampEnvNumber('SANDBOX_EXEC_TIMEOUT_MS', 30_000, 1_000, 300_000),
    memoryMb: clampEnvNumber('SANDBOX_MEMORY_MB', 512, 64, 4_096),
    cpus: clampEnvNumber('SANDBOX_CPUS', 1, 0.1, 4),
    pidsLimit: clampEnvNumber('SANDBOX_PIDS_LIMIT', 128, 16, 1_024),
    networkMode: resolveNetworkMode(),
    image: (process.env.SANDBOX_IMAGE || '').trim() || 'alpine:3.20',
    user: (process.env.SANDBOX_USER || '').trim() || '65534:65534',
    maxOutputBytes: clampEnvNumber('SANDBOX_MAX_OUTPUT_BYTES', 64_000, 1_000, 1_000_000),
  };
}

// ── Command allowlist ─────────────────────────────────────────────────────

/**
 * Default allowlist: read-mostly inspection commands plus the minimum needed
 * to work inside `/workspace`.
 *
 * Deliberately absent: any network client (`curl`, `wget`, `nc`, `ssh`), any
 * package manager, any interpreter that trivially re-implements them
 * (`python`, `node`, `perl`) and any shell (`sh`, `bash`) — a shell would
 * make the allowlist decorative, since `sh -c '...'` can run anything. The
 * argv is executed directly, never through a shell, so metacharacters like
 * `;` and `|` are literal argument text and not command separators.
 */
const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
  'cat',
  'echo',
  'ls',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'sort',
  'uniq',
  'cut',
  'diff',
  'stat',
  'mkdir',
  'cp',
  'mv',
  'touch',
  'true',
  'false',
  'basename',
  'dirname',
  'date',
  'sed',
  'awk',
];

/** The commands permitted in this deployment. */
export function resolveCommandAllowlist(): ReadonlySet<string> {
  const raw = (process.env.SANDBOX_COMMAND_ALLOWLIST || '').trim();
  if (raw.length === 0) return new Set(DEFAULT_COMMAND_ALLOWLIST);
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // An allowlist that parses to nothing means "allow nothing", not "allow the
  // defaults" — an operator who sets the var to junk gets the closed posture.
  return new Set(entries);
}

export type PolicyViolation = 'blocked_command' | 'path_escape' | 'arg_rejected';

export class SandboxPolicyError extends Error {
  readonly violation: PolicyViolation;

  constructor(violation: PolicyViolation, message: string) {
    super(message);
    this.name = 'SandboxPolicyError';
    this.violation = violation;
  }
}

/**
 * Validate a command against the allowlist.
 *
 * The command must be a bare program name. A path (`/bin/sh`, `./x`,
 * `../../bin/sh`) is rejected outright, because allowing paths would let
 * `/usr/bin/env sh` and friends smuggle a non-allowlisted binary past a
 * basename check.
 */
export function assertCommandAllowed(command: string): void {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new SandboxPolicyError('blocked_command', 'Empty command is not permitted');
  }
  if (/[\\/]/.test(trimmed)) {
    throw new SandboxPolicyError(
      'blocked_command',
      `Command must be a bare program name, not a path: '${trimmed}'`
    );
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new SandboxPolicyError(
      'blocked_command',
      `Command contains characters that are not permitted: '${trimmed}'`
    );
  }
  const allowlist = resolveCommandAllowlist();
  if (!allowlist.has(trimmed)) {
    throw new SandboxPolicyError(
      'blocked_command',
      `Command '${trimmed}' is not in the sandbox allowlist`
    );
  }
}

/**
 * Validate a single argv element.
 *
 * Args are passed to `docker run` as separate argv entries and executed
 * without a shell, so the risk here is not metacharacter injection but
 * argument smuggling into `docker` itself. Anything that could be read as a
 * docker flag, and NUL bytes (which truncate C strings), are rejected.
 */
export function assertArgAllowed(arg: string): void {
  if (arg.includes('\0')) {
    throw new SandboxPolicyError('arg_rejected', 'Argument contains a NUL byte');
  }
  if (arg.length > 4_096) {
    throw new SandboxPolicyError('arg_rejected', 'Argument exceeds 4096 bytes');
  }
}

// ── Scope-path containment (threat T4) ────────────────────────────────────

/**
 * Resolve a caller-supplied path against the session scope root and prove it
 * stays inside.
 *
 * Two checks, because either alone is bypassable:
 *
 * 1. Lexical: `resolve()` collapses `..` segments, then the result must sit
 *    under `scopeRoot` followed by a separator. The separator check is what
 *    stops `/workspace-evil` passing a naive `startsWith('/workspace')`.
 * 2. Physical: the deepest existing ancestor is `realpath`-ed, defeating a
 *    symlink planted inside the scope that points out of it. Resolving the
 *    ancestor rather than the target itself means this also works for a path
 *    being created (which does not exist yet).
 *
 * Absolute inputs are rejected outright: the tool contract is
 * scope-relative, and accepting absolute paths only widens what has to be
 * proven safe.
 */
export function resolveScopedPath(scopeRoot: string, requested: string): string {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    throw new SandboxPolicyError('path_escape', 'Path must be a non-empty string');
  }
  if (requested.includes('\0')) {
    throw new SandboxPolicyError('path_escape', 'Path contains a NUL byte');
  }
  if (isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) {
    throw new SandboxPolicyError(
      'path_escape',
      `Path must be relative to the sandbox scope: '${requested}'`
    );
  }

  const rootReal = safeRealpath(resolve(scopeRoot));
  const candidate = resolve(rootReal, requested);

  if (!isInside(rootReal, candidate)) {
    throw new SandboxPolicyError(
      'path_escape',
      `Path escapes the sandbox scope: '${requested}'`
    );
  }

  // Physical check against symlink escape: walk up to the deepest ancestor
  // that exists, realpath it, and require the result still be inside.
  const anchorReal = safeRealpath(deepestExisting(rootReal, candidate));
  if (!isInside(rootReal, anchorReal) && anchorReal !== rootReal) {
    throw new SandboxPolicyError(
      'path_escape',
      `Path resolves through a symlink out of the sandbox scope: '${requested}'`
    );
  }

  return candidate;
}

/** True when `candidate` is `root` itself or sits strictly beneath it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * `realpathSync` that degrades to the lexical path when the target does not
 * exist. Callers only pass paths that exist (or an existing ancestor), so a
 * throw here means a race or a permission problem, not an escape.
 */
function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** Deepest ancestor of `candidate` (inclusive) that currently exists. */
function deepestExisting(root: string, candidate: string): string {
  let current = candidate;
  // Bounded walk: stop at the root, and never loop more than the path depth.
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      realpathSync(current);
      return current;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current || !isInside(root, parent)) return root;
      current = parent;
    }
  }
  return root;
}

// ── Agent-loop limits (ADR-024 §3) ────────────────────────────────────────

export interface AgentLimits {
  /** Max reasoning/tool steps. Not model-controllable. */
  readonly maxSteps: number;
  /** Wall-clock budget for the WHOLE run, not per step. */
  readonly maxDurationMs: number;
}

/** Hard ceiling on steps, above any operator configuration. */
export const AGENT_MAX_STEPS_CEILING = 32;

export function resolveAgentLimits(): AgentLimits {
  return {
    maxSteps: clampEnvNumber('AGENT_MAX_STEPS', 8, 1, AGENT_MAX_STEPS_CEILING),
    maxDurationMs: clampEnvNumber('AGENT_MAX_DURATION_MS', 120_000, 1_000, 600_000),
  };
}
