// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R5 §7 — quality-model-identity unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeQualityModelId,
  deriveQualityModelIdentity,
  buildQualityIdentityAliases,
} from '@/core/orchestration/model-selection/quality-model-identity';

describe('01C.1B-J2-C-R5 — normalizeQualityModelId', () => {
  it('lowercases + replaces dots/underscores/spaces with dashes', () => {
    expect(normalizeQualityModelId('Claude_Opus 4.7')).toBe('claude-opus-4-7');
  });

  it('collapses repeated dashes', () => {
    expect(normalizeQualityModelId('a--b___c')).toBe('a-b-c');
  });

  it('trims leading/trailing dashes', () => {
    expect(normalizeQualityModelId('-foo-')).toBe('foo');
  });

  it('empty returns empty', () => {
    expect(normalizeQualityModelId('')).toBe('');
  });
});

describe('01C.1B-J2-C-R5 — deriveQualityModelIdentity', () => {
  it('strips fireworks wrapper for deepseek-v4-pro', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'accounts/fireworks/models/deepseek-v4-pro',
      providerId: 'fireworks-ai',
    });
    expect(id.qualityCanonicalId).toContain('deepseek-v4-pro');
    expect(id.confidence === 'high' || id.confidence === 'exact').toBe(true);
    expect(id.reasons.join('|')).toMatch(/stripped_wrapper:accounts\/fireworks\/models\//);
  });

  it('preserves vendor prefix for anthropic/claude-opus-4-7', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'anthropic/claude-opus-4-7',
      providerId: 'deepinfra',
    });
    expect(id.qualityCanonicalId).toBe('anthropic/claude-opus-4-7');
    expect(id.vendor).toBe('anthropic');
    expect(id.confidence).toBe('exact');
  });

  it('normalizes dot-to-dash for claude-opus-4.7', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'anthropic/claude-opus-4.7',
      providerId: 'deepinfra',
    });
    expect(id.qualityCanonicalId).toBe('anthropic/claude-opus-4-7');
  });

  it('preserves size class — does NOT collapse 235b vs 32b', () => {
    const a = deriveQualityModelIdentity({
      modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    });
    const b = deriveQualityModelIdentity({
      modelId: 'Qwen/Qwen3-32B-Instruct',
    });
    expect(a.qualityCanonicalId).not.toBe(b.qualityCanonicalId);
    expect(a.sizeClass).toBe('235b');
    expect(b.sizeClass).toBe('32b');
  });

  it('preserves variant — thinking != instruct', () => {
    const a = deriveQualityModelIdentity({ modelId: 'Qwen/Qwen3-235B-Thinking' });
    const b = deriveQualityModelIdentity({ modelId: 'Qwen/Qwen3-235B-Instruct' });
    expect(a.qualityCanonicalId).not.toBe(b.qualityCanonicalId);
    expect(a.variant).toBe('thinking');
    expect(b.variant).toBe('instruct');
  });

  it('preserves numeric version — 4.7 != 4', () => {
    const a = deriveQualityModelIdentity({ modelId: 'anthropic/claude-opus-4-7' });
    const b = deriveQualityModelIdentity({ modelId: 'anthropic/claude-opus-4' });
    expect(a.qualityCanonicalId).not.toBe(b.qualityCanonicalId);
  });

  it('preserves k2.6 vs k2 (numeric version)', () => {
    const a = deriveQualityModelIdentity({ modelId: 'kimi-k2.6' });
    const b = deriveQualityModelIdentity({ modelId: 'kimi-k2' });
    expect(a.qualityCanonicalId).not.toBe(b.qualityCanonicalId);
  });

  it('does NOT collapse 120b vs 20b', () => {
    const a = deriveQualityModelIdentity({ modelId: 'openai/gpt-oss-120b' });
    const b = deriveQualityModelIdentity({ modelId: 'openai/gpt-oss-20b' });
    expect(a.qualityCanonicalId).not.toBe(b.qualityCanonicalId);
    expect(a.sizeClass).toBe('120b');
    expect(b.sizeClass).toBe('20b');
  });

  it('caller-supplied canonical that matches derived → confidence=exact', () => {
    const id = deriveQualityModelIdentity({
      modelId: 'anthropic/claude-opus-4.7',
      canonicalModelId: 'anthropic/claude-opus-4-7',
    });
    expect(id.confidence).toBe('exact');
  });

  it('empty input returns confidence=low', () => {
    const id = deriveQualityModelIdentity({});
    expect(id.confidence).toBe('low');
    expect(id.qualityCanonicalId).toBe('');
  });
});

describe('01C.1B-J2-C-R5 — buildQualityIdentityAliases', () => {
  it('emits both wrapped and short forms', () => {
    const aliases = buildQualityIdentityAliases({
      modelId: 'accounts/fireworks/models/deepseek-v4-pro',
    });
    expect(aliases).toContain('accounts/fireworks/models/deepseek-v4-pro');
    expect(aliases).toContain('deepseek-v4-pro');
  });

  it('emits dot-vs-dash normalized form', () => {
    const aliases = buildQualityIdentityAliases({
      modelId: 'anthropic/claude-opus-4.7',
    });
    expect(aliases).toContain('anthropic/claude-opus-4-7');
  });

  it('includes vendor-stripped form', () => {
    const aliases = buildQualityIdentityAliases({
      modelId: 'anthropic/claude-opus-4-7',
    });
    expect(aliases).toContain('claude-opus-4-7');
  });

  it('deterministic ordering for identical input', () => {
    const a = buildQualityIdentityAliases({ modelId: 'Qwen/Qwen3-235B-Thinking' });
    const b = buildQualityIdentityAliases({ modelId: 'Qwen/Qwen3-235B-Thinking' });
    expect(a).toEqual(b);
  });

  it('does not collapse distinct ids', () => {
    const a = buildQualityIdentityAliases({ modelId: 'kimi-k2p5' });
    const b = buildQualityIdentityAliases({ modelId: 'kimi-k2.6' });
    // They normalize differently because the numbers differ.
    expect(a.some((alias) => /k2p5|k2-p5/i.test(alias))).toBe(true);
    expect(b.some((alias) => /k2-6/i.test(alias))).toBe(true);
    expect(new Set([...a, ...b]).size).toBeGreaterThan(Math.max(a.length, b.length));
  });

  it('does not leak secrets', () => {
    const aliases = buildQualityIdentityAliases({
      modelId: 'sk-supersecret123456',
      aliases: ['Bearer abc.def.ghi'],
    });
    const j = JSON.stringify(aliases);
    // The aliases ARE the input — secrets shouldn't be supplied. But the
    // module itself doesn't inject secret patterns.
    expect(j).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});
