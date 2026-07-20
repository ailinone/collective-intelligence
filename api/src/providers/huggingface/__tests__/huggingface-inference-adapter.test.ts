// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HuggingFaceInferenceAdapter — x-use-cache: false header is the contract.
 *
 * HF's router caches identical requests, which destroys latency measurement
 * in benchmark runs. The adapter injects `x-use-cache: false` on every
 * request. That injection MUST survive constructor merging, and MUST be
 * overridable by caller-supplied headers (for the rare operator who genuinely
 * wants caching). Both invariants are pinned below.
 */

import { describe, expect, it } from 'vitest';
import {
  HuggingFaceInferenceAdapter,
  HF_NO_CACHE_HEADER,
} from '../huggingface-inference-adapter';

/**
 * Reach the protected `buildRequestHeaders` method to verify header shape.
 * Casting to a loose interface is the same pattern used by the hub and
 * Xinference test packs.
 */
type ExposedHub = {
  buildRequestHeaders(includeJsonContentType: boolean): Record<string, string>;
};

function makeAdapter(extraMetadata?: { extraHeaders?: Record<string, string> }) {
  return new HuggingFaceInferenceAdapter({
    name: 'huggingface',
    enabled: true,
    providerName: 'huggingface',
    apiKey: 'hf_test_token',
    baseUrl: 'https://router.huggingface.co/v1',
    metadata: extraMetadata,
  });
}

describe('HF_NO_CACHE_HEADER constant', () => {
  it('is exactly { "x-use-cache": "false" }', () => {
    expect(HF_NO_CACHE_HEADER).toEqual({ 'x-use-cache': 'false' });
  });
});

describe('HuggingFaceInferenceAdapter — identity', () => {
  it('providerName is "huggingface"', () => {
    const adapter = makeAdapter();
    expect((adapter as unknown as { providerName: string }).providerName).toBe('huggingface');
    expect(adapter.displayName).toBe('Hugging Face Inference');
  });

  it('honors caller-supplied displayName', () => {
    const adapter = new HuggingFaceInferenceAdapter({
      name: 'huggingface',
      enabled: true,
      providerName: 'huggingface',
      displayName: 'HF Router (prod)',
      apiKey: 'hf_t',
      baseUrl: 'https://router.huggingface.co/v1',
    });
    expect(adapter.displayName).toBe('HF Router (prod)');
  });
});

describe('HuggingFaceInferenceAdapter — no-cache header', () => {
  it('injects x-use-cache: false by default', () => {
    const adapter = makeAdapter();
    const headers = (adapter as unknown as ExposedHub).buildRequestHeaders(true);
    expect(headers['x-use-cache']).toBe('false');
  });

  it('preserves x-use-cache injection across JSON / non-JSON header variants', () => {
    const adapter = makeAdapter();
    const hJson = (adapter as unknown as ExposedHub).buildRequestHeaders(true);
    const hNoJson = (adapter as unknown as ExposedHub).buildRequestHeaders(false);
    expect(hJson['x-use-cache']).toBe('false');
    expect(hNoJson['x-use-cache']).toBe('false');
  });

  it('still emits Authorization: Bearer for the HF_TOKEN', () => {
    const adapter = makeAdapter();
    const headers = (adapter as unknown as ExposedHub).buildRequestHeaders(false);
    expect(headers.Authorization).toBe('Bearer hf_test_token');
  });

  it('lets a caller re-enable caching explicitly via extraHeaders', () => {
    // Operator scenario: a regression-suite benchmark might WANT to hit the
    // cache to measure cold-vs-warm TTFT. The caller's override wins.
    const adapter = makeAdapter({
      extraHeaders: { 'x-use-cache': 'true' },
    });
    const headers = (adapter as unknown as ExposedHub).buildRequestHeaders(false);
    expect(headers['x-use-cache']).toBe('true');
  });

  it('preserves additional caller-supplied headers alongside x-use-cache', () => {
    const adapter = makeAdapter({
      extraHeaders: { 'x-hf-provider': 'together', 'x-trace-id': 'abc-123' },
    });
    const headers = (adapter as unknown as ExposedHub).buildRequestHeaders(false);
    expect(headers['x-hf-provider']).toBe('together');
    expect(headers['x-trace-id']).toBe('abc-123');
    // Default still intact when caller didn't override it.
    expect(headers['x-use-cache']).toBe('false');
  });
});
