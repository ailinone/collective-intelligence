// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-ontology.test.ts — MVP 5A
 *
 * Proves:
 *   - normalize() resolves aliases to canonical ids.
 *   - get() returns the right definition for canonical AND alias inputs.
 *   - has() is true for both forms.
 *   - The ontology contains NO model-family names (gpt, claude, etc.).
 *   - The ontology table is alphabetically ordered for stability.
 */

import { describe, expect, it } from 'vitest';
import {
  __CAPABILITIES_TABLE,
  buildCapabilityOntology,
  capabilityOntology,
} from '../capability-ontology';

describe('capabilityOntology — normalize + lookup', () => {
  it('normalize maps a canonical id to itself (lowercased)', () => {
    expect(capabilityOntology.normalize('chat')).toBe('chat');
    expect(capabilityOntology.normalize('CHAT')).toBe('chat');
    expect(capabilityOntology.normalize('Chat')).toBe('chat');
  });

  it('normalize resolves common aliases to canonical ids', () => {
    expect(capabilityOntology.normalize('function_calling')).toBe('tools');
    expect(capabilityOntology.normalize('function-calling')).toBe('tools');
    expect(capabilityOntology.normalize('json')).toBe('json_mode');
    expect(capabilityOntology.normalize('json-mode')).toBe('json_mode');
    expect(capabilityOntology.normalize('image_understanding')).toBe('vision');
    expect(capabilityOntology.normalize('text_to_speech')).toBe('audio_generation');
    expect(capabilityOntology.normalize('chain_of_thought')).toBe('reasoning');
  });

  /**
   * Regression guard (LOTE AO, 2026-09-05). The table used to fold BOTH
   * audio directions into one `audio_generation` id, so a TTS request and a
   * transcription request normalised to the same string and nothing
   * downstream could tell them apart. They are now distinct canonical ids.
   */
  it('keeps the two audio DIRECTIONS as distinct canonical ids', () => {
    expect(capabilityOntology.normalize('text_to_speech')).toBe('audio_generation');
    expect(capabilityOntology.normalize('tts')).toBe('audio_generation');
    expect(capabilityOntology.normalize('audio_output')).toBe('audio_generation');

    expect(capabilityOntology.normalize('speech_to_text')).toBe('speech_to_text');
    expect(capabilityOntology.normalize('transcription')).toBe('speech_to_text');
    expect(capabilityOntology.normalize('asr')).toBe('speech_to_text');
    expect(capabilityOntology.normalize('audio_input')).toBe('audio_input');
    expect(capabilityOntology.normalize('listen')).toBe('audio_input');

    // Speech-to-speech is a third, separate thing.
    expect(capabilityOntology.normalize('audio_to_audio')).toBe('audio_to_audio');
    expect(capabilityOntology.normalize('speech_to_speech')).toBe('audio_to_audio');

    // `supportsAudio` is direction-agnostic, so all audio ids still share it
    // as their structural pre-filter — documented in the module header.
    for (const id of ['audio_generation', 'speech_to_text', 'audio_input', 'audio_to_audio']) {
      expect(capabilityOntology.get(id)?.routeFlag).toBe('supportsAudio');
    }
  });

  it('normalize returns the lowercased input when no match', () => {
    expect(capabilityOntology.normalize('UnknownCap')).toBe('unknowncap');
  });

  it('get resolves canonical AND alias inputs to the same definition', () => {
    const byCanonical = capabilityOntology.get('tools');
    const byAlias = capabilityOntology.get('function_calling');
    expect(byCanonical).toBeDefined();
    expect(byAlias).toBeDefined();
    expect(byAlias?.id).toBe(byCanonical?.id);
  });

  it('has returns true for known capabilities AND their aliases', () => {
    expect(capabilityOntology.has('chat')).toBe(true);
    expect(capabilityOntology.has('streaming')).toBe(true);
    expect(capabilityOntology.has('json')).toBe(true);
    expect(capabilityOntology.has('function-calling')).toBe(true);
    expect(capabilityOntology.has('chain-of-thought')).toBe(true);
  });

  it('has returns false for unknown capabilities', () => {
    expect(capabilityOntology.has('definitely-not-a-capability')).toBe(false);
  });

  it('all() returns the canonical definition table', () => {
    expect(capabilityOntology.all().length).toBe(__CAPABILITIES_TABLE.length);
    // Was 14 pre-LOTE-AO; the table now covers the whole catalog vocabulary.
    // Coverage itself is asserted in capability-ontology-coverage.test.ts.
    expect(capabilityOntology.all().length).toBeGreaterThanOrEqual(70);
  });
});

describe('capabilityOntology — no model family names', () => {
  it('canonical ids do NOT include any model family name', () => {
    const FAMILY_NAMES = [
      'gpt',
      'claude',
      'gemini',
      'kimi',
      'grok',
      'deepseek',
      'mistral',
      'llama',
      'qwen',
      'o1',
      'o3',
      'opus',
      'sonnet',
      'haiku',
    ];
    for (const def of capabilityOntology.all()) {
      for (const name of FAMILY_NAMES) {
        expect(def.id.toLowerCase()).not.toBe(name);
      }
    }
  });

  it('aliases do NOT include any model family name', () => {
    const FAMILY_NAMES = [
      'gpt',
      'claude',
      'gemini',
      'kimi',
      'grok',
      'deepseek',
      'mistral',
      'llama',
      'qwen',
    ];
    for (const def of capabilityOntology.all()) {
      for (const alias of def.aliases) {
        for (const name of FAMILY_NAMES) {
          expect(alias.toLowerCase()).not.toContain(name);
        }
      }
    }
  });
});

describe('capabilityOntology — stable ordering', () => {
  it('canonical table is alphabetical by id', () => {
    const ids = capabilityOntology.all().map((d) => d.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe('buildCapabilityOntology — test seam', () => {
  it('builds a custom ontology without touching the singleton', () => {
    const custom = buildCapabilityOntology([
      { id: 'custom_only', aliases: ['custom-only', 'custom'] },
    ]);
    expect(custom.has('custom_only')).toBe(true);
    expect(custom.normalize('custom')).toBe('custom_only');
    // The singleton is unaffected.
    expect(capabilityOntology.has('custom_only')).toBe(false);
  });
});
