// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VisionImageCandidateJudge — Package B.
 *
 * The judge reuses `VisionOrchestrationService.analyzeImage` (a real,
 * dynamically-model-selecting vision call — no hardcoded judge model) and the
 * SAME tolerant JSON parsing every text judge in this codebase already uses
 * (`provider-llm-judge-client.ts#coerceRawResult`). These tests inject a mock
 * vision service via the constructor so no real provider call happens.
 */
import { describe, it, expect, vi } from 'vitest';
import { VisionImageCandidateJudge, type ImageJudgeConfig } from '../image-candidate-judge';
import type { OrchestrationContext } from '@/types';

const USER_CONTEXT = { organizationId: 'org_test' } as unknown as OrchestrationContext;

function makeConfig(overrides: Partial<ImageJudgeConfig> = {}): ImageJudgeConfig {
  return { enabled: true, timeoutMs: 5000, ...overrides };
}

describe('VisionImageCandidateJudge', () => {
  it('returns available:false without calling vision when disabled', async () => {
    const analyzeImage = vi.fn();
    const judge = new VisionImageCandidateJudge(makeConfig({ enabled: false }), { analyzeImage });

    const result = await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_1', userContext: USER_CONTEXT }
    );

    expect(analyzeImage).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe('image_judge_disabled');
  });

  it('parses a clean JSON verdict from the vision call', async () => {
    const analyzeImage = vi.fn().mockResolvedValue({
      content: JSON.stringify({ score: 0.85, verdict: 'pass', rationale: 'matches the prompt well' }),
      modelUsed: 'some-vision-model',
    });
    const judge = new VisionImageCandidateJudge(makeConfig(), { analyzeImage });

    const result = await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_2', userContext: USER_CONTEXT }
    );

    expect(result.available).toBe(true);
    expect(result.score).toBeCloseTo(0.85);
    expect(result.verdict).toBe('pass');
    expect(result.rationale).toBe('matches the prompt well');
    expect(result.judgeModelId).toBe('some-vision-model');
  });

  it('never reveals which model generated the candidate to the judge prompt', async () => {
    const analyzeImage = vi.fn().mockResolvedValue({
      content: JSON.stringify({ score: 0.5, verdict: 'uncertain' }),
      modelUsed: 'judge-model',
    });
    const judge = new VisionImageCandidateJudge(makeConfig(), { analyzeImage });

    await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_3', userContext: USER_CONTEXT }
    );

    const call = analyzeImage.mock.calls[0][0];
    expect(call.prompt).not.toMatch(/dall-?e|midjourney|stable[\s-]?diffusion|flux|imagen/i);
    expect(call.prompt).toContain('a red bicycle');
  });

  it('tolerantly salvages a markdown-fenced or prose-wrapped response', async () => {
    const analyzeImage = vi.fn().mockResolvedValue({
      content: 'Sure, here you go:\n```json\n{"score": 0.7, "verdict": "pass"}\n```',
      modelUsed: 'some-vision-model',
    });
    const judge = new VisionImageCandidateJudge(makeConfig(), { analyzeImage });

    const result = await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_4', userContext: USER_CONTEXT }
    );

    expect(result.available).toBe(true);
    expect(result.score).toBeCloseTo(0.7);
  });

  it('returns available:false (never throws) when the vision call fails', async () => {
    const analyzeImage = vi.fn().mockRejectedValue(new Error('no vision-capable model available'));
    const judge = new VisionImageCandidateJudge(makeConfig(), { analyzeImage });

    const result = await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_5', userContext: USER_CONTEXT }
    );

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toContain('no vision-capable model available');
  });

  it('returns available:false when the vision call exceeds the configured timeout', async () => {
    const analyzeImage = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ content: '{}', modelUsed: 'x' }), 200))
    );
    const judge = new VisionImageCandidateJudge(makeConfig({ timeoutMs: 20 }), { analyzeImage });

    const result = await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_6', userContext: USER_CONTEXT }
    );

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toContain('timeout');
  });

  it('returns available:false when the judge output is unparseable garbage', async () => {
    const analyzeImage = vi.fn().mockResolvedValue({
      content: 'I cannot help with that request.',
      modelUsed: 'some-vision-model',
    });
    const judge = new VisionImageCandidateJudge(makeConfig(), { analyzeImage });

    const result = await judge.score(
      { image: 'https://example.com/a.png', prompt: 'a red bicycle' },
      { requestId: 'req_7', userContext: USER_CONTEXT }
    );

    expect(result.available).toBe(false);
  });
});
