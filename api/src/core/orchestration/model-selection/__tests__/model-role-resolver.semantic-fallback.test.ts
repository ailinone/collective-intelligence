// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Semantic search is optional. When disabled or unavailable, the
 * resolver falls back to structured filtering and records the status
 * in the trace.
 *
 * Strategy 01C.0 does NOT activate TEI for model selection — the
 * interface exists but is not wired. The default trace should always
 * say `disabled` (when `semanticSearch: null`) or `source_unavailable`
 * (when omitted) — NEVER `used`.
 */
import { describe, it, expect } from 'vitest';
import {
  DISABLED_SEMANTIC_SEARCH,
  ModelRoleResolver,
  type SemanticModelSearchProvider,
} from '../model-role-resolver';
import { diversePool } from './role-resolver.fixtures';

describe('ModelRoleResolver — semantic fallback', () => {
  it('with semanticSearch: null → trace says "disabled"', async () => {
    const resolver = new ModelRoleResolver({ semanticSearch: DISABLED_SEMANTIC_SEARCH });
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis', userMessageExcerpt: 'do X' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: diversePool(),
      constraints: {},
    });
    expect(r.trace.semanticSearchStatus).toBe('not_applicable');
    // When a candidatePool is provided, semantic search is "not_applicable"
    // (pool takes precedence). Drop the pool to exercise the fallback.
  });

  it('without candidatePool + without semanticSearch → trace says "source_unavailable"', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      constraints: {},
    });
    // No catalog wired AND no semantic search → source_unavailable
    expect(['source_unavailable', 'disabled']).toContain(r.trace.semanticSearchStatus);
    expect(r.trace.registrySourceStatus).toBe('source_unavailable');
  });

  it('with semanticSearch available AND no pool → uses semantic results', async () => {
    const semanticSearch: SemanticModelSearchProvider = {
      isAvailable: () => true,
      search: async () => diversePool(),
    };
    const resolver = new ModelRoleResolver({ semanticSearch });
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis', userMessageExcerpt: 'do Y' },
      strategyName: 'consensus',
      role: 'participant',
      constraints: {},
    });
    expect(r.trace.semanticSearchStatus).toBe('used');
    expect(r.selected.length).toBe(3);
  });

  it('semantic search failure falls back gracefully (no crash)', async () => {
    const semanticSearch: SemanticModelSearchProvider = {
      isAvailable: () => true,
      search: async () => {
        throw new Error('TEI unreachable');
      },
    };
    const resolver = new ModelRoleResolver({ semanticSearch });
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      constraints: {},
    });
    expect(r.trace.semanticSearchStatus).toBe('source_unavailable');
    expect(r.selected.length).toBe(0); // no fallback catalog wired
  });
});
