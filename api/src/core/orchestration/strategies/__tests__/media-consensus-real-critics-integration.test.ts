// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration test (Section A, Task 10): a full MediaConsensusStrategy run
 * wired with 3 REAL MediaJudgeEvaluator instances (spec_compliance,
 * artifact_quality, tone), mocked only at the MediaJudgeClient boundary —
 * never a real provider, zero cost. Proves the real wiring (not a fake
 * StrategyOutputEvaluator) reconciles independently-scored critics and
 * `pickBestCandidate` picks the genuinely highest-scored candidate.
 *
 * No `constraints` are passed on the request, so the deterministic gate
 * (`runDeterministicMediaGate`) short-circuits to `skipped_no_constraints`
 * without ever calling `probeMedia` — nothing under
 * `@/services/media/ffmpeg-media-toolkit` needs mocking for an image
 * candidate (see `media-deterministic-gate.ts` and `sampleFramesForCandidate`,
 * which treats the image bytes themselves as the single "sampled frame").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { MediaConsensusStrategy, type MediaCriticConfig } from '../media-consensus-strategy';
import { MediaJudgeEvaluator } from '../evaluation/media-judge-evaluator';
import {
  MEDIA_CRITIC_ROLES,
  type MediaJudgeClient,
  type MediaJudgeInput,
} from '../evaluation/media-judge-evaluator.types';
import type { LLMJudgeRawResult } from '../evaluation/llm-judge-evaluator.types';
import type { ImagesOrchestrationService, ImageResult } from '@/services/images-orchestration-service';
import type { OrchestrationContext } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
});

const userContext = { requestId: 'r1', models: [] } as unknown as OrchestrationContext;

function fakeImagesService(results: ImageResult[]): ImagesOrchestrationService {
  let call = 0;
  return {
    generateImages: vi.fn(async () => {
      const r = results[call] ?? results[results.length - 1];
      call += 1;
      return r;
    }),
  } as unknown as ImagesOrchestrationService;
}

/**
 * Scores candidate 0 low (0.3) and candidate 1 high (0.9) on every critic
 * axis, regardless of criticRole — proves the reconciler's weighted average
 * across independently-invoked critics (not any single critic, and not
 * candidate-generation order) drives the final pick. `MediaConsensusStrategy`
 * generates candidates via `Promise.all` and evaluates them via
 * `Promise.all` too, so call order across critics is not guaranteed to be
 * candidate-major; we key off `input.task.userMessageExcerpt`-independent
 * content instead — the low/high score is looked up from the base64 image
 * payload embedded in the judge content (the actual candidate bytes),
 * making the mock robust to call interleaving.
 */
function makeJudgeMediaMock() {
  return vi.fn(async (input: MediaJudgeInput): Promise<LLMJudgeRawResult> => {
    const serialized = JSON.stringify(input.content);
    const isHighScoreCandidate = serialized.includes('aGlnaC1zY29yZQ==');
    const score = isHighScoreCandidate ? 0.9 : 0.3;
    return {
      score,
      verdict: 'pass',
      confidence: 0.9,
      shortRationale: `mock rationale for ${input.criticRole}`,
      costUsd: 0.001,
    };
  });
}

describe('MediaConsensusStrategy — real MediaJudgeEvaluator critics (mocked provider boundary)', () => {
  it('reconciles 3 real critics and picks the genuinely higher-scored candidate', async () => {
    const images: ImageResult[] = [
      { images: [{ b64_json: 'bG93LXNjb3Jl' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
      { images: [{ b64_json: 'aGlnaC1zY29yZQ==' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
    ];
    const imagesService = fakeImagesService(images);
    const judgeMedia = makeJudgeMediaMock();
    const mediaClient: MediaJudgeClient = { judgeMedia };

    const critics: MediaCriticConfig[] = MEDIA_CRITIC_ROLES.map((role) => ({
      role,
      evaluator: new MediaJudgeEvaluator(
        {
          enabled: true,
          judgeModelId: 'mock-vision-judge',
          maxCostUsd: 0.05,
          timeoutMs: 5000,
          rubricVersion: 'media-judge-v1',
          criticRole: role,
        },
        mediaClient
      ),
    }));

    const strategy = new MediaConsensusStrategy({ imagesService, critics, candidateCount: 2 });
    const result = await strategy.execute({
      capability: 'image_generation',
      prompt: 'a red bicycle leaning on a brick wall',
      stageName: 'gen-image',
      stageIndex: 0,
      userContext,
      requestId: 'req-real-critics',
      candidateCount: 2,
    });

    // 3 critics x 2 candidates, each an independent MediaJudgeClient call.
    expect(judgeMedia).toHaveBeenCalledTimes(6);
    expect(result.degraded).toBe(false);
    expect(result.bestCandidateIndex).toBe(1);
    expect(result.bestArtifact?.b64_json).toBe('aGlnaC1zY29yZQ==');
    expect(result.totalJudgeCostUsd).toBeCloseTo(0.006, 5); // 6 calls x $0.001

    const losingRecord = result.candidates[0];
    const winningRecord = result.candidates[1];
    expect(winningRecord.criticResults).toHaveLength(3);
    expect(winningRecord.reconciledEvaluation.score).toBeCloseTo(0.9, 5);
    expect(losingRecord.reconciledEvaluation.score).toBeCloseTo(0.3, 5);

    // Every critic role actually ran, independently, against BOTH candidates
    // — confirms real MediaJudgeEvaluator instances (one per role), not a
    // single fake collapsing the three roles into one call.
    const rolesSeen = judgeMedia.mock.calls.map(([input]) => input.criticRole);
    for (const role of MEDIA_CRITIC_ROLES) {
      expect(rolesSeen.filter((r) => r === role)).toHaveLength(2);
    }
  });
});
