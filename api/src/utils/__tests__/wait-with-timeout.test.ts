// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitTimeoutError, waitWithTimeout } from '../wait-with-timeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitWithTimeout', () => {
  it('resolves with the value and leaves no timer behind', async () => {
    await expect(waitWithTimeout(Promise.resolve(42), 1_000, 'x')).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the original rejection', async () => {
    const error = new Error('boom');
    await expect(waitWithTimeout(Promise.reject(error), 1_000, 'x')).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with WaitTimeoutError after the bound while the underlying promise keeps running', async () => {
    let resolveLate!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });

    const waiting = waitWithTimeout(slow, 250, 'Catalog load').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(250);
    const error = await waiting;

    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).message).toBe('Catalog load timed out after 250ms');
    expect((error as WaitTimeoutError).timeoutMs).toBe(250);

    resolveLate('done');
    await expect(slow).resolves.toBe('done');
  });
});
