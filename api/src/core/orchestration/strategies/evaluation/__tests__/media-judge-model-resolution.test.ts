// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi } from 'vitest';
import { resolveMediaJudgeModelId } from '../media-judge-model-resolution';
import type { Model } from '@/types';

function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? `provider-${overrides.id}`,
    provider: overrides.provider ?? `provider-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    contextWindow: overrides.contextWindow ?? 64000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1k: overrides.inputCostPer1k ?? 0.001,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.002,
    capabilities: overrides.capabilities ?? ['chat', 'text_generation'],
    performance: overrides.performance ?? {
      latencyMs: 1000,
      throughput: 100,
      quality: 0.9,
      reliability: 0.95,
    },
    status: overrides.status ?? 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    metadata: overrides.metadata,
  };
}

describe('resolveMediaJudgeModelId', () => {
  it('returns the id of a vision-capable, active chat model from the catalog', async () => {
    const listCatalogModels = vi.fn().mockResolvedValue([
      makeModel({ id: 'text-only-judge', capabilities: ['chat', 'text_generation'] }),
      makeModel({
        id: 'vision-judge',
        capabilities: ['chat', 'text_generation', 'vision'],
      }),
    ]);

    const modelId = await resolveMediaJudgeModelId({ listCatalogModels });
    expect(modelId).toBe('vision-judge');
  });

  it('returns undefined when no vision-capable chat model exists in the catalog', async () => {
    const listCatalogModels = vi.fn().mockResolvedValue([
      makeModel({ id: 'text-only-judge', capabilities: ['chat', 'text_generation'] }),
    ]);

    const modelId = await resolveMediaJudgeModelId({ listCatalogModels });
    expect(modelId).toBeUndefined();
  });

  it('returns undefined when the catalog is empty', async () => {
    const listCatalogModels = vi.fn().mockResolvedValue([]);
    const modelId = await resolveMediaJudgeModelId({ listCatalogModels });
    expect(modelId).toBeUndefined();
  });
});
