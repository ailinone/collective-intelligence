// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@/types';

// Same mocking contract as branding-strips-provider-identity.test.ts:
// brandingConfig is a module-level singleton read at call time.
vi.mock('@/config', () => ({
  brandingConfig: {
    hideModels: true,
    brandName: 'Ailin¹',
    minimalMetadata: false,
    logDetailedMetadata: false,
  },
}));

import { applyBranding } from '../branding';

function executedResponse(model: string, metadata?: Record<string, unknown>): ChatResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop', logprobs: null },
    ],
    ...(metadata ? { ailin_metadata: metadata } : {}),
  } as ChatResponse;
}

describe('applyBranding — explicit user selection keeps its real model name', () => {
  it('skips branding entirely when the executed model IS the pinned model', () => {
    const response = executedResponse('openai/gpt-4o');
    const out = applyBranding(response, { explicitModel: 'openai/gpt-4o' });
    expect(out.model).toBe('openai/gpt-4o');
    expect(out).not.toBe(response);
    expect(response.model).toBe('openai/gpt-4o');
  });

  it('matches the provider-stripped form of the pinned id', () => {
    const response = executedResponse('gpt-4o');
    const out = applyBranding(response, { explicitModel: 'openai/gpt-4o' });
    expect(out.model).toBe('gpt-4o');
  });

  it('matches via metadata.resolved_model when the envelope echoes a different field', () => {
    const response = executedResponse('ailin-resolved', {
      strategy_used: 'single',
      resolved_model: '@cf/meta/llama-3.1-8b-instruct-fp8',
      final_decider_model_id: '@cf/meta/llama-3.1-8b-instruct-fp8',
    });
    const out = applyBranding(response, {
      explicitModel: '@cf/meta/llama-3.1-8b-instruct-fp8',
    });
    expect(out.model).toBe('ailin-resolved');
  });

  it('keeps branding when the pin FAILED OVER to another model', () => {
    const response = executedResponse('deepseek/deepseek-v4', {
      strategy_used: 'single',
      models_used: ['openai/gpt-4o', 'deepseek/deepseek-v4'],
      resolved_model: 'deepseek/deepseek-v4',
      fallback_chain: ['openai/gpt-4o', 'deepseek/deepseek-v4'],
    });
    const out = applyBranding(response, { explicitModel: 'openai/gpt-4o' });
    expect(out.model).toBe('Ailin¹');
  });

  it('keeps branding for strategy requests — a composite id never equals an executed model', () => {
    const response = executedResponse('anthropic/claude-sonnet-4', {
      strategy_used: 'best',
      models_used: ['anthropic/claude-sonnet-4'],
      resolved_model: 'anthropic/claude-sonnet-4',
    });
    const out = applyBranding(response, { explicitModel: 'best:large' });
    expect(out.model).toBe('Ailin¹');
  });

  it('keeps branding when no explicitModel is given (all existing callers unchanged)', () => {
    const response = executedResponse('openai/gpt-4o');
    const out = applyBranding(response);
    expect(out.model).toBe('Ailin¹');
  });

  it('still strips system_fingerprint on the preserve path (P1-3 passthrough hole)', () => {
    const response = executedResponse('openai/gpt-4o') as ChatResponse & {
      system_fingerprint?: string;
    };
    response.system_fingerprint = 'vllm-0.21.0-5e58c442';
    const out = applyBranding(response, { explicitModel: 'openai/gpt-4o' }) as typeof response;
    expect(out.model).toBe('openai/gpt-4o');
    expect(out.system_fingerprint).toBeUndefined();
  });

  it('keeps branding on whitespace/empty explicitModel', () => {
    const response = executedResponse('openai/gpt-4o');
    expect(applyBranding(response, { explicitModel: '   ' }).model).toBe('Ailin¹');
  });
});
