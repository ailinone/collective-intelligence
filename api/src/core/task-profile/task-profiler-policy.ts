// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-policy.ts — MVP 6A
 *
 * Pure config: thresholds + term sets. No I/O.
 *
 * Term sets are FUNCTIONAL ONLY — no model/provider names, only
 * generic domain/task vocabulary. Permitted per MVP 6A spec §12.10.
 */

// ─── Token thresholds ──────────────────────────────────────────────────

export interface TaskProfilerPolicy {
  readonly tokenThresholds: {
    /** Inputs up to this size are `low` complexity. */
    readonly low: number;
    /** Inputs up to this size are `medium` complexity. */
    readonly medium: number;
    /** Inputs up to this size are `high` complexity. Above → `extreme`. */
    readonly high: number;
    /** When context tokens ≥ this, `long_context` capability is required. */
    readonly longContext: number;
  };
  readonly attachmentBumps: {
    /** Each attachment beyond the first nudges complexity up by 1 level. */
    readonly perAttachment: number;
    /** When multi-document detected, escalate toward `extreme`. */
    readonly multiDocumentThreshold: number;
  };
}

export const DEFAULT_TASK_PROFILER_POLICY: TaskProfilerPolicy = Object.freeze({
  tokenThresholds: Object.freeze({
    low: 500,
    medium: 4_000,
    high: 50_000,
    longContext: 30_000,
  }),
  attachmentBumps: Object.freeze({
    perAttachment: 1,
    multiDocumentThreshold: 3,
  }),
});

export function resolveTaskProfilerPolicy(
  override?: Partial<TaskProfilerPolicy>,
): TaskProfilerPolicy {
  if (!override) return DEFAULT_TASK_PROFILER_POLICY;
  return {
    tokenThresholds: {
      ...DEFAULT_TASK_PROFILER_POLICY.tokenThresholds,
      ...(override.tokenThresholds ?? {}),
    },
    attachmentBumps: {
      ...DEFAULT_TASK_PROFILER_POLICY.attachmentBumps,
      ...(override.attachmentBumps ?? {}),
    },
  };
}

// ─── Functional term dictionaries ──────────────────────────────────────

/**
 * All terms are FUNCTIONAL vocabulary — no model/provider names.
 * Used by `task-profile-normalizer.containsWord(text, term)` to detect
 * task / risk / privacy signals.
 */

export const CODE_TERMS: readonly string[] = Object.freeze([
  'code',
  'function',
  'class',
  'implement',
  'debug',
  'compile',
  'syntax',
  'programming',
  'refactor',
  'unit-test',
  'unittest',
  'bug',
]);

export const MATH_TERMS: readonly string[] = Object.freeze([
  'math',
  'equation',
  'calculate',
  'derivative',
  'integral',
  'matrix',
  'algebra',
  'geometry',
  'theorem',
  'proof',
]);

export const ANALYSIS_TERMS: readonly string[] = Object.freeze([
  'analyze',
  'analysis',
  'compare',
  'comparison',
  'evaluate',
  'review',
  'inspect',
  'audit',
]);

export const SUMMARIZATION_TERMS: readonly string[] = Object.freeze([
  'summarize',
  'summary',
  'tldr',
  'brief',
  'condense',
  'shorten',
]);

export const CREATIVE_TERMS: readonly string[] = Object.freeze([
  'poem',
  'story',
  'imagine',
  'fiction',
  'creative',
  'narrative',
  'song',
]);

export const REASONING_TERMS: readonly string[] = Object.freeze([
  'reason',
  'reasoning',
  'why',
  'because',
  'explain',
  'derive',
  'prove',
  'logical',
]);

export const AGENTIC_TERMS: readonly string[] = Object.freeze([
  'agent',
  'autonomous',
  'multi-step',
  'multistep',
  'step-by-step',
  'plan',
  'workflow',
  'orchestrate',
]);

export const TOOL_USE_TERMS: readonly string[] = Object.freeze([
  'tool',
  'function-call',
  'function-calling',
  'api-call',
]);

// ─── Risk vocabulary (functional, domain-level) ─────────────────────────

export const LEGAL_TERMS: readonly string[] = Object.freeze([
  'legal',
  'contract',
  'compliance',
  'liability',
  'litigation',
  'lawsuit',
  'court',
  'judicial',
  'regulatory',
]);

export const FINANCE_TERMS: readonly string[] = Object.freeze([
  'finance',
  'financial',
  'invest',
  'tax',
  'audit',
  'balance-sheet',
  'revenue',
  'fiscal',
  'banking',
]);

export const MEDICAL_TERMS: readonly string[] = Object.freeze([
  'medical',
  'diagnosis',
  'patient',
  'prescription',
  'clinical',
  'healthcare',
  'health-record',
  'pharma',
]);

export const SECURITY_TERMS: readonly string[] = Object.freeze([
  'security',
  'vulnerability',
  'exploit',
  'credential',
  'credentials',
  'breach',
  'pentest',
  'incident',
]);

export const PRODUCTION_TERMS: readonly string[] = Object.freeze([
  'production',
  'live-system',
  'mission-critical',
  'sla',
  'on-call',
]);

// ─── Privacy vocabulary ─────────────────────────────────────────────────

export const PRIVACY_PREFERRED_TERMS: readonly string[] = Object.freeze([
  'confidential',
  'internal',
  'private',
  'sensitive',
  'pii',
  'gdpr',
  'hipaa',
  'do-not-share',
]);

// ─── Output / freshness vocabulary ──────────────────────────────────────

export const JSON_OUTPUT_TERMS: readonly string[] = Object.freeze([
  'json',
  'json-object',
  'structured-output',
]);

export const TABLE_OUTPUT_TERMS: readonly string[] = Object.freeze([
  'table',
  'csv',
  'tabular',
  'markdown-table',
]);

export const MARKDOWN_OUTPUT_TERMS: readonly string[] = Object.freeze([
  'markdown',
]);

export const FRESHNESS_TERMS: readonly string[] = Object.freeze([
  'latest',
  'newest',
  'recent',
  'current',
  'up-to-date',
  'today',
  'this-week',
  'this-month',
]);

// ─── Multi-document signals ─────────────────────────────────────────────

export const MULTI_DOCUMENT_TERMS: readonly string[] = Object.freeze([
  'multi-document',
  'multidocument',
  'across-files',
  'multiple-files',
  'documents',
]);
