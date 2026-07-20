// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-service-disabled.test.ts — MVP 8C.0
 *
 * When the feature flag is OFF or sampleRate is 0, the service MUST
 * return immediately with the appropriate skippedReason and MUST NOT
 * invoke the Pareto computer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DefaultShadowRoutingService,
  type ShadowParetoComputer,
} from '../shadow-routing-service';
import { resolveShadowConfig } from '../shadow-routing-config';
import { InMemoryShadowLogger } from '../shadow-routing-logger';
import { InMemoryShadowMetrics } from '../shadow-routing-metrics';
import type { ShadowRoutingInput } from '../shadow-routing-types';

const input: ShadowRoutingInput = Object.freeze({
  requestId: 'r-disabled-1',
  routeContext: { actualModel: 'm', actualProvider: 'p', actualStrategy: 'single' },
  profilerInput: { requestId: 'r-disabled-1', approximateInputTokens: 100 },
  metadata: { source: 'chat', timestamp: '2026-05-12T20:00:00Z' },
});

function neverCalledComputer(): ShadowParetoComputer {
  return {
    compute: vi.fn(async () => {
      throw new Error('compute_should_not_be_called');
    }),
  };
}

describe('disabled — flag OFF', () => {
  it('default config (flag OFF) → skippedReason=flag_disabled', async () => {
    const service = new DefaultShadowRoutingService({});
    const r = await service.run(input);
    expect(r.executed).toBe(false);
    expect(r.skippedReason).toBe('flag_disabled');
  });

  it('isEnabled() returns false when flag is OFF', () => {
    const service = new DefaultShadowRoutingService({});
    expect(service.isEnabled()).toBe(false);
  });

  it('isEnabled() returns false when sampleRate=0 even if flag ON', () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 0 }),
    });
    expect(service.isEnabled()).toBe(false);
  });

  it('Pareto computer is NEVER invoked when flag is OFF', async () => {
    const computer = neverCalledComputer();
    const service = new DefaultShadowRoutingService({
      paretoComputer: computer,
    });
    await service.run(input);
    expect(computer.compute).not.toHaveBeenCalled();
  });
});

describe('disabled — sampleRate=0', () => {
  it('skippedReason=sample_rate_zero', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({ enabled: true, sampleRate: 0 }),
    });
    const r = await service.run(input);
    expect(r.skippedReason).toBe('sample_rate_zero');
  });
});

describe('disabled — emits metrics + does NOT log when log_level=off', () => {
  it('metrics get a skipped counter increment', async () => {
    const metrics = new InMemoryShadowMetrics();
    const service = new DefaultShadowRoutingService({ metrics });
    await service.run(input);
    expect(metrics.getCount('shadow_routing_skipped_total', { reason: 'flag_disabled' })).toBe(1);
  });

  it('default config has logLevel=off → logger NOT invoked', async () => {
    const logger = new InMemoryShadowLogger();
    const service = new DefaultShadowRoutingService({ logger });
    await service.run(input);
    expect(logger.size()).toBe(0);
  });
});

describe('decisionMode safety guard', () => {
  it('refuses to run when decisionMode !== legacy', async () => {
    const service = new DefaultShadowRoutingService({
      config: resolveShadowConfig({
        enabled: true,
        sampleRate: 1,
        decisionMode: 'shadow' as 'legacy',
      }),
    });
    const r = await service.run(input);
    expect(r.executed).toBe(false);
    expect(r.skippedReason).toBe('invalid_input');
  });
});
