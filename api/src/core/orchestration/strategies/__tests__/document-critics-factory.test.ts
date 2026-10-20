// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi } from 'vitest';
import { buildDocumentCritics, DOCUMENT_JUDGING_UNAVAILABLE_REASON } from '../document-critics-factory';
import { DOCUMENT_CRITIC_ROLES } from '../evaluation/document-judge-evaluator.types';
import type { ProviderRegistry } from '@/providers/provider-registry';

function fakeRegistry(): ProviderRegistry {
  return {} as ProviderRegistry;
}

describe('buildDocumentCritics', () => {
  it('returns 3 critics (one per DocumentCriticRole) when a judge model resolves', async () => {
    const resolveDocumentJudgeModelId = vi.fn().mockResolvedValue('text-judge-model');
    const result = await buildDocumentCritics({
      providerRegistry: fakeRegistry(),
      resolveDocumentJudgeModelId,
    });

    expect(result.critics).toHaveLength(3);
    expect(result.critics.map((c) => c.role).sort()).toEqual([...DOCUMENT_CRITIC_ROLES].sort());
    expect(result.documentJudgingUnavailableReason).toBeUndefined();
    for (const critic of result.critics) {
      expect(critic.evaluator.mode).toBe('llm_judge');
    }
  });

  it('returns empty critics + a labeled reason when no text-capable judge model resolves', async () => {
    const resolveDocumentJudgeModelId = vi.fn().mockResolvedValue(undefined);
    const result = await buildDocumentCritics({
      providerRegistry: fakeRegistry(),
      resolveDocumentJudgeModelId,
    });

    expect(result.critics).toEqual([]);
    expect(result.documentJudgingUnavailableReason).toBe(DOCUMENT_JUDGING_UNAVAILABLE_REASON);
  });

  it('degrades gracefully (does not throw) when resolveDocumentJudgeModelId rejects', async () => {
    const resolveDocumentJudgeModelId = vi.fn().mockRejectedValue(new Error('catalog unavailable'));

    const result = await buildDocumentCritics({
      providerRegistry: fakeRegistry(),
      resolveDocumentJudgeModelId,
    });

    expect(result.critics).toEqual([]);
    expect(result.documentJudgingUnavailableReason).toContain(DOCUMENT_JUDGING_UNAVAILABLE_REASON);
    expect(result.documentJudgingUnavailableReason).toContain('catalog unavailable');
  });
});
