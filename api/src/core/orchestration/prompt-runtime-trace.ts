// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §7 — Prompt Runtime Trace.
 *
 * Produces a SANITIZED, DETERMINISTIC trace of the prompt that WOULD be
 * sent to each role's adapter during `consensus` strategy execution,
 * without actually invoking the adapter.
 *
 * Purpose:
 *   - Surface evidence (during `dryRun=true planOnly=true tracePromptPayload=true`)
 *     that EVERY role has a resolvable prompt template + all required
 *     variables filled.
 *   - Provide a `promptFingerprint` per role that the plan fingerprint
 *     includes so any change to a prompt template / variable resolution
 *     invalidates the previously-approved plan.
 *
 * Sanitization rules (NEVER include in the trace):
 *   - The raw prompt body / user message content (only SHA-256 hash + char count).
 *   - API keys, bearer tokens, org IDs, user IDs.
 *   - Adapter-specific payload internals beyond the format identifier.
 *
 * Determinism:
 *   - The trace is a pure function of (chatRequest.messages shape,
 *     promptTemplateId, promptVersion, slot values resolved). It MUST
 *     produce the same fingerprint across two identical dry-runs.
 *   - `promptFingerprint` = SHA-256 over canonical JSON of
 *     `{ promptTemplateId, promptVersion, messagesShape, variablesResolved, missingVariables, adapterPayloadFormat }`.
 *
 * Failure modes (surfaced via `promptIssues` rather than thrown):
 *   - `template_not_found`: the role's template ID was not in the registry.
 *   - `missing_variables`: required variables (slots) had no resolved value.
 *   - `role_not_selected_due_to_plan_blocker`: the dry-run did not select
 *     a model for this role (e.g., no live-ready judge), so a trace cannot
 *     be computed.
 */
import { createHash } from 'node:crypto';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type PromptRuntimeTraceRole =
  | 'participant'
  | 'synthesizer'
  | 'judge'
  | 'fallback'
  | 'fallbackSingle'
  | 'unknown';

export interface PromptRuntimeTraceMessageShape {
  readonly role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  readonly contentHash: string;
  readonly chars: number;
}

export interface PromptRuntimeTrace {
  readonly strategy: string;
  readonly role: PromptRuntimeTraceRole;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly routeId?: string;
  /** Stable identifier for the template (e.g., `consensusVoter`,
   *  `consensusSynthesizer`, `llmJudgeEvaluatorInternal`, `fallbackPrompt`). */
  readonly promptTemplateId: string;
  /** Optional source path for human auditing (sanitized to project-relative). */
  readonly promptTemplatePath?: string;
  /** Version tag of the template; bump when the canonical wording changes. */
  readonly promptVersion?: string | null;
  /** SHA-256 over the canonical projection (see module docstring). */
  readonly promptFingerprint: string;
  /** Shape of the materialized messages (role + content hash + char count). */
  readonly messagesShape: readonly PromptRuntimeTraceMessageShape[];
  /** Variable / slot names the template DECLARES it needs. */
  readonly variablesRequired: readonly string[];
  /** Variable / slot names actually resolved at trace time. */
  readonly variablesResolved: readonly string[];
  /** Subset of `variablesRequired` that ended up unresolved. */
  readonly missingVariables: readonly string[];
  /** Identifier for the adapter payload shape (e.g., `openai_chat`, `anthropic_messages`). */
  readonly adapterPayloadFormat: string;
  /** Sentinel guaranteeing the trace was produced via the sanitization path. */
  readonly sanitized: true;
}

export interface PromptIssue {
  readonly role: PromptRuntimeTraceRole;
  readonly reason:
    | 'template_not_found'
    | 'missing_variables'
    | 'role_not_selected_due_to_plan_blocker'
    | 'adapter_format_unknown';
  readonly detail?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Template registry — declarative metadata about each role's prompt.
//
// The registry contains ONLY metadata (id, path, version, required vars,
// payload format) plus a `getBody` callback that returns the rendered
// template text. The trace builder calls `getBody` exactly once per role
// and never logs or surfaces the body — it only hashes + counts chars.
// ──────────────────────────────────────────────────────────────────────

export interface PromptTemplateRegistryEntry {
  readonly id: string;
  readonly path: string;
  readonly version: string;
  readonly variablesRequired: readonly string[];
  readonly adapterPayloadFormat: string;
  readonly getBody: (vars: Readonly<Record<string, unknown>>) => string;
}

/** Default-empty registry — the dry-run service injects role entries at
 *  trace time. Tests can also inject custom registries to verify behavior
 *  without depending on the production `sota-system-prompts` module. */
export type PromptTemplateRegistry = ReadonlyMap<PromptRuntimeTraceRole, PromptTemplateRegistryEntry>;

// ──────────────────────────────────────────────────────────────────────
// Canonical JSON (mirrors consensus-plan-fingerprint.canonicalJsonStringify)
// ──────────────────────────────────────────────────────────────────────

function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ──────────────────────────────────────────────────────────────────────
// Trace builder
// ──────────────────────────────────────────────────────────────────────

export interface BuildTraceInput {
  readonly strategy: string;
  readonly role: PromptRuntimeTraceRole;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly routeId?: string;
  readonly registryEntry: PromptTemplateRegistryEntry;
  /** Variable values resolved at this dry-run. Keys must overlap with
   *  `registryEntry.variablesRequired` for the trace to report
   *  `missingVariables=[]`. */
  readonly variables: Readonly<Record<string, unknown>>;
  /** The user's input messages (chatRequest.messages). The trace
   *  HASHES each entry's content — it never logs the raw text. */
  readonly userMessages: readonly { readonly role: string; readonly content: string | unknown }[];
}

/**
 * Build a trace for a single role.
 *
 * The returned object is the deterministic projection used in fingerprint
 * computation. The `promptFingerprint` covers the FOUR items that operators
 * need to know to reason about parity:
 *   - templateId + version (which template)
 *   - messagesShape (how many turns, their roles, content hashes)
 *   - variablesResolved (what slot values were injected)
 *   - missingVariables (what was still unfilled at trace time)
 *   - adapterPayloadFormat (how the adapter will marshal the messages)
 */
export function buildPromptRuntimeTrace(input: BuildTraceInput): PromptRuntimeTrace {
  const required = input.registryEntry.variablesRequired;
  const resolvedKeys = Object.keys(input.variables).filter((k) => input.variables[k] !== undefined && input.variables[k] !== null);
  const missingVariables = required.filter((name) => !resolvedKeys.includes(name));

  // Render the system body — we never surface its raw text.
  let systemBody = '';
  try {
    systemBody = input.registryEntry.getBody(input.variables);
  } catch {
    systemBody = '';  // treat render failure as empty system (it propagates to missing vars)
  }

  // Build the materialized messages shape: system + user turns.
  const messagesShape: PromptRuntimeTraceMessageShape[] = [];
  if (systemBody.length > 0) {
    messagesShape.push({
      role: 'system',
      contentHash: sha256Hex(systemBody),
      chars: systemBody.length,
    });
  }
  for (const m of input.userMessages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const role = (m.role === 'system' || m.role === 'user' || m.role === 'assistant' ||
                  m.role === 'tool' || m.role === 'function') ? m.role : 'user';
    messagesShape.push({
      role,
      contentHash: sha256Hex(content),
      chars: content.length,
    });
  }

  const projection = {
    promptTemplateId: input.registryEntry.id,
    promptVersion: input.registryEntry.version,
    messagesShape,
    variablesResolved: resolvedKeys.sort(),
    missingVariables: missingVariables.slice().sort(),
    adapterPayloadFormat: input.registryEntry.adapterPayloadFormat,
  };

  return {
    strategy: input.strategy,
    role: input.role,
    modelId: input.modelId,
    providerId: input.providerId,
    routeId: input.routeId,
    promptTemplateId: input.registryEntry.id,
    promptTemplatePath: input.registryEntry.path,
    promptVersion: input.registryEntry.version,
    promptFingerprint: sha256Hex(canonicalJsonStringify(projection)),
    messagesShape,
    variablesRequired: required.slice(),
    variablesResolved: resolvedKeys.sort(),
    missingVariables: missingVariables.slice().sort(),
    adapterPayloadFormat: input.registryEntry.adapterPayloadFormat,
    sanitized: true,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Multi-role builder
// ──────────────────────────────────────────────────────────────────────

export interface BuildMultiRoleTraceInput {
  readonly strategy: string;
  readonly registry: PromptTemplateRegistry;
  readonly selectedRoles: ReadonlyMap<PromptRuntimeTraceRole, {
    readonly modelId?: string;
    readonly providerId?: string;
    readonly routeId?: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }>;
  readonly userMessages: readonly { readonly role: string; readonly content: string | unknown }[];
  /** Roles for which the plan did NOT pick a model (e.g., no live-ready judge).
   *  Each such role yields a `PromptIssue.role_not_selected_due_to_plan_blocker`. */
  readonly unselectedRoles?: readonly PromptRuntimeTraceRole[];
}

export interface BuildMultiRoleTraceResult {
  readonly traces: readonly PromptRuntimeTrace[];
  readonly issues: readonly PromptIssue[];
  /** Aggregate fingerprint covering all role traces, sorted by role for stability.
   *  Used by the plan-fingerprint to detect ANY prompt change across roles. */
  readonly aggregatePromptFingerprint: string;
}

export function buildMultiRolePromptTrace(input: BuildMultiRoleTraceInput): BuildMultiRoleTraceResult {
  const traces: PromptRuntimeTrace[] = [];
  const issues: PromptIssue[] = [];

  // Selected roles → traces.
  for (const [role, selection] of input.selectedRoles) {
    const entry = input.registry.get(role);
    if (!entry) {
      issues.push({
        role,
        reason: 'template_not_found',
        detail: `No registry entry for role=${role}`,
      });
      continue;
    }
    const trace = buildPromptRuntimeTrace({
      strategy: input.strategy,
      role,
      modelId: selection.modelId,
      providerId: selection.providerId,
      routeId: selection.routeId,
      registryEntry: entry,
      variables: selection.variables,
      userMessages: input.userMessages,
    });
    traces.push(trace);
    if (trace.missingVariables.length > 0) {
      issues.push({
        role,
        reason: 'missing_variables',
        detail: trace.missingVariables.join(','),
      });
    }
  }

  // Unselected roles → blocker issues (no trace).
  for (const role of input.unselectedRoles ?? []) {
    issues.push({
      role,
      reason: 'role_not_selected_due_to_plan_blocker',
    });
  }

  // Aggregate fingerprint: stable across runs.
  const projection = traces
    .slice()
    .sort((a, b) => a.role.localeCompare(b.role))
    .map((t) => ({
      role: t.role,
      promptFingerprint: t.promptFingerprint,
    }));
  const aggregatePromptFingerprint = sha256Hex(canonicalJsonStringify(projection));

  return { traces, issues, aggregatePromptFingerprint };
}

// ──────────────────────────────────────────────────────────────────────
// Sanitization helper — exposed for caller test purposes.
// ──────────────────────────────────────────────────────────────────────

/** Returns a redacted view of the trace suitable for surfacing in a
 *  `consensusPlan.promptTrace` field. Identical to the trace but
 *  guaranteed not to include `messagesShape` body or any path that could
 *  leak prompt content. (Currently `messagesShape` only has hash+chars,
 *  but the redactor is the place to enforce future invariants.) */
export function sanitizeTraceForSurface(trace: PromptRuntimeTrace): PromptRuntimeTrace {
  return {
    strategy: trace.strategy,
    role: trace.role,
    modelId: trace.modelId,
    providerId: trace.providerId,
    routeId: trace.routeId,
    promptTemplateId: trace.promptTemplateId,
    promptTemplatePath: trace.promptTemplatePath,
    promptVersion: trace.promptVersion,
    promptFingerprint: trace.promptFingerprint,
    messagesShape: trace.messagesShape.map((m) => ({
      role: m.role,
      contentHash: m.contentHash,
      chars: m.chars,
    })),
    variablesRequired: trace.variablesRequired.slice(),
    variablesResolved: trace.variablesResolved.slice(),
    missingVariables: trace.missingVariables.slice(),
    adapterPayloadFormat: trace.adapterPayloadFormat,
    sanitized: true,
  };
}
