// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-service-enabled.test.ts — MVP 8C.0
 *
 * With flag ON and sampleRate=1, the service:
 *   - invokes the Pareto computer
 *   - logs a redacted event
 *   - emits metrics
 *   - returns a properly-shaped result
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DefaultShadowRoutingService,
  DEFERRED_PARETO_COMPUTER,
  type ShadowParetoComputer,
} from '../shadow-routing-service';
import { resolveShadowConfig } from '../shadow-routing-config';
import { InMemoryShadowLogger, SHADOW_DECISION_EVENT } from '../shadow-routing-logger';
import { InMemoryShadowMetrics } from '../shadow-routing-metrics';
import type { ShadowRoutingInput } from '../shadow-routing-types';

const input: ShadowRoutingInput = Object.freeze({
  requestId: 'r-enabled-1',
  routeContext: {
    actualModel: 'claude-opus-4',
    actualProvider: 'anthropic',
    actualStrategy: 'single',
  },
  profilerInput: { requestId: 'r-enabled-1', approximateInputTokens: 200, taskTypeHint: 'code-generation' },
  metadata: { source: 'chat', timestamp: '2026-05-12T20:00:00Z' },
});

function fakeComputer(): ShadowParetoComputer {
  return {
    compute: vi.fn(async () => ({
      taskProfile: { taskType: 'code-generation', complexity: 'medium' },
      paretoPlan: {
        strategy: 'parallel',
        selectedRouteIds: ['route-a', 'route-b'],
        selectedModelIds: ['model-a', 'model-b'],
        expectedJudge: 0.82,
        expectedCostUsd: 0.003,
        paretoStatus: 'beats_baseline',
        peerLift: -0.1,
      },
    })),
  };
}

describe('enabled — flag ON + sampleRate=1', () => {
  it('isEnabled() returns true', () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
    });
    expect(service.isEnabled()).toBe(true);
  });

  it('invokes the Pareto computer once', async () => {
    const computer = fakeComputer();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: computer,
    });
    await service.run(input);
    expect(computer.compute).toHaveBeenCalledTimes(1);
  });

  it('returns executed=true with Pareto plan + diff', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: fakeComputer(),
    });
    const r = await service.run(input);
    expect(r.executed).toBe(true);
    expect(r.paretoPlan?.strategy).toBe('parallel');
    expect(r.paretoPlan?.expectedJudge).toBe(0.82);
    expect(r.diff).toBeDefined();
  });

  it('emits a single executed counter increment', async () => {
    const metrics = new InMemoryShadowMetrics();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: fakeComputer(),
      metrics,
    });
    await service.run(input);
    expect(metrics.getCount('shadow_routing_executed_total')).toBe(1);
  });

  it('logs a redacted event when logLevel != off', async () => {
    const logger = new InMemoryShadowLogger();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1, logLevel: 'info' }),
      paretoComputer: fakeComputer(),
      logger,
    });
    await service.run(input);
    expect(logger.size()).toBe(1);
    const snapshot = logger.snapshot();
    expect(snapshot[0].event).toBe(SHADOW_DECISION_EVENT);
    const json = JSON.stringify(snapshot[0].payload);
    // Hashed identifiers — not raw model/provider.
    expect(json).not.toContain('claude-opus-4');
    expect(json).not.toContain('anthropic');
    expect(json).toContain('actualModelHash');
    expect(json).toContain('actualProviderHash');
  });

  it('records latency observation', async () => {
    const metrics = new InMemoryShadowMetrics();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: fakeComputer(),
      metrics,
    });
    await service.run(input);
    const observations = metrics.getObservations('shadow_routing_latency_ms');
    expect(observations.length).toBeGreaterThanOrEqual(1);
  });
});

describe('deferred Pareto computer (default)', () => {
  it('default computer returns skippedReason=pareto_compute_not_yet_wired', async () => {
    const r = await DEFERRED_PARETO_COMPUTER.compute(input, { aborted: false });
    expect(r.skippedReason).toBe('pareto_compute_not_yet_wired');
  });

  it('service surfaces the computer skip reason', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
    });
    const r = await service.run(input);
    expect(r.executed).toBe(true); // Service ran; computer returned skip reason.
    expect(r.skippedReason).toBe('pareto_compute_not_yet_wired');
  });
});

describe('task type gate', () => {
  it('skips when taskTypeHint not in approved list', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({
        enabled: true,
        sampleRate: 1,
        taskTypes: ['code-generation'],
      }),
    });
    const r = await service.run({
      ...input,
      profilerInput: { ...input.profilerInput, taskTypeHint: 'reasoning' },
    });
    expect(r.skippedReason).toBe('task_type_not_approved');
  });
});
