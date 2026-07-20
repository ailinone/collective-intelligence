// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import { computeModalityCost, toModalityCostFields } from '@/services/modality-cost';
import type { Model } from '@/types';

// Minimal model factory — only the fields computeModalityCost / normalizeCost read.
function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test/model-x',
    provider: 'cloudprovider',
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    ...overrides,
  } as Model;
}

describe('computeModalityCost (COST #6 — modality cost integrity)', () => {
  it('trusts an adapter-reported positive cost (provider_reported)', () => {
    const record = computeModalityCost({
      response: { cost: 0.042 },
      model: model(),
      provider: 'cloudprovider',
    });
    expect(record.costSource).toBe('provider_reported');
    expect(record.normalizedCostUsd).toBe(0.042);
    expect(record.rawCostUsd).toBe(0.042);
    expect(record.costConfidence).toBe('high');
  });

  it('flags MISSING when neither cost nor tokens are available (per-unit image/audio/video case)', () => {
    // image/audio/video responses carry no cost and no token usage
    const record = computeModalityCost({
      response: { data: [{ url: 'https://x/y.png' }] },
      model: model(),
      provider: 'cloudprovider',
    });
    expect(record.costSource).toBe('missing');
    expect(record.normalizedCostUsd).toBeNull();
    expect(record.costConfidence).toBe('none');
  });

  it('also flags MISSING for an empty/undefined response (never throws)', () => {
    expect(computeModalityCost({ response: undefined, model: model(), provider: 'p' }).costSource).toBe('missing');
    expect(computeModalityCost({ response: null, model: model(), provider: 'p' }).costSource).toBe('missing');
    expect(computeModalityCost({ response: {}, model: model(), provider: 'p' }).costSource).toBe('missing');
  });

  it('estimates from DB pricing when cost is 0 but tokens are present (text modalities)', () => {
    const record = computeModalityCost({
      response: { cost: 0, usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      model: model({ inputCostPer1k: 0.001, outputCostPer1k: 0.002 }),
      provider: 'cloudprovider',
    });
    expect(record.costSource).toBe('estimated_from_pricing_table');
    // (1000/1000)*0.001 + (500/1000)*0.002 = 0.001 + 0.001 = 0.002
    expect(record.normalizedCostUsd).toBeCloseTo(0.002, 6);
  });

  it('ignores non-finite cost/usage values defensively', () => {
    const record = computeModalityCost({
      response: { cost: 'free', usage: { prompt_tokens: 'lots' } },
      model: model(),
      provider: 'cloudprovider',
    });
    expect(record.costSource).toBe('missing');
    expect(record.normalizedCostUsd).toBeNull();
  });

  it('toModalityCostFields projects the public envelope fields', () => {
    const record = computeModalityCost({ response: { cost: 0.01 }, model: model(), provider: 'p' });
    const fields = toModalityCostFields(record);
    expect(fields).toEqual({
      cost: 0.01,
      rawCost: 0.01,
      costSource: 'provider_reported',
      costConfidence: 'high',
    });
  });
});
