// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring contract — quality-multipass must degrade/rotate, never crash the
 * stream when its primary route dies mid-request.
 *
 * Why a string-grep test (same pattern as collective-dead-skip-wiring):
 * the 2026-08-21 post-deploy probes (mAUd5n7PTnssGlo1ok04S,
 * dCG2M4-ss9HL9Zd5yKVYG) showed the STREAMING path crashing the whole
 * strategy on two distinct throw sites:
 *   1. generateResponse threw "No adapter found" when every provider able
 *      to serve the model was dead/FC-rejected — instead of rotating.
 *   2. executeStream's final synthesis threw on null adapter even though a
 *      best pass had ALREADY been generated.
 * Plus: executeStream had NO failed-generation rotation (execute() had it)
 * and an unguarded validator could take the whole stream down.
 *
 * The regression mode is silent refactoring — lock the wiring textually.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '..', 'strategies', 'quality-multipass-strategy.ts'),
  'utf8'
);

describe('quality-multipass stream resilience wiring', () => {
  it('generateResponse returns a FAILED execution on null adapter (no throw)', () => {
    expect(src).toMatch(
      /No adapter could be resolved for model — returning failed execution for rotation/
    );
    expect(src).toMatch(
      /`No adapter found for model: \$\{model\.id\}`/
    );
  });

  it('executeStream rotates the primary when a pass fails', () => {
    expect(src).toMatch(/Stream pass generation failed — rotating primary model/);
    // bounded multi-candidate rotation, not a single alternate swap
    expect(src).toMatch(/while \(!generation\.success && rotationBudget > 0\)/);
    expect(src).toMatch(/primaryModel = alternate;/);
  });

  it('validator failures fall back to the content heuristic instead of killing the stream', () => {
    expect(src).toMatch(/Validator threw — scoring pass with content heuristic/);
    expect(src).toMatch(/this\.calculateQualityScore\(generation\)/);
  });

  it('final synthesis degrades to the best pass content when the adapter is gone', () => {
    expect(src).toMatch(/Final synthesis adapter unavailable — degrading to best pass content/);
    expect(src).toMatch(/yield bestExecution\.response;/);
  });
});
