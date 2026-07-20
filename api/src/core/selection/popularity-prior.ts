// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dynamic cold-start quality prior from HuggingFace popularity signals.
 *
 * Why this exists: after a restart there is NO runtime history, so the selector's
 * cold-start gives every model the same flat `fallbackScore`. An obscure
 * 0-download fine-tune then ties a 2M-download model and wins by arbitrary table
 * order — the "picks junk" symptom. Popularity (downloads/likes/trendingScore)
 * is a *live, dynamic* legitimacy signal (re-fetched every discovery cycle), so
 * ranking by it pins NO specific model id — it keeps selection fully dynamic
 * while giving the cold-start something real to discriminate on.
 *
 * Returns a prior in [0,1], or `undefined` when there is NO popularity signal at
 * all (caller keeps its neutral flat fallback — e.g. curated native models that
 * never carried HF stats). A captured `downloads: 0` is a REAL signal (→ ~0),
 * deliberately distinct from an absent one.
 */
export function computePopularityPrior(
  downloads?: number,
  likes?: number,
  trendingScore?: number,
): number | undefined {
  const hasDl = typeof downloads === 'number' && Number.isFinite(downloads);
  const hasLk = typeof likes === 'number' && Number.isFinite(likes);
  const hasTr = typeof trendingScore === 'number' && Number.isFinite(trendingScore);
  if (!hasDl && !hasLk && !hasTr) return undefined;

  // Log-normalize each (downloads/likes are heavily right-skewed). Downloads
  // dominate: they are the strongest proxy for "real, used model" vs. a
  // training-artifact. 1 dl→0, 10M→1; 10k likes→1; trending capped at 100.
  const dlNorm = hasDl ? Math.min(1, Math.log10(Math.max(0, downloads as number) + 1) / 7) : 0;
  const lkNorm = hasLk ? Math.min(1, Math.log10(Math.max(0, likes as number) + 1) / 4) : 0;
  const trNorm = hasTr ? Math.min(1, Math.max(0, trendingScore as number) / 100) : 0;

  return Math.max(0, Math.min(1, 0.6 * dlNorm + 0.3 * lkNorm + 0.1 * trNorm));
}

/** Extract popularity signals from a model's metadata blob and compute the prior. */
export function popularityPriorFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): number | undefined {
  if (!metadata) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return computePopularityPrior(
    num(metadata.downloads),
    num(metadata.likes),
    num(metadata.trendingScore),
  );
}
