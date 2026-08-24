// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { applyFreeTierCeiling } from '../chat-routes';
import type { ChatRequest } from '@/types';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatRequest;
}

describe('applyFreeTierCeiling', () => {
  it('defaults max_cost to the ceiling when the client sent none', () => {
    const r = request();
    applyFreeTierCeiling(r);
    expect(r.max_cost).toBe(0.003);
    expect(r.ailin_free_tier_scope).toBe(true);
  });

  it('keeps a client-supplied max_cost that is already below the ceiling', () => {
    const r = request({ max_cost: 0.001 });
    applyFreeTierCeiling(r);
    expect(r.max_cost).toBe(0.001);
  });

  it('clamps a client-supplied max_cost that exceeds the ceiling — the bypass this closes', () => {
    const r = request({ max_cost: 5 });
    applyFreeTierCeiling(r);
    expect(r.max_cost).toBe(0.003);
  });

  it('leaves an allowlisted explicit strategy untouched', () => {
    for (const strategy of ['single', 'cost-cascade'] as const) {
      const r = request({ strategy });
      applyFreeTierCeiling(r);
      expect(r.strategy).toBe(strategy);
    }
  });

  it('downgrades a non-allowlisted explicit strategy to cost-cascade — the bypass this closes', () => {
    for (const strategy of ['consensus', 'debate', 'quality-multipass'] as const) {
      const r = request({ strategy });
      applyFreeTierCeiling(r);
      expect(r.strategy).toBe('cost-cascade');
    }
  });

  it('leaves an unset strategy unset (triage still decides)', () => {
    const r = request();
    applyFreeTierCeiling(r);
    expect(r.strategy).toBeUndefined();
  });

  it('always sets ailin_free_tier_scope, regardless of the other fields', () => {
    const r = request({ max_cost: 0.0001, strategy: 'single' });
    applyFreeTierCeiling(r);
    expect(r.ailin_free_tier_scope).toBe(true);
  });
});
