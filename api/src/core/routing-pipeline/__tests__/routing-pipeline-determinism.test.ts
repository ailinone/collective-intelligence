// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-determinism.test.ts — MVP 7A
 *
 * Pipeline must be deterministic: same input → same result. No clock,
 * no randomness. Input must not be mutated.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { composeRoutingPipeline } from '../routing-pipeline-composer';
import { createStaticRoutingConfigProvider } from '../../routing-config/runtime-routing-config-provider';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import type { TaskProfilerInput } from '../../task-profile/task-profile-types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routing-pipeline — determinism', () => {
  function runOnce(): unknown {
    return composeRoutingPipeline({
      requestId: 'r-det-1',
      profilerInput: { requestId: 'r-det-1', text: 'analyze quarterly data' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      nowIso: '2026-05-12T13:07:00.000Z',
      traceId: 'trace-det-1',
    });
  }

  it('same input → same JSON-serialized result', () => {
    const a = JSON.stringify(runOnce());
    const b = JSON.stringify(runOnce());
    expect(a).toBe(b);
  });

  it('1000 iterations produce identical traces (trace.strategyPlan)', () => {
    const first = runOnce();
    const firstJson = JSON.stringify(first);
    for (let i = 0; i < 1000; i += 1) {
      const r = runOnce();
      expect(JSON.stringify(r)).toBe(firstJson);
    }
  });

  it('does not call Date.now anywhere in the pipeline', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    composeRoutingPipeline({
      requestId: 'r-det-2',
      profilerInput: { requestId: 'r-det-2', text: 'whatever' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
      nowIso: '2026-05-12T13:07:30.000Z',
      traceId: 'trace-det-2',
    });
    expect(dateSpy).not.toHaveBeenCalled();
  });

  it('does not call Math.random anywhere in the pipeline', () => {
    const randSpy = vi.spyOn(Math, 'random');
    composeRoutingPipeline({
      requestId: 'r-det-3',
      profilerInput: { requestId: 'r-det-3', text: 'data' },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(randSpy).not.toHaveBeenCalled();
  });

  it('input.profilerInput is not mutated', () => {
    const input: TaskProfilerInput = {
      requestId: 'r-det-4',
      text: 'help me',
    };
    const before = JSON.stringify(input);
    composeRoutingPipeline({
      requestId: 'r-det-4',
      profilerInput: input,
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('every allowed mode is deterministic across 50 iterations', () => {
    const modes = [
      'legacy',
      'registry_cache',
      'shadow_trace_only',
      'shadow_registry_only',
      'shadow_structural_full',
    ] as const;
    for (const mode of modes) {
      const first = composeRoutingPipeline({
        requestId: 'r-det-5',
        profilerInput: { requestId: 'r-det-5', text: 'x' },
        registry: buildFixtureRegistry(),
        configProvider: createStaticRoutingConfigProvider({ mode }),
        nowIso: '2026-05-12T13:08:00.000Z',
        traceId: 'trace-det-5',
      });
      const firstJson = JSON.stringify(first);
      for (let i = 0; i < 50; i += 1) {
        const r = composeRoutingPipeline({
          requestId: 'r-det-5',
          profilerInput: { requestId: 'r-det-5', text: 'x' },
          registry: buildFixtureRegistry(),
          configProvider: createStaticRoutingConfigProvider({ mode }),
          nowIso: '2026-05-12T13:08:00.000Z',
          traceId: 'trace-det-5',
        });
        expect(JSON.stringify(r)).toBe(firstJson);
      }
    }
  });
});
