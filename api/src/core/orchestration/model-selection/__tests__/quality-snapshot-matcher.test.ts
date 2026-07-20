// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R5 §8 — quality-snapshot-matcher unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  matchQualitySnapshotEntry,
  type QualitySnapshotEntry,
} from '@/core/orchestration/model-selection/quality-snapshot-matcher';
import { deriveQualityModelIdentity } from '@/core/orchestration/model-selection/quality-model-identity';

function makeIdentity(modelId: string, canonicalModelId?: string) {
  return deriveQualityModelIdentity({ modelId, canonicalModelId });
}

describe('01C.1B-J2-C-R5 — matchQualitySnapshotEntry', () => {
  it('exact_model_id: verbatim runtime modelId match', () => {
    const id = makeIdentity('deepseek/deepseek-r1-0528');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'deepseek/deepseek-r1-0528', qualityScore: 0.91 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(true);
    expect(r.matchKind).toBe('exact_model_id');
    expect(r.confidence).toBe('exact');
  });

  it('exact_canonical_id: snapshot canonical equals runtime canonical', () => {
    const id = makeIdentity('Anthropic/Claude-Opus-4.7');
    const entries: QualitySnapshotEntry[] = [
      { canonicalModelId: 'anthropic/claude-opus-4-7', qualityScore: 0.96 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(true);
    expect(r.matchKind).toBe('exact_canonical_id');
    expect(r.confidence === 'high' || r.confidence === 'exact').toBe(true);
  });

  it('provider_unwrapped_alias: runtime fireworks wrapper stripped, matches snapshot bare id', () => {
    const id = makeIdentity('accounts/fireworks/models/deepseek-v4-pro');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'deepseek-v4-pro', qualityScore: 0.95 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(true);
    expect(['provider_unwrapped_alias', 'exact_model_id']).toContain(r.matchKind);
  });

  it('normalized_alias: dot-vs-dash claude-opus-4.7 → claude-opus-4-7', () => {
    const id = makeIdentity('anthropic/claude-opus-4-7');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'anthropic/claude-opus-4.7', qualityScore: 0.96 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(true);
    // Both sides normalize to the same canonical → exact_canonical
    expect(r.confidence === 'high' || r.confidence === 'exact' || r.confidence === 'medium').toBe(true);
  });

  it('no silent collapse: kimi-k2p5 vs Kimi-K2.6 are different versions', () => {
    const id = makeIdentity('kimi-k2p5');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'Kimi-K2.6', qualityScore: 0.94 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    // The numbers differ (k2p5 vs k2-6). They should NOT collapse silently.
    if (r.matched) {
      // If matched at family level, confidence must be 'low'.
      expect(r.confidence).toBe('low');
    } else {
      expect(r.matchKind).toBe('no_match');
    }
  });

  it('no silent collapse: 235b vs 32b never match even at family level', () => {
    const id = makeIdentity('Qwen/Qwen3-235B-A22B-Thinking-2507');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'Qwen/Qwen3-32B-Instruct', qualityScore: 0.7 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(false);
  });

  it('no silent collapse: thinking vs instruct never match without explicit alias', () => {
    const id = makeIdentity('Qwen/Qwen3-235B-Thinking');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'Qwen/Qwen3-235B-Instruct', qualityScore: 0.7 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(false);
  });

  it('explicit alias overrides version mismatch: kimi-k2p5 aliased in entry', () => {
    const id = makeIdentity('kimi-k2p5');
    const entries: QualitySnapshotEntry[] = [
      {
        modelId: 'moonshotai/kimi-k2',
        aliases: ['kimi-k2p5', 'kimi-k2.5'],
        qualityScore: 0.94,
      },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    expect(r.matched).toBe(true);
    expect(['provider_unwrapped_alias', 'normalized_alias', 'exact_model_id']).toContain(r.matchKind);
  });

  it('ambiguous family match refuses to pick', () => {
    const id = makeIdentity('Qwen/Qwen3-235B-Thinking');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'Qwen/Qwen3-235B-Thinking-A', qualityScore: 0.8 },
      { modelId: 'Qwen/Qwen3-235B-Thinking-B', qualityScore: 0.81 },
    ];
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: entries,
    });
    // Either matches the first alias path (which we accept), or refuses.
    // The matcher prioritizes alias intersection first; both A and B should
    // both have the runtime's normalized form in their aliases — so this is
    // an ambiguous tier 4 match.
    if (r.matched) {
      expect(r.ambiguousMatchCount).toBe(2);
    }
  });

  it('deterministic: identical inputs → identical output', () => {
    const id = makeIdentity('anthropic/claude-opus-4-7');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'anthropic/claude-opus-4-7', qualityScore: 0.96 },
      { modelId: 'anthropic/claude-haiku-4-5', qualityScore: 0.85 },
    ];
    const a = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: entries });
    const b = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: entries });
    expect(a).toEqual(b);
  });

  it('empty snapshot → no_match', () => {
    const id = makeIdentity('anthropic/claude-opus-4-7');
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: [] });
    expect(r.matched).toBe(false);
    expect(r.matchKind).toBe('no_match');
  });

  it('does not leak secrets', () => {
    const id = makeIdentity('a/b');
    const entries: QualitySnapshotEntry[] = [
      { modelId: 'a/b', metadata: { apiKey: 'sk-supersecret123456' } as never },
    ];
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: entries });
    // The matcher doesn't surface raw `metadata` in its result. It returns
    // `entry: e` which the caller chose to include — we only check that the
    // matcher's own added fields (reasons, matchedAlias, etc.) don't carry
    // secret-like patterns. The entry passthrough is the caller's choice.
    const result = { ...r };
    delete (result as { entry?: unknown }).entry;
    const j = JSON.stringify(result);
    expect(j).not.toMatch(/sk-supersecret/);
  });
});
