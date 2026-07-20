// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-config-provider.test.ts — MVP 7A
 *
 * Verifies the static provider's basic contract: returns the configured
 * mode, defaults conservatively, freezes the config, never mutates.
 */

import { describe, expect, it } from 'vitest';
import {
  createStaticRoutingConfigProvider,
  StaticRoutingConfigProvider,
} from '../static-routing-config-provider';
import type { RoutingMode } from '../runtime-routing-config-types';

describe('StaticRoutingConfigProvider — defaults', () => {
  it('default mode is legacy', () => {
    const p = new StaticRoutingConfigProvider();
    expect(p.getMode()).toBe('legacy');
  });

  it('default enabled = true', () => {
    const p = new StaticRoutingConfigProvider();
    expect(p.getConfig().enabled).toBe(true);
  });

  it('default source = static_stub', () => {
    const p = new StaticRoutingConfigProvider();
    expect(p.getConfig().source).toBe('static_stub');
  });
});

describe('StaticRoutingConfigProvider — configured mode', () => {
  const ALLOWED: readonly RoutingMode[] = [
    'legacy',
    'registry_cache',
    'shadow_trace_only',
    'shadow_registry_only',
    'shadow_structural_full',
  ];

  for (const mode of ALLOWED) {
    it(`returns mode=${mode} when configured`, () => {
      const p = createStaticRoutingConfigProvider({ mode });
      expect(p.getMode()).toBe(mode);
      expect(p.getConfig().enabled).toBe(true);
      expect(p.getConfig().reason).toBeUndefined();
    });
  }
});

describe('StaticRoutingConfigProvider — config immutability', () => {
  it('returned config is frozen', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_trace_only' });
    const cfg = p.getConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('attempting to mutate config does not change the provider state', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'registry_cache' });
    const cfg = p.getConfig();
    try {
      (cfg as { mode: string }).mode = 'shadow_structural_full';
    } catch {
      // strict mode throws — expected.
    }
    expect(p.getMode()).toBe('registry_cache');
  });

  it('getConfig() called repeatedly returns the same reference', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_registry_only' });
    expect(p.getConfig()).toBe(p.getConfig());
  });
});

describe('StaticRoutingConfigProvider — getMode determinism', () => {
  it('getMode() is stable across calls', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_trace_only' });
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(p.getMode());
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe('shadow_trace_only');
  });

  it('isModeAllowed() never mutates state', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'legacy' });
    const before = p.getConfig();
    p.isModeAllowed('shadow_structural_full');
    p.isModeAllowed('semantic_primary');
    const after = p.getConfig();
    expect(after).toBe(before);
  });

  it('explainMode() never mutates state', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'legacy' });
    const before = p.getConfig();
    p.explainMode('shadow_structural_full');
    p.explainMode('shadow_semantic_full');
    const after = p.getConfig();
    expect(after).toBe(before);
  });
});

describe('StaticRoutingConfigProvider — test_fixture source', () => {
  it('supports test_fixture source', () => {
    const p = createStaticRoutingConfigProvider({
      mode: 'shadow_structural_full',
      source: 'test_fixture',
    });
    expect(p.getConfig().source).toBe('test_fixture');
  });
});

describe('StaticRoutingConfigProvider — updatedAt propagation', () => {
  it('passes updatedAt through unchanged', () => {
    const ts = '2026-05-12T13:30:00.000Z';
    const p = createStaticRoutingConfigProvider({
      mode: 'shadow_structural_full',
      updatedAt: ts,
    });
    expect(p.getConfig().updatedAt).toBe(ts);
  });
});
