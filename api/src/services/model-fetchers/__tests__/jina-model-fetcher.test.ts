// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';
import { JinaModelFetcher } from '@/services/model-fetchers/jina-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('jina-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns conservative seed models when API key is missing', async () => {
    const fetcher = new JinaModelFetcher({
      apiKey: '',
      seedModels: ['jina-deepsearch-v1', 'jina-embeddings-v3'],
    });

    const models = await fetcher.getModels();

    expect(models).toHaveLength(2);
    const deepsearch = models.find((model) => model.id === 'jina-deepsearch-v1');
    const embeddings = models.find((model) => model.id === 'jina-embeddings-v3');

    expect(deepsearch?.capabilities).toContain('chat');
    expect(deepsearch?.capabilities).toContain('deep_search');
    expect(embeddings?.capabilities).toContain('embeddings');
    expect(embeddings?.capabilities).toContain('embedding');
  });

  it('merges discovered models with seed set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'jina-embeddings-v3',
            display_name: 'Jina Embeddings V3',
            context_window: 16384,
            max_output_tokens: 2048,
            capabilities: ['embeddings', 'embedding'],
          },
          {
            id: 'jina-clip-v2',
            display_name: 'Jina CLIP V2',
            context_window: 8192,
            max_output_tokens: 1024,
            capabilities: ['embedding'],
          },
        ],
      })
    );

    const fetcher = new JinaModelFetcher({
      apiKey: 'jina-live-key',
      apiBaseUrl: 'https://api.jina.ai/v1',
      seedModels: ['jina-deepsearch-v1', 'jina-embeddings-v3'],
    });

    const models = await fetcher.getModels();

    expect(models.find((model) => model.id === 'jina-deepsearch-v1')).toBeTruthy();
    expect(models.find((model) => model.id === 'jina-embeddings-v3')?.displayName).toBe(
      'Jina Embeddings V3'
    );
    expect(models.find((model) => model.id === 'jina-clip-v2')).toBeTruthy();
  });
});

