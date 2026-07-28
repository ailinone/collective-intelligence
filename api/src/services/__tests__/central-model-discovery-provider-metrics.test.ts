// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Coverage for updateProviderModelCountMetrics(): refreshes
 * ci_provider_discovered_models_total (Grafana alert
 * ci-alert-provider-model-count-drop watches this) with the actual current
 * `models` row count per provider_id after each discovery cycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const groupByMock = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: {
    model: {
      groupBy: (...args: unknown[]) => groupByMock(...args),
    },
  },
}));

vi.mock('@/observability/ci-metrics', () => ({
  providerDiscoveredModelsTotal: { set: vi.fn() },
}));

import { CentralModelDiscoveryService } from '@/services/central-model-discovery-service';
import { providerDiscoveredModelsTotal } from '@/observability/ci-metrics';

type UpdateFn = () => Promise<void>;

function getUpdater(): UpdateFn {
  const service = new CentralModelDiscoveryService();
  return (service as unknown as { updateProviderModelCountMetrics: UpdateFn })
    .updateProviderModelCountMetrics.bind(service);
}

describe('central-model-discovery-service: updateProviderModelCountMetrics', () => {
  beforeEach(() => {
    groupByMock.mockReset();
    vi.mocked(providerDiscoveredModelsTotal.set).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the gauge to the current DB row count for every provider returned by groupBy', async () => {
    groupByMock.mockResolvedValueOnce([
      { providerId: 'featherless-ai', _count: { _all: 21518 } },
      { providerId: 'huggingface', _count: { _all: 64729 } },
      { providerId: 'gemini-openai', _count: { _all: 57 } },
    ]);

    await getUpdater()();

    expect(groupByMock).toHaveBeenCalledWith({
      by: ['providerId'],
      _count: { _all: true },
    });
    expect(providerDiscoveredModelsTotal.set).toHaveBeenCalledWith(
      { provider: 'featherless-ai' },
      21518
    );
    expect(providerDiscoveredModelsTotal.set).toHaveBeenCalledWith(
      { provider: 'huggingface' },
      64729
    );
    expect(providerDiscoveredModelsTotal.set).toHaveBeenCalledWith(
      { provider: 'gemini-openai' },
      57
    );
    expect(providerDiscoveredModelsTotal.set).toHaveBeenCalledTimes(3);
  });

  it('is a no-op (no gauge calls) when no models exist for any provider', async () => {
    groupByMock.mockResolvedValueOnce([]);

    await getUpdater()();

    expect(providerDiscoveredModelsTotal.set).not.toHaveBeenCalled();
  });

  it('swallows a DB error instead of throwing, so a metrics failure never fails the discovery cycle', async () => {
    groupByMock.mockRejectedValueOnce(new Error('connection reset'));

    await expect(getUpdater()()).resolves.toBeUndefined();
    expect(providerDiscoveredModelsTotal.set).not.toHaveBeenCalled();
  });
});
