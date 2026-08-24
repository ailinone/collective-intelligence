// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ChatResponse } from '@/types';

// brandingConfig is a module-level singleton read at call time by
// applyBranding — mock it so this test doesn't depend on real env config.
vi.mock('@/config', () => ({
  brandingConfig: {
    hideModels: true,
    brandName: 'Ailin¹',
    minimalMetadata: false,
    logDetailedMetadata: false,
  },
}));

import { applyBranding } from '../branding';

function rawProviderResponse(): ChatResponse & { system_fingerprint: string } {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'Qwen/Qwen3-32B',
    // Not in the ChatResponse type -- passed through from the raw upstream
    // provider JSON, exactly as observed live in production.
    system_fingerprint: 'vllm-0.21.0-5e58c442',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop', logprobs: null },
    ],
  } as ChatResponse & { system_fingerprint: string };
}

describe('applyBranding — provider identity leak (P1-3)', () => {
  it('strips system_fingerprint when hideModels is on, even though the type never declared it', () => {
    const branded = applyBranding(rawProviderResponse()) as Record<string, unknown>;
    expect(branded.system_fingerprint).toBeUndefined();
    expect('system_fingerprint' in branded).toBe(false);
  });

  it('still replaces model with the brand name', () => {
    const branded = applyBranding(rawProviderResponse());
    expect(branded.model).toBe('Ailin¹');
  });

  it('does not mutate the original response object', () => {
    const original = rawProviderResponse();
    applyBranding(original);
    expect(original.system_fingerprint).toBe('vllm-0.21.0-5e58c442');
    expect(original.model).toBe('Qwen/Qwen3-32B');
  });
});
