// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard: `filterByCapabilities` must defer EVERY alias of
 * `function_calling` (canonical ontology id `tools`), not just the literal
 * string `function_calling`.
 *
 * `mapInferredCapabilities` (orchestration-engine.ts) always pushes BOTH
 * `'tool_use'` and `'function_calling'` together into `requiredCapabilities`
 * whenever a tools-bearing request is detected — this pair, not
 * `'function_calling'` alone, is the real production shape passed to
 * `filterByCapabilities` / `buildChatExecutionPool` (used by
 * base-strategy.ts's `getEligibleModels()` for every multi-model strategy:
 * consensus, collaborative, hybrid, debate, quality-multipass, ...).
 *
 * The 2026-08-21 fix deferred `function_calling` from the hard-capability
 * filter because the capability is sparsely declared across the catalog —
 * hard-filtering on it collapsed tools-request pools to a handful of
 * mostly-dead models. But the deferral only stripped the literal string
 * `'function_calling'`; `capability-ontology.ts` defines `tool_use` and
 * `function_calling` as ALIASES of the same canonical capability (`tools`),
 * so leaving `tool_use` hard-required silently reimposed the exact
 * hard-filter the deferral was built to avoid.
 *
 * Confirmed real, not hypothetical: `baidu-model-fetcher.ts`
 * (`extractCapabilitiesFromBaidu`) sets `'function_calling'` for ERNIE-4.x
 * models but never independently sets `'tool_use'` — so any Baidu ERNIE-4.x
 * model reached a multi-model pool for a tools-bearing request and was
 * hard-rejected on the untouched `tool_use` twin, reproducing the exact
 * "eligible pool collapses to near-nothing" failure class the
 * `function_calling` deferral was meant to prevent.
 */
import { describe, it, expect } from 'vitest';
import type { Model } from '@/types';
import { PoolBuilder } from '../pool-builder';

const model = (capabilities: string[], id = 'test-model'): Model =>
  ({ id, capabilities } as unknown as Model);

describe('PoolBuilder.filterByCapabilities — tool_use/function_calling alias deferral', () => {
  it('does NOT hard-reject a model declaring only function_calling when both tool_use and function_calling are required (real production shape, mirrors Baidu ERNIE-4.x)', () => {
    const baiduShaped = model(['chat', 'function_calling'], 'baidu-ernie-4-shaped');
    const result = new PoolBuilder([baiduShaped])
      .filterByCapabilities(['tool_use', 'function_calling'])
      .build();

    expect(result.poolSize).toBe(1);
    expect(result.models[0]?.id).toBe('baidu-ernie-4-shaped');
  });

  it('defers the whole pool (no hard drop) when tool_use + function_calling are the ONLY required capabilities and nothing declares either', () => {
    const bare = model(['chat'], 'bare-model');
    const result = new PoolBuilder([bare]).filterByCapabilities(['tool_use', 'function_calling']).build();

    expect(result.poolSize).toBe(1);
    expect(result.stages[0]?.droppedReasons['function_calling_deferred_to_probe']).toBe(1);
  });

  it('still hard-drops on a genuinely unrelated required capability alongside the deferred pair', () => {
    const noVision = model(['chat', 'function_calling'], 'no-vision');
    const result = new PoolBuilder([noVision])
      .filterByCapabilities(['tool_use', 'function_calling', 'vision'])
      .build();

    expect(result.poolSize).toBe(0);
    expect(result.stages[0]?.droppedReasons['missing_vision']).toBe(1);
  });

  it('KEEPS a model that satisfies both the deferred pair and a genuine hard requirement', () => {
    const sighted = model(['chat', 'function_calling', 'vision'], 'sighted-fc');
    const result = new PoolBuilder([sighted])
      .filterByCapabilities(['tool_use', 'function_calling', 'vision'])
      .build();

    expect(result.poolSize).toBe(1);
  });
});
