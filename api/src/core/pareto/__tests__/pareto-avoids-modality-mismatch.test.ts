// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-avoids-modality-mismatch.test.ts — MVP 8A
 *
 * Validates 15.3 + 15.7: audio/image candidates do not appear in a
 * text-task ensemble; cheap-harmful candidates are rejected too.
 */

import { describe, expect, it } from 'vitest';
import { optimizeParetoEnsemble } from '../pareto-ensemble-optimizer';
import {
  scoreAnchorA,
  scoreAnchorB,
  scorePairX,
  scoreModalityMismatchAudio,
  scoreModalityMismatchImage,
  scoreCheapHarmful,
  scoreMini,
  STANDARD_BASELINE,
} from './fixtures/candidate-fixtures';

describe('optimizer — modality + harm rejection', () => {
  it('audio TTS route never appears in a text-task selection', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [
        scorePairX(),
        scoreAnchorA(),
        scoreModalityMismatchAudio(),
      ],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.selectedModelIds).not.toContain('fx-audio-tts');
    const rejection = plan.rejectedCandidates.find(
      (r) => r.modelId === 'fx-audio-tts',
    );
    expect(rejection, 'audio reject record').toBeDefined();
    expect(rejection!.reason).toContain('modality');
  });

  it('image-generation route never appears in a text-task selection', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scoreAnchorA(), scoreModalityMismatchImage()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.selectedModelIds).not.toContain('fx-image-gen');
  });

  it('multi-mini pool: none of the minis appear, no matter how cheap', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [
        scoreMini('a'),
        scoreMini('b'),
        scoreMini('c'),
        scoreAnchorA(),
        scorePairX(),
      ],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    for (const id of ['fx-mini-a', 'fx-mini-b', 'fx-mini-c']) {
      expect(plan.selectedModelIds).not.toContain(id);
    }
  });

  it('cheap-but-harmful is rejected even when cheaper than the anchors', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scoreAnchorA(), scoreCheapHarmful()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.selectedModelIds).not.toContain('fx-cheap-harmful');
    const rec = plan.rejectedCandidates.find(
      (r) => r.modelId === 'fx-cheap-harmful',
    );
    expect(rec, 'cheap-harmful rejection record').toBeDefined();
    expect(rec!.reason.length).toBeGreaterThan(0);
  });

  it('modality-mismatch under non-strict policy: still rejected by scorer-level reject', () => {
    // The scorer already produced `rejected:true` with `modality_mismatch`
    // — the optimizer respects that flag regardless of policy.modalityStrict.
    const plan = optimizeParetoEnsemble({
      candidates: [scoreModalityMismatchAudio(), scorePairX()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: { modalityStrict: false },
    });
    expect(plan.selectedModelIds).not.toContain('fx-audio-tts');
  });

  it('explanation strings never embed PII or raw prompts', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [scoreAnchorA(), scoreAnchorB(), scorePairX()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
    });
    expect(plan.explanation).not.toContain('prompt');
    expect(plan.explanation).not.toContain('userMessage');
    expect(plan.explanation).not.toContain('rawContext');
  });
});
