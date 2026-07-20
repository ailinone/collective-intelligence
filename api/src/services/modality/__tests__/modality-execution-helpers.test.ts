// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import {
  normalizeStrategy,
  resolveFallbackDeadlineMs,
  diversifyProviders,
} from '@/services/modality/modality-execution-helpers';

describe('normalizeStrategy', () => {
  it('passes through canonical values', () => {
    for (const s of ['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'dynamic'] as const) {
      expect(normalizeStrategy(s)).toBe(s);
    }
  });
  it('maps aliases and trims/lowercases', () => {
    expect(normalizeStrategy('  QUALITY ')).toBe('quality');
    expect(normalizeStrategy('quality-multipass')).toBe('quality_multipass');
    expect(normalizeStrategy('quality-multi-pass')).toBe('quality_multipass');
    expect(normalizeStrategy('auto')).toBe('dynamic');
  });
  it('defaults to dynamic for empty/unknown', () => {
    expect(normalizeStrategy(undefined)).toBe('dynamic');
    expect(normalizeStrategy('')).toBe('dynamic');
    expect(normalizeStrategy('nonsense')).toBe('dynamic');
  });
});

describe('resolveFallbackDeadlineMs', () => {
  it('returns 0 (no search) when fallback disabled regardless of strategy', () => {
    expect(resolveFallbackDeadlineMs('parallel', false)).toBe(0);
    expect(resolveFallbackDeadlineMs('single', false)).toBe(0);
  });
  it('maps strategy → wall-clock search budget (ms) when fallback allowed — NOT a candidate count, see doc comment (2026-07-15)', () => {
    expect(resolveFallbackDeadlineMs('single', true)).toBe(4000);
    expect(resolveFallbackDeadlineMs('cost', true)).toBe(10000);
    expect(resolveFallbackDeadlineMs('speed', true)).toBe(10000);
    expect(resolveFallbackDeadlineMs('parallel', true)).toBe(20000);
    expect(resolveFallbackDeadlineMs('debate', true)).toBe(20000);
    expect(resolveFallbackDeadlineMs('quality_multipass', true)).toBe(20000);
    expect(resolveFallbackDeadlineMs('quality', true)).toBe(30000);
    expect(resolveFallbackDeadlineMs('balanced', true)).toBe(30000);
    expect(resolveFallbackDeadlineMs('dynamic', true)).toBe(30000);
  });
});

describe('diversifyProviders', () => {
  it('leads with the first occurrence of each provider, preserving order', () => {
    const models = [
      { id: 'a', provider: 'openai' },
      { id: 'b', provider: 'openai' },
      { id: 'c', provider: 'anthropic' },
      { id: 'd', provider: 'google' },
      { id: 'e', provider: 'anthropic' },
    ];
    expect(diversifyProviders(models).map((m) => m.id)).toEqual(['a', 'c', 'd', 'b', 'e']);
  });
  it('is case-insensitive on provider and handles empty', () => {
    expect(diversifyProviders([{ id: 'x', provider: 'OpenAI' }, { id: 'y', provider: 'openai' }]).map((m) => m.id)).toEqual(['x', 'y']);
    expect(diversifyProviders([])).toEqual([]);
  });
});
