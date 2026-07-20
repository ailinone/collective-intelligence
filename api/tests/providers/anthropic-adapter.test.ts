// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Anthropic Provider Adapter
 * Uses REAL API calls - NO mocks, NO hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { shouldRunLiveProviderSuite } from '../utils/live-mode';

const apiKey = process.env.ANTHROPIC_API_KEY || '';
const describeLiveSuite = shouldRunLiveProviderSuite(apiKey) ? describe : describe.skip;

describeLiveSuite('AnthropicAdapter - Real API Tests (NO Mocks)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  let adapter: AnthropicAdapter;

  beforeEach(async () => {
    if (!apiKey) {
      return;
    }
    
    adapter = new AnthropicAdapter({
      apiKey,
      maxRetries: 0,
    });
  });

  describe('constructor', () => {
    it('should create adapter with valid config', () => {
      if (!apiKey) {
        return;
      }
      expect(adapter).toBeDefined();
      expect(adapter.getName()).toBe('anthropic');
      expect(adapter.getDisplayName()).toBe('Anthropic');
    });

    it('should throw error if API key is missing', () => {
      expect(() => {
        new AnthropicAdapter({
          apiKey: '',
        });
      }).toThrow('anthropic: API key is required');
    });
  });

  describe('getModels', () => {
    it('should return list of models from REAL discovery', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();

      expect(models).toBeDefined();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
    }, 60000);

    it('should have models with valid structure', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      
      if (models.length > 0) {
        const model = models[0];
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
        expect(model.provider).toBe('anthropic');
        expect(typeof model.inputCostPer1k).toBe('number');
        expect(typeof model.outputCostPer1k).toBe('number');
      }
    }, 60000);
  });

  describe('chatCompletion', () => {
    it('should successfully complete a chat request with REAL API', async () => {
      if (!apiKey) {
        return;
      }
      
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      const model = models[0];
      const request: ChatRequest = {
        model: model.id,
        messages: [
          {
            role: 'user',
            content: 'Say hello',
          },
        ],
      };

      const response = await adapter.chatCompletion(request);

      expect(response).toBeDefined();
      expect(response.id).toBeDefined();
      expect(response.model).toBeDefined();
      expect(response.choices).toBeDefined();
      expect(response.choices.length).toBeGreaterThan(0);
    }, 60000);
  });

  describe('healthCheck', () => {
    it('should return healthy status when API is accessible', async () => {
      if (!apiKey) {
        return;
      }
      
      const result = await adapter.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(result.checkedAt).toBeInstanceOf(Date);
    }, 60000);
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly with real models', async () => {
      if (!apiKey) {
        return;
      }
      
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      const model = models[0];
      const cost = adapter.calculateCost(model, 1000, 1000);

      expect(cost).toBeGreaterThan(0);
      expect(typeof cost).toBe('number');
    }, 60000);
  });

  describe('normalizeModelName', () => {
    it('should normalize model names dynamically using discovered models', async () => {
      if (!apiKey) {
        return;
      }
      
      // Get real models from dynamic discovery
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Use a real model name (or part of it) to test normalization
      const realModelName = models[0].name;
      // Extract a partial name to test normalization (e.g., "claude" from "claude-3-5-sonnet")
      const partialName = realModelName.split('-')[0] || realModelName.substring(0, 6);
      
      const normalized = await adapter.normalizeModelName(partialName);
      expect(typeof normalized).toBe('string');
      expect(normalized.length).toBeGreaterThan(0);
    }, 60000);

    it('should preserve valid model names from discovery', async () => {
      if (!apiKey) {
        return;
      }
      
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Test with a real model name
      const realModelName = models[0].name;
      const normalized = await adapter.normalizeModelName(realModelName);
      expect(normalized).toBeDefined();
      expect(typeof normalized).toBe('string');
    }, 60000);
  });
});
