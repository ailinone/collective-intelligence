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
      detectVideoGenerationIntent(req(VIDEO_TRIGGER, { disable_media_generation: true }))
    ).toBeNull();
  });

  it('opt-out wins even when conditioning media would otherwise force generation', () => {
    const withImage = req(VIDEO_TRIGGER, {
      disable_media_generation: true,
      // an image field would normally set hasConditioningMedia = true
      ...({ image: 'https://example.com/frame.png' } as unknown as Partial<ChatRequest>),
    });
    expect(detectVideoGenerationIntent(withImage)).toBeNull();
  });
});

describe('detectVideoGenerationIntent — in-message image is vision chat, not video (2026-08-19)', () => {
  const imageMsg = (text: string) =>
    ({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    }) as unknown as ChatRequest;

  it('does NOT reroute plain image chat (no video intent) to video generation', () => {
    expect(detectVideoGenerationIntent(imageMsg('What is in this image?'))).toBeNull();
  });

  it('does NOT reroute image chat with Portuguese text', () => {
    expect(detectVideoGenerationIntent(imageMsg('O que há nesta imagem?'))).toBeNull();
  });

  it('does NOT reroute image chat even with a generation verb but no video keyword', () => {
    expect(detectVideoGenerationIntent(imageMsg('Create a caption for this image'))).toBeNull();
  });

  it('DOES treat in-message image as conditioning when prompt asks for video', () => {
    const intent = detectVideoGenerationIntent(
      imageMsg('Generate a video animating this image')
    );
    expect(intent).not.toBeNull();
    expect(intent?.image).toBe('data:image/png;base64,AAAA');
  });

  it('explicit top-level image field still forces video early-path', () => {
    const intent = detectVideoGenerationIntent(
      req('anything', { image: 'https://example.com/frame.png' } as Partial<ChatRequest>)
    );
    expect(intent).not.toBeNull();
    expect(intent?.image).toBe('https://example.com/frame.png');
  });
});

describe('detectVideoGenerationIntent — discussion/comparison false positives (2026-08-04 audit)', () => {
  it('does NOT trigger on a comparison question naming video-model products', () => {
    // Real audit finding: "sora"/"veo" matched hasVideoKeyword and "create"
    // matched hasGenerationVerb, with none of hasDevContext's terms present —
    // this used to silently call the (mostly-broken) video generation path
    // instead of answering the user's actual question in text.
    expect(
      detectVideoGenerationIntent(req('Create a comparison of Sora vs Veo, which is better?'))
    ).toBeNull();
  });

  it('does NOT trigger on an explanatory/review question about a video tool', () => {
    expect(
      detectVideoGenerationIntent(req('Explain how Sora generates video and review its quality'))
    ).toBeNull();
  });

  it('does NOT trigger on the Portuguese equivalent comparison phrasing', () => {
    expect(
      detectVideoGenerationIntent(
        req('Qual a diferença entre gerar vídeo com Sora e Veo, e qual é melhor?')
      )
    ).toBeNull();
  });

  it('still triggers a genuine generation request that happens to name a model', () => {
    // The discussion-context guard must not become so broad it swallows real
    // requests — "using Sora" here is instructing HOW to generate, not asking
    // to compare/explain/review anything.
    expect(
      detectVideoGenerationIntent(req('Please create a short video of a sunset using Sora'))
    ).not.toBeNull();
  });
});
