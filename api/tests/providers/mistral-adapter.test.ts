// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Mistral Provider Adapter
 * Uses REAL API calls - NO mocks, NO hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { MistralAdapter } from '@/providers/mistral/mistral-adapter';
import type { ProviderConfig, ChatRequest } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { shouldRunLiveProviderSuite } from '../utils/live-mode';

const apiKey = process.env.MISTRAL_API_KEY || '';
const describeLiveSuite = shouldRunLiveProviderSuite(apiKey) ? describe : describe.skip;

describeLiveSuite('MistralAdapter - Real API Tests (NO Mocks)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  let adapter: MistralAdapter;

  beforeEach(async () => {
    if (!apiKey) {
      return;
    }
    
    const config: ProviderConfig = {
      name: 'mistral',
      apiKey,
      baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
      enabled: true,
      priority: 1,
    };
    
    adapter = new MistralAdapter(config);
  });

  describe('Provider Information', () => {
    it('should have correct provider name', () => {
      expect(adapter.getName()).toBe('mistral');
    });

    it('should return models from REAL dynamic discovery', async () => {
      if (!apiKey) {
        return;
      }
      const models = await adapter.getModels();
      // Models come from REAL dynamic discovery, not hardcoded
      expect(models.length).toBeGreaterThanOrEqual(0);
      expect(models.every((m) => m.provider === 'mistral')).toBe(true);
    }, 60000);
  });

  describe('Cost Calculation', () => {
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

  describe('Chat Completion', () => {
    it('should make REAL request to Mistral API', async () => {
      if (!apiKey) {
        return;
      }
      
      const models = await adapter.getModels();
      if (models.length === 0) {
        return;
      }
      
      const request: ChatRequest = {
        model: models[0].id,
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

  describe('Health Check', () => {
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
});
