// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CanonicalModel — identidade lógica do modelo, vendor-neutral.
 *
 * MVP 1 invariant: this file declares the type only. The resolver that
 * populates it (`CanonicalModelResolver`) is a later MVP. No I/O, no
 * Prisma, no Redis, no TEI.
 *
 * Semantic / capabilities / freshness pertencem AQUI — não em Offering
 * nem em Route. Provider naming pertence a `ModelProviderOffering`.
 * Pricing / endpoint / health pertencem a `ProviderModelRoute`.
 */

import type { CanonicalLifecycle } from './types';

/**
 * Vendor-neutral model identity. Two providers serving the same logical
 * model (e.g. `groq:llama-3.3-70b-versatile` and
 * `fireworks:accounts/fireworks/models/llama-v3p3-70b-instruct`) reference
 * the SAME `CanonicalModel.canonicalModelId`.
 */
export interface CanonicalModel {
  /** Stable, vendor-neutral id. Examples: `llama-3.3-70b-instruct`, `claude-opus-4-7`. */
  readonly canonicalModelId: string;

  /** Family key. Examples: `llama`, `claude`, `gpt`, `gemini`, `kimi`. */
  readonly family: string;

  /** Version string within the family. Examples: `3.3`, `opus-4.7`, `5.5`. */
  readonly version: string;

  /**
   * Monotonic numeric rank within the family. Primary signal for the
   * freshness scorer: higher = newer. Only compared WITHIN the same
   * family — cross-family comparison is meaningless and disabled.
   */
  readonly generationRank: number;

  /** ISO date when the model was first released by its owner. */
  readonly releaseDate?: string;

  /** Owner organisation. Examples: `meta`, `anthropic`, `openai`, `google`. */
  readonly owner: string;

  /** Approximate parameter count in billions, when disclosed. */
  readonly sizeParams?: number;

  /** Architecture hint when known. */
  readonly architecture?: 'dense' | 'moe' | 'hybrid';

  /** Generation lifecycle. Drives whether the model can be selected at all. */
  readonly lifecycle: CanonicalLifecycle;

  /**
   * Canonical capability URIs (ontology). Aggregated from all Offerings'
   * `providerReportedCapabilities` plus inferred + verified signals.
   */
  readonly normalizedCapabilities: ReadonlySet<string>;

  /**
   * Text fed to the embedder. Built deterministically from canonical
   * fields so re-embedding yields the same vector when inputs stable.
   */
  readonly semanticDocument: string;

  /**
   * Pointer to the entry in `SemanticIndex`. Optional during MVP 1; the
   * embedding pipeline that populates this is a later MVP.
   */
  readonly embeddingId?: string;

  /**
   * Normalised freshness in [0..1] within family. Composed with readiness
   * by `freshness-scorer.ts` (MVP 4). Standalone, this is just a number;
   * it does NOT decide selection.
   */
  readonly freshnessScore: number;

  /**
   * Per task-class quality prior in [0..1]. Updated by feedback loop
   * (later MVP). Cross-family comparison is OK here — quality is the
   * canonical-level cross-family signal.
   */
  readonly qualityPriorByTaskClass: Readonly<Record<string, number>>;

  /** Free-text strengths (audit/explain output). */
  readonly typicalStrengths: ReadonlyArray<string>;

  /** Free-text weaknesses (audit/explain output). */
  readonly knownWeaknesses: ReadonlyArray<string>;
}
