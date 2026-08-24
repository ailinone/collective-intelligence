// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import {
  anonymousOutputViolation,
  ANONYMOUS_TRIPWIRE_REFUSAL,
  ANONYMOUS_TRIPWIRE_OVERLAP_CHARS,
} from '../anonymous-output-tripwire';

/**
 * Anonymous-output tripwire — narrow deny-list backstop for the anonymous
 * chat path. Two properties matter equally:
 *
 * 1. CATCHES the incident class: unambiguous pt-BR/en slurs, in any casing
 *    or diacritic variant, standalone or embedded in a sentence.
 * 2. Does NOT fire on legitimate text: word-boundary matching means common
 *    substrings ("reputação" contains "puta", "computed" contains "puto"
 *    after normalization... actually "computed"→no, but "reputacao" does)
 *    must pass through untouched. A false positive here replaces a perfectly
 *    good answer with a refusal on the FREE guest path — visible breakage.
 */
describe('anonymousOutputViolation', () => {
  describe('catches the incident class', () => {
    const violating: Array<[string, string]> = [
      ['Você é uma vadia', 'pt_br_slur'],
      ['vadia', 'pt_br_slur'],
      ['VADIA!', 'pt_br_slur'],
      ['sua putinha chata', 'pt_br_slur'],
      ['que puta que pariu', 'pt_br_slur'],
      ['você é um puto', 'pt_br_slur'],
      ['Filho da puta', 'pt_br_slur'],
      ['fdp', 'pt_br_slur'],
      ['you bitch', 'en_slur'],
      ['such a whore', 'en_slur'],
      ['slut', 'en_slur'],
      ['you cunt', 'en_slur'],
      // diacritics variant
      ['você é uma desgraçada', 'pt_br_slur'],
      ['piranha', 'pt_br_slur'],
    ];

    for (const [text, expectedCategory] of violating) {
      it(`flags "${text.slice(0, 24)}" (${expectedCategory})`, () => {
        const violation = anonymousOutputViolation(text);
        expect(violation).not.toBeNull();
        expect(violation!.category).toBe(expectedCategory);
      });
    }

    it('catches a slur split across the streaming overlap window', () => {
      // Simulates the fast-path check: previous text tail + new delta.
      const previousTail = 'Acho que você é uma va';
      const newDelta = 'dia mesmo.';
      expect(anonymousOutputViolation(previousTail.slice(-32) + newDelta)).not.toBeNull();
    });
  });

  describe('does not fire on legitimate text (false-positive guard)', () => {
    const legitimate = [
      'Sua reputação é excelente, posso ajudar com mais alguma coisa?',
      'A reputacao da empresa é sólida.',
      'Vou computar os valores e retornar o resultado.',
      'Put option é um tipo de derivativo financeiro.',
      'Bem-vindo ao Ailin Chat! Como posso ajudar hoje?',
      'Computação em nuvem permite escalar serviços.',
      'OPUTEK é uma marca registrada.', // all-caps substring, no word boundary
      'Can you explain how options work?',
      '',
    ];

    for (const text of legitimate) {
      it(`passes "${text.slice(0, 40)}"`, () => {
        expect(anonymousOutputViolation(text)).toBeNull();
      });
    }
  });

  it('exports a non-empty safe refusal', () => {
    expect(ANONYMOUS_TRIPWIRE_REFUSAL.length).toBeGreaterThan(10);
  });

  it('overlap window is at least as long as the longest deny entry', () => {
    // "desgraçada"/"desgracada" = 9 chars; 32 gives comfortable slack for
    // multi-word entries like "filho da puta" split across chunks.
    expect(ANONYMOUS_TRIPWIRE_OVERLAP_CHARS).toBeGreaterThanOrEqual(16);
  });
});
