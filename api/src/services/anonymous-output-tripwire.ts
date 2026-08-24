// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Anonymous-output tripwire — output-side backstop for the anonymous chat
 * path ONLY (ailin.chat guests over the dedicated guest key).
 *
 * WHY this exists: the behavioral-guardrails system directive
 * (prompts/behavioral-guardrails.ts) is the PRIMARY control keeping cheap
 * pool models (small community/roleplay models routed by ailin-economy)
 * respectful. But prompt adherence is probabilistic — an 8B model with weak
 * instruction-following can still emit a slur under adversarial pressure.
 * The 2026-08-20 incident (anonymous visitor called "vadia") was exactly
 * this failure mode, before the guardrail existed.
 *
 * This module is the cheap second layer: a NARROW, high-precision deny list
 * of unambiguous pt-BR/en slurs and directed insults checked against the
 * final response text. On match, the anonymous response is replaced with a
 * safe refusal and the event is logged (category only — never the text) for
 * investigation via the anonymous_chat_logs table.
 *
 * Design constraints:
 * - INTENTIONALLY narrow: only terms with essentially no legitimate use in
 *   a normal assistant reply. Word-boundary regexes (after diacritics are
 *   stripped) so "reputação"→"reputacao" does NOT match "puta".
 * - Low recall is acceptable: this is a backstop, not moderation. The
 *   guardrail directive remains the primary control; pool restriction
 *   remains the escalation tier.
 * - Authenticated/paid traffic NEVER passes through this check — only
 *   requests carrying `ailin_anonymous_context` do (see chat-routes.ts).
 */

/** Normalize for matching: lowercase + strip diacritics + collapse whitespace. */
function normalizeForMatching(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Deny list. Each entry: [word-boundary regex source, category].
 * Kept as plain words + \b anchors; regexes are built once, cached.
 */
const DENY_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  // pt-BR gendered slurs / directed insults — the incident class
  ['vadia', 'pt_br_slur'],
  ['vadio', 'pt_br_slur'],
  ['vagabunda', 'pt_br_slur'],
  ['putinha', 'pt_br_slur'],
  ['putinho', 'pt_br_slur'],
  ['puta', 'pt_br_slur'],
  ['puto', 'pt_br_slur'],
  ['piranha', 'pt_br_slur'],
  ['fdp', 'pt_br_slur'],
  ['desgraçada', 'pt_br_slur'], // diacritics stripped at match time
  ['desgracada', 'pt_br_slur'],
  // en
  ['bitch', 'en_slur'],
  ['whore', 'en_slur'],
  ['slut', 'en_slur'],
  ['cunt', 'en_slur'],
];

const DENY_PATTERNS: ReadonlyArray<{ re: RegExp; category: string }> = DENY_ENTRIES.map(
  ([word, category]) => ({
    // \b on both sides; the word itself has no regex metacharacters by
    // construction (maintained list above).
    re: new RegExp(`\\b${word}\\b`),
    category,
  })
);

export interface AnonymousOutputViolation {
  category: string;
}

/**
 * Check a piece of response text for deny-list violations. Returns the first
 * match's category, or null. Pure function — safe to call per streaming
 * chunk (callers should pass accumulated text + new delta to also catch
 * terms split across chunk boundaries).
 */
export function anonymousOutputViolation(text: string): AnonymousOutputViolation | null {
  if (!text) return null;
  const normalized = normalizeForMatching(text);
  for (const { re, category } of DENY_PATTERNS) {
    if (re.test(normalized)) {
      return { category };
    }
  }
  return null;
}

/** Safe refusal emitted in place of the violating response. */
export const ANONYMOUS_TRIPWIRE_REFUSAL =
  'Não posso continuar essa resposta. Posso ajudar com outra coisa?';

/**
 * Number of trailing characters of previously-checked text a caller should
 * re-include when checking a new streaming delta, so a slur split across a
 * chunk boundary (e.g. "va" | "dia") is still caught. Longest deny entry
 * plus slack.
 */
export const ANONYMOUS_TRIPWIRE_OVERLAP_CHARS = 32;
