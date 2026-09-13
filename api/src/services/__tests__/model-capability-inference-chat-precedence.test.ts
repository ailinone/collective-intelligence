// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression suite for the chat-eligibility PRECEDENCE defect.
 *
 * Measured in production (commit 25ee4d67): `inferModelCapabilities` decided
 * chat eligibility from a vendor-family name regex that ran unconditionally and
 * won. Two audio models matched it —
 *
 *   gemini-2.5-flash-preview-tts  → /\bgemini\b/
 *   Qwen/Qwen3-ASR-0.6B           → /\bqwen\b/
 *
 * — were persisted with ['chat','text_generation','streaming'], entered the chat
 * candidate pool and were selected to answer "17 x 23", contributing to a 29%
 * wrong-answer rate over 48 runs. The tts/asr classifier that would have caught
 * them only ran when the family regex matched NOTHING, so on these exact rows it
 * was unreachable.
 *
 * The fix inverts the order: declared modalities first, dedicated-specialisation
 * classification second, vendor-family name regex last. These tests pin that
 * order — each one fails against the pre-fix implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyDedicatedSpecialization,
  inferModelCapabilities,
  inferSupportedEndpoints,
} from '@/services/model-capability-inference';

const CHAT_CAPABILITIES = ['chat', 'text_generation', 'streaming'] as const;

describe('chat eligibility precedence', () => {
  describe('production regressions — audio models must never be chat', () => {
    it('does not classify gemini-2.5-flash-preview-tts as a chat model', () => {
      const capabilities = inferModelCapabilities({ modelId: 'gemini-2.5-flash-preview-tts' });

      for (const chatCapability of CHAT_CAPABILITIES) {
        expect(capabilities).not.toContain(chatCapability);
      }
      expect(capabilities).toContain('text_to_speech');
      expect(capabilities).toContain('tts');
    });

    it('routes gemini-2.5-flash-preview-tts to the speech endpoint, not chat', () => {
      const capabilities = inferModelCapabilities({ modelId: 'gemini-2.5-flash-preview-tts' });
      const endpoints = inferSupportedEndpoints(capabilities);

      expect(endpoints).toContain('audio_speech');
      expect(endpoints).not.toContain('chat_completions');
    });

    it('does not classify Qwen/Qwen3-ASR-0.6B as a chat model', () => {
      const capabilities = inferModelCapabilities({ modelId: 'Qwen/Qwen3-ASR-0.6B' });

      for (const chatCapability of CHAT_CAPABILITIES) {
        expect(capabilities).not.toContain(chatCapability);
      }
      expect(capabilities).toContain('speech_to_text');
      expect(capabilities).toContain('transcription');
    });

    it('routes Qwen/Qwen3-ASR-0.6B to the transcription endpoint, not chat', () => {
      const capabilities = inferModelCapabilities({ modelId: 'Qwen/Qwen3-ASR-0.6B' });
      const endpoints = inferSupportedEndpoints(capabilities);

      expect(endpoints).toContain('audio_transcriptions');
      expect(endpoints).not.toContain('chat_completions');
    });

    it('keeps the vendor-family name regex from resurrecting chat via description text', () => {
      // The family signal is read from the id AND the free-text description.
      // A vendor blurb naming the family must not re-admit a dedicated TTS SKU.
      const capabilities = inferModelCapabilities({
        modelId: 'gemini-2.5-flash-preview-tts',
        metadata: {
          description: 'Gemini 2.5 Flash preview, a chat assistant family model.',
        },
      });

      expect(capabilities).not.toContain('chat');
    });
  });

  describe('declared output modalities outrank the name heuristic', () => {
    it('refuses chat when declared outputs exclude text, even with text input', () => {
      // Pre-fix, `exclusiveNonChat` additionally required `!hasInputText`, so a
      // text-in/audio-out TTS model — the canonical shape — stayed "chat" as
      // soon as the id carried any vendor-family token.
      const capabilities = inferModelCapabilities({
        modelId: 'mistral/speech-model-v2',
        metadata: {
          architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
        },
      });

      expect(capabilities).not.toContain('chat');
      expect(capabilities).not.toContain('text_generation');
      expect(capabilities).toContain('text_to_speech');
    });

    it('declared text output still wins over a non-chat looking name', () => {
      // Real modality evidence is the STRONGEST signal in both directions: a
      // model that declares text output keeps chat even if its id looks niche.
      const capabilities = inferModelCapabilities({
        modelId: 'vendor/gemma-tts-analyst',
        metadata: {
          architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
        },
      });

      expect(capabilities).toContain('chat');
      expect(capabilities).toContain('text_generation');
    });
  });

  describe('provider declarations still outrank the heuristics', () => {
    it('keeps a provider-declared chat capability on an audio-named model', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'gemini-2.5-flash-preview-tts',
        seedCapabilities: ['chat'],
      });

      // Declared by the provider — this block only gates what the HEURISTICS
      // may add, it never strips a declaration.
      expect(capabilities).toContain('chat');
      // ...and the dedicated role is still recorded alongside it.
      expect(capabilities).toContain('tts');
    });
  });

  describe('chat models are unaffected', () => {
    it.each([
      'openai/gpt-4o',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-large',
      'deepseek/deepseek-chat',
      'qwen/qwen-2.5-72b-instruct',
    ])('still infers chat for %s', (modelId) => {
      const capabilities = inferModelCapabilities({ modelId });

      expect(capabilities).toContain('chat');
      expect(capabilities).toContain('text_generation');
      expect(capabilities).toContain('streaming');
    });

    it('keeps audio-capable chat models (text output declared) in the chat pool', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'openai/gpt-4o-audio-preview',
        metadata: {
          architecture: {
            input_modalities: ['text', 'audio'],
            output_modalities: ['text', 'audio'],
          },
        },
      });

      expect(capabilities).toContain('chat');
      expect(capabilities).toContain('audio');
    });
  });

  describe('classifyDedicatedSpecialization', () => {
    it('returns the dedicated role for non-chat ids', () => {
      expect(classifyDedicatedSpecialization('gemini-2.5-flash-preview-tts')?.modelType).toBe('tts');
      expect(classifyDedicatedSpecialization('Qwen/Qwen3-ASR-0.6B')?.modelType).toBe('stt');
      expect(classifyDedicatedSpecialization('text-embedding-3-large')?.modelType).toBe('embedding');
    });

    it('returns undefined for chat verdicts — a name table is not chat evidence', () => {
      expect(classifyDedicatedSpecialization('openai/gpt-4o')).toBeUndefined();
      expect(classifyDedicatedSpecialization('anthropic/claude-sonnet-4')).toBeUndefined();
    });

    it('returns undefined for ids it cannot classify', () => {
      expect(classifyDedicatedSpecialization('some-unknown-vendor/mystery-1')).toBeUndefined();
      expect(classifyDedicatedSpecialization(undefined)).toBeUndefined();
    });
  });
});
