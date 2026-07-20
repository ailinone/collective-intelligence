// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { ModelDiscoveryService } from '../../src/services/model-discovery-service';
import { logger } from '../../src/utils/logger';
import { beforeAll, afterAll } from 'vitest';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';

describe('ModelDiscoveryService - 100% Dynamic', () => {
  let discoveryService: ModelDiscoveryService;

  beforeAll(async () => {
    await startTestEnvironment();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(() => {
    discoveryService = new ModelDiscoveryService(logger);
  });

  it('should create ModelDiscoveryService instance', () => {
    expect(discoveryService).toBeDefined();
    expect(discoveryService).toBeInstanceOf(ModelDiscoveryService);
  });

  it('should discover models dynamically without hardcoded catalog', async () => {
    const models = await discoveryService.discoverAllModels();

    // Models array should be defined (may be empty if no providers configured)
    expect(Array.isArray(models)).toBe(true);
  });

  it('should sync discovered models to catalog', async () => {
    const result = await discoveryService.syncDiscoveredModels();

    // Result should have expected structure
    expect(result).toHaveProperty('discovered');
    expect(result).toHaveProperty('updated');
    expect(result).toHaveProperty('unchanged');

    expect(typeof result.discovered).toBe('number');
    expect(typeof result.updated).toBe('number');
    expect(typeof result.unchanged).toBe('number');
  });

  it('should get discovery statistics', async () => {
    const stats = await discoveryService.getDiscoveryStats();

    // Stats should have expected structure
    expect(stats).toHaveProperty('totalModels');
    expect(stats).toHaveProperty('totalProviders');
    expect(stats).toHaveProperty('totalSources');
    expect(stats).toHaveProperty('sourcesByType');
    expect(stats).toHaveProperty('providersBySource');
    expect(stats).toHaveProperty('lastDiscovery');
  });

  it('should check if models are available', async () => {
    const hasModels = await discoveryService.hasAvailableModels();

    // Should return boolean
    expect(typeof hasModels).toBe('boolean');
  });
});
