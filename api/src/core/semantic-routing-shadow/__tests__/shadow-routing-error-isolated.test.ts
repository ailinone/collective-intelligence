// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-error-isolated.test.ts — MVP 8C.0
 *
 * Errors thrown by the Pareto computer MUST be captured by the service
 * and surfaced as skippedReason='shadow_error'. The caller must never
 * see a thrown exception.
 */

import { describe, expect, it } from 'vitest';
import {
  DefaultShadowRoutingService,
  type ShadowParetoComputer,
} from '../shadow-routing-service';
import { resolveShadowConfig } from '../shadow-routing-config';
import { InMemoryShadowLogger } from '../shadow-routing-logger';
import { InMemoryShadowMetrics } from '../shadow-routing-metrics';
import type { ShadowRoutingInput } from '../shadow-routing-types';

const input: ShadowRoutingInput = Object.freeze({
  requestId: 'r-err-1',
  routeContext: { actualModel: 'm', actualProvider: 'p', actualStrategy: 'single' },
  profilerInput: { requestId: 'r-err-1', taskTypeHint: 'code-generation' },
  metadata: { source: 'chat', timestamp: '2026-05-12T20:00:00Z' },
});

function throwingComputer(): ShadowParetoComputer {
  return {
    async compute() {
      throw new Error('pareto_compute_failure');
    },
  };
}

describe('error isolation', () => {
  it('throwing computer → skippedReason=shadow_error', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: throwingComputer(),
    });
    const r = await service.run(input);
    expect(r.executed).toBe(false);
    expect(r.skippedReason).toBe('shadow_error');
  });

  it('caller never receives a thrown exception', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: throwingComputer(),
    });
    await expect(service.run(input)).resolves.toBeDefined();
  });

  it('error increments the error metric', async () => {
    const metrics = new InMemoryShadowMetrics();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 1 }),
      paretoComputer: throwingComputer(),
      metrics,
    });
    await service.run(input);
    expect(metrics.getCount('shadow_routing_error_total')).toBe(1);
  });

  it('error path emits a log event (when logLevel != off)', async () => {
    const logger = new InMemoryShadowLogger();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({
        enabled: true,
        sampleRate: 1,
        logLevel: 'error',
      }),
      paretoComputer: throwingComputer(),
      logger,
    });
    await service.run(input);
    expect(logger.size()).toBe(1);
    const json = JSON.stringify(logger.snapshot()[0].payload);
    expect(json).toContain('shadow_error');
  });
});

describe('error path — never leaks PII', () => {
  it('error payload still scrubs forbidden keys', async () => {
    const logger = new InMemoryShadowLogger();
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({
        enabled: true,
        sampleRate: 1,
        logLevel: 'error',
      }),
      paretoComputer: throwingComputer(),
      logger,
    });
    await service.run({
      ...input,
      routeContext: {
        actualModel: 'top-secret-model',
        actualProvider: 'top-secret-provider',
        actualStrategy: 'single',
      },
    });
    const json = JSON.stringify(logger.snapshot()[0].payload);
    expect(json).not.toContain('top-secret-model');
    expect(json).not.toContain('top-secret-provider');
  });
});
