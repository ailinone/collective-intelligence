// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared modality orchestration helpers (DUP #2, 2026-06-11).
 *
 * Extracted from audio/video/images orchestration services where these three
 * implementations were byte-identical (verified by an adversarial per-function
 * comparison — risk:none). They are pure functions: no `this`, no service
 * state. Intentionally NOT extracted here (they diverge materially per service,
 * verified): the cost/quality/latency getters (audio has a NaN guard the others
 * lack), `sortModelsByStrategy`, and the per-service error classification.
 * This module is the first, safe phase of the modality consolidation; the
 * heavier `ModalityExecutor` base class (the executeWithFallback driver) is a
 * later phase.
 */

/**
 * Canonical orchestration strategy union. Previously duplicated as an inline
 * union in audio/video and as the `ImageStrategy` alias in images.
 */
export type ModalityStrategy =
  | 'single'
  | 'cost'
  | 'speed'
  | 'quality'
  | 'balanced'
  | 'parallel'
  | 'debate'
  | 'quality_multipass'
  | 'dynamic';

/**
 * Normalize a free-form strategy string to the canonical union.
 * (audio:168, video:65, images:423 — identical.)
 */
export function normalizeStrategy(strategy: string | undefined): ModalityStrategy {
  const normalized = strategy?.trim().toLowerCase();
  if (!normalized) return 'dynamic';
  switch (normalized) {
    case 'single':
    case 'cost':
    case 'speed':
    case 'quality':
    case 'balanced':
    case 'parallel':
    case 'debate':
    case 'quality_multipass':
    case 'dynamic':
      return normalized;
    case 'quality-multipass':
    case 'quality-multi-pass':
      return 'quality_multipass';
    case 'auto':
      return 'dynamic';
    default:
      return 'dynamic';
  }
}

/**
 * Resolve the wall-clock search budget (ms) for a fallback strategy.
 *
 * REDESIGNED 2026-07-15 (found in production, then corrected per explicit
 * operator instruction): this used to be a hard CANDIDATE-COUNT ceiling
 * (`resolveCandidateLimit`, capped at 6-9 in the default tiers). The catalog
 * carries far more candidates per media-generation capability than any
 * fixed count could track — 46,848 models across 24 providers for
 * image_generation, 493 across 18 providers for video_generation, both
 * still growing as more providers/models get onboarded (audio_generation is
 * currently much smaller, 23 models / 4 providers, but is not exempt from
 * the same growth). `diversifyProviders()` truncated to whichever N
 * providers ranked first BEFORE the old limit was even considered, so a cap
 * of 6 meant 12+ providers with real, working video models never got a
 * single attempt — confirmed live: a real video-generation request
 * exhausted all 6 tried candidates (wrong endpoints, incompatible payloads,
 * dead models) while 12 untried providers sat in the pool, and every raise
 * of that count would need ANOTHER code change the next time the catalog
 * grows. A count tied to "how many providers exist right now" can never be
 * the right architecture for a catalog that grows continuously.
 *
 * The budget below is NOT tied to catalog size at all — it's a UX-latency
 * ceiling (how long a caller should reasonably wait), so the search tries
 * as MANY ranked candidates as fit in that time, automatically adapting as
 * the catalog grows (more/fewer attempts fit depending on how many
 * candidates are actually healthy and fast right now) with zero future
 * code changes required. See `executeWithFallback`'s `deadlineMs` — the
 * search itself is unbounded in candidate COUNT (the full ranked pool is
 * offered), bounded only by this wall-clock budget.
 */
export function resolveFallbackDeadlineMs(strategy: ModalityStrategy, allowFallback: boolean): number {
  if (!allowFallback) return 0; // 0 = try only the first candidate, no search
  switch (strategy) {
    case 'single':
      return 4000;
    case 'cost':
    case 'speed':
      return 10000;
    case 'parallel':
    case 'debate':
    case 'quality_multipass':
      return 20000;
    case 'quality':
    case 'balanced':
    case 'dynamic':
    default:
      return 30000;
  }
}

/**
 * Stable-partition models so the first occurrence of each provider leads and
 * remaining duplicates follow in original order. Generic over `{ provider }`
 * so it works with the `Model` type (and any extension) unchanged.
 * (audio:319, video:180, images:565 — byte-identical.)
 */
export function diversifyProviders<T extends { provider: string }>(models: T[]): T[] {
  const providerFirst: T[] = [];
  const remainder: T[] = [];
  const seenProviders = new Set<string>();
  for (const model of models) {
    const provider = model.provider.toLowerCase();
    if (!seenProviders.has(provider)) {
      providerFirst.push(model);
      seenProviders.add(provider);
    } else {
      remainder.push(model);
    }
  }
  return [...providerFirst, ...remainder];
}
