// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression suite for silent substitution of a NON-EXISTENT model.
 *
 * Measured: `POST /v1/chat/completions` with
 * `"model": "definitely-not-a-real-model-xyz"` returned 200, answered by a
 * dynamically selected model. Nothing on the request path ever checked that the
 * pinned id exists — `single-model-strategy.ts` logs "User-specified model not
 * found in available models" and delegates to `DynamicModelSelector`, which
 * rewrites `request.model` to whatever it picked.
 *
 * These tests pin the boundary the guard draws: "does not exist anywhere" is an
 * error, everything else (auto, aliases, no pin, catalog unreachable) is not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findModelsByIdOrName = vi.fn();

vi.mock('@/services/model-repository', () => ({
  getModelRepository: () => ({ findModelsByIdOrName }),
}));

import {
  checkExplicitModelExists,
  getPinnedModelId,
  unknownModelErrorBody,
} from '@/services/explicit-model-guard';
import type { ChatRequest } from '@/types';

const chatRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    messages: [{ role: 'user', content: 'how much is 17 x 23?' }],
    ...overrides,
  }) as ChatRequest;

describe('explicit-model-guard', () => {
  beforeEach(() => {
    findModelsByIdOrName.mockReset();
  });

  describe('getPinnedModelId', () => {
    it('treats a client-written model id as a pin', () => {
      expect(getPinnedModelId(chatRequest({ model: 'anthropic/claude-sonnet-4' }))).toBe(
        'anthropic/claude-sonnet-4'
      );
    });

    it('treats auto, blank and absent models as no pin', () => {
      expect(getPinnedModelId(chatRequest({ model: 'auto' }))).toBeNull();
      expect(getPinnedModelId(chatRequest({ model: 'AUTO' }))).toBeNull();
      expect(getPinnedModelId(chatRequest({ model: '   ' }))).toBeNull();
      expect(getPinnedModelId(chatRequest())).toBeNull();
    });

    it('treats ailin-* virtual aliases as no pin', () => {
      // The route normalizer rewrites aliases and sets user_specified_model
      // false; `getUserSpecifiedModelFlag` independently refuses to call an
      // `ailin-` prefix a user pin, so both spellings are covered.
      expect(getPinnedModelId(chatRequest({ model: 'ailin-economy' }))).toBeNull();
      expect(
        getPinnedModelId({
          ...chatRequest({ model: 'auto' }),
          user_specified_model: false,
        } as ChatRequest)
      ).toBeNull();
    });

    it('trims surrounding whitespace off the pinned id', () => {
      expect(getPinnedModelId(chatRequest({ model: '  openai/gpt-4o  ' }))).toBe('openai/gpt-4o');
    });
  });

  describe('checkExplicitModelExists', () => {
    it('rejects an id that resolves to no catalog row', async () => {
      findModelsByIdOrName.mockResolvedValue([]);

      const check = await checkExplicitModelExists(
        chatRequest({ model: 'definitely-not-a-real-model-xyz' })
      );

      expect(check.requestedModel).toBe('definitely-not-a-real-model-xyz');
      expect(check.exists).toBe(false);
      expect(check.indeterminate).toBe(false);
      expect(check.matchCount).toBe(0);
    });

    it('admits an id that resolves to at least one catalog row', async () => {
      findModelsByIdOrName.mockResolvedValue([{ id: 'vendor/model-a' }, { id: 'vendor/model-a' }]);

      const check = await checkExplicitModelExists(chatRequest({ model: 'vendor/model-a' }));

      expect(check.exists).toBe(true);
      expect(check.matchCount).toBe(2);
    });

    it('never touches the catalog when nothing was pinned', async () => {
      const check = await checkExplicitModelExists(chatRequest({ model: 'auto' }));

      expect(check.requestedModel).toBeNull();
      expect(check.exists).toBe(true);
      expect(findModelsByIdOrName).not.toHaveBeenCalled();
    });

    it('FAILS OPEN when the catalog lookup throws', async () => {
      // An unreachable database must not turn every pinned request into a 404.
      findModelsByIdOrName.mockRejectedValue(new Error('connection terminated'));

      const check = await checkExplicitModelExists(chatRequest({ model: 'vendor/model-a' }));

      expect(check.exists).toBe(true);
      expect(check.indeterminate).toBe(true);
    });

    it('resolves against the whole catalog, not the 100-row recency window', async () => {
      // findModelsByIdOrName is an exact SQL lookup; searchModels applies a
      // silent `limit || 100` over `created_at DESC` and would 404 every older
      // model in the catalog.
      findModelsByIdOrName.mockResolvedValue([{ id: 'vendor/old-model' }]);

      await checkExplicitModelExists(chatRequest({ model: 'vendor/old-model' }));

      expect(findModelsByIdOrName).toHaveBeenCalledWith('vendor/old-model');
    });
  });

  describe('unknownModelErrorBody', () => {
    it('returns an OpenAI-compatible error envelope naming the model', () => {
      const body = unknownModelErrorBody('definitely-not-a-real-model-xyz');

      expect(body.error.code).toBe('model_not_found');
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.param).toBe('model');
      expect(body.error.message).toContain('definitely-not-a-real-model-xyz');
    });
  });
});
