// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Sandbox / agent audit trail (ADR-024 §5).
 *
 * The requirement is reconstruction: for any action the system took, it must
 * be possible to say afterwards exactly WHAT ran, WHEN, under WHICH limits,
 * and WITH WHAT RESULT. Two design points follow from that:
 *
 * 1. **Refusals are recorded as loudly as executions.** An attempted escape
 *    that is blocked produces an audit record and bumps
 *    `sandbox_policy_violation_total`. A sandbox that silently refuses is
 *    indistinguishable, in the logs, from one that was never attacked.
 *
 * 2. **Output is recorded by size + digest, not verbatim.** stdout from a
 *    model-directed command is untrusted, potentially huge, and potentially
 *    sensitive; copying it wholesale into the audit log would turn the log
 *    into the exfiltration sink the sandbox exists to prevent. A SHA-256
 *    digest still lets an investigator prove that two runs produced identical
 *    output, or match a sample against a recorded run.
 *
 * Transport is the project's existing pino logger plus the operability
 * metrics module — no new observability substrate.
 */

import { createHash, randomUUID } from 'node:crypto';
import { incrementCounter, observeHistogram, METRIC_NAMES } from '@/core/operability/metrics';
import { logger } from '@/utils/logger';
import type { PolicyViolation, SandboxLimits } from './sandbox-policy';

const log = logger.child({ component: 'sandbox-audit' });

/** Terminal classification of a sandbox execution. */
export type SandboxOutcome = 'ok' | 'blocked' | 'timeout' | 'error' | 'oom';

export interface SandboxAuditRecord {
  /** Unique id for this single action. */
  auditId: string;
  /** Sandbox session (one scope directory) this action belonged to. */
  sessionId: string;
  /** Agent run id, when the action came from the agent loop. */
  runId?: string;
  /** Zero-based step index within an agent run. */
  stepIndex?: number;
  /** The exact program that was asked for. */
  command: string;
  /** The exact argv that was asked for, unmodified. */
  args: readonly string[];
  /** Host path of the writable scope directory. */
  scopePath: string;
  /** The limits actually in force for this execution. */
  limits: SandboxLimits;
  outcome: SandboxOutcome;
  /** Set when `outcome === 'blocked'`. */
  violation?: PolicyViolation;
  exitCode?: number | null;
  durationMs: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  organizationId?: string;
  userId?: string;
  /** Human-readable reason, for blocked/error outcomes. */
  reason?: string;
}

/** SHA-256 hex digest, used so output can be correlated without being stored. */
export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newAuditId(): string {
  return randomUUID();
}

/**
 * Emit one audit record for a completed (or refused) sandbox execution.
 *
 * Emits at `info` for normal outcomes and `warn` for `blocked`, so a policy
 * refusal surfaces in a deployment whose log level hides routine traffic.
 */
export function recordSandboxExec(record: SandboxAuditRecord): void {
  const payload = {
    event: 'sandbox.exec',
    auditId: record.auditId,
    sessionId: record.sessionId,
    runId: record.runId,
    stepIndex: record.stepIndex,
    command: record.command,
    args: record.args,
    scopePath: record.scopePath,
    networkMode: record.limits.networkMode,
    limits: {
      timeoutMs: record.limits.timeoutMs,
      memoryMb: record.limits.memoryMb,
      cpus: record.limits.cpus,
      pidsLimit: record.limits.pidsLimit,
      image: record.limits.image,
      user: record.limits.user,
    },
    outcome: record.outcome,
    violation: record.violation,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    stdoutBytes: record.stdoutBytes,
    stderrBytes: record.stderrBytes,
    stdoutSha256: record.stdoutSha256,
    stderrSha256: record.stderrSha256,
    organizationId: record.organizationId,
    userId: record.userId,
    reason: record.reason,
  };

  if (record.outcome === 'blocked') {
    log.warn(payload, 'sandbox.exec blocked by policy');
  } else {
    log.info(payload, 'sandbox.exec');
  }

  incrementCounter(
    METRIC_NAMES.SANDBOX_EXEC_TOTAL,
    { outcome: record.outcome, networkMode: record.limits.networkMode },
    { log: false }
  );
  observeHistogram(METRIC_NAMES.SANDBOX_EXEC_DURATION_MS, record.durationMs, {
    outcome: record.outcome,
  });
  if (record.violation) {
    incrementCounter(
      METRIC_NAMES.SANDBOX_POLICY_VIOLATION_TOTAL,
      { violation: record.violation },
      { log: false }
    );
  }
}

/** Terminal reason an agent run stopped. */
export type AgentStopReason = 'success' | 'max_steps_reached' | 'timeout' | 'error' | 'disabled';

export interface AgentStepAuditRecord {
  runId: string;
  stepIndex: number;
  /** Model id chosen DYNAMICALLY for this step — recorded, never pinned. */
  modelId?: string;
  toolName?: string;
  outcome: 'ok' | 'tool_error' | 'model_error' | 'blocked';
  durationMs: number;
  organizationId?: string;
  userId?: string;
  reason?: string;
}

export function recordAgentStep(record: AgentStepAuditRecord): void {
  log.info({ event: 'agent.step', ...record }, 'agent.step');
  incrementCounter(METRIC_NAMES.AGENT_STEP_TOTAL, { outcome: record.outcome }, { log: false });
}

export function recordAgentRun(params: {
  runId: string;
  stopReason: AgentStopReason;
  steps: number;
  durationMs: number;
  organizationId?: string;
  userId?: string;
}): void {
  log.info({ event: 'agent.run', ...params }, 'agent.run');
  incrementCounter(METRIC_NAMES.AGENT_RUN_TOTAL, { stopReason: params.stopReason }, { log: false });
}
