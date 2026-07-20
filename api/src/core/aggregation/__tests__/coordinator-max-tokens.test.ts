// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the 128k-output fix (2026-07-05): the consensus coordinator historically
 * ran with a hardcoded max_tokens=2000 that IGNORED the client. Now it honors a
 * positive client max_tokens up to the 128k ceiling (131_072), falling back to
 * CONSENSUS_SYNTHESIS_MAX_TOKENS (default 2000) when the client didn't ask.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveCoordinatorMaxTokens } from '../response-aggregator';

afterEach(() => {
  delete process.env.CONSENSUS_SYNTHESIS_MAX_TOKENS;
});

describe('resolveCoordinatorMaxTokens', () => {
  it('honors the client max_tokens (128k passes through)', () => {
    expect(resolveCoordinatorMaxTokens(131_072)).toBe(131_072);
    expect(resolveCoordinatorMaxTokens(4096)).toBe(4096);
  });

  it('caps above the 128k ceiling', () => {
    expect(resolveCoordinatorMaxTokens(500_000)).toBe(131_072);
  });

  it('falls back to 2000 when the client did not set max_tokens', () => {
    expect(resolveCoordinatorMaxTokens(undefined)).toBe(2000);
    expect(resolveCoordinatorMaxTokens(0)).toBe(2000);
    expect(resolveCoordinatorMaxTokens(-5)).toBe(2000);
    expect(resolveCoordinatorMaxTokens(Number('x'))).toBe(2000);
  });

  it('fallback is tunable via CONSENSUS_SYNTHESIS_MAX_TOKENS (still ceiling-capped)', () => {
    process.env.CONSENSUS_SYNTHESIS_MAX_TOKENS = '8000';
    expect(resolveCoordinatorMaxTokens(undefined)).toBe(8000);
    process.env.CONSENSUS_SYNTHESIS_MAX_TOKENS = '999999';
    expect(resolveCoordinatorMaxTokens(undefined)).toBe(131_072);
  });

  it('floors fractional client values', () => {
    expect(resolveCoordinatorMaxTokens(1234.9)).toBe(1234);
  });

  it('derives from the coordinator model capability when the client set nothing (frontier-parity)', () => {
    // No client value → use the coordinator model's own maxOutputTokens instead
    // of the static 2000, so the collective synthesis matches a frontier single.
    expect(resolveCoordinatorMaxTokens(undefined, 65536)).toBe(65536);
    expect(resolveCoordinatorMaxTokens(0, 32000)).toBe(32000);
    // still ceiling-capped
    expect(resolveCoordinatorMaxTokens(undefined, 256000)).toBe(131_072);
  });

  it('client value still wins over the model capability', () => {
    expect(resolveCoordinatorMaxTokens(4096, 256000)).toBe(4096);
  });

  it('falls back to env/2000 only when neither client nor model cap is available', () => {
    expect(resolveCoordinatorMaxTokens(undefined, 0)).toBe(2000);
    expect(resolveCoordinatorMaxTokens(undefined, undefined)).toBe(2000);
  });
});
