// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerMetricsRoute } from '@/routes/metrics/metrics-route';
import type { AppConfig } from '@/types';

const mockedConfig = vi.hoisted(() => ({} as Partial<AppConfig>));

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  const cloned = structuredClone(actual.config);

  Object.assign(mockedConfig, cloned);
  mockedConfig.server = { ...cloned.server, logLevel: 'info' };
  mockedConfig.observability = {
    ...cloned.observability,
    prometheusToken: undefined as string | undefined,
  };

  return {
    ...actual,
    config: mockedConfig,
    isDevelopment: actual.isDevelopment,
  };
});

const getMetricsMock = vi.hoisted(() =>
  vi.fn(async () => 'metric_one 1\n')
);

vi.mock('@/utils/metrics', () => ({
  getMetrics: getMetricsMock,
}));

import { config } from '@/config';

describe('Metrics Route', () => {
  const originalToken = config.observability.prometheusToken;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    getMetricsMock.mockResolvedValue('metric_one 1\n');
    app = Fastify();
    await registerMetricsRoute(app);
    await app.ready();
  });

  afterEach(async () => {
    config.observability.prometheusToken = originalToken;
    if (app) {
      await app.close();
    }
  });

  it('returns metrics without auth when token not configured', async () => {
    config.observability.prometheusToken = undefined;

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.body).toBe('metric_one 1\n');
    expect(getMetricsMock).toHaveBeenCalled();
  });

  it('requires token when configured', async () => {
    config.observability.prometheusToken = 'secret-token';

    const missingTokenResponse = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(missingTokenResponse.statusCode).toBe(403);

    const authorized = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: {
        authorization: 'Bearer secret-token',
      },
    });

    expect(authorized.statusCode).toBe(200);
    expect(getMetricsMock).toHaveBeenCalledTimes(1);
  });
});

