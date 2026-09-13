// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Streaming media-generation redirect gate — behavioral coverage (2026-09-07).
 *
 * See the sibling `streaming-media-gate-modality-structural.test.ts` for the
 * full root-cause writeup and why the structural/behavioral split exists.
 *
 * This file exercises `detectStreamingMediaGateModality`, the real, exported
 * decision function `handleStreamingRequest` calls (same extraction +
 * inference + classification pipeline as the route — no reimplementation),
 * against realistic image/video/audio/file prompts. It requires actually
 * importing `chat-routes.ts`, exactly like the pre-existing
 * `streaming-media-gate-text-extraction.test.ts` — in a dev sandbox with an
 * incomplete node_modules that can fail to load (observed: a missing
 * `@anthropic-ai/sdk` breaks the whole provider-adapter import graph
 * chat-routes.ts pulls in), but is unaffected in a clean install (CI).
 */
import { describe, it, expect } from 'vitest';
import {
  detectStreamingMediaGateModality,
  detectStreamingMediaGateModalities,
} from '../chat-routes';
import type { ChatMessage } from '@/types';

function userTurn(text: string): ChatMessage[] {
  return [{ role: 'user', content: text }];
}

describe('detectStreamingMediaGateModality — behavioral coverage across all four modalities', () => {
  it('classifies an image-generation request as "image"', () => {
    const modality = detectStreamingMediaGateModality({
      messages: userTurn('Please generate an image of a red bicycle'),
    });
    expect(modality).toBe('image');
  });

  it('classifies a video-generation request as "video"', () => {
    const modality = detectStreamingMediaGateModality({
      messages: userTurn('Please generate a video of a sunset over the ocean'),
    });
    expect(modality).toBe('video');
  });

  it('classifies an audio-generation request as "audio"', () => {
    const modality = detectStreamingMediaGateModality({
      messages: userTurn('Please generate audio narration of this poem'),
    });
    expect(modality).toBe('audio');
  });

  it('classifies a file-generation request as "file" (pre-existing coverage, unchanged)', () => {
    const modality = detectStreamingMediaGateModality({
      messages: userTurn('Please generate a pdf report of the Q3 results'),
    });
    expect(modality).toBe('file');
  });

  it('classifies an ordinary chat request as null (no redirect)', () => {
    const modality = detectStreamingMediaGateModality({
      messages: userTurn('Explain how diffusion models work'),
    });
    expect(modality).toBeNull();
  });

  it('every non-null modality would satisfy the widened gate condition ( !== null )', () => {
    const prompts = [
      'generate an image of a mountain',
      'generate a video of a dog running',
      'generate audio of a bell ringing',
      'generate a csv of last month sales',
    ];
    for (const prompt of prompts) {
      const modality = detectStreamingMediaGateModality({ messages: userTurn(prompt) });
      expect(modality).not.toBeNull();
      // The OLD gate (`=== 'file'`) would have missed 3 of these 4 prompts —
      // this is the exact behavioral gap the fix closes.
    }
  });
});

/**
 * LOTE AT PR4 (2026-09-07): `detectStreamingMediaGateModalities`, the
 * observability-only plural sibling used for the redirect log line. Does
 * NOT change the redirect gate's own behavior — see its doc comment in
 * chat-routes.ts.
 */
describe('detectStreamingMediaGateModalities — plural (observability) coverage', () => {
  it('reports a single-element set for a single-modality request', () => {
    const modalities = detectStreamingMediaGateModalities({
      messages: userTurn('Please generate an image of a red bicycle'),
    });
    expect(modalities).toEqual(new Set(['image']));
  });

  it('reports every distinct modality for a composite request', () => {
    const modalities = detectStreamingMediaGateModalities({
      messages: userTurn(
        'Please generate an image of a rocket and generate a video of it launching'
      ),
    });
    expect(modalities).toEqual(new Set(['image', 'video']));
  });

  it('reports an empty set for an ordinary chat request', () => {
    const modalities = detectStreamingMediaGateModalities({
      messages: userTurn('Explain how diffusion models work'),
    });
    expect(modalities).toEqual(new Set());
  });
});
