// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaConsensusStrategy — full-flow tests with a MOCKED orchestration
 * service (never a real provider). Covers:
 *   - happy path: N candidates generated, independently judged, best picked
 *   - deterministic gate short-circuits a constraint-violating candidate
 *     BEFORE any critic runs (cost discipline)
 *   - a generation failure is an outlier, not a crash
 *   - all-outliers degrades gracefully instead of throwing
 *   - `reconcileCriticResults` / `pickBestCandidate` as pure functions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const probeMedia = vi.fn();
const extractFrames = vi.fn();

vi.mock('@/services/media/ffmpeg-media-toolkit', async () => {
  const actual = await vi.importActual<typeof import('@/services/media/ffmpeg-media-toolkit')>(
    '@/services/media/ffmpeg-media-toolkit'
  );
  return {
    ...actual,
    probeMedia: (...args: unknown[]) => probeMedia(...args),
    extractFrames: (...args: unknown[]) => extractFrames(...args),
  };
});

import {
  MediaConsensusStrategy,
  reconcileCriticResults,
  pickBestCandidate,
  sampleFramesForCandidate,
  type MediaCandidateRecord,
  type MediaConsensusRequest,
} from './media-consensus-strategy';
import type { StrategyOutputEvaluator, EvaluationResult } from './evaluation/strategy-output-evaluator';
import type { ImagesOrchestrationService, ImageResult } from '@/services/images-orchestration-service';
import type { VideoOrchestrationService, VideoResult } from '@/services/video-orchestration-service';
import type { OrchestrationContext, AilinArtifact } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
});

const userContext = { requestId: 'r1', models: [] } as unknown as OrchestrationContext;

function fakeEvaluator(score: number, verdict: EvaluationResult['verdict'] = 'pass'): StrategyOutputEvaluator {
  return {
    mode: 'mock',
    id: `fake-${score}`,
    evaluate: vi.fn(async (): Promise<EvaluationResult> => ({
      scoringMode: 'mock',
      evaluatorId: `fake-${score}`,
      score,
      verdict,
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      validationStatus: 'fully_validated',
    })),
  };
}

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

function fakeVideoService(results: VideoResult[]): VideoOrchestrationService {
  let call = 0;
  return {
    generateVideo: vi.fn(async () => {
      const r = results[call] ?? results[results.length - 1];
      call += 1;
      return r;
    }),
  } as unknown as VideoOrchestrationService;
}

function baseRequest(overrides: Partial<MediaConsensusRequest> = {}): MediaConsensusRequest {
  return {
    capability: 'image_generation',
    prompt: 'a red bicycle leaning on a brick wall',
    stageName: 'gen-image',
    stageIndex: 0,
    userContext,
    requestId: 'req-1',
    candidateCount: 2,
    ...overrides,
  };
}

describe('MediaConsensusStrategy — constructor validation', () => {
  it('throws when video_generation requested without a VideoOrchestrationService', async () => {
    const strategy = new MediaConsensusStrategy({});
    await expect(
      strategy.execute(baseRequest({ capability: 'video_generation' }))
    ).rejects.toThrow(/no VideoOrchestrationService was injected/);
  });

  it('throws when image_generation requested without an ImagesOrchestrationService', async () => {
    const strategy = new MediaConsensusStrategy({});
    await expect(strategy.execute(baseRequest())).rejects.toThrow(
      /no ImagesOrchestrationService was injected/
    );
  });
});

describe('MediaConsensusStrategy — happy path', () => {
  it('generates N candidates, judges independently, and picks the best-scored one', async () => {
    const images: ImageResult[] = [
      { images: [{ b64_json: 'aW1hZ2Utb25l' }], modelUsed: 'model-a', provider: 'prov-a', durationMs: 10 },
      { images: [{ b64_json: 'aW1hZ2UtdHdv' }], modelUsed: 'model-b', provider: 'prov-b', durationMs: 12 },
    ];
    const imagesService = fakeImagesService(images);

    // Critic A always prefers candidate order by giving a HIGHER score to
    // whichever candidate the mock evaluator sees LAST is irrelevant here —
    // we just assert deterministically via distinct scores per call index.
    let evalCall = 0;
    const scoringCritic: StrategyOutputEvaluator = {
      mode: 'mock',
      id: 'scoring-critic',
      evaluate: vi.fn(async (): Promise<EvaluationResult> => {
        const score = evalCall === 0 ? 0.4 : 0.9;
        evalCall += 1;
        return {
          scoringMode: 'mock',
          evaluatorId: 'scoring-critic',
          score,
          verdict: 'pass',
          structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
          validationStatus: 'fully_validated',
        };
      }),
    };

    const strategy = new MediaConsensusStrategy({
      imagesService,
      critics: [{ role: 'artifact_quality', evaluator: scoringCritic }],
    });

    const result = await strategy.execute(baseRequest());

    expect(result.candidates).toHaveLength(2);
    expect(result.degraded).toBe(false);
    // Second-generated candidate scored 0.9 > first's 0.4.
    expect(result.bestCandidateIndex).toBe(1);
    expect(result.bestArtifact?.b64_json).toBe('aW1hZ2UtdHdv');
    expect(result.bestArtifact?.modality).toBe('image');
    expect(imagesService.generateImages).toHaveBeenCalledTimes(2);
  });

  it('runs multiple critics independently and reconciles their scores', async () => {
    const images: ImageResult[] = [
      { images: [{ url: 'https://x/img.png' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
    ];
    const imagesService = fakeImagesService(images);
    const critics = [
      { role: 'spec_compliance' as const, evaluator: fakeEvaluator(0.8) },
      { role: 'artifact_quality' as const, evaluator: fakeEvaluator(0.6) },
      { role: 'tone' as const, evaluator: fakeEvaluator(1.0) },
    ];
    const strategy = new MediaConsensusStrategy({ imagesService, critics, candidateCount: 1 });
    const result = await strategy.execute(baseRequest({ candidateCount: 1 }));

    expect(result.candidates).toHaveLength(1);
    const record = result.candidates[0];
    expect(record.criticResults).toHaveLength(3);
    // Equal-weighted average of 0.8, 0.6, 1.0.
    expect(record.reconciledEvaluation.score).toBeCloseTo(0.8, 5);
    for (const critic of critics) {
      expect(critic.evaluator.evaluate).toHaveBeenCalledTimes(1);
    }
  });
});

describe('MediaConsensusStrategy — deterministic gate short-circuits the judge', () => {
  it('a candidate that fails the gate never reaches a critic', async () => {
    probeMedia.mockResolvedValue({
      durationSec: 2,
      streams: [{ codecType: 'video', width: 320, height: 240 }],
      hasVideo: true,
      hasAudio: false,
    });

    const videos: VideoResult[] = [
      {
        videos: [{ b64_json: Buffer.from('fake-video').toString('base64') }],
        modelUsed: 'vm',
        provider: 'vp',
        durationMs: 100,
      },
    ];
    const videoService = fakeVideoService(videos);
    const critic = fakeEvaluator(0.9);

    const strategy = new MediaConsensusStrategy({
      videoService,
      critics: [{ role: 'spec_compliance', evaluator: critic }],
      candidateCount: 1,
    });

    const result = await strategy.execute(
      baseRequest({
        capability: 'video_generation',
        candidateCount: 1,
        constraints: { durationSec: { minSec: 30 } },
      })
    );

    expect(result.candidates[0].gate.status).toBe('fail');
    expect(result.candidates[0].criticResults).toHaveLength(0);
    expect(critic.evaluate).not.toHaveBeenCalled();
    expect(result.candidates[0].outlierDetection.outlier).toBe(true);
    expect(result.degraded).toBe(true);
  });
});

describe('MediaConsensusStrategy — generation failures degrade gracefully', () => {
  it('one failed + one successful candidate → the successful one wins, no crash', async () => {
    const imagesService: ImagesOrchestrationService = {
      generateImages: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider 500'))
        .mockResolvedValueOnce({
          images: [{ url: 'https://x/ok.png' }],
          modelUsed: 'm',
          provider: 'p',
          durationMs: 5,
        } satisfies ImageResult),
    } as unknown as ImagesOrchestrationService;

    const critic = fakeEvaluator(0.7);
    const strategy = new MediaConsensusStrategy({
      imagesService,
      critics: [{ role: 'artifact_quality', evaluator: critic }],
      candidateCount: 2,
    });

    const result = await strategy.execute(baseRequest({ candidateCount: 2 }));

    expect(result.degraded).toBe(false);
    expect(result.bestCandidateIndex).toBe(1);
    expect(result.candidates[0].outlierDetection.outlier).toBe(true);
    expect(result.candidates[0].artifact.error).toBe('provider 500');
    // The failed candidate's artifact never reached a critic call.
    expect(critic.evaluate).toHaveBeenCalledTimes(1);
  });

  it('every candidate fails → degraded=true, still returns a best-of-the-worst pick', async () => {
    const imagesService: ImagesOrchestrationService = {
      generateImages: vi.fn().mockRejectedValue(new Error('provider down')),
    } as unknown as ImagesOrchestrationService;

    const strategy = new MediaConsensusStrategy({ imagesService, candidateCount: 2 });
    const result = await strategy.execute(baseRequest({ candidateCount: 2 }));

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('all_candidates_outliers');
    expect(result.bestCandidateIndex).toBeDefined();
    expect(result.candidates).toHaveLength(2);
  });
});

describe('reconcileCriticResults — pure function', () => {
  it('no critics configured → unavailable, never fabricated', () => {
    const r = reconcileCriticResults([], []);
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
  });

  it('any fail verdict wins over pass/uncertain (conservative reconciliation)', () => {
    const r = reconcileCriticResults(
      [
        {
          role: 'spec_compliance',
          result: { scoringMode: 'mock', evaluatorId: 'a', score: 0.9, verdict: 'pass', structural: { nonEmpty: true, meetsMinLength: true, executionError: false } },
        },
        {
          role: 'tone',
          result: { scoringMode: 'mock', evaluatorId: 'b', score: 0.1, verdict: 'fail', structural: { nonEmpty: true, meetsMinLength: true, executionError: false } },
        },
      ],
      []
    );
    expect(r.verdict).toBe('fail');
  });

  it('respects per-critic weights', () => {
    const r = reconcileCriticResults(
      [
        {
          role: 'spec_compliance',
          result: { scoringMode: 'mock', evaluatorId: 'a', score: 1.0, verdict: 'pass', structural: { nonEmpty: true, meetsMinLength: true, executionError: false } },
        },
        {
          role: 'tone',
          result: { scoringMode: 'mock', evaluatorId: 'b', score: 0.0, verdict: 'pass', structural: { nonEmpty: true, meetsMinLength: true, executionError: false } },
        },
      ],
      [
        { role: 'spec_compliance', evaluator: fakeEvaluator(1), weight: 3 },
        { role: 'tone', evaluator: fakeEvaluator(0), weight: 1 },
      ]
    );
    // (1.0*3 + 0.0*1) / 4 = 0.75
    expect(r.score).toBeCloseTo(0.75, 5);
  });
});

describe('pickBestCandidate — pure function', () => {
  function record(index: number, score: number | undefined): MediaCandidateRecord {
    return {
      index,
      artifact: { modality: 'image', stage_name: 's', stage_index: 0 },
      generationDurationMs: 1,
      gate: { status: 'skipped_no_constraints', violations: [] },
      criticResults: [],
      reconciledEvaluation: {
        scoringMode: 'composite',
        evaluatorId: 'x',
        score,
        verdict: 'pass',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      },
      outlierDetection: { outlier: false },
    };
  }

  it('empty pool → undefined', () => {
    expect(pickBestCandidate([])).toBeUndefined();
  });

  it('picks the highest score', () => {
    const best = pickBestCandidate([record(0, 0.3), record(1, 0.9), record(2, 0.5)]);
    expect(best?.index).toBe(1);
  });

  it('an undefined score always ranks last', () => {
    const best = pickBestCandidate([record(0, undefined), record(1, 0.01)]);
    expect(best?.index).toBe(1);
  });

  it('first survivor wins when nothing is scored', () => {
    const best = pickBestCandidate([record(0, undefined), record(1, undefined)]);
    expect(best?.index).toBe(0);
  });
});

describe('sampleFramesForCandidate', () => {
  it('image modality → the image itself is the single frame, no ffmpeg call', async () => {
    const artifact: AilinArtifact = {
      modality: 'image',
      stage_name: 's',
      stage_index: 0,
      b64_json: 'aW1hZ2U=',
    };
    const frames = await sampleFramesForCandidate(artifact);
    expect(frames).toEqual(['aW1hZ2U=']);
    expect(extractFrames).not.toHaveBeenCalled();
  });

  it('video modality → delegates to extractFrames and returns base64 frames', async () => {
    extractFrames.mockResolvedValue([
      { index: 0, timestampSec: 0, timestampMeasured: true, buffer: Buffer.from('f0'), mimeType: 'image/jpeg' },
      { index: 1, timestampSec: 1, timestampMeasured: true, buffer: Buffer.from('f1'), mimeType: 'image/jpeg' },
    ]);
    const artifact: AilinArtifact = {
      modality: 'video',
      stage_name: 's',
      stage_index: 0,
      b64_json: Buffer.from('video-bytes').toString('base64'),
    };
    const frames = await sampleFramesForCandidate(artifact);
    expect(extractFrames).toHaveBeenCalledOnce();
    expect(frames).toEqual([Buffer.from('f0').toString('base64'), Buffer.from('f1').toString('base64')]);
  });

  it('no b64_json → undefined, never throws', async () => {
    const frames = await sampleFramesForCandidate({
      modality: 'video',
      stage_name: 's',
      stage_index: 0,
      url: 'https://x/v.mp4',
    });
    expect(frames).toBeUndefined();
  });

  it('extractFrames throws MediaProcessingError-like → degrades to undefined, never throws', async () => {
    const { MediaProcessingError } = await vi.importActual<
      typeof import('@/services/media/ffmpeg-media-toolkit')
    >('@/services/media/ffmpeg-media-toolkit');
    extractFrames.mockRejectedValue(new MediaProcessingError('no frames'));
    const frames = await sampleFramesForCandidate({
      modality: 'video',
      stage_name: 's',
      stage_index: 0,
      b64_json: Buffer.from('video-bytes').toString('base64'),
    });
    expect(frames).toBeUndefined();
  });
});
