// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, beforeEach } from 'vitest';
import { CacheService } from '../cache-service';
import { initializeCacheRuntime } from '../cache-runtime-state';
import type { ChatRequest } from '@/types';

function buildKey(cacheService: CacheService, request: ChatRequest): string {
  return (
    cacheService as unknown as {
      buildCacheKey: (req: ChatRequest, organizationId: string) => string;
    }
  ).buildCacheKey(request, 'org-test');
}

describe('cache-service key signature', () => {
  const baseRequest: ChatRequest = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Explain CAP theorem in one paragraph.' }],
    temperature: 0.1,
    max_tokens: 256,
  };

  beforeEach(() => {
    initializeCacheRuntime(false);
  });

  it('creates different keys for different explicit strategies', () => {
    const cacheService = new CacheService();

    const costKey = buildKey(cacheService, { ...baseRequest, strategy: 'cost' });
    const qualityKey = buildKey(cacheService, { ...baseRequest, strategy: 'quality' });
    const parallelKey = buildKey(cacheService, { ...baseRequest, strategy: 'parallel' });

    expect(costKey).not.toBe(qualityKey);
    expect(costKey).not.toBe(parallelKey);
    expect(qualityKey).not.toBe(parallelKey);
  });

  it('normalizes strategy aliases into the same cache key', () => {
    const cacheService = new CacheService();

    const canonical = buildKey(cacheService, {
      ...baseRequest,
      strategy: 'quality_multipass',
    });
    const alias = buildKey(cacheService, {
      ...baseRequest,
      strategy: 'quality-multipass',
    });

    expect(canonical).toBe(alias);
  });

  it('changes key when orchestration-affecting constraints change', () => {
    const cacheService = new CacheService();

    const withHighBudget = buildKey(cacheService, {
      ...baseRequest,
      strategy: 'quality',
      max_cost: 2,
      quality_target: 0.95,
    });
    const withLowBudget = buildKey(cacheService, {
      ...baseRequest,
      strategy: 'quality',
      max_cost: 0.1,
      quality_target: 0.95,
    });
    const withWebSearch = buildKey(cacheService, {
      ...baseRequest,
      strategy: 'quality',
      max_cost: 2,
      quality_target: 0.95,
      webSearch: true,
      webSearchOptions: { engine: 'exa', max_results: 5, search_context_size: 'high' },
    });

    expect(withHighBudget).not.toBe(withLowBudget);
    expect(withHighBudget).not.toBe(withWebSearch);
  });
});
