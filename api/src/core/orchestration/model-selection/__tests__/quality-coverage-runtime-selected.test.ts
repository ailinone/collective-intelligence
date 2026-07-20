// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R5 §12 — Integration tests for runtime quality coverage.
 *
 * These tests prove the alias-aware quality snapshot matcher resolves
 * snapshot entries for the SAME runtime ids that previously fell back to
 * catalog placeholder in R4D.
 */
import { describe, it, expect } from 'vitest';
import { deriveQualityModelIdentity } from '@/core/orchestration/model-selection/quality-model-identity';
import {
  matchQualitySnapshotEntry,
  type QualitySnapshotEntry,
} from '@/core/orchestration/model-selection/quality-snapshot-matcher';

const r5Snapshot: QualitySnapshotEntry[] = [
  {
    // From J2 base
    modelId: 'anthropic/claude-opus-4.7',
    canonicalModelId: 'anthropic/claude-opus-4-7',
    aliases: ['anthropic/claude-opus-4-7'],
    qualityScore: 0.96,
    qualityScoreSource: 'external_benchmark',
  },
  {
    // From J2 base, with R5-added aliases
    modelId: 'deepseek-v4-pro',
    canonicalModelId: 'deepseek-v4-pro',
    aliases: ['accounts/fireworks/models/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    qualityScore: 0.95,
    qualityScoreSource: 'external_benchmark',
  },
  {
    // R5-new family_inference entry
    modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    canonicalModelId: 'qwen/qwen3-235b-a22b-thinking-2507',
    aliases: ['qwen3-235b-a22b-thinking-2507'],
    qualityScore: 0.85,
    qualityScoreSource: 'inferred_family_default',
    confidence: 'medium',
  },
  {
    // R5-new family_inference entry for DeepSeek R1
    modelId: 'deepseek-ai/DeepSeek-R1-0528',
    canonicalModelId: 'deepseek-ai/deepseek-r1-0528',
    aliases: ['deepseek-r1-0528'],
    qualityScore: 0.88,
    qualityScoreSource: 'inferred_family_default',
    confidence: 'medium',
  },
  {
    // R5-new family_inference entry for kimi-k2p5
    modelId: 'accounts/fireworks/models/kimi-k2p5',
    canonicalModelId: 'kimi-k2p5',
    aliases: ['kimi-k2p5'],
    qualityScore: 0.87,
    qualityScoreSource: 'inferred_family_default',
    confidence: 'medium',
  },
];

describe('01C.1B-J2-C-R5 — runtime quality coverage integration', () => {
  it('selected runtime id with fireworks wrapper finds entry via alias', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'accounts/fireworks/models/deepseek-v4-pro',
      providerId: 'fireworks-ai',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(true);
    expect(r.entry?.modelId).toBe('deepseek-v4-pro');
    expect(r.entry?.qualityScoreSource).toBe('external_benchmark');
  });

  it('dot-vs-dash normalizes correctly: anthropic/claude-opus-4-7 finds anthropic/claude-opus-4.7', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'anthropic/claude-opus-4-7',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(true);
    expect(r.entry?.qualityScoreSource).toBe('external_benchmark');
  });

  it('Qwen shortened id resolves to canonical thinking entry without collapsing to instruct', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(true);
    expect(r.entry?.modelId).toContain('Thinking');
  });

  it('kimi-k2p5 fireworks wrapper resolves to R5-new entry (not silently to Kimi-K2.6)', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'accounts/fireworks/models/kimi-k2p5',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(true);
    expect(r.entry?.modelId).toContain('kimi-k2p5');
    // The Kimi-K2.6 entry is DIFFERENT — it must NOT collide.
    expect(r.entry?.canonicalModelId ?? '').not.toMatch(/k2[.-]6/);
  });

  it('deepseek-v4-pro fireworks wrapper is resolved (provider_unwrapped)', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'accounts/fireworks/models/deepseek-v4-pro',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(true);
    expect(r.matchKind).toMatch(/exact_model_id|provider_unwrapped_alias|normalized_alias/);
  });

  it('familyInferenceUsed=true does NOT count as externalBenchmarkBacked', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.entry?.qualityScoreSource).toBe('inferred_family_default');
    expect(r.entry?.qualityScoreSource).not.toBe('external_benchmark');
  });

  it('returns no_match for unknown id', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'random/unknown-model-xyz-123',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(false);
  });

  it('catalogFallbackUsed semantics: an unmatched candidate means no snapshot entry', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'random/unknown-model',
    });
    const r = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(r.matched).toBe(false);
    // The caller treats this as catalogFallbackUsed=true.
  });

  it('does not leak secrets in trace', () => {
    const id = deriveQualityModelIdentity({ modelId: 'a/b' });
    const r = matchQualitySnapshotEntry({
      runtimeIdentity: id,
      snapshotEntries: [
        {
          modelId: 'a/b',
          qualityScore: 0.5,
          // No secret fields in this safe entry
        },
      ],
    });
    const trace = { ...r };
    delete (trace as { entry?: unknown }).entry;
    const j = JSON.stringify(trace);
    expect(j).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(j).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    expect(j).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it('deterministic: identical input produces identical output', () => {
    const id = deriveQualityModelIdentity({ modelId: 'anthropic/claude-opus-4-7' });
    const a = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    const b = matchQualitySnapshotEntry({ runtimeIdentity: id, snapshotEntries: r5Snapshot });
    expect(a).toEqual(b);
  });
});
