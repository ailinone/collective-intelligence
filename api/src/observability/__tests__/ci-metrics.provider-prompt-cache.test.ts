// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for `recordProviderPromptCacheUsage()` / `ci_provider_prompt_cache_tokens_total`
 * (ADR-025 follow-up, 2026-09).
 *
 * This is the shared, provider-agnostic side channel every adapter touched
 * in the follow-up gap-closure (AWS Bedrock, Vertex AI, Cohere, and the
 * OpenAI-compatible hub adapter for Groq/Azure/Cerebras/SambaNova/Databricks)
 * calls into to surface a vendor's own reported cache-hit/miss tokens without
 * changing the shared `Usage`/`ChatResponse` type contract. Tested here in
 * isolation; each adapter's own test file covers the call site (what
 * triggers the call and with what values), not the counter's own increment
 * behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  providerPromptCacheTokensTotal,
  recordProviderPromptCacheUsage,
} from '@/observability/ci-metrics';

async function valueFor(provider: string, outcome: 'hit' | 'miss'): Promise<number | undefined> {
  const metric = await providerPromptCacheTokensTotal.get();
  return metric.values.find((v) => v.labels.provider === provider && v.labels.outcome === outcome)
    ?.value;
}

describe('recordProviderPromptCacheUsage', () => {
  it('increments the hit counter by the reported hit-token count', async () => {
    recordProviderPromptCacheUsage({ provider: 'test-provider-hit-only', hitTokens: 123 });

    expect(await valueFor('test-provider-hit-only', 'hit')).toBe(123);
    expect(await valueFor('test-provider-hit-only', 'miss')).toBeUndefined();
  });

  it('increments the miss counter by the reported miss-token count', async () => {
    recordProviderPromptCacheUsage({ provider: 'test-provider-miss-only', missTokens: 45 });

    expect(await valueFor('test-provider-miss-only', 'miss')).toBe(45);
    expect(await valueFor('test-provider-miss-only', 'hit')).toBeUndefined();
  });

  it('records both outcomes when a provider reports both directly', async () => {
    recordProviderPromptCacheUsage({
      provider: 'test-provider-both',
      hitTokens: 10,
      missTokens: 5,
    });

    expect(await valueFor('test-provider-both', 'hit')).toBe(10);
    expect(await valueFor('test-provider-both', 'miss')).toBe(5);
  });

  it('accumulates across multiple calls for the same provider', async () => {
    recordProviderPromptCacheUsage({ provider: 'test-provider-accum', hitTokens: 7 });
    recordProviderPromptCacheUsage({ provider: 'test-provider-accum', hitTokens: 3 });

    expect(await valueFor('test-provider-accum', 'hit')).toBe(10);
  });

  it('is a no-op when neither field is provided', async () => {
    recordProviderPromptCacheUsage({ provider: 'test-provider-empty' });

    expect(await valueFor('test-provider-empty', 'hit')).toBeUndefined();
    expect(await valueFor('test-provider-empty', 'miss')).toBeUndefined();
  });

  it('is a no-op for a zero or negative value — never fabricates a hit/miss that was not reported', async () => {
    recordProviderPromptCacheUsage({ provider: 'test-provider-zero', hitTokens: 0, missTokens: -5 });

    expect(await valueFor('test-provider-zero', 'hit')).toBeUndefined();
    expect(await valueFor('test-provider-zero', 'miss')).toBeUndefined();
  });
});
