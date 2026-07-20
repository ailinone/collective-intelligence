// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-config-blocked-modes.test.ts — MVP 7A
 *
 * Asserts the BLOCKED-mode invariants:
 *   - shadow_semantic_full is blocked
 *   - semantic_primary is blocked
 *   - reason = blocked_until_c3_completed_and_semantic_index_available
 *   - allowed modes pass
 *   - ALLOWED / BLOCKED sets are mutually exclusive
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MODES,
  ALLOWED_REASON,
  BLOCKED_MODES,
  BLOCKED_REASON,
  createStaticRoutingConfigProvider,
} from '../runtime-routing-config-provider';
import type { RoutingMode } from '../runtime-routing-config-types';

describe('routing-config — blocked modes', () => {
  it('shadow_semantic_full is BLOCKED', () => {
    const p = createStaticRoutingConfigProvider();
    expect(p.isModeAllowed('shadow_semantic_full')).toBe(false);
  });

  it('semantic_primary is BLOCKED', () => {
    const p = createStaticRoutingConfigProvider();
    expect(p.isModeAllowed('semantic_primary')).toBe(false);
  });

  it('blocked reason for shadow_semantic_full matches contract', () => {
    const p = createStaticRoutingConfigProvider();
    expect(p.explainMode('shadow_semantic_full')).toEqual({
      allowed: false,
      reason: BLOCKED_REASON,
    });
  });

  it('blocked reason for semantic_primary matches contract', () => {
    const p = createStaticRoutingConfigProvider();
    expect(p.explainMode('semantic_primary')).toEqual({
      allowed: false,
      reason: BLOCKED_REASON,
    });
  });

  it('BLOCKED_REASON literal equals expected sentinel', () => {
    expect(BLOCKED_REASON).toBe(
      'blocked_until_c3_completed_and_semantic_index_available',
    );
  });
});

describe('routing-config — allowed modes pass', () => {
  const ALLOWED: readonly RoutingMode[] = [
    'legacy',
    'registry_cache',
    'shadow_trace_only',
    'shadow_registry_only',
    'shadow_structural_full',
  ];

  for (const mode of ALLOWED) {
    it(`${mode} is ALLOWED`, () => {
      const p = createStaticRoutingConfigProvider();
      expect(p.isModeAllowed(mode)).toBe(true);
      expect(p.explainMode(mode)).toEqual({
        allowed: true,
        reason: ALLOWED_REASON,
      });
    });
  }
});

describe('routing-config — when configured mode is BLOCKED', () => {
  it('shadow_semantic_full configured ⇒ enabled=false + reason set', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'shadow_semantic_full' });
    const cfg = p.getConfig();
    expect(cfg.mode).toBe('shadow_semantic_full');
    expect(cfg.enabled).toBe(false);
    expect(cfg.reason).toBe(BLOCKED_REASON);
  });

  it('semantic_primary configured ⇒ enabled=false + reason set', () => {
    const p = createStaticRoutingConfigProvider({ mode: 'semantic_primary' });
    const cfg = p.getConfig();
    expect(cfg.mode).toBe('semantic_primary');
    expect(cfg.enabled).toBe(false);
    expect(cfg.reason).toBe(BLOCKED_REASON);
  });
});

describe('routing-config — ALLOWED and BLOCKED sets are disjoint', () => {
  it('ALLOWED_MODES ∩ BLOCKED_MODES = ∅', () => {
    for (const m of ALLOWED_MODES) {
      expect(BLOCKED_MODES.has(m)).toBe(false);
    }
    for (const m of BLOCKED_MODES) {
      expect(ALLOWED_MODES.has(m)).toBe(false);
    }
  });

  it('union covers all 7 modes', () => {
    const all = new Set<RoutingMode>([...ALLOWED_MODES, ...BLOCKED_MODES]);
    expect(all.size).toBe(7);
    expect(all.has('legacy')).toBe(true);
    expect(all.has('registry_cache')).toBe(true);
    expect(all.has('shadow_trace_only')).toBe(true);
    expect(all.has('shadow_registry_only')).toBe(true);
    expect(all.has('shadow_structural_full')).toBe(true);
    expect(all.has('shadow_semantic_full')).toBe(true);
    expect(all.has('semantic_primary')).toBe(true);
  });
});
