// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-capability-document.ts — type contract for the embeddable doc.
 *
 * MVP 5A invariants:
 *   - Pure types. No I/O. No embedding generation here.
 *   - `text` is human-readable AND deterministic. Used by future MVPs
 *     to feed TEI; in MVP 5A it is just a snapshot anchor.
 *   - `structured` carries categorical info — NO prompts, NO user data.
 */

// ─── Cost / latency class buckets ───────────────────────────────────────

export type CostClass = 'free' | 'micro' | 'low' | 'mid' | 'high' | 'unknown';
export type LatencyClass = 'fast' | 'moderate' | 'slow' | 'unknown';

// ─── Document ───────────────────────────────────────────────────────────

export interface ModelCapabilityDocumentStructured {
  readonly family: string;
  readonly version?: string;
  readonly lifecycle: string;
  readonly capabilities: readonly string[];
  readonly routeKinds: readonly string[];
  readonly contextWindowMax?: number;
  readonly costClass?: CostClass;
  readonly latencyClass?: LatencyClass;
  readonly freshnessScore?: number;
}

export interface ModelCapabilityDocument {
  readonly canonicalModelId: string;
  readonly title: string;
  readonly text: string;
  readonly structured: ModelCapabilityDocumentStructured;
}
