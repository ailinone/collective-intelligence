// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6 §8 — Artificial Analysis normalizer.
 *
 * Pure helper that takes one or many raw AA models and returns a stable,
 * audit-friendly normalized projection. The projection NEVER drops fields
 * silently — every field exposed on `NormalizedArtificialAnalysisModel`
 * is mapped explicitly from the AA payload.
 *
 * Pure: identical input → identical output, no I/O.
 */
import type { ArtificialAnalysisLlmModel } from './artificial-analysis-client';

// ─── Types ────────────────────────────────────────────────────────────────

export interface NormalizedArtificialAnalysisModel {
  readonly source: 'artificial_analysis_api';
  readonly aaModelId: string;
  readonly aaName: string;
  readonly aaSlug?: string;
  readonly creatorId?: string;
  readonly creatorName?: string;
  readonly creatorSlug?: string;
  readonly normalizedAliases: ReadonlyArray<string>;
  readonly evaluations: {
    readonly intelligenceIndex?: number;
    readonly codingIndex?: number;
    readonly mathIndex?: number;
    readonly mmluPro?: number;
    readonly gpqa?: number;
    readonly hle?: number;
    readonly liveCodeBench?: number;
    readonly sciCode?: number;
    readonly math500?: number;
    readonly aime?: number;
  };
  readonly pricing: {
    readonly blended3To1UsdPer1MTokens?: number;
    readonly inputUsdPer1MTokens?: number;
    readonly outputUsdPer1MTokens?: number;
  };
  readonly speed: {
    readonly outputTokensPerSecond?: number;
    readonly timeToFirstTokenSeconds?: number;
    readonly timeToFirstAnswerTokenSeconds?: number;
  };
  readonly rawRef: {
    readonly id: string;
    readonly slug?: string;
    readonly name: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const PROVIDER_WRAPPER_PREFIXES = [
  'accounts/fireworks/models/',
  'deepseek-ai/',
  'moonshotai/',
  'qwen/',
  'anthropic/',
  'google/',
  'xai/',
  'openai/',
  'mistralai/',
  'meta-llama/',
  'aion-labs/',
  'abacusai/',
];

export function normalizeAaId(input: string | undefined): string {
  if (!input) return '';
  let s = String(input).toLowerCase().trim();
  for (const prefix of PROVIDER_WRAPPER_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  s = s
    .replace(/[._\s]+/g, '-')
    .replace(/[()]/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

function clampNumber(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return n;
}

function aliasSet(m: ArtificialAnalysisLlmModel): ReadonlyArray<string> {
  const ids: string[] = [];
  if (m.id) ids.push(m.id);
  if (m.name) ids.push(m.name);
  if (m.slug) ids.push(m.slug);
  if (m.model_creator?.name) {
    if (m.name) ids.push(`${m.model_creator.name}/${m.name}`);
    if (m.slug) ids.push(`${m.model_creator.name}/${m.slug}`);
  }
  if (m.model_creator?.slug) {
    if (m.slug) ids.push(`${m.model_creator.slug}/${m.slug}`);
    if (m.name) ids.push(`${m.model_creator.slug}/${m.name}`);
  }
  const out = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    out.add(String(id));
    out.add(normalizeAaId(id));
    const short = String(id).split('/').pop();
    if (short) out.add(normalizeAaId(short));
  }
  return [...out].filter(Boolean).sort();
}

// ─── Public API ───────────────────────────────────────────────────────────

export function normalizeArtificialAnalysisModel(
  m: ArtificialAnalysisLlmModel,
): NormalizedArtificialAnalysisModel {
  return {
    source: 'artificial_analysis_api',
    aaModelId: String(m.id),
    aaName: String(m.name),
    aaSlug: m.slug,
    creatorId: m.model_creator?.id,
    creatorName: m.model_creator?.name,
    creatorSlug: m.model_creator?.slug,
    normalizedAliases: aliasSet(m),
    evaluations: {
      intelligenceIndex: clampNumber(m.evaluations?.artificial_analysis_intelligence_index),
      codingIndex: clampNumber(m.evaluations?.artificial_analysis_coding_index),
      mathIndex: clampNumber(m.evaluations?.artificial_analysis_math_index),
      mmluPro: clampNumber(m.evaluations?.mmlu_pro),
      gpqa: clampNumber(m.evaluations?.gpqa),
      hle: clampNumber(m.evaluations?.hle),
      liveCodeBench: clampNumber(m.evaluations?.livecodebench),
      sciCode: clampNumber(m.evaluations?.scicode),
      math500: clampNumber(m.evaluations?.math_500),
      aime: clampNumber(m.evaluations?.aime),
    },
    pricing: {
      blended3To1UsdPer1MTokens: clampNumber(m.pricing?.price_1m_blended_3_to_1),
      inputUsdPer1MTokens: clampNumber(m.pricing?.price_1m_input_tokens),
      outputUsdPer1MTokens: clampNumber(m.pricing?.price_1m_output_tokens),
    },
    speed: {
      outputTokensPerSecond: clampNumber(m.median_output_tokens_per_second),
      timeToFirstTokenSeconds: clampNumber(m.median_time_to_first_token_seconds),
      timeToFirstAnswerTokenSeconds: clampNumber(m.median_time_to_first_answer_token),
    },
    rawRef: {
      id: String(m.id),
      slug: m.slug,
      name: String(m.name),
    },
  };
}

export function normalizeArtificialAnalysisModels(
  ms: ReadonlyArray<ArtificialAnalysisLlmModel>,
): ReadonlyArray<NormalizedArtificialAnalysisModel> {
  return ms.map(normalizeArtificialAnalysisModel);
}
