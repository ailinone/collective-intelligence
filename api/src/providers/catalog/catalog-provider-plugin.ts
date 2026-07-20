// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog → ProviderPlugin Bridge
 *
 * Turns a data-driven {@link ProviderCatalogEntry} into a runtime
 * {@link ProviderPlugin} that the existing `providerPluginManager` can
 * validate, initialize, health-check, and register.
 *
 * Why a bridge (and not yet-another-registry):
 *
 *   - The catalog declares WHAT a provider is (classification + endpoints).
 *   - The plugin system declares HOW the runtime manages a provider lifecycle
 *     (init → healthCheck → register → discover → shutdown).
 *   - Rather than invent a new lifecycle, we adapt the catalog onto the
 *     existing ProviderPluginManager. The net result is ZERO new provider
 *     switch-cases anywhere — the only growth vector for provider count is
 *     `providers.catalog.ts` data.
 *
 * Integration-class support matrix:
 *
 *   oai-compat-pure          ✅ full  (uses hub fetcher + hub adapter)
 *   oai-compat-quirks        ✅ full  (same, with extra headers/paths)
 *   self-hosted-oai-compat   ✅ full  (same, apiKeyOptional honored)
 *   gateway                  ✅ full  (same; discovery reveals upstreams)
 *   first-party-native       ⛔ rejected — requires dedicated adapter via
 *                                        `adapterClass` and its own plugin.
 *   *-only specialty classes ⛔ rejected — will be wired when dedicated
 *                                        adapters land (VoyageRerank, etc.).
 *   catalog-only mode        ⛔ rejected — loader skips before reaching here.
 *
 * Rejection is fail-fast at `initialize()` time with a diagnostic error —
 * NOT a silent no-op — so the catalog-loader logs exactly which entries were
 * skipped and why, keeping the inventory honest.
 */

import { logger } from '@/utils/logger';
import { OpenAICompatibleHubAdapter } from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { OpenAICompatibleHubModelFetcher } from '@/services/model-fetchers/openai-compatible-hub-model-fetcher';
import type { ProviderAdapter } from '../base/provider-adapter';
import type {
  ProviderPlugin,
  ProviderModel as PluginProviderModel,
  ProviderConfig,
} from '../provider-plugin-system';
import type { ProviderCatalogEntry } from './provider-catalog.types';
import { isOpenAICompatibleEntry, normalizePinnedModelEntry } from './provider-catalog.types';
import { narrowAs } from '@/utils/type-guards';
import { resolveAdapterFactory } from './adapter-factory-registry';

const BRIDGE_VERSION = 'catalog-bridge@v1';

/**
 * Error thrown when the catalog entry cannot be materialized into a plugin.
 * Callers (catalog-loader) catch this to log + skip, then continue.
 */
export class CatalogPluginUnsupportedError extends Error {
  constructor(
    readonly providerId: string,
    readonly integrationClass: string,
    reason: string,
  ) {
    super(
      `CatalogProviderPlugin: cannot bridge '${providerId}' (integrationClass=${integrationClass}) — ${reason}`,
    );
    this.name = 'CatalogPluginUnsupportedError';
  }
}

/**
 * Runtime plugin wrapping a single catalog entry.
 *
 * One instance per catalog entry. The instance is created by the loader,
 * then handed to `providerPluginManager.registerPlugin()` which drives the
 * full lifecycle.
 */
export class CatalogProviderPlugin implements ProviderPlugin {
  readonly name: string;
  readonly version = BRIDGE_VERSION;
  readonly description?: string;

  private readonly entry: ProviderCatalogEntry;
  private readonly log;
  /**
   * Adapter is typed as the base `ProviderAdapter` to allow dedicated
   * adapter classes (Voyage, WatsonX, etc.) that don't extend the hub.
   * The hub-compatible sub-path still builds an `OpenAICompatibleHubAdapter`
   * under the hood; only the declared type widened.
   */
  private adapter?: ProviderAdapter;
  private fetcher?: OpenAICompatibleHubModelFetcher;

  constructor(entry: ProviderCatalogEntry) {
    this.entry = entry;
    this.name = entry.providerId;
    this.description =
      entry.notes ??
      `${entry.displayName} (${entry.integrationClass}, ${entry.integrationMode})`;
    this.log = logger.child({
      component: 'catalog-provider-plugin',
      providerId: entry.providerId,
    });
  }

  /**
   * Build adapter + fetcher from catalog entry and env-sourced config.
   *
   * The ProviderConfig arriving here was built by `ProviderPluginManager`'s
   * convention-based resolver: `<PROVIDER>_API_KEY` / `<PROVIDER>_BASE_URL`.
   * When the catalog declares a non-default `apiKeyEnvVar` (e.g.
   * AWS_ACCESS_KEY_ID), the manager's resolver will NOT find it — so we
   * fall back to the catalog-declared env var here as a second attempt.
   */
  async initialize(config: ProviderConfig): Promise<void> {
    // ── Gate: integration class support ────────────────────────────────────
    if (this.entry.integrationMode === 'catalog-only') {
      throw new CatalogPluginUnsupportedError(
        this.entry.providerId,
        this.entry.integrationClass,
        'integrationMode=catalog-only — the loader should have skipped this entry',
      );
    }

    // Dedicated-adapter path: if the entry declares an adapterClass AND a
    // factory is registered for it, honor that factory. This is how specialty
    // classes (embeddings-only, etc.) reach the runtime without passing the
    // OAI-compat gate — the factory owns the full contract.
    const dedicatedFactory = resolveAdapterFactory(this.entry.adapterClass);

    if (!dedicatedFactory && !isOpenAICompatibleEntry(this.entry)) {
      throw new CatalogPluginUnsupportedError(
        this.entry.providerId,
        this.entry.integrationClass,
        'requires a dedicated ProviderPlugin (first-party-native / specialty). ' +
          `Declare adapterClass in the catalog entry and register the factory in ` +
          `default-adapter-factories.ts. adapterClass="${this.entry.adapterClass ?? '<unset>'}".`,
      );
    }

    // ── Resolve apiKey: prefer convention-resolved value, fall back to the
    //    catalog-declared env var (handles divergent prefixes). ─────────────
    const apiKey = this.resolveApiKey(config);
    if (!apiKey && !this.entry.apiKeyOptional) {
      throw new CatalogPluginUnsupportedError(
        this.entry.providerId,
        this.entry.integrationClass,
        `missing API key — set ${this.entry.apiKeyEnvVar} in env`,
      );
    }

    // ── Resolve baseUrl: env override wins over catalog default. ───────────
    const baseUrl = this.resolveBaseUrl(config);

    // ── Build fetcher (discovery). ─────────────────────────────────────────
    //
    // Even dedicated adapters use the hub fetcher for /models discovery when
    // the provider exposes an OpenAI-compatible listing endpoint. Dedicated
    // adapters that override getModels() (e.g. Voyage, Volcano) effectively
    // ignore this fetcher — but constructing it is cheap and harmless.
    this.fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: this.entry.providerId,
      apiKey: apiKey || '',
      baseUrl,
      modelListPaths: this.entry.paths?.modelList
        ? [...this.entry.paths.modelList]
        : undefined,
      authHeaderName: this.entry.authHeaderName,
      authScheme: this.mapAuthScheme(),
      extraHeaders: this.entry.extraHeaders
        ? { ...this.entry.extraHeaders }
        : undefined,
      modelDenylist: this.entry.modelDenylist
        ? [...this.entry.modelDenylist]
        : undefined,
    });

    // ── Build adapter (execution). ─────────────────────────────────────────
    if (dedicatedFactory) {
      this.adapter = dedicatedFactory({
        entry: this.entry,
        apiKey: apiKey || '',
        baseUrl,
        extraHeaders: this.entry.extraHeaders
          ? { ...this.entry.extraHeaders }
          : undefined,
      });
      this.log.info(
        {
          adapterClass: this.entry.adapterClass,
          integrationClass: this.entry.integrationClass,
          integrationMode: this.entry.integrationMode,
          baseUrl,
          apiKeyPresent: Boolean(apiKey),
        },
        'Catalog-backed plugin initialized via dedicated adapter factory',
      );
      return;
    }

    // Default path: generic hub adapter.
    //
    // `OpenAICompatibleHubAdapterConfig` extends the project-wide
    // `ProviderConfig` from `@/types`, which requires `name` + `enabled` in
    // addition to the auth/baseUrl fields. We populate `name` from the
    // catalog providerId (acts as the registry key) and `enabled: true`
    // unconditionally — the catalog-loader already filtered out denied /
    // unsupported entries before constructing this plugin.
    this.adapter = new OpenAICompatibleHubAdapter({
      name: this.entry.providerId,
      enabled: true,
      providerName: this.entry.providerId,
      displayName: this.entry.displayName,
      apiKey: apiKey || '',
      baseUrl,
      metadata: {
        authHeaderName: this.entry.authHeaderName,
        authScheme: this.mapAuthScheme(),
        extraHeaders: this.entry.extraHeaders
          ? { ...this.entry.extraHeaders }
          : undefined,
        chatCompletionsPath: this.entry.paths?.chatCompletions,
        embeddingsPath: this.entry.paths?.embeddings,
        moderationsPath: this.entry.paths?.moderation,
        videosPath: this.entry.paths?.videoGenerate,
        videoPollPath: this.entry.paths?.videoPoll,
        videoRequestStyle: this.entry.videoRequestStyle,
        imagesPath: this.entry.paths?.imagesGenerate,
        imagesEditsPath: this.entry.paths?.imagesEdit,
        audioSpeechPath: this.entry.paths?.audioSpeech,
        audioTranscriptionsPath: this.entry.paths?.audioTranscriptions,
        modelListPath: this.entry.paths?.modelList?.[0],
        // Plumb the catalog's apiKeyOptional flag through to the hub
        // adapter's validateConfig override — without this, self-hosted
        // entries with no API key set in env throw at adapter construction.
        apiKeyOptional: this.entry.apiKeyOptional === true,
      },
    });

    this.log.info(
      {
        integrationClass: this.entry.integrationClass,
        integrationMode: this.entry.integrationMode,
        baseUrl,
        apiKeyPresent: Boolean(apiKey),
        apiKeyOptional: Boolean(this.entry.apiKeyOptional),
      },
      'Catalog-backed plugin initialized',
    );
  }

  /**
   * List models via the hub fetcher.
   *
   * Returns the fetcher's rich `ProviderModel` shape — which is structurally
   * compatible with the plugin-system's simpler shape (the richer fields are
   * ignored by consumers that expect the simpler shape).
   *
   * For `execution-only` entries where `/models` isn't exposed, the catalog
   * declares `pinnedFallback.models` (or, during the Phase 4d migration
   * window, the legacy `staticModels`). We synthesize minimal entries in
   * that case so the plugin-manager's discovery step has something to
   * register.
   */
  async listModels(): Promise<PluginProviderModel[]> {
    if (!this.fetcher) {
      throw new Error(
        `CatalogProviderPlugin(${this.entry.providerId}): listModels called before initialize`,
      );
    }

    // Execution-only: synthesize from pinnedFallback.models (Phase 4d, 2026-04-28).
    // The legacy `staticModels` branch is kept as a safety net during the
    // migration window — once every catalog row is migrated, both the legacy
    // field and this fallback branch get removed in the same commit.
    //
    // Capability declaration (root-cause refactor 2026-04-28): each pinned
    // entry can be either a bare id (string) or a structured `{id, capabilities}`
    // record. Operator-declared capabilities flow through directly here — the
    // catalog-bridge in central-model-discovery-service handles the regex
    // fallback for bare-string entries; this synthesizer is only consulted by
    // the plugin manager (separate code path). When called via that path, we
    // preserve the declared capabilities so the synthesized model rows surface
    // with real tags rather than `capabilities: []`.
    const rawPinned = this.entry.pinnedFallback?.models ?? this.entry.staticModels ?? null;
    if (
      this.entry.integrationMode === 'execution-only' &&
      rawPinned &&
      rawPinned.length > 0
    ) {
      return rawPinned.map((rawEntry) => {
        const { id, capabilities } = normalizePinnedModelEntry(rawEntry);
        return {
          id,
          name: id,
          displayName: id,
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: [...capabilities] as PluginProviderModel['capabilities'],
          pricing: { inputCostPer1M: 0, outputCostPer1M: 0 },
        };
      });
    }

    const models = await this.fetcher.getModels();

    // The fetcher's ProviderModel is a superset of the plugin-system's.
    // Structural typing accepts this assignment directly.
    return narrowAs<PluginProviderModel[]>(models);
  }

  /**
   * Health check — delegates to the hub adapter's healthCheck, which probes
   * `/models` endpoints with a short timeout and honors the `api-key-header`
   * scheme. Returns boolean (plugin-system API), not the adapter's richer
   * HealthCheckResult.
   *
   * Self-hosted entries with `apiKeyOptional` still probe the endpoint — a
   * running local server must respond, even if auth is relaxed.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.adapter) {
      this.log.warn('healthCheck called before initialize');
      return false;
    }

    try {
      const result = await this.adapter.healthCheck();
      return result.healthy;
    } catch (err) {
      this.log.warn({ err }, 'healthCheck threw — treating as unhealthy');
      return false;
    }
  }

  /**
   * Return the underlying adapter for registration in the provider registry.
   * The plugin-manager calls this AFTER healthCheck() passes.
   */
  getAdapter(): ProviderAdapter {
    if (!this.adapter) {
      throw new Error(
        `CatalogProviderPlugin(${this.entry.providerId}): getAdapter called before initialize`,
      );
    }
    return this.adapter;
  }

  /**
   * Expose the fetcher for downstream wiring (central-model-discovery-service).
   * Returns undefined if not yet initialized or if the entry is catalog-only.
   */
  getFetcher(): OpenAICompatibleHubModelFetcher | undefined {
    return this.fetcher;
  }

  /**
   * Expose the catalog entry for loaders that want to inspect
   * classification / lifecycle flags without re-reading the catalog.
   */
  getCatalogEntry(): ProviderCatalogEntry {
    return this.entry;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  /**
   * API key resolution order:
   *   1. config.apiKey (plugin-manager convention: `<PROVIDER>_API_KEY`)
   *   2. process.env[entry.apiKeyEnvVar] (catalog-declared override)
   *
   * Rationale: for most providers, #1 and #2 point at the same env var
   * (per catalog Zod rule). For divergent prefixes (AWS, IBM, OCI), #2
   * resolves what #1 missed.
   */
  private resolveApiKey(config: ProviderConfig): string | undefined {
    if (config.apiKey && config.apiKey.length > 0) {
      return config.apiKey;
    }
    const viaCatalog = process.env[this.entry.apiKeyEnvVar];
    return viaCatalog && viaCatalog.length > 0 ? viaCatalog : undefined;
  }

  /**
   * Base URL resolution order:
   *   1. config.baseURL (plugin-manager convention: `<PROVIDER>_BASE_URL`)
   *   2. process.env[entry.baseUrlEnvVar] (catalog-declared override)
   *   3. entry.baseUrl (catalog default)
   */
  private resolveBaseUrl(config: ProviderConfig): string {
    if (config.baseURL && config.baseURL.length > 0) {
      return config.baseURL;
    }
    if (this.entry.baseUrlEnvVar) {
      const viaCatalog = process.env[this.entry.baseUrlEnvVar];
      if (viaCatalog && viaCatalog.length > 0) {
        return viaCatalog;
      }
    }
    return this.entry.baseUrl;
  }

  /**
   * Map catalog auth scheme → adapter/fetcher auth scheme string.
   *
   * The hub adapter uses `authScheme: 'Bearer' | 'Token' | ''` style tokens
   * (what goes before the key in the Authorization header). The catalog
   * vocabulary is higher-level.
   */
  private mapAuthScheme(): string | undefined {
    switch (this.entry.authScheme) {
      case 'bearer':
        return 'Bearer';
      case 'api-key-header':
        // Value placed raw in the custom header — no prefix.
        return '';
      case 'query-param':
      case 'hmac-sigv4':
      case 'oauth2':
      case 'iam-token':
      case 'custom':
        // These should have been rejected above via isOpenAICompatibleEntry /
        // classification. If we got here, the catalog entry is misconfigured.
        this.log.warn(
          { authScheme: this.entry.authScheme },
          'Unsupported authScheme for oai-compat bridge — falling back to Bearer',
        );
        return 'Bearer';
      case 'none':
        return undefined;
      case undefined:
        return 'Bearer'; // catalog default
      default:
        return 'Bearer';
    }
  }

  /**
   * Optional shutdown hook — called by plugin-manager during unregister.
   * The hub adapter has no explicit shutdown; we just clear references.
   */
  async shutdown(): Promise<void> {
    this.log.info('Catalog-backed plugin shutting down');
    this.adapter = undefined;
    this.fetcher = undefined;
  }
}

/**
 * Factory helper — constructs a plugin from a catalog entry and performs
 * early validation. Throws `CatalogPluginUnsupportedError` before consuming
 * any env vars when the entry is structurally unsupported by the bridge.
 *
 * Loader code should prefer this over `new CatalogProviderPlugin(...)` so
 * that the "can bridge?" and "build bridge" steps are co-located.
 */
export function createCatalogProviderPlugin(
  entry: ProviderCatalogEntry,
): CatalogProviderPlugin {
  // Structural reject for modes that shouldn't reach the bridge at all.
  if (entry.integrationMode === 'catalog-only') {
    throw new CatalogPluginUnsupportedError(
      entry.providerId,
      entry.integrationClass,
      'integrationMode=catalog-only — loader must filter these out before bridging',
    );
  }

  // Structural reject for classes that need a dedicated adapter AND have NO
  // dedicated factory registered.
  //
  // Layered-gate fix (2026-05-05): the prior check rejected EVERY non-OAI
  // entry here, even when `initialize()` would otherwise resolve a registered
  // dedicated factory and proceed normally. That mismatch killed 7 catalog
  // rows with valid `adapterClass`/factory bindings (voyage, replicate,
  // recraft, runwayml, bfl, etc.) before the factory-resolve path ever ran.
  // Symmetry now: this gate matches `CatalogProviderPlugin.initialize()`'s
  // own check (`!dedicatedFactory && !isOpenAICompatibleEntry(this.entry)`).
  if (!isOpenAICompatibleEntry(entry)) {
    const hasDedicatedFactory = resolveAdapterFactory(entry.adapterClass) !== undefined;
    if (!hasDedicatedFactory) {
      throw new CatalogPluginUnsupportedError(
        entry.providerId,
        entry.integrationClass,
        'class needs a dedicated ProviderPlugin — bridge only covers oai-compat-* ' +
          'and no factory is registered for ' +
          `adapterClass="${entry.adapterClass ?? '<unset>'}". Either register a ` +
          'factory in default-adapter-factories.ts or set integrationClass to an oai-compat variant.',
      );
    }
    // Has a registered factory → proceed; initialize() will route through it.
  }

  return new CatalogProviderPlugin(entry);
}
