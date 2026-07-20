// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-capability-document-builder.ts — pure builder.
 *
 * MVP 5A invariants:
 *   - Pure function. No I/O. No embedding generation.
 *   - Deterministic: same input ⇒ same document, byte-for-byte.
 *   - Uses `capabilityOntology` to normalise the capability list.
 *   - Output text is structured + label-prefixed (NOT free-form prose)
 *     so the future TEI embedder receives a stable, dense signal.
 *   - DOES NOT include prompts, user data, or PII.
 */

import type { CanonicalModel } from '../registry/canonical-model';
import type { ModelProviderOffering } from '../registry/model-offering';
import type { ProviderModelRoute } from '../registry/model-route';
import { capabilityOntology } from './capability-ontology';
import type {
  CostClass,
  LatencyClass,
  ModelCapabilityDocument,
  ModelCapabilityDocumentStructured,
} from './model-capability-document';

// ─── Builder input ──────────────────────────────────────────────────────

export interface ModelCapabilityDocumentBuilderInput {
  readonly canonical: CanonicalModel;
  readonly offerings: readonly ModelProviderOffering[];
  readonly routes: readonly ProviderModelRoute[];
}

// ─── Cost / latency bucketing ───────────────────────────────────────────

function classifyCost(routes: readonly ProviderModelRoute[]): CostClass {
  if (routes.length === 0) return 'unknown';
  // Use the MIN cost across all routes as the representative class.
  let min = Number.POSITIVE_INFINITY;
  for (const r of routes) {
    const total = r.inputCostPer1M + r.outputCostPer1M;
    if (total < min) min = total;
  }
  if (!Number.isFinite(min)) return 'unknown';
  if (min === 0) return 'free';
  if (min <= 0.001) return 'micro';
  if (min <= 1) return 'low';
  if (min <= 10) return 'mid';
  return 'high';
}

function classifyLatency(routes: readonly ProviderModelRoute[]): LatencyClass {
  if (routes.length === 0) return 'unknown';
  // Use the MIN observed p95 across all routes that have one.
  let min: number | null = null;
  for (const r of routes) {
    if (r.latencyP95Ms !== null && Number.isFinite(r.latencyP95Ms)) {
      if (min === null || r.latencyP95Ms < min) min = r.latencyP95Ms;
    }
  }
  if (min === null) return 'unknown';
  if (min < 500) return 'fast';
  if (min < 1500) return 'moderate';
  return 'slow';
}

// ─── Capability aggregation ─────────────────────────────────────────────

function aggregateCapabilities(
  canonical: CanonicalModel,
  offerings: readonly ModelProviderOffering[],
): readonly string[] {
  const set = new Set<string>();
  // Canonical's normalised set wins.
  for (const c of canonical.normalizedCapabilities) {
    set.add(capabilityOntology.normalize(c));
  }
  // Per-offering capabilities are folded in (their providers may declare
  // capabilities the canonical doesn't yet record).
  for (const o of offerings) {
    for (const c of o.providerReportedCapabilities) {
      set.add(capabilityOntology.normalize(c));
    }
  }
  // Deterministic order: sorted alphabetically.
  return Object.freeze(Array.from(set).sort());
}

function aggregateRouteKinds(routes: readonly ProviderModelRoute[]): readonly string[] {
  const set = new Set<string>();
  for (const r of routes) set.add(r.routeKind);
  return Object.freeze(Array.from(set).sort());
}

function maxContextWindow(routes: readonly ProviderModelRoute[]): number | undefined {
  if (routes.length === 0) return undefined;
  let max = 0;
  for (const r of routes) {
    if (r.contextWindow > max) max = r.contextWindow;
  }
  return max > 0 ? max : undefined;
}

// ─── Document builder ───────────────────────────────────────────────────

/**
 * Produces a stable, deterministic document describing the canonical
 * model. Same input MUST yield identical output (used by future MVPs
 * to compute embedding ids).
 */
export function buildModelCapabilityDocument(
  input: ModelCapabilityDocumentBuilderInput,
): ModelCapabilityDocument {
  const { canonical, offerings, routes } = input;

  const capabilities = aggregateCapabilities(canonical, offerings);
  const routeKinds = aggregateRouteKinds(routes);
  const contextWindowMax = maxContextWindow(routes);
  const costClass = classifyCost(routes);
  const latencyClass = classifyLatency(routes);

  const structured: ModelCapabilityDocumentStructured = {
    family: canonical.family,
    version: canonical.version,
    lifecycle: canonical.lifecycle,
    capabilities,
    routeKinds,
    contextWindowMax,
    costClass,
    latencyClass,
    freshnessScore: canonical.freshnessScore,
  };

  // Text representation. Structured, label-prefixed, alphabetised so
  // it is BYTE-IDENTICAL across runs for the same input.
  const lines: string[] = [
    `canonical:${canonical.canonicalModelId}`,
    `family:${canonical.family}`,
  ];
  if (canonical.version) lines.push(`version:${canonical.version}`);
  lines.push(`lifecycle:${canonical.lifecycle}`);
  lines.push(`owner:${canonical.owner}`);
  if (typeof canonical.generationRank === 'number') {
    lines.push(`generation_rank:${canonical.generationRank}`);
  }
  lines.push(`capabilities:${capabilities.join(',')}`);
  lines.push(`route_kinds:${routeKinds.join(',')}`);
  if (contextWindowMax !== undefined) {
    lines.push(`context_window_max:${contextWindowMax}`);
  }
  lines.push(`cost_class:${costClass}`);
  lines.push(`latency_class:${latencyClass}`);
  lines.push(`freshness:${canonical.freshnessScore.toFixed(2)}`);

  const text = lines.join(' ');
  const title = canonical.family && canonical.version
    ? `${canonical.family} ${canonical.version} (${canonical.canonicalModelId})`
    : canonical.canonicalModelId;

  return {
    canonicalModelId: canonical.canonicalModelId,
    title,
    text,
    structured,
  };
}
