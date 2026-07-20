// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Central Model Discovery Service
 *
 * Serviço intermediário que coordena a descoberta de modelos de todas as fontes:
 * - APIs nativas (OpenAI, Anthropic, Google, etc.)
 * - Hubs empresariais (VertexAI, AWS Bedrock, Azure, OCI)
 * - Routers/aggregators (OpenRouter, Featherless.ai, etc.)
 *
 * Mantém uma base própria com todos os modelos e metadados.
 * Executa validações contínuas e serve como fonte única de verdade.
 */

import { logger } from '@/utils/logger';
import { getProviderKeyStatus } from '@/config/load-secrets-into-env';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';
import { Prisma, type Provider, type Model as PrismaModel } from '@/generated/prisma/index.js';
import { getModelSelectionCache } from '@/core/selection/model-selection-cache';
import { getModelDiscoveryScheduler } from './model-discovery-scheduler';
import { isUniqueConstraintError, getUniqueConstraintFields } from '@/utils/prisma-error-helpers';
import { modelCacheService } from '@/services/model-cache-service';
import {
  extractModelModalities,
  inferModelCapabilities,
  inferProviderFromModelId,
} from '@/services/model-capability-inference';
import { withNormalizedMetadata } from '@/capability/metadata-normalization';
import { narrowAs } from '@/utils/type-guards';
import { getProviderRegistry } from '@/providers/provider-registry';
import type { BalanceCheckResult } from '@/providers/base/provider-adapter';

const PROVIDER_ID_ALIASES: Record<string, string> = {
  'x-ai': 'xai',
  x: 'xai',
  grok: 'xai',
  qwen: 'alibaba',
  alicloud: 'alibaba',
  ernie: 'baidu',
  // Phase 6 Fix 5 (2026-04-30): canonical is 'aws-bedrock' (matches
  // consolidation-matrix.ts live-validation bucket, provider-kind.ts
  // NATIVE_PROVIDERS set, and the aws-bedrock-model-fetcher.ts
  // providerName). Alias direction was previously inverted —
  // 'aws-bedrock' was being normalised INTO non-canonical 'bedrock',
  // which is what caused 125 DB rows to land under provider_id='bedrock'
  // (orphan vs the catalog/registry expectation). The reversal stops
  // the bleed; existing rows are operator-bound for migration via
  // `UPDATE models SET provider_id='aws-bedrock' WHERE provider_id='bedrock'`.
  amazon: 'aws-bedrock',
  aws: 'aws-bedrock',
  bedrock: 'aws-bedrock',
  bedrockruntime: 'aws-bedrock',
  microsoft: 'azure-openai',
  azure: 'azure-openai',
  azureopenai: 'azure-openai',
  vertex: 'vertex-ai',
  vertexai: 'vertex-ai',
  googlegenerativeai: 'google',
  googleai: 'google',
  oracle: 'oci',
  orq: 'orqai',
  'orq.ai': 'orqai',
  eden: 'edenai',
  'eden.ai': 'edenai',
  nvidiahub: 'nvidia-hub',
  'nvidia-hub': 'nvidia-hub',
  'nvidia-hub-api': 'nvidia-hub',
  'aihub-mix': 'aihubmix',
  'mini-max': 'minimax',
  'moonshot-ai': 'moonshot',
  'friendli-ai': 'friendli',
  aimlapi: 'aiml',
  'image-router': 'imagerouter',
  helicone: 'heliconeai',
  'helicone.ai': 'heliconeai',
  'helicone-ai': 'heliconeai',
  'comet-api': 'cometapi',
  'comet': 'cometapi',
  'nano-gpt': 'nanogpt',
  // Canonical providerId is `ai302` post-migration (2026-04-22). Aliases
  // target the canonical id so downstream lookups don't need the catalog
  // alias-resolution path.
  '302-ai': 'ai302',
  '302': 'ai302',
  '302ai': 'ai302',
  'route-way': 'routeway',
  ollama: 'ollama',
  'llama-server': 'local-llama',
  'llama.cpp': 'local-llama',
  'koboldcpp': 'local-kobold',
  'local-embeddings': 'local-embeddings',
  'local-ocr': 'local-ocr',
  'local-docling': 'local-docling',
  'local-piper': 'local-piper',
};

const EXECUTION_PROVIDER_PRIORITY: readonly string[] = [
  'openrouter',
  'nvidia-hub',
  'aihubmix',
  'novita',
  'moonshot',
  'friendli',
  'aiml',
  'imagerouter',
  'orqai',
  'heliconeai',
  'edenai',
  'cometapi',
  'nanogpt',
  'requesty',
  'ai302',
  'poe',
  'routeway',
  'ollama',
  'local-llama',
  'local-kobold',
  'local-embeddings',
  'local-ocr',
  'local-docling',
  'local-piper',
  'nvidia',
  'minimax',
  'jina',
  'vertex-ai',
  'azure-openai',
  // Phase 6 Fix 5 (2026-04-30): 'bedrock' replaced by canonical
  // 'aws-bedrock'. Inputs that come in as 'bedrock' (legacy metadata)
  // are normalized into 'aws-bedrock' by PROVIDER_ID_ALIASES before
  // the priority check, so this entry uses the canonical form only.
  'aws-bedrock',
  'alibaba',
  'baidu',
  'oci',
  'openai',
  'anthropic',
  'google',
  'mistral',
  'deepseek',
  'xai',
  'cohere',
];

export interface DiscoveredModel {
  id: string;
  name?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
  pricing?: {
    prompt?: number;
    completion?: number;
    inputCostPer1M?: number;
    outputCostPer1M?: number;
    currency?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface DiscoverySource {
  name: string;
  type: 'native_api' | 'cloud_hub' | 'router' | 'aggregator';
  priority: number; // 1 = highest priority (most accurate)
  providers: string[];
  fetcher: () => Promise<DiscoveredModel[]>;
}

export interface ModelDiscoveryResult {
  source: string;
  provider: string;
  modelsDiscovered: number;
  modelsUpdated: number;
  modelsNew: number;
  errors: string[];
  duration: number;
  timestamp: Date;
}

export interface CentralDiscoveryStats {
  totalSources: number;
  totalProviders: number;
  totalModels: number;
  lastDiscovery: Date | null;
  nextScheduled: Date | null;
  sourcesByType: Record<string, number>;
  providersBySource: Record<string, string[]>;
  discoveryHistory: ModelDiscoveryResult[];
}

// ─── Source Health Tracking (Self-Healing Discovery L1) ───────────────────

export interface SourceHealthRecord {
  sourceName: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  failReason: string | null;
  retriable: boolean;
  backoffMs: number;
  modelsDiscoveredLast: number;
  totalAttempts: number;
  totalSuccesses: number;
}

export interface DiscoveryHealthReport {
  sources: SourceHealthRecord[];
  criticalMissing: string[];
  lastFullDiscovery: Date | null;
  healthScore: number;
}

/**
 * Map catalog `authScheme` token to the string the hub fetcher expects in the
 * Authorization header prefix. Mirrors {@link CatalogProviderPlugin.mapAuthScheme}
 * but kept local so the discovery source doesn't depend on the plugin lifecycle.
 */
function mapCatalogAuthScheme(scheme: string | undefined): string | undefined {
  switch (scheme) {
    case 'bearer':
      return 'Bearer';
    case 'api-key-header':
      return '';
    default:
      return undefined;
  }
}

export class CentralModelDiscoveryService {
  private log = logger.child({ component: 'central-discovery' });
  private cache = getModelSelectionCache();
  private discoverySources: Map<string, DiscoverySource> = new Map();
  private providerBalanceStatus: Map<string, BalanceCheckResult> = new Map();
  private sourceHealthMap: Map<string, SourceHealthRecord> = new Map();
  private lastFullDiscovery: Date | null = null;
  private initializationPromise: Promise<void>;
  // In-flight discovery coalescing: when two callers ask for discoverAllModels()
  // simultaneously (e.g., index.ts syncDiscoveredModels + model-discovery-runner
  // at startup), both would concurrently upsert the same models → duplicate key
  // violations on models.uid. Instead, share the in-flight Promise so both get
  // the same result without redundant DB writes.
  private inFlightDiscovery: Promise<ModelDiscoveryResult[]> | null = null;

  constructor() {
    this.initializationPromise = this.initializeSources().catch((error: unknown) => {
      this.log.error({ error }, 'Failed to initialize discovery sources');
      throw error;
    });
  }

  private async ensureInitialized(): Promise<void> {
    await this.initializationPromise;
  }

  async ready(): Promise<void> {
    await this.ensureInitialized();
  }

  // ─── Self-Healing Discovery (L1) ─────────────────────────────────────────

  /**
   * Returns per-source health for monitoring and diagnostics.
   */
  getDiscoveryHealth(): DiscoveryHealthReport {
    const sources = Array.from(this.sourceHealthMap.values());
    const criticalMissing = this.getCriticalProviderGaps();
    const totalSources = sources.length;
    const healthySources = sources.filter(s => s.consecutiveFailures === 0).length;
    return {
      sources,
      criticalMissing,
      lastFullDiscovery: this.lastFullDiscovery,
      healthScore: totalSources > 0 ? healthySources / totalSources : 0,
    };
  }

  /**
   * Returns critical native providers that have API keys loaded but zero models in DB.
   * These providers SHOULD have models — their absence indicates a discovery failure.
   */
  getCriticalProviderGaps(): string[] {
    try {
      // `getProviderKeyStatus` imported at module scope — no more `require()`,
      // and the return type is real-typed instead of `any`.
      const keyStatus = getProviderKeyStatus();
      const gaps: string[] = [];

      // Critical native providers that should have many models if key is valid
      const CRITICAL_NATIVES = ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'mistral'];

      for (const provider of CRITICAL_NATIVES) {
        const status = keyStatus.get(provider);
        if (status?.loaded) {
          // Key is loaded — check if we have models for this provider
          const health = this.sourceHealthMap.get(`${provider}-native`);
          if (!health || health.modelsDiscoveredLast === 0) {
            gaps.push(provider);
          }
        }
      }
      return gaps;
    } catch {
      return [];
    }
  }

  /**
   * Re-run discovery ONLY for sources that previously failed due to missing keys
   * or other retriable errors. Called 30s after startup to catch late-arriving secrets.
   */
  async retryFailedSources(): Promise<ModelDiscoveryResult[]> {
    await this.ensureInitialized();
    const results: ModelDiscoveryResult[] = [];
    const now = Date.now();

    for (const [sourceName, health] of this.sourceHealthMap.entries()) {
      if (!health.retriable) continue;

      // Check backoff: don't retry too soon
      const timeSinceLastAttempt = health.lastAttemptAt
        ? now - health.lastAttemptAt.getTime()
        : Infinity;
      if (timeSinceLastAttempt < health.backoffMs) continue;

      const source = this.discoverySources.get(sourceName);
      if (!source) continue;

      this.log.info(
        { source: sourceName, previousFailures: health.consecutiveFailures, backoffMs: health.backoffMs },
        'Self-healing: retrying previously failed discovery source'
      );

      try {
        const models = await Promise.race([
          source.fetcher(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Retry timeout for ${sourceName}`)), 15000)
          ),
        ]);

        if (models.length > 0) {
          const result = await this.processDiscoveredModels(sourceName, source, models);
          this.recordSourceSuccess(sourceName, models.length);
          results.push({
            ...result,
            source: sourceName,
            provider: source.providers.join(','),
            duration: 0,
            timestamp: new Date(),
          });
          this.log.info(
            { source: sourceName, modelsDiscovered: models.length },
            'Self-healing: discovery source recovered — models now in DB'
          );
        } else {
          this.recordSourceFailure(sourceName, 'Zero models returned', true);
        }
      } catch (err) {
        this.recordSourceFailure(sourceName, err instanceof Error ? err.message : String(err), true);
      }
    }

    // Check for critical gaps after retry
    const gaps = this.getCriticalProviderGaps();
    if (gaps.length > 0) {
      this.log.error(
        { criticalProvidersMissing: gaps },
        'CRITICAL: Native providers with API keys have zero models in DB after retry'
      );
    }

    return results;
  }

  /**
   * Called by secrets-loader when a provider API key becomes available.
   * Triggers immediate re-discovery for the affected source.
   */
  async onSecretAvailable(envVar: string): Promise<void> {
    await this.ensureInitialized();

    // Map env var to source name (e.g., OPENAI_API_KEY → openai-native)
    // Covers ALL native and hub sources registered in initializeSources()
    const envToSource: Record<string, string> = {
      // Native API sources
      OPENAI_API_KEY: 'openai-native',
      ANTHROPIC_API_KEY: 'anthropic-native',
      GOOGLE_API_KEY: 'google-native',
      XAI_API_KEY: 'xai-native',
      DEEPSEEK_API_KEY: 'deepseek-native',
      MISTRAL_API_KEY: 'mistral-native',
      COHERE_API_KEY: 'cohere-native',
      JINA_API_KEY: 'jina-native',
      QWEN_API_KEY: 'alibaba-native',
      ERNIE_API_KEY: 'baidu-native',
      // Cloud hub sources
      NVIDIA_API_KEY: 'nvidia-first-party',
      AIHUBMIX_API_KEY: 'aihubmix-hub',
      NOVITA_API_KEY: 'novita-hub',
      MOONSHOT_API_KEY: 'moonshot-hub',
      MINIMAX_API_KEY: 'minimax-hub',
      FRIENDLI_API_KEY: 'friendli-hub',
      AIML_API_KEY: 'aiml-hub',
      IMAGEROUTER_API_KEY: 'imagerouter-hub',
      ORQAI_API_KEY: 'orqai-hub',
      EDENAI_API_KEY: 'edenai-hub',
      HELICONEAI_API_KEY: 'heliconeai-hub',
      COMETAPI_API_KEY: 'cometapi-hub',
      NANOGPT_API_KEY: 'nanogpt-hub',
      REQUESTY_API_KEY: 'requesty-hub',
      AI302_API_KEY: 'ai302-hub',
      POE_API_KEY: 'poe-hub',
      ROUTEWAY_API_KEY: 'routeway-hub',
      AZURE_OPENAI_API_KEY: 'azure-openai-hub',
      // Audio providers
      DEEPGRAM_API_KEY: 'deepgram-audio',
      CARTESIA_API_KEY: 'cartesia-audio',
      ELEVENLABS_API_KEY: 'elevenlabs-audio',
      // Router/aggregator sources
      OPENROUTER_API_KEY: 'openrouter-aggregator',
    };

    const sourceName = envToSource[envVar];
    if (!sourceName) return;

    const source = this.discoverySources.get(sourceName);
    if (!source) return;

    this.log.info({ envVar, source: sourceName }, 'API key became available — triggering re-discovery');

    try {
      const models = await source.fetcher();
      if (models.length > 0) {
        await this.processDiscoveredModels(sourceName, source, models);
        this.recordSourceSuccess(sourceName, models.length);
        this.log.info(
          { source: sourceName, modelsDiscovered: models.length },
          'Re-discovery after key availability succeeded'
        );
      }
    } catch (err) {
      this.log.warn({ source: sourceName, error: String(err) }, 'Re-discovery after key availability failed');
    }
  }

  private recordSourceSuccess(sourceName: string, modelsDiscovered: number): void {
    const existing = this.sourceHealthMap.get(sourceName);
    this.sourceHealthMap.set(sourceName, {
      sourceName,
      lastAttemptAt: new Date(),
      lastSuccessAt: new Date(),
      consecutiveFailures: 0,
      failReason: null,
      retriable: false,
      backoffMs: 0,
      modelsDiscoveredLast: modelsDiscovered,
      totalAttempts: (existing?.totalAttempts ?? 0) + 1,
      totalSuccesses: (existing?.totalSuccesses ?? 0) + 1,
    });
  }

  private recordSourceFailure(sourceName: string, reason: string, retriable: boolean): void {
    const existing = this.sourceHealthMap.get(sourceName);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    // Exponential backoff: 30s → 60s → 120s → ... → 3600s max
    const backoffMs = Math.min(30_000 * Math.pow(2, failures - 1), 3_600_000);
    this.sourceHealthMap.set(sourceName, {
      sourceName,
      lastAttemptAt: new Date(),
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      consecutiveFailures: failures,
      failReason: reason,
      retriable,
      backoffMs,
      modelsDiscoveredLast: 0,
      totalAttempts: (existing?.totalAttempts ?? 0) + 1,
      totalSuccesses: existing?.totalSuccesses ?? 0,
    });
  }

  /**
   * Inicializa todas as fontes de descoberta disponíveis
   */
  private async initializeSources() {
    // APIs Nativas - Prioridade máxima (dados mais precisos)
    await this.addNativeAPISources();

    // Hubs Empresariais - Prioridade alta
    await this.addCloudHubSources();

    // Registered Adapters - Audio-first and specialty providers
    // Dynamically discovers models from any registered adapter that returns models
    await this.addRegisteredAdapterSources();

    // Hub aggregators - HuggingFace Hub paginated metadata, Bytez full surface, etc.
    // These cover providers whose canonical catalog of inferenceable models lives
    // outside an OpenAI-compatible /models endpoint. Registered BEFORE catalog-bridge
    // so the catalog-bridge skip-detection avoids double-registering the same provider.
    await this.addAggregatorSources();

    // Catalog-bridge providers - Discovery for every catalog row not covered above.
    // Uses the plugin's OpenAICompatibleHubModelFetcher (HTTP GET /models with auth)
    // for `discovery+execution` rows; falls back to `staticModels` for execution-only.
    // Lazy plugin resolution lets sources register before plugins are wired.
    await this.addCatalogProviderSources();

    // Routers/Aggregators - Prioridade média (fallback)
    await this.addRouterSources();

    this.log.info({ sources: this.discoverySources.size }, 'Central discovery service initialized');
  }

  /**
   * Adiciona fontes de APIs nativas
   */
  private async addNativeAPISources() {
    const nativeSources: Partial<DiscoverySource>[] = [
      {
        name: 'openai-native',
        type: 'native_api',
        priority: 1,
        providers: ['openai'],
        fetcher: async () => {
          const { OpenAIModelFetcher } = await import('./model-fetchers/openai-model-fetcher.js');
          const fetcher = new OpenAIModelFetcher(
            process.env.OPENAI_API_KEY || '',
            process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            process.env.OPENAI_ORGANIZATION
          );
          return await fetcher.getModels();
        },
      },
      {
        name: 'anthropic-native',
        type: 'native_api',
        priority: 1,
        providers: ['anthropic'],
        fetcher: async () => {
          const { AnthropicModelFetcher } = await import(
            './model-fetchers/anthropic-model-fetcher.js'
          );
          const fetcher = new AnthropicModelFetcher(
            process.env.ANTHROPIC_API_KEY || '',
            process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
          );
          return await fetcher.getModels();
        },
      },
      {
        name: 'google-native',
        type: 'native_api',
        priority: 1,
        providers: ['google'],
        fetcher: async () => {
          const { GoogleModelFetcher } = await import('./model-fetchers/google-model-fetcher.js');
          const fetcher = new GoogleModelFetcher(process.env.GOOGLE_API_KEY || '');
          return await fetcher.getModels();
        },
      },
      {
        name: 'mistral-native',
        type: 'native_api',
        priority: 1,
        providers: ['mistral'],
        fetcher: async () => {
          const { MistralModelFetcher } = await import('./model-fetchers/mistral-model-fetcher.js');
          const fetcher = new MistralModelFetcher(process.env.MISTRAL_API_KEY || '');
          return await fetcher.getModels();
        },
      },
      {
        name: 'deepseek-native',
        type: 'native_api',
        priority: 1,
        providers: ['deepseek'],
        fetcher: async () => {
          const { DeepSeekModelFetcher } = await import(
            './model-fetchers/deepseek-model-fetcher.js'
          );
          const fetcher = new DeepSeekModelFetcher(
            process.env.DEEPSEEK_API_KEY || '',
            process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
          );
          return await fetcher.getModels();
        },
      },
      {
        name: 'xai-native',
        type: 'native_api',
        priority: 1,
        providers: ['xai'],
        fetcher: async () => {
          const { XAIModelFetcher } = await import('./model-fetchers/xai-model-fetcher.js');
          const fetcher = new XAIModelFetcher(process.env.XAI_API_KEY || '', process.env.XAI_BASE_URL || 'https://api.x.ai/v1');
          return await fetcher.getModels();
        },
      },
      {
        name: 'cohere-native',
        type: 'native_api',
        priority: 1,
        providers: ['cohere'],
        fetcher: async () => {
          const { CohereModelFetcher } = await import('./model-fetchers/cohere-model-fetcher.js');
          const fetcher = new CohereModelFetcher(process.env.COHERE_API_KEY || '');
          return await fetcher.getModels();
        },
      },
      {
        name: 'jina-native',
        type: 'native_api',
        priority: 1,
        providers: ['jina'],
        fetcher: async () => {
          if (!process.env.JINA_API_KEY) {
            this.log.info('Jina credentials not configured, skipping native discovery');
            return [];
          }

          const { JinaModelFetcher } = await import('./model-fetchers/jina-model-fetcher.js');
          const seedModels = (process.env.JINA_SEED_MODELS || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          const fetcher = new JinaModelFetcher({
            apiKey: process.env.JINA_API_KEY || '',
            apiBaseUrl: process.env.JINA_API_BASE_URL || 'https://api.jina.ai/v1',
            deepSearchBaseUrl: process.env.JINA_DEEPSEARCH_BASE_URL || 'https://deepsearch.jina.ai/v1',
            seedModels,
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'alibaba-native',
        type: 'native_api',
        priority: 1,
        providers: ['qwen', 'alibaba'],
        fetcher: async () => {
          const { AlibabaModelFetcher } = await import('./model-fetchers/alibaba-model-fetcher.js');
              
              // Try both API keys - test each one
              const apiKey1 = process.env.QWEN_API_KEY || '';
              const apiKey2 = process.env.QWEN_API_KEY_2 || '';

              // Model Studio keys are region-scoped: a key created in one region
              // will 401 against any other region's endpoint. We don't know which
              // region the user's key was provisioned in, so we probe all public
              // Model Studio regions in order of popularity. If ALIBABA_BASE_URL
              // is set, use ONLY that (explicit user preference).
              //
              // Source: https://help.aliyun.com/zh/model-studio/api-key-management
              const explicitRegion = process.env.ALIBABA_BASE_URL || process.env.QWEN_BASE_URL;
              const workspaceId = process.env.ALIBABA_WORKSPACE_ID || '';
              const regions: string[] = explicitRegion ? [explicitRegion] : [
                'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',  // Singapore (most common intl)
                'https://dashscope-us.aliyuncs.com/compatible-mode/v1',    // US Virginia
                'https://dashscope.aliyuncs.com/compatible-mode/v1',       // China Beijing
                'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1', // Hong Kong
                // Frankfurt requires workspaceId in path; only try if configured
                ...(workspaceId
                  ? [`https://${workspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1`]
                  : []),
              ];
              
              let models: DiscoveredModel[] = [];
              
              // Try both API keys with both regions
              for (const regionUrl of regions) {
                if (models.length > 0) break; // Stop if we got models
                
                // Try first API key
                let fetcher = new AlibabaModelFetcher(
                  apiKey1,
                  regionUrl,
                  process.env.ALIBABA_ACCESS_KEY_ID,
                  process.env.ALIBABA_ACCESS_KEY_SECRET
                );
                models = await fetcher.getModels();
                
                // If first key fails, try second key
                if (models.length === 0 && apiKey2) {
                  fetcher = new AlibabaModelFetcher(
                    apiKey2,
                    regionUrl,
                    process.env.ALIBABA_ACCESS_KEY_ID,
                    process.env.ALIBABA_ACCESS_KEY_SECRET
                  );
                  models = await fetcher.getModels();
                }
              }
              
              return models;
        },
      },
      {
        name: 'baidu-native',
        type: 'native_api',
        priority: 1,
        providers: ['baidu', 'ernie'],
        fetcher: async () => {
          const { BaiduModelFetcher } = await import('./model-fetchers/baidu-model-fetcher.js');
          // Baidu ERNIE requires both API Key (client_id) and Secret Key (client_secret) for OAuth2
          const apiKey = process.env.ERNIE_API_KEY || '';
          const secretKey = process.env.ERNIE_SECRET_KEY || undefined;
          const fetcher = new BaiduModelFetcher(apiKey, secretKey);
          return await fetcher.getModels();
        },
      },
    ];

    for (const source of nativeSources) {
      if (source.name && source.fetcher) {
        this.discoverySources.set(source.name, source as DiscoverySource);
      }
    }
  }

  /**
   * Adiciona fontes de hubs empresariais
   */
  private async addCloudHubSources() {
    const hubSources: Partial<DiscoverySource>[] = [
      {
        name: 'nvidia-first-party',
        type: 'cloud_hub',
        priority: 2,
        providers: ['nvidia'],
        fetcher: async () => {
          if (!process.env.NVIDIA_API_KEY) {
            this.log.info('NVIDIA credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'nvidia',
            apiKey: process.env.NVIDIA_API_KEY,
            baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'nvidia-hub-catalog',
        type: 'cloud_hub',
        priority: 2,
        providers: ['nvidia-hub', 'nvidiahub'],
        fetcher: async () => {
          if (!process.env.NVIDIA_API_KEY) {
            this.log.info('NVIDIA Hub credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'nvidia-hub',
            apiKey: process.env.NVIDIA_API_KEY,
            baseUrl: process.env.NVIDIA_HUB_BASE_URL || 'https://integrate.api.nvidia.com/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'aihubmix-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['aihubmix', 'aihub-mix'],
        fetcher: async () => {
          if (!process.env.AIHUBMIX_API_KEY) {
            this.log.info('AiHubMix credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'aihubmix',
            apiKey: process.env.AIHUBMIX_API_KEY,
            baseUrl: process.env.AIHUBMIX_BASE_URL || 'https://aihubmix.com/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'novita-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['novita'],
        fetcher: async () => {
          if (!process.env.NOVITA_API_KEY) {
            this.log.info('Novita credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'novita',
            apiKey: process.env.NOVITA_API_KEY,
            baseUrl: process.env.NOVITA_BASE_URL || 'https://api.novita.ai/openai/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'moonshot-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['moonshot', 'moonshot-ai'],
        fetcher: async () => {
          if (!process.env.MOONSHOT_API_KEY) {
            this.log.info('Moonshot credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'moonshot',
            apiKey: process.env.MOONSHOT_API_KEY,
            baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'minimax-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['minimax', 'mini-max'],
        fetcher: async () => {
          if (!process.env.MINIMAX_API_KEY) {
            this.log.info('MiniMax credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'minimax',
            apiKey: process.env.MINIMAX_API_KEY,
            baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1',
            modelListPaths: ['/models', '/v1/models'],
          });

          const discovered = await fetcher.getModels();
          if (discovered.length > 0) {
            return discovered;
          }

          const seededModelId = process.env.MINIMAX_SEED_MODEL || 'minimax-text-01';
          this.log.info({ seededModelId }, 'MiniMax discovery empty, using conservative seed fallback');

          return [
            {
              id: seededModelId,
              name: seededModelId,
              displayName: seededModelId,
              contextWindow: 65_536,
              maxOutputTokens: 4096,
              capabilities: ['chat', 'text_generation'],
              pricing: {
                inputCostPer1M: 0,
                outputCostPer1M: 0,
                currency: 'USD',
              },
              metadata: {
                source: 'minimax-seed',
                provider: 'minimax',
                executionProvider: 'minimax',
                seeded: true,
              },
            },
          ];
        },
      },
      {
        name: 'friendli-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['friendli', 'friendli-ai'],
        fetcher: async () => {
          if (!process.env.FRIENDLI_API_KEY) {
            this.log.info('Friendli credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'friendli',
            apiKey: process.env.FRIENDLI_API_KEY,
            baseUrl: process.env.FRIENDLI_BASE_URL || 'https://api.friendli.ai/serverless/v1',
            modelListPaths: ['/models', '/v1/models'],
            extraHeaders: {
              'X-Friendli-Team': process.env.FRIENDLI_TEAM_ID || '',
            },
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'aiml-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['aiml', 'aimlapi'],
        fetcher: async () => {
          const { AimlModelFetcher } = await import(
            './model-fetchers/aiml-model-fetcher.js'
          );

          const fetcher = new AimlModelFetcher({
            apiKey: process.env.AIML_API_KEY || '',
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'imagerouter-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['imagerouter', 'image-router'],
        fetcher: async () => {
          if (!process.env.IMAGEROUTER_API_KEY) {
            this.log.info('ImageRouter credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { ImageRouterModelFetcher } = await import(
            './model-fetchers/imagerouter-model-fetcher.js'
          );
          const fetcher = new ImageRouterModelFetcher(
            process.env.IMAGEROUTER_API_KEY || '',
            process.env.IMAGEROUTER_BASE_URL || 'https://api.imagerouter.io'
          );
          return await fetcher.getModels();
        },
      },
      {
        name: 'orqai-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['orqai', 'orq.ai', 'orq'],
        fetcher: async () => {
          if (!process.env.ORQAI_API_KEY) {
            this.log.info('ORQ.ai credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          // ORQ model catalog endpoint is documented under Platform API:
          // GET https://api.orq.ai/v2/models
          // Runtime execution stays on AI Router endpoint (/v2/router).
          const orqModelsBaseUrl = process.env.ORQAI_MODELS_BASE_URL || 'https://api.orq.ai';
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'orqai',
            apiKey: process.env.ORQAI_API_KEY,
            baseUrl: orqModelsBaseUrl,
            modelListPaths: ['/v2/models', '/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'edenai-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['edenai', 'eden.ai', 'eden'],
        fetcher: async () => {
          if (!process.env.EDENAI_API_KEY) {
            this.log.info('Eden AI credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'edenai',
            apiKey: process.env.EDENAI_API_KEY,
            baseUrl: process.env.EDENAI_BASE_URL || 'https://api.edenai.run/v3/llm',
            modelListPaths: ['/models', '/llm/models', '/info/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'heliconeai-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['heliconeai', 'helicone.ai', 'helicone'],
        fetcher: async () => {
          if (!process.env.HELICONEAI_API_KEY) {
            this.log.info('Helicone AI credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'heliconeai',
            apiKey: process.env.HELICONEAI_API_KEY,
            baseUrl: process.env.HELICONEAI_BASE_URL || 'https://ai-gateway.helicone.ai/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'cometapi-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['cometapi', 'comet-api', 'comet'],
        fetcher: async () => {
          if (!process.env.COMETAPI_API_KEY) {
            this.log.info('Comet API credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'cometapi',
            apiKey: process.env.COMETAPI_API_KEY,
            baseUrl: process.env.COMETAPI_BASE_URL || 'https://api.cometapi.com/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'nanogpt-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['nanogpt', 'nano-gpt'],
        fetcher: async () => {
          if (!process.env.NANOGPT_API_KEY) {
            this.log.info('Nano GPT credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'nanogpt',
            apiKey: process.env.NANOGPT_API_KEY,
            baseUrl: process.env.NANOGPT_BASE_URL || 'https://nano-gpt.com/api/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'requesty-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['requesty'],
        fetcher: async () => {
          if (!process.env.REQUESTY_API_KEY) {
            this.log.info('Requesty credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'requesty',
            apiKey: process.env.REQUESTY_API_KEY,
            baseUrl: process.env.REQUESTY_BASE_URL || 'https://router.requesty.ai/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        // Canonical providerId `ai302`; legacy names kept in `providers[]`
        // so cross-service lookups using the pre-migration id still find
        // this hub. The fetcher tags discovered models with the canonical
        // id so the model → adapter dispatch lands on the catalog-
        // registered adapter.
        name: 'ai302-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['ai302', '302ai', '302-ai', '302'],
        fetcher: async () => {
          if (!process.env.AI302_API_KEY) {
            this.log.info('302 AI credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'ai302',
            apiKey: process.env.AI302_API_KEY,
            // 302.ai serves /models at root (not under /v1), same pattern as AIML
            baseUrl: 'https://api.302.ai',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'poe-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['poe'],
        fetcher: async () => {
          if (!process.env.POE_API_KEY) {
            this.log.info('POE credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'poe',
            apiKey: process.env.POE_API_KEY,
            baseUrl: process.env.POE_BASE_URL || 'https://api.poe.com/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'routeway-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['routeway', 'route-way'],
        fetcher: async () => {
          if (!process.env.ROUTEWAY_API_KEY) {
            this.log.info('Routeway credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );

          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'routeway',
            apiKey: process.env.ROUTEWAY_API_KEY,
            baseUrl: process.env.ROUTEWAY_BASE_URL || 'https://api.routeway.ai/v1',
            modelListPaths: ['/models', '/v1/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'vertex-ai-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['google', 'vertex-ai'],
        fetcher: async () => {
          if (
            !process.env.VERTEX_AI_API_KEY &&
            !process.env.GOOGLE_API_KEY &&
            !process.env.GOOGLE_GENAI_API_KEY
          ) {
            this.log.info('Vertex AI credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { VertexAIModelFetcher } = await import('./model-fetchers/vertex-ai-model-fetcher.js');
          const fetcher = new VertexAIModelFetcher({
            apiKey:
              process.env.VERTEX_AI_API_KEY ||
              process.env.GOOGLE_API_KEY ||
              process.env.GOOGLE_GENAI_API_KEY,
            projectId: process.env.VERTEX_AI_PROJECT_ID,
            location: process.env.VERTEX_AI_LOCATION,
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'aws-bedrock-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['amazon', 'aws', 'bedrock'],
        fetcher: async () => {
          const { AWSBedrockModelFetcher } = await import(
            './model-fetchers/aws-bedrock-model-fetcher.js'
          );
          const fetcher = new AWSBedrockModelFetcher({
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            region: process.env.AWS_BEDROCK_REGION || 'us-east-1',
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'azure-openai-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['microsoft', 'azure', 'azure-openai'],
        fetcher: async () => {
          if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
            this.log.info('Azure OpenAI credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { AzureOpenAIModelFetcher } = await import(
            './model-fetchers/azure-openai-model-fetcher.js'
          );
          const fetcher = new AzureOpenAIModelFetcher({
            apiKey: process.env.AZURE_OPENAI_API_KEY,
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            defaultDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
            apiVersion: process.env.AZURE_OPENAI_API_VERSION,
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'oci-generative-ai-hub',
        type: 'cloud_hub',
        priority: 2,
        providers: ['oracle', 'oci'],
        fetcher: async () => {
          if (
            !process.env.OCI_TENANCY_ID ||
            !process.env.OCI_USER_ID ||
            !process.env.OCI_FINGERPRINT ||
            !process.env.OCI_PRIVATE_KEY ||
            !process.env.OCI_REGION
          ) {
            this.log.info('OCI credentials not configured, skipping cloud hub discovery');
            return [];
          }

          const { OCIModelFetcher } = await import('./model-fetchers/oci-model-fetcher.js');
          const fetcher = new OCIModelFetcher({
            tenancyId: process.env.OCI_TENANCY_ID,
            userId: process.env.OCI_USER_ID,
            fingerprint: process.env.OCI_FINGERPRINT,
            privateKey: process.env.OCI_PRIVATE_KEY,
            region: process.env.OCI_REGION,
          });
          return await fetcher.getModels();
        },
      },

      // ── Audio-First Providers (STT, TTS) ──────────────────
      // These adapters have their own getModels() that discover models from
      // their respective APIs. Added explicitly because addRegisteredAdapterSources()
      // runs before the ProviderRegistry is initialized (race condition).
      // ── Local CPU Inference Sidecars ──────────────────
      // Direct API calls to local sidecar containers. Each sidecar exposes
      // /v1/models (or /models) and auto-registers its models.
      {
        name: 'ollama-local',
        type: 'native_api',
        priority: 1,
        providers: ['ollama'],
        fetcher: async () => {
          const rawUrl = process.env.OLLAMA_URL;
          if (!rawUrl) return [];

          // OLLAMA_URL conventionally carries the /v1 suffix (execution
          // adapters append /chat/completions to it), but the discovery
          // paths below are rooted at the server root (/v1/models,
          // /api/tags). Strip a trailing /v1 so both URL shapes work —
          // same normalization translation-service applies.
          const baseUrl = rawUrl.replace(/\/v1\/?$/, '');

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'ollama',
            apiKey: 'ollama',
            baseUrl,
            modelListPaths: ['/v1/models', '/api/tags'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'local-llama-sidecar',
        type: 'native_api',
        priority: 1,
        providers: ['local-llama', 'llama-server', 'llama.cpp'],
        fetcher: async () => {
          const baseUrl = process.env.LOCAL_LLAMA_URL;
          if (!baseUrl) return [];

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'local-llama',
            apiKey: 'local',
            baseUrl,
            modelListPaths: ['/v1/models', '/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'local-kobold-sidecar',
        type: 'native_api',
        priority: 1,
        providers: ['local-kobold', 'koboldcpp'],
        fetcher: async () => {
          const baseUrl = process.env.LOCAL_KOBOLD_URL;
          if (!baseUrl) return [];

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'local-kobold',
            apiKey: 'local',
            baseUrl,
            modelListPaths: ['/v1/models', '/api/v1/model'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'local-embeddings-sidecar',
        type: 'native_api',
        priority: 1,
        providers: ['local-embeddings'],
        fetcher: async () => {
          const baseUrl = process.env.LOCAL_EMBEDDINGS_URL;
          if (!baseUrl) return [];

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'local-embeddings',
            apiKey: 'local',
            baseUrl,
            modelListPaths: ['/v1/models', '/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'local-ocr-sidecar',
        type: 'native_api',
        priority: 1,
        providers: ['local-ocr', 'paddleocr'],
        fetcher: async () => {
          const baseUrl = process.env.LOCAL_OCR_URL;
          if (!baseUrl) return [];

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'local-ocr',
            apiKey: 'local',
            baseUrl,
            modelListPaths: ['/v1/models', '/models'],
          });
          return await fetcher.getModels();
        },
      },
      {
        name: 'local-docling-sidecar',
        type: 'native_api',
        priority: 1,
        providers: ['local-docling', 'docling'],
        fetcher: async () => {
          const baseUrl = process.env.LOCAL_DOCLING_URL;
          if (!baseUrl) return [];

          const { OpenAICompatibleHubModelFetcher } = await import(
            './model-fetchers/openai-compatible-hub-model-fetcher.js'
          );
          const fetcher = new OpenAICompatibleHubModelFetcher({
            providerName: 'local-docling',
            apiKey: 'local',
            baseUrl,
            modelListPaths: ['/v1/models', '/models'],
          });
          return await fetcher.getModels();
        },
      },

      // ── Audio-First Providers (STT, TTS) ──────────────────
      // Direct API calls — do NOT depend on ProviderRegistry (which initializes
      // after the first discovery run). Each fetcher calls the provider API inline.
      {
        name: 'deepgram-audio',
        type: 'native_api',
        priority: 2,
        providers: ['deepgram'],
        fetcher: async () => {
          const apiKey = process.env.DEEPGRAM_API_KEY;
          if (!apiKey) return [];

          const baseUrl = process.env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com/v1';
          const resp = await fetch(`${baseUrl}/models`, {
            headers: { Authorization: `Token ${apiKey}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) return [];

          const data = await resp.json() as {
            stt?: Array<{ name: string; canonical_name?: string }>;
            tts?: Array<{ name: string; canonical_name?: string }>;
          };

          const models: DiscoveredModel[] = [];
          for (const m of data.stt || []) {
            models.push({
              id: `deepgram/${m.name}`, name: m.name,
              displayName: `Deepgram ${m.canonical_name || m.name} (STT)`,
              contextWindow: 0, maxOutputTokens: 0,
              capabilities: ['speech_to_text', 'streaming'],
              metadata: { provider: 'deepgram', modalities: ['audio'] },
            });
          }
          for (const m of data.tts || []) {
            models.push({
              id: `deepgram/${m.name}`, name: m.name,
              displayName: `Deepgram ${m.canonical_name || m.name} (TTS)`,
              contextWindow: 0, maxOutputTokens: 0,
              capabilities: ['text_to_speech', 'streaming'],
              metadata: { provider: 'deepgram', modalities: ['audio'] },
            });
          }
          return models;
        },
      },
      {
        name: 'cartesia-audio',
        type: 'native_api',
        priority: 2,
        providers: ['cartesia'],
        fetcher: async () => {
          const apiKey = process.env.CARTESIA_API_KEY;
          if (!apiKey) return [];

          const baseUrl = process.env.CARTESIA_BASE_URL || 'https://api.cartesia.ai';
          const resp = await fetch(`${baseUrl}/models`, {
            headers: {
              'X-API-Key': apiKey,
              'Cartesia-Version': '2024-06-10',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) return [];

          const data = await resp.json() as Array<{ id: string; name: string; description?: string }>;
          return (Array.isArray(data) ? data : []).map(m => ({
            id: `cartesia/${m.id}`, name: m.id,
            displayName: `Cartesia ${m.name} (TTS)`,
            contextWindow: 0, maxOutputTokens: 0,
            capabilities: ['text_to_speech', 'streaming'],
            metadata: { provider: 'cartesia', modalities: ['audio'] },
          }));
        },
      },
      {
        name: 'elevenlabs-audio',
        type: 'native_api',
        priority: 2,
        providers: ['elevenlabs'],
        fetcher: async () => {
          const apiKey = process.env.ELEVENLABS_API_KEY;
          if (!apiKey) return [];

          const baseUrl = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1';
          const resp = await fetch(`${baseUrl}/models`, {
            headers: { 'xi-api-key': apiKey },
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) return [];

          const data = await resp.json() as Array<{
            model_id: string; name: string;
            can_do_text_to_speech?: boolean;
          }>;
          return (Array.isArray(data) ? data : [])
            .filter(m => m.can_do_text_to_speech !== false)
            .map(m => ({
              id: `elevenlabs/${m.model_id}`, name: m.model_id,
              displayName: `ElevenLabs ${m.name} (TTS)`,
              contextWindow: 0, maxOutputTokens: 0,
              capabilities: ['text_to_speech', 'streaming'],
              metadata: { provider: 'elevenlabs', modalities: ['audio'] },
            }));
        },
      },
    ];

    for (const source of hubSources) {
      if (source.name && source.fetcher) {
        this.discoverySources.set(source.name, source as DiscoverySource);
      }
    }
  }

  /**
   * Adiciona fontes de routers/aggregators
   */
  /**
   * Dynamically registers discovery sources from all registered provider adapters.
   * This catches providers (e.g., Deepgram, Cartesia, ElevenLabs) that have
   * getModels() but are not covered by native API, cloud hub, or router fetchers.
   * Skips providers that already have a dedicated discovery source.
   */
  private async addRegisteredAdapterSources(): Promise<void> {
    try {
      const registry = getProviderRegistry();
      const allProviderNames = registry.getProviderNames();
      let added = 0;

      for (const providerName of allProviderNames) {
        // Skip if already covered by a dedicated source
        const existingSourceKey = Array.from(this.discoverySources.keys())
          .find(key => key.toLowerCase().includes(providerName.toLowerCase()));
        if (existingSourceKey) continue;

        const adapter = registry.get(providerName);
        if (!adapter) continue;

        const sourceName = `${providerName}-adapter`;
        this.discoverySources.set(sourceName, {
          name: sourceName,
          type: 'native_api',
          priority: 2,
          providers: [providerName],
          fetcher: async (): Promise<DiscoveredModel[]> => {
            try {
              const models = await adapter.getModels();
              if (!models || models.length === 0) return [];
              return models.map(m => ({
                id: m.id || `${providerName}/${m.name}`,
                name: m.name,
                displayName: m.displayName,
                contextWindow: m.contextWindow || 0,
                maxOutputTokens: m.maxOutputTokens || 0,
                capabilities: (m as { capabilities?: string[] }).capabilities || [],
                metadata: {
                  provider: providerName,
                  modalities: (m as { modalities?: string[] }).modalities || [],
                  endpoints: (m as { endpoints?: string[] }).endpoints || [],
                },
              }));
            } catch (err) {
              this.log.warn(
                { provider: providerName, error: err instanceof Error ? err.message : String(err) },
                'Adapter getModels() failed'
              );
              return [];
            }
          },
        });
        added++;
      }

      if (added > 0) {
        this.log.info({ added, total: allProviderNames.length }, 'Registered adapter discovery sources');
      }
    } catch (err) {
      // Provider registry may not be initialized yet — safe to skip
      this.log.debug({ error: err instanceof Error ? err.message : String(err) }, 'Skipping adapter sources (registry not ready)');
    }
  }

  /**
   * Aggregator discovery sources.
   *
   * Adds providers whose canonical inferenceable surface lives behind a
   * non-OpenAI-compatible metadata API and would not be covered by the
   * catalog-bridge OpenAICompatibleHubModelFetcher.
   *
   * Currently:
   *   - huggingface-hub: paginates https://huggingface.co/api/models
   *     with inference_provider=all (~58k models at time of writing).
   *
   * Each aggregator source registers under a name like `<provider>-hub` so the
   * catalog-bridge skip-detection (which matches `provider-` prefixes) treats
   * the provider as already covered and does not double-register the bridge
   * variant pointing at the OAI-compatible router (which only exposes a
   * subset).
   */
  private async addAggregatorSources(): Promise<void> {
    if (process.env.HF_HUB_DISCOVERY_DISABLED !== 'true') {
      this.discoverySources.set('huggingface-hub', {
        name: 'huggingface-hub',
        type: 'aggregator',
        priority: 8,
        providers: ['huggingface'],
        fetcher: async (): Promise<DiscoveredModel[]> => {
          const { HfHubModelFetcher } = await import('./model-fetchers/hf-hub-model-fetcher.js');
          const fetcher = new HfHubModelFetcher(process.env.HF_TOKEN);
          return await fetcher.getModels();
        },
      });
    }

    if (process.env.BYTEZ_DISCOVERY_DISABLED !== 'true') {
      this.discoverySources.set('bytez-native', {
        name: 'bytez-native',
        type: 'aggregator',
        priority: 8,
        providers: ['bytez'],
        fetcher: async (): Promise<DiscoveredModel[]> => {
          const { BytezNativeModelFetcher } = await import(
            './model-fetchers/bytez-native-model-fetcher.js'
          );
          const fetcher = new BytezNativeModelFetcher(process.env.BYTEZ_API_KEY || '');
          return await fetcher.getModels();
        },
      });
    }

    if (process.env.IMAGEROUTER_DISCOVERY_DISABLED !== 'true') {
      // ImageRouter's /v1/models is an object-map and /v2/models a bare array;
      // neither is the OpenAI `{ data: [] }` shape the hub fetcher expects (the
      // catalog row discovered 0 models). Register the dedicated fetcher here so
      // catalog-bridge skips it and the /v2 array is parsed instead.
      this.discoverySources.set('imagerouter-native', {
        name: 'imagerouter-native',
        type: 'aggregator',
        priority: 8,
        providers: ['imagerouter'],
        fetcher: async (): Promise<DiscoveredModel[]> => {
          const { ImageRouterModelFetcher } = await import(
            './model-fetchers/imagerouter-model-fetcher.js'
          );
          const fetcher = new ImageRouterModelFetcher(process.env.IMAGEROUTER_API_KEY || '');
          return await fetcher.getModels();
        },
      });
    }
  }

  /**
   * Catalog-bridge discovery sources.
   *
   * The 41 hardcoded sources cover native providers, cloud hubs, and the
   * historical aggregator set. The catalog (~81 entries) holds every other
   * provider — groq, fireworks-ai, togetherai, deepinfra, perplexity, etc.
   * Each catalog row is wired into the plugin manager via catalog-bridge,
   * but historically had no discovery source attached, so /v1/models was
   * never probed and the DB never grew past the 34 native+hub providers.
   *
   * This method synthesizes one source per qualifying catalog row:
   *   - Skip if a hardcoded source already covers the providerId.
   *   - Skip catalog-only mode (no adapter to call).
   *   - Skip denyByDefault (NSFW/policy-gated).
   *
   * The fetcher uses the plugin's OpenAICompatibleHubModelFetcher when
   * available (live HTTP GET to /models with the catalog-declared auth),
   * and falls back to plugin.listModels() which materializes staticModels
   * for execution-only rows.
   *
   * Plugin resolution is lazy (inside the fetcher closure) so this method
   * can run during initialization before the plugin manager has finished
   * registering catalog plugins — by the time runDiscoveryRound() invokes
   * the fetcher, all plugins are wired.
   */
  private async addCatalogProviderSources(): Promise<void> {
    try {
      const { PROVIDER_CATALOG } = await import('../providers/catalog/providers.catalog.js');
      const { isOpenAICompatibleEntry, normalizePinnedModelEntry } = await import(
        '../providers/catalog/provider-catalog.types.js'
      );
      const { OpenAICompatibleHubModelFetcher } = await import(
        './model-fetchers/openai-compatible-hub-model-fetcher.js'
      );

      let added = 0;
      let skippedCovered = 0;
      let skippedCatalogOnly = 0;
      let skippedDenied = 0;
      let skippedNotOaiCompat = 0;
      let skippedExecutionOnly = 0;

      for (const entry of PROVIDER_CATALOG) {
        // Skip if a dedicated source already covers this provider.
        const providerLc = entry.providerId.toLowerCase();
        const aliasesLc = (entry.aliases ?? []).map((a: string) => a.toLowerCase());
        const idsToCheck = [providerLc, ...aliasesLc];
        const existing = Array.from(this.discoverySources.keys()).find((key) => {
          const keyLc = key.toLowerCase();
          return idsToCheck.some(
            (id) => keyLc === id || keyLc.includes(`-${id}`) || keyLc.startsWith(`${id}-`)
          );
        });
        if (existing) {
          skippedCovered++;
          continue;
        }

        if (entry.integrationMode === 'catalog-only') {
          skippedCatalogOnly++;
          continue;
        }

        if (entry.denyByDefault === true) {
          skippedDenied++;
          continue;
        }

        // execution-only: provider exposes models via the catalog's pinned
        // fallback list (no /models endpoint to probe). Phase 4d (2026-04-28)
        // renamed `staticModels` to `pinnedFallback.models` with a richer
        // shape (closed `reason` enum + `lastReviewedAt`). The legacy
        // `staticModels` is honoured during the migration window so a partial
        // deploy cannot silently drop providers.
        const isExecutionOnly = entry.integrationMode === 'execution-only';
        // Resolve pinned-fallback entries. The new pinnedFallback shape allows
        // structured `{id, capabilities}` entries; the legacy staticModels is
        // string-only. Both flow through `normalizePinnedModelEntry` to the
        // canonical `{id, capabilities}` form (capabilities=[] for bare string
        // entries — the emit path falls back to regex inference for those).
        const rawPinnedEntries = entry.pinnedFallback?.models ?? entry.staticModels;
        const pinnedNormalised = rawPinnedEntries
          ? rawPinnedEntries.map(normalizePinnedModelEntry)
          : undefined;
        if (isExecutionOnly && (!pinnedNormalised || pinnedNormalised.length === 0)) {
          skippedExecutionOnly++;
          continue;
        }

        // Discovery via /models only makes sense for OAI-compatible listings;
        // native-only providers (Bedrock, Vertex, etc.) are covered by hardcoded
        // sources above. EXCEPTION: execution-only with pinnedFallback emits a
        // static list — no HTTP probe — so the OAI-compat shape is irrelevant.
        // Image-only providers like bfl/recraft fall in this exception bucket.
        if (!isExecutionOnly && !isOpenAICompatibleEntry(entry)) {
          skippedNotOaiCompat++;
          continue;
        }

        const sourceName = `catalog-${entry.providerId}`;
        const providerId = entry.providerId;
        const apiKeyEnvVar = entry.apiKeyEnvVar;
        const baseUrlEnvVar = entry.baseUrlEnvVar;
        const defaultBaseUrl = entry.baseUrl;
        const apiKeyOptional = entry.apiKeyOptional === true;
        const authHeaderName = entry.authHeaderName;
        const authScheme = mapCatalogAuthScheme(entry.authScheme);
        const modelListPaths = entry.paths?.modelList ? [...entry.paths.modelList] : undefined;
        const extraHeaders = entry.extraHeaders ? { ...entry.extraHeaders } : undefined;
        const modelDenylist = entry.modelDenylist ? [...entry.modelDenylist] : undefined;
        const pinnedModels = pinnedNormalised ? [...pinnedNormalised] : undefined;
        const log = this.log;

        this.discoverySources.set(sourceName, {
          name: sourceName,
          type: 'native_api',
          priority: 6,
          providers: [providerId],
          fetcher: async (): Promise<DiscoveredModel[]> => {
            // execution-only: emit pinned-fallback list directly, no HTTP probe.
            //
            // Capability source priority (root-cause refactor 2026-04-28):
            //   1. Operator-declared (structured `{id, capabilities}` entries
            //      in the catalog) — trusted as-is, no inference. Equivalent
            //      to `provider-declared` in the source-weight hierarchy.
            //   2. Name-regex fallback (legacy `staticModels` strings or bare
            //      `pinnedFallback.models[i]` strings) — confidence 0.20.
            //
            // Why operator-declared trumps regex: regex over the model id is
            // necessarily speculative ("does the name look like an embedding
            // model?"). The catalog row is hand-curated by a human who knows
            // exactly what each pinned model does — that's strictly stronger
            // evidence than any pattern can produce. The previous tagging gap
            // (Phase-10 follow-up: 18 of 26 capability-empty rows lived here
            // — atlascloud kling/seedream, databricks dbrx/mpt/bge/gte,
            // writer palmyra-*, avian kimi/glm) was the result of a single
            // bare-string list with no declared capabilities, falling through
            // to a regex table that didn't cover those families.
            //
            // Empty array remains the safety net: if neither operator-declared
            // nor regex inference produces anything, the model still surfaces
            // in /v1/models with capabilities:[] rather than being dropped.
            if (isExecutionOnly && pinnedModels) {
              return pinnedModels.map(({ id: modelId, capabilities: declared }) => {
                const capabilities =
                  declared.length > 0
                    ? [...declared]
                    : inferModelCapabilities({ modelId }) ?? [];
                return {
                  id: modelId,
                  name: modelId,
                  displayName: modelId,
                  contextWindow: 0,
                  maxOutputTokens: 0,
                  capabilities,
                  pricing: undefined,
                  metadata: {
                    originalProvider: providerId,
                    executionProvider: providerId,
                    source: sourceName,
                    fromStatic: true,
                    // Mark the source so downstream consumers (capability search,
                    // bandits, audits) can distinguish operator-declared from
                    // regex-inferred without re-running inference.
                    capabilitySource:
                      declared.length > 0 ? 'operator-declared' : 'name-regex',
                  },
                };
              });
            }

            const apiKey = process.env[apiKeyEnvVar] ?? '';
            if (!apiKey && !apiKeyOptional) {
              return [];
            }

            const baseUrl =
              (baseUrlEnvVar ? process.env[baseUrlEnvVar] : undefined) || defaultBaseUrl;
            if (!baseUrl) {
              return [];
            }

            try {
              const fetcher = new OpenAICompatibleHubModelFetcher({
                providerName: providerId,
                apiKey,
                baseUrl,
                modelListPaths,
                authHeaderName,
                authScheme,
                extraHeaders,
                modelDenylist,
              });

              const rawModels = await fetcher.getModels();
              // Each model is structurally an object — route the narrow
              // through the `narrowAs<>` helper so the cast is visible at a
              // single auditable site and the lint rule against
              // `as unknown as` stays clean.
              return narrowAs<Array<Record<string, unknown>>>(rawModels).map((m) => {
                const id = (m.id ?? m.name ?? '') as string;
                const upstreamMeta = narrowAs<Record<string, unknown>>(m.metadata) ?? {};
                // Preserve `owned_by` attribution that OpenAICompatibleHubModelFetcher
                // already extracted into metadata.originalProvider. For gateways
                // (Vercel, Cometapi, etc.) this is the CRITICAL signal that lets
                // the capability merger pin a model to its real upstream family
                // instead of the gateway itself. We only fall back to the catalog
                // providerId when the upstream did NOT declare an owner —
                // matches the Vercel adapter's `attributeFromDiscovery()` precedence
                // (owned_by > namespace parse > raw id).
                const upstreamOwner = upstreamMeta.originalProvider;
                const resolvedOriginalProvider =
                  typeof upstreamOwner === 'string' && upstreamOwner.length > 0
                    ? upstreamOwner
                    : providerId;
                const metadata: Record<string, unknown> = {
                  ...upstreamMeta,
                  originalProvider: resolvedOriginalProvider,
                  // executionProvider stays the catalog providerId — that's the
                  // adapter we'll route through, regardless of who owns the model.
                  executionProvider: providerId,
                  source: sourceName,
                };
                const declared = (m.capabilities as string[] | undefined) ?? [];
                // Fallback inference: if the upstream fetcher returned an empty
                // capability list, run regex/modality inference so families
                // like `omni-moderation-*`, `cohere-transcribe-*`, `rerank-*`,
                // and `aqa` aren't surfaced as untagged. Inference uses the
                // model id + the metadata bag we just assembled (so modalities
                // declared by the upstream API still drive the tagging).
                const capabilities =
                  declared.length > 0
                    ? declared
                    : inferModelCapabilities({ modelId: id, metadata });
                return {
                  id,
                  name: (m.name as string | undefined) ?? id,
                  displayName:
                    (m.displayName as string | undefined) ?? (m.name as string | undefined) ?? id,
                  contextWindow: (m.contextWindow as number | undefined) ?? 0,
                  maxOutputTokens: (m.maxOutputTokens as number | undefined) ?? 0,
                  capabilities,
                  pricing: m.pricing as DiscoveredModel['pricing'],
                  metadata,
                };
              });
            } catch (err) {
              log.warn(
                { providerId, err: err instanceof Error ? err.message : String(err) },
                'catalog-bridge fetcher threw'
              );
              return [];
            }
          },
        });
        added++;
      }

      this.log.info(
        {
          added,
          skippedCovered,
          skippedCatalogOnly,
          skippedDenied,
          skippedNotOaiCompat,
          skippedExecutionOnly,
          totalCatalog: PROVIDER_CATALOG.length,
        },
        'Catalog-bridge discovery sources registered'
      );
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to register catalog-bridge discovery sources'
      );
    }
  }

  private async addRouterSources() {
    const routerSources: Partial<DiscoverySource>[] = [
      {
        name: 'openrouter-aggregator',
        type: 'router',
        priority: 3,
        providers: ['*'], // All providers
        fetcher: async () => {
          const { OpenRouterModelFetcher } = await import(
            './model-fetchers/openrouter-model-fetcher.js'
          );
          const fetcher = new OpenRouterModelFetcher(process.env.OPENROUTER_API_KEY || '');
          return await fetcher.getModels();
        },
      },
      // Additional router integrations (e.g., Featherless.ai) can be registered here once their adapters are available.
    ];

    for (const source of routerSources) {
      if (source.name && source.fetcher) {
        this.discoverySources.set(source.name, source as DiscoverySource);
      }
    }
  }

  /**
   * Get the balance status map for all checked providers.
   * Returns a Map of providerName -> BalanceCheckResult.
   */
  getProviderBalanceStatus(): Map<string, BalanceCheckResult> {
    return this.providerBalanceStatus;
  }

  /**
   * Returns the set of provider names confirmed to have no credits.
   */
  getNoCreditsProviders(): Set<string> {
    const result = new Set<string>();
    for (const [provider, status] of this.providerBalanceStatus) {
      if (!status.hasCredits) {
        result.add(provider);
      }
    }
    return result;
  }

  /**
   * Mark a provider as having no credits (called by strategies on HTTP 402/403 runtime failures).
   * Closes the feedback loop: runtime failures update balance status for future selections.
   */
  markProviderNoCredits(providerName: string): void {
    const normalized = providerName.toLowerCase();
    this.providerBalanceStatus.set(normalized, { hasCredits: false, balance: 0, currency: 'USD' });
    this.log.info({ provider: normalized }, 'Provider marked as no-credits from runtime failure');
  }

  /** Local/self-hosted provider names that never need balance checks. */
  private static readonly LOCAL_PROVIDERS = new Set([
    'ollama', 'local-llama', 'local-kobold', 'local-embeddings',
    'local-ocr', 'local-docling', 'local-piper',
  ]);

  /**
   * Determine the balance status for a model based on its provider.
   * Uses the cached providerBalanceStatus from the last discovery run.
   */
  getModelBalanceStatus(providerName: string): 'has-credits' | 'no-credits' | 'unknown' | 'local' {
    const normalized = providerName.toLowerCase();
    if (CentralModelDiscoveryService.LOCAL_PROVIDERS.has(normalized) || normalized.startsWith('local-') || normalized.startsWith('self-hosted')) {
      return 'local';
    }
    const balanceResult = this.providerBalanceStatus.get(normalized);
    if (!balanceResult) {
      return 'unknown';
    }
    return balanceResult.hasCredits ? 'has-credits' : 'no-credits';
  }

  /**
   * Enrich an array of models with balanceStatus based on cached provider balance data.
   * Mutates models in-place for efficiency and returns the same array.
   */
  enrichModelsWithBalanceStatus(models: import('@/types').Model[]): import('@/types').Model[] {
    for (const model of models) {
      const provider = model.provider || '';
      // Also check executionProvider in metadata (hub models route through a different provider)
      const executionProvider = typeof model.metadata?.executionProvider === 'string'
        ? model.metadata.executionProvider
        : '';
      // Use the most specific provider (executionProvider takes precedence if present)
      const effectiveProvider = executionProvider || provider;
      model.balanceStatus = this.getModelBalanceStatus(effectiveProvider);
    }
    return models;
  }

  /**
   * Check balance/credits for all registered provider adapters.
   * Best-effort: failures are logged and skipped. Runs in parallel with a timeout.
   */
  private async checkProviderBalances(): Promise<void> {
    try {
      const registry = getProviderRegistry();
      const providerNames = registry.getProviderNames();

      // #3b balance→hub bridge: feed balance verdicts into the operability hub so
      // no_credits RECOVERS within one discovery cycle (~5min) on a credit top-up
      // — a healthy balance probe records a success, and runtime precedence then
      // clears no_credits independent of the persisted TTL — and is set
      // PROACTIVELY on depletion, not only after a user request hits a 402. This
      // closes the gap where checkBalance updated only the balance signal (#3
      // funding gate) but left the hub's no_credits gate stuck until probe/TTL.
      const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
      const opHub = getProviderOperabilityHub();

      const balanceChecks = providerNames.map(async (providerName) => {
        try {
          const adapter = registry.get(providerName);
          if (!adapter) return;

          // 5-second timeout per provider to avoid blocking discovery
          const timeoutPromise = new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), 5000);
          });

          const result = await Promise.race([
            adapter.checkBalance(),
            timeoutPromise,
          ]);

          if (result !== null) {
            this.providerBalanceStatus.set(providerName, result);
            // Bridge the verdict into the hub. A successful checkBalance implies
            // BOTH auth-ok and (if hasCredits) funded, so 'healthy' clears both
            // auth_failed and no_credits via runtime precedence; a zero balance
            // records 'insufficient_credit' proactively.
            opHub.recordProbeResult(
              providerName,
              result.hasCredits ? 'healthy' : 'insufficient_credit',
              result.hasCredits ? 'balance check: has credits' : 'balance check: no credits',
            );

            if (!result.hasCredits) {
              this.log.warn(
                {
                  provider: providerName,
                  balance: result.balance,
                  currency: result.currency,
                },
                'Provider has no credits — models may fail with HTTP 402/403'
              );
            } else {
              this.log.info(
                {
                  provider: providerName,
                  hasCredits: result.hasCredits,
                  balance: result.balance,
                  currency: result.currency,
                },
                'Provider balance check OK'
              );
            }
          }
        } catch (error) {
          this.log.info(
            {
              provider: providerName,
              error: error instanceof Error ? error.message : String(error),
            },
            'Balance check failed for provider (non-critical)'
          );
        }
      });

      await Promise.all(balanceChecks);

      const checkedCount = this.providerBalanceStatus.size;
      const noCreditsCount = Array.from(this.providerBalanceStatus.values()).filter(
        (s) => !s.hasCredits
      ).length;

      if (checkedCount > 0) {
        this.log.info(
          { checked: checkedCount, noCredits: noCreditsCount, total: providerNames.length },
          'Provider balance checks completed'
        );
      }
    } catch (error) {
      this.log.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Provider balance check sweep failed (non-critical)'
      );
    }
  }

  /**
   * Executa descoberta completa de todas as fontes simultaneamente.
   *
   * Race-condition guard: coalesces concurrent callers onto a single in-flight
   * discovery Promise. Without this, two simultaneous callers (e.g., index.ts
   * startup sync + model-discovery-runner startup trigger) would both race to
   * upsert the same models, producing `duplicate key violates unique constraint
   * "models_pkey"` errors on the `uid` field.
   */
  async discoverAllModels(): Promise<ModelDiscoveryResult[]> {
    if (this.inFlightDiscovery) {
      this.log.debug('discoverAllModels called while another discovery is in-flight — coalescing');
      return this.inFlightDiscovery;
    }
    this.inFlightDiscovery = this.runDiscoveryRound();
    try {
      return await this.inFlightDiscovery;
    } finally {
      this.inFlightDiscovery = null;
    }
  }

  private async runDiscoveryRound(): Promise<ModelDiscoveryResult[]> {
    await this.ensureInitialized();
    this.log.info('Starting comprehensive model discovery from all sources');

    const startTime = Date.now();
    const results: ModelDiscoveryResult[] = [];

    // Executa descoberta de todas as fontes em paralelo
    // Add timeout per source to prevent hanging (max 10 seconds per source)
    const discoveryPromises = Array.from(this.discoverySources.entries()).map(
      async ([sourceName, source]) => {
        const sourceStartTime = Date.now();

        try {
          this.log.info(
            { source: sourceName, type: source.type },
            'Starting discovery from source'
          );

          // Per-source timeout: aggregators paginate large catalogs (HF Hub
          // emits ~58k cursor pages, Bytez ships ~100k in one shot) and need
          // a much longer budget than native_api endpoints. Configurable via
          // env so operators can tighten or extend per environment.
          const timeoutMs = source.type === 'aggregator'
            ? Number(process.env.AGGREGATOR_DISCOVERY_TIMEOUT_MS || '120000')
            : Number(process.env.NATIVE_DISCOVERY_TIMEOUT_MS || '10000');
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Discovery timeout after ${timeoutMs}ms for ${sourceName}`)),
              timeoutMs,
            );
          });

          const models = await Promise.race([
            source.fetcher(),
            timeoutPromise,
          ]);

          // Processa e armazena modelos
          const result = await this.processDiscoveredModels(sourceName, source, models);

          const duration = Date.now() - sourceStartTime;

          // L1: Record source health — success
          this.recordSourceSuccess(sourceName, result.modelsDiscovered);

          this.log.info(
            {
              source: sourceName,
              modelsDiscovered: result.modelsDiscovered,
              duration,
            },
            'Discovery completed for source'
          );

          return {
            ...result,
            duration,
            timestamp: new Date(),
          };
        } catch (error) {
          const duration = Date.now() - sourceStartTime;
          const errorMessage = error instanceof Error ? error.message : String(error);

          // L1: Record source health — failure
          // Check if failure is retriable (key not loaded, timeout, etc.)
          const isKeyMissing = errorMessage.includes('mock') || errorMessage.includes('API key') || errorMessage.includes('credentials');
          const isTimeout = errorMessage.includes('timeout');
          this.recordSourceFailure(sourceName, errorMessage, isKeyMissing || isTimeout);

          // Don't log timeout errors as errors, just warnings
          if (isTimeout) {
            this.log.warn({ source: sourceName, duration }, 'Discovery timeout for source (provider may be slow or unavailable)');
          } else {
            this.log.warn({ source: sourceName, error: errorMessage }, 'Discovery failed for source (non-critical)');
          }

          return {
            source: sourceName,
            provider: source.providers.join(','),
            modelsDiscovered: 0,
            modelsUpdated: 0,
            modelsNew: 0,
            errors: [errorMessage],
            duration,
            timestamp: new Date(),
          };
        }
      }
    );

    // Aguarda todas as descobertas completarem
    const discoveryResults = await Promise.all(discoveryPromises);
    results.push(...discoveryResults);
    this.lastFullDiscovery = new Date();

    // L1: Also record failure for sources that returned 0 models (silent failure)
    for (const result of discoveryResults) {
      if (result.modelsDiscovered === 0 && result.errors.length === 0) {
        const health = this.sourceHealthMap.get(result.source);
        if (!health || health.modelsDiscoveredLast === 0) {
          // Source returned 0 models without error — likely empty API key
          this.recordSourceFailure(result.source, 'Zero models returned (empty API key?)', true);
        }
      }
    }

    // Registra estatísticas no banco
    await this.recordDiscoveryResults(results);

    // Invalida caches seletivamente - apenas para providers que foram descobertos
    // Isso preserva cache de outros providers e reduz impacto de performance
    const discoveredProviderIds = Array.from(
      new Set(results.flatMap((r) => (r.provider ? [r.provider] : [])))
    );
    await this.invalidateCaches(discoveredProviderIds);

    // Check provider balances/credits after model discovery (best-effort, non-blocking)
    await this.checkProviderBalances();

    const totalDuration = Date.now() - startTime;
    const noCreditsProviders = Array.from(this.getNoCreditsProviders());
    this.log.info(
      {
        sourcesProcessed: results.length,
        totalModels: results.reduce((sum, r) => sum + r.modelsDiscovered, 0),
        totalDuration,
        noCreditsProviders: noCreditsProviders.length > 0 ? noCreditsProviders : undefined,
      },
      'Comprehensive model discovery completed'
    );

    return results;
  }

  /**
   * Bulk upsert models using PostgreSQL native INSERT ... ON CONFLICT
   * This is much more efficient than individual upserts, reducing roundtrips and transaction overhead
   * 
   * @param models Array of normalized models to upsert
   * @param providerId Provider ID for all models
   * @param sourceName Source name for metadata
   * @param source Discovery source
   * @returns Object with counts of new and updated models
   */
  private async bulkUpsertModels(
    models: Array<{ model: DiscoveredModel; provider: string; normalizedModel: DiscoveredModel }>,
    providerId: string,
    sourceName: string,
    source: DiscoverySource
  ): Promise<{ new: number; updated: number }> {
    if (models.length === 0) {
      return { new: 0, updated: 0 };
    }

    // Batch size for bulk operations (adjust based on performance testing)
    const BATCH_SIZE = 100;
    let newCount = 0;
    let updatedCount = 0;

    // Deduplicate by model id so ON CONFLICT does not see the same row twice (avoids P2010/21000)
    const byId = new Map<string, (typeof models)[0]>();
    for (const m of models) {
      byId.set(m.normalizedModel.id, m);
    }
    const deduped = Array.from(byId.values());

    // Process in batches to avoid very large SQL statements
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      
      // Build VALUES clause for batch insert (includes uid for multi-provider PK)
      const values: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const { normalizedModel, provider: _provider } of batch) {
        const modelName = normalizedModel.name || normalizedModel.id;
        const capabilities = Array.isArray(normalizedModel.capabilities) ? normalizedModel.capabilities : [];
        const pricing = normalizedModel.pricing || { prompt: 0, completion: 0, currency: 'USD' };
        const inputCostPer1k = (pricing.inputCostPer1M ?? 0) / 1000;
        const outputCostPer1k = (pricing.outputCostPer1M ?? 0) / 1000;

        const metadataPayload: Record<string, unknown> = withNormalizedMetadata(
          {
            ...(normalizedModel.metadata ?? {}),
            source: sourceName,
            sourceType: source.type,
            sourcePriority: source.priority,
            discoveredAt: new Date().toISOString(),
            pricing,
          },
          capabilities,
        );

        const performancePayload = {
          latencyMs: 1000,
          throughput: 100,
          quality: 0.8,
          reliability: 0.95,
        };

        // uid = MD5(provider_id + ':' + model_id)[0:25] — deterministic surrogate PK
        const uid = computeModelUid(providerId, normalizedModel.id);

        values.push(
          `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12}, $${paramIndex + 13})`
        );

        params.push(
          uid, // uid (PK)
          normalizedModel.id, // id
          providerId, // provider_id
          modelName, // name
          normalizedModel.displayName || modelName, // display_name
          normalizedModel.contextWindow || 4096, // context_window
          normalizedModel.maxOutputTokens || 1024, // max_output_tokens
          inputCostPer1k, // input_cost_per_1k
          outputCostPer1k, // output_cost_per_1k
          JSON.stringify(capabilities), // capabilities (JSON)
          JSON.stringify(metadataPayload), // metadata (JSON)
          JSON.stringify(performancePayload), // performance (JSON)
          'active', // status
          new Date(), // updated_at
        );

        paramIndex += 14;
      }

      // Use PostgreSQL's INSERT ... ON CONFLICT on the PRIMARY KEY (uid).
      //
      // Why uid and not (id, provider_id):
      //   `uid` is the PRIMARY KEY (see models_pkey). Multiple discovery sources
      //   in parallel can generate the SAME uid (e.g., openai-native, aihubmix-hub,
      //   and cometapi-hub all report "openai/gpt-4o"). Each source runs its own
      //   INSERT concurrently in a different transaction. `ON CONFLICT (id, provider_id)`
      //   does NOT resolve conflicts on `uid` — so when two INSERTs race with the
      //   same uid, the second crashes with "duplicate key violates models_pkey".
      //
      //   `ON CONFLICT (uid)` makes the INSERT atomic at the PK level, so parallel
      //   sources converge to a single UPDATE without errors.
      //
      // Check which models exist before bulk upsert to track new vs updated counts
      const modelIds = batch.map(({ normalizedModel }) => normalizedModel.id);
      const existingModels = await prisma.model.findMany({
        where: { id: { in: modelIds }, providerId },
        select: { id: true },
      });
      const existingIds = new Set(existingModels.map((m) => m.id));

      const sql = `
        INSERT INTO models (
          uid, id, provider_id, name, display_name, context_window, max_output_tokens,
          input_cost_per_1k, output_cost_per_1k, capabilities, metadata, performance,
          status, updated_at
        ) VALUES ${values.join(', ')}
        ON CONFLICT (uid) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          context_window = EXCLUDED.context_window,
          max_output_tokens = EXCLUDED.max_output_tokens,
          input_cost_per_1k = EXCLUDED.input_cost_per_1k,
          output_cost_per_1k = EXCLUDED.output_cost_per_1k,
          capabilities = EXCLUDED.capabilities,
          metadata = EXCLUDED.metadata,
          performance = EXCLUDED.performance,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `;

      try {
        // Execute bulk upsert
        await prisma.$executeRawUnsafe(sql, ...params);
        
        // Count new vs updated based on pre-check
        for (const { normalizedModel } of batch) {
          if (existingIds.has(normalizedModel.id)) {
            updatedCount++;
          } else {
            newCount++;
          }
        }
      } catch (error) {
        this.log.error(
          { batchStart: i, batchSize: batch.length, error },
          'Failed to bulk upsert models batch'
        );
        // Fall back to individual upserts for this batch
        for (const { normalizedModel, provider } of batch) {
          try {
            const existing = await prisma.model.findFirst({
              where: { id: normalizedModel.id, providerId },
            });
            if (!existing) {
              await this.createNewModel(normalizedModel, provider, sourceName, source);
              newCount++;
            } else {
              const updated = await this.updateExistingModel(existing, normalizedModel, provider, sourceName, source);
              if (updated) {
                updatedCount++;
              }
            }
          } catch (individualError) {
            this.log.warn(
              { modelId: normalizedModel.id, error: individualError },
              'Failed to upsert model individually'
            );
          }
        }
      }
    }

    return { new: newCount, updated: updatedCount };
  }

  /**
   * Processa modelos descobertos e atualiza o banco de dados
   * Uses bulk upsert for efficiency (reduces roundtrips and transaction overhead)
   */
  private async processDiscoveredModels(
    sourceName: string,
    source: DiscoverySource,
    models: DiscoveredModel[]
  ): Promise<Omit<ModelDiscoveryResult, 'duration' | 'timestamp'>> {
    let modelsNew = 0;
    let modelsUpdated = 0;
    const errors: string[] = [];

    // Group models by provider for bulk processing
    const modelsByProvider = new Map<string, Array<{ model: DiscoveredModel; provider: string; normalizedModel: DiscoveredModel }>>();

    for (const model of models) {
      try {
        // Determine provider and normalize model
        const provider = this.determineModelProvider(model, source);
        const normalizedModel = this.enrichModelMetadata(model, provider, source);

        if (!modelsByProvider.has(provider)) {
          modelsByProvider.set(provider, []);
        }

        modelsByProvider.get(provider)!.push({
          model,
          provider,
          normalizedModel,
        });
      } catch (error) {
        errors.push(`Failed to prepare model ${model.id}: ${error instanceof Error ? error.message : String(error)}`);
        this.log.warn({ modelId: model.id, error }, 'Failed to prepare discovered model');
      }
    }

    // NOTE: We intentionally do NOT register "origin providers" extracted from
    // router/aggregator model ids. Those are the model's ORG/author (e.g. `crisy7`,
    // `allenai`, `asiryan`), NOT inference providers — registering each created
    // ~18.8k empty orphan provider rows (never read anywhere; `virtualProvider` is
    // write-only). The real execution providers (`huggingface`, `openrouter`, …) are
    // registered via modelsByProvider below — the only provider inventory that matters.

    // Process each provider's models in bulk
    for (const [provider, providerModels] of modelsByProvider.entries()) {
      try {
        // Ensure provider exists
        const providerRecord = await this.ensureProviderExists(provider, sourceName);

        // Bulk upsert models for this provider
        const result = await this.bulkUpsertModels(providerModels, providerRecord.id, sourceName, source);
        modelsNew += result.new;
        modelsUpdated += result.updated;
      } catch (error) {
        errors.push(`Failed to process provider ${provider}: ${error instanceof Error ? error.message : String(error)}`);
        this.log.warn({ provider, error }, 'Failed to bulk process models for provider');
        
        // Fall back to individual processing for this provider
        for (const { normalizedModel } of providerModels) {
          try {
            const existing = await prisma.model.findFirst({
              where: { id: normalizedModel.id },
            });
            if (!existing) {
              await this.createNewModel(normalizedModel, provider, sourceName, source);
              modelsNew++;
            } else {
              const updated = await this.updateExistingModel(existing, normalizedModel, provider, sourceName, source);
              if (updated) {
                modelsUpdated++;
              }
            }
          } catch (individualError) {
            errors.push(`Failed to process model ${normalizedModel.id}: ${individualError instanceof Error ? individualError.message : String(individualError)}`);
            this.log.warn({ modelId: normalizedModel.id, error: individualError }, 'Failed to process discovered model individually');
          }
        }
      }
    }

    return {
      source: sourceName,
      provider: source.providers.join(','),
      modelsDiscovered: models.length,
      modelsUpdated,
      modelsNew,
      errors,
    };
  }

  /**
   * Determina o provedor de um modelo baseado na fonte e metadados
   */
  private determineModelProvider(model: DiscoveredModel, source: DiscoverySource): string {
    const sourceProvider = this.resolveSourceExecutionProvider(source);
    if (sourceProvider) {
      return sourceProvider;
    }

    const metadataProvider = this.readProviderFromMetadata(model.metadata);
    if (metadataProvider) {
      return metadataProvider;
    }

    const inferredFromId = this.normalizeProviderId(inferProviderFromModelId(model.id));
    if (inferredFromId) {
      return inferredFromId;
    }

    return this.normalizeProviderId(source.name) || 'unknown';
  }

  /**
   * Garante metadados consistentes para cada modelo descoberto
   */
  private enrichModelMetadata(model: DiscoveredModel, provider: string, source: DiscoverySource): DiscoveredModel {
    const metadata: Record<string, unknown> = {
      ...(model.metadata || {}),
      discoverySource: source.name,
    };

    if (!('originalProvider' in metadata) || !metadata.originalProvider) {
      metadata.originalProvider = this.extractOriginalProviderFromId(model.id) || provider;
    }

    if (!('executionProvider' in metadata) || !metadata.executionProvider) {
      metadata.executionProvider =
        source.type === 'router' || source.type === 'aggregator'
          ? provider
          : (metadata.originalProvider as string);
    }

    const modalities = extractModelModalities(metadata);
    if (modalities.input.length > 0) {
      metadata.inputModalities = modalities.input;
    }
    if (modalities.output.length > 0) {
      metadata.outputModalities = modalities.output;
    }

    let capabilities = inferModelCapabilities({
      modelId: model.id,
      metadata,
      seedCapabilities: model.capabilities,
    });

    // Sanitize OpenAI legacy COMPLETIONS-ONLY models. davinci/babbage/curie and
    // gpt-3.5-turbo-instruct REQUIRE the /completions endpoint — hub fetchers
    // frequently default-tag them 'chat', which made the judge/selector pick them
    // for chatCompletion → "Model … requires completions endpoint" (wasted cascade
    // attempts, judgeFailed). These family names are OpenAI-legacy-specific, so the
    // pattern is safe (won't match gpt-4/claude/llama/mistral-instruct/etc.).
    if (/(?:davinci|babbage|curie|gpt-3\.5-turbo-instruct)/i.test(model.id)) {
      capabilities = capabilities.filter((c) => String(c) !== 'chat');
      if (!capabilities.some((c) => String(c) === 'completions')) {
        capabilities = [...capabilities, 'completions' as (typeof capabilities)[number]];
      }
    }

    return {
      ...model,
      capabilities,
      metadata,
    };
  }

  private extractOriginalProviderFromId(modelId: string): string | undefined {
    return inferProviderFromModelId(modelId);
  }

  /**
   * Cria um novo modelo no banco de dados
   */
  private async createNewModel(
    model: DiscoveredModel,
    provider: string,
    sourceName: string,
    source: DiscoverySource
  ): Promise<void> {
    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
    const pricing = model.pricing || { prompt: 0, completion: 0, currency: 'USD' };
    const providerRecord = await this.ensureProviderExists(provider, sourceName);
    const modelName = model.name || model.id;

    // Check if model with this ID + provider already exists
    const existingById = await prisma.model.findFirst({
      where: { id: model.id, providerId: providerRecord.id },
    });

    if (existingById) {
      // Model with this ID already exists, update it instead
      await this.updateExistingModel(existingById, model, provider, sourceName, source);
      return;
    }

    // Check if model with same providerId + name exists (composite unique constraint)
    const existingByProviderAndName = await prisma.model.findFirst({
      where: {
        providerId: providerRecord.id,
        name: modelName,
      },
    });

    if (existingByProviderAndName) {
      await this.updateExistingModel(existingByProviderAndName, model, provider, sourceName, source);
      return;
    }

    // Try to create the model using transaction to handle race conditions atomically
    // This prevents unique constraint violations when multiple discovery processes run in parallel
    // We use a transaction with retry logic to ensure atomicity
    const maxRetries = 3;
    let lastError: unknown;

    // Use advisory lock to prevent concurrent inserts of the same model across processes
    // PostgreSQL advisory locks use bigint values, we'll generate a hash from the model ID
    const lockId = `model_${model.id}`.substring(0, 63).replace(/[^a-zA-Z0-9_]/g, '_');
    // Generate a deterministic bigint hash from the lock ID
    let lockHash = 0n;
    for (let i = 0; i < lockId.length; i++) {
      lockHash = (lockHash * 31n + BigInt(lockId.charCodeAt(i))) % BigInt(2 ** 63);
    }
    // Ensure positive value (PostgreSQL advisory locks require positive bigint)
    if (lockHash < 0n) {
      lockHash = -lockHash;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use advisory lock + transaction to ensure atomicity across processes
        // ReadCommitted isolation level allows better concurrency than Serializable
        // while advisory locks prevent race conditions on the same model
        await prisma.$transaction(
          async (tx) => {
            // I7 fix: Use pg_try_advisory_xact_lock (non-blocking) instead of pg_advisory_xact_lock.
            // When many providers discover the same model simultaneously, blocking locks queue up
            // database connections, potentially exhausting the pool. Non-blocking + retry is safer:
            // if the lock is held, we skip this attempt and retry on next loop iteration.
            const [lockResult] = await tx.$queryRaw<[{ pg_try_advisory_xact_lock: boolean }]>`
              SELECT pg_try_advisory_xact_lock(${lockHash})
            `;
            if (!lockResult.pg_try_advisory_xact_lock) {
              // Lock held by another process — skip this attempt, will retry
              throw Object.assign(new Error('Advisory lock not acquired, retrying'), { code: 'LOCK_BUSY' });
            }

            // Now check and create/update within the locked transaction
            // First check if model exists by ID + provider (composite unique)
            const existingById = await tx.model.findFirst({
              where: { id: model.id, providerId: providerRecord.id },
            });

            if (existingById) {
              // Model exists, update it by uid (PK)
              await tx.model.update({
                where: { uid: existingById.uid },
                data: {
                  displayName: model.displayName || modelName,
                  contextWindow: model.contextWindow || 4096,
                  maxOutputTokens: model.maxOutputTokens || 1024,
                  inputCostPer1k: new Prisma.Decimal((pricing.inputCostPer1M ?? 0) / 1000),
                  outputCostPer1k: new Prisma.Decimal((pricing.outputCostPer1M ?? 0) / 1000),
                  capabilities,
                  metadata: withNormalizedMetadata(
                    {
                      ...model.metadata,
                      source: sourceName,
                      sourceType: source.type,
                      sourcePriority: source.priority,
                      discoveredAt: new Date().toISOString(),
                      pricing,
                    },
                    capabilities,
                  ),
                  status: 'active',
                },
              });
              return;
            }

            // Check if model exists by providerId + name (composite unique constraint)
            const existingByProviderAndName = await tx.model.findFirst({
              where: {
                providerId: providerRecord.id,
                name: modelName,
              },
            });

            if (existingByProviderAndName) {
              // Update existing model by uid (PK)
              await tx.model.update({
                where: { uid: existingByProviderAndName.uid },
                data: {
                  displayName: model.displayName || modelName,
                  contextWindow: model.contextWindow || 4096,
                  maxOutputTokens: model.maxOutputTokens || 1024,
                  inputCostPer1k: new Prisma.Decimal((pricing.inputCostPer1M ?? 0) / 1000),
                  outputCostPer1k: new Prisma.Decimal((pricing.outputCostPer1M ?? 0) / 1000),
                  capabilities,
                  metadata: withNormalizedMetadata(
                    {
                      ...model.metadata,
                      source: sourceName,
                      sourceType: source.type,
                      sourcePriority: source.priority,
                      discoveredAt: new Date().toISOString(),
                      pricing,
                    },
                    capabilities,
                  ),
                  status: 'active',
                },
              });
              return;
            }

            // Model doesn't exist, use upsert to handle race conditions
            // Uses composite unique (id, providerId) for multi-provider support
            const uid = computeModelUid(providerRecord.id, model.id);
            await tx.model.upsert({
              where: {
                id_providerId: {
                  id: model.id,
                  providerId: providerRecord.id,
                },
              },
              update: {
                // Update metadata even if model exists (in case source changed)
                displayName: model.displayName || modelName,
                contextWindow: model.contextWindow || 4096,
                maxOutputTokens: model.maxOutputTokens || 1024,
                inputCostPer1k: new Prisma.Decimal((pricing.inputCostPer1M ?? 0) / 1000),
                outputCostPer1k: new Prisma.Decimal((pricing.outputCostPer1M ?? 0) / 1000),
                capabilities,
                metadata: withNormalizedMetadata(
                  {
                    ...model.metadata,
                    source: sourceName,
                    sourceType: source.type,
                    sourcePriority: source.priority,
                    discoveredAt: new Date().toISOString(),
                    pricing,
                  },
                  capabilities,
                ),
                status: 'active',
                updatedAt: new Date(),
              },
              create: {
                uid,
                id: model.id,
                name: modelName,
                displayName: model.displayName || modelName,
                providerId: providerRecord.id,
                contextWindow: model.contextWindow || 4096,
                maxOutputTokens: model.maxOutputTokens || 1024,
                inputCostPer1k: new Prisma.Decimal((pricing.inputCostPer1M ?? 0) / 1000),
                outputCostPer1k: new Prisma.Decimal((pricing.outputCostPer1M ?? 0) / 1000),
                capabilities,
                metadata: withNormalizedMetadata(
                  {
                    ...model.metadata,
                    source: sourceName,
                    sourceType: source.type,
                    sourcePriority: source.priority,
                    discoveredAt: new Date().toISOString(),
                    pricing,
                  },
                  capabilities,
                ),
                status: 'active',
                performance: {
                  latencyMs: 1000,
                  throughput: 100,
                  quality: 0.8,
                  reliability: 0.95,
                },
              },
            });
          },
          {
            isolationLevel: 'ReadCommitted', // Balanced: prevents dirty reads, allows concurrency
            timeout: 10000, // 10 second timeout
            maxWait: 5000, // Max wait for transaction start
          }
        );

        // Success, exit retry loop
        return;
      } catch (error: unknown) {
        lastError = error;

        // I7 fix: Handle non-blocking advisory lock miss (LOCK_BUSY) with short backoff
        if (error instanceof Error && (error as { code?: string }).code === 'LOCK_BUSY') {
          if (attempt < maxRetries) {
            const delay = 30 * Math.pow(2, attempt - 1); // 30ms, 60ms, 120ms
            this.log.debug(
              { attempt, maxRetries, delay, modelId: model.id },
              'Advisory lock busy, retrying after short delay'
            );
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            continue;
          }
          // All retries failed to get lock — model is being processed by another instance
          this.log.debug(
            { modelId: model.id, providerId: providerRecord.id },
            'Model lock not acquired after max retries — another process is handling this model'
          );
          return; // Safe to skip — other process will create/update
        }

        // Check if it's a unique constraint violation using type-safe helper
        if (isUniqueConstraintError(error)) {
          const constraintFields = getUniqueConstraintFields(error);
          // Unique constraint violation - this can happen in race conditions
          if (attempt < maxRetries) {
            // Wait with exponential backoff before retry
            const delay = 50 * Math.pow(2, attempt - 1); // 50ms, 100ms, 200ms
            this.log.debug(
              { attempt, maxRetries, delay, modelId: model.id, constraintFields },
              'Unique constraint violation, retrying after delay'
            );
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            continue;
          }

          // Max retries exceeded - model was likely created by another process
          this.log.warn(
            { modelId: model.id, modelName, providerId: providerRecord.id, attempts: attempt, constraintFields },
            'Model creation failed after max retries - model may have been created by concurrent process'
          );
          return; // Silently continue - model exists now
        }

        // For non-constraint errors, re-throw immediately
        throw error;
      }
    }

    // If we get here, all retries failed
    if (lastError) {
      throw lastError;
    }
  }

  /**
   * Atualiza um modelo existente se houver mudanças significativas
   */
  private async updateExistingModel(
    existing: PrismaModel,
    model: DiscoveredModel,
    provider: string,
    sourceName: string,
    source: DiscoverySource
  ): Promise<boolean> {
    // Use Prisma's update input type for type safety
    const updates: Prisma.ModelUpdateInput = {};
    let changed = false;

    if (existing.providerId !== provider) {
      updates.provider = { connect: { id: provider } };
      changed = true;
    }

    // Verifica mudanças de preço (use inputCostPer1M/outputCostPer1M — canonical fields from discovery)
    const inputPer1M = model.pricing?.inputCostPer1M ?? model.pricing?.prompt ?? 0;
    const outputPer1M = model.pricing?.outputCostPer1M ?? model.pricing?.completion ?? 0;
    const newInputCost = inputPer1M / 1000;
    const newOutputCost = outputPer1M / 1000;

    if (Number(existing.inputCostPer1k) !== newInputCost) {
      updates.inputCostPer1k = new Prisma.Decimal(newInputCost);
      changed = true;
    }

    if (Number(existing.outputCostPer1k) !== newOutputCost) {
      updates.outputCostPer1k = new Prisma.Decimal(newOutputCost);
      changed = true;
    }

    // Verifica mudanças de capacidades
    const newCapabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
    const existingCapabilities = existing.capabilities && Array.isArray(existing.capabilities) ? existing.capabilities : [];
    if (JSON.stringify(existingCapabilities.sort()) !== JSON.stringify(newCapabilities.sort())) {
      updates.capabilities = newCapabilities;
      changed = true;
    }

    // Verifica mudanças de contexto
    if (existing.contextWindow !== model.contextWindow) {
      updates.contextWindow = model.contextWindow;
      changed = true;
    }

    // Convert existing.metadata (JsonValue) to a plain object for spreading
    const existingMetadataObj = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown>
      : {};
    
    const metadataPayload: Record<string, unknown> = withNormalizedMetadata(
      {
        ...existingMetadataObj,
        ...(model.metadata ?? {}),
        source: sourceName,
        sourceType: source.type,
        lastUpdated: new Date().toISOString(),
        pricing: model.pricing,
      },
      newCapabilities,
    );

    const existingMetadataString = JSON.stringify(existing.metadata ?? {});
    const newMetadataString = JSON.stringify(metadataPayload);

    if (existingMetadataString !== newMetadataString) {
      updates.metadata = metadataPayload as Prisma.InputJsonValue;
      updates.updatedAt = new Date();
      changed = true;
    }

    if (changed) {
      await prisma.model.update({
        where: { uid: existing.uid },
        data: updates,
      });
    }

    return changed;
  }

  private defaultExecutionProviderForSource(source: DiscoverySource): string {
    return this.resolveSourceExecutionProvider(source) || this.normalizeProviderId(source.name) || source.name;
  }

  private readStringMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string
  ): string | undefined {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private normalizeProviderId(value?: string): string | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!normalized) return undefined;
    return PROVIDER_ID_ALIASES[normalized] || normalized;
  }

  private readProviderFromMetadata(metadata?: Record<string, unknown>): string | undefined {
    if (!metadata) return undefined;

    const keys = [
      'executionProvider',
      'execution_provider',
      'provider',
      'providerId',
      'provider_id',
      'originalProvider',
      'original_provider',
      'vendor',
      'sourceProvider',
      'source_provider',
    ];

    for (const key of keys) {
      const raw = this.readStringMetadata(metadata, key);
      const normalized = this.normalizeProviderId(raw);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

  private resolveSourceExecutionProvider(source: DiscoverySource): string | undefined {
    // OpenRouter router/aggregator special-case:
    //   The openrouter source is a gateway (`providers: ['*']`) — every model
    //   discovered through it is attributed as an `openrouter` row regardless of
    //   the upstream's `originalProvider`, because runtime execution is routed
    //   through openrouter's API. Keeping this shortcut preserves attribution
    //   for the openrouter-aggregator router.
    if (source.name.includes('openrouter')) {
      return 'openrouter';
    }

    // Provider-bound aggregators (NEW class added in Phase 0):
    //   `huggingface-hub` (providers: ['huggingface']) and `bytez-native`
    //   (providers: ['bytez']) declare a single execution provider. Their
    //   models MUST be attributed to that provider — NOT to 'openrouter',
    //   which was the historical default for `type === 'aggregator'` when
    //   openrouter was the only aggregator. Removing that blanket shortcut
    //   was the fix for the 2026-04-28 misattribution bug where 58,079
    //   HuggingFace Hub models landed under provider_id='openrouter'.
    const candidates = source.providers
      .filter((provider) => provider !== '*')
      .map((provider) => this.normalizeProviderId(provider))
      .filter((provider): provider is string => Boolean(provider));

    if (candidates.length === 0) {
      // Router-style source with `providers: ['*']` and no explicit provider:
      // defer to per-model originalProvider resolution downstream.
      return undefined;
    }
    if (candidates.length === 1) {
      // Aggregator with a single declared provider — single source of truth.
      return candidates[0];
    }

    for (const preferred of EXECUTION_PROVIDER_PRIORITY) {
      if (candidates.includes(preferred)) {
        return preferred;
      }
    }

    return candidates[candidates.length - 1];
  }

  /**
   * Garante que o provedor existe no banco
   * Uses upsert to handle race conditions when multiple discovery processes run in parallel
   */
  private async ensureProviderExists(
    provider: string,
    sourceName: string,
    metadataOverrides?: Record<string, unknown>
  ): Promise<Provider> {
    try {
      // Use upsert to atomically create or update provider, preventing race conditions
      const nowIso = new Date().toISOString();
      const baseMetadata: Record<string, unknown> = {
        discoveredBy: sourceName,
        discoveredAt: nowIso,
      };

      const existing = await prisma.provider.upsert({
        where: { name: provider },
        update: {
          updatedAt: new Date(),
        },
        create: {
          id: provider,
          name: provider,
          displayName: this.formatProviderName(provider),
          status: 'active',
          metadata: {
            ...baseMetadata,
            ...(metadataOverrides || {}),
          } as Prisma.InputJsonValue,
        },
      });

      if (metadataOverrides && Object.keys(metadataOverrides).length > 0) {
        const currentMetadata =
          existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
            ? (existing.metadata as Record<string, unknown>)
            : {};

        // Camada 5: IDEMPOTENCY guard. This extra metadata-merge UPDATE was firing
        // on EVERY call for an already-registered provider — e.g. the HF-router
        // virtual providers re-touched on each request — re-writing identical
        // metadata and causing lock contention (~5.7s observed on the hot path).
        // Skip it when every override value is already present. baseMetadata is
        // intentionally NOT part of the check (its discoveredAt changes each call,
        // and a timestamp refresh is not worth a contended write on the hot path).
        const alreadyApplied = Object.entries(metadataOverrides).every(
          ([k, v]) => currentMetadata[k] === v,
        );
        if (!alreadyApplied) {
          await prisma.provider.update({
            where: { id: existing.id },
            data: {
              metadata: {
                ...currentMetadata,
                ...baseMetadata,
                ...metadataOverrides,
              } as Prisma.InputJsonValue,
              updatedAt: new Date(),
            },
          });
        }
      }

      return existing;
    } catch (error: unknown) {
      // If upsert fails (shouldn't happen, but handle gracefully), try to fetch existing
      if (isUniqueConstraintError(error)) {
        const existing = await prisma.provider.findUnique({
          where: { name: provider },
        });
        if (existing) {
          return existing;
        }
      }
      // Re-throw if it's not a unique constraint error or provider doesn't exist
      throw error;
    }
  }

  /**
   * Gera tags para o modelo
   */
  private generateTags(model: DiscoveredModel, provider: string): string[] {
    const tags: string[] = [provider];

    if (model.contextWindow && model.contextWindow > 100000) tags.push('large-context');
    if (model.pricing?.prompt && model.pricing.prompt < 0.0001) tags.push('cost-effective');

    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
    if (capabilities.includes('vision')) tags.push('multimodal');
    if (capabilities.includes('function_calling')) tags.push('tools');
    if (capabilities.includes('streaming')) tags.push('streaming');

    return tags;
  }

  /**
   * Infere especializações baseado nas capacidades
   */
  private inferSpecializations(capabilities: string[]): string[] {
    const specializations: string[] = [];

    if (capabilities.includes('code_interpreter')) {
      specializations.push('code-generation', 'debugging');
    }

    if (capabilities.includes('vision')) {
      specializations.push('image-analysis', 'multimodal');
    }

    if (capabilities.includes('function_calling')) {
      specializations.push('tool-use', 'automation');
    }

    if (capabilities.includes('reasoning')) {
      specializations.push('analysis', 'problem-solving');
    }

    return specializations;
  }

  /**
   * Formata nome de provedor para display
   */
  private formatProviderName(provider: string): string {
    const nameMap: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      google: 'Google DeepMind',
      mistral: 'Mistral AI',
      deepseek: 'DeepSeek',
      cohere: 'Cohere',
      xai: 'xAI',
      'x-ai': 'xAI',
      qwen: 'Alibaba Qwen',
      alibaba: 'Alibaba Cloud',
      baidu: 'Baidu',
      ernie: 'Baidu Ernie',
      'vertex-ai': 'Google Vertex AI',
      'azure-openai': 'Azure OpenAI',
      aws: 'Amazon Web Services',
      bedrock: 'AWS Bedrock',
      oci: 'Oracle Cloud',
      openrouter: 'OpenRouter',
      nvidia: 'NVIDIA',
      'nvidia-hub': 'NVIDIA Hub',
      aihubmix: 'AiHubMix',
      novita: 'Novita',
      moonshot: 'Moonshot AI',
      minimax: 'MiniMax',
      jina: 'Jina AI',
      friendli: 'Friendli',
      aiml: 'AIML API',
      imagerouter: 'ImageRouter',
      orqai: 'ORQ.ai',
      edenai: 'Eden AI',
      heliconeai: 'Helicone AI Gateway',
      cometapi: 'Comet API',
      nanogpt: 'Nano GPT',
      requesty: 'Requesty',
      ai302: '302.AI',
      poe: 'POE',
      routeway: 'Routeway',
      deepgram: 'Deepgram',
      cartesia: 'Cartesia',
      elevenlabs: 'ElevenLabs',
      ollama: 'Ollama (Local)',
      'local-llama': 'Local LLM (llama.cpp)',
      'local-kobold': 'Local VLM (KoboldCpp)',
      'local-embeddings': 'Local Embeddings',
      'local-ocr': 'Local OCR (PaddleOCR)',
      'local-docling': 'Local DocAI (Docling)',
      'local-piper': 'Local TTS (Piper)',
    };

    return nameMap[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  /**
   * Registra resultados da descoberta no banco
   */
  private async recordDiscoveryResults(results: ModelDiscoveryResult[]) {
    for (const _result of results) {
      // Discovery log persistence will be enabled once the corresponding database table is available.
    }
  }

  /**
   * Invalida caches após descoberta
   * 
   * Strategy: Selective invalidation instead of full clear
   * - Only invalidate affected provider/model caches
   * - Preserve other cached data (reduces cache churn)
   * - Use cache tags for efficient bulk invalidation
   */
  private async invalidateCaches(providerIds?: string[]) {
    try {
      if (providerIds && providerIds.length > 0) {
        // Selective invalidation: only clear caches for affected providers
        // This preserves cache for other providers and reduces performance impact
        for (const providerId of providerIds) {
          try {
            // Invalidate provider-specific cache keys
            await this.cache.delete(`models:provider:${providerId}`);
            await this.cache.delete(`models:provider:${providerId}:active`);
            await this.cache.delete(`provider:${providerId}:models`);
          } catch (error) {
            this.log.debug({ providerId, error }, 'Failed to invalidate provider cache');
          }
        }
        this.log.info({ providerIds }, 'Selective cache invalidation completed');
      } else {
        // Fallback: full cache clear only when provider list unavailable
        // This is less efficient but ensures consistency
        await this.cache.clear();
        this.log.info('Full model caches invalidated after discovery (fallback)');
      }

      // Model catalog endpoints rely on ModelCacheService (LRU + Redis `model:*` keys).
      // Clear it after discovery to avoid stale capabilities being served.
      await modelCacheService.invalidateAll();
    } catch (error) {
      this.log.warn({ error }, 'Failed to invalidate caches');
    }
  }

  /**
   * Retorna estatísticas do serviço central
   */
  async getStats(): Promise<CentralDiscoveryStats> {
    await this.ensureInitialized();
    const [totalModels, totalProviders] = await Promise.all([
      prisma.model.count(),
      prisma.provider.count(),
    ]);
    type ScheduleSummary = {
      id: string;
      name: string;
      enabled: boolean;
      lastRun?: string;
      nextRun?: string;
      priority: number;
    };

    const schedulerStatus = getModelDiscoveryScheduler().getStatus();
    const nextScheduleDate =
      schedulerStatus.schedules
        .map((schedule: ScheduleSummary) => (schedule.nextRun ? new Date(schedule.nextRun) : null))
        .filter((date): date is Date => Boolean(date))
        .sort((a: Date, b: Date) => a.getTime() - b.getTime())[0] || null;

    // Discovery history persistence remains disabled until the logging table is introduced.
    // const lastDiscovery = await prisma.discoveryLog.findFirst({
    //   orderBy: { timestamp: 'desc' },
    // });
    // const discoveryHistory = await prisma.discoveryLog.findMany({
    //   take: 10,
    //   orderBy: { timestamp: 'desc' },
    // });
    // Discovery history persistence remains disabled until the logging table is introduced.
    // const lastDiscovery = await prisma.discoveryLog.findFirst({
    //   orderBy: { timestamp: 'desc' },
    // });
    // const discoveryHistory = await prisma.discoveryLog.findMany({
    //   take: 10,
    //   orderBy: { timestamp: 'desc' },
    // });
    // `lastDiscovery` would come from a future `discoveryLog` table; placeholder
    // is kept in the report shape (line 3338) but the local intermediate is
    // not needed.
    const discoveryHistory: ModelDiscoveryResult[] = [];

    // Conta fontes por tipo
    const sourcesByType: Record<string, number> = {};
    for (const [_, source] of this.discoverySources) {
      sourcesByType[source.type] = (sourcesByType[source.type] || 0) + 1;
    }

    // Mapeia provedores por fonte
    const providersBySource: Record<string, string[]> = {};
    for (const [sourceName, source] of this.discoverySources) {
      providersBySource[sourceName] = source.providers;
    }

    return {
      totalSources: this.discoverySources.size,
      totalProviders,
      totalModels,
      lastDiscovery: null, // Discovery history persistence remains disabled until the logging table is introduced
      nextScheduled: nextScheduleDate,
      sourcesByType,
      providersBySource,
      discoveryHistory,
    };
  }

  /**
   * Descoberta específica por fonte
   */
  async discoverFromSource(sourceName: string): Promise<ModelDiscoveryResult | null> {
    await this.ensureInitialized();
    const source = this.discoverySources.get(sourceName);
    if (!source) {
      this.log.warn({ sourceName }, 'Source not found');
      return null;
    }

    const startTime = Date.now();

    try {
      const models = await source.fetcher();
      const result = await this.processDiscoveredModels(sourceName, source, models);

      const duration = Date.now() - startTime;

      const finalResult: ModelDiscoveryResult = {
        ...result,
        duration,
        timestamp: new Date(),
      };

      await this.recordDiscoveryResults([finalResult]);
      // Selective cache invalidation: invalidate only providers declared by this discovery source.
      // DiscoveredModel does not carry provider; provider is inferred inside processing via the source.
      // If the source uses wildcard providers ('*'), fall back to full cache clear to ensure consistency.
      const discoveredProviderIds = source.providers.filter((p) => p !== '*');
      await this.invalidateCaches(discoveredProviderIds.length ? discoveredProviderIds : undefined);

      return finalResult;
    } catch (error) {
      this.log.error({ sourceName, error }, 'Discovery failed for specific source');
      return null;
    }
  }
}

let centralDiscoveryInstance: CentralModelDiscoveryService | null = null;

export async function getCentralModelDiscoveryService(): Promise<CentralModelDiscoveryService> {
  if (!centralDiscoveryInstance) {
    centralDiscoveryInstance = new CentralModelDiscoveryService();
  }

  await centralDiscoveryInstance.ready();
  return centralDiscoveryInstance;
}
