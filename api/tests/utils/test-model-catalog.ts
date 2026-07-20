// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test Model Catalog Helper
 * 
 * ⚠️ DEPRECATED: This file is deprecated. Use dynamic-model-discovery.ts instead.
 * 
 * This file used to seed hardcoded models, but we now use REAL dynamic discovery
 * from provider APIs. NO hardcoded models, NO mocks.
 * 
 * See: api/tests/NO_MOCKS_POLICY.md
 * 
 * @deprecated Use dynamic-model-discovery.ts for all test model needs
 */

import { Prisma, PrismaClient } from '@/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { Model } from '@/types';

/**
 * Get Prisma Client with current DATABASE_URL
 * Creates a new instance to ensure it uses the correct DATABASE_URL from test environment
 */
type DisposablePrismaClient = {
  prisma: PrismaClient;
  dispose: () => Promise<void>;
};

function createDisposablePrismaClient(): DisposablePrismaClient {
  // Use current DATABASE_URL from environment (set by test-environment)
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set by test environment');
  }

  // Create new instance with current DATABASE_URL to ensure it uses Testcontainers URL
  const pool = new pg.Pool({
    connectionString: databaseUrl,
  });
  pool.on('error', (error: unknown) => {
    // Prevent "Unhandled 'error' event" crashes during Testcontainers teardown (57P01 is expected).
    const code =
      error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;

    if (process.env.NODE_ENV === 'test' && code === '57P01') {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn('[test-model-catalog] PostgreSQL pool error:', { code, message });
  });
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : undefined,
  });

  const dispose = async (): Promise<void> => {
    try {
      await prisma.$disconnect();
    } finally {
      await pool.end().catch(() => undefined);
    }
  };

  return { prisma, dispose };
}

export interface TestModelDefinition {
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  capabilities: string[];
  status?: 'active' | 'deprecated' | 'beta';
  aliases?: string[];
  performance?: {
    latencyMs?: number;
    throughput?: number;
    quality?: number;
    reliability?: number;
  };
}

/**
 * OpenAI test models
 */
export const OPENAI_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'gpt-5.1',
    displayName: 'GPT-5.1',
    contextWindow: 1024000,
    maxOutputTokens: 32768,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision', 'reasoning', 'agents'],
    status: 'active',
  },
  {
    name: 'gpt-5',
    displayName: 'GPT-5',
    contextWindow: 512000,
    maxOutputTokens: 16384,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.01,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision', 'reasoning', 'agents'],
    status: 'active',
  },
  {
    name: 'gpt-4o',
    displayName: 'GPT-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision'],
    status: 'active',
  },
  {
    name: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
    capabilities: ['chat', 'streaming', 'function_calling'],
    status: 'active',
  },
  {
    name: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision'],
    status: 'active',
  },
  {
    name: 'gpt-3.5-turbo',
    displayName: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
    capabilities: ['chat', 'streaming', 'function_calling'],
    status: 'active',
  },
];

/**
 * Anthropic test models
 * Note: Order matters for alias matching - more specific/newer versions should come first
 */
export const ANTHROPIC_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'claude-3-5-sonnet-20241022',
    displayName: 'Claude 3.5 Sonnet',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision'],
    status: 'active',
  },
  {
    name: 'claude-3-sonnet-20240229',
    displayName: 'Claude 3 Sonnet',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'streaming', 'vision'],
    status: 'active',
  },
  {
    name: 'claude-3-opus-20240229',
    displayName: 'Claude 3 Opus',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
    capabilities: ['chat', 'streaming', 'vision'],
    status: 'active',
  },
  {
    name: 'claude-3-haiku-20240307',
    displayName: 'Claude 3 Haiku',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.00125,
    capabilities: ['chat', 'streaming', 'vision'],
    status: 'active',
  },
];

/**
 * Google test models
 */
export const GOOGLE_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'gemini-2.5-pro',
    aliases: ['gemini-2.5-pro-exp'],
    displayName: 'Gemini 2.5 Pro',
    contextWindow: 2097152,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision'],
    status: 'active',
  },
  {
    name: 'gemini-2.0-flash',
    aliases: ['gemini-2.0-flash-exp'],
    displayName: 'Gemini 2.0 Flash',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision'],
    status: 'active',
  },
  {
    name: 'gemini-1.5-pro',
    aliases: ['gemini-pro', 'gemini'],
    displayName: 'Gemini 1.5 Pro',
    contextWindow: 2097152,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision', 'json_mode'],
    status: 'active',
  },
  {
    name: 'gemini-1.5-flash',
    aliases: ['gemini-flash'],
    displayName: 'Gemini 1.5 Flash',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision', 'json_mode'],
    status: 'active',
  },
  {
    name: 'gemini-1.5-flash-8b',
    displayName: 'Gemini 1.5 Flash-8B',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.0000375,
    outputCostPer1k: 0.00015,
    capabilities: ['chat', 'streaming', 'function_calling', 'vision'],
    status: 'active',
  },
  {
    name: 'gemini-1.0-pro',
    displayName: 'Gemini 1.0 Pro',
    contextWindow: 30720,
    maxOutputTokens: 2048,
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
    capabilities: ['chat', 'streaming'],
    status: 'active',
  },
  {
    name: 'gemini-1.0-pro-vision',
    displayName: 'Gemini 1.0 Pro Vision',
    contextWindow: 12288,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.0005,
    capabilities: ['chat', 'streaming', 'vision'],
    status: 'active',
  },
];

/**
 * Mistral test models
 */
export const MISTRAL_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'mistral-large-latest',
    displayName: 'Mistral Large',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.009,
    capabilities: ['chat', 'streaming', 'function_calling'],
    status: 'active',
  },
  {
    name: 'mistral-small-latest',
    displayName: 'Mistral Small',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.0006,
    outputCostPer1k: 0.0018,
    capabilities: ['chat', 'streaming'],
    status: 'active',
  },
];

/**
 * DeepSeek test models
 */
export const DEEPSEEK_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: 64000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.00014,
    outputCostPer1k: 0.00028,
    capabilities: ['chat', 'streaming', 'function_calling'],
    status: 'active',
  },
  {
    name: 'deepseek-coder',
    displayName: 'DeepSeek Coder',
    contextWindow: 64000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.00014,
    outputCostPer1k: 0.00028,
    capabilities: ['chat', 'streaming', 'code', 'function_calling'],
    status: 'active',
  },
  {
    name: 'deepseek-v3',
    displayName: 'DeepSeek V3',
    contextWindow: 65536,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00027,
    outputCostPer1k: 0.0011,
    capabilities: ['chat', 'streaming', 'function_calling'],
    status: 'active',
    performance: {
      latencyMs: 1000,
      throughput: 100,
      quality: 0.92,
      reliability: 0.99,
    },
  },
  {
    name: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.00055,
    outputCostPer1k: 0.0022,
    capabilities: ['chat', 'streaming', 'function_calling', 'reasoning'],
    status: 'active',
  },
];

/**
 * XAI test models
 * NOTE: Models should be discovered dynamically, not hardcoded.
 * This is only for test setup when dynamic discovery is not available.
 * In production, all models come from dynamic discovery.
 */
export const XAI_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'grok-2-latest',
    displayName: 'Grok 2',
    contextWindow: 131072,
    maxOutputTokens: 16384,
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.01,
    capabilities: ['chat', 'streaming'],
    status: 'active',
  },
  {
    name: 'grok-2-vision-1212',
    displayName: 'Grok 2 Vision',
    contextWindow: 32768,
    maxOutputTokens: 16384,
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.01,
    capabilities: ['chat', 'streaming', 'vision'],
    status: 'active',
  },
];

/**
 * Cohere test models
 * NOTE: Models should be discovered dynamically, not hardcoded.
 * This is only for test setup when dynamic discovery is not available.
 * In production, all models come from dynamic discovery.
 */
export const COHERE_TEST_MODELS: TestModelDefinition[] = [
  {
    name: 'command-r-plus',
    displayName: 'Command R+',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'streaming', 'function_calling'],
    status: 'active',
  },
  {
    name: 'command-r',
    displayName: 'Command R',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
    capabilities: ['chat', 'streaming'],
    status: 'active',
  },
];

/**
 * All test models by provider
 */
export const TEST_MODELS_BY_PROVIDER: Record<string, TestModelDefinition[]> = {
  openai: OPENAI_TEST_MODELS,
  anthropic: ANTHROPIC_TEST_MODELS,
  google: GOOGLE_TEST_MODELS,
  mistral: MISTRAL_TEST_MODELS,
  deepseek: DEEPSEEK_TEST_MODELS,
  xai: XAI_TEST_MODELS,
  cohere: COHERE_TEST_MODELS,
};

/**
 * Seed test models for a specific provider
 */
export async function seedTestModels(providerName: string, models: TestModelDefinition[]): Promise<void> {
  // Get Prisma client with current DATABASE_URL (from Testcontainers)
  const { prisma, dispose } = createDisposablePrismaClient();

  try {
    const provider = await prisma.provider.upsert({
      where: { name: providerName },
      create: {
        id: providerName,
        name: providerName,
        displayName: providerName.charAt(0).toUpperCase() + providerName.slice(1),
        status: 'active',
        metadata: {},
      },
      update: {
        displayName: providerName.charAt(0).toUpperCase() + providerName.slice(1),
        status: 'active',
      },
    });

    for (const modelDef of models) {
      await prisma.model.upsert({
        where: {
          providerId_name: {
            providerId: provider.id,
            name: modelDef.name,
          },
        },
        create: {
          id: `${providerName}-${modelDef.name}`,
          providerId: provider.id,
          name: modelDef.name,
          displayName: modelDef.displayName,
          contextWindow: modelDef.contextWindow,
          maxOutputTokens: modelDef.maxOutputTokens,
          inputCostPer1k: new Prisma.Decimal(modelDef.inputCostPer1k),
          outputCostPer1k: new Prisma.Decimal(modelDef.outputCostPer1k),
          capabilities: modelDef.capabilities as never,
          performance: modelDef.performance || { latencyMs: 1000, throughput: 100, quality: 0.9, reliability: 0.99 },
          status: modelDef.status || 'active',
          metadata: {},
        },
        update: {
          displayName: modelDef.displayName,
          contextWindow: modelDef.contextWindow,
          maxOutputTokens: modelDef.maxOutputTokens,
          inputCostPer1k: new Prisma.Decimal(modelDef.inputCostPer1k),
          outputCostPer1k: new Prisma.Decimal(modelDef.outputCostPer1k),
          capabilities: modelDef.capabilities as never,
          performance: modelDef.performance || { latencyMs: 1000, throughput: 100, quality: 0.9, reliability: 0.99 },
          status: modelDef.status || 'active',
        },
      });
    }
  } finally {
    // Disconnect Prisma client + close pool to avoid connection leaks
    await dispose();
  }
}

/**
 * Seed all test models for all providers
 */
export async function seedAllTestModels(): Promise<void> {
  for (const [providerName, models] of Object.entries(TEST_MODELS_BY_PROVIDER)) {
    await seedTestModels(providerName, models);
  }
}

/**
 * Clear all test models
 */
export async function clearTestModels(): Promise<void> {
  // Get Prisma client with current DATABASE_URL (from Testcontainers)
  const { prisma, dispose } = createDisposablePrismaClient();

  try {
    await prisma.model.deleteMany({});
    await prisma.provider.deleteMany({});
  } finally {
    // Disconnect Prisma client + close pool to avoid connection leaks
    await dispose();
  }
}

