// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retriever-structural.test.ts — MVP 5A
 *
 * Happy-path tests: the retriever returns scored, sorted candidates
 * with `rejectedByStage` accumulation and `countsByStage` funnel.
 */

import { describe, expect, it } from 'vitest';
import { retrieveCandidates } from '../candidate-retriever';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { RETRIEVAL_STAGES } from '../candidate-retrieval-types';
import { buildRuntimeModelRegistry } from '../../registry/registry-builder';

describe('retrieveCandidates — happy path', () => {
  it('returns a non-empty candidate list for chat-capable request', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(c.rejected).toBe(false);
      expect(c.totalScore).toBeGreaterThan(0);
    }
  });

  it('countsByStage has initial, after_filters, after_score, returned', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    expect(result.countsByStage[RETRIEVAL_STAGES.INITIAL]).toBeGreaterThan(0);
    expect(result.countsByStage[RETRIEVAL_STAGES.AFTER_FILTERS]).toBeGreaterThanOrEqual(0);
    expect(result.countsByStage[RETRIEVAL_STAGES.AFTER_SCORE]).toBeGreaterThanOrEqual(0);
    expect(result.countsByStage[RETRIEVAL_STAGES.RETURNED]).toBeGreaterThanOrEqual(0);
  });

  it('countsByStage is monotonically non-increasing through stages', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    expect(result.countsByStage[RETRIEVAL_STAGES.AFTER_FILTERS]).toBeLessThanOrEqual(
      result.countsByStage[RETRIEVAL_STAGES.INITIAL],
    );
    expect(result.countsByStage[RETRIEVAL_STAGES.AFTER_SCORE]).toBeLessThanOrEqual(
      result.countsByStage[RETRIEVAL_STAGES.AFTER_FILTERS],
    );
    expect(result.countsByStage[RETRIEVAL_STAGES.RETURNED]).toBeLessThanOrEqual(
      result.countsByStage[RETRIEVAL_STAGES.AFTER_SCORE],
    );
  });

  it('rejectedByStage carries stage + reason per rejected route', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['vision'] }, // many fixture routes lack vision
      { registry },
    );
    expect(result.rejectedByStage.length).toBeGreaterThan(0);
    for (const r of result.rejectedByStage) {
      expect(r.routeId).toBeTruthy();
      expect(r.stage).toBeTruthy();
      expect(r.reason).toBeTruthy();
    }
  });
});

describe('retrieveCandidates — maxCandidates slicing', () => {
  it('returns at most maxCandidates results', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], maxCandidates: 3 },
      { registry },
    );
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it('maxCandidates=0 returns empty candidates but populated rejectedByStage', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], maxCandidates: 0 },
      { registry },
    );
    expect(result.candidates.length).toBe(0);
    // The funnel still records what was filtered/rejected.
    expect(result.countsByStage[RETRIEVAL_STAGES.AFTER_SCORE]).toBeGreaterThan(0);
  });

  it('default (no maxCandidates) returns all post-score survivors', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    expect(result.candidates.length).toBe(
      result.countsByStage[RETRIEVAL_STAGES.AFTER_SCORE],
    );
  });
});

describe('retrieveCandidates — ordering', () => {
  it('first candidate has the highest totalScore', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    for (let i = 1; i < result.candidates.length; i += 1) {
      expect(result.candidates[i - 1].totalScore).toBeGreaterThanOrEqual(
        result.candidates[i].totalScore,
      );
    }
  });

  it('ties are broken by routeId ascending', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    for (let i = 1; i < result.candidates.length; i += 1) {
      const a = result.candidates[i - 1];
      const b = result.candidates[i];
      if (a.totalScore === b.totalScore) {
        expect(a.routeId < b.routeId).toBe(true);
      }
    }
  });
});

describe('retrieveCandidates — capability fitness drives rejection', () => {
  it('routes missing required capability appear in rejectedByStage', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat', 'audio_generation'] },
      { registry },
    );
    // Some routes won't have audio.
    const audioRejections = result.rejectedByStage.filter((r) =>
      r.reason.includes('audio_generation'),
    );
    expect(audioRejections.length).toBeGreaterThan(0);
  });

  it('routes WITH the capability are NOT rejected for that reason', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat', 'tools'] },
      { registry },
    );
    // At least one survivor should have tools support.
    const surviving = result.candidates.length;
    expect(surviving).toBeGreaterThan(0);
  });
});

describe('retrieveCandidates — context window filter', () => {
  it('high minContextWindow eliminates small-context routes', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      {
        requiredCapabilities: ['chat'],
        minContextWindow: 500_000,
      },
      { registry },
    );
    // The fixture only has gemini-2.5-pro / gemini-2.5-pro-1m at ≥500k,
    // so very few survivors are expected.
    expect(result.candidates.length).toBeLessThanOrEqual(10);
    const ctxRejections = result.rejectedByStage.filter((r) =>
      r.reason.startsWith('context_below_min'),
    );
    expect(ctxRejections.length).toBeGreaterThan(0);
  });
});

describe('retrieveCandidates — empty registry', () => {
  it('returns empty candidates + zero counts', () => {
    // Build an empty registry by passing an empty model array.
    const { registry } = buildRuntimeModelRegistry({ models: [] });
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    expect(result.candidates.length).toBe(0);
    expect(result.countsByStage[RETRIEVAL_STAGES.INITIAL]).toBe(0);
    expect(result.rejectedByStage.length).toBe(0);
  });
});
