// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-legacy-equivalence.test.ts — MVP 8C.0
 *
 * Proves that running the shadow service alongside a "legacy selection"
 * NEVER alters the legacy selection object. Uses a small adapter that
 * mirrors the runtime contract: legacySelect() → actualSelection,
 * then shadow.run() called (fire-and-forget OR awaited).
 */

import { describe, expect, it } from 'vitest';
import {
  DefaultShadowRoutingService,
  type ShadowParetoComputer,
} from '../shadow-routing-service';
import { resolveShadowConfig } from '../shadow-routing-config';
import type { ShadowRoutingInput } from '../shadow-routing-types';

interface ActualSelection {
  readonly model: string;
  readonly provider: string;
  readonly strategy: string;
  readonly routeId: string;
}

function legacySelect(): ActualSelection {
  return Object.freeze({
    model: 'claude-opus-4',
    provider: 'anthropic',
    strategy: 'single',
    routeId: 'route-1',
  });
}

const baseInput = (actual: ActualSelection): ShadowRoutingInput => ({
  requestId: 'r-equiv-1',
  routeContext: {
    actualModel: actual.model,
    actualProvider: actual.provider,
    actualStrategy: actual.strategy,
    actualRouteId: actual.routeId,
  },
  profilerInput: { requestId: 'r-equiv-1', taskTypeHint: 'code-generation' },
  metadata: { source: 'chat', timestamp: '2026-05-12T20:00:00Z' },
});

describe('legacy equivalence — shadow OFF', () => {
  it('legacy selection identity unchanged after shadow.run()', async () => {
    const actual = legacySelect();
    const before = JSON.stringify(actual);
    const service = new DefaultShadowRoutingService({});
    await service.run(baseInput(actual));
    expect(JSON.stringify(actual)).toBe(before);
  });

  it('shadow returns skip but the runtime continues unchanged', async () => {
    const actual = legacySelect();
    const service = new DefaultShadowRoutingService({});
    const result = await service.run(baseInput(actual));
    expect(result.executed).toBe(false);
    expect(actual.model).toBe('claude-opus-4');
    expect(actual.strategy).toBe('single');
  });
});

describe('legacy equivalence — shadow ON', () => {
  function happyComputer(): ShadowParetoComputer {
    return {
      async compute() {
        return {
          taskProfile: { taskType: 'code-generation' },
          paretoPlan: {
            strategy: 'parallel',
            selectedRouteIds: ['route-a', 'route-b'],
            selectedModelIds: ['model-a', 'model-b'],
            expectedJudge: 0.8,
            expectedCostUsd: 0.003,
            paretoStatus: 'beats_baseline',
          },
        };
      },
    };
  }

  it('legacy selection identity unchanged after shadow runs', async () => {
    const actual = legacySelect();
    const before = JSON.stringify(actual);
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: happyComputer(),
    });
    await service.run(baseInput(actual));
    expect(JSON.stringify(actual)).toBe(before);
  });

  it('Pareto chose a DIFFERENT plan but legacy stays the source of truth', async () => {
    const actual = legacySelect();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: happyComputer(),
    });
    const result = await service.run(baseInput(actual));
    expect(result.paretoPlan?.strategy).toBe('parallel');
    expect(actual.strategy).toBe('single'); // legacy unchanged
  });

  it('fire-and-forget pattern: void return must not block', async () => {
    const actual = legacySelect();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: happyComputer(),
    });
    // Pattern: `void service.run(...)` — no await. The legacy code
    // path immediately returns `actual` while shadow runs async.
    void service.run(baseInput(actual));
    expect(actual.model).toBe('claude-opus-4');
  });
});

describe('legacy equivalence — shadow ERROR', () => {
  function throwingComputer(): ShadowParetoComputer {
    return {
      async compute() {
        throw new Error('boom');
      },
    };
  }

  it('shadow error never alters legacy selection', async () => {
    const actual = legacySelect();
    const before = JSON.stringify(actual);
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: throwingComputer(),
    });
    const r = await service.run(baseInput(actual));
    expect(r.skippedReason).toBe('shadow_error');
    expect(JSON.stringify(actual)).toBe(before);
  });
});
