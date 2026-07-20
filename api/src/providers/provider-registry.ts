// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Registry
 * Centralized management of all LLM providers
 */

import { ProviderAdapter } from './base/provider-adapter';
import { OpenAIAdapter } from './openai/openai-adapter';
import { AnthropicAdapter } from './anthropic/anthropic-adapter';
import { GoogleAdapter } from './google/google-adapter';
import { VertexAIAdapter } from './vertex-ai/vertex-ai-adapter';
// AWSBedrockAdapter is constructed via its catalog factory binding (see
// providers.catalog.ts) — the legacy switch case was removed 2026-06-11.
import { AWSSageMakerAdapter, type AWSSageMakerAdapterConfig, type SageMakerPayloadSchema } from './aws-sagemaker/aws-sagemaker-adapter';
import { DeepSeekAdapter } from './deepseek/deepseek-adapter';
import { MistralAdapter } from './mistral/mistral-adapter';
import { XAIAdapter } from './xai/xai-adapter';
import { CohereAdapter } from './cohere/cohere-adapter';
import { OpenRouterAdapter, type OpenRouterConfig } from './openrouter/openrouter-adapter';
import { JinaAdapter } from './jina/jina-adapter';
import { DeepgramAdapter } from './deepgram/deepgram-adapter';
import { CartesiaAdapter } from './cartesia/cartesia-adapter';
import { ElevenLabsAdapter } from './elevenlabs/elevenlabs-adapter';
import { SelfHostedAdapter } from './self-hosted/self-hosted-adapter';
import { PalabraAIAdapter } from './palabraai/palabraai-adapter';
import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from './openai-compatible-hub/openai-compatible-hub-adapter';
import type { Provider, Model, ProviderConfig } from '@/types';
import { logger } from '@/utils/logger';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';
import { modelCacheService } from '@/services/model-cache-service';
import { modelCatalogService } from '@/services/model-catalog-service';
import { resolveModelOperability, type ModelOperability } from './provider-operability';

/**
 * Provider Registry - Manages all provider adapters
 */
export class ProviderRegistry {
  private providers: Map<string, ProviderAdapter> = new Map();
  private log = logger.child({ component: 'provider-registry' });

  getModelOperability(model: Model): ModelOperability {
    return resolveModelOperability(model, (providerName) => this.providers.get(providerName));
  }

  resolveAdapterForModel(model: Model): {
    adapter: ProviderAdapter | null;
    operability: ModelOperability;
  } {
    const operability = this.getModelOperability(model);
    if (!operability.runnable || !operability.resolvedProvider) {
      return { adapter: null, operability };
    }

    const adapter = this.providers.get(operability.resolvedProvider) || null;
    if (!adapter) {
      return {
        adapter: null,
        operability: {
          ...operability,
          runnable: false,
          nonOperationalReasons: Array.from(
            new Set([...operability.nonOperationalReasons, 'resolved_provider_adapter_missing'])
          ),
        },
      };
    }

    return { adapter, operability };
  }

  /**
   * Register a provider adapter
   */
  register(adapter: ProviderAdapter): void {
    const name = adapter.getName();

    if (this.providers.has(name)) {
      this.log.warn({ provider: name }, 'Provider already registered, replacing');
    }

    this.providers.set(name, adapter);
    this.log.info({ provider: name }, 'Provider registered');
  }

  /**
   * Get a provider adapter by name
   */
  get(name: string): ProviderAdapter | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all registered providers
   */
  getAll(): ProviderAdapter[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all provider names
   */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if provider is registered
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Unregister a provider adapter
   */
  unregister(name: string): boolean {
    const existed = this.providers.has(name);
    if (existed) {
      this.providers.delete(name);
      this.log.info({ provider: name }, 'Provider unregistered');
    }
    return existed;
  }

  /**
   * Get provider information for all providers
   */
  async getAllProviders(): Promise<Provider[]> {
    const providers: Provider[] = [];

    for (const adapter of this.providers.values()) {
      try {
        const provider = await adapter.getProvider();
        providers.push(provider);
      } catch (error) {
        this.log.error({ provider: adapter.getName(), error }, 'Failed to get provider info');
      }
    }

    return providers;
  }

  /**
   * Get all models from all providers
   */
  async getAllModels(): Promise<Model[]> {
    return modelCatalogService.listModels();
  }

  /**
   * Find model by ID across all providers with dynamic operability fallback.
   *
   * Strategy:
   * 1. Try preferredProvider first (if specified)
   * 2. Try the first DB entry
   * 3. If not operational, iterate ALL entries for this model ID and try each
   *    until one has a registered adapter (= provider with valid API key)
   *
   * No hardcoded provider lists — operability is checked dynamically via
   * resolveAdapterForModel() which verifies adapter registration in the registry.
   */
  async findModel(modelId: string, preferredProvider?: string): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    // Determinism (2026-06-29): a popular id exists under MANY providers (e.g.
    // gpt-oss-20b under huggingface/phala/aihubmix/together). Picking the FIRST
    // catalog entry meant trying dead variants (phala 401 / aihubmix 403) before a
    // good one — non-deterministic "sometimes hits on attempt N". Now PREFER the
    // proven-operable route (operability hub) and SKIP proven-bad ones; fall back
    // to any-adapter only as a last resort so we never regress to null.
    const hub = getProviderOperabilityHub();
    const opRank = (provider: string): number => {
      const st = hub.getRouteState(provider, modelId).operabilityState;
      if (st === 'healthy') return 4;
      if (st === 'recovering' || st === 'degraded') return 3;
      if (st === 'unknown') return 2;
      return 0; // auth_failed / no_credits / rate_limited / temporarily_unavailable
    };

    // 1. Preferred provider — but only if it is NOT proven-bad.
    if (preferredProvider) {
      const model = await modelCatalogService.getModel(modelId, preferredProvider);
      if (model && opRank(preferredProvider) > 0) {
        const resolution = this.resolveAdapterForModel(model);
        if (resolution.adapter) return { model, adapter: resolution.adapter };
      }
    }

    // 2. All entries, ranked by PROVEN operability — prefer the operable variant,
    //    skip the proven-bad ones (the deterministic core).
    const allEntries = await modelCatalogService.getAllEntriesForModel(modelId);
    const ranked = [...allEntries].sort((a, b) => opRank(b.provider) - opRank(a.provider));
    for (const model of ranked) {
      if (opRank(model.provider) === 0) continue; // skip proven-bad providers
      const resolution = this.resolveAdapterForModel(model);
      if (resolution.adapter) {
        this.log.info(
          { modelId, resolvedProvider: model.provider, totalEntries: allEntries.length },
          'Model resolved to proven-operable provider',
        );
        return { model, adapter: resolution.adapter };
      }
    }

    // 3. Last resort: any entry with an adapter (even unproven/bad — better than null).
    for (const model of ranked) {
      const resolution = this.resolveAdapterForModel(model);
      if (resolution.adapter) {
        this.log.warn(
          { modelId, resolvedProvider: model.provider },
          'No proven-operable provider — using last-resort variant',
        );
        return { model, adapter: resolution.adapter };
      }
    }

    this.log.warn(
      { modelId, preferredProvider, entriesChecked: allEntries.length },
      'No operational provider found for model across all entries',
    );
    return null;
  }

  /**
   * Find model by ID using 3-tier cache (optimized for hundreds of models)
   *
   * Performance:
   *   - Tier 1 hit (in-memory): < 1ms
   *   - Tier 2 hit (Redis): < 5ms
   *   - Tier 3 hit (Database): < 50ms
   *   - Average with 500 models: < 8ms
   */
  async findModelCached(
    modelId: string
  ): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    // Try 3-tier cache first
    const model = await modelCacheService.get(modelId);

    if (!model) {
      return null;
    }

    const resolution = this.resolveAdapterForModel(model);
    if (!resolution.adapter) {
      return null;
    }

    return { model, adapter: resolution.adapter };
  }

  /**
   * Bulk find models (optimized for multi-model orchestration up to 9 models)
   *
   * Critical for strategies that use 6-9 models simultaneously
   * Performance: < 20ms for 9 models
   */
  async bulkFindModels(
    modelIds: string[]
  ): Promise<Map<string, { model: Model; adapter: ProviderAdapter }>> {
    const results = new Map<string, { model: Model; adapter: ProviderAdapter }>();

    // Use 3-tier bulk get
    const models = await modelCacheService.bulkGet(modelIds);

    for (const [id, model] of models.entries()) {
      const resolution = this.resolveAdapterForModel(model);
      if (resolution.adapter) {
        results.set(id, { model, adapter: resolution.adapter });
      }
    }

    return results;
  }

  /**
   * Find model by name (tries to match across providers)
   */
  async findModelByName(
    modelName: string
  ): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    const allModels = await this.getAllModels();

    // Try exact match first
    let model = allModels.find((m) => m.name === modelName);

    // Try case-insensitive match
    if (!model) {
      model = allModels.find((m) => m.name.toLowerCase() === modelName.toLowerCase());
    }

    // Try normalized match (each provider's normalizer)
    if (!model) {
      for (const adapter of this.providers.values()) {
        const normalized = adapter.normalizeModelName(modelName);
        model = allModels.find((m) => m.name === normalized && m.provider === adapter.getName());
        if (model) break;
      }
    }

    if (!model) {
      return null;
    }

    const resolution = this.resolveAdapterForModel(model);
    if (!resolution.adapter) {
      return null;
    }

    return { model, adapter: resolution.adapter };
  }

  /**
   * Health check all providers
   */
  async healthCheckAll(): Promise<
    Record<string, { healthy: boolean; latency?: number; error?: string }>
  > {
    const results: Record<string, { healthy: boolean; latency?: number; error?: string }> = {};

    await Promise.all(
      Array.from(this.providers.entries()).map(async ([name, adapter]) => {
        try {
          const result = await adapter.healthCheck();
          results[name] = {
            healthy: result.healthy,
            latency: result.latency,
            error: result.error,
          };
        } catch (error) {
          results[name] = {
            healthy: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    return results;
  }

  /**
   * Get count of registered providers
   */
  count(): number {
    return this.providers.size;
  }

  /**
   * Clear all providers (mainly for testing)
   */
  clear(): void {
    this.providers.clear();
    this.log.info('All providers cleared');
  }
}

function providerApiKeyCandidates(providerName: string): string[] {
  const normalized = providerName.trim().toLowerCase();
  const defaults = [`${normalized.toUpperCase().replace(/-/g, '_')}_API_KEY`];

  if (normalized === 'nvidia-hub') {
    return ['NVIDIA_API_KEY', 'NVIDIA_HUB_API_KEY', ...defaults];
  }

  // ──────────────────────────────────────────────────────────────────────
  // PERMANENT STRUCTURAL EXCEPTION — `302ai` → `AI302_API_KEY`
  //
  // This is NOT a migration residue. It's retained as a permanent backward-
  // compat shim because three structural realities make it necessary:
  //
  //   1. The providerId regex requires a leading alpha character
  //      (`/^[a-z][a-z0-9]*.../`), so the user-facing brand "302.AI"
  //      cannot be the canonical ID. The catalog uses `ai302` as canonical
  //      and declares `['302ai','302-ai','302']` as aliases.
  //
  //   2. The default env-var derivation
  //        `${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`
  //      would produce `302AI_API_KEY` for the legacy name — a string that
  //      Node accepts via `process.env['302AI_API_KEY']` but which cannot
  //      be set by standard shell `export` syntax (digit-leading) or by
  //      dotenv/CI tooling that validates POSIX identifiers. Routing legacy
  //      configs to `AI302_API_KEY` avoids that trap.
  //
  //   3. Legacy `'302ai'` strings remain referenced in:
  //        - central-model-discovery-service.ts alias normalization map
  //        - openai-compatible-hub-adapter.ts balance-URL lookup table
  //      so the string is a permanent legacy identity, not a to-remove TODO.
  //
  // Reviewed and ratified as permanent on 2026-04-22.
  // ──────────────────────────────────────────────────────────────────────
  if (normalized === '302ai') {
    return ['AI302_API_KEY', ...defaults];
  }

  return defaults;
}

function resolveProviderApiKey(providerName: string, fallback?: string): string {
  const candidates = providerApiKeyCandidates(providerName);
  for (const candidate of candidates) {
    const value = process.env[candidate];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return fallback || '';
}

/**
 * Initialize provider registry from configuration
 */
export async function initializeProviderRegistry(
  providersConfig: ProviderConfig[]
): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry();
  const initializedAdapters: ProviderAdapter[] = [];

  // Filter providers - re-evaluate enabled status at initialization time when secrets are available
  // This is critical because secrets are loaded AFTER config creation but BEFORE provider initialization
  // Also update config.apiKey from environment if it was loaded from secrets
  const enabledProviders = providersConfig
    .map((p) => {
      // Re-check API key availability (may have been loaded from secrets after config creation)
      const apiKeyFromEnv = resolveProviderApiKey(p.name);
      const _apiKey = p.apiKey || apiKeyFromEnv;
      
      // Update config with API key from environment if available
      if (apiKeyFromEnv && !p.apiKey) {
        return { ...p, apiKey: apiKeyFromEnv };
      }
      
      return p;
    })
    .filter((p) => {
      const apiKey = p.apiKey || resolveProviderApiKey(p.name);
      
      // For providers with API keys, check if key is present (may have been loaded from secrets)
      if (apiKey.length > 0) {
        return true;
      }
      
      // For vertex-ai, also check PROJECT_ID
      if (p.name === 'vertex-ai') {
        const projectId = process.env.VERTEX_AI_PROJECT_ID;
        return !!projectId;
      }
      
      return false;
    });

  logger.info(
    { 
      totalConfigs: providersConfig.length, 
      enabledCount: enabledProviders.length,
      enabledProviders: enabledProviders.map(p => p.name)
    },
    'Provider filtering at initialization time'
  );

  for (const config of enabledProviders) {
    try {
      let adapter: ProviderAdapter | null = null;

      // Create appropriate adapter based on provider name
      switch (config.name.toLowerCase()) {
        case 'openai':
          adapter = new OpenAIAdapter(config);
          break;

        case 'anthropic':
          adapter = new AnthropicAdapter(config);
          break;

        case 'google':
          adapter = new GoogleAdapter(config);
          break;

        case 'deepseek':
          adapter = new DeepSeekAdapter(config);
          break;

        case 'mistral':
          adapter = new MistralAdapter(config);
          break;

        case 'xai':
          adapter = new XAIAdapter(config);
          break;

        case 'cohere':
          adapter = new CohereAdapter(config);
          break;

        case 'openrouter': {
          // OpenRouterConfig extends ProviderConfig, so we can use config directly
          // appUrl and appName are optional and can be passed if needed
          const openRouterConfig: OpenRouterConfig = {
            ...config,
            // If metadata exists and has these properties, use them
            ...(typeof config === 'object' && config !== null && 'metadata' in config && typeof (config as { metadata?: unknown }).metadata === 'object' && (config as { metadata?: Record<string, unknown> }).metadata !== null
              ? {
                  appUrl: (config as { metadata?: Record<string, unknown> }).metadata?.appUrl as string | undefined,
                  appName: (config as { metadata?: Record<string, unknown> }).metadata?.appName as string | undefined,
                }
              : {}),
          };
          adapter = new OpenRouterAdapter(openRouterConfig);
          break;
        }

        // ─── Switch cases for non-catalog self-hosted sidecars ────────────
        //
        // History:
        //   • Lot B (2026-04-22) consolidated 17 duplicated cases into
        //     `providers.catalog.ts` (LOTE E migration block).
        //   • Residue-closure pass A (2026-04-22) removed `302ai` by
        //     migrating it to the catalog as `ai302` with
        //     `['302ai','302-ai','302']` aliases — the env-var prefix
        //     quirk disappears once the canonical id matches the
        //     convention (`AI302_API_KEY` ← `ai302`).
        //   • Residue-closure pass B (2026-04-22) removed the four
        //     catalog-duplicated self-hosted cases (`ollama`,
        //     `local-llama`, `local-kobold`, `local-embeddings`) — the
        //     catalog path owns them now via `baseUrlEnvVar` opt-in
        //     (`OLLAMA_URL`, `LOCAL_LLAMA_URL`, …). Their entries were
        //     also removed from `config/index.ts` so the switch never
        //     sees them and no "Unknown provider" warn is emitted.
        //
        // What remains: five self-hosted sidecars that are NOT
        // OpenAI-compatible on their normalized surface (OCR, PDF→JSON,
        // translation, TTS). The catalog's `integrationClass` enum only
        // covers OAI-compatible shapes today, so these can't move into
        // a catalog row without new classes. Until then, they live here
        // as a documented structural exception.
        //
        // ⚠️ DO NOT ADD NEW PROVIDERS HERE. New providers are data-rows in
        // `providers.catalog.ts` + (if non-OAI-compat) a dedicated adapter
        // factory in `default-adapter-factories.ts`.
        case 'local-ocr':
        case 'local-docling':
        case 'local-nllb':
        case 'local-cosyvoice':
        case 'local-piper': {
          const HUB_DISPLAY_NAMES: Record<string, string> = {
            'local-ocr': 'Local OCR (PaddleOCR)',
            'local-docling': 'Local DocAI (Docling)',
            'local-nllb': 'Local Translation (NLLB-200)',
            'local-cosyvoice': 'Local TTS (CosyVoice2)',
            'local-piper': 'Local TTS (Piper)',
          };
          const hubConfig = config as ProviderConfig & { metadata?: Record<string, unknown> };
          const hubAdapterConfig: OpenAICompatibleHubAdapterConfig = {
            ...config,
            providerName: config.name,
            displayName: HUB_DISPLAY_NAMES[config.name] ?? config.name,
            metadata:
              hubConfig.metadata && typeof hubConfig.metadata === 'object'
                ? (hubConfig.metadata as OpenAICompatibleHubAdapterConfig['metadata'])
                : undefined,
          };
          adapter = new OpenAICompatibleHubAdapter(hubAdapterConfig);
          break;
        }

        case 'jina': {
          const configWithMetadata = config as ProviderConfig & {
            metadata?: {
              apiBaseUrl?: string;
              deepSearchBaseUrl?: string;
              readerBaseUrl?: string;
              searchBaseUrl?: string;
            };
          };
          adapter = new JinaAdapter({
            ...config,
            apiBaseUrl: configWithMetadata.metadata?.apiBaseUrl,
            deepSearchBaseUrl: configWithMetadata.metadata?.deepSearchBaseUrl || config.baseUrl,
            readerBaseUrl: configWithMetadata.metadata?.readerBaseUrl,
            searchBaseUrl: configWithMetadata.metadata?.searchBaseUrl,
          });
          break;
        }

        case 'vertex-ai': {
          // Vertex AI requires projectId and optional location/useExpressMode
          // Access metadata from config (it's added in config/index.ts)
          const configWithMetadata = config as ProviderConfig & {
            metadata?: { projectId?: string; location?: string; useExpressMode?: boolean };
          };
          const vertexConfig = {
            ...config,
            projectId: configWithMetadata.metadata?.projectId || '',
            location: configWithMetadata.metadata?.location || 'us-central1',
            useExpressMode: configWithMetadata.metadata?.useExpressMode === true,
          };
          adapter = new VertexAIAdapter(vertexConfig);
          break;
        }

        // 'aws-bedrock' is intentionally NOT a switch case: Bedrock is served
        // by its catalog entry (integrationClass=first-party-native with the
        // AwsBedrockAdapter factory binding — see providers.catalog.ts). The
        // legacy case here was unreachable (no config.providers entry uses
        // name 'aws-bedrock') and violated the catalog∩switch=∅ invariant
        // (matrix-integrity test). Removed 2026-06-11.

        case 'aws-sagemaker': {
          // AWS SageMaker — like Bedrock but per-endpoint. Endpoint name +
          // payload schema (openai / jumpstart / hf-tgi) can come from
          // config.metadata or AWS_SAGEMAKER_* env vars.
          const configWithMetadata = config as ProviderConfig & {
            metadata?: {
              region?: string;
              accessKeyId?: string;
              secretAccessKey?: string;
              sessionToken?: string;
              endpointName?: string;
              payloadSchema?: SageMakerPayloadSchema;
              customAttributes?: string;
            };
          };
          const sagemakerConfig: AWSSageMakerAdapterConfig = {
            ...config,
            region:
              configWithMetadata.metadata?.region ||
              process.env.AWS_SAGEMAKER_REGION ||
              process.env.AWS_REGION,
            accessKeyId:
              configWithMetadata.metadata?.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey:
              configWithMetadata.metadata?.secretAccessKey ||
              process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken:
              configWithMetadata.metadata?.sessionToken || process.env.AWS_SESSION_TOKEN,
            endpointName:
              configWithMetadata.metadata?.endpointName ||
              process.env.AWS_SAGEMAKER_ENDPOINT_NAME,
            payloadSchema:
              configWithMetadata.metadata?.payloadSchema ||
              (process.env.AWS_SAGEMAKER_PAYLOAD_SCHEMA as SageMakerPayloadSchema | undefined),
            customAttributes:
              configWithMetadata.metadata?.customAttributes ||
              process.env.AWS_SAGEMAKER_CUSTOM_ATTRIBUTES,
          };
          adapter = new AWSSageMakerAdapter(sagemakerConfig);
          break;
        }

        // ── Audio-First Providers ──────────────────
        case 'deepgram':
          adapter = new DeepgramAdapter(config);
          break;

        case 'cartesia':
          adapter = new CartesiaAdapter(config);
          break;

        case 'elevenlabs':
          adapter = new ElevenLabsAdapter(config);
          break;

        case 'palabraai': {
          const palabraConfig = config as ProviderConfig & { metadata?: { clientId?: string; clientSecret?: string } };
          adapter = new PalabraAIAdapter({
            ...config,
            clientId: palabraConfig.metadata?.clientId,
            clientSecret: palabraConfig.metadata?.clientSecret,
          });
          break;
        }

        case 'self-hosted':
          adapter = new SelfHostedAdapter(config);
          break;

        default:
          logger.warn({ provider: config.name }, 'Unknown provider, skipping');
          continue;
      }

      if (adapter) {
        const adapterName = adapter.getName();
        registry.register(adapter);
        initializedAdapters.push(adapter);
        logger.info(
          { provider: config.name, adapterName, registeredName: adapterName },
          'Provider adapter registered successfully'
        );
      } else {
        logger.warn({ provider: config.name }, 'Adapter was null, not registered');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(
        {
          provider: config.name,
          error: errorMessage,
          stack: errorStack,
          errorDetails: error,
        },
        'Failed to initialize provider'
      );
    }
  }

  if (initializedAdapters.length === 0) {
    logger.warn('No provider adapters initialized; model catalog sync skipped');
  }

  // Batch 8.2 — Multi-deployment expansion.
  //
  // Operators who need N Azure / Databricks / SageMaker deployments set the
  // corresponding JSON env var (AZURE_OPENAI_DEPLOYMENTS, etc.). The
  // registrar parses, builds, and registers N adapters under distinct
  // `<parent>-<alias>` names. No-op when the env vars aren't set —
  // zero impact on the single-deployment path above.
  try {
    const { registerMultiDeploymentProviders } = await import(
      './catalog/multi-deployment-registrar.js'
    );
    const multi = await registerMultiDeploymentProviders(registry);
    if (multi.totalRegistered > 0) {
      logger.info(
        {
          azure: multi.azure.length,
          databricks: multi.databricks.length,
          sagemaker: multi.sagemaker.length,
          total: multi.totalRegistered,
        },
        'Multi-deployment providers registered',
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      { error: errorMessage },
      'Multi-deployment registrar threw — single-deployment providers unaffected',
    );
  }

  const registeredProviderNames = registry.getProviderNames();
  logger.info(
    { 
      providerCount: registry.count(), 
      providers: registeredProviderNames,
      initializedAdaptersCount: initializedAdapters.length,
      initializedAdapterNames: initializedAdapters.map(a => a.getName())
    },
    'Provider registry initialized'
  );
  
  // Verify that all initialized adapters were registered
  if (initializedAdapters.length !== registeredProviderNames.length) {
    logger.warn(
      {
        initializedCount: initializedAdapters.length,
        registeredCount: registeredProviderNames.length,
        initializedNames: initializedAdapters.map(a => a.getName()),
        registeredNames: registeredProviderNames,
      },
      'Mismatch between initialized adapters and registered providers'
    );
  }

  return registry;
}

/**
 * Global provider registry instance (singleton)
 */
let globalRegistry: ProviderRegistry | null = null;

/**
 * Get global provider registry
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!globalRegistry) {
    throw new Error('Provider registry not initialized. Call initializeProviderRegistry first.');
  }
  return globalRegistry;
}

/**
 * Set global provider registry
 */
export function setProviderRegistry(registry: ProviderRegistry): void {
  globalRegistry = registry;
}
