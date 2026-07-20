// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VllmAdapter — thin wrapper over the OAI-compat hub.
 *
 * The adapter itself does almost nothing — the test pack exists to prove:
 *   1. It instantiates without throwing when apiKey is empty (apiKeyOptional)
 *   2. The providerName is 'vllm' (for metrics / logs)
 *   3. The displayName can be overridden from config
 */

import { describe, expect, it } from 'vitest';
import { VllmAdapter } from '../vllm-adapter';

describe('VllmAdapter', () => {
  it('instantiates with empty apiKey (apiKeyOptional: true)', () => {
    expect(
      () =>
        new VllmAdapter({
          name: 'vllm',
          enabled: true,
          providerName: 'vllm',
          apiKey: '',
          baseUrl: 'http://localhost:8000/v1',
        }),
    ).not.toThrow();
  });

  it('default displayName = "vLLM"', () => {
    const adapter = new VllmAdapter({
      name: 'vllm',
      enabled: true,
      providerName: 'vllm',
      apiKey: '',
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(adapter.displayName).toBe('vLLM');
  });

  it('respects displayName override', () => {
    const adapter = new VllmAdapter({
      name: 'vllm',
      enabled: true,
      providerName: 'vllm',
      displayName: 'vLLM (staging)',
      apiKey: '',
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(adapter.displayName).toBe('vLLM (staging)');
  });

  it('provider id is "vllm"', () => {
    const adapter = new VllmAdapter({
      name: 'vllm',
      enabled: true,
      providerName: 'vllm',
      apiKey: '',
      baseUrl: 'http://localhost:8000/v1',
    });
    expect((adapter as unknown as { providerName: string }).providerName).toBe('vllm');
  });
});
