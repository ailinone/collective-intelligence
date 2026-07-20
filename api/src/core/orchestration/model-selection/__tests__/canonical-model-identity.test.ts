// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4B §7 — canonical-model-identity tests.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeModelId,
  deriveCanonicalModelIdentity,
} from '@/core/orchestration/model-selection/canonical-model-identity';

describe('01C.1B-J1D-R4B §7 — normalizeModelId', () => {
  it('lowercases + preserves vendor/model shape', () => {
    expect(normalizeModelId('Qwen/Qwen3-235B-A22B-Thinking-2507')).toBe(
      'qwen/qwen3-235b-a22b-thinking-2507',
    );
  });

  it('strips deepinfra wrapper but keeps vendor/model', () => {
    expect(normalizeModelId('deepinfra/openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b');
  });

  it('strips huggingface wrapper', () => {
    expect(normalizeModelId('huggingface/Qwen/Qwen3-235B-A22B-Thinking-2507')).toBe(
      'qwen/qwen3-235b-a22b-thinking-2507',
    );
  });

  it('strips hf: colon prefix', () => {
    expect(normalizeModelId('hf:Qwen/Qwen3-235B-A22B-Thinking-2507')).toBe(
      'qwen/qwen3-235b-a22b-thinking-2507',
    );
  });

  it('strips routeway wrapper', () => {
    expect(normalizeModelId('routeway/openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b');
  });

  it('strips edenai + nested deepinfra (two wrappers)', () => {
    expect(normalizeModelId('edenai/deepinfra/openai/gpt-oss-120b')).toBe(
      'openai/gpt-oss-120b',
    );
  });

  it('does NOT strip when leading segment is a real vendor', () => {
    expect(normalizeModelId('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b');
  });

  it('does NOT strip when leading segment is anthropic', () => {
    expect(normalizeModelId('anthropic/claude-opus-4.7')).toBe('anthropic/claude-opus-4.7');
  });

  it('returns empty for empty input', () => {
    expect(normalizeModelId('')).toBe('');
  });

  it('trims whitespace', () => {
    expect(normalizeModelId('  Qwen/Qwen3-235B  ')).toBe('qwen/qwen3-235b');
  });
});

describe('01C.1B-J1D-R4B §7 — deriveCanonicalModelIdentity', () => {
  it('canonical for deepinfra::Qwen3 is same as huggingface::Qwen3', () => {
    const di = deriveCanonicalModelIdentity({
      apiModelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      providerId: 'deepinfra',
    });
    const hf = deriveCanonicalModelIdentity({
      apiModelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      providerId: 'huggingface',
    });
    expect(di.canonicalModelId).toBe(hf.canonicalModelId);
    expect(di.canonicalModelId).toBe('qwen/qwen3-235b-a22b-thinking-2507');
  });

  it('canonical for hf:Qwen3 matches deepinfra::Qwen3', () => {
    const a = deriveCanonicalModelIdentity({ apiModelId: 'hf:Qwen/Qwen3-235B-A22B-Thinking-2507' });
    const b = deriveCanonicalModelIdentity({
      apiModelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      providerId: 'deepinfra',
    });
    expect(a.canonicalModelId).toBe(b.canonicalModelId);
  });

  it('deepinfra/openai/gpt-oss-120b and openai/gpt-oss-120b are the same canonical', () => {
    const wrapped = deriveCanonicalModelIdentity({
      apiModelId: 'deepinfra/openai/gpt-oss-120b',
    });
    const direct = deriveCanonicalModelIdentity({
      apiModelId: 'openai/gpt-oss-120b',
    });
    expect(wrapped.canonicalModelId).toBe(direct.canonicalModelId);
    expect(direct.canonicalModelId).toBe('openai/gpt-oss-120b');
  });

  it('does NOT collapse gpt-oss-120b with gpt-oss-20b', () => {
    const big = deriveCanonicalModelIdentity({ apiModelId: 'openai/gpt-oss-120b' });
    const small = deriveCanonicalModelIdentity({ apiModelId: 'openai/gpt-oss-20b' });
    expect(big.canonicalModelId).not.toBe(small.canonicalModelId);
  });

  it('does NOT collapse Qwen3-235B with Qwen3-32B', () => {
    const big = deriveCanonicalModelIdentity({ apiModelId: 'Qwen/Qwen3-235B' });
    const small = deriveCanonicalModelIdentity({ apiModelId: 'Qwen/Qwen3-32B' });
    expect(big.canonicalModelId).not.toBe(small.canonicalModelId);
  });

  it('infers vendor + family for known vendors', () => {
    const qwen = deriveCanonicalModelIdentity({ apiModelId: 'Qwen/Qwen3-235B-Thinking' });
    expect(qwen.vendor).toBe('qwen');
    expect(qwen.family).toBe('qwen');

    const gptOss = deriveCanonicalModelIdentity({ apiModelId: 'openai/gpt-oss-120b' });
    expect(gptOss.vendor).toBe('openai');
    expect(gptOss.family).toBe('gpt-oss');

    const claude = deriveCanonicalModelIdentity({ apiModelId: 'anthropic/claude-opus-4.7' });
    expect(claude.vendor).toBe('anthropic');
    expect(claude.family).toBe('claude');

    const gemini = deriveCanonicalModelIdentity({ apiModelId: 'gemini-2.5-pro' });
    expect(gemini.vendor).toBe('google');
    expect(gemini.family).toBe('gemini');

    const grok = deriveCanonicalModelIdentity({ apiModelId: 'grok-4' });
    expect(grok.vendor).toBe('xai');
    expect(grok.family).toBe('grok');
  });

  it('handles vendor-only fallback for unknown vendors', () => {
    const r = deriveCanonicalModelIdentity({ apiModelId: 'newvendor/some-model' });
    expect(r.vendor).toBe('newvendor');
    expect(r.family).toBeUndefined();
  });

  it('preserves sourceModelId in the result', () => {
    const r = deriveCanonicalModelIdentity({ apiModelId: 'deepinfra/openai/gpt-oss-120b' });
    expect(r.sourceModelId).toBe('deepinfra/openai/gpt-oss-120b');
    expect(r.canonicalModelId).toBe('openai/gpt-oss-120b');
  });

  it('is deterministic — same input → same output', () => {
    const a = deriveCanonicalModelIdentity({
      apiModelId: 'Qwen/Qwen3-235B-Thinking',
      providerId: 'deepinfra',
    });
    const b = deriveCanonicalModelIdentity({
      apiModelId: 'Qwen/Qwen3-235B-Thinking',
      providerId: 'deepinfra',
    });
    expect(a).toEqual(b);
  });

  it('empty input returns empty identity (no throw)', () => {
    const r = deriveCanonicalModelIdentity({});
    expect(r.canonicalModelId).toBe('');
    expect(r.normalizedModelId).toBe('');
    expect(r.sourceModelId).toBe('');
  });

  it('serialized identity does not contain secret patterns', () => {
    const r = deriveCanonicalModelIdentity({ apiModelId: 'openai/gpt-oss-120b' });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('apiModelId preferred over modelId when both present', () => {
    const r = deriveCanonicalModelIdentity({
      modelId: 'something-else',
      apiModelId: 'Qwen/Qwen3-235B',
    });
    expect(r.canonicalModelId).toBe('qwen/qwen3-235b');
  });
});
