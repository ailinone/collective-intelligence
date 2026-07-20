// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageRouterModelFetcher } from '@/services/model-fetchers/imagerouter-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('imagerouter-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps /v1/models payload into provider models', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'imagerouter/flux-pro',
            display_name: 'Flux Pro',
            task: 'image_generation',
            modalities: ['image'],
            input_cost_per_1m: 0.4,
            output_cost_per_1m: 0.8,
          },
          {
            id: 'imagerouter/video-gen-1',
            display_name: 'Video Gen 1',
            task: 'video_generation',
            modalities: ['video'],
          },
        ],
      })
    );

    const fetcher = new ImageRouterModelFetcher('imagerouter-live-key', 'https://api.imagerouter.io');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(2);

    const imageModel = models.find((model) => model.id === 'imagerouter/flux-pro');
    const videoModel = models.find((model) => model.id === 'imagerouter/video-gen-1');

    expect(imageModel?.capabilities).toContain('image_generation');
    expect(imageModel?.pricing.inputCostPer1M).toBe(0.4);
    expect(videoModel?.capabilities).toContain('video_generation');
    expect(videoModel?.metadata?.executionProvider).toBe('imagerouter');
  });

  it('returns empty list when API key is missing', async () => {
    const fetcher = new ImageRouterModelFetcher('', 'https://api.imagerouter.io');
    const models = await fetcher.getModels();
    expect(models).toEqual([]);
  });
});

