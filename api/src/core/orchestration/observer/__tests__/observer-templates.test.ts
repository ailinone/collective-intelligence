// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * buildImmediateOpeningNarration — the zero-latency, template-built opening
 * line (Gap 2, "narrate from the very beginning"). Pure/synchronous: no
 * network, no LLM, no `await` anywhere in this module.
 */
import { describe, it, expect } from 'vitest';
import { buildImmediateOpeningNarration } from '../observer-templates';

describe('buildImmediateOpeningNarration', () => {
  it('is a pure synchronous function (not a Promise)', () => {
    const result = buildImmediateOpeningNarration({ name: 'consensus' }, 'hello');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('string');
  });

  it('defaults to English when there is no user sample', () => {
    const line = buildImmediateOpeningNarration({ name: 'debate', displayName: 'Debate' });
    expect(line).toContain('Starting the "Debate" strategy');
  });

  it('defaults to English for an English-looking sample', () => {
    const line = buildImmediateOpeningNarration(
      { name: 'debate', displayName: 'Debate' },
      'Why is the sky blue?'
    );
    expect(line).toContain('Starting the "Debate" strategy');
  });

  it('mirrors pt-BR when the sample carries pt-BR diacritics', () => {
    const line = buildImmediateOpeningNarration(
      { name: 'consensus', displayName: 'Consensus Building' },
      'Por que o céu é azul?'
    );
    expect(line).toContain('Iniciando a estratégia "Consensus Building"');
  });

  it('mirrors pt-BR via function-word signal even without diacritics', () => {
    const line = buildImmediateOpeningNarration(
      { name: 'consensus' },
      'voce pode me ajudar com isso'
    );
    expect(line.startsWith('Iniciando')).toBe(true);
  });

  it('falls back to the raw strategy name when displayName is absent', () => {
    const line = buildImmediateOpeningNarration({ name: 'tri-role-collective' });
    expect(line).toContain('"tri-role-collective"');
  });

  it('reports a single model count without a range (minModels === maxModels)', () => {
    const line = buildImmediateOpeningNarration({ name: 'x', minModels: 3, maxModels: 3 });
    expect(line).toContain('3 AI models');
    expect(line).not.toMatch(/3-3|3 a 3/);
  });

  it('reports a range when minModels !== maxModels', () => {
    const line = buildImmediateOpeningNarration({ name: 'consensus', minModels: 3, maxModels: 5 });
    expect(line).toContain('3-5 AI models');
  });

  it('reports a pt-BR range using "a" instead of a dash', () => {
    const line = buildImmediateOpeningNarration(
      { name: 'consensus', minModels: 3, maxModels: 5 },
      'não sei, você acha que vai funcionar?'
    );
    expect(line).toContain('3 a 5 modelos');
  });

  it('singularizes "model"/"modelo" when min===max===1', () => {
    const enLine = buildImmediateOpeningNarration({ name: 'single', minModels: 1, maxModels: 1 });
    expect(enLine).toContain('1 AI model ');
    expect(enLine).not.toContain('1 AI models');

    const ptLine = buildImmediateOpeningNarration(
      { name: 'single', minModels: 1, maxModels: 1 },
      'não consigo resolver isso'
    );
    expect(ptLine).toContain('1 modelo de IA');
    expect(ptLine).not.toContain('1 modelos');
  });

  it('treats missing minModels/maxModels as a single model (defaults to 1/1)', () => {
    const line = buildImmediateOpeningNarration({ name: 'single' });
    expect(line).toContain('1 AI model ');
  });

  it('never invokes the network/LLM path — pure string interpolation only', () => {
    // Regression guard: a future refactor that made this async (e.g. by
    // routing through ObserverService) would break every synchronous call
    // site that relies on emitting this BEFORE any await.
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      buildImmediateOpeningNarration({ name: 'consensus', minModels: 3, maxModels: 5 }, 'oi');
    }
    // 1000 calls of pure string work must be near-instant; a real network/LLM
    // call would blow this budget on a SINGLE call, let alone a thousand.
    expect(Date.now() - start).toBeLessThan(200);
  });
});
