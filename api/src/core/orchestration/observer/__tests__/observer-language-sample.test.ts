// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Observer language mirroring — regression locks (2026-07-02).
 *
 * Two bugs, both fixed here:
 *
 *  1. extractUserSample() only matched string content. Live, the chat pipeline
 *     delivers the user message as OpenAI content-parts (an ARRAY of
 *     { type: 'text', text }), so the sample came back '' → the narrator fell to
 *     the no-sample branch → English narration for every non-English user.
 *
 *  2. A SYSTEM-prompt language instruction did not reliably steer the small narrator
 *     model against a rich English event: "forceful / never narrate in English"
 *     pushed English-target users to German/Chinese; "gentle" let English events pull
 *     non-English users back to English. The fix injects the user's own request into
 *     the narration USER turn ("My request: …") so the model mirrors the conversation
 *     language — 8/8 across pt-BR, en-US, it-IT, ru-RU against a rich English event.
 */
import { describe, it, expect } from 'vitest';
import { ObserverService } from '../observer-service';
import { mirrorLanguageFromSample } from '../../prompts/language-directive';
import { OBSERVER_PROMPTS } from '../observer-prompts';

describe('ObserverService.extractUserSample', () => {
  it('returns the string content of the last user message', () => {
    const sample = ObserverService.extractUserSample([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'Por que o céu é azul?' },
    ]);
    expect(sample).toBe('Por que o céu é azul?');
  });

  it('extracts text from OpenAI content-parts arrays (the live shape)', () => {
    // This is the shape that reaches the observer wiring in production and used
    // to yield '' — the root cause of English-only narration.
    const sample = ObserverService.extractUserSample([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Perché il cielo è azzurro?' },
        ] as unknown,
      },
    ]);
    expect(sample).toBe('Perché il cielo è azzurro?');
  });

  it('joins multiple text parts and ignores non-text parts', () => {
    const sample = ObserverService.extractUserSample([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:...' } },
          { type: 'text', text: '¿Por qué el cielo' },
          { type: 'text', text: 'es azul?' },
        ] as unknown,
      },
    ]);
    expect(sample).toBe('¿Por qué el cielo es azul?');
  });

  it('prefers the most recent user message (language can switch mid-chat)', () => {
    const sample = ObserverService.extractUserSample([
      { role: 'user', content: 'first question in English' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'segunda pergunta em português' },
    ]);
    expect(sample).toBe('segunda pergunta em português');
  });

  it('returns empty string for image-only / text-less user turns', () => {
    const sample = ObserverService.extractUserSample([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:...' } }] as unknown,
      },
    ]);
    expect(sample).toBe('');
  });
});

describe('mirrorLanguageFromSample — user-turn language anchor', () => {
  it('embeds the user sample as a "My request" prefix so the model mirrors it', () => {
    const prefix = mirrorLanguageFromSample('Perché il cielo è azzurro?');
    expect(prefix).toContain('My request: "Perché il cielo è azzurro?"');
    expect(prefix.toLowerCase()).toContain('reply in my language');
  });

  it('does NOT use the anti-English framing that caused language drift', () => {
    // The regression: telling the model to NEVER narrate in English / IGNORE the
    // metadata's language broke the English-target case.
    for (const prefix of [
      mirrorLanguageFromSample('Why is the sky blue?'),
      mirrorLanguageFromSample('Por que o céu é azul?'),
    ]) {
      expect(prefix.toLowerCase()).not.toContain('never narrate in english');
      expect(prefix.toLowerCase()).not.toContain('ignore');
    }
  });

  it('returns empty string for a text-less sample (system line still asks for the language)', () => {
    expect(mirrorLanguageFromSample('')).toBe('');
    expect(mirrorLanguageFromSample(undefined)).toBe('');
  });

  it('strips code fences from the sample so English code does not skew the signal', () => {
    const prefix = mirrorLanguageFromSample(
      'Explique este erro:\n```\nTypeError: undefined is not a function\n```',
    );
    expect(prefix).toContain('Explique este erro:');
    expect(prefix).not.toContain('TypeError');
  });
});

describe('OBSERVER_PROMPTS wiring', () => {
  const event = { type: 'round_start', models: ['a', 'b', 'c'], round: 1, totalRounds: 2 };

  it('system prompt asks the model to mirror the language of the next message', () => {
    const sys = OBSERVER_PROMPTS.system('debate');
    expect(sys.toLowerCase()).toContain('same language as the user');
    expect(sys).toContain('"debate"');
  });

  it('eventPrompt injects the sample as a user-turn prefix when provided', () => {
    const prompt = OBSERVER_PROMPTS.eventPrompt(event, 'Por que o céu é azul?');
    expect(prompt.startsWith('My request: "Por que o céu é azul?"')).toBe(true);
    expect(prompt).toContain('Event type: round_start');
  });

  it('eventPrompt falls back to a plain prompt when no sample is available', () => {
    const prompt = OBSERVER_PROMPTS.eventPrompt(event);
    expect(prompt.startsWith('Narrate this event:')).toBe(true);
    expect(prompt).not.toContain('My request:');
  });
});
