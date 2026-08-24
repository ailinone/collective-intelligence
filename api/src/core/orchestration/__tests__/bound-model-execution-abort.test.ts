// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for a confirmed production bug (2026-08-14): the per-model
 * timeout in BaseStrategy.boundModelExecution() races the orchestration
 * layer's `await` against a setTimeout fallback, but never cancels the
 * underlying HTTP request. Two back-to-back requests landed on the same
 * self-hosted host; the first took 24s, the second got zero response within
 * a 60s client timeout because the un-aborted first call was still holding
 * server-side capacity.
 *
 * This test proves REAL cancellation — a local server that would hang
 * forever must actually observe the connection close once the per-model
 * timeout fires. Asserting only that boundModelExecution() resolves quickly
 * would not catch the bug (that part already "works" today via Promise.race).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BaseStrategy, type StrategyMetadata } from '@/core/orchestration/base-strategy';
import { ProviderAdapter, type ProviderConfig } from '@/providers/base/provider-adapter';
import { getProviderHealthRegistry } from '@/core/operability';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingResponse,
  Model,
  ModelExecution,
  ModelRole,
  OrchestrationContext,
  OrchestrationResult,
  Provider,
} from '@/types';
import type {
  ImageEditResponse,
  ImageVariationResponse,
  ModerationResponse,
} from '@/types/model-client';
import type { HealthCheckResult } from '@/providers/base/provider-adapter';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm-hang',
    providerId: 'self-hosted-test',
    provider: 'self-hosted-test',
    name: 'hang-model',
    displayName: 'Hang Model',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat'],
    performance: { latencyMs: 500, throughput: 50, quality: 0.8, reliability: 0.95 },
    status: 'active',
    ...overrides,
  };
}

function makeRequest(): ChatRequest {
  return {
    model: 'm-hang',
    messages: [{ role: 'user', content: 'ping' }],
  } as ChatRequest;
}

/**
 * Adapter whose chatCompletion issues a REAL fetch() to a caller-supplied
 * base URL. No mocking of fetch/network — this is the only way to prove the
 * underlying TCP connection actually closes, not just that a promise settles.
 */
class RealFetchHangingAdapter extends ProviderAdapter {
  constructor(private readonly baseUrl: string) {
    super('self-hosted-test', 'Self-Hosted Test', { apiKey: 'unused' } as ProviderConfig);
  }
  async getProvider(): Promise<Provider> {
    throw new Error('not used');
  }
  async getModels(): Promise<Model[]> {
    return [];
  }
  async chatCompletion(_request: ChatRequest, options?: { signal?: AbortSignal }): Promise<ChatResponse> {
    // A well-behaved adapter forwards the signal straight to fetch(). This is
    // what proves the orchestration layer (boundModelExecution -> executeModel)
    // actually delivers a working AbortSignal all the way to the adapter
    // boundary — not just that *this test's* adapter happens to cancel itself.
    await fetch(this.baseUrl, { signal: options?.signal });
    throw new Error('unreachable: server never responds');
  }
  async *chatCompletionStream(): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('not used');
  }
  async generateEmbeddings(): Promise<EmbeddingResponse> {
    throw new Error('not used');
  }
  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, checkedAt: new Date() };
  }
  calculateCost(): number {
    return 0;
  }
  normalizeModelName(modelName: string): string {
    return modelName;
  }
  async imageEdit(): Promise<ImageEditResponse> {
    throw new Error('not used');
  }
  async imageVariation(): Promise<ImageVariationResponse> {
    throw new Error('not used');
  }
  async moderate(): Promise<ModerationResponse> {
    throw new Error('not used');
  }
}

class TestStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'test-strategy',
      name: 'single',
      displayName: 'Test',
      description: 'test-only strategy for boundModelExecution',
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 1,
      estimatedQualityBoost: 0,
      estimatedDurationMultiplier: 1,
      suitableFor: [],
    };
  }
  async execute(): Promise<OrchestrationResult> {
    throw new Error('not used');
  }

  public callBoundModelExecution(
    adapter: ProviderAdapter,
    model: Model,
    request: ChatRequest,
    role: ModelRole,
    timeoutMs: number
  ): Promise<ModelExecution> {
    return this.boundModelExecution(
      (signal) => this.executeModel(adapter, model, request, role, signal),
      { adapter, model, request, role },
      timeoutMs
    );
  }
}

describe('boundModelExecution — real cancellation on timeout', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      // Force-close any still-open sockets so a failing (un-fixed) test run
      // doesn't leak a hung connection into the next test file.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it(
    'closes the real underlying connection once the per-model timeout fires',
    async () => {
      let serverSawRequest = false;
      let serverSawClose = false;
      let closedAtMs = 0;
      const requestStart = Date.now();

      server = http.createServer((req, res) => {
        serverSawRequest = true;
        // Never call res.end() — this response hangs forever unless the
        // client actually aborts the underlying connection.
        req.on('close', () => {
          serverSawClose = true;
          closedAtMs = Date.now() - requestStart;
        });
        void res; // keep response open
      });

      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/`;

      const strategy = new TestStrategy();
      const adapter = new RealFetchHangingAdapter(baseUrl);
      const model = makeModel();
      const request = makeRequest();

      // Generous timeout: base-strategy's dynamic `await import('@/core/operability')`
      // (near-zero-skip, health registry) plus OpenTelemetry span setup are
      // cold on first invocation in this test process and can take a while
      // to transform/load — irrelevant overhead we don't want to race
      // against. What matters is what happens to the real connection AFTER
      // the timeout fires, not how tight the timeout is.
      const timeoutMs = 3000;
      const execution = await strategy.callBoundModelExecution(
        adapter,
        model,
        request,
        'primary',
        timeoutMs
      );

      // boundModelExecution resolving promptly (via Promise.race) is NOT proof
      // of the fix by itself — that part works even when nothing is actually
      // cancelled. This is just a sanity check that the call was attempted.
      expect(execution.success).toBe(false);
      expect(serverSawRequest).toBe(true);

      // The real proof: within a bounded grace period after the timeout
      // fires, the server must observe the connection actually close —
      // i.e. the timeout branch genuinely aborted the in-flight request
      // instead of merely giving up on waiting for it.
      const graceMs = 2500;
      const deadline = Date.now() + graceMs;
      while (!serverSawClose && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(serverSawClose).toBe(true);
      expect(closedAtMs).toBeLessThan(timeoutMs + graceMs);

      // A self-inflicted cancellation (our own soft-deadline, not a real
      // provider failure) must not poison this provider's health / near-zero
      // -skip tracking — see base-strategy's `wasDeliberatelyCancelled` gate.
      const healthRecord = getProviderHealthRegistry().lookup({
        providerId: 'self-hosted-test',
        modelId: model.id,
      });
      expect(healthRecord).toBeUndefined();
    },
    15000
  );
});
