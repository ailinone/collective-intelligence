// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-capability-validator — `verified` flag regression test.
 *
 * LOTE AM (2026-09-05) wiring audit finding: `ModelCapabilityValidator`
 * always returned `validationStatus: 'valid', confidence: 0.9` whenever
 * `TEST_USE_REAL_API_KEYS` was not `'true'` — which is EVERY production
 * request, since that flag is a test-suite-only switch and is never set in
 * prod. The declared-but-never-tested skip path was therefore
 * indistinguishable from an actual provider round-trip that confirmed the
 * capabilities, for 100% of real traffic.
 *
 * The fix does NOT change `validationStatus` (selection code branches on
 * `validationStatus !== 'valid'` to decide whether to persist a correction —
 * flipping that for the skip path would fire a DB write + warn log for every
 * one of the ~25 validated candidates on every single selection call, the
 * exact log-flood/write-storm the skip path exists to avoid). Instead it
 * adds an honest `verified: boolean` + resets the skip path's `confidence`
 * from a misleading `0.9` to `0`, so any caller/dashboard can tell "we asked
 * the provider" apart from "we trusted the catalog".
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ModelCapabilityValidator } from '@/services/model-capability-validator';
import type { Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

function stubModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'stub/model-1',
    providerId: 'stub',
    provider: 'stub',
    name: 'model-1',
    displayName: 'Stub Model 1',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat', 'streaming'],
    performance: {} as Model['performance'],
    status: 'active',
    ...overrides,
  };
}

function stubAdapter(): ProviderAdapter {
  return {
    chatCompletion: vi.fn(),
    chatCompletionStream: vi.fn(),
  } as unknown as ProviderAdapter;
}

describe('ModelCapabilityValidator — verified flag (LOTE AM wiring fix)', () => {
  const originalFlag = process.env.TEST_USE_REAL_API_KEYS;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.TEST_USE_REAL_API_KEYS;
    } else {
      process.env.TEST_USE_REAL_API_KEYS = originalFlag;
    }
  });

  it('marks the skip path (no TEST_USE_REAL_API_KEYS) as verified:false with confidence 0, NOT a fabricated pass', async () => {
    delete process.env.TEST_USE_REAL_API_KEYS;

    const validator = new ModelCapabilityValidator();
    const model = stubModel();
    const adapter = stubAdapter();

    const result = await validator.validateCapabilities(model, adapter);

    // Behavior-preserving: still reports 'valid' so selection code's
    // `validationStatus !== 'valid'` branch is not triggered for every
    // candidate on every request (no log flood, no spurious DB writes).
    expect(result.validationStatus).toBe('valid');
    expect(result.capabilities).toEqual(model.capabilities);

    // The actual fix: this result must be legible as "never tested".
    expect(result.verified).toBe(false);
    expect(result.confidence).toBe(0);

    // The skip path must never call the provider — that's the entire point
    // of skipping (avoid 401/500 floods against mock keys).
    expect(adapter.chatCompletion).not.toHaveBeenCalled();
  });

  it('marks a real provider round-trip (TEST_USE_REAL_API_KEYS=true) as verified:true', async () => {
    process.env.TEST_USE_REAL_API_KEYS = 'true';

    const validator = new ModelCapabilityValidator();
    const model = stubModel({ capabilities: ['chat'] });
    const adapter = stubAdapter();
    (adapter.chatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      choices: [{ message: { content: 'test' } }],
    });

    const result = await validator.validateCapabilities(model, adapter);

    expect(result.verified).toBe(true);
    expect(adapter.chatCompletion).toHaveBeenCalled();
  });

  it('getValidationStats() separates verified from unverified results', async () => {
    process.env.TEST_USE_REAL_API_KEYS = undefined as unknown as string;
    delete process.env.TEST_USE_REAL_API_KEYS;

    const validator = new ModelCapabilityValidator();
    await validator.validateCapabilities(stubModel({ id: 'stub/a' }), stubAdapter());
    await validator.validateCapabilities(stubModel({ id: 'stub/b' }), stubAdapter());

    const stats = validator.getValidationStats();

    expect(stats.totalModelsValidated).toBe(2);
    expect(stats.unverifiedModels).toBe(2);
    expect(stats.verifiedModels).toBe(0);
  });
});
