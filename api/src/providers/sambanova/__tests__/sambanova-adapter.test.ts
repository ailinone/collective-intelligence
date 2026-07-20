// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SambanovaAdapter — fast-tier hint tests.
 *
 * The adapter is a thin hub extension whose only value today is:
 *   - labeling observability with `providerName: 'sambanova'`,
 *   - exposing the documented fast-tier model list and an `isFastTier()` guard.
 *
 * These tests lock down the fast-tier classification contract so the
 * capability merger can rely on it.
 */

import { describe, expect, it } from 'vitest';
import { SambanovaAdapter } from '../sambanova-adapter';

describe('SambanovaAdapter — fast-tier classification', () => {
  it('flags the documented fast-tier models', () => {
    expect(SambanovaAdapter.isFastTier('Meta-Llama-3.1-8B-Instruct')).toBe(true);
    expect(SambanovaAdapter.isFastTier('Meta-Llama-3.2-1B-Instruct')).toBe(true);
    expect(SambanovaAdapter.isFastTier('Meta-Llama-3.2-3B-Instruct')).toBe(true);
  });

  it('does not flag larger (non-fast-tier) models', () => {
    expect(SambanovaAdapter.isFastTier('Meta-Llama-3.1-70B-Instruct')).toBe(false);
    expect(SambanovaAdapter.isFastTier('Meta-Llama-3.1-405B-Instruct')).toBe(false);
    expect(SambanovaAdapter.isFastTier('DeepSeek-V3')).toBe(false);
  });

  it('is case-sensitive (matches docs — "Meta-Llama-3.1-8B-Instruct" is canonical)', () => {
    expect(SambanovaAdapter.isFastTier('meta-llama-3.1-8b-instruct')).toBe(false);
  });

  it('exposes FAST_TIER_MODELS as a readonly list', () => {
    expect(Array.isArray(SambanovaAdapter.FAST_TIER_MODELS)).toBe(true);
    expect(SambanovaAdapter.FAST_TIER_MODELS.length).toBeGreaterThan(0);
  });

  it('is constructible without throwing', () => {
    const adapter = new SambanovaAdapter({
      name: 'sambanova',
      enabled: true,
      apiKey: 'snova-test',
      baseUrl: 'https://api.sambanova.ai/v1',
      providerName: 'sambanova',
    });
    expect(adapter).toBeInstanceOf(SambanovaAdapter);
  });
});
