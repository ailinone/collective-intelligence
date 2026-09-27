// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi } from 'vitest';
import { buildMediaCritics, QUALITY_JUDGING_UNAVAILABLE_REASON } from '../media-critics-factory';
import { MEDIA_CRITIC_ROLES } from '../evaluation/media-judge-evaluator.types';
import type { ProviderRegistry } from '@/providers/provider-registry';

function fakeRegistry(): ProviderRegistry {
  return {} as ProviderRegistry;
}

describe('buildMediaCritics', () => {
  it('returns 3 critics (one per MediaCriticRole) when a judge model resolves', async () => {
    const resolveMediaJudgeModelId = vi.fn().mockResolvedValue('vision-judge-model');
    const result = await buildMediaCritics({
      providerRegistry: fakeRegistry(),
      resolveMediaJudgeModelId,
    });

    expect(result.critics).toHaveLength(3);
    expect(result.critics.map((c) => c.role).sort()).toEqual([...MEDIA_CRITIC_ROLES].sort());
    expect(result.qualityJudgingUnavailableReason).toBeUndefined();
    for (const critic of result.critics) {
      expect(critic.evaluator.mode).toBe('llm_judge');
    }
  });

  it('returns empty critics + a labeled reason when no vision-capable judge model resolves', async () => {
    const resolveMediaJudgeModelId = vi.fn().mockResolvedValue(undefined);
    const result = await buildMediaCritics({
      providerRegistry: fakeRegistry(),
      resolveMediaJudgeModelId,
    });

    expect(result.critics).toEqual([]);
    expect(result.qualityJudgingUnavailableReason).toBe(QUALITY_JUDGING_UNAVAILABLE_REASON);
  });

  it('degrades gracefully (does not throw) when resolveMediaJudgeModelId rejects', async () => {
    const resolveMediaJudgeModelId = vi.fn().mockRejectedValue(new Error('catalog unavailable'));

    const result = await buildMediaCritics({
      providerRegistry: fakeRegistry(),
      resolveMediaJudgeModelId,
    });

    expect(result.critics).toEqual([]);
    expect(result.qualityJudgingUnavailableReason).toContain(QUALITY_JUDGING_UNAVAILABLE_REASON);
    expect(result.qualityJudgingUnavailableReason).toContain('catalog unavailable');
  });
});
