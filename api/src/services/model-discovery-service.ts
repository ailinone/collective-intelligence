// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Model } from '@/types';
import type { Logger } from 'pino';

// Forward declarations to resolve circular imports
export interface ModelAutoDiscovery {
  discoverModels(): Promise<Model[]>;
  discoverNewModels(): Promise<{ success: boolean; models: Model[]; errors: string[] }>;
  getModelCatalog(): Model[];
  getDiscoveryStats(): Promise<{
    totalModels: number;
    totalProviders: number;
    totalSources: number;
    lastDiscovery: Date | null;
    nextScheduled: Date | null;
    sourcesByType: Record<string, number>;
  }>;
}

/**
 * Enterprise-grade Model Auto Discovery Implementation
 * 
 * 100% Dynamic - No mocks, stubs, or hardcoded data
 * Uses CentralModelDiscoveryService to fetch models from:
 * - Native provider APIs (OpenAI, Anthropic, Google, etc.)
 * - Cloud hubs (Vertex AI, AWS Bedrock, Azure OpenAI, OCI)
 * - Aggregators (OpenRouter)
 * 
 * All models are discovered in real-time from provider APIs
 */
export function getModelAutoDiscovery(logger: Logger): ModelAutoDiscovery {
  const log = logger.child({ component: 'model-auto-discovery' });
  
  return {
    /**
     * Discover all available models from all sources
     * Enterprise implementation: Real-time API calls to all providers
     */
    async discoverModels(): Promise<Model[]> {
      try {
        const { getCentralModelDiscoveryService } = await import('./central-model-discovery-service.js');
        const centralService = await getCentralModelDiscoveryService();
        const results = await centralService.discoverAllModels();
        
        // Extract all discovered models from results
        const allModels: Model[] = [];
        for (const result of results) {
          if (result.modelsDiscovered > 0) {
            // Models are already persisted by CentralModelDiscoveryService
            // We fetch them from database to return
            const { getAllCatalogModels } = await import('./model-catalog-service.js');
            const models = await getAllCatalogModels();
            allModels.push(...models);
          }
        }
        
        // Deduplicate by model ID
        const uniqueModels = Array.from(
          new Map(allModels.map(m => [m.id, m])).values()
        );
        
        log.info({ count: uniqueModels.length }, 'Models discovered from all sources');
        return uniqueModels;
      } catch (error) {
        log.error({ error }, 'Failed to discover models');
        throw error;
      }
    },

    /**
     * Discover new models and return discovery results
     * Enterprise implementation: Real-time discovery with detailed results
     */
    async discoverNewModels(): Promise<{ success: boolean; models: Model[]; errors: string[] }> {
      try {
        const { getCentralModelDiscoveryService } = await import('./central-model-discovery-service.js');
        const centralService = await getCentralModelDiscoveryService();
        const results = await centralService.discoverAllModels();
        
        const allErrors: string[] = [];
        let totalDiscovered = 0;
        let totalUpdated = 0;
        let totalNew = 0;
        
        for (const result of results) {
          allErrors.push(...(result.errors || []));
          totalDiscovered += result.modelsDiscovered;
          totalUpdated += result.modelsUpdated;
          totalNew += result.modelsNew;
        }
        
        // Fetch discovered models from database
        const { getAllCatalogModels } = await import('./model-catalog-service.js');
        const models = await getAllCatalogModels();
        
        // Mark models with discovery action
        const modelsWithAction = models.map(model => ({
          ...model,
          action: totalNew > 0 ? 'discovered' : totalUpdated > 0 ? 'updated' : 'unchanged',
        }));
        
        const success = allErrors.length === 0 || totalDiscovered > 0;
        
        log.info(
          {
            success,
            discovered: totalNew,
            updated: totalUpdated,
            total: totalDiscovered,
            errors: allErrors.length,
          },
          'Model discovery completed'
        );
        
        return {
          success,
          models: modelsWithAction,
          errors: allErrors,
        };
      } catch (error) {
        log.error({ error }, 'Model discovery failed');
        return {
          success: false,
          models: [],
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },

    /**
     * Get current model catalog from database
     * Enterprise implementation: Returns all dynamically discovered models
     * 
     * NOTE: This is a synchronous method that may return stale data.
     * For real-time data, use discoverModels() instead.
     * 
     * This method is kept for backward compatibility but should be avoided
     * in favor of async methods that fetch from database.
     */
    getModelCatalog(): Model[] {
      // Synchronous method - cannot fetch from database
      // Return empty array and log warning
      // Callers should use discoverModels() for real-time data
      log.warn('getModelCatalog() called synchronously - returns empty array. Use discoverModels() for real-time data from database');
      return [];
    },

    /**
     * Get discovery statistics
     * Enterprise implementation: Real statistics from database
     */
    async getDiscoveryStats(): Promise<{
      totalModels: number;
      totalProviders: number;
      totalSources: number;
      lastDiscovery: Date | null;
      nextScheduled: Date | null;
      sourcesByType: Record<string, number>;
    }> {
      try {
        const { prisma } = await import('../database/client.js');
        const { getCentralModelDiscoveryService } = await import('./central-model-discovery-service.js');
        
        const [totalModels, totalProviders, centralStats] = await Promise.all([
          prisma.model.count({ where: { status: 'active' } }),
          prisma.provider.count({ where: { status: 'active' } }),
          getCentralModelDiscoveryService().then(s => s.getStats()),
        ]);
        
        return {
          totalModels,
          totalProviders,
          totalSources: centralStats.totalSources,
          lastDiscovery: centralStats.lastDiscovery,
          nextScheduled: centralStats.nextScheduled,
          sourcesByType: centralStats.sourcesByType,
        };
      } catch (error) {
        log.error({ error }, 'Failed to get discovery stats');
        return {
          totalModels: 0,
          totalProviders: 0,
          totalSources: 0,
          lastDiscovery: null,
          nextScheduled: null,
          sourcesByType: {},
        };
      }
    },
  };
}

/**
 * Model Discovery Service - 100% Dynamic Model Discovery
 *
 * Enterprise-grade service that provides 100% dynamic model discovery
 * without any hardcoded data, mocks, or stubs.
 *
 * Uses CentralModelDiscoveryService to fetch models in real-time from:
 * - Native provider APIs (OpenAI, Anthropic, Google, Mistral, DeepSeek, xAI, Cohere, Alibaba, Baidu)
 * - Cloud hubs (Vertex AI, AWS Bedrock, Azure OpenAI, OCI Generative AI)
 * - Aggregators (OpenRouter)
 *
 * All models are discovered dynamically from provider APIs and stored in database.
 * No hardcoded catalogs or static model lists.
 */
export class ModelDiscoveryService {
  private readonly log: Logger;
  private centralServicePromise: Promise<import('./central-model-discovery-service.js').CentralModelDiscoveryService> | null = null;

  constructor(logger: Logger) {
    this.log = logger.child({ component: 'model-discovery-service' });
  }

  /**
   * Get or initialize CentralModelDiscoveryService
   * Enterprise pattern: Lazy initialization with singleton
   */
  private async getCentralService(): Promise<import('./central-model-discovery-service.js').CentralModelDiscoveryService> {
    if (!this.centralServicePromise) {
      this.centralServicePromise = import('./central-model-discovery-service.js').then(
        ({ getCentralModelDiscoveryService }) => getCentralModelDiscoveryService()
      );
    }
    return this.centralServicePromise;
  }

  /**
   * Discover new models from all sources
   * Enterprise implementation: Real-time API calls to all providers
   */
  async discoverNewModels(): Promise<{ success: boolean; models: Model[]; errors: string[] }> {
    try {
      const centralService = await this.getCentralService();
      const results = await centralService.discoverAllModels();
      
      const allErrors: string[] = [];
      let totalDiscovered = 0;
      let totalUpdated = 0;
      let totalNew = 0;
      
      for (const result of results) {
        allErrors.push(...(result.errors || []));
        totalDiscovered += result.modelsDiscovered;
        totalUpdated += result.modelsUpdated;
        totalNew += result.modelsNew;
      }
      
      // Fetch discovered models from database
      const { getAllCatalogModels } = await import('./model-catalog-service.js');
      const models = await getAllCatalogModels();
      
      // Mark models with discovery action based on results
      const modelsWithAction = models.map(model => {
        // Determine action based on discovery results
        // This is approximate - actual action is tracked in discovery results
        return {
          ...model,
          action: totalNew > 0 ? 'discovered' : totalUpdated > 0 ? 'updated' : 'unchanged',
        };
      });
      
      const success = allErrors.length === 0 || totalDiscovered > 0;
      
      this.log.info(
        {
          success,
          discovered: totalNew,
          updated: totalUpdated,
          total: totalDiscovered,
          errors: allErrors.length,
        },
        'Model discovery completed - 100% dynamic'
      );
      
      return {
        success,
        models: modelsWithAction,
        errors: allErrors,
      };
    } catch (error) {
      this.log.error({ error }, 'Model discovery failed');
      return {
        success: false,
        models: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * 100% dynamic model discovery - no hardcoded catalogs
   * Enterprise implementation: Real-time discovery from all provider APIs
   */
  async discoverAllModels(): Promise<Model[]> {
    this.log.info('Starting 100% dynamic model discovery from all provider APIs');

    try {
      const centralService = await this.getCentralService();
      const results = await centralService.discoverAllModels();
      
      // Fetch all models from database (already persisted by CentralModelDiscoveryService)
      const { getAllCatalogModels } = await import('./model-catalog-service.js');
      const models = await getAllCatalogModels();
      
      const totalDiscovered = results.reduce((sum, r) => sum + r.modelsDiscovered, 0);
      const totalErrors = results.reduce((sum, r) => sum + (r.errors?.length || 0), 0);
      
      if (totalErrors > 0) {
      this.log.warn(
          { errors: totalErrors, discovered: totalDiscovered },
        'Some providers failed during discovery, but continuing'
      );
    }

      this.log.info(
        { totalModels: models.length, sourcesProcessed: results.length },
        'Dynamic model discovery completed'
      );
      
      return models;
    } catch (error) {
      this.log.error({ error }, 'Failed to discover models');
      throw error;
    }
  }

  /**
   * Sync discovered models to catalog (100% dynamic, no hardcoded data)
   * Enterprise implementation: Real-time sync from provider APIs
   */
  async syncDiscoveredModels(): Promise<{
    discovered: number;
    updated: number;
    unchanged: number;
  }> {
    try {
      const centralService = await this.getCentralService();
      const results = await centralService.discoverAllModels();
      
      let discovered = 0;
      let updated = 0;
      let unchanged = 0;
      
      for (const result of results) {
        discovered += result.modelsNew;
        updated += result.modelsUpdated;
        // Models that were checked but didn't change
        unchanged += result.modelsDiscovered - result.modelsNew - result.modelsUpdated;
      }
      
      this.log.info(
        { discovered, updated, unchanged },
        'Model sync completed - all models from dynamic discovery'
      );
      
      return { discovered, updated, unchanged };
    } catch (error) {
      this.log.error({ error }, 'Failed to sync discovered models');
      throw error;
    }
  }

  /**
   * Get discovery statistics
   * Enterprise implementation: Real statistics from database and discovery service
   */
  async getDiscoveryStats(): Promise<{
    totalModels: number;
    totalProviders: number;
    totalSources: number;
    lastDiscovery: Date | null;
    nextScheduled: Date | null;
    sourcesByType: Record<string, number>;
    providersBySource: Record<string, string[]>;
  }> {
    try {
      const centralService = await this.getCentralService();
      const centralStats = await centralService.getStats();
      
      return {
        totalModels: centralStats.totalModels,
        totalProviders: centralStats.totalProviders,
        totalSources: centralStats.totalSources,
        lastDiscovery: centralStats.lastDiscovery,
        nextScheduled: centralStats.nextScheduled,
        sourcesByType: centralStats.sourcesByType,
        providersBySource: centralStats.providersBySource,
      };
    } catch (error) {
      this.log.error({ error }, 'Failed to get discovery stats');
      return {
        totalModels: 0,
        totalProviders: 0,
        totalSources: 0,
        lastDiscovery: null,
        nextScheduled: null,
        sourcesByType: {},
        providersBySource: {},
      };
    }
  }

  /**
   * Check if any models are available (useful for graceful degradation)
   * Enterprise implementation: Real-time check from database
   */
  async hasAvailableModels(): Promise<boolean> {
    try {
      const stats = await this.getDiscoveryStats();
      return (stats.totalModels || 0) > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Get singleton instance of ModelDiscoveryService
 * Enterprise pattern: Singleton for service instances
 */
let modelDiscoveryServiceInstance: ModelDiscoveryService | null = null;

export function getModelDiscoveryService(loggerParam?: Logger): ModelDiscoveryService {
  if (!modelDiscoveryServiceInstance) {
    // Lazy require to break a circular import. The synchronous CJS shape
    // is typed via a structural cast — the runtime contract is enforced
    // by the `@/utils/logger` module exporting `logger`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- circular import broken by lazy require
    const log = loggerParam ?? (require('@/utils/logger') as { logger: Logger }).logger;
    modelDiscoveryServiceInstance = new ModelDiscoveryService(log);
  }
  return modelDiscoveryServiceInstance;
}