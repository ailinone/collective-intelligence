// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests for Google Gemini Adapter
 * 
 * These tests make REAL API calls to Google Gemini API to validate actual system behavior.
 * Requires TEST_USE_REAL_API_KEYS=true and valid GCP Secrets configuration.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import type { ChatRequest } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { config } from '@/config';

const googleApiKey = process.env.GOOGLE_API_KEY || '';
const shouldRunLiveTests =
  process.env.TEST_USE_REAL_API_KEYS === 'true' &&
  process.env.TEST_SKIP_EXTERNAL_APIS !== 'true' &&
  googleApiKey.length > 0 &&
  !googleApiKey.includes('mock') &&
  !googleApiKey.includes('test-');

const describeGoogleAdapter = shouldRunLiveTests ? describe : describe.skip;

describeGoogleAdapter('GoogleAdapter - Real API Integration Tests', () => {
  beforeAll(async () => {
    await startTestEnvironment();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  let adapter: GoogleAdapter;

  beforeEach(async () => {
    // Seed test models FIRST
    const { seedTestModels, GOOGLE_TEST_MODELS } = await import('../utils/test-model-catalog');
    await seedTestModels('google', GOOGLE_TEST_MODELS);
    
    // Use REAL API key from environment (loaded from GCP Secrets if TEST_USE_REAL_API_KEYS=true)
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey || apiKey.includes('mock') || apiKey.includes('test-')) {
      return;
    }
    
    // Create adapter with REAL API key
    adapter = new GoogleAdapter({
      name: 'google',
      apiKey: apiKey,
    });
  });

  describe('Provider Information', () => {
    it('should return correct provider name', () => {
      expect(adapter.getName()).toBe('google');
    });

    it('should return provider information from REAL API', async () => {
      // REAL API call - validates actual system behavior
      const provider = await adapter.getProvider();

      expect(provider).toBeDefined();
      expect(provider.name).toBe('google');
      expect(provider.displayName).toBe('Google AI (Gemini)');
      expect(provider.status).toBe('active'); // Should be active if API is working
      expect(provider.health).toBeDefined();
    }, 60000); // 60 second timeout for real API calls
  });

  describe('Models', () => {
    it('should return Gemini models from catalog', async () => {
      const models = await adapter.getModels();

      expect(models).toBeDefined();
      expect(models.length).toBeGreaterThanOrEqual(7); // Now includes Gemini 2.x series
      expect(models.map(m => m.id)).toContain('gemini-1.5-pro');
      expect(models.map(m => m.id)).toContain('gemini-1.5-flash');
      expect(models.map(m => m.id)).toContain('gemini-2.5-pro');
      expect(models.map(m => m.id)).toContain('gemini-2.0-flash');
      expect(models.map(m => m.id)).toContain('gemini-1.0-pro');
    });

    it('should include correct pricing for Gemini 1.5 Flash (cheapest)', async () => {
      const models = await adapter.getModels();
      const flash = models.find(m => m.id === 'gemini-1.5-flash');

      expect(flash).toBeDefined();
      expect(flash?.inputCostPer1k).toBe(0.000075); // $0.075 per 1M
      expect(flash?.outputCostPer1k).toBe(0.0003); // $0.30 per 1M
    });

    it('should include correct pricing for Gemini 1.5 Pro', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro');

      expect(pro).toBeDefined();
      expect(pro?.inputCostPer1k).toBe(0.00125); // $1.25 per 1M
      expect(pro?.outputCostPer1k).toBe(0.005); // $5 per 1M
    });

    it('should support large context windows (1M+ tokens)', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro');
      const flash = models.find(m => m.id === 'gemini-1.5-flash');

      // Gemini 1.5 Pro has 2M context, Flash has 1M
      expect(pro?.contextWindow).toBeGreaterThanOrEqual(1000000);
      expect(flash?.contextWindow).toBeGreaterThanOrEqual(1000000);
    });

    it('should include vision capability', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro');

      expect(pro?.capabilities).toContain('vision');
    });

    it('should include function calling capability', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro');

      expect(pro?.capabilities).toContain('function_calling');
    });
  });

  describe('Model Normalization', () => {
    it('should normalize model names dynamically using discovered models', async () => {
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Use a real model name from discovery to test normalization
      const realModelName = models[0].name;
      const partialName = realModelName.split('-')[0] || realModelName.substring(0, 6);
      
      const normalized = await adapter.normalizeModelName(partialName);
      // Should resolve to a valid model
      expect(normalized).toBeDefined();
      expect(typeof normalized).toBe('string');
    }, 60000);

    it('should preserve valid model names from discovery', async () => {
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      // Test with a real model name from discovery
      const realModelName = models[0].name;
      const normalized = await adapter.normalizeModelName(realModelName);
      expect(normalized).toBeDefined();
      expect(typeof normalized).toBe('string');
    }, 60000);
  });

  describe('Chat Completion - REAL API', () => {
    it('should handle simple chat request with REAL API', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
        max_tokens: 16, // Minimum for OpenRouter, but we're using Google directly
      };

      const response = await adapter.chatCompletion(request);

      expect(response).toBeDefined();
      expect(response.choices).toBeDefined();
      expect(response.choices.length).toBeGreaterThan(0);
      expect(response.choices[0].message.content).toBeDefined();
      expect(response.usage).toBeDefined();
      expect(response.usage.total_tokens).toBeGreaterThan(0);
    }, 60000); // 60 second timeout for real API calls

    it('should handle system messages with REAL API', async () => {
      const request: ChatRequest = {
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Say "ok"' },
        ],
        max_tokens: 16,
      };

      const response = await adapter.chatCompletion(request);

      expect(response).toBeDefined();
      expect(response.choices[0].message.content).toBeDefined();
    }, 60000);

    it('should handle temperature parameter with REAL API', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Say "test"' }],
        temperature: 0.9,
        max_tokens: 16,
      };

      const response = await adapter.chatCompletion(request);

      expect(response).toBeDefined();
      expect(response.choices[0].message.content).toBeDefined();
    }, 60000);

    it('should handle max_tokens parameter with REAL API', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Say "test"' }],
        max_tokens: 100,
      };

      const response = await adapter.chatCompletion(request);

      expect(response).toBeDefined();
      expect(response.choices[0].message.content).toBeDefined();
    }, 60000);
  });

  describe('Health Check - REAL API', () => {
    it('should return healthy status with REAL API check', async () => {
      // REAL API call to validate health
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.latency).toBeGreaterThanOrEqual(0);
      expect(health.checkedAt).toBeInstanceOf(Date);
    }, 60000); // 60 second timeout for real API calls
  });

  describe('Cost Calculation', () => {
    it('should calculate cost for Gemini 1.5 Flash (cheapest)', async () => {
      const models = await adapter.getModels();
      const flash = models.find(m => m.id === 'gemini-1.5-flash')!;
      
      const cost = adapter.calculateCost(flash, 1000, 1000);
      
      // Input: 1000 tokens * $0.000075 = $0.000075
      // Output: 1000 tokens * $0.0003 = $0.0003
      // Total: $0.000375
      expect(cost).toBeCloseTo(0.000375, 6);
    });

    it('should calculate cost for Gemini 1.5 Pro', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro')!;
      
      const cost = adapter.calculateCost(pro, 1000, 1000);
      
      // Input: 1000 tokens * $0.00125 = $0.00125
      // Output: 1000 tokens * $0.005 = $0.005
      // Total: $0.00625
      expect(cost).toBeCloseTo(0.00625, 5);
    });

    it('should show Gemini Flash is cheaper than GPT-4o', async () => {
      const models = await adapter.getModels();
      const flash = models.find(m => m.id === 'gemini-1.5-flash')!;
      
      const geminiCost = adapter.calculateCost(flash, 1000, 1000);
      
      // GPT-4o: input $0.0025, output $0.01 per 1k
      const gpt4oCost = (1000 / 1000) * 0.0025 + (1000 / 1000) * 0.01; // $0.0125

      expect(geminiCost).toBeLessThan(gpt4oCost);
      
      // Gemini Flash is ~97% cheaper than GPT-4o
      const savingsPercent = ((gpt4oCost - geminiCost) / gpt4oCost) * 100;
      expect(savingsPercent).toBeGreaterThan(95);
    });

    it('should show Gemini Flash is cheaper than Claude', async () => {
      const models = await adapter.getModels();
      const flash = models.find(m => m.id === 'gemini-1.5-flash')!;
      
      const geminiCost = adapter.calculateCost(flash, 1000, 1000);
      
      // Claude 3.5 Sonnet: input $0.003, output $0.015 per 1k
      const claudeCost = (1000 / 1000) * 0.003 + (1000 / 1000) * 0.015; // $0.018

      expect(geminiCost).toBeLessThan(claudeCost);
      
      // Gemini Flash is ~98% cheaper than Claude
      const savingsPercent = ((claudeCost - geminiCost) / claudeCost) * 100;
      expect(savingsPercent).toBeGreaterThan(95);
    });
  });

  describe('Context Window', () => {
    it('should support 1M+ token context for Gemini 1.5', async () => {
      const models = await adapter.getModels();
      const gemini15 = models.filter(m => m.id.startsWith('gemini-1.5'));

      gemini15.forEach(model => {
        // Gemini 1.5 models have at least 1M context window
        expect(model.contextWindow).toBeGreaterThanOrEqual(1000000);
      });
    });

    it('should support smaller context for Gemini 1.0', async () => {
      const models = await adapter.getModels();
      const gemini10 = models.find(m => m.id === 'gemini-1.0-pro');

      // Gemini 1.0 Pro has ~30K context
      expect(gemini10?.contextWindow).toBeGreaterThan(20000);
      expect(gemini10?.contextWindow).toBeLessThan(50000);
    });
  });

  describe('Capabilities', () => {
    it('should support vision in Gemini 1.5 models', async () => {
      const models = await adapter.getModels();
      const gemini15Models = models.filter(m => m.id.startsWith('gemini-1.5'));

      gemini15Models.forEach(model => {
        expect(model.capabilities).toContain('vision');
      });
    });

    it('should support function calling in modern models', async () => {
      const models = await adapter.getModels();
      const modernModels = models.filter(m => 
        m.id.includes('1.5') || m.id.includes('2.0') || m.id.includes('2.5')
      );

      modernModels.forEach(model => {
        expect(model.capabilities).toContain('function_calling');
      });
    });

    it('should support streaming in all models', async () => {
      const models = await adapter.getModels();

      models.forEach(model => {
        expect(model.capabilities).toContain('streaming');
      });
    });

    it('should support JSON mode in Gemini 1.5 Pro and Flash', async () => {
      const models = await adapter.getModels();
      const gemini15ProFlash = models.filter(m => 
        m.id === 'gemini-1.5-pro' || m.id === 'gemini-1.5-flash'
      );

      gemini15ProFlash.forEach(model => {
        expect(model.capabilities).toContain('json_mode');
      });
    });
  });

  describe('Performance Characteristics', () => {
    it('should have performance metrics for Flash', async () => {
      const models = await adapter.getModels();
      const flash = models.find(m => m.id === 'gemini-1.5-flash');

      expect(flash?.performance).toBeDefined();
      expect(flash?.performance.latencyMs).toBeGreaterThan(0);
    });

    it('should have performance metrics for Pro', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro');

      expect(pro?.performance).toBeDefined();
      expect(pro?.performance.latencyMs).toBeGreaterThan(0);
    });

    it('should have quality metrics for models', async () => {
      const models = await adapter.getModels();
      const pro = models.find(m => m.id === 'gemini-1.5-pro');

      expect(pro?.performance.quality).toBeGreaterThan(0);
      expect(pro?.performance.quality).toBeLessThanOrEqual(1);
    });
  });
});
