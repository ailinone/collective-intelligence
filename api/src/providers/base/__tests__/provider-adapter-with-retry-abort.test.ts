// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for withRetry()'s abort-during-backoff check
 * (provider-adapter.ts, inside the for-loop's top-of-iteration guard).
 *
 * The loop re-checks `signal?.aborted` immediately before firing the next
 * attempt, because abort can land while the loop is asleep in the
 * exponential backoff between attempts (routine — the collective per-call
 * timeout commonly lands a retry's backoff sleep across the abort
 * boundary). That check must throw an error whose `.name === 'AbortError'`
 * — not `lastError` (whatever real error the previous attempt failed with,
 * e.g. ECONNRESET/HTTP 500, whose `.name` is never 'AbortError') and not a
 * plain `new Error('Aborted')` (also `.name === 'Error'`).
 *
 * Downstream, base-strategy.ts's wasDeliberatelyCancelled check
 * (`error instanceof Error && error.name === 'AbortError'`, gated further
 * on `signal?.aborted === true`) relies on that exact `.name` to tell a
 * deliberate cancellation apart from a genuine provider failure. Get the
 * name wrong and a cancelled request whose most recent retry attempt
 * happened to fail for a real transient reason gets wrongly recorded as a
 * genuine provider failure by the health-registry / near-zero-skip logic —
 * the false-health-poisoning failure mode this abort-handling effort exists
 * to prevent.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ProviderAdapter,
  type ProviderConfig,
  type HealthCheckResult,
} from '@/providers/base/provider-adapter';
import type { ChatResponse, EmbeddingResponse, Model, Provider } from '@/types';
import type {
  ImageEditResponse,
  ImageVariationResponse,
  ModerationResponse,
} from '@/types/model-client';

/**
 * Minimal concrete adapter so withRetry() (a protected method on the
 * abstract base class) can be exercised directly, without any real
 * provider's HTTP/SDK plumbing — mirrors the FakeAdapter pattern already
 * used in provider-adapter-tpm-budget.test.ts.
 */
class FakeAdapter extends ProviderAdapter {
  private onSleep?: () => void;

  constructor(config: ProviderConfig) {
    super('fake-retry-provider', 'Fake Retry Provider', config);
  }

  async getProvider(): Promise<Provider> {
    throw new Error('not used');
  }
  async getModels(): Promise<Model[]> {
    return [];
  }
  async chatCompletion(): Promise<ChatResponse> {
    throw new Error('not used');
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

  /** Invoked synchronously whenever the retry loop sleeps for backoff. */
  setOnSleep(fn: () => void) {
    this.onSleep = fn;
  }

  /**
   * Deterministically simulate "abort lands during the backoff sleep"
   * without racing real timers: fire the registered hook (which aborts the
   * signal) synchronously, then resolve immediately in place of the real
   * setTimeout-based sleep.
   */
  protected sleep(_ms: number): Promise<void> {
    this.onSleep?.();
    return Promise.resolve();
  }

  public runWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    estimatedTokens: number | undefined,
    signal: AbortSignal | undefined
  ): Promise<T> {
    return (
      this as unknown as {
        withRetry: <U>(
          op: () => Promise<U>,
          name: string,
          tokens?: number,
          sig?: AbortSignal
        ) => Promise<U>;
      }
    ).withRetry(operation, operationName, estimatedTokens, signal);
  }
}

describe('ProviderAdapter.withRetry — abort during backoff', () => {
  it("does not re-issue operation() and throws a genuine AbortError, not the prior attempt's real error", async () => {
    const controller = new AbortController();
    const adapter = new FakeAdapter({ apiKey: 'sk-test', retryDelay: 1, maxRetries: 3 });

    // Abort the moment the loop goes to sleep for backoff after attempt 1's
    // real (non-abort) failure — the exact race the top-of-loop check
    // guards against.
    adapter.setOnSleep(() => controller.abort());

    const operation = vi.fn(async () => {
      throw new Error('ECONNRESET: transient failure');
    });

    let rejected: unknown;
    try {
      await adapter.runWithRetry(operation, 'op', undefined, controller.signal);
    } catch (err) {
      rejected = err;
    }

    // (a) the loop must not fire a second operation() call once the signal
    // is aborted, even though a real (retryable) error is what triggered
    // the backoff sleep in the first place.
    expect(operation).toHaveBeenCalledTimes(1);

    // (b) the thrown error must be a genuine AbortError — not the ECONNRESET
    // Error from attempt 1 rethrown as-is, and not a plain new Error().
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).name).toBe('AbortError');
  });
});
