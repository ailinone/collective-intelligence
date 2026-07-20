// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for the TPM/RPM budget mechanism on the base
 * ProviderAdapter (scale-to-100k Phase 2 follow-up, issue #152) —
 * getTpmConfig()/consumeTpmBudget(), and its wiring into
 * executeThroughBulkhead's optional estimatedTokens parameter.
 *
 * tokenBucketManager is mocked (not a real/fake Redis) since its own Lua
 * script logic is already covered by token-bucket-limiter's own usage
 * elsewhere in the codebase (the rate-limit middleware) — this suite only
 * verifies ProviderAdapter's calling convention: does it consume before
 * acquiring a bulkhead lease, does it skip the check when no token
 * estimate is given, and does a rejection surface as a clear error without
 * ever calling the wrapped operation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderAdapter, type ProviderConfig } from '@/providers/base/provider-adapter';
import type { ChatRequest, ChatResponse, EmbeddingResponse, Model, Provider } from '@/types';
import type {
  ImageEditResponse,
  ImageVariationResponse,
  ModerationResponse,
} from '@/types/model-client';
import type { HealthCheckResult } from '@/providers/base/provider-adapter';

const { consumeMock, getBucketMock } = vi.hoisted(() => {
  const consumeMock = vi.fn<[number], Promise<boolean>>();
  const getBucketMock = vi.fn(() => ({ consume: consumeMock }));
  return { consumeMock, getBucketMock };
});

vi.mock('@/core/resilience/token-bucket-limiter', () => ({
  tokenBucketManager: { getBucket: getBucketMock },
}));

const { tokenBucketManager } = await import('@/core/resilience/token-bucket-limiter');

class FakeAdapter extends ProviderAdapter {
  constructor(config: ProviderConfig) {
    super('fake-tpm-provider', 'Fake TPM Provider', config);
  }
  async getProvider(): Promise<Provider> { throw new Error('not used'); }
  async getModels(): Promise<Model[]> { return []; }
  async chatCompletion(): Promise<ChatResponse> { throw new Error('not used'); }
  async *chatCompletionStream(): AsyncGenerator<ChatResponse, void, unknown> { throw new Error('not used'); }
  async generateEmbeddings(): Promise<EmbeddingResponse> { throw new Error('not used'); }
  async healthCheck(): Promise<HealthCheckResult> { return { healthy: true, checkedAt: new Date() }; }
  calculateCost(): number { return 0; }
  normalizeModelName(modelName: string): string { return modelName; }
  async imageEdit(): Promise<ImageEditResponse> { throw new Error('not used'); }
  async imageVariation(): Promise<ImageVariationResponse> { throw new Error('not used'); }
  async moderate(): Promise<ModerationResponse> { throw new Error('not used'); }

  public runThroughBulkhead<T>(op: () => Promise<T>, name: string, estimatedTokens?: number): Promise<T> {
    return (this as unknown as {
      executeThroughBulkhead: <U>(o: () => Promise<U>, n: string, t?: number) => Promise<U>;
    }).executeThroughBulkhead(op, name, estimatedTokens);
  }

  public exposeGetTpmConfig() {
    return (this as unknown as { getTpmConfig: () => { capacity: number; refillRatePerSecond: number } }).getTpmConfig();
  }
}

describe('ProviderAdapter TPM budget', () => {
  beforeEach(() => {
    consumeMock.mockReset();
    getBucketMock.mockClear();
    delete process.env.PROVIDER_TPM_LIMITS;
  });

  it('skips the TPM check entirely when no estimatedTokens is given (backward compatible)', async () => {
    const adapter = new FakeAdapter({ apiKey: 'sk-test' });
    const result = await adapter.runThroughBulkhead(async () => 'ok', 'op');
    expect(result).toBe('ok');
    expect(getBucketMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('consumes the estimated token cost from the provider TPM bucket before running the operation', async () => {
    consumeMock.mockResolvedValue(true);
    const adapter = new FakeAdapter({ apiKey: 'sk-test' });
    const result = await adapter.runThroughBulkhead(async () => 'ok', 'op', 500);

    expect(result).toBe('ok');
    expect(getBucketMock).toHaveBeenCalledWith(
      'provider-tpm',
      'fake-tpm-provider',
      expect.objectContaining({ capacity: expect.any(Number), refillRate: expect.any(Number) })
    );
    expect(consumeMock).toHaveBeenCalledWith(500);
  });

  it('rejects with a clear error and never runs the operation when the TPM budget is exhausted', async () => {
    consumeMock.mockResolvedValue(false);
    const adapter = new FakeAdapter({ apiKey: 'sk-test' });
    const operation = vi.fn(async () => 'should not run');

    await expect(adapter.runThroughBulkhead(operation, 'op', 1000)).rejects.toThrow(/TPM budget exhausted/);
    expect(operation).not.toHaveBeenCalled();
  });

  it('getTpmConfig returns a sane default for an unrecognized provider', () => {
    const adapter = new FakeAdapter({ apiKey: 'sk-test' });
    const config = adapter.exposeGetTpmConfig();
    expect(config.capacity).toBeGreaterThan(0);
    expect(config.refillRatePerSecond).toBeGreaterThan(0);
  });

  it('getTpmConfig honors a PROVIDER_TPM_LIMITS override, merged over the default', () => {
    process.env.PROVIDER_TPM_LIMITS = JSON.stringify({ 'fake-tpm-provider': { capacity: 999 } });
    const adapter = new FakeAdapter({ apiKey: 'sk-test' });
    const config = adapter.exposeGetTpmConfig();
    expect(config.capacity).toBe(999);
    expect(config.refillRatePerSecond).toBeGreaterThan(0); // untouched field preserved from the default
  });

  it('module mock sanity: tokenBucketManager.getBucket is the mocked function', () => {
    expect(tokenBucketManager.getBucket).toBe(getBucketMock);
  });
});
