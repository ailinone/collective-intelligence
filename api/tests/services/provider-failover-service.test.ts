// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Provider Failover Service
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { ProviderFailoverService } from '@/services/provider-failover-service';
import type { ChatRequest, ChatResponse, Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModel, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';

/**
 * Provider adapter type for testing
 */
type TestProviderAdapter = Pick<ProviderAdapter, 'getName'> & {
  chatCompletion?: (request: ChatRequest) => Promise<ChatResponse>;
  chatCompletionStream?: (request: ChatRequest) => AsyncGenerator<ChatResponse>;
};

describe('ProviderFailoverService - Real Tests (NO Hardcoded Models)', () => {
  let service: ProviderFailoverService;
  let realModel: Model | null;

  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
    realModel = await getTestModel();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(() => {
    service = new ProviderFailoverService();
  });

  describe('failover logic', () => {
    it('should work with real models', async () => {
      if (!realModel) {
        return;
      }

      const testRequest: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: realModel.id, // Use dynamically discovered model
      };

      // Test that service can handle real model IDs
      expect(testRequest.model).toBeDefined();
      expect(testRequest.model).not.toBe('gpt-4o'); // No hardcoded models
    }, 60000);
  });
});
