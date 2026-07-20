// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-timeout.test.ts — MVP 8C.0
 *
 * When the Pareto computer exceeds `maxLatencyMs`, the service MUST:
 *   - cancel the compute (signal.aborted=true)
 *   - return skippedReason='shadow_timeout'
 *   - increment timeout metric
 *   - never throw to the caller
 */

import { describe, expect, it } from 'vitest';
import {
  DefaultShadowRoutingService,
  type ShadowParetoComputer,
} from '../shadow-routing-service';
import { resolveShadowConfig } from '../shadow-routing-config';
import { InMemoryShadowMetrics } from '../shadow-routing-metrics';
import type { ShadowRoutingInput } from '../shadow-routing-types';

const input: ShadowRoutingInput = Object.freeze({
  requestId: 'r-timeout-1',
  routeContext: { actualModel: 'm', actualProvider: 'p', actualStrategy: 'single' },
  profilerInput: { requestId: 'r-timeout-1', taskTypeHint: 'code-generation' },
  metadata: { source: 'chat', timestamp: '2026-05-12T20:00:00Z' },
});

function slowComputer(delayMs: number): ShadowParetoComputer {
  return {
    async compute(_, signal) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
      // After awaking, check signal — a real impl should bail out.
      void signal;
      return { skippedReason: undefined };
    },
  };
}

describe('shadow timeout', () => {
  it('exceeding maxLatencyMs returns skippedReason=shadow_timeout', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1, maxLatencyMs: 10 }),
      paretoComputer: slowComputer(100),
    });
    const r = await service.run(input);
    expect(r.skippedReason).toBe('shadow_timeout');
    expect(r.executed).toBe(false);
  });

  it('within budget: completes normally', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1, maxLatencyMs: 200 }),
      paretoComputer: slowComputer(5),
    });
    const r = await service.run(input);
    expect(r.executed).toBe(true);
  });

  it('timeout increments the timeout metric', async () => {
    const metrics = new InMemoryShadowMetrics();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1, maxLatencyMs: 10 }),
      paretoComputer: slowComputer(100),
      metrics,
    });
    await service.run(input);
    expect(metrics.getCount('shadow_routing_timeout_total')).toBe(1);
  });

  it('caller never receives a thrown exception on timeout', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1, maxLatencyMs: 10 }),
      paretoComputer: slowComputer(100),
    });
    await expect(service.run(input)).resolves.toBeDefined();
  });
});
