// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Orchestration Integration Tests (Realistic)
 * 
 * Tests orchestration engine behavior without complex mocks.
 * Focus on: Strategy selection, error handling, configuration
 */

import { describe, it, expect } from 'vitest';
import { OrchestrationEngine } from '../orchestration-engine';
import type { ProviderRegistry } from '@/providers/provider-registry';

describe('Orchestration Engine Integration', () => {
  describe('Initialization', () => {
    it('should initialize with default configuration', () => {
      const engine = new OrchestrationEngine({
        providerRegistry: {
          getAllModels: async () => [],
          findModel: async () => null,
          findModelByName: async () => null,
          getProviderNames: () => [],
        } as ProviderRegistry,
        defaultStrategy: 'single',
        enableAutoSelection: false,
      });

      expect(engine).toBeDefined();
    });

    it('should accept configuration options', () => {
      const engine = new OrchestrationEngine({
        providerRegistry: {
          getAllModels: async () => [],
          findModel: async () => null,
          findModelByName: async () => null,
          getProviderNames: () => [],
        } as ProviderRegistry,
        defaultStrategy: 'parallel',
        enableAutoSelection: true,
        enableTriaging: true,
        // No hardcoded triageModel - will be dynamically selected based on available models
      });

      expect(engine).toBeDefined();
    });
  });

  describe('Strategy Selection', () => {
    it('should support single model strategy', () => {
      const engine = new OrchestrationEngine({
        providerRegistry: {
          getAllModels: async () => [],
          findModel: async () => null,
          findModelByName: async () => null,
          getProviderNames: () => [],
        } as ProviderRegistry,
        defaultStrategy: 'single',
        enableAutoSelection: false,
      });

      // Configuration accepted
      expect(engine).toBeDefined();
    });

    it('should support parallel strategy', () => {
      const engine = new OrchestrationEngine({
        providerRegistry: {
          getAllModels: async () => [],
          findModel: async () => null,
          findModelByName: async () => null,
          getProviderNames: () => [],
        } as ProviderRegistry,
        defaultStrategy: 'parallel',
        enableAutoSelection: false,
      });

      expect(engine).toBeDefined();
    });

    it('should support sequential strategy', () => {
      const engine = new OrchestrationEngine({
        providerRegistry: {
          getAllModels: async () => [],
          findModel: async () => null,
          findModelByName: async () => null,
          getProviderNames: () => [],
        } as ProviderRegistry,
        defaultStrategy: 'sequential',
        enableAutoSelection: false,
      });

      expect(engine).toBeDefined();
    });
  });
});

