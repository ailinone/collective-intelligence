// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Mock do Central Model Discovery Service para testes
 * 
 * Use este mock para evitar chamadas reais às APIs de descoberta de modelos.
 * 
 * Exemplo de uso:
 * ```typescript
 * import { vi } from 'vitest';
 * import { mockModelDiscoveryService } from '@mocks/services/model-discovery';
 * 
 * vi.mock('@/services/central-model-discovery-service', () => ({
 *   CentralModelDiscoveryService: vi.fn().mockImplementation(() => mockModelDiscoveryService),
 *   getCentralModelDiscoveryService: vi.fn().mockReturnValue(mockModelDiscoveryService),
 * }));
 * ```
 */

import type { DiscoveredModel } from '@/services/central-model-discovery-service';

export const mockDiscoveredModels: DiscoveredModel[] = [
  // OpenAI Models
  {
    id: 'gpt-4',
    name: 'GPT-4',
    displayName: 'GPT-4',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    provider: 'openai',
    capabilities: ['chat', 'function_calling', 'vision'],
    pricing: { inputCostPer1M: 30, outputCostPer1M: 60, currency: 'USD' },
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    displayName: 'GPT-4 Turbo',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
    capabilities: ['chat', 'function_calling', 'vision', 'json_mode'],
    pricing: { inputCostPer1M: 10, outputCostPer1M: 30, currency: 'USD' },
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    displayName: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    maxOutputTokens: 4096,
    provider: 'openai',
    capabilities: ['chat', 'function_calling'],
    pricing: { inputCostPer1M: 0.5, outputCostPer1M: 1.5, currency: 'USD' },
  },
  
  // Anthropic Models
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    displayName: 'Claude 3 Opus',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'function_calling'],
    pricing: { inputCostPer1M: 15, outputCostPer1M: 75, currency: 'USD' },
  },
  {
    id: 'claude-3-sonnet-20240229',
    name: 'Claude 3 Sonnet',
    displayName: 'Claude 3 Sonnet',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'function_calling'],
    pricing: { inputCostPer1M: 3, outputCostPer1M: 15, currency: 'USD' },
  },
  
  // Google Models
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    displayName: 'Gemini 1.5 Pro',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    provider: 'google',
    capabilities: ['chat', 'vision', 'audio', 'video', 'function_calling'],
    pricing: { inputCostPer1M: 3.5, outputCostPer1M: 10.5, currency: 'USD' },
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    displayName: 'Gemini 1.5 Flash',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    provider: 'google',
    capabilities: ['chat', 'vision', 'audio', 'video', 'function_calling'],
    pricing: { inputCostPer1M: 0.075, outputCostPer1M: 0.3, currency: 'USD' },
  },
];

export const mockModelDiscoveryService = {
  discoverAllModels: async (): Promise<DiscoveredModel[]> => {
    return mockDiscoveredModels;
  },
  
  discoverFromSource: async (sourceName: string): Promise<DiscoveredModel[]> => {
    return mockDiscoveredModels.filter(m => m.provider === sourceName);
  },
  
  getDiscoveredModels: (): DiscoveredModel[] => {
    return mockDiscoveredModels;
  },
  
  getModelById: (id: string): DiscoveredModel | undefined => {
    return mockDiscoveredModels.find(m => m.id === id);
  },
  
  getModelsByProvider: (provider: string): DiscoveredModel[] => {
    return mockDiscoveredModels.filter(m => m.provider === provider);
  },
  
  refreshModels: async (): Promise<void> => {
    // No-op for mock
  },
};

/**
 * Cria um mock configurável do Model Discovery Service
 */
export function createMockModelDiscoveryService(overrides?: Partial<typeof mockModelDiscoveryService>) {
  return {
    ...mockModelDiscoveryService,
    ...overrides,
  };
}

/**
 * Cria modelos mock personalizados
 */
export function createMockModels(count: number, provider = 'openai'): DiscoveredModel[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `mock-model-${i}`,
    name: `Mock Model ${i}`,
    displayName: `Mock Model ${i}`,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    provider,
    capabilities: ['chat'],
    pricing: { inputCostPer1M: 1, outputCostPer1M: 2, currency: 'USD' },
  }));
}

