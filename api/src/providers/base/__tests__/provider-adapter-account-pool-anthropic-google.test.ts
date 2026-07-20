// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for account pooling on Anthropic + Google adapters
 * (scale-to-100k Phase 2 follow-up, issue #152) — extends the OpenAI
 * reference implementation (provider-adapter-account-pool.test.ts) to the
 * next two highest-value providers.
 *
 * No network calls: constructing the Anthropic/Google SDK clients does not
 * make a request.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import { GoogleAdapter } from '@/providers/google/google-adapter';

describe('AnthropicAdapter account pool', () => {
  it('builds one SDK client per unique pooled key', () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-primary',
      apiKeyPool: ['sk-ant-primary', 'sk-ant-second'],
    });
    const clientPool = (adapter as unknown as { clientPool: unknown[] }).clientPool;
    expect(clientPool).toHaveLength(2);
    expect(new Set(clientPool).size).toBe(2);
  });

  it('builds a single-client pool when no apiKeyPool is configured', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-ant-only' });
    const clientPool = (adapter as unknown as { clientPool: unknown[] }).clientPool;
    expect(clientPool).toHaveLength(1);
  });

  it('getRequestClient round-robins across the pool', () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-a',
      apiKeyPool: ['sk-ant-a', 'sk-ant-b'],
    });
    const getRequestClient = (
      adapter as unknown as { getRequestClient: () => unknown }
    ).getRequestClient.bind(adapter);
    const sequence = Array.from({ length: 4 }, () => getRequestClient());
    expect(sequence[0]).toBe(sequence[2]);
    expect(sequence[1]).toBe(sequence[3]);
    expect(sequence[0]).not.toBe(sequence[1]);
  });

  it('estimateTokenCost estimates prompt tokens plus max_tokens', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-ant-only' });
    const estimate = (adapter as unknown as { estimateTokenCost: (r: unknown) => number }).estimateTokenCost;
    const request = { messages: [{ role: 'user', content: 'a'.repeat(400) }], max_tokens: 500 };
    expect(estimate(request)).toBe(600); // 400/4=100 + 500
  });
});

describe('GoogleAdapter account pool', () => {
  it('builds one SDK client per unique pooled key', () => {
    const adapter = new GoogleAdapter({
      apiKey: 'AIza-primary',
      apiKeyPool: ['AIza-primary', 'AIza-second'],
      enabled: true,
      name: 'google',
    });
    const clientPool = (adapter as unknown as { clientPool: unknown[] }).clientPool;
    expect(clientPool).toHaveLength(2);
    expect(new Set(clientPool).size).toBe(2);
  });

  it('builds a single-client pool when no apiKeyPool is configured', () => {
    const adapter = new GoogleAdapter({ apiKey: 'AIza-only', enabled: true, name: 'google' });
    const clientPool = (adapter as unknown as { clientPool: unknown[] }).clientPool;
    expect(clientPool).toHaveLength(1);
  });

  it('getRequestClient round-robins across the pool', () => {
    const adapter = new GoogleAdapter({
      apiKey: 'AIza-a',
      apiKeyPool: ['AIza-a', 'AIza-b'],
      enabled: true,
      name: 'google',
    });
    const getRequestClient = (
      adapter as unknown as { getRequestClient: () => unknown }
    ).getRequestClient.bind(adapter);
    const sequence = Array.from({ length: 4 }, () => getRequestClient());
    expect(sequence[0]).toBe(sequence[2]);
    expect(sequence[1]).toBe(sequence[3]);
    expect(sequence[0]).not.toBe(sequence[1]);
  });

  it('estimateTokenCost estimates prompt tokens plus max_tokens', () => {
    const adapter = new GoogleAdapter({ apiKey: 'AIza-only', enabled: true, name: 'google' });
    const estimate = (adapter as unknown as { estimateTokenCost: (r: unknown) => number }).estimateTokenCost;
    const request = { messages: [{ role: 'user', content: 'b'.repeat(200) }], max_tokens: 300 };
    expect(estimate(request)).toBe(350); // 200/4=50 + 300
  });
});
