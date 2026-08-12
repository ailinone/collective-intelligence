// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `catalog-cost-estimate` — the only billing arithmetic in the chat route layer.
 *
 * A streaming handler that calls the adapter directly has no
 * `OrchestrationResult`, so `trackChatUsage` resolves
 * `totalCostOverride ?? result?.totalCost ?? 0` to an unconditional ZERO. That
 * is still live today on `POST /v1/chat/completions` (`chat-routes.ts:1806`),
 * which is what this module is retained to fix.
 *
 * THE MODULE IS CURRENTLY UNWIRED — see its header for the full reasoning. These
 * tests therefore guard ARITHMETIC that is not yet on a request path. That is
 * deliberate: the arithmetic has to be provably correct BEFORE it is allowed to
 * move a counter that `/v1/chat/completions` enforces a hard 429 on.
 *
 * Two failure directions matter and both are tested here:
 *   - UNDER: returning 0 when the data to price the request is actually present
 *     (the bug being fixed).
 *   - OVER: inventing a number when it is not. Wherever this value reaches
 *     `usage_quotas.costUsd`, a fabricated price becomes a real enforcement
 *     decision. Every "cannot determine" case below must be exactly 0, not a
 *     best guess.
 *
 * CO-LOCATED, NOT IN `__tests__/`, DELIBERATELY: `vitest.ci.config.ts` excludes
 * `src/routes/**\/__tests__/**` (those are route integration tests needing a real
 * DB), so a file placed there would never run in the main CI suite. This is a
 * dependency-free unit test and belongs in the suite that actually gates merges.
 */

import { describe, it, expect } from 'vitest';
import type { ChatResponse, Model } from '@/types';
import {
  estimateStreamCostUsd,
  estimateProviderCallsCostUsd,
  sumProviderCallTokens,
} from './catalog-cost-estimate';

function model(overrides: Partial<Model> & { id: string }): { model: Model } {
  return {
    model: {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      inputCostPer1k: overrides.inputCostPer1k ?? 0,
      outputCostPer1k: overrides.outputCostPer1k ?? 0,
    } as Model,
  };
}

function usage(prompt: number, completion: number): ChatResponse['usage'] {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

const CANDIDATES = [
  model({ id: 'openai/gpt-4o-mini', inputCostPer1k: 0.15, outputCostPer1k: 0.6 }),
  model({ id: 'anthropic/claude-haiku', inputCostPer1k: 0.8, outputCostPer1k: 4 }),
];

describe('estimateStreamCostUsd', () => {
  it('prices prompt and completion tokens at the executed model rate', () => {
    // 2000/1000 * 0.15 + 500/1000 * 0.6 = 0.30 + 0.30
    expect(estimateStreamCostUsd(CANDIDATES, 'openai/gpt-4o-mini', usage(2000, 500))).toBeCloseTo(
      0.6,
      10
    );
  });

  it('prices the model that actually ran, not the first candidate', () => {
    // The fallback ladder means the primary candidate is frequently NOT the one
    // that served the stream. 1000/1000 * 0.8 + 1000/1000 * 4 = 4.8
    expect(estimateStreamCostUsd(CANDIDATES, 'anthropic/claude-haiku', usage(1000, 1000))).toBeCloseTo(
      4.8,
      10
    );
  });

  it('matches on model name as well as id', () => {
    const byName = [model({ id: 'x-1', name: 'friendly-name', inputCostPer1k: 1 })];
    expect(estimateStreamCostUsd(byName, 'friendly-name', usage(1000, 0))).toBeCloseTo(1, 10);
  });

  it('returns 0 when the adapter reported no usage', () => {
    expect(estimateStreamCostUsd(CANDIDATES, 'openai/gpt-4o-mini', undefined)).toBe(0);
  });

  it('returns 0 when the stream never identified its model', () => {
    // Guessing here would attribute one candidate's rate to a request that may
    // have run on another.
    expect(estimateStreamCostUsd(CANDIDATES, undefined, usage(2000, 500))).toBe(0);
  });

  it('returns 0 when the executed model is not among the candidates', () => {
    expect(estimateStreamCostUsd(CANDIDATES, 'some/unknown-model', usage(2000, 500))).toBe(0);
  });

  it('returns 0 for an empty candidate list', () => {
    expect(estimateStreamCostUsd([], 'openai/gpt-4o-mini', usage(2000, 500))).toBe(0);
  });

  it('treats non-finite catalog pricing as free rather than NaN', () => {
    // A NaN would propagate into `sanitizeCostValue` and silently become 0
    // anyway, but only after polluting the usage-event metadata on the way.
    const broken = [
      model({
        id: 'broken',
        inputCostPer1k: Number.NaN,
        outputCostPer1k: Number.POSITIVE_INFINITY,
      }),
    ];
    expect(estimateStreamCostUsd(broken, 'broken', usage(1000, 1000))).toBe(0);
  });

  it('ignores negative token counts instead of producing a credit', () => {
    expect(estimateStreamCostUsd(CANDIDATES, 'openai/gpt-4o-mini', usage(-5000, 1000))).toBeCloseTo(
      0.6,
      10
    );
  });

  it('returns 0, never a negative number, for a free model', () => {
    const free = [model({ id: 'local/llama', inputCostPer1k: 0, outputCostPer1k: 0 })];
    expect(estimateStreamCostUsd(free, 'local/llama', usage(100000, 100000))).toBe(0);
  });
});

/**
 * Pricing a set of calls whose `Model` the caller already knows. Unlike the
 * stream case there is no matching problem — every reported call is priceable,
 * and the only way to get 0 is for the adapter to have reported no usage.
 *
 * These two helpers are structurally typed (`{ model: Model; usage? }`), not
 * bound to any one caller. Their original consumer was deleted by #271; they are
 * retained with the rest of the module for the follow-up described in its
 * header.
 */
describe('estimateProviderCallsCostUsd', () => {
  it('sums every call in the fan-out', () => {
    // 0.6 (gpt-4o-mini, as above) + 4.8 (claude-haiku, as above)
    const calls = [
      { model: CANDIDATES[0]!.model, usage: usage(2000, 500) },
      { model: CANDIDATES[1]!.model, usage: usage(1000, 1000) },
    ];
    expect(estimateProviderCallsCostUsd(calls)).toBeCloseTo(5.4, 10);
  });

  it('returns 0 for no calls — nothing reached a provider', () => {
    // The case that must never be billed: a caller that served the request from
    // cache reached no provider and reports an empty array.
    expect(estimateProviderCallsCostUsd([])).toBe(0);
  });

  it('prices only the calls that came back with usage', () => {
    const calls = [
      { model: CANDIDATES[0]!.model, usage: usage(2000, 500) },
      { model: CANDIDATES[1]!.model, usage: undefined },
    ];
    expect(estimateProviderCallsCostUsd(calls)).toBeCloseTo(0.6, 10);
  });

  it('does not let one broken catalog entry poison the whole sum', () => {
    const calls = [
      { model: CANDIDATES[0]!.model, usage: usage(2000, 500) },
      {
        model: model({ id: 'broken', inputCostPer1k: Number.NaN }).model,
        usage: usage(1000, 1000),
      },
    ];
    expect(estimateProviderCallsCostUsd(calls)).toBeCloseTo(0.6, 10);
  });
});

describe('sumProviderCallTokens', () => {
  it('adds prompt and completion tokens across the fan-out', () => {
    const calls = [{ usage: usage(2000, 500) }, { usage: usage(1000, 1000) }];
    expect(sumProviderCallTokens(calls)).toEqual({
      promptTokens: 3000,
      completionTokens: 1500,
      totalTokens: 4500,
    });
  });

  it('is all zeroes for no calls', () => {
    expect(sumProviderCallTokens([])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('skips calls with no usage rather than counting NaN', () => {
    const calls = [{ usage: usage(100, 50) }, { usage: undefined }];
    expect(sumProviderCallTokens(calls)).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('clamps negative counts to zero instead of subtracting', () => {
    const calls = [{ usage: usage(-100, 50) }];
    expect(sumProviderCallTokens(calls)).toEqual({
      promptTokens: 0,
      completionTokens: 50,
      totalTokens: 50,
    });
  });
});
