// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cache Service Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { getSemanticCache } from '@/core/cache/semantic-cache';
import type { ChatRequest } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModelId, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';

describe('Cache Service - Real Tests (NO Hardcoded Models)', () => {
  let testModelId: string;

  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
    testModelId = await getTestModelId();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    const cache = await getSemanticCache();
    await cache.invalidate({ organizationId: 'org-123' });
  });

  it('should cache and retrieve requests with real models', async () => {
    if (!testModelId) {
      return; // Skip if no models available
    }

    const cache = await getSemanticCache();
    
    const request: ChatRequest = {
      model: testModelId, // Use dynamically discovered model
      messages: [{ role: 'user', content: 'Test cache' }],
    };

    const response = {
      id: 'cached-response',
      model: testModelId, // Use dynamically discovered model
      choices: [{ index: 0, message: { role: 'assistant', content: 'Cached response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    // Store in cache
    await cache.store({
      request,
      response,
      organizationId: 'org-123',
      metadata: {},
    });

    // Retrieve from cache
    const cached = await cache.lookup({
      request,
      organizationId: 'org-123',
    });

    expect(cached).toBeDefined();
    expect(cached?.entry.response.id).toBe('cached-response');
  }, 60000);
});
