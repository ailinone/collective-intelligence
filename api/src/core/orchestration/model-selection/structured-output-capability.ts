// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4D §7 — Structured Output Capability normalization.
 *
 * Background
 * ──────────
 * The R4C live audit showed that the runtime catalog underreports
 * structured-output capability: live-ready Anthropic/Google/DeepSeek/
 * Mistral/Qwen models advertise only `chat` + `text_generation`, even
 * though they support JSON / function-calling in production.
 *
 * This module classifies a model's structured-output evidence into one
 * of four buckets:
 *
 *   strong  — explicit json_output / json_mode / structured_output / response_format
 *   medium  — function_calling / tool_use / tool_calling / tools / supports_tools
 *   weak    — instruction_json / regex_parseable_json (NOT accepted by default)
 *   none    — no evidence
 *
 * Evidence can come from THREE non-destructive sources, in precedence:
 *
 *   1. direct capability list (case-insensitive substring on each capability)
 *   2. metadata keys (response_format / json_mode / tool_use_supported)
 *   3. audit-trailed backfill artifact (per-model overrides)
 *
 * No source MUTATES the underlying catalog. Stronger evidence wins over
 * weaker; backfill can ADD evidence but cannot REMOVE it.
 *
 * Default policy:
 *   `satisfiesJudgeStructuredOutputRequirement` accepts strong OR medium.
 *   `weak` requires an explicit `allowWeakStructuredOutputForJudge=true`
 *   policy flag (audit-fingerprinted at the planFingerprint layer).
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type StructuredOutputSupport = 'strong' | 'medium' | 'weak' | 'none';

export interface StructuredOutputEvidence {
  readonly support: StructuredOutputSupport;
  readonly matchedCapabilities: ReadonlyArray<string>;
  readonly matchedMetadataKeys: ReadonlyArray<string>;
  readonly matchedBackfillReason?: string;
  readonly evidenceSource:
    | 'capability'
    | 'metadata'
    | 'backfill'
    | 'capability+metadata'
    | 'capability+backfill'
    | 'metadata+backfill'
    | 'capability+metadata+backfill'
    | 'none';
  readonly reason: string;
}

export interface StructuredOutputBackfillEntry {
  readonly providerId: string;
  readonly modelId?: string;
  readonly apiModelId?: string;
  readonly canonicalModelId?: string;
  readonly support: StructuredOutputSupport;
  readonly reason: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly source: 'docs' | 'family_inference' | 'live_probe' | 'manual';
  readonly capturedAt?: string;
  readonly stage?: string;
}

export interface DetectStructuredOutputInput {
  readonly capabilities?: ReadonlyArray<string>;
  readonly metadata?: Record<string, unknown>;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly apiModelId?: string;
  readonly canonicalModelId?: string;
  readonly backfill?: ReadonlyArray<StructuredOutputBackfillEntry>;
}

// ─── Constants ────────────────────────────────────────────────────────────

export const STRUCTURED_OUTPUT_POLICY_VERSION = '01C.1B-J1D-R4D-v1' as const;

export const STRONG_CAPABILITY_TERMS: ReadonlyArray<string> = [
  'json_output',
  'json_mode',
  'json-mode',
  'jsonmode',
  'structured_output',
  'structured_outputs',
  'response_format_json',
  'response_format_json_object',
  'response_format_json_schema',
];

export const MEDIUM_CAPABILITY_TERMS: ReadonlyArray<string> = [
  'function_calling',
  'function_call',
  'functioncall',
  'functioncalling',
  'tool_use',
  'tooluse',
  'tool_calling',
  'toolcalling',
  'tools',
  'supports_tools',
];

export const WEAK_CAPABILITY_TERMS: ReadonlyArray<string> = [
  'instruction_json',
  'json_only_instruction',
  'regex_parseable_json',
];

// Metadata keys that signal structured output.
export const STRONG_METADATA_KEYS: ReadonlyArray<string> = [
  'json_output',
  'json_mode',
  'structured_output',
  'response_format',
  'response_format_json',
  'response_format_json_schema',
];
export const MEDIUM_METADATA_KEYS: ReadonlyArray<string> = [
  'function_calling',
  'tool_use',
  'tool_calling',
  'tools',
  'supports_tools',
];

// Order-aware rank for "stronger evidence wins".
const RANK: Record<StructuredOutputSupport, number> = {
  none: 0,
  weak: 1,
  medium: 2,
  strong: 3,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function normalizeCapList(caps: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return Array.isArray(caps) ? caps.map((c) => String(c).toLowerCase()) : [];
}

function matchTerms(
  caps: ReadonlyArray<string>,
  terms: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const out: string[] = [];
  for (const c of caps) {
    if (terms.some((t) => c === t || c.includes(t))) out.push(c);
  }
  return out;
}

function matchMetadataKeys(
  metadata: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!metadata) return [];
  const matched: string[] = [];
  for (const k of Object.keys(metadata)) {
    const kLower = k.toLowerCase();
    if (keys.some((target) => kLower === target || kLower.includes(target))) {
      const v = metadata[k];
      // Treat truthy and string non-empty values as positive evidence.
      if (v === true || (typeof v === 'string' && v.length > 0) || typeof v === 'object') {
        matched.push(k);
      }
    }
  }
  // Also detect response_format=json_* style nested values.
  const rf = metadata.response_format;
  if (typeof rf === 'string' && /^json(\b|_|$)/i.test(rf) && !matched.includes('response_format')) {
    matched.push('response_format');
  }
  if (
    typeof rf === 'object' &&
    rf !== null &&
    'type' in rf &&
    typeof (rf as { type: unknown }).type === 'string' &&
    /^json/i.test((rf as { type: string }).type) &&
    !matched.includes('response_format')
  ) {
    matched.push('response_format');
  }
  return matched;
}

function lookupBackfill(
  backfill: ReadonlyArray<StructuredOutputBackfillEntry>,
  input: DetectStructuredOutputInput,
): StructuredOutputBackfillEntry | undefined {
  const providerId = String(input.providerId || '').toLowerCase();
  const idCandidates = [input.modelId, input.apiModelId, input.canonicalModelId]
    .filter(Boolean)
    .map((id) => String(id).toLowerCase());
  for (const entry of backfill) {
    if (String(entry.providerId).toLowerCase() !== providerId) continue;
    const entryIds = [entry.modelId, entry.apiModelId, entry.canonicalModelId]
      .filter(Boolean)
      .map((id) => String(id).toLowerCase());
    if (entryIds.some((id) => idCandidates.includes(id))) return entry;
  }
  return undefined;
}

function classifyFromCaps(
  caps: ReadonlyArray<string>,
): { class: StructuredOutputSupport; matched: ReadonlyArray<string> } {
  const matchedStrong = matchTerms(caps, STRONG_CAPABILITY_TERMS);
  if (matchedStrong.length > 0) return { class: 'strong', matched: matchedStrong };
  const matchedMedium = matchTerms(caps, MEDIUM_CAPABILITY_TERMS);
  if (matchedMedium.length > 0) return { class: 'medium', matched: matchedMedium };
  const matchedWeak = matchTerms(caps, WEAK_CAPABILITY_TERMS);
  if (matchedWeak.length > 0) return { class: 'weak', matched: matchedWeak };
  return { class: 'none', matched: [] };
}

function classifyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { class: StructuredOutputSupport; matched: ReadonlyArray<string> } {
  const strong = matchMetadataKeys(metadata, STRONG_METADATA_KEYS);
  if (strong.length > 0) return { class: 'strong', matched: strong };
  const medium = matchMetadataKeys(metadata, MEDIUM_METADATA_KEYS);
  if (medium.length > 0) return { class: 'medium', matched: medium };
  return { class: 'none', matched: [] };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Detect structured-output support for a single model.
 *
 * Pure: identical input → identical output. No I/O. Never throws.
 */
export function detectStructuredOutputSupport(
  input: DetectStructuredOutputInput,
): StructuredOutputEvidence {
  const caps = normalizeCapList(input.capabilities);
  const fromCaps = classifyFromCaps(caps);
  const fromMd = classifyFromMetadata(input.metadata);

  let bestClass: StructuredOutputSupport = 'none';
  const sources: Array<'capability' | 'metadata' | 'backfill'> = [];

  if (fromCaps.class !== 'none') {
    bestClass = fromCaps.class;
    sources.push('capability');
  }
  if (fromMd.class !== 'none' && RANK[fromMd.class] > RANK[bestClass]) {
    bestClass = fromMd.class;
    sources.push('metadata');
  } else if (fromMd.class !== 'none' && !sources.includes('metadata')) {
    sources.push('metadata');
  }

  // Backfill: stronger evidence can OVERRIDE weaker direct evidence, but
  // backfill cannot WEAKEN existing strong evidence.
  let matchedBackfillReason: string | undefined;
  if (Array.isArray(input.backfill) && input.backfill.length > 0) {
    const entry = lookupBackfill(input.backfill, input);
    if (entry) {
      matchedBackfillReason = entry.reason;
      if (RANK[entry.support] > RANK[bestClass]) {
        bestClass = entry.support;
      }
      sources.push('backfill');
    }
  }

  const evidenceSource =
    sources.length === 0
      ? 'none'
      : (sources.join('+') as StructuredOutputEvidence['evidenceSource']);

  let reason: string;
  if (bestClass === 'none') {
    reason = 'no_structured_output_evidence';
  } else if (sources.includes('backfill') && bestClass !== fromCaps.class && bestClass !== fromMd.class) {
    reason = `structured_output_via_backfill:${matchedBackfillReason ?? 'unknown'}`;
  } else if (sources.length === 1 && sources[0] === 'capability') {
    reason = `structured_output_via_capability:${fromCaps.matched.join(',')}`;
  } else if (sources.length === 1 && sources[0] === 'metadata') {
    reason = `structured_output_via_metadata:${fromMd.matched.join(',')}`;
  } else {
    reason = `structured_output_multi_source:${sources.join('+')}`;
  }

  return {
    support: bestClass,
    matchedCapabilities: fromCaps.matched,
    matchedMetadataKeys: fromMd.matched,
    matchedBackfillReason,
    evidenceSource,
    reason,
  };
}

/**
 * Predicate: does this model satisfy the judge's structured-output
 * requirement under the current policy?
 *
 * Default: strong OR medium.
 * With `allowWeakStructuredOutputForJudge=true`: also accept weak.
 */
export function satisfiesJudgeStructuredOutputRequirement(input: {
  evidence: StructuredOutputEvidence;
  allowWeakStructuredOutputForJudge?: boolean;
}): boolean {
  const { support } = input.evidence;
  if (support === 'strong' || support === 'medium') return true;
  if (support === 'weak' && input.allowWeakStructuredOutputForJudge === true) return true;
  return false;
}

/**
 * Load a structured-output backfill artifact from a parsed JSON object.
 * Mirrors the R4C context-backfill loader shape — same audit-trailed
 * envelope: `{ version, overrides: [...] }`.
 */
export function readStructuredOutputBackfill(parsed: {
  version?: string;
  overrides?: ReadonlyArray<StructuredOutputBackfillEntry>;
}): {
  version: string | undefined;
  overrides: ReadonlyArray<StructuredOutputBackfillEntry>;
} {
  return {
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    overrides: Array.isArray(parsed.overrides) ? parsed.overrides : [],
  };
}
