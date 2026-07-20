// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import { getModelAutoDiscovery } from '@/services/model-discovery-service';
import type { ProviderAdapter } from './base/provider-adapter';

/**
 * Provider configuration
 */
export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  [key: string]: unknown;
}

/**
 * Provider model structure from provider API
 */
export interface ProviderModel {
  id: string;
  name: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: string[];
  pricing: {
    inputCostPer1M: number;
    outputCostPer1M: number;
    currency?: string;
  };
}

/**
 * Usage statistics from provider
 */
export interface UsageStats {
  requests: number;
  tokens: number;
  cost: number;
}

/**
 * Provider Plugin Interface
 * Implement this to add a new LLM provider
 */
export interface ProviderPlugin {
  // Metadata
  name: string;
  version: string;
  description?: string;

  // Required methods
  initialize(config: ProviderConfig): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  healthCheck(): Promise<boolean>;

  // Adapter (implements ProviderAdapter interface)
  getAdapter(): ProviderAdapter;

  // Optional methods
  getUsage?(): Promise<UsageStats>;
  shutdown?(): Promise<void>;
}

/**
 * Result of plugin registration
 */
export interface PluginRegistrationResult {
  success: boolean;
  pluginName: string;
  modelsDiscovered: number;
  error?: string;
}

/**
 * Provider Plugin Manager
 * Manages registration and lifecycle of provider plugins
 */
class ProviderPluginManager {
  private plugins: Map<string, ProviderPlugin> = new Map();
  private log = logger.child({ component: 'plugin-manager' });
  private modelAutoDiscovery = getModelAutoDiscovery(this.log);

  /**
   * Register new provider plugin
   */
  async registerPlugin(plugin: ProviderPlugin): Promise<PluginRegistrationResult> {
    try {
      this.log.info(
        { plugin: plugin.name, version: plugin.version },
        'Registering provider plugin'
      );

      // 1. Validate plugin structure
      this.validatePlugin(plugin);

      // 2. Get configuration for this provider
      const config = this.getProviderConfig(plugin.name);

      // 3. Initialize plugin
      await plugin.initialize(config);

      // 4. Probe health — but DO NOT gate registration on the result.
      //
      // Architectural rationale (2026-05-05): the boot-time health probe is a
      // 5-second network round-trip. In the cold-DNS / cold-TCP / cold-TLS
      // window of container start (especially WSL2 Docker), the false-failure
      // rate is high enough that fail-closed registration permanently silences
      // working providers. Industry-standard pattern (k8s readiness, Envoy
      // outlier detection) is: register first, mark health observably, retry
      // on use. Persistent failures are caught by the request-time circuit
      // breaker, not by the boot probe.
      let healthy = false;
      let healthError: unknown = undefined;
      try {
        healthy = await plugin.healthCheck();
      } catch (err) {
        healthError = err;
      }

      // 5. Register in provider registry regardless of health result. Dynamic
      //    import avoids circular dependency.
      const { getProviderRegistry } = await import('./provider-registry.js');
      const registry = getProviderRegistry();
      const adapter = plugin.getAdapter();
      registry.register(adapter);

      // 6. Store plugin reference
      this.plugins.set(plugin.name, plugin);

      // 6b. Mark availability so /providers diagnostics reflect reality.
      //     - healthy → 'available'
      //     - unhealthy/threw → 'degraded' (registered, but boot probe failed;
      //       request-time circuit breaker decides whether to actually use it)
      try {
        const { providerAvailabilityService } = await import(
          '@/services/provider-availability-service'
        );
        if (healthy) {
          providerAvailabilityService.markAvailable(plugin.name);
        } else {
          const reason =
            healthError instanceof Error
              ? `health-check failed at boot: ${healthError.message}`
              : 'health-check failed at boot (no detail)';
          providerAvailabilityService.markDegraded(plugin.name, reason);
        }
      } catch {
        // Availability service is best-effort; don't block registration.
      }

      if (healthy) {
        this.log.info(
          { plugin: plugin.name, version: plugin.version },
          'Provider plugin registered successfully'
        );
      } else {
        // Extract diagnosable detail — Error objects don't JSON-serialize by
        // default, which produces the `error: {}` log entries we hunted.
        const detail =
          healthError instanceof Error
            ? { message: healthError.message, name: healthError.name }
            : { message: String(healthError ?? 'health probe returned false') };
        this.log.warn(
          {
            plugin: plugin.name,
            version: plugin.version,
            healthError: detail,
          },
          'Provider plugin registered (degraded) — boot health probe failed; will retry on first use'
        );
      }

      // 7. Auto-discover models from new provider
      const discoveryResult = await this.discoverProviderModels(plugin);

      return {
        success: true,
        pluginName: plugin.name,
        modelsDiscovered: discoveryResult.discovered,
      };
    } catch (error) {
      // Real failures (validation, initialize, registry.register throws) still
      // count as registration failures. We diagnose the Error explicitly here
      // so the log entry is not the empty `error: {}` that bit us before.
      const detail =
        error instanceof Error
          ? { message: error.message, name: error.name, stack: error.stack }
          : { message: String(error) };
      this.log.error(
        { errorDetail: detail, plugin: plugin.name },
        'Failed to register provider plugin'
      );

      return {
        success: false,
        pluginName: plugin.name,
        modelsDiscovered: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Unregister provider plugin
   */
  async unregisterPlugin(pluginName: string): Promise<boolean> {
    try {
      const plugin = this.plugins.get(pluginName);
      if (!plugin) {
        this.log.warn({ plugin: pluginName }, 'Plugin not found');
        return false;
      }

      // Shutdown plugin if supported
      if (plugin.shutdown) {
        await plugin.shutdown();
      }

      // Remove adapter from provider registry
      const { getProviderRegistry } = await import('./provider-registry.js');
      const registry = getProviderRegistry();
      const adapter = plugin.getAdapter();
      const adapterName = adapter.getName();
      registry.unregister(adapterName);

      // Remove from plugins map
      this.plugins.delete(pluginName);

      this.log.info({ plugin: pluginName }, 'Provider plugin unregistered');
      return true;
    } catch (error) {
      this.log.error({ error, plugin: pluginName }, 'Failed to unregister plugin');
      return false;
    }
  }

  /**
   * Get registered plugin
   */
  getPlugin(pluginName: string): ProviderPlugin | undefined {
    return this.plugins.get(pluginName);
  }

  /**
   * List all registered plugins
   */
  listPlugins(): Array<{ name: string; version: string; description?: string }> {
    return Array.from(this.plugins.values()).map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
    }));
  }

  /**
   * Validate plugin structure
   */
  private validatePlugin(plugin: ProviderPlugin): void {
    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new Error('Plugin must have a name');
    }

    if (!plugin.version || typeof plugin.version !== 'string') {
      throw new Error('Plugin must have a version');
    }

    // Check required methods
    const _requiredMethods = ['initialize', 'listModels', 'healthCheck', 'getAdapter'];

    // Type guard for plugin methods - type-safe validation
    if (typeof plugin !== 'object' || plugin === null) {
      throw new Error('Plugin must be an object');
    }

    // Validate each required method individually with type safety
    if (typeof plugin.initialize !== 'function') {
      throw new Error('Plugin must implement initialize() method');
    }
    
    if (typeof plugin.listModels !== 'function') {
      throw new Error('Plugin must implement listModels() method');
    }
    
    if (typeof plugin.healthCheck !== 'function') {
      throw new Error('Plugin must implement healthCheck() method');
    }
    
    if (typeof plugin.getAdapter !== 'function') {
      throw new Error('Plugin must implement getAdapter() method');
    }

    this.log.debug({ plugin: plugin.name }, 'Plugin validation passed');
  }

  /**
   * Get provider configuration from environment
   */
  private getProviderConfig(providerName: string): ProviderConfig {
    const envPrefix = providerName.toUpperCase().replace(/-/g, '_');

    const config: ProviderConfig = {
      apiKey: process.env[`${envPrefix}_API_KEY`] || '',
      baseURL: process.env[`${envPrefix}_BASE_URL`],
      timeout: parseInt(process.env[`${envPrefix}_TIMEOUT`] || '60000'),
      maxRetries: parseInt(process.env[`${envPrefix}_MAX_RETRIES`] || '3'),
    };

    // Validate required config
    if (!config.apiKey) {
      this.log.warn({ provider: providerName }, 'API key not configured');
    }

    return config;
  }

  /**
   * Discover models from newly registered provider
   */
  private async discoverProviderModels(plugin: ProviderPlugin): Promise<{ discovered: number }> {
    // Boot-time fast-path: skip per-plugin discovery when the periodic runner is the
    // authoritative source. With ~99 catalog plugins, each registration would otherwise
    // trigger a full `centralService.discoverAllModels()` cycle (via discoverNewModels →
    // central), saturating the event loop and blocking HTTP bind.
    if (process.env.SKIP_PER_PLUGIN_DISCOVERY === 'true') {
      this.log.debug(
        { plugin: plugin.name },
        'Per-plugin discovery skipped (SKIP_PER_PLUGIN_DISCOVERY=true)'
      );
      return { discovered: 0 };
    }
    try {
      this.log.info({ plugin: plugin.name }, 'Discovering models from new provider');

      // Run discovery for this specific provider
      const result = await this.modelAutoDiscovery.discoverNewModels();

      // Filter to only this provider's discoveries
      interface DiscoveryModel {
        provider?: string;
        action?: string;
      }
      const providerDiscoveries = result.models.filter(
        (m: DiscoveryModel) => m.provider === plugin.name && m.action === 'discovered'
      );

      this.log.info(
        { plugin: plugin.name, discovered: providerDiscoveries.length },
        'Models discovered from new provider'
      );

      return { discovered: providerDiscoveries.length };
    } catch (error) {
      this.log.error({ error, plugin: plugin.name }, 'Failed to discover models from provider');
      return { discovered: 0 };
    }
  }

  /**
   * Health check all registered plugins
   */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, plugin] of this.plugins) {
      try {
        const healthy = await plugin.healthCheck();
        results[name] = healthy;
      } catch (error) {
        this.log.error({ error, plugin: name }, 'Plugin health check failed');
        results[name] = false;
      }
    }

    return results;
  }

  /**
   * Get plugin statistics
   */
  async getPluginStats(): Promise<{
    total: number;
    plugins: Array<{
      name: string;
      version: string;
      healthy: boolean;
      modelsCount: number;
    }>;
  }> {
    const stats: Array<{
      name: string;
      version: string;
      healthy: boolean;
      modelsCount: number;
    }> = [];

    for (const plugin of this.plugins.values()) {
      try {
        const healthy = await plugin.healthCheck();
        const models = await plugin.listModels();

        stats.push({
          name: plugin.name,
          version: plugin.version,
          healthy,
          modelsCount: models.length,
        });
      } catch (error) {
        this.log.error({ error, plugin: plugin.name }, 'Failed to get plugin stats');

        stats.push({
          name: plugin.name,
          version: plugin.version,
          healthy: false,
          modelsCount: 0,
        });
      }
    }

    return {
      total: this.plugins.size,
      plugins: stats,
    };
  }

  /**
   * Reload plugin (useful for config updates)
   */
  async reloadPlugin(pluginName: string): Promise<boolean> {
    try {
      const plugin = this.plugins.get(pluginName);
      if (!plugin) {
        return false;
      }

      this.log.info({ plugin: pluginName }, 'Reloading plugin');

      // Shutdown if supported
      if (plugin.shutdown) {
        await plugin.shutdown();
      }

      // Re-initialize with fresh config
      const config = this.getProviderConfig(pluginName);
      await plugin.initialize(config);

      // Verify health
      const healthy = await plugin.healthCheck();
      if (!healthy) {
        throw new Error('Health check failed after reload');
      }

      this.log.info({ plugin: pluginName }, 'Plugin reloaded successfully');
      return true;
    } catch (error) {
      this.log.error({ error, plugin: pluginName }, 'Failed to reload plugin');
      return false;
    }
  }
}

// Export singleton instance
export const providerPluginManager = new ProviderPluginManager();
