// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-determinism.test.ts — MVP 8C.0
 *
 * Sampling, hashing and redaction are pure → must produce identical
 * output across many invocations.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashIdentifier, redactPayload } from '../shadow-routing-redaction';
import { shouldSample } from '../shadow-routing-sampling';

afterEach(() => vi.restoreAllMocks());

describe('shadow routing — determinism', () => {
  it('hashIdentifier is deterministic across 1000 calls', () => {
    const a = hashIdentifier('my-model-id-12345');
    for (let i = 0; i < 1000; i += 1) {
      expect(hashIdentifier('my-model-id-12345')).toBe(a);
    }
  });

  it('shouldSample is deterministic for same (requestId, rate)', () => {
    const a = shouldSample('r-deterministic', 0.4);
    for (let i = 0; i < 1000; i += 1) {
      expect(shouldSample('r-deterministic', 0.4)).toBe(a);
    }
  });

  it('redactPayload produces identical JSON over 100 runs', () => {
    const payload = {
      requestId: 'r-1',
      modelHash: hashIdentifier('claude-opus-4'),
      latencyMs: 12,
    };
    const a = JSON.stringify(redactPayload(payload));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(redactPayload(payload))).toBe(a);
    }
  });

  it('hashIdentifier does NOT call Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    hashIdentifier('my-id-12345');
    expect(spy).not.toHaveBeenCalled();
  });

  it('shouldSample does NOT call Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    shouldSample('r-1', 0.5);
    expect(spy).not.toHaveBeenCalled();
  });

  it('hashIdentifier does NOT call Date.now', () => {
    const spy = vi.spyOn(Date, 'now');
    hashIdentifier('my-id-12345');
    expect(spy).not.toHaveBeenCalled();
  });
});
