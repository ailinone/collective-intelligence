// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaJudgeEvaluator — before/after image-edit verification (Section D).
 *
 * `evaluateImageEdit` is a NEW method alongside the existing `evaluate()`
 * contract (it does not implement `StrategyOutputEvaluator` — a before/after
 * PAIR of images has no equivalent single-`CandidateArtifact` shape). It
 * reuses the exact same safety gates as `evaluateVisualMedia` (disabled
 * config, missing judge model id, zero/invalid budget, no injected client)
 * and the same `MediaJudgeClient`/`buildImageEditJudgeContent` machinery.
 */
import { describe, it, expect, vi } from 'vitest';
import { MediaJudgeEvaluator, buildImageEditJudgeContent } from './media-judge-evaluator';
import type { MediaJudgeClient, MediaJudgeEvaluatorConfig, MediaJudgeInput } from './media-judge-evaluator.types';
import type { AilinArtifact } from '@/types';

const baseConfig: MediaJudgeEvaluatorConfig = {
  enabled: true,
  judgeModelId: 'vision-judge-x',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
  rubricVersion: 'media-v1',
  criticRole: 'spec_compliance',
};

function preArtifact(): AilinArtifact {
  return {
    modality: 'image',
    stage_name: 'gen-turn',
    stage_index: 0,
    b64_json: 'cHJlLWVkaXQtaW1hZ2UtYnl0ZXM=',
    mime_type: 'image/png',
  };
}

function postArtifact(): AilinArtifact {
  return {
    modality: 'image',
    stage_name: 'edit-turn',
    stage_index: 1,
    b64_json: 'cG9zdC1lZGl0LWltYWdlLWJ5dGVz',
    mime_type: 'image/png',
  };
}

describe('buildImageEditJudgeContent', () => {
  it('includes the edit instruction and both images, labeled before/after', () => {
    const content = buildImageEditJudgeContent(
      'make the sky orange',
      preArtifact(),
      postArtifact()
    );
    const text = content
      .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    expect(text).toContain('make the sky orange');
    expect(text.toUpperCase()).toContain('BEFORE');
    expect(text.toUpperCase()).toContain('AFTER');
    const images = content.filter(
      (p): p is Extract<typeof p, { type: 'image_url' }> => p.type === 'image_url'
    );
    expect(images).toHaveLength(2);
  });

  it('embeds the exact base64 bytes under the artifact mime type', () => {
    const content = buildImageEditJudgeContent(
      'make the sky orange',
      preArtifact(),
      postArtifact()
    );
    const images = content.filter(
      (p): p is Extract<typeof p, { type: 'image_url' }> => p.type === 'image_url'
    );
    expect(images[0].image_url.url).toBe(
      'data:image/png;base64,cHJlLWVkaXQtaW1hZ2UtYnl0ZXM='
    );
    expect(images[1].image_url.url).toBe(
      'data:image/png;base64,cG9zdC1lZGl0LWltYWdlLWJ5dGVz'
    );
  });

  it('falls back to image/jpeg when mime_type is missing or non-image', () => {
    const content = buildImageEditJudgeContent(
      'make the sky orange',
      { ...preArtifact(), mime_type: undefined },
      { ...postArtifact(), mime_type: 'application/octet-stream' }
    );
    const images = content.filter(
      (p): p is Extract<typeof p, { type: 'image_url' }> => p.type === 'image_url'
    );
    expect(images[0].image_url.url).toBe(
      'data:image/jpeg;base64,cHJlLWVkaXQtaW1hZ2UtYnl0ZXM='
    );
    expect(images[1].image_url.url).toBe(
      'data:image/jpeg;base64,cG9zdC1lZGl0LWltYWdlLWJ5dGVz'
    );
  });
});

describe('MediaJudgeEvaluator.evaluateImageEdit — safety gates', () => {
  it('disabled config → unavailable, client never called', async () => {
    const mediaClient: MediaJudgeClient = { judgeMedia: vi.fn() };
    const ev = new MediaJudgeEvaluator({ ...baseConfig, enabled: false }, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('no injected client → unavailable', async () => {
    const ev = new MediaJudgeEvaluator(baseConfig, undefined);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
  });

  it('missing pre or post bytes → unavailable, never fabricates a verdict', async () => {
    const mediaClient: MediaJudgeClient = { judgeMedia: vi.fn() };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: { ...preArtifact(), b64_json: undefined },
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('missing/empty judge model id → unavailable, client never called', async () => {
    const mediaClient: MediaJudgeClient = { judgeMedia: vi.fn() };
    const ev = new MediaJudgeEvaluator({ ...baseConfig, judgeModelId: undefined }, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('invalid/zero maxCostUsd → unavailable, client never called', async () => {
    const mediaClient: MediaJudgeClient = { judgeMedia: vi.fn() };
    const ev = new MediaJudgeEvaluator({ ...baseConfig, maxCostUsd: 0 }, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });
});

describe('MediaJudgeEvaluator.evaluateImageEdit — real (mocked) call', () => {
  it('dispatches through the injected client and returns its verdict', async () => {
    const judgeMedia = vi.fn(
      async (input: MediaJudgeInput) =>
        ({ score: 0.9, verdict: 'pass' as const, confidence: 0.8, costUsd: 0.001 })
    );
    const mediaClient: MediaJudgeClient = { judgeMedia };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make the sky orange',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(judgeMedia).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe('pass');
    expect(r.score).toBe(0.9);
    expect(r.validationStatus).toBe('fully_validated');
  });

  it('client throws → uncertain/unavailable, never throws out of evaluateImageEdit', async () => {
    const mediaClient: MediaJudgeClient = {
      judgeMedia: vi.fn().mockRejectedValue(new Error('provider timeout')),
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make the sky orange',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.verdict).toBe('uncertain');
    expect(r.validationStatus).toBe('unavailable');
  });
});
