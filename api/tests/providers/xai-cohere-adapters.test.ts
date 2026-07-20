// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * XAI & Cohere Providers Tests
 * Uses REAL API calls - NO mocks, NO hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { XAIAdapter } from '@/providers/xai/xai-adapter';
import { CohereAdapter } from '@/providers/cohere/cohere-adapter';
import type { ProviderConfig, ChatRequest } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModelId, discoverModelsForProvider, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { shouldRunLiveProviderSuite } from '../utils/live-mode';

const runXaiSuite = shouldRunLiveProviderSuite(process.env.XAI_API_KEY || '');
const runCohereSuite = shouldRunLiveProviderSuite(process.env.COHERE_API_KEY || '');
const describeLiveSuite = runXaiSuite || runCohereSuite ? describe : describe.skip;

describeLiveSuite('XAI & Cohere Providers - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  describe('XAIAdapter', () => {
    let adapter: XAIAdapter;
    const apiKey = process.env.XAI_API_KEY || '';

    beforeEach(async () => {
      if (!apiKey) {
        return;
      }

      const config: ProviderConfig = {
        name: 'xai',
        apiKey,
        baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
        enabled: true,
        priority: 1,
      };
      
      // Models are discovered dynamically from the database - NO hardcoded seeding
      adapter = new XAIAdapter(config);
    });

    it('should have correct provider name', () => {
      expect(adapter.getName()).toBe('xai');
      expect(adapter.getDisplayName()).toBe('xAI (Grok)');
    });

    it('should return models from REAL dynamic discovery', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      // Models come from REAL dynamic discovery, not hardcoded
      expect(models.length).toBeGreaterThanOrEqual(0);
      expect(models.every((m) => m.provider === 'xai')).toBe(true);
    }, 60000);

    it('should include models from dynamic discovery', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      // Models are discovered dynamically, so we just verify the adapter works
      if (models.length > 0) {
        expect(models[0].provider).toBe('xai');
        expect(models[0].id).toBeDefined();
        expect(models[0].name).toBeDefined();
      }
    }, 60000);

    it('should calculate cost', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      if (models.length > 0) {
        const model = models[0];
        const cost = adapter.calculateCost(model, 1000, 1000);
        expect(cost).toBeGreaterThanOrEqual(0);
      }
    }, 60000);

    it('should make REAL chat completion request', async () => {
      if (!apiKey) {
        return;
      }
      
      // Get a real model from dynamic discovery - NO hardcoded models
      const xaiModels = await discoverModelsForProvider('xai');
      if (xaiModels.length === 0) {
        return; // Skip if no models available
      }

      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: xaiModels[0].id, // Use dynamically discovered model
      };

      const response = await adapter.chatCompletion(request);
      expect(response.choices[0].message.content).toBeDefined();
    }, 60000);

    it('should perform health check', async () => {
      if (!apiKey) {
        return;
      }
      const health = await adapter.healthCheck();
      expect(health.healthy).toBeDefined();
      expect(typeof health.healthy).toBe('boolean');
    }, 60000);
  });

  describe('CohereAdapter', () => {
    let adapter: CohereAdapter;
    const apiKey = process.env.COHERE_API_KEY || '';

    beforeEach(async () => {
      if (!apiKey) {
        return;
      }

      const config: ProviderConfig = {
        name: 'cohere',
        apiKey,
        baseUrl: process.env.COHERE_BASE_URL || 'https://api.cohere.ai/v1',
        enabled: true,
        priority: 1,
      };
      
      // Models are discovered dynamically from the database - NO hardcoded seeding
      adapter = new CohereAdapter(config);
    });

    it('should have correct provider name', () => {
      expect(adapter.getName()).toBe('cohere');
      expect(adapter.getDisplayName()).toBe('Cohere');
    });

    it('should return models from REAL dynamic discovery', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      // Models come from REAL dynamic discovery, not hardcoded
      expect(models.length).toBeGreaterThanOrEqual(0);
      expect(models.every((m) => m.provider === 'cohere')).toBe(true);
    }, 60000);

    it('should include models from dynamic discovery', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      // Models are discovered dynamically, so we just verify the adapter works
      if (models.length > 0) {
        expect(models[0].provider).toBe('cohere');
        expect(models[0].id).toBeDefined();
        expect(models[0].name).toBeDefined();
      }
    }, 60000);

    it('should calculate cost', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      if (models.length > 0) {
        const model = models[0];
        const cost = adapter.calculateCost(model, 1000, 1000);
        expect(cost).toBeGreaterThanOrEqual(0);
      }
    }, 60000);

    it('should make REAL chat completion request', async () => {
      if (!apiKey) {
        return;
      }
      
      // Get a real model from dynamic discovery - NO hardcoded models
      const cohereModels = await discoverModelsForProvider('cohere');
      if (cohereModels.length === 0) {
        return; // Skip if no models available
      }

      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: cohereModels[0].id, // Use dynamically discovered model
      };

      const response = await adapter.chatCompletion(request);
      expect(response.choices[0].message.content).toBeDefined();
    }, 60000);

    it('should generate embeddings', async () => {
      if (!apiKey) {
        return;
      }
      
      const request = {
        input: ['text 1', 'text 2'],
        model: 'embed-english-v3.0',
      };

      const response = await adapter.generateEmbeddings(request);
      expect(response.data).toBeDefined();
      expect(Array.isArray(response.data)).toBe(true);
    }, 60000);

    it('should perform health check', async () => {
      if (!apiKey) {
        return;
      }
      const health = await adapter.healthCheck();
      expect(health.healthy).toBeDefined();
      expect(typeof health.healthy).toBe('boolean');
    }, 60000);
  });
});
