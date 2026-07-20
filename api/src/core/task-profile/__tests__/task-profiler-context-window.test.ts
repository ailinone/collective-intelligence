// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-context-window.test.ts — MVP 6A
 *
 * contextRequirementTokens + long_context capability.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — contextRequirementTokens', () => {
  it('propagates approximateInputTokens directly', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 2_500,
    });
    expect(profile.contextRequirementTokens).toBe(2_500);
  });

  it('attachments are summed into context tokens', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 500,
      attachments: [
        { kind: 'document', approximateTokens: 3_000 },
        { kind: 'document', approximateTokens: 2_000 },
      ],
    });
    expect(profile.contextRequirementTokens).toBe(500 + 3_000 + 2_000);
  });

  it('text-only input estimates from char length (~4 chars/token)', () => {
    const text = 'a'.repeat(1_000); // 1000 chars ≈ 250 tokens
    const { profile } = profileTask({ requestId: 'r-1', text });
    expect(profile.contextRequirementTokens).toBe(250);
  });

  it('omitted when no tokens detectable', () => {
    const { profile } = profileTask({ requestId: 'r-1' });
    expect(profile.contextRequirementTokens).toBeUndefined();
  });
});

describe('profileTask — long_context capability', () => {
  it('total tokens ≥ longContext threshold → long_context required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 30_000,
    });
    expect(profile.requiredCapabilities).toContain('long_context');
  });

  it('total tokens < threshold → long_context NOT required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 20_000,
    });
    expect(profile.requiredCapabilities).not.toContain('long_context');
  });

  it('attachments push total above threshold → long_context required', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      approximateInputTokens: 10_000,
      attachments: [{ kind: 'document', approximateTokens: 25_000 }],
    });
    expect(profile.requiredCapabilities).toContain('long_context');
  });
});

describe('profileTask — policy override for thresholds', () => {
  it('lowering longContext threshold makes more inputs require long_context', () => {
    const { profile } = profileTask(
      {
        requestId: 'r-1',
        approximateInputTokens: 5_000,
      },
      { tokenThresholds: { low: 500, medium: 4_000, high: 50_000, longContext: 1_000 } },
    );
    expect(profile.requiredCapabilities).toContain('long_context');
  });
});
