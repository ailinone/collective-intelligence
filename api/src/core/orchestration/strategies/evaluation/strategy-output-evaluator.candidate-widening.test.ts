// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AT — `EvaluatorInput.candidate` additive-widening regression test.
 *
 * `candidate` is a brand-new, optional field. Every EXISTING evaluator
 * implementation must keep scoring `output` exactly as before, whether or
 * not a caller also populates `candidate` alongside it — only
 * `MediaJudgeEvaluator` is allowed to look at it. This file proves that for
 * every text-only evaluator implementation in this directory (except the
 * ones that need live provider/DB wiring to construct, which are covered by
 * their own existing test suites).
 */
import { describe, it, expect } from 'vitest';
import { StructuralOutputEvaluator } from './structural-evaluator';
import { UnavailableStrategyOutputEvaluator } from './unavailable-evaluator';
import { MockStrategyOutputEvaluator } from './mock-evaluator';
import type { EvaluatorInput, MediaCandidateArtifact } from './strategy-output-evaluator';

const irrelevantMediaCandidate: MediaCandidateArtifact = {
  kind: 'media',
  artifact: { modality: 'video', stage_name: 'stage', stage_index: 0, url: 'https://example.com/x.mp4' },
  sampledFrames: ['ZmFrZS1mcmFtZQ=='],
};

const baseInput: EvaluatorInput = {
  task: { taskType: 'analysis' },
  output: 'A perfectly ordinary text answer, long enough to pass any length check that might apply.',
  strategyName: 'consensus',
  role: 'voter',
  modelId: 'some-model',
};

describe('EvaluatorInput.candidate — additive widening does not affect existing evaluators', () => {
  it('StructuralOutputEvaluator: identical result with or without `candidate`', async () => {
    const ev = new StructuralOutputEvaluator();
    const without = await ev.evaluate(baseInput);
    const withCandidate = await ev.evaluate({ ...baseInput, candidate: irrelevantMediaCandidate });
    expect(withCandidate).toEqual(without);
  });

  it('UnavailableStrategyOutputEvaluator: identical result with or without `candidate`', async () => {
    const ev = new UnavailableStrategyOutputEvaluator();
    const without = await ev.evaluate(baseInput);
    const withCandidate = await ev.evaluate({ ...baseInput, candidate: irrelevantMediaCandidate });
    expect(withCandidate).toEqual(without);
  });

  it('MockStrategyOutputEvaluator: identical result with or without `candidate`', async () => {
    const ev = new MockStrategyOutputEvaluator({ byModelId: { 'some-model': 0.77 } });
    const without = await ev.evaluate(baseInput);
    const withCandidate = await ev.evaluate({ ...baseInput, candidate: irrelevantMediaCandidate });
    expect(withCandidate).toEqual(without);
    expect(without.score).toBe(0.77);
  });

  it('a text `candidate` alongside `output` is likewise ignored by text-only evaluators', async () => {
    const ev = new StructuralOutputEvaluator();
    const without = await ev.evaluate(baseInput);
    const withTextCandidate = await ev.evaluate({
      ...baseInput,
      candidate: { kind: 'text', content: 'a completely different string' },
    });
    expect(withTextCandidate).toEqual(without);
  });
});
