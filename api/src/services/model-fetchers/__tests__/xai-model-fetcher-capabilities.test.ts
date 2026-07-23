// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { XAIModelFetcher } from '@/services/model-fetchers/xai-model-fetcher';

/**
 * Regression tests for xAI capability tagging.
 *
 * xAI's /v1/models lists non-chat model classes (Grok Imagine image/video
 * generation, computer-use/build agents) alongside chat models with no
 * modality field to distinguish them. The fetcher previously tagged EVERY
 * listed model 'chat' unconditionally, which let these leak into chat-only
 * candidate pools (e.g. CostCascadeStrategy) — observed live in the
 * ailin-humaneval experiment (2026-07-23) as near-zero cost_usd cascade
 * rungs for grok-imagine-image, grok-imagine-video, grok-imagine-video-1.5-
 * preview, grok-build-0.1, and snowball-computer-use-no-safety.
 */

type FakeModel = { id: string };

function capabilitiesFor(modelId: string): string[] {
  const fetcher = new XAIModelFetcher('sk-real-key');
  return fetcher['extractCapabilitiesFromXAI']({ id: modelId } as FakeModel as never);
}

describe('xai-model-fetcher capability tagging', () => {
  it('does NOT tag Grok Imagine image/video models as chat', () => {
    for (const id of ['grok-imagine-image', 'grok-imagine-video', 'grok-imagine-video-1.5-preview']) {
      const caps = capabilitiesFor(id);
      expect(caps, id).not.toContain('chat');
      expect(caps, id).not.toContain('streaming');
      expect(caps, id).not.toContain('function_calling');
    }
    expect(capabilitiesFor('grok-imagine-image')).toContain('image_generation');
    expect(capabilitiesFor('grok-imagine-video')).toContain('video_generation');
  });

  it('does NOT tag the computer-use agent model as chat', () => {
    const caps = capabilitiesFor('grok-2-computer-use');
    expect(caps).not.toContain('chat');
    expect(caps).toContain('computer_use');
  });

  it('does NOT tag the Grok build/agentic-coding model as chat', () => {
    const caps = capabilitiesFor('grok-build-0.1');
    expect(caps).not.toContain('chat');
    expect(caps).not.toContain('streaming');
  });

  it('still tags real Grok chat models as chat, with reasoning + vision where applicable', () => {
    expect(capabilitiesFor('grok-4-fast')).toEqual(
      expect.arrayContaining(['chat', 'streaming', 'function_calling', 'json_mode', 'reasoning', 'thinking_mode']),
    );
    const grok2 = capabilitiesFor('grok-2-1212');
    expect(grok2).toContain('chat');
    expect(grok2).toContain('vision');
    expect(grok2).toContain('multimodal');
  });
});
