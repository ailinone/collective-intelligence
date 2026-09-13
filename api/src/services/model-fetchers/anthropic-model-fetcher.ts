// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Anthropic Model Fetcher
 *
 * 100% Dynamic Model Discovery - No hardcoded models
 * Uses Anthropic API /v1/models endpoint for real-time model discovery
 * Reference: https://docs.anthropic.com/en/api/models-list
 */

// 100% Dynamic Discovery - No SDK dependency needed, using REST API directly
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Shape of one entry in Anthropic's `GET /v1/models` response.
 * https://platform.claude.com/docs/en/api/models/list
 *
 * `capabilities`/`max_input_tokens`/`max_tokens` are REAL, first-party,
 * per-model fields the vendor already returns — added 2026-09 after an audit
 * found this fetcher declared none of them and instead guessed vision/
 * reasoning/json_mode from substrings of the model id and hardcoded 100k-
 * 200k context windows, even though the vendor's own response already
 * answers all of that. See `applyDeclaredCapabilities` and
 * `convertAnthropicModel`.
 */
interface AnthropicApiModel {
  id: string;
  display_name: string;
  created_at: string;
  type: 'model';
  max_input_tokens?: number | null;
  max_tokens?: number | null;
  capabilities?: {
    image_input?: { supported?: boolean };
    pdf_input?: { supported?: boolean };
    thinking?: { supported?: boolean };
    structured_outputs?: { supported?: boolean };
  } | null;
}

/**
 * Anthropic Model Fetcher
 * 100% Dynamic - Fetches models from Anthropic API /v1/models endpoint
 */
export class AnthropicModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private log = logger.child({ component: 'anthropic-fetcher' });

  constructor(apiKey: string, baseUrl?: string) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.anthropic.com';
    if (!this.apiKey) {
      this.log.warn('Anthropic API key not provided - returning empty model list');
    }
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Anthropic API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    // Sanitize API key - remove invalid characters that can't be in HTTP headers
    // This handles cases where keys from GCP may have newlines or other control characters
    const sanitizedApiKey = this.apiKey.trim().replace(/[\r\n\t]/g, '');
    if (sanitizedApiKey !== this.apiKey) {
      this.log.warn('API key contained invalid characters and was sanitized');
    }

    // Validate baseUrl
    if (!this.baseUrl || !this.baseUrl.startsWith('http')) {
      this.log.error({ baseUrl: this.baseUrl }, 'Invalid baseUrl for Anthropic API');
      return [];
    }

    try {
      // 100% Dynamic Discovery - Fetch from Anthropic API /v1/models
      // Reference: https://docs.anthropic.com/en/api/models-list
      const { default: fetch } = await import('node-fetch');
      const allModels: ProviderModel[] = [];
      let afterId: string | null = null;
      let hasMore = true;

      while (hasMore) {
        let url: URL;
        try {
          url = new URL(`${this.baseUrl}/v1/models`);
          if (afterId) {
            url.searchParams.set('after_id', afterId);
          }
          url.searchParams.set('limit', '100'); // Max limit
        } catch (urlError) {
          this.log.error(
            {
              baseUrl: this.baseUrl,
              error: urlError instanceof Error ? urlError.message : String(urlError),
            },
            'Failed to construct Anthropic API URL - invalid baseUrl or character encoding issue'
          );
          return [];
        }

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'x-api-key': sanitizedApiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.log.error(
            {
              status: response.status,
              statusText: response.statusText,
              error: errorText.substring(0, 500),
            },
            'Failed to fetch models from Anthropic API'
          );
          return [];
        }

        const data = (await response.json()) as {
          data?: AnthropicApiModel[];
          has_more?: boolean;
          last_id?: string;
        };

        if (!data.data || !Array.isArray(data.data)) {
          this.log.warn('Anthropic API returned invalid response format');
          break;
        }

        // Convert Anthropic models to ProviderModel format
        for (const anthropicModel of data.data) {
          try {
            const model = this.convertAnthropicModel(anthropicModel);
            if (model) {
              allModels.push(model);
            }
          } catch (error) {
            this.log.warn(
              { modelId: anthropicModel.id, error },
              'Failed to convert Anthropic model'
            );
          }
        }

        // Check for next page
        hasMore = Boolean(data.has_more && data.last_id);
        afterId = data.last_id || null;
      }

      this.log.info({ count: allModels.length }, 'Successfully fetched models from Anthropic API');
      return allModels;
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle ERR_INVALID_CHAR specifically
      if (errorCode === 'ERR_INVALID_CHAR') {
        this.log.error(
          {
            baseUrl: this.baseUrl,
            keyPresent: Boolean(this.apiKey),
            error: errorMessage,
          },
          'Failed to fetch models from Anthropic API - invalid character in URL or headers (ERR_INVALID_CHAR). Check baseUrl and API key encoding.'
        );
      } else {
        this.log.error(
          {
            error: errorMessage,
            errorCode,
            baseUrl: this.baseUrl,
          },
          'Failed to fetch models from Anthropic API'
        );
      }
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  /**
   * Convert Anthropic API model to ProviderModel format
   */
  private convertAnthropicModel(betaModelInfo: AnthropicApiModel): ProviderModel | null {
    try {
      const modelId = betaModelInfo.id;
      const heuristicCapabilities = this.extractCapabilitiesFromAnthropic(modelId);
      const capabilities = this.applyDeclaredCapabilities(
        heuristicCapabilities,
        betaModelInfo.capabilities
      );
      const estimated = this.estimateModelSpecs(modelId);

      // Anthropic's /v1/models reports real per-model max_input_tokens/
      // max_tokens. Prefer them over the tier heuristic (which cannot know
      // about a specific snapshot's limits, only guess from its id) — fall
      // back to the estimate only when the vendor omits or zeroes the field.
      const contextWindow =
        typeof betaModelInfo.max_input_tokens === 'number' && betaModelInfo.max_input_tokens > 0
          ? betaModelInfo.max_input_tokens
          : estimated.contextWindow;
      const maxOutputTokens =
        typeof betaModelInfo.max_tokens === 'number' && betaModelInfo.max_tokens > 0
          ? betaModelInfo.max_tokens
          : estimated.maxOutputTokens;

      const metadata = {
        endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
        tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
        family: this.extractFamily(modelId),
        tier: this.extractTier(modelId),
        source: 'anthropic-api',
        displayName: betaModelInfo.display_name,
        createdAt: betaModelInfo.created_at,
        pricingSource: estimated.pricingSource,
        specSource:
          contextWindow === estimated.contextWindow && maxOutputTokens === estimated.maxOutputTokens
            ? 'tier-estimate'
            : 'anthropic-api-declared',
      };

      return {
        id: modelId,
        name: modelId,
        displayName: betaModelInfo.display_name || this.formatDisplayName(modelId),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing: estimated.pricing,
        metadata,
      };
    } catch (error) {
      this.log.warn({ model: betaModelInfo.id, error }, 'Failed to convert Anthropic model');
      return null;
    }
  }

  /**
   * Anthropic's `/v1/models` response carries a real, vendor-declared
   * `capabilities` object per model (image_input, thinking,
   * structured_outputs, pdf_input, ...). This fetcher used to discard it
   * entirely and guess vision/reasoning/json_mode from substrings of the
   * model id instead — a guess the vendor's own response already answers.
   *
   * A declared `true`/`false` is authoritative and overrides the heuristic
   * in both directions (adds a capability the guess missed, removes one it
   * wrongly assumed). A field the vendor omits (or a null `capabilities`
   * block, e.g. an older API version) leaves the heuristic's guess alone —
   * the guess is the only signal available at all in that case.
   */
  private applyDeclaredCapabilities(
    heuristic: ModelCapability[],
    declared: AnthropicApiModel['capabilities']
  ): ModelCapability[] {
    const capabilities = new Set(heuristic);
    if (!declared) {
      return Array.from(capabilities);
    }

    const applyFlag = (supported: boolean | undefined, flags: ModelCapability[]) => {
      if (supported === undefined) return;
      if (supported) {
        flags.forEach((flag) => capabilities.add(flag));
      } else {
        flags.forEach((flag) => capabilities.delete(flag));
      }
    };

    applyFlag(declared.image_input?.supported, ['vision', 'multimodal']);
    applyFlag(declared.thinking?.supported, ['reasoning', 'thinking_mode']);
    applyFlag(declared.structured_outputs?.supported, ['json_mode']);
    applyFlag(declared.pdf_input?.supported, ['pdf_understanding']);

    return Array.from(capabilities);
  }

  private async createProviderModel(modelId: string): Promise<ProviderModel> {
    const capabilities = this.extractCapabilitiesFromAnthropic(modelId);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'anthropic-api',
    };

    return {
      id: modelId,
      name: modelId,
      displayName: this.formatDisplayName(modelId),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  /**
   * Extract capabilities using generic patterns, not hardcoded model names
   */
  private extractCapabilitiesFromAnthropic(modelId: string): ModelCapability[] {
    const capabilities: ModelCapability[] = ['chat', 'function_calling', 'streaming', 'json_mode'];
    const normalized = modelId.toLowerCase();

    // Vision/multimodal - check for version patterns (indicates newer models with vision)
    // Generic version pattern works for any version (3.5, 3.7, 4.0, etc.)
    const hasVersion = normalized.match(/\d+\.\d+/);
    if (hasVersion || normalized.includes('vision') || normalized.includes('multimodal')) {
      capabilities.push('vision', 'multimodal');
    }

    // Reasoning capabilities - check for reasoning-related keywords or higher version numbers
    // Higher version numbers (e.g., 3.5, 4.0) often indicate enhanced reasoning
    if (
      normalized.includes('reasoning') ||
      normalized.includes('thinking') ||
      (hasVersion && parseFloat(hasVersion[0]) >= 3.5)
    ) {
      capabilities.push('reasoning', 'thinking_mode');
    }

    return Array.from(new Set(capabilities));
  }

  /**
   * Extract model family using generic pattern extraction, not hardcoded names
   */
  private extractFamily(modelId: string): string {
    const normalized = modelId.toLowerCase();

    // Extract base family name (first meaningful segment)
    const match = normalized.match(/^([a-z]+(?:-\d+)?(?:\.\d+)?)/);
    if (match && match[1]) {
      const prefix = match[1];
      // Format to title case
      return prefix
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }

    // Fallback: extract first segment
    const segments = normalized.split('-');
    if (segments.length > 0 && segments[0]) {
      return segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
    }

    return 'Claude';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('opus')) return 'flagship';
    if (modelId.includes('sonnet')) return 'premium';
    if (modelId.includes('haiku')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    // Convert kebab-case to title case
    return modelId
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Source-of-truth tag for a price returned by {@link estimateModelSpecs} —
   * same rationale/shape as `VertexAIModelFetcher.PRICING_SOURCES`: a model
   * that falls through to the generic default is indistinguishable downstream
   * from one with a confirmed price unless something says so explicitly.
   */
  private static readonly PRICING_SOURCES = [
    'opus-tier-table',
    'opus-legacy-tier-table',
    'sonnet-tier-table',
    'sonnet-legacy-tier-table',
    'haiku-tier-table',
    'haiku-legacy-tier-table',
    'fable-mythos-tier-table',
    'default-fallback',
  ] as const;

  /**
   * Extract the generation number Anthropic encodes with a hyphen instead of
   * a dot right after a tier keyword — "claude-opus-4-6" -> {4, 6},
   * "claude-opus-5" -> {5, 0} (no minor component). A trailing dated snapshot
   * suffix ("claude-opus-4-5-20251101") must NOT be read as extra version
   * digits: the lookahead requires the minor-version digits not be followed
   * by another digit, so "-5-20251101" still yields minor 5, not 5 followed
   * by a bogus third component.
   *
   * Guards against a bare, undated legacy id where the tier word sits
   * immediately before an 8-digit date with no version number in between
   * (e.g. an older "...-haiku-20241022" style id, unlike current ids which
   * always put the generation between the tier word and the date): without
   * a sanity cap, `\d{1,2}` would greedily read "20" off the date as if it
   * were major version 20. Real generation numbers are single low digits, so
   * a "major" above 9 is rejected as a false match rather than trusted.
   */
  private extractGeneration(
    normalized: string,
    tier: string
  ): { major: number; minor: number } | null {
    const match = normalized.match(new RegExp(`${tier}-(\\d{1,2})(?:-(\\d{1,2})(?!\\d))?`));
    if (!match) return null;
    const major = parseInt(match[1], 10);
    if (major > 9) return null;
    const minor = match[2] !== undefined ? parseInt(match[2], 10) : 0;
    return { major, minor };
  }

  /** `{major, minor} >= {atLeastMajor, atLeastMinor}` — false for a missing generation. */
  private static versionAtLeast(
    version: { major: number; minor: number } | null,
    atLeastMajor: number,
    atLeastMinor: number
  ): boolean {
    if (!version) return false;
    return (
      version.major > atLeastMajor || (version.major === atLeastMajor && version.minor >= atLeastMinor)
    );
  }

  /**
   * Estimate model specifications using generic tier/keyword inference, not
   * hardcoded model names.
   *
   * Anthropic's `/v1/models` response does not include pricing, so this
   * stays a heuristic — but the tier prices below are sourced from the
   * current official rate card (platform.claude.com/docs/en/about-claude/pricing,
   * verified 2026-09), not invented. Context window / max output tokens are
   * an even rougher estimate used ONLY when the API's own `max_input_tokens`/
   * `max_tokens` are absent (see `convertAnthropicModel`), so precision here
   * matters far less than it used to.
   *
   * ## 2026-09 audit finding
   *
   * The previous version of this table was dated "as of Nov 2024" and had
   * three flat per-tier prices with no generation awareness at all, plus no
   * entry for the `fable`/`mythos` tiers. Checked against the 11 models the
   * live `anthropic-native` discovery source actually returns today: 9 of 11
   * (82%) were mispriced — every `opus-4.5..4.8`/`opus-5` row 3x too high
   * ($15/$75 vs the real $5/$25), every `fable`/`sonnet-5` row using the
   * generic unknown-tier default (`fable` 10x too low: $1/$5 vs $10/$50;
   * `sonnet-5` 1.5x too high: $3/$15 vs $2/$10), and `haiku-4.5` 4x too low
   * ($0.25/$1.25 — actually Claude 3 Haiku's 2024 price — vs the real $1/$5).
   * Only `sonnet-4.5`/`sonnet-4.6` happened to still be correct, because
   * Anthropic kept Sonnet's price flat across exactly those two generations.
   */
  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
    pricingSource: (typeof AnthropicModelFetcher.PRICING_SOURCES)[number];
  } {
    const normalized = modelId.toLowerCase();

    const isDeepReasoning = normalized.includes('fable') || normalized.includes('mythos');
    const isFlagship = !isDeepReasoning && normalized.includes('opus');
    const isPremium = !isDeepReasoning && normalized.includes('sonnet');
    const isFast = !isDeepReasoning && normalized.includes('haiku');

    // Claude Fable 5 / 5.1 and Claude Mythos 5 / 5.1 all price identically on
    // the current rate card ($10/$50) — no generation split needed (yet).
    if (isDeepReasoning) {
      return {
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        pricing: { inputCostPer1M: 10, outputCostPer1M: 50, currency: 'USD' },
        pricingSource: 'fable-mythos-tier-table',
      };
    }

    if (isFlagship) {
      const gen = this.extractGeneration(normalized, 'opus');
      // Opus 4.5 and every later snapshot (4.6, 4.7, 4.8, 5, ...) price at
      // $5/$25. Only pre-4.5 Opus (4, 4.1 — retired on the first-party API,
      // still reachable via Bedrock/Google Cloud) kept the older $15/$75.
      const isCurrentGen = AnthropicModelFetcher.versionAtLeast(gen, 4, 5);
      const has1MContext = AnthropicModelFetcher.versionAtLeast(gen, 4, 6);
      return {
        contextWindow: has1MContext ? 1_000_000 : 200_000,
        maxOutputTokens: has1MContext ? 128_000 : isCurrentGen ? 8_192 : 4_096,
        pricing: isCurrentGen
          ? { inputCostPer1M: 5, outputCostPer1M: 25, currency: 'USD' }
          : { inputCostPer1M: 15, outputCostPer1M: 75, currency: 'USD' },
        pricingSource: isCurrentGen ? 'opus-tier-table' : 'opus-legacy-tier-table',
      };
    }

    if (isPremium) {
      const gen = this.extractGeneration(normalized, 'sonnet');
      // Sonnet 5 introduced a price cut to $2/$10; every 4.x snapshot
      // (4, 4.5, 4.6) stayed at $3/$15.
      const isGen5Plus = AnthropicModelFetcher.versionAtLeast(gen, 5, 0);
      const has1MContext = isGen5Plus || AnthropicModelFetcher.versionAtLeast(gen, 4, 6);
      return {
        contextWindow: has1MContext ? 1_000_000 : 200_000,
        maxOutputTokens: has1MContext ? 128_000 : 8_192,
        pricing: isGen5Plus
          ? { inputCostPer1M: 2, outputCostPer1M: 10, currency: 'USD' }
          : { inputCostPer1M: 3, outputCostPer1M: 15, currency: 'USD' },
        pricingSource: isGen5Plus ? 'sonnet-tier-table' : 'sonnet-legacy-tier-table',
      };
    }

    if (isFast) {
      const gen = this.extractGeneration(normalized, 'haiku');
      // Haiku 4.5 priced UP from Haiku 3.5's $0.80/$4 to $1/$5 (a more
      // capable, more expensive model) — the direction the old flat "fast
      // tier is always cheapest" table got backwards by pinning every Haiku
      // snapshot to Claude 3 Haiku's ancient $0.25/$1.25.
      const isCurrentGen = AnthropicModelFetcher.versionAtLeast(gen, 4, 5);
      return {
        contextWindow: 200_000,
        maxOutputTokens: isCurrentGen ? 64_000 : 4_096,
        pricing: isCurrentGen
          ? { inputCostPer1M: 1, outputCostPer1M: 5, currency: 'USD' }
          : { inputCostPer1M: 0.8, outputCostPer1M: 4, currency: 'USD' },
        pricingSource: isCurrentGen ? 'haiku-tier-table' : 'haiku-legacy-tier-table',
      };
    }

    // Default specs - conservative estimates for a tier this table doesn't
    // recognize yet. Tagged so downstream cost-accounting can flag/query it
    // instead of silently trusting an unconfirmed number (see
    // VertexAIModelFetcher's identical `default-fallback` contract).
    this.log.warn(
      { modelId },
      'Anthropic pricing fell through to the unverified default fallback — no tier keyword ' +
        '(opus/sonnet/haiku/fable/mythos) matched this model id.'
    );
    return {
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      pricing: { inputCostPer1M: 1, outputCostPer1M: 5, currency: 'USD' },
      pricingSource: 'default-fallback',
    };
  }
}
