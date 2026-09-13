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
 * Bedrock reports no token economics — and we no longer invent any.
 *
 * ## History
 *
 * This file used to bound an `estimateModelSpecs()` keyword table that mapped
 * substrings of the model id to a context window and a per-1M price. It existed
 * because that table had already caused a production incident: any id carrying
 * a 100B+ parameter count was treated as a proprietary flagship and priced at
 * $15/$75 per 1M, inflating commodity open-weights models (gpt-oss-120b is
 * $0.15/$0.60) by 100-125x in the live catalog.
 *
 * Bounding the estimate was the wrong fix, because the premise was wrong:
 * `ListFoundationModels` returns modelId / modelName / providerName /
 * modalities / inferenceTypesSupported and NO pricing and NO context window.
 * There was never anything to estimate FROM. A number written into
 * `models.input_cost_per_1k` is indistinguishable downstream from a real one,
 * and the cost and selection layers read that column.
 *
 * LOTE AN (2026-09-05, GAP-AK-6) deleted the table. These tests now pin the
 * stronger property — Bedrock discovery emits "unknown", not a guess — which
 * subsumes every bound the old suite checked.
 */

type BedrockSummary = {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
};

function convert(summary: BedrockSummary) {
  const fetcher = new AWSBedrockModelFetcher({ accessKeyId: '', secretAccessKey: '' });
  return (
    fetcher as unknown as {
      convertBedrockModel: (m: BedrockSummary) => {
        contextWindow: number;
        maxOutputTokens: number;
        pricing: { inputCostPer1M: number; outputCostPer1M: number };
        capabilities: string[];
        metadata: Record<string, unknown>;
        displayName?: string;
        id: string;
      };
    }
  ).convertBedrockModel(summary);
}

describe('aws-bedrock-model-fetcher — no fabricated specs', () => {
  it('emits zero pricing for every model, flagship keywords included', () => {
    const ids = [
      'anthropic.claude-opus-4-20250514-v1:0', // used to hit the $15/$75 flagship branch
      'anthropic.claude-3-haiku-20240307-v1:0', // used to hit the $0.25/$1.25 fast branch
      'openai.gpt-oss-120b-1:0', // the model the 2026 incident mispriced
      'meta.llama3-1-405b-instruct-v1:0',
      'amazon.titan-text-express-v1',
      'deepseek.r1-v1:0',
    ];
    for (const modelId of ids) {
      const model = convert({ modelId });
      expect(model.pricing.inputCostPer1M, `${modelId} input`).toBe(0);
      expect(model.pricing.outputCostPer1M, `${modelId} output`).toBe(0);
    }
  });

  it('emits zero context window / max output rather than a keyword-derived guess', () => {
    const model = convert({ modelId: 'anthropic.claude-opus-4-20250514-v1:0' });
    expect(model.contextWindow).toBe(0);
    expect(model.maxOutputTokens).toBe(0);
  });

  it('no longer exposes the estimator at all', () => {
    const fetcher = new AWSBedrockModelFetcher({ accessKeyId: '', secretAccessKey: '' });
    expect(
      (fetcher as unknown as Record<string, unknown>).estimateModelSpecs,
      'estimateModelSpecs was removed — reintroducing it reintroduces fabricated pricing'
    ).toBeUndefined();
  });
});

describe('aws-bedrock-model-fetcher — capabilities from declared modalities', () => {
  it('uses the API-reported modalities instead of guessing from the model id', () => {
    // ListFoundationModels really returns these arrays; they were previously
    // stashed in metadata and ignored while capabilities came from substring
    // matches on the id.
    const model = convert({
      modelId: 'vendor.opaque-sku-v1:0', // no 'claude'/'vision'/'image' substring to key off
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
    });

    expect(model.capabilities).toContain('vision');
    expect(model.capabilities).toContain('multimodal');
    expect(model.capabilities).toContain('chat');
  });

  it('does not claim vision for a text-only model whose id merely looks modern', () => {
    // The old id heuristic gave vision to anything matching /claude/ + /\d+\.\d+/.
    const model = convert({
      modelId: 'anthropic.claude-3.5-text-only-v1:0',
      inputModalities: ['TEXT'],
      outputModalities: ['TEXT'],
    });

    expect(model.capabilities).not.toContain('vision');
  });

  it('marks an embedding-only model from its declared modalities', () => {
    const model = convert({
      modelId: 'amazon.titan-embed-text-v2:0',
      inputModalities: ['TEXT'],
      outputModalities: ['EMBEDDING'],
    });

    expect(model.capabilities).not.toContain('chat');
  });

  it('falls back to id-based extraction only when no modalities are reported', () => {
    const model = convert({ modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0' });
    expect(model.capabilities).toContain('chat');
  });

  it('keeps the raw declared modalities in metadata for audit', () => {
    const model = convert({
      modelId: 'x.y-v1:0',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
    });
    expect(model.metadata.inputModalities).toEqual(['TEXT', 'IMAGE']);
    expect(model.metadata.outputModalities).toEqual(['TEXT']);
  });
});
