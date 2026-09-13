// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Zero-latency opening narration (Gap 2, "narrate from the very beginning").
 *
 * The Observer's real narration (`ObserverService.generateNarration`) always
 * costs a full LLM round-trip — 10s Ollama timeout / 15s cloud timeout, and a
 * measured 4-9s floor even on the happy path. That is fine for the RICH
 * narration that follows, but it means the FIRST content a viewer sees can
 * never be truly instant if it has to wait on that call.
 *
 * This module builds the one line that CAN be instant: a deterministic,
 * plain-string-interpolation sentence built entirely from data the engine
 * already has in hand the moment a strategy is resolved (its name/displayName
 * and its minModels/maxModels) — no network call, no `await`, no LLM. The
 * engine emits it via `ObserverFeed.emitImmediate()` (see observer-types.ts)
 * BEFORE kicking off the async, LLM-backed `emit()` call for the same
 * milestone, so a viewer never sees empty silence while an equivalent
 * "visible reasoning" stream would already be producing tokens.
 */

/** The subset of StrategyMetadata this template needs. Kept structural
 *  (not imported from base-strategy.ts) so this module has zero dependency
 *  on the strategy layer — any object with these fields works. */
export interface OpeningStrategyInfo {
  name: string;
  displayName?: string;
  minModels?: number;
  maxModels?: number;
}

/**
 * Best-effort pt-BR vs. English guess for THIS ONE LINE ONLY.
 *
 * Every other narration in this system mirrors the user's language via
 * LLM instruction (see `language-directive.ts`'s doc comment on why a
 * detector/whitelist was deliberately rejected there — it does not
 * generalize to arbitrary languages). That approach is unavailable here BY
 * DESIGN: this line's entire reason to exist is that it must be emitted
 * with zero LLM/network latency. A coarse two-way heuristic scoped to this
 * one template is an acceptable, clearly-bounded trade-off — it only ever
 * affects the ~1-9s window before the real, fully general LLM-mirrored
 * narration for the same milestone lands and takes over.
 *
 * Errs toward English (the safer default for a programmatic/API caller)
 * when the sample is empty or ambiguous.
 */
function looksLikePortuguese(sample: string): boolean {
  if (!sample) return false;
  const s = sample.toLowerCase();
  // Letters/diacritics exceedingly rare in English but common in pt-BR/pt-PT
  // (ã/õ/ç/â/ê/ô are pt-specific; the plain acute vowels á/é/í/ó/ú/à are
  // shared with other Romance languages — a false-positive there still picks
  // a much closer-feeling opener than a flat English default, and the real
  // LLM-mirrored narration for the SAME milestone corrects the language
  // within seconds regardless).
  if (/[ãõçâêôáéíóúà]/.test(s)) return true;
  // A short list of ubiquitous pt-BR function words that essentially never
  // appear in English prose (word-boundary matched to avoid false hits on
  // substrings of unrelated English words).
  return /\b(você|voce|não|nao|está|esta|isso|preciso|também|tambem|obrigad[oa]|por favor|ol[aá])\b/.test(
    s
  );
}

/** "3" when min===max, "3-5" (or "3 a 5" in pt) otherwise. */
function describeModelRange(min: number, max: number, pt: boolean): string {
  if (max <= min) return String(min);
  return pt ? `${min} a ${max}` : `${min}-${max}`;
}

/**
 * Build the zero-latency opening narration line for a just-resolved strategy.
 * Pure and synchronous — safe to call from a hot path with no perf concern.
 *
 * @param strategy Strategy metadata (name/displayName/minModels/maxModels).
 * @param userSample A short sample of the user's own text (e.g. from
 *   `ObserverService.extractUserSample`), used ONLY for the pt/en guess above.
 */
export function buildImmediateOpeningNarration(
  strategy: OpeningStrategyInfo,
  userSample?: string
): string {
  const label = strategy.displayName?.trim() || strategy.name;
  const min = Math.max(1, strategy.minModels ?? 1);
  const max = Math.max(min, strategy.maxModels ?? min);
  const pt = looksLikePortuguese(userSample ?? '');
  const range = describeModelRange(min, max, pt);
  const isSingular = min === 1 && max === 1;

  if (pt) {
    const modelWord = isSingular ? 'modelo' : 'modelos';
    return `Iniciando a estratégia "${label}" com ${range} ${modelWord} de IA trabalhando na sua resposta.`;
  }
  const modelWord = isSingular ? 'model' : 'models';
  return `Starting the "${label}" strategy with ${range} AI ${modelWord} working on your answer.`;
}
