// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BaseStrategy.withPeerReviewPrompt must use the canonical
 * PEER_REVIEW_SYSTEM_PROMPT constant (audit finding F-01): the inline copy had
 * already drifted (it carried a "Note:" prefix the canonical version does not).
 * Single source of truth — peer-review-prompt.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BaseStrategy } from '../base-strategy';
import { PEER_REVIEW_SYSTEM_PROMPT } from '../prompts/peer-review-prompt';
import type { ChatRequest, OrchestrationResult } from '@/types';

class TestStrategy extends BaseStrategy {
  getMetadata() {
    return {
      id: 'test',
      name: 'single' as const,
      displayName: 'Test',
      description: 'test strategy',
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 1,
      estimatedQualityBoost: 0,
      estimatedDurationMultiplier: 1,
      suitableFor: [],
    };
  }

  execute(): Promise<OrchestrationResult> {
    return Promise.reject(new Error('not implemented in test'));
  }

  public peerReview(request: ChatRequest): ChatRequest {
    return this.withPeerReviewPrompt(request);
  }
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('BaseStrategy.withPeerReviewPrompt — canonical constant (F-01)', () => {
  it('prepends the exact PEER_REVIEW_SYSTEM_PROMPT (no drifted variants)', () => {
    delete process.env.DISABLE_FACILITATION_PROMPT;
    const strategy = new TestStrategy();

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    };
    const result = strategy.peerReview(request);

    expect(result.messages).toHaveLength(2);
    const first = result.messages[0];
    expect(first.role).toBe('system');
    expect(first.content).toBe(PEER_REVIEW_SYSTEM_PROMPT);
    // Original messages are preserved after the prepend
    expect(result.messages[1]).toEqual(request.messages[0]);
  });

  it('is still disabled by the legacy DISABLE_FACILITATION_PROMPT flag', () => {
    process.env.DISABLE_FACILITATION_PROMPT = 'true';
    const strategy = new TestStrategy();

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    };
    const result = strategy.peerReview(request);

    expect(result.messages).toHaveLength(1);
  });
});
