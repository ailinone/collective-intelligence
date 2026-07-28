// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareWorkersAIModelFetcher } from '@/services/model-fetchers/cloudflare-workers-ai-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('cloudflare-workers-ai-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps the /ai/models/search v4 envelope into provider models, hitting the correct URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            name: '@cf/meta/llama-3-8b-instruct',
            description: 'Meta Llama 3 8B',
            task: { name: 'Text Generation' },
          },
          {
            name: '@cf/baai/bge-small-en-v1.5',
            description: 'BGE embeddings',
            task: { name: 'Text Embeddings' },
          },
        ],
      })
    );

    const fetcher = new CloudflareWorkersAIModelFetcher('cf-live-token', 'acct-123');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/models/search'
    );
    expect(models).toHaveLength(2);

    const chatModel = models.find((m) => m.id === '@cf/meta/llama-3-8b-instruct');
    const embedModel = models.find((m) => m.id === '@cf/baai/bge-small-en-v1.5');
    expect(chatModel?.capabilities).toContain('chat');
    expect(embedModel?.capabilities).toContain('embedding');
  });

  it('returns empty list when the token is missing', async () => {
    const fetcher = new CloudflareWorkersAIModelFetcher('', 'acct-123');
    const models = await fetcher.getModels();
    expect(models).toEqual([]);
  });

  it('returns empty list when the account id is missing, even with a valid token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const fetcher = new CloudflareWorkersAIModelFetcher('cf-live-token', '');
    const models = await fetcher.getModels();
    expect(models).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns empty list on a non-OK HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({}, 403));
    const fetcher = new CloudflareWorkersAIModelFetcher('cf-live-token', 'acct-123');
    const models = await fetcher.getModels();
    expect(models).toEqual([]);
  });

  it('returns empty list when the API envelope reports success:false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ success: false, errors: [{ code: 9109, message: 'Unauthorized' }] })
    );
    const fetcher = new CloudflareWorkersAIModelFetcher('cf-live-token', 'acct-123');
    const models = await fetcher.getModels();
    expect(models).toEqual([]);
  });
});
