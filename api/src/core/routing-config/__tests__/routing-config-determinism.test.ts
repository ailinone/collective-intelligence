// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-config-determinism.test.ts — MVP 7A
 *
 * The provider is purely in-memory and must be deterministic across
 * thousands of invocations. No Date.now, no Math.random.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createStaticRoutingConfigProvider } from '../runtime-routing-config-provider';
import type { RoutingMode } from '../runtime-routing-config-types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routing-config — determinism', () => {
  it('1000 iterations of getConfig() return the same reference', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_structural_full' });
    const ref = p.getConfig();
    for (let i = 0; i < 1000; i += 1) {
      expect(p.getConfig()).toBe(ref);
    }
  });

  it('1000 iterations of getMode() return the same value', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_trace_only' });
    for (let i = 0; i < 1000; i += 1) {
      expect(p.getMode()).toBe('shadow_trace_only');
    }
  });

  it('does not depend on Date.now', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_registry_only' });
    p.getConfig();
    p.getMode();
    p.isModeAllowed('shadow_structural_full');
    p.explainMode('semantic_primary');
    expect(dateSpy).not.toHaveBeenCalled();
  });

  it('does not depend on Math.random', () => {
    const randSpy = vi.spyOn(Math, 'random');
    const p = createStaticRoutingConfigProvider({ mode: 'registry_cache' });
    p.getConfig();
    p.getMode();
    p.isModeAllowed('legacy');
    p.explainMode('shadow_structural_full');
    expect(randSpy).not.toHaveBeenCalled();
  });

  it('two providers built with the same options produce equal configs', () => {
    const opts = { mode: 'shadow_structural_full' as RoutingMode };
    const a = createStaticRoutingConfigProvider(opts);
    const b = createStaticRoutingConfigProvider(opts);
    expect(a.getConfig().mode).toBe(b.getConfig().mode);
    expect(a.getConfig().enabled).toBe(b.getConfig().enabled);
    expect(a.getConfig().source).toBe(b.getConfig().source);
  });

  it('explainMode is stable across many calls', () => {
    const p = createStaticRoutingConfigProvider();
    const first = p.explainMode('shadow_structural_full');
    for (let i = 0; i < 500; i += 1) {
      const r = p.explainMode('shadow_structural_full');
      expect(r.allowed).toBe(first.allowed);
      expect(r.reason).toBe(first.reason);
    }
  });
});
