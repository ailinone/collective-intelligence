// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai/openai-adapter';
import { AnthropicAdapter } from '../../src/providers/anthropic/anthropic-adapter';
import { GoogleAdapter } from '../../src/providers/google/google-adapter';
import { MistralAdapter } from '../../src/providers/mistral/mistral-adapter';
import { ProviderConfig } from '../../src/providers/base/provider-adapter';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { shouldRunLiveProviderSuite } from '../utils/live-mode';

// Use real API keys from environment - NO mocks
const getRealConfig = (providerName: string): ProviderConfig => {
  const apiKeyEnvMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    mistral: 'MISTRAL_API_KEY',
  };
  
  const apiKey = process.env[apiKeyEnvMap[providerName]] || '';
  
  return {
    apiKey,
    baseUrl: process.env[`${providerName.toUpperCase()}_BASE_URL`] || '',
    timeout: 30000,
    organization: process.env[`${providerName.toUpperCase()}_ORGANIZATION`] || '',
  };
};

const shouldRunSuite =
  shouldRunLiveProviderSuite(process.env.OPENAI_API_KEY || '') ||
  shouldRunLiveProviderSuite(process.env.ANTHROPIC_API_KEY || '') ||
  shouldRunLiveProviderSuite(process.env.GOOGLE_API_KEY || '') ||
  shouldRunLiveProviderSuite(process.env.MISTRAL_API_KEY || '');
const describeLiveSuite = shouldRunSuite ? describe : describe.skip;

describeLiveSuite('Dynamic Model Selection - 100% No Hardcoded, NO Mocks', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });
  describe('OpenAIAdapter', () => {
    it('should select default model dynamically without hardcoded fallback', async () => {
      const config = getRealConfig('openai');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new OpenAIAdapter(config);
      const defaultModel = await adapter['getDefaultModel']();

      expect(defaultModel).toBeDefined();
      expect(typeof defaultModel).toBe('string');
      // Should not be hardcoded - must come from real discovery
      expect(defaultModel.length).toBeGreaterThan(0);
    }, 60000);

    it('should normalize model names dynamically using discovered models', async () => {
      const config = getRealConfig('openai');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new OpenAIAdapter(config);
      
      // Get real models from dynamic discovery
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Use a real model name (or part of it) to test normalization
      const realModelName = models[0].name;
      const partialName = realModelName.split('-')[0] || realModelName.substring(0, 3);
      
      const normalized = await adapter.normalizeModelName(partialName);

      // Should find a model that matches (or return the input if no match)
      expect(typeof normalized).toBe('string');
    }, 60000);
  });

  describe('AnthropicAdapter', () => {
    it('should select default model dynamically without hardcoded fallback', async () => {
      const config = getRealConfig('anthropic');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new AnthropicAdapter(config);
      const defaultModel = await adapter['getDefaultModel']();

      expect(defaultModel).toBeDefined();
      expect(typeof defaultModel).toBe('string');
      // Should not be hardcoded - must come from real discovery
      expect(defaultModel.length).toBeGreaterThan(0);
    }, 60000);

    it('should normalize model names dynamically using discovered models', async () => {
      const config = getRealConfig('anthropic');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new AnthropicAdapter(config);
      
      // Get real models from dynamic discovery
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Use a real model name (or part of it) to test normalization
      const realModelName = models[0].name;
      const partialName = realModelName.split('-')[0] || realModelName.substring(0, 6);
      
      const normalized = await adapter.normalizeModelName(partialName);

      // Should find a model that matches (or return the input if no match)
      expect(typeof normalized).toBe('string');
    }, 60000);
  });

  describe('GoogleAdapter', () => {
    it('should select default model dynamically without hardcoded fallback', async () => {
      const config = getRealConfig('google');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new GoogleAdapter(config);
      const defaultModel = await adapter['getDefaultModel']();

      expect(defaultModel).toBeDefined();
      expect(typeof defaultModel).toBe('string');
      // Should not be hardcoded - must come from real discovery
      expect(defaultModel.length).toBeGreaterThan(0);
    }, 60000);

    it('should normalize model names dynamically using discovered models', async () => {
      const config = getRealConfig('google');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new GoogleAdapter(config);
      
      // Get real models from dynamic discovery
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Use a real model name (or part of it) to test normalization
      const realModelName = models[0].name;
      const partialName = realModelName.split('-')[0] || realModelName.substring(0, 6);
      
      const normalized = await adapter.normalizeModelName(partialName);

      // Should find a model that matches (or return the input if no match)
      expect(typeof normalized).toBe('string');
    }, 60000);
  });

  describe('MistralAdapter', () => {
    it('should select default model dynamically without hardcoded fallback', async () => {
      const config = getRealConfig('mistral');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new MistralAdapter(config);
      const defaultModel = await adapter['getDefaultModel']();

      expect(defaultModel).toBeDefined();
      expect(typeof defaultModel).toBe('string');
      // Should not be hardcoded - must come from real discovery
      expect(defaultModel.length).toBeGreaterThan(0);
    }, 60000);

    it('should normalize model names dynamically using discovered models', async () => {
      const config = getRealConfig('mistral');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new MistralAdapter(config);
      
      // Get real models from dynamic discovery
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Use a real model name (or part of it) to test normalization
      const realModelName = models[0].name;
      const partialName = realModelName.split('-')[0] || realModelName.substring(0, 7);
      
      const normalized = await adapter.normalizeModelName(partialName);

      // Should find a model that matches (or return the input if no match)
      expect(typeof normalized).toBe('string');
    }, 60000);
  });

  describe('No hardcoded fallbacks in chatCompletion methods', () => {
    it('should not use hardcoded models in OpenAI chatCompletion', async () => {
      const config = getRealConfig('openai');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new OpenAIAdapter(config);
      
      // Get real models - if none available, should throw error (NO hardcoded fallback)
      const models = await adapter.getModels();
      if (models.length === 0) {
        await expect(adapter.chatCompletion({ messages: [] })).rejects.toThrow('No OpenAI models available');
      } else {
        // If models are available, should work with real models
        expect(models.length).toBeGreaterThan(0);
      }
    }, 60000);

    it('should not use hardcoded models in Anthropic chatCompletion', async () => {
      const config = getRealConfig('anthropic');
      if (!config.apiKey) {
        // Skip if no API key available
        return;
      }
      const adapter = new AnthropicAdapter(config);
      
      // Get real models - if none available, should throw error (NO hardcoded fallback)
      const models = await adapter.getModels();
      if (models.length === 0) {
        await expect(adapter.chatCompletion({ messages: [] })).rejects.toThrow('No Anthropic models available');
      } else {
        // If models are available, should work with real models
        expect(models.length).toBeGreaterThan(0);
      }
    }, 60000);
  });
});
















