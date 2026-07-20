// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Embedder Interface (ADR-022, Sprint 3)
 *
 * Defines a swappable contract for producing 384-dimensional embeddings of
 * capability source text (ontology entries, model descriptors). Schema is
 * `vector(384)` with HNSW indices already provisioned — see migrations
 * `20260420003552_capability_ontology_and_hcra` and `20260420010000_embedding_versioning`.
 *
 * Why an interface (not a concrete OpenAI call):
 * - The embedder identity is persisted per-row in `embedding_model`. The worker
 *   re-embeds rows whose `embedding_model` differs from the active embedder.
 *   This is only meaningful if we can swap embedders without code-wide changes.
 * - Local embedders (BGE, E5) and API embedders (OpenAI, Cohere, Voyage) all
 *   produce 384d vectors via Matryoshka truncation. They are interchangeable
 *   from the persistence layer's POV.
 * - Tests can inject a deterministic stub without touching the API.
 *
 * Dimensionality is 384 by deliberate choice:
 * - HNSW M=16, ef_construction=64 provisioned for small-to-medium vectors.
 * - 384 is the BGE-small / Nomic / OpenAI-truncated sweet spot.
 * - Migrating to 768 or 1024 later requires column type change + reindex —
 *   non-trivial but bounded.
 */
export const EMBEDDING_DIM = 384;

/**
 * Stable identifier for an embedder, persisted in `*.embedding_model`.
 *
 * Format: `<provider>/<model>@<version>` (e.g. `openai/text-embedding-3-small@384`,
 * `local/bge-small-en@v1.5`). The `@dim` suffix on OpenAI variants is required
 * because the same model produces different vectors at different `dimensions`
 * settings, and we must distinguish them for staleness checks.
 *
 * This is a string, not an enum, so adding a new embedder is a code change in
 * one file (this directory) — not a schema migration.
 */
export type EmbedderId = string;

/**
 * Single text → 384d vector. Implementations should batch internally.
 */
export interface EmbedRequest {
  text: string;
}

export interface EmbedResult {
  vector: number[]; // length === EMBEDDING_DIM
}

/**
 * Capability embedder contract. Implementations MUST:
 * - Always produce vectors of length `EMBEDDING_DIM`.
 * - Be deterministic for the same input (same model produces same vector).
 * - Surface their `id` so the worker can persist provenance.
 * - Batch internally — `embedBatch` is the hot path; `embed` is a thin wrapper
 *   for ad-hoc single-text use (e.g. user-submitted query in the search API).
 *
 * Implementations MAY:
 * - Throw on transient errors (the worker has retry/backoff on its side).
 * - Internally chunk a large `texts` array into smaller API calls.
 */
export interface CapabilityEmbedder {
  /** Stable identity tag persisted alongside each embedding. */
  readonly id: EmbedderId;

  /** Embed a single text. Convenience wrapper over `embedBatch`. */
  embed(text: string): Promise<EmbedResult>;

  /**
   * Embed N texts. Implementations choose batch size internally; callers
   * may pass arrays of arbitrary length. The returned array length MUST
   * equal the input length and preserve order.
   */
  embedBatch(texts: readonly string[]): Promise<EmbedResult[]>;
}

/**
 * Produce a stable text payload for an ontology entry. Concatenation order is
 * intentional: preferred label first (highest signal), synonyms next (alias
 * coverage), description last (broader semantic context).
 *
 * The `|` separator is a deliberate non-natural character — keeps cosine
 * similarity from being polluted by accidental phrasing similarity at boundaries.
 */
export function ontologyEmbeddingText(entry: {
  preferredLabel: string;
  synonyms: readonly string[];
  description?: string | null;
}): string {
  const parts = [entry.preferredLabel];
  if (entry.synonyms.length > 0) {
    parts.push(entry.synonyms.join(', '));
  }
  if (entry.description) {
    parts.push(entry.description);
  }
  return parts.join(' | ');
}

/**
 * Produce a stable text payload for a model. Uses the materialised
 * `capability_uris` (mapped to human-readable labels via the ontology cache)
 * because slug strings carry no semantic information for the embedder.
 */
export function modelEmbeddingText(input: {
  displayName: string;
  family?: string | null;
  tier?: string | null;
  capabilityLabels: readonly string[];
}): string {
  const parts = [input.displayName];
  if (input.family) parts.push(`family: ${input.family}`);
  if (input.tier) parts.push(`tier: ${input.tier}`);
  if (input.capabilityLabels.length > 0) {
    parts.push(`capabilities: ${input.capabilityLabels.join(', ')}`);
  }
  return parts.join(' | ');
}
