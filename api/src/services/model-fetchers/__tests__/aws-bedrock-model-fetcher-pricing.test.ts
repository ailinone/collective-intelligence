// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { AWSBedrockModelFetcher } from '@/services/model-fetchers/aws-bedrock-model-fetcher';

/**
 * Regression tests for the Bedrock pricing estimates.
 *
 * Incident: the flagship heuristic treated any id with a 100B+ parameter
 * count (405b, 120b, ...) as a proprietary flagship and priced it $15/$75 per
 * 1M tokens. Large open-weights models on Bedrock are commodity-priced —
 * openai.gpt-oss-120b-1:0 is $0.15/$0.60 per 1M (https://aws.amazon.com/bedrock/pricing/),
 * so the estimate was inflated 100x/125x in the production catalog.
 */

type Specs = {
  contextWindow: number;
  maxOutputTokens: number;
  pricing: { inputCostPer1M: number; outputCostPer1M: number; currency?: string };
};

function specsFor(modelId: string): Specs {
  const fetcher = new AWSBedrockModelFetcher({ accessKeyId: '', secretAccessKey: '' });
  return fetcher['estimateModelSpecs'](modelId);
}

describe('aws-bedrock-model-fetcher pricing estimates', () => {
  it('does not price large open-weights models as proprietary flagships', () => {
    for (const id of ['openai.gpt-oss-120b-1:0', 'meta.llama3-1-405b-instruct-v1:0']) {
      const { pricing } = specsFor(id);
      expect(pricing.inputCostPer1M, `${id} input`).toBeLessThanOrEqual(3);
      expect(pricing.outputCostPer1M, `${id} output`).toBeLessThanOrEqual(5);
    }
  });

  it('keeps flagship pricing for proprietary flagship keywords', () => {
    const { pricing } = specsFor('anthropic.claude-opus-4-20250514-v1:0');
    expect(pricing.inputCostPer1M).toBe(15.0);
    expect(pricing.outputCostPer1M).toBe(75.0);
  });

  it('keeps the fast tier for small models', () => {
    const { pricing } = specsFor('anthropic.claude-3-haiku-20240307-v1:0');
    expect(pricing.inputCostPer1M).toBe(0.25);
    expect(pricing.outputCostPer1M).toBe(1.25);
  });

  it('never emits input pricing above the most expensive real Bedrock text model for non-flagship ids', () => {
    const nonFlagshipIds = [
      'openai.gpt-oss-120b-1:0',
      'openai.gpt-oss-20b-1:0',
      'meta.llama3-1-405b-instruct-v1:0',
      'meta.llama3-3-70b-instruct-v1:0',
      'deepseek.r1-v1:0',
      'amazon.titan-text-express-v1',
      'mistral.mistral-large-2407-v1:0',
    ];
    for (const id of nonFlagshipIds) {
      const { pricing } = specsFor(id);
      expect(pricing.inputCostPer1M, `${id} input`).toBeLessThanOrEqual(5);
      expect(pricing.outputCostPer1M, `${id} output`).toBeLessThanOrEqual(20);
    }
  });
});
