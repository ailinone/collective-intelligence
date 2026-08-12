// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * billing-usage-tracker-wallet-coverage.test.ts — WHICH routes actually reach the
 * prepaid wallet, pinned as behaviour instead of prose.
 *
 * `trackChatUsage` is the single debit chokepoint, but it does NOT meter the request
 * body — it meters `modelsOverride ?? summarizeModels(result)`. Three routes call it
 * with neither: /v1/responses (streaming, responses-routes.ts, and non-streaming),
 * /v1/chat/completions/extended-thinking and /ultra-thinking all pass a synthetic
 * `{ model, messages: [] }` plus only `totalTokensOverride` / `totalCostOverride`.
 * With no per-model breakdown, `aggregateTokenUsage` yields 0 prompt / 0 completion
 * tokens, so `debitChatRequest` computes a $0 charge and moves no money — before and
 * after the wallet-gate rewrite, and regardless of the tier the caller asked for.
 *
 * That is a real coverage gap (the same `<strategy>:<tier>` composites bill on
 * /v1/chat/completions), but closing it means newly charging customers on three
 * endpoints, which is a product decision — not something to slip in behind a
 * default-off flag. These tests exist so the gap is explicit and so a half-wired fix
 * (carrier threaded through, tokens still missing) fails loudly here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '@/types';

const debitCalls: Array<{ promptTokens: number; completionTokens: number; request: ChatRequest }> =
  [];

vi.mock('@/services/prepaid-wallet-gate', () => ({
  debitChatRequest: vi.fn(async (args: (typeof debitCalls)[number]) => {
    debitCalls.push(args);
  }),
}));
vi.mock('@/services/usage-analytics-service', () => ({
  recordUsageEvents: vi.fn(async () => undefined),
}));
vi.mock('@/services/quota-service', () => ({
  recordQuotaUsage: vi.fn(async () => undefined),
}));

const { trackChatUsage } = await import('@/services/billing-usage-tracker');

beforeEach(() => {
  debitCalls.length = 0;
});

describe('trackChatUsage → prepaid wallet coverage', () => {
  /** The exact shape responses-routes.ts / extended-thinking-routes.ts pass. */
  async function trackSyntheticRoute(model: string): Promise<void> {
    await trackChatUsage({
      organizationId: 'org-1',
      userId: 'user-1',
      requestId: 'req-1',
      request: { model, messages: [] } as unknown as ChatRequest,
      cacheHit: false,
      totalCostOverride: 1.23,
      totalTokensOverride: 250_000,
    });
  }

  it.each(['consensus:extra', 'expert-panel:extra', 'ailin-best', 'auto'])(
    'debits nothing for the synthetic /v1/responses + thinking-route shape (model=%s)',
    async (model) => {
      await trackSyntheticRoute(model);
      expect(debitCalls).toHaveLength(1);
      // No carrier AND no token breakdown — either alone already yields a $0 charge.
      expect(debitCalls[0]?.request.ailin_tier).toBeUndefined();
      expect(debitCalls[0]?.request.ailin_tier_rate).toBeUndefined();
      expect(debitCalls[0]?.promptTokens).toBe(0);
      expect(debitCalls[0]?.completionTokens).toBe(0);
    }
  );

  it('forwards the real carrier and real token split on the /v1/chat/completions shape', async () => {
    await trackChatUsage({
      organizationId: 'org-1',
      userId: 'user-1',
      requestId: 'req-2',
      request: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        ailin_alias: 'consensus:large',
        ailin_tier: 'large',
        ailin_tier_rate: { inputPer1MUsd: 4, outputPer1MUsd: 20 },
      } as unknown as ChatRequest,
      cacheHit: false,
      modelsOverride: [
        { modelId: 'm1', modelName: 'M1', promptTokens: 1_000, completionTokens: 2_000 },
      ],
    });

    expect(debitCalls).toHaveLength(1);
    expect(debitCalls[0]?.request.ailin_tier).toBe('large');
    expect(debitCalls[0]?.promptTokens).toBe(1_000);
    expect(debitCalls[0]?.completionTokens).toBe(2_000);
  });
});
