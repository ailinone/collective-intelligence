// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Capability Merger
 *
 * Consolidates capability signals from multiple sources into a single canonical
 * set of capabilities per model, with full source attribution per capability.
 *
 * Architecture (decision 1b — hierarchical precedence + 2b — per-capability sources):
 *
 *   fetcher (provider API)  ─┐
 *   helicone oracle         ─┼─→ CapabilitySignal[]  ─→ mergeCapabilities()  ─→ MergedCapabilities
 *   modality inference      ─┤
 *   parameter inference     ─┤
 *   name regex (fallback)   ─┘
 *
 * Why a separate module:
 * - inference (model-capability-inference.ts) PRODUCES signals from raw metadata
 * - merger (this file) RESOLVES conflicts and attributes sources
 * - downstream (bandits, canary gates, selection) reads MergedCapabilities and
 *   can downweight capabilities that came only from weak sources
 */

import type { ModelCapability } from '@/types';

// ─── Source taxonomy ──────────────────────────────────────────────────────────

/**
 * Where a capability claim came from. Listed roughly in order of trust.
 *
 * - provider-declared: The provider's own /models endpoint returned an explicit
 *   capability boolean or array (e.g. NanoGPT `?detailed=true` → `vision: true`,
 *   Mistral `capabilities.function_calling: true`, AiHubMix `features: ["tools"]`).
 *   This is the gold standard — the provider operates the model and knows.
 *
 * - helicone-oracle: Cross-referenced via Helicone's public model registry
 *   (https://api.helicone.ai/v1/public/model-registry/models). Useful as a
 *   backfill when the primary provider returns ID-only (OpenAI, DashScope, NIM).
 *
 * - modality-derived: Inferred from `architecture.input_modalities` /
 *   `output_modalities` arrays (OpenRouter, Poe, Bedrock format). E.g.
 *   `input: ["image"]` ⇒ `vision`. Strong signal but indirect.
 *
 * - parameter-derived: Inferred from `supported_parameters` arrays (OpenRouter,
 *   Routeway). E.g. `tools` ⇒ `function_calling`, `reasoning` ⇒ `reasoning`.
 *   Tells you what the API ACCEPTS, not necessarily what the model excels at.
 *
 * - name-regex: Last-resort heuristic match against the model id/description.
 *   Will produce false positives ("agent" in name ≠ agent capability).
 */
export type CapabilitySource =
  | 'provider-declared'
  | 'helicone-oracle'
  | 'modality-derived'
  | 'parameter-derived'
  | 'name-regex';

/**
 * Numeric priority for sorting (lower = stronger). Used internally and exposed
 * so downstream consumers can sort the `sources` array consistently.
 */
export const SOURCE_PRIORITY: Readonly<Record<CapabilitySource, number>> = Object.freeze({
  'provider-declared': 1,
  'helicone-oracle': 2,
  'modality-derived': 3,
  'parameter-derived': 4,
  'name-regex': 5,
});

/**
 * "Strong" sources are authoritative — if any strong source declares the
 * model's capability set, weak-source claims are discarded.
 *
 * Rationale: provider-declared and oracle-cross-referenced data is opinionated
 * and complete. If a provider says `vision: false` but a regex match on the
 * name says "vision", we trust the provider. This avoids the regex false
 * positives that currently dominate the catalog.
 */
export const STRONG_SOURCES: ReadonlySet<CapabilitySource> = new Set<CapabilitySource>([
  'provider-declared',
  'helicone-oracle',
]);

export function isStrongSource(source: CapabilitySource): boolean {
  return STRONG_SOURCES.has(source);
}

// ─── I/O types ────────────────────────────────────────────────────────────────

/**
 * One atomic claim: "model has capability X, claimed by source Y".
 * Multiple signals for the same (capability, source) pair are deduplicated.
 *
 * `detail` and `confidence` are read by the Sprint 2 assertion writer (ADR-022)
 * to populate `model_capability_assertions.source_detail` and `confidence`.
 * The hierarchical merger ignores both fields.
 */
export interface CapabilitySignal {
  capability: ModelCapability;
  source: CapabilitySource;
  /** Optional fine-grained provenance: which endpoint, which field, etc. */
  detail?: Record<string, unknown>;
  /** Per-claim confidence in [0,1]. Defaults vary by source: declared=1.0, inferred=0.7. */
  confidence?: number;
}

/**
 * Final consolidated view of a model's capabilities.
 *
 * - `capabilities`: the deduped, canonical list to write to `models.capabilities`
 * - `sources`: per-capability attribution, sorted strongest-first. Write to
 *   `models.metadata.capabilitySources` so downstream consumers (L5 bandit,
 *   L6 canary gate) can apply confidence weighting.
 */
export interface MergedCapabilities {
  capabilities: ModelCapability[];
  sources: Partial<Record<ModelCapability, CapabilitySource[]>>;
}

// ─── Helpers (already implemented — your job is mergeCapabilities below) ──────

/**
 * Group signals by capability, preserving the set of sources per capability.
 * Sources are deduplicated and sorted strongest-first within each group.
 */
function groupByCapability(
  signals: readonly CapabilitySignal[],
): Map<ModelCapability, CapabilitySource[]> {
  const grouped = new Map<ModelCapability, Set<CapabilitySource>>();
  for (const signal of signals) {
    let bucket = grouped.get(signal.capability);
    if (!bucket) {
      bucket = new Set<CapabilitySource>();
      grouped.set(signal.capability, bucket);
    }
    bucket.add(signal.source);
  }
  const sortedSources = new Map<ModelCapability, CapabilitySource[]>();
  for (const [capability, sourceSet] of grouped.entries()) {
    const sorted = Array.from(sourceSet).sort(
      (a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b],
    );
    sortedSources.set(capability, sorted);
  }
  return sortedSources;
}

/**
 * True if any signal in the input came from a strong source.
 * When this is true, weak-only capabilities should be suppressed.
 */
function hasAnyStrongSignal(signals: readonly CapabilitySignal[]): boolean {
  for (const signal of signals) {
    if (isStrongSource(signal.source)) return true;
  }
  return false;
}

// ─── Core merge function ──────────────────────────────────────────────────────

/**
 * Merge capability signals into a canonical capability set with source
 * attribution.
 *
 * RULES (decision 1b — hierarchical precedence):
 *
 *   1. If ANY strong-source signal exists for this model:
 *        - Keep ONLY capabilities that have at least one strong source.
 *        - Discard capabilities supported only by weak sources (regex-only,
 *          parameter-only, modality-only).
 *        - Rationale: provider's authoritative list trumps inference.
 *
 *   2. If NO strong-source signal exists (provider returned ID-only and
 *      Helicone has nothing):
 *        - Union of all weak-source capabilities (best-effort fallback).
 *        - Better to have regex-derived caps than no caps at all.
 *
 *   3. Sources for each kept capability are recorded in full (decision 2b),
 *      sorted strongest-first. The `groupByCapability` helper above already
 *      does the dedup + sort — you just need to filter by rule 1 vs 2.
 *
 * EXAMPLE 1 — provider declares, regex disagrees:
 *   Input: [
 *     { capability: 'chat',   source: 'provider-declared' },
 *     { capability: 'vision', source: 'name-regex' },        // false positive
 *   ]
 *   Output: capabilities = ['chat']
 *           sources = { chat: ['provider-declared'] }
 *           (vision dropped — strong source exists but didn't include it)
 *
 * EXAMPLE 2 — only weak signals available (OpenAI ID-only case):
 *   Input: [
 *     { capability: 'chat',   source: 'name-regex' },
 *     { capability: 'vision', source: 'name-regex' },
 *   ]
 *   Output: capabilities = ['chat', 'vision']
 *           sources = { chat: ['name-regex'], vision: ['name-regex'] }
 *           (both kept — fallback mode, no strong source to defer to)
 *
 * EXAMPLE 3 — strong + weak both confirm:
 *   Input: [
 *     { capability: 'vision', source: 'provider-declared' },
 *     { capability: 'vision', source: 'modality-derived' },
 *     { capability: 'vision', source: 'name-regex' },
 *   ]
 *   Output: capabilities = ['vision']
 *           sources = { vision: ['provider-declared', 'modality-derived', 'name-regex'] }
 *           (kept; full attribution retained for downstream confidence weighting)
 *
 * @param signals  Flat list of capability claims from all upstream sources.
 *                 Order does NOT matter; duplicates are tolerated.
 * @returns        Canonical merged result. `capabilities` is sorted alphabetically
 *                 for stable serialization to JSONB.
 */
export function mergeCapabilities(
  signals: readonly CapabilitySignal[],
): MergedCapabilities {
  const grouped = groupByCapability(signals);
  const strongSignalPresent = hasAnyStrongSignal(signals);

  const sources: Partial<Record<ModelCapability, CapabilitySource[]>> = {};

  for (const [capability, capabilitySources] of grouped.entries()) {
    if (strongSignalPresent && !capabilitySources.some(isStrongSource)) {
      continue;
    }
    sources[capability] = capabilitySources;
  }

  const capabilities = (Object.keys(sources) as ModelCapability[]).sort();
  return { capabilities, sources };
}
