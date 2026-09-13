// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaJudgeEvaluator — dispatch + safety-gate tests.
 *
 * Mirrors llm-judge-evaluator.test.ts's structure. The two things this
 * file must prove per the architecture:
 *   1. no `candidate` (or `candidate.kind === 'text'`) degrades to the
 *      EXACT text-judging path LLMJudgeEvaluator already implements.
 *   2. a media candidate builds a real multi-part prompt and never
 *      fabricates a score when frames/transcript/config are missing.
 */
import { describe, it, expect, vi } from 'vitest';
import { MediaJudgeEvaluator, buildMediaJudgeContent } from './media-judge-evaluator';
import type { MediaCandidateArtifact, EvaluatorInput } from './strategy-output-evaluator';
import type { LLMJudgeClient } from './llm-judge-evaluator.types';
import type { MediaJudgeClient, MediaJudgeEvaluatorConfig, MediaJudgeInput } from './media-judge-evaluator.types';

const baseConfig: MediaJudgeEvaluatorConfig = {
  enabled: true,
  judgeModelId: 'vision-judge-x',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
  rubricVersion: 'media-v1',
  criticRole: 'artifact_quality',
};

const baseInput: EvaluatorInput = {
  task: { taskType: 'video_generation' },
  output: '',
  strategyName: 'media-consensus',
  role: 'voter',
};

function mediaClientThatShouldNotBeCalled(): MediaJudgeClient {
  return {
    judgeMedia: vi.fn(async () => {
      throw new Error('media client was called when it should not have been');
    }),
  };
}

const videoCandidate: MediaCandidateArtifact = {
  kind: 'media',
  artifact: {
    modality: 'video',
    stage_name: 'stage-0',
    stage_index: 0,
    b64_json: 'ZmFrZS12aWRlby1ieXRlcw==',
    mime_type: 'video/mp4',
  },
  sampledFrames: ['ZnJhbWUtb25l', 'ZnJhbWUtdHdv'],
};

describe('MediaJudgeEvaluator — degrades to text judging unchanged', () => {
  it('no candidate → delegates to LLMJudgeEvaluator path (client never called for media)', async () => {
    const mediaClient = mediaClientThatShouldNotBeCalled();
    const textClient: LLMJudgeClient = {
      judge: async () => ({ score: 0.6, verdict: 'pass' }),
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient, textClient);
    const r = await ev.evaluate({ ...baseInput, output: 'a long enough plain text answer here' });
    expect(r.score).toBe(0.6);
    expect(r.verdict).toBe('pass');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
    expect(r.evaluatorId).toBe('media-judge-artifact_quality-media-v1');
  });

  it('candidate.kind === "text" → delegates using candidate.content as output', async () => {
    const textClient: LLMJudgeClient = {
      judge: vi.fn(async (input) => {
        expect(input.output).toBe('candidate text wins over EvaluatorInput.output');
        return { score: 0.9, verdict: 'pass' };
      }),
    };
    const ev = new MediaJudgeEvaluator(baseConfig, undefined, textClient);
    const r = await ev.evaluate({
      ...baseInput,
      output: 'should be ignored',
      candidate: { kind: 'text', content: 'candidate text wins over EvaluatorInput.output' },
    });
    expect(r.score).toBe(0.9);
  });
});

describe('MediaJudgeEvaluator — audio candidates degrade via transcript', () => {
  it('transcript present → judged as text', async () => {
    const textClient: LLMJudgeClient = {
      judge: async () => ({ score: 0.75, verdict: 'pass' }),
    };
    const ev = new MediaJudgeEvaluator(baseConfig, undefined, textClient);
    const r = await ev.evaluate({
      ...baseInput,
      candidate: {
        kind: 'media',
        artifact: { modality: 'audio', stage_name: 's', stage_index: 0, url: 'https://x/a.wav' },
        transcript: 'hello world, this is the transcript',
      },
    });
    expect(r.score).toBe(0.75);
    expect(r.notes).toContain('audio candidate judged via transcript');
  });

  it('transcript missing → unavailable, never fabricated', async () => {
    const ev = new MediaJudgeEvaluator(baseConfig);
    const r = await ev.evaluate({
      ...baseInput,
      candidate: {
        kind: 'media',
        artifact: { modality: 'audio', stage_name: 's', stage_index: 0, url: 'https://x/a.wav' },
      },
    });
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('audio_transcript_missing');
  });
});

describe('MediaJudgeEvaluator — media candidates never fabricate a score', () => {
  it('artifact.error set (generation failed) → fail, score 0, no client call', async () => {
    const mediaClient = mediaClientThatShouldNotBeCalled();
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluate({
      ...baseInput,
      candidate: {
        kind: 'media',
        artifact: { modality: 'video', stage_name: 's', stage_index: 0, error: 'provider 500' },
      },
    });
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('fail');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('no sampledFrames → unavailable, client never called', async () => {
    const mediaClient = mediaClientThatShouldNotBeCalled();
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluate({
      ...baseInput,
      candidate: {
        kind: 'media',
        artifact: { modality: 'video', stage_name: 's', stage_index: 0, b64_json: 'abc' },
        sampledFrames: [],
      },
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('no_sampled_frames');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('unsupported "file" modality → unavailable', async () => {
    const ev = new MediaJudgeEvaluator(baseConfig);
    const r = await ev.evaluate({
      ...baseInput,
      candidate: {
        kind: 'media',
        artifact: { modality: 'file', stage_name: 's', stage_index: 0, url: 'https://x/f.pdf' },
        sampledFrames: ['abc'],
      },
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('media_judge_unsupported_modality:file');
  });

  it('enabled=false → unavailable, media client never called', async () => {
    const mediaClient = mediaClientThatShouldNotBeCalled();
    const ev = new MediaJudgeEvaluator({ ...baseConfig, enabled: false }, mediaClient);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('media_judge_disabled');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('missing judgeModelId → unavailable, media client never called', async () => {
    const mediaClient = mediaClientThatShouldNotBeCalled();
    const ev = new MediaJudgeEvaluator({ ...baseConfig, judgeModelId: undefined }, mediaClient);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('judge_model_id_missing');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('maxCostUsd=0 → unavailable, media client never called', async () => {
    const mediaClient = mediaClientThatShouldNotBeCalled();
    const ev = new MediaJudgeEvaluator({ ...baseConfig, maxCostUsd: 0 }, mediaClient);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('budget_zero_or_invalid');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('no media client injected → unavailable', async () => {
    const ev = new MediaJudgeEvaluator(baseConfig);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('media_judge_client_unavailable');
  });
});

describe('MediaJudgeEvaluator — happy path with mock media client', () => {
  it('dispatches with the frames + rubric and returns fully_validated', async () => {
    let seenInput: MediaJudgeInput | undefined;
    const mediaClient: MediaJudgeClient = {
      judgeMedia: async (input) => {
        seenInput = input;
        return { score: 0.85, verdict: 'pass', confidence: 0.8, shortRationale: 'looks right' };
      },
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });

    expect(r.score).toBe(0.85);
    expect(r.verdict).toBe('pass');
    expect(r.validationStatus).toBe('fully_validated');
    expect(r.notes).toContain('critic=artifact_quality');

    expect(seenInput?.criticRole).toBe('artifact_quality');
    expect(seenInput?.content.some((p) => p.type === 'text')).toBe(true);
    expect(seenInput?.content.filter((p) => p.type === 'video_frame')).toHaveLength(2);
  });

  it('judgeModelOverride takes precedence over config.judgeModelId', async () => {
    let seenModelId: string | undefined;
    const mediaClient: MediaJudgeClient = {
      judgeMedia: async (input) => {
        seenModelId = input.judgeModelId;
        return { score: 0.5, verdict: 'pass' };
      },
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    await ev.evaluate({
      ...baseInput,
      candidate: videoCandidate,
      judgeModelOverride: 'dynamic-vision-model',
    });
    expect(seenModelId).toBe('dynamic-vision-model');
  });

  it('malformed judge result (out-of-range score) → uncertain + unavailable', async () => {
    const mediaClient: MediaJudgeClient = {
      judgeMedia: async () => ({ score: 5, verdict: 'pass' }),
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
  });

  it('client throws → uncertain + unavailable, never crashes', async () => {
    const mediaClient: MediaJudgeClient = {
      judgeMedia: async () => {
        throw new Error('provider 503');
      },
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluate({ ...baseInput, candidate: videoCandidate });
    expect(r.verdict).toBe('uncertain');
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('provider 503');
  });
});

describe('buildMediaJudgeContent', () => {
  it('embeds one video_frame part per sampled frame plus a text header', () => {
    const content = buildMediaJudgeContent(baseInput, videoCandidate, videoCandidate.sampledFrames!);
    expect(content[0].type).toBe('text');
    const frames = content.filter((p) => p.type === 'video_frame');
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      if (f.type === 'video_frame') {
        // videoCandidate's mime_type is 'video/mp4' (not an image/* type), so
        // the frame data URL falls back to the jpeg default (frames are
        // always sampled as JPEGs by ffmpeg-media-toolkit's extractFrames).
        expect(f.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
        expect(f.timestamp_measured).toBe(false);
      }
    }
  });
});
