// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Arbitration revision (repair) call must carry the language-mirror directive
 * (audit finding F-06): the refined answer has to stay in the user's language
 * instead of drifting to English, matching what the SOTA synthesizer prompts
 * already embed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LANGUAGE_MIRROR_DIRECTIVE } from '@/core/orchestration/prompts/language-directive';

const { chatCompletion } = vi.hoisted(() => ({ chatCompletion: vi.fn() }));

vi.mock('@/providers/provider-registry.js', () => ({
  getProviderRegistry: () => ({
    findModel: async () => ({
      adapter: { chatCompletion, calculateCost: vi.fn(() => 0.01) },
      model: { id: 'm1', name: 'Model One' },
    }),
  }),
}));

import { ArbitrationSystem, type CompetitiveSolution } from '../arbitration-system';

function makeSolution(): CompetitiveSolution {
  return {
    modelId: 'm1',
    modelName: 'Model One',
    provider: 'test',
    response: {
      id: 'resp-1',
      object: 'chat.completion',
      created: Date.now(),
      model: 'm1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'original answer' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
    cost: 0.001,
    durationMs: 100,
  };
}

describe('ArbitrationSystem.requestRevision — language mirror (F-06)', () => {
  beforeEach(() => {
    chatCompletion.mockReset();
    chatCompletion.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'refined answer' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  });

  it('sends the LANGUAGE_MIRROR_DIRECTIVE as the system message of the repair call', async () => {
    const system = new ArbitrationSystem();

    await system.requestRevision(
      {
        originalSolution: makeSolution(),
        feedback: { weaknesses: ['weak'], improvements: ['improve'], targetQuality: 0.9 },
        iteration: 1,
      },
      { id: 'm1', name: 'Model One', provider: 'test' }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    const request = chatCompletion.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe(LANGUAGE_MIRROR_DIRECTIVE);
  });
});
