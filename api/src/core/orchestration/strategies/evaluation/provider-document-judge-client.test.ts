// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderDocumentJudgeClient — contract tests.
 *
 * Pure / mocked. NEVER touches a real provider — same fake-registry pattern
 * as provider-media-judge-client.test.ts. The property this file most needs
 * to prove: `issues` is extracted tolerantly (malformed entries dropped,
 * never fabricated) on top of the same score/verdict salvage
 * `coerceRawResult` already provides.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProviderDocumentJudgeClient, coerceDocumentRawResult } from './provider-document-judge-client';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatResponse, Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

function fakeChatResponse(content: string): ChatResponse {
  return {
    id: 'document-judge-1',
    object: 'chat.completion',
    created: 0,
    model: 'doc-judge-model',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  };
}

function fakeRegistry(adapter: Partial<ProviderAdapter>): ProviderRegistry {
  const model: Model = {
    id: 'doc-judge-model',
    providerId: 'mockprov',
    provider: 'mockprov',
    name: 'doc-judge-model',
    displayName: 'document judge',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat'],
    performance: { latencyMs: 1, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
  };
  return {
    findModel: async () => ({ model, adapter: adapter as ProviderAdapter }),
  } as unknown as ProviderRegistry;
}

describe('coerceDocumentRawResult', () => {
  it('extracts a well-formed issues array alongside score/verdict', () => {
    const result = coerceDocumentRawResult(
      JSON.stringify({
        score: 0.3,
        verdict: 'fail',
        rationale: 'missing clause',
        issues: [{ location: 4, severity: 'major', description: 'no governing law clause' }],
      })
    );
    expect(result.score).toBe(0.3);
    expect(result.issues).toEqual([{ location: 4, severity: 'major', description: 'no governing law clause' }]);
  });

  it('drops a malformed issue (no location) instead of fabricating one', () => {
    const result = coerceDocumentRawResult(
      JSON.stringify({ score: 0.5, verdict: 'uncertain', issues: [{ severity: 'minor', description: 'x' }] })
    );
    expect(result.issues).toEqual([]);
  });

  it('defaults an unrecognised severity to "minor"', () => {
    const result = coerceDocumentRawResult(
      JSON.stringify({ score: 0.5, verdict: 'pass', issues: [{ location: 1, severity: 'huge', description: 'x' }] })
    );
    expect(result.issues).toEqual([{ location: 1, severity: 'minor', description: 'x' }]);
  });

  it('returns an empty issues array (not a throw) when issues is missing entirely', () => {
    const result = coerceDocumentRawResult(JSON.stringify({ score: 0.9, verdict: 'pass' }));
    expect(result.issues).toEqual([]);
  });
});

describe('ProviderDocumentJudgeClient', () => {
  it('sends plain text content (no image parts) and attaches billable cost', async () => {
    const chatCompletion = vi.fn().mockResolvedValue({
      ...fakeChatResponse(
        JSON.stringify({
          score: 0.2,
          verdict: 'fail',
          issues: [{ location: 2, severity: 'critical', description: 'total does not sum' }],
        })
      ),
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    });
    const calculateCost = vi.fn().mockReturnValue(0.004);
    const client = new ProviderDocumentJudgeClient({ registry: fakeRegistry({ chatCompletion, calculateCost }) });

    const result = await client.judgeDocument({
      judgeModelId: 'doc-judge-model',
      rubricVersion: 'document-critic-v1',
      criticRole: 'factual_accuracy',
      task: {},
      documentText: '[page 1]\nRevenue was $10M.\n\n[page 2]\nThe total above was $12M.',
      maxCostUsd: 0.05,
      timeoutMs: 5000,
    });

    expect(result.issues).toEqual([{ location: 2, severity: 'critical', description: 'total does not sum' }]);
    expect(result.costUsd).toBe(0.004);
    const sentRequest = chatCompletion.mock.calls[0][0];
    expect(JSON.stringify(sentRequest)).not.toContain('image_url');
    expect(sentRequest.messages[1].content).toContain('[page 1]');
  });

  it('throws when the judge model does not resolve', async () => {
    const registry = { findModel: async () => undefined } as unknown as ProviderRegistry;
    const client = new ProviderDocumentJudgeClient({ registry });
    await expect(
      client.judgeDocument({
        judgeModelId: 'missing-model',
        rubricVersion: 'v1',
        criticRole: 'tone',
        task: {},
        documentText: 'text',
        maxCostUsd: 0.05,
        timeoutMs: 5000,
      })
    ).rejects.toThrow('document_judge_model_not_found:missing-model');
  });
});
