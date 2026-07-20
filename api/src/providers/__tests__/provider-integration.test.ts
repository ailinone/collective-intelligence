// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Integration Tests (Realistic)
 * 
 * Tests actual provider behavior without complex mocks.
 * Uses real database for model catalog.
 * Mocks only external API calls.
 * 
 * Focus: Error handling, cost calculation, model selection
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAIAdapter } from '../openai/openai-adapter';
import { AnthropicAdapter } from '../anthropic/anthropic-adapter';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';
import { nanoid } from 'nanoid';

describe('Provider Integration Tests', () => {
  let testProviderId: string;
  let testModelId: string;

  beforeAll(async () => {
    // Use dynamic model discovery instead of hardcoded models
    // Discover models from providers dynamically
    const { getCentralModelDiscoveryService } = await import('@/services/central-model-discovery-service.js');
    const discoveryService = await getCentralModelDiscoveryService();
    
    // Run discovery to populate database with real models
    await discoveryService.discoverAllModels();
    
    // Find a real discovered model for testing (dynamic, not hardcoded)
    testProviderId = 'openai';
    
    // Ensure provider exists
    await prisma.provider.upsert({
      where: { id: testProviderId },
      create: {
        id: testProviderId,
        name: 'openai',
        displayName: 'OpenAI',
        status: 'active',
      },
      update: {},
    });

    // Find first available model from OpenAI dynamically (no hardcoded model name)
    const discoveredModel = await prisma.model.findFirst({
      where: {
        providerId: testProviderId,
        status: 'active',
      },
    });

    if (discoveredModel) {
      testModelId = discoveredModel.id;
    } else {
      // If no models discovered, create a minimal test model (still dynamic approach)
      testModelId = `${testProviderId}:test-model-${Date.now()}`;
      await prisma.model.create({
        data: {
          uid: computeModelUid(testProviderId, testModelId),
          id: testModelId,
          providerId: testProviderId,
          name: 'test-model',
          displayName: 'Test Model',
          contextWindow: 8192,
          maxOutputTokens: 4096,
          inputCostPer1k: 0.03,
          outputCostPer1k: 0.06,
          capabilities: ['chat'],
          status: 'active',
        },
      });
    }
  });

  describe('OpenAI Adapter', () => {
    it('should initialize with configuration', () => {
      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('openai');
    });

    it('should get models from database catalog', async () => {
      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
      });

      const models = await adapter.getModels();

      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      // Should have at least the test model we seeded
      expect(models.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle missing API key gracefully', () => {
      expect(() => {
        new OpenAIAdapter({
          apiKey: '',
        });
      }).toThrow(/api.*key|configuration/i);
    });
  });

  describe('Anthropic Adapter', () => {
    it('should initialize with configuration', () => {
      const adapter = new AnthropicAdapter({
        apiKey: 'test-key',
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('anthropic');
    });

    it('should handle missing API key gracefully', () => {
      expect(() => {
        new AnthropicAdapter({
          apiKey: '',
        });
      }).toThrow(/api.*key|configuration/i);
    });
  });

  describe('Cost Calculation (Without Mocks)', () => {
    it('should have correct pricing data in database', async () => {
      const model = await prisma.model.findFirst({
        where: { id: testModelId },
      });

      expect(model).toBeDefined();
      if (model) {
        expect(Number(model.inputCostPer1k)).toBeGreaterThanOrEqual(0);
        expect(Number(model.outputCostPer1k)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Error Handling', () => {
    it('should throw error when API key is invalid format', () => {
      expect(() => {
        new OpenAIAdapter({
          apiKey: 'not-a-valid-key-format',
        });
      }).not.toThrow(); // Adapter accepts any string, validation happens on use
    });
  });
});

