// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { providerPluginManager, type ProviderPlugin, type ProviderConfig } from '@/providers/provider-plugin-system';
import { modelAutoDiscovery } from '@/services/model-discovery-service';
import { ProviderRegistry, setProviderRegistry, getProviderRegistry } from '@/providers/provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

const discoverNewModelsMock = vi.hoisted(() => vi.fn());

// Mock dependencies
vi.mock('@/services/model-discovery-service', async () => {
  const actual = await vi.importActual<typeof import('@/services/model-discovery-service')>('@/services/model-discovery-service');
  const discovery = {
    discoverNewModels: discoverNewModelsMock,
  };
  return {
    ...actual,
    getModelAutoDiscovery: vi.fn(() => discovery),
    modelAutoDiscovery: discovery,
  };
});

// Mock plugin for testing
class MockProviderPlugin implements ProviderPlugin {
  name = 'mock-provider';
  version = '1.0.0';
  description = 'Mock provider for testing';

  private initialized = false;

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('API key required');
    }
    this.initialized = true;
  }

  async listModels() {
    if (!this.initialized) throw new Error('Not initialized');
    return [
      {
        id: 'mock-model-1',
        name: 'Mock Model 1',
        contextWindow: 4096,
        maxOutputTokens: 2048,
        capabilities: ['chat'],
        pricing: { inputCostPer1M: 1.0, outputCostPer1M: 2.0 },
      },
    ];
  }

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  getAdapter(): ProviderAdapter {
    const name = this.name;
    return {
      getName: () => name,
      getDisplayName: () => name,
      getProvider: vi.fn(),
      getModels: vi.fn(() => this.listModels()),
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as ProviderAdapter;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }
}

describe('ProviderPluginSystem', () => {
  beforeAll(async () => {
    await startTestEnvironment();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set environment variable for config
    process.env.MOCK_PROVIDER_API_KEY = 'test-api-key';

    // Reset provider registry singleton
    setProviderRegistry(new ProviderRegistry());
  });

  afterEach(async () => {
    const registered = providerPluginManager.listPlugins();
    await Promise.all(
      registered.map(plugin => providerPluginManager.unregisterPlugin(plugin.name).catch(() => false))
    );
  });

  describe('registerPlugin', () => {
    it('should register a valid plugin successfully', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 1,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [{ id: 'mock-model-1', provider: 'mock-provider', action: 'discovered' }],
      });

      // Execute
      const result = await providerPluginManager.registerPlugin(plugin);

      // Verify
      expect(result.success).toBe(true);
      expect(result.pluginName).toBe('mock-provider');
      expect(result.modelsDiscovered).toBe(1);
      
      // Should have called provider registry
      const registry = getProviderRegistry();
      expect(registry.has('mock-provider')).toBe(true);
      
      // Should have triggered discovery
      expect(modelAutoDiscovery.discoverNewModels).toHaveBeenCalled();
    });

    it('should fail if plugin is invalid', async () => {
      // Setup - invalid plugin (missing required method)
      const invalidPlugin: Partial<ProviderPlugin> = {
        name: 'invalid',
        version: '1.0.0',
        initialize: vi.fn(),
        listModels: vi.fn(),
        // Missing healthCheck and getAdapter
      };

      // Execute
      const result = await providerPluginManager.registerPlugin(invalidPlugin);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toContain('must implement');
    });

    it('should fail if health check fails', async () => {
      // Setup
      const unhealthyPlugin = new MockProviderPlugin();
      vi.spyOn(unhealthyPlugin, 'healthCheck').mockResolvedValue(false);

      // Execute
      const result = await providerPluginManager.registerPlugin(unhealthyPlugin);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toContain('health check failed');
    });

    it('should handle initialization errors', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      vi.spyOn(plugin, 'initialize').mockRejectedValue(new Error('Init failed'));

      // Execute
      const result = await providerPluginManager.registerPlugin(plugin);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toContain('Init failed');
    });
  });

  describe('unregisterPlugin', () => {
    it('should unregister a plugin successfully', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 1,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      await providerPluginManager.registerPlugin(plugin);

      // Execute
      const result = await providerPluginManager.unregisterPlugin('mock-provider');

      // Verify
      expect(result).toBe(true);
      expect(await plugin.healthCheck()).toBe(false);
    });

    it('should return false if plugin not found', async () => {
      // Execute
      const result = await providerPluginManager.unregisterPlugin('non-existent');

      // Verify
      expect(result).toBe(false);
    });
  });

  describe('getPlugin', () => {
    it('should return registered plugin', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 0,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      await providerPluginManager.registerPlugin(plugin);

      // Execute
      const retrieved = providerPluginManager.getPlugin('mock-provider');

      // Verify
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('mock-provider');
    });

    it('should return undefined if plugin not registered', () => {
      // Execute
      const result = providerPluginManager.getPlugin('non-existent');

      // Verify
      expect(result).toBeUndefined();
    });
  });

  describe('listPlugins', () => {
    it('should list all registered plugins', async () => {
      // Setup
      const plugin1 = new MockProviderPlugin();
      const plugin2 = Object.assign(new MockProviderPlugin(), { name: 'mock-provider-2' });
      
      // Set API key for second plugin
      process.env.MOCK_PROVIDER_2_API_KEY = 'test-api-key-2';
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 0,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      await providerPluginManager.registerPlugin(plugin1);
      await providerPluginManager.registerPlugin(plugin2);

      // Execute
      const plugins = providerPluginManager.listPlugins();

      // Verify
      expect(plugins.length).toBeGreaterThanOrEqual(1);
      expect(plugins.some(p => p.name === 'mock-provider' || p.name === 'mock-provider-2')).toBe(true);
    });
  });

  describe('healthCheckAll', () => {
    it('should check health of all plugins', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 0,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      await providerPluginManager.registerPlugin(plugin);

      // Execute
      const health = await providerPluginManager.healthCheckAll();

      // Verify
      expect(health).toBeDefined();
      expect(health['mock-provider']).toBe(true);
    });

    it('should handle unhealthy plugins', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 0,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      // Register plugin (will be healthy initially)
      await providerPluginManager.registerPlugin(plugin);

      // Make plugin unhealthy AFTER registration
      vi.spyOn(plugin, 'healthCheck').mockResolvedValue(false);

      // Execute
      const health = await providerPluginManager.healthCheckAll();

      // Verify
      expect(health['mock-provider']).toBe(false);
    });
  });

  describe('getPluginStats', () => {
    it('should return statistics for all plugins', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 0,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      await providerPluginManager.registerPlugin(plugin);

      // Execute
      const stats = await providerPluginManager.getPluginStats();

      // Verify
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.plugins).toBeDefined();
      expect(stats.plugins.length).toBeGreaterThan(0);
      
      const mockPlugin = stats.plugins.find(p => p.name === 'mock-provider');
      expect(mockPlugin).toBeDefined();
      expect(mockPlugin?.healthy).toBe(true);
      expect(mockPlugin?.modelsCount).toBe(1);
    });
  });

  describe('reloadPlugin', () => {
    it('should reload a plugin successfully', async () => {
      // Setup
      const plugin = new MockProviderPlugin();
      const initSpy = vi.spyOn(plugin, 'initialize');
      
      vi.mocked(modelAutoDiscovery.discoverNewModels).mockResolvedValue({
        discovered: 0,
        updated: 0,
        failed: 0,
        providers: 1,
        models: [],
      });

      await providerPluginManager.registerPlugin(plugin);

      // Execute
      const result = await providerPluginManager.reloadPlugin('mock-provider');

      // Verify
      expect(result).toBe(true);
      expect(initSpy).toHaveBeenCalledTimes(2); // Once in register, once in reload
    });

    it('should return false if plugin not found', async () => {
      // Execute
      const result = await providerPluginManager.reloadPlugin('non-existent');

      // Verify
      expect(result).toBe(false);
    });
  });
});

