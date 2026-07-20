// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerStatusRoutes } from '@/routes/status/status-routes';

const queueServiceMock = vi.hoisted(() => ({
  getStatistics: vi.fn(),
  healthCheck: vi.fn(),
}));

const queueRuntimeMock = vi.hoisted(() => ({
  enabled: true,
  reason: undefined,
  configuration: {
    workerCount: 2,
    workerConcurrency: 10,
    scale: {
      enabled: true,
      minWorkers: 1,
      maxWorkers: 5,
      scaleStep: 1,
      scaleUpUtilizationPercent: 80,
      scaleDownUtilizationPercent: 20,
      scaleUpQueueSize: 50,
      scaleDownQueueSize: 5,
      monitorIntervalMs: 15_000,
      cooldownMs: 60_000,
    },
  },
}));

vi.mock('@/services/request-queue-service', () => ({
  requestQueueService: queueServiceMock,
}));

vi.mock('@/queue/queue-runtime-state', () => ({
  getQueueRuntimeState: () => queueRuntimeMock,
}));

describe('Status Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    queueRuntimeMock.enabled = true;
    queueRuntimeMock.reason = undefined;
    queueRuntimeMock.configuration = {
      workerCount: 2,
      workerConcurrency: 5,
      scale: {
        enabled: true,
        minWorkers: 5,
        maxWorkers: 25,
        scaleStep: 5,
        scaleUpUtilizationPercent: 80,
        scaleDownUtilizationPercent: 20,
        scaleUpQueueSize: 50,
        scaleDownQueueSize: 5,
        monitorIntervalMs: 10_000,
        cooldownMs: 30_000,
      },
    };

    queueServiceMock.getStatistics.mockResolvedValue({
      waiting: 12,
      active: 150,
      completed: 1234,
      failed: 12,
      capacity: 200,
      utilizationPercent: 75,
      workerCount: 2,
    });

    queueServiceMock.healthCheck.mockResolvedValue({
      healthy: true,
      queueSize: 12,
      workersActive: 150,
      utilizationPercent: 75,
      workerCount: 2,
    });

    app = Fastify();
    await registerStatusRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns queue autoscaling metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/status',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();

    expect(payload.features.queue.autoscale).toEqual(
      expect.objectContaining({
        enabled: true,
        minWorkers: 5,
        maxWorkers: 25,
        scaleStep: 5,
        scaleUpUtilizationPercent: 80,
        scaleDownUtilizationPercent: 20,
        scaleUpQueueSize: 50,
        scaleDownQueueSize: 5,
        monitorIntervalMs: 10000,
        cooldownMs: 30000,
      })
    );

    expect(payload.features.queue.stats).toEqual(
      expect.objectContaining({
        waiting: 12,
        active: 150,
        completed: 1234,
        failed: 12,
        capacity: 200,
        workerCount: 2,
      })
    );

    expect(payload.features.queue.health).toEqual(
      expect.objectContaining({
        healthy: true,
        queueSize: 12,
        workersActive: 150,
        workerCount: 2,
      })
    );
  });
});


