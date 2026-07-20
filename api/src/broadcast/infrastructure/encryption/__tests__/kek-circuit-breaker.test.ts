// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * KEK circuit breaker — state-machine tests.
 *
 * The breaker has three transitions we care about:
 *   closed → open           (after N consecutive failures)
 *   open   → half_open      (after cooldown elapses, on next call)
 *   half_open → closed      (after probeSuccessThreshold probes succeed)
 *   half_open → open        (probe fails → re-open with exponential backoff)
 *
 * The wrap() passthrough is NOT gated — failures on wrap (create-destination
 * time) should surface to the operator, not be masked. We assert that here.
 *
 * All timing uses an injectable `now()` so tests are deterministic.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  CircuitBreakerKekProvider,
  KekUnwrapBreakerOpenError,
} from '../kek-circuit-breaker';
import type { KekProvider } from '../kek-provider';

/**
 * Test double that tracks call counts and can be toggled to fail.
 */
class FlakyKek implements KekProvider {
  readonly resource = 'test://kek';
  unwrapCalls = 0;
  wrapCalls = 0;
  shouldFail = false;

  async wrap(dek: Buffer): Promise<Buffer> {
    this.wrapCalls += 1;
    if (this.shouldFail) throw new Error('simulated KMS outage (wrap)');
    return Buffer.concat([Buffer.from([0xff]), dek]);
  }

  async unwrap(wrappedDek: Buffer): Promise<Buffer> {
    this.unwrapCalls += 1;
    if (this.shouldFail) throw new Error('simulated KMS outage (unwrap)');
    return wrappedDek.subarray(1);
  }
}

/**
 * Controllable clock — advances only when the test calls `tick()`.
 */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    tick(ms: number) {
      t += ms;
    },
  };
}

const DEK = Buffer.alloc(32, 0x42);

describe('CircuitBreakerKekProvider', () => {
  describe('wrap() passthrough (not gated)', () => {
    it('forwards wrap results unchanged', async () => {
      const inner = new FlakyKek();
      const breaker = new CircuitBreakerKekProvider(inner);
      const wrapped = await breaker.wrap(DEK);
      expect(wrapped.length).toBe(33);
      expect(inner.wrapCalls).toBe(1);
    });

    it('does NOT open the breaker on wrap failures', async () => {
      const inner = new FlakyKek();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 2,
      });
      inner.shouldFail = true;
      // 5 wrap failures
      for (let i = 0; i < 5; i++) {
        await expect(breaker.wrap(DEK)).rejects.toThrow(/simulated/);
      }
      expect(breaker.getState()).toBe('closed');
    });

    it('exposes the inner resource', () => {
      const inner = new FlakyKek();
      const breaker = new CircuitBreakerKekProvider(inner);
      expect(breaker.resource).toBe('test://kek');
    });
  });

  describe('unwrap() failure counting', () => {
    it('remains closed below the failure threshold', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 5,
        now: clock.now,
      });
      inner.shouldFail = true;
      for (let i = 0; i < 4; i++) {
        await expect(breaker.unwrap(DEK)).rejects.toThrow(/simulated/);
      }
      expect(breaker.getState()).toBe('closed');
      expect(inner.unwrapCalls).toBe(4);
    });

    it('opens after N consecutive failures and fast-fails subsequent calls', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 3,
        baseCooldownMs: 10_000,
        now: clock.now,
      });
      inner.shouldFail = true;
      // 3 real failures trip the breaker.
      for (let i = 0; i < 3; i++) {
        await expect(breaker.unwrap(DEK)).rejects.toThrow(/simulated/);
      }
      expect(breaker.getState()).toBe('open');
      expect(inner.unwrapCalls).toBe(3);

      // Next call must NOT reach the inner — breaker fast-fails.
      await expect(breaker.unwrap(DEK)).rejects.toBeInstanceOf(
        KekUnwrapBreakerOpenError,
      );
      expect(inner.unwrapCalls).toBe(3);
    });

    it('prunes failures outside the rolling window', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 3,
        rollingWindowMs: 10_000,
        now: clock.now,
      });
      inner.shouldFail = true;
      // Two failures, then let them age out.
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      clock.tick(11_000); // window expired
      // Next failure should NOT trip — the earlier two are pruned.
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      expect(breaker.getState()).toBe('closed');
    });

    it('a success in closed state clears pending failures', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 3,
        now: clock.now,
      });
      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      inner.shouldFail = false;
      await expect(breaker.unwrap(DEK)).resolves.toBeInstanceOf(Buffer);
      // Failure window is cleared; 2 new failures shouldn't trip.
      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('half-open probe', () => {
    it('transitions open → half_open after cooldown and probes the inner', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 2,
        baseCooldownMs: 5_000,
        now: clock.now,
      });
      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      expect(breaker.getState()).toBe('open');

      // During cooldown, fast-fail (inner NOT called).
      const callsBefore = inner.unwrapCalls;
      await expect(breaker.unwrap(DEK)).rejects.toBeInstanceOf(
        KekUnwrapBreakerOpenError,
      );
      expect(inner.unwrapCalls).toBe(callsBefore);

      // Cooldown elapses → next call goes half_open and probes.
      clock.tick(5_001);
      inner.shouldFail = false;
      await expect(breaker.unwrap(DEK)).resolves.toBeInstanceOf(Buffer);
      // Still half_open — one successful probe isn't enough by default (threshold=2).
      expect(breaker.getState()).toBe('half_open');
    });

    it('closes after probeSuccessThreshold successes in half_open', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 1,
        baseCooldownMs: 1_000,
        probeSuccessThreshold: 2,
        now: clock.now,
      });

      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      expect(breaker.getState()).toBe('open');

      clock.tick(1_001);
      inner.shouldFail = false;
      await expect(breaker.unwrap(DEK)).resolves.toBeInstanceOf(Buffer); // probe 1
      expect(breaker.getState()).toBe('half_open');
      await expect(breaker.unwrap(DEK)).resolves.toBeInstanceOf(Buffer); // probe 2 → close
      expect(breaker.getState()).toBe('closed');
    });

    it('re-opens with exponential backoff when a probe fails', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 1,
        baseCooldownMs: 1_000,
        maxCooldownMs: 8_000,
        now: clock.now,
      });

      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      expect(breaker.getState()).toBe('open');

      // Cooldown = 1000 * 2^0 = 1000
      clock.tick(1_001);
      await expect(breaker.unwrap(DEK)).rejects.toThrow(/simulated/); // probe fails
      expect(breaker.getState()).toBe('open');

      // Now cooldown = 1000 * 2^1 = 2000. Before that, fast-fail.
      clock.tick(1_500);
      await expect(breaker.unwrap(DEK)).rejects.toBeInstanceOf(
        KekUnwrapBreakerOpenError,
      );
      // After 2000ms total, probe again.
      clock.tick(600); // total 2100 since last open
      await expect(breaker.unwrap(DEK)).rejects.toThrow(/simulated/); // probe fails again
      expect(breaker.getState()).toBe('open');

      // Cooldown doubled to 4000. Verify max clamp by failing a few more times.
      for (let i = 0; i < 5; i++) {
        clock.tick(20_000);
        await expect(breaker.unwrap(DEK)).rejects.toThrow(/simulated/);
      }
      expect(breaker.getState()).toBe('open');
    });

    it('resets backoff to 1x after a successful close', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 1,
        baseCooldownMs: 1_000,
        probeSuccessThreshold: 1,
        now: clock.now,
      });

      // First open → probe fail → re-open (backoff level 1: 2000ms).
      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      clock.tick(1_001);
      await expect(breaker.unwrap(DEK)).rejects.toThrow(); // probe fails → backoff++
      // Now backoff=2000. Elapse 2000ms, probe OK, close.
      clock.tick(2_001);
      inner.shouldFail = false;
      await expect(breaker.unwrap(DEK)).resolves.toBeInstanceOf(Buffer);
      expect(breaker.getState()).toBe('closed');

      // Open again — cooldown should be baseCooldownMs (1000), NOT 2000.
      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      // Just under 1000 → still open fast-fails.
      clock.tick(900);
      await expect(breaker.unwrap(DEK)).rejects.toBeInstanceOf(
        KekUnwrapBreakerOpenError,
      );
      // Just over 1000 → half_open probe.
      clock.tick(200);
      inner.shouldFail = false;
      await expect(breaker.unwrap(DEK)).resolves.toBeInstanceOf(Buffer);
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('KekUnwrapBreakerOpenError', () => {
    it('carries retryAfterMs for callers to log / surface', async () => {
      const inner = new FlakyKek();
      const clock = makeClock();
      const breaker = new CircuitBreakerKekProvider(inner, {
        failureThreshold: 1,
        baseCooldownMs: 7_500,
        now: clock.now,
      });
      inner.shouldFail = true;
      await expect(breaker.unwrap(DEK)).rejects.toThrow();
      // Immediately after open — retryAfterMs ≈ 7500.
      const caught = await breaker.unwrap(DEK).catch((e) => e);
      expect(caught).toBeInstanceOf(KekUnwrapBreakerOpenError);
      expect(caught.retryAfterMs).toBeGreaterThan(0);
      expect(caught.retryAfterMs).toBeLessThanOrEqual(7_500);
    });
  });
});
