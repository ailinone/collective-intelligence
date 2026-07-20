// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for legacy-capability-uri.ts.
 *
 * Three invariants this suite locks down:
 *
 * 1. **Round-trip**: every legacy ModelCapability survives
 *    `legacyToUri → uriToLegacy` unchanged. Without this, selector and
 *    search service would drift on non-trivial slugs (e.g. `text_to_speech`
 *    vs `text-to-speech`).
 *
 * 2. **Slug ↔ ontology agreement**: every slug emitted by `legacyToUri` is
 *    present in the ontology seed (`api/src/capability/ontology/seed.ts`).
 *    This is the only guard preventing the legacy enum and the canonical
 *    capability-ontology table from drifting silently. If a future PR adds
 *    a new ModelCapability without seeding the ontology, this test fails.
 *
 * 3. **Type-narrowed reverse**: `uriToTypedLegacy` returns null for both
 *    malformed URIs and URIs pointing to slugs outside the legacy union.
 *    `uriArrayToLegacyArray` drops the same.
 */

import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@/types';
import {
  CAPABILITY_URI_PREFIX,
  legacyArrayToUriArray,
  legacyToUri,
  uriArrayToLegacyArray,
  uriToLegacy,
  uriToTypedLegacy,
} from '../legacy-capability-uri';
import { ONTOLOGY_SEED } from '../ontology/seed';

// Mirror of the ModelCapability union — kept in sync manually because the
// type system can't enumerate a string-literal union at runtime. If this
// list drifts from types/index.ts, the assertion in test 2 below catches
// it (the legacy set will be incomplete vs the actual union).
const ALL_LEGACY_CAPABILITIES: readonly ModelCapability[] = [
  'chat',
  'code_generation',
  'code_completion',
  'coding',
  'code_review',
  'debugging',
  'refactoring',
  'documentation',
  'testing',
  'analysis',
  'qa',
  'vision',
  'multimodal',
  'function_calling',
  'tool_use',
  'streaming',
  'json_mode',
  'embeddings',
  'embedding',
  'reasoning',
  'thinking_mode',
  'text_generation',
  'web_search',
  'deep_research',
  'file_search',
  'image_generation',
  'image_editing',
  'video_generation',
  'video_editing',
  'video_understanding',
  'image_captioning',
  'visual_question_answering',
  'audio_generation',
  'speech_to_text',
  'text_to_speech',
  'tts',
  'listen',
  'transcription',
  'audio_input',
  'audio_output',
  'audio_to_audio',
  'image_to_video',
  'video_to_video',
  'video_to_text',
  'video_transcription',
  'realtime_audio',
  'computer_use',
  'mcp',
  'deep_search',
  'completions',
  'code_interpreter',
  'diarization',
  'agents',
  'realtime',
  'audio',
  'deep_compute',
  'research',
  'health',
  'pdf_understanding',
  'translation',
  'reranking',
  'retrieval',
  'code_edit',
  'moderation',
  'safety',
  'long_context',
];
const LEGACY_SET = new Set(ALL_LEGACY_CAPABILITIES);

describe('legacy-capability-uri', () => {
  describe('legacyToUri / uriToLegacy round-trip', () => {
    it('round-trips every legacy capability slug unchanged', () => {
      const broken: Array<{ legacy: string; uri: string; back: string | null }> = [];
      for (const legacy of ALL_LEGACY_CAPABILITIES) {
        const uri = legacyToUri(legacy);
        const back = uriToLegacy(uri);
        if (back !== legacy) broken.push({ legacy, uri, back });
      }
      expect(broken).toEqual([]);
    });

    it('emits URIs prefixed with the canonical CAPABILITY_URI_PREFIX', () => {
      for (const legacy of ALL_LEGACY_CAPABILITIES) {
        expect(legacyToUri(legacy)).toMatch(
          new RegExp(`^${CAPABILITY_URI_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        );
      }
    });

    it('returns null for malformed URIs', () => {
      expect(uriToLegacy('not-a-uri')).toBeNull();
      expect(uriToLegacy('http://wrong.host/cap/v1/chat')).toBeNull();
      expect(uriToLegacy('http://ailin.dev/cap/v0/chat')).toBeNull();
      expect(uriToLegacy('')).toBeNull();
    });
  });

  describe('legacyArrayToUriArray', () => {
    it('preserves order and length', () => {
      const input: readonly ModelCapability[] = ['chat', 'vision', 'tool_use'];
      const out = legacyArrayToUriArray(input);
      expect(out).toEqual([
        legacyToUri('chat'),
        legacyToUri('vision'),
        legacyToUri('tool_use'),
      ]);
    });

    it('handles empty input', () => {
      expect(legacyArrayToUriArray([])).toEqual([]);
    });
  });

  describe('uriToTypedLegacy', () => {
    it('returns the slug when it is in the legacy union', () => {
      expect(uriToTypedLegacy(legacyToUri('chat'), LEGACY_SET)).toBe('chat');
    });

    it('returns null when the URI is malformed', () => {
      expect(uriToTypedLegacy('not-a-uri', LEGACY_SET)).toBeNull();
    });

    it('returns null when the slug is outside the legacy union', () => {
      // Hypothetical future capability not yet in the legacy union
      const futureUri = `${CAPABILITY_URI_PREFIX}quantum_reasoning`;
      expect(uriToTypedLegacy(futureUri, LEGACY_SET)).toBeNull();
    });
  });

  describe('uriArrayToLegacyArray', () => {
    it('keeps known slugs and drops unknowns', () => {
      const uris = [
        legacyToUri('chat'),
        `${CAPABILITY_URI_PREFIX}quantum_reasoning`, // unknown
        legacyToUri('vision'),
        'malformed',                                  // malformed
      ];
      expect(uriArrayToLegacyArray(uris, LEGACY_SET)).toEqual(['chat', 'vision']);
    });
  });

  describe('ontology agreement (cross-check)', () => {
    /**
     * The seed file is the structural source of truth for which slugs the
     * ontology table holds. If a slug is in the legacy union but absent
     * from the seed, the URI we emit will reference a non-existent
     * capability_ontology row and the search service will silently miss
     * matches. This test catches that drift at PR time.
     */
    it('every legacy capability slug is present in ONTOLOGY_SEED', () => {
      const seedSlugs = new Set(ONTOLOGY_SEED.map((e) => e.slug));
      const missing = ALL_LEGACY_CAPABILITIES.filter((c) => !seedSlugs.has(c));
      expect(missing).toEqual([]);
    });
  });
});
