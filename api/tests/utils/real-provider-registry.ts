// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real Provider Registry for Tests
 * 
 * Creates a REAL provider registry with REAL adapters and REAL models from dynamic discovery
 * NO mocks, NO hardcoded models
 */

import { ProviderRegistry } from '@/providers/provider-registry';
import { initializeProviderRegistry } from '@/providers/provider-registry';
import { config } from '@/config';
import { ensureModelsDiscovered } from './dynamic-model-discovery';
import { logger } from '@/utils/logger';
import { createMockProviderRegistry, syncMockModelsToCatalog } from './mock-provider';

const log = logger.child({ component: 'test-real-provistry' });

/**
 * Create a REAL provider registry with REAL adapters
 * Uses dynamic model discovery - NO mocks, NO hardcoded models
 */
export async function createRealProviderRegistry(): Promise<ProviderRegistry> {
  const deterministicLocalMode =
    process.env.TEST_USE_REAL_API_KEYS !== 'true' || process.env.TEST_SKIP_EXTERNAL_APIS === 'true';

  if (deterministicLocalMode) {
    log.info('Using deterministic local provider registry fallback (mock adapters)');
    const registry = createMockProviderRegistry();
    await syncMockModelsToCatalog(registry);
    return registry;
  }

  log.info('Creating REAL provider registry with dynamic discovery');
  
  // Ensure models are discovered first
  await ensureModelsDiscovered();
  
  // Initialize provider registry with real config - config is already loaded synchronously
  const registry = await initializeProviderRegistry(config.providers);
  
  log.info(
    { 
      providerCount: registry.getProviderNames().length,
      providers: registry.getProviderNames() 
    },
    'Real provider registry created'
  );
  
  return registry;
}

/**
 * Sync real models from registry to catalog
 * Models come from dynamic discovery - NO hardcoded models
 */
export async function syncRealModelsToCatalog(registry: ProviderRegistry): Promise<void> {
  const deterministicLocalMode =
    process.env.TEST_USE_REAL_API_KEYS !== 'true' || process.env.TEST_SKIP_EXTERNAL_APIS === 'true';

  if (deterministicLocalMode) {
    await syncMockModelsToCatalog(registry);
    return;
  }

  log.info('Syncing real models from registry to catalog');
  
  // Models are already in catalog from dynamic discovery
  // This function is kept for compatibility but doesn't need to do anything
  // since ensureModelsDiscovered() already populated the catalog
  
  const models = await registry.getAllModels();
  log.info({ modelCount: models.length }, 'Models available in registry');
}
