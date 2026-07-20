// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Video-generation intent opt-out for scoring/judge requests (review TS-01).
 *
 * The experiment judge reuses the public /v1/chat/completions path, so every
 * production interceptor — including video generation — runs during scoring. A
 * canvas regime's rubric mentions "clip"/"render"/"create", and a scored HTML
 * response mentions "render"/"make": without an opt-out, the judge call was
 * rerouted into (costly, wrong) video generation, and the video JSON became a
 * fabricated 1.0 score. `disable_media_generation: true` closes that hole.
 */
import { describe, it, expect } from 'vitest';
import { detectVideoGenerationIntent } from '../chat-request-processor';
import type { ChatRequest } from '@/types';

function req(text: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: text }],
    ...extra,
  } as ChatRequest;
}

// A prompt that WOULD trigger the video interceptor (keyword + generation verb,
// no dev context) — this is the shape a canvas judge rubric can accidentally hit.
const VIDEO_TRIGGER = 'Please create a short animation clip of a bouncing ball';

describe('detectVideoGenerationIntent', () => {
  it('detects a genuine video-generation request (baseline — the interceptor still works)', () => {
    expect(detectVideoGenerationIntent(req(VIDEO_TRIGGER))).not.toBeNull();
  });

  it('returns null when disable_media_generation is set (scoring/judge opt-out)', () => {
    expect(
      detectVideoGenerationIntent(req(VIDEO_TRIGGER, { disable_media_generation: true })),
    ).toBeNull();
  });

  it('opt-out wins even when conditioning media would otherwise force generation', () => {
    const withImage = req(VIDEO_TRIGGER, {
      disable_media_generation: true,
      // an image field would normally set hasConditioningMedia = true
      ...(({ image: 'https://example.com/frame.png' } as unknown) as Partial<ChatRequest>),
    });
    expect(detectVideoGenerationIntent(withImage)).toBeNull();
  });
});
