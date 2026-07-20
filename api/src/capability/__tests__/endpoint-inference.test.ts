// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests pinning the capability → endpoint heuristic.
 *
 * The heuristic is the only thing standing between a discovered model and its
 * runtime API surface. If `inferEndpoint` returns 'chat_completions' for an
 * image model, the orchestrator will call POST /v1/chat/completions on a
 * provider that only accepts /v1/images — a 404 visible to the end user.
 *
 * These tests exist because the heuristic was historically in the fetcher base
 * class only; the central-discovery-service now consumes it from this module
 * to normalize every persisted row. Both consumers MUST agree on semantics, so
 * we pin the rules here rather than in fetcher-specific tests.
 */

import { describe, expect, it } from 'vitest';
import { inferEndpoint, withInferredEndpoint } from '@/capability/endpoint-inference';

describe('inferEndpoint', () => {
  describe('explicit metadata.endpoint wins', () => {
    it('returns the metadata value when it is a non-empty string', () => {
      expect(inferEndpoint(['chat'], { endpoint: 'custom' })).toBe('custom');
      expect(inferEndpoint(['image_generation'], { endpoint: 'chat_completions' })).toBe('chat_completions');
    });

    it('falls back to heuristic when metadata.endpoint is empty/whitespace', () => {
      expect(inferEndpoint(['image_generation'], { endpoint: '' })).toBe('images');
      expect(inferEndpoint(['image_generation'], { endpoint: '   ' })).toBe('images');
    });

    it('falls back to heuristic when metadata.endpoint is not a string', () => {
      expect(inferEndpoint(['image_generation'], { endpoint: 42 })).toBe('images');
      expect(inferEndpoint(['image_generation'], { endpoint: null })).toBe('images');
      expect(inferEndpoint(['image_generation'], { endpoint: undefined })).toBe('images');
    });
  });

  describe('capability → endpoint priority order', () => {
    it('image_generation → images (highest specificity)', () => {
      expect(inferEndpoint(['image_generation', 'function_calling'])).toBe('images');
    });

    it.each([
      ['video_generation'],
      ['image_to_video'],
      ['video_to_video'],
    ])('%s → videos', (cap) => {
      expect(inferEndpoint([cap])).toBe('videos');
    });

    it('text_to_speech → audio_speech', () => {
      expect(inferEndpoint(['text_to_speech'])).toBe('audio_speech');
    });

    it.each([
      ['speech_to_text'],
      ['transcription'],
      ['video_transcription'],
    ])('%s → audio_transcriptions', (cap) => {
      expect(inferEndpoint([cap])).toBe('audio_transcriptions');
    });

    it('realtime → realtime', () => {
      expect(inferEndpoint(['realtime'])).toBe('realtime');
    });

    it('function_calling + premium tier → responses (gated by tier)', () => {
      expect(inferEndpoint(['function_calling'], { tier: 'premium' })).toBe('responses');
    });

    it('function_calling without premium tier does NOT route to responses', () => {
      expect(inferEndpoint(['function_calling'])).toBe('chat_completions');
      expect(inferEndpoint(['function_calling'], { tier: 'standard' })).toBe('chat_completions');
    });

    it('embedding → embeddings', () => {
      expect(inferEndpoint(['embedding'])).toBe('embeddings');
    });

    it('completions → completions (legacy)', () => {
      expect(inferEndpoint(['completions'])).toBe('completions');
    });

    it('default fallback for chat-only or empty caps → chat_completions', () => {
      expect(inferEndpoint(['chat'])).toBe('chat_completions');
      expect(inferEndpoint([])).toBe('chat_completions');
      expect(inferEndpoint(['vision', 'streaming'])).toBe('chat_completions');
    });
  });
});

describe('withInferredEndpoint', () => {
  it('preserves an explicitly-set endpoint and does not mutate input', () => {
    const input = { endpoint: 'images', other: 1 };
    const out = withInferredEndpoint(input, ['chat']);
    expect(out.endpoint).toBe('images');
    // Input is never mutated. (We may return the same reference when no
    // change is needed — that's an intentional perf choice in the hot path.)
    expect(input).toEqual({ endpoint: 'images', other: 1 });
  });

  it('returns a fresh object when filling endpoint (does not mutate input)', () => {
    const input: Record<string, unknown> = { source: 'native' };
    const out = withInferredEndpoint(input, ['embedding']);
    expect(out).not.toBe(input);
    expect(input.endpoint).toBeUndefined();
    expect(out.endpoint).toBe('embeddings');
  });

  it('fills the endpoint from heuristic when missing', () => {
    const out = withInferredEndpoint({ source: 'native' }, ['embedding']);
    expect(out.endpoint).toBe('embeddings');
    expect(out.source).toBe('native');
  });

  it('treats empty/whitespace endpoint as missing', () => {
    expect(withInferredEndpoint({ endpoint: '' }, ['image_generation']).endpoint).toBe('images');
    expect(withInferredEndpoint({ endpoint: '  ' }, ['video_generation']).endpoint).toBe('videos');
  });
});
