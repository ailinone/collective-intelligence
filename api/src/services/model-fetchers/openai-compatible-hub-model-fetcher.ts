// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import {
  BaseProviderModelFetcher,
  type ModelMetadata,
  type ProviderModel,
} from './provider-model-fetcher.js';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';
import { inferCapabilitiesFromModelId } from './model-capability-patterns.js';

interface OpenAICompatibleHubModelFetcherConfig {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  modelListPaths?: string[];
  authHeaderName?: string;
  authScheme?: string;
  secondaryAuthHeaderName?: string;
  secondaryAuthScheme?: string;
  extraHeaders?: Record<string, string>;
  /** Model IDs to exclude (read from env: <PROVIDER>_MODEL_DENYLIST=model1,model2) */
  modelDenylist?: string[];
  /**
   * Matches the catalog's `apiKeyOptional` flag — self-hosted OpenAI-compat
   * servers (vllm, lm-studio, xinference) commonly run with no auth at all.
   * When true, an empty apiKey does NOT skip discovery (the caller already
   * decided the provider is reachable without one); when false/absent, an
   * empty apiKey is treated as "missing credential" as before.
   */
  apiKeyOptional?: boolean;
}

type RawModelRecord = Record<string, unknown>;

/**
 * Gap-fill for providers whose /models endpoint omits context/pricing fields
 * entirely, so every model would otherwise fall back to the generic 8192
 * context / $0 pricing defaults below. `zai` (bigmodel.cn's GLM API) is one
 * such provider — verified 2026-07-20 against real-pricing hub listings
 * (openrouter/fastrouter/friendli/gmi/chutes) for the same GLM models, since
 * bigmodel.cn's own /v1/models response carries neither field. This ranked
 * these models last on every context-window-first selection (e.g.
 * `resolveTopTierModels` in c3-experiment-configs.ts), effectively excluding
 * GLM from top-tier comparisons regardless of the model's real capability.
 * Applied ONLY when the fetched value is still the generic fallback (see
 * call site) — a real, provider-supplied value always wins.
 *
 * Values are openrouter's published per-token pricing for the same GLM
 * models (independently cross-checked against fastrouter/vercel-ai-gateway/
 * phala/huggingface listings already in the catalog, which agree within a
 * normal cross-reseller margin) — not estimated ratios.
 *
 * Re-verified 2026-09-09 directly against `https://openrouter.ai/api/v1/models`
 * (live JSON, not a scraped/summarized pricing page) — this table had drifted
 * for glm-4.6, glm-5 and glm-5.2 (all repriced downward since the table was
 * last touched) and was missing glm-5.3 / glm-5.3-flash entirely, so those
 * three models fell all the way through to the $0/8192 generic default
 * despite `zai` re-listing glm-5.3 on bigmodel.cn. glm-4.5, glm-4.5-air,
 * glm-4.7, glm-5.1 and glm-5-turbo matched OpenRouter's current numbers
 * exactly and are unchanged. (Z.AI's own docs.z.ai marketing pricing page was
 * also checked but repeats identical $/1M figures across adjacent GLM
 * versions in a way that reads as a stale/templated table, not a reliable
 * per-model source — OpenRouter's raw API was used as ground truth instead,
 * consistent with this table's original sourcing.)
 */
const HUB_METADATA_GAP_FILL: Record<
  string,
  Record<string, { contextWindow: number; inputCostPer1M: number; outputCostPer1M: number }>
> = {
  zai: {
    'glm-4.5': { contextWindow: 131_072, inputCostPer1M: 0.6, outputCostPer1M: 2.2 },
    'glm-4.5-air': { contextWindow: 131_072, inputCostPer1M: 0.13, outputCostPer1M: 0.85 },
    'glm-4.6': { contextWindow: 204_800, inputCostPer1M: 0.43, outputCostPer1M: 1.75 },
    'glm-4.7': { contextWindow: 204_800, inputCostPer1M: 0.4, outputCostPer1M: 1.75 },
    'glm-5': { contextWindow: 204_800, inputCostPer1M: 0.6, outputCostPer1M: 1.92 },
    'glm-5.1': { contextWindow: 204_800, inputCostPer1M: 0.966, outputCostPer1M: 3.036 },
    'glm-5.2': { contextWindow: 1_048_576, inputCostPer1M: 0.28, outputCostPer1M: 0.88 },
    'glm-5.3': { contextWindow: 1_048_576, inputCostPer1M: 1.4, outputCostPer1M: 4.4 },
    'glm-5.3-flash': { contextWindow: 1_310_720, inputCostPer1M: 0.075, outputCostPer1M: 0.25 },
    'glm-5-turbo': { contextWindow: 202_752, inputCostPer1M: 1.2, outputCostPer1M: 4.0 },
  },
};

const HUB_FETCHER_DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Maps a hub's declared `supported_endpoint_types` value to this codebase's
 * canonical `ModelCapability` vocabulary (see `@/types`). This is a
 * provider-DECLARED, structural signal — which backend route the vendor
 * itself serves the model on — so it is folded into `declaredCapabilities`
 * in `buildMetadata` below at the SAME priority as the `capabilities`/
 * `features`/`supported_capabilities` keys: strictly before the model-id
 * regex fallback (`inferCapabilitiesFromModelId`) in `convertRawModel`,
 * which only ever runs when no declared capability was found at all.
 *
 * Live-verified 2026-09-14 against `GET https://api.unorouter.com/v1/models`
 * (272 real models, `supported_endpoint_types` present on 100% of them).
 * Eight distinct values were observed. Five of them —`openai`, `anthropic`,
 * `gemini`, `openai-response`, `openai-response-compact`— are wire-protocol/
 * routing labels (which chat-completions API shape to call), not an
 * additional capability signal, and are intentionally NOT mapped here: chat
 * is already this fetcher's default assumption, so mapping them would add
 * no information. The three mapped below ARE a real capability declaration:
 *   - `image-generation`: Runware/Cloudflare-hosted image checkpoints (e.g.
 *     `dreamshaper-xl`, `flux.2-dev`) whose ids don't match any pattern in
 *     `model-capability-patterns.ts`, so today they silently fall through to
 *     the generic chat default. 55 of unorouter's 272 models (aihorde +
 *     image-generation combined) were confirmed to be affected this way.
 *   - `aihorde`: the AI Horde crowd-sourced Stable Diffusion network. 100%
 *     of the 22 `aihorde`-tagged models observed are SD/SDXL image
 *     checkpoints (`albedobase-xl-31:free`, `juggernaut-xl:free`, ...) —
 *     never a text/chat backend on this hub.
 *   - `embedding`: always paired with `openai` in the combo (e.g.
 *     `qwen3-embedding-8b:free`, `jina-embeddings-v4:free`, `sea-lion-
 *     modernbert-embedding-600m:free`). 11 of the 19 `embedding`-tagged
 *     models had no embedding-shaped id at all (or, for the two
 *     `gemini-embedding-*` rows, matched the unrelated `gemini` chat-family
 *     regex instead) and fell through to chat/default before this fix.
 */
const ENDPOINT_TYPE_CAPABILITY_MAP: Record<string, ModelCapability[]> = {
  'image-generation': ['image_generation'],
  aihorde: ['image_generation'],
  embedding: ['embedding', 'embeddings'],
};

/**
 * Node's global `fetch` (undici) sends `User-Agent: node` when no override
 * is given. Some providers front their API with a WAF that silently blocks
 * that exact UA (e.g. featherless-ai's Cloudflare edge returns a generic
 * `404 Gone`), which this fetcher's own 404/405 handling treats as "this
 * path doesn't exist, try the next one" and swallows with no log line —
 * so the WAF block reads as an empty model list instead of an error. Same
 * fix and rationale as adapter-probe-callbacks.ts's PROBE_USER_AGENT; kept
 * as a separate constant here since the two fetchers are independent code
 * paths (this one backs central-model-discovery-service.ts's DB-populating
 * catalog sources, not the operability/health-check layer).
 */
const HUB_FETCHER_USER_AGENT = 'ailin-ci-discovery/1.0 (+https://ailin.one)';

function normalizeHubModelId(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  if (!trimmed) {
    return trimmed;
  }

  const atIndex = trimmed.indexOf('@');
  const slashIndex = trimmed.indexOf('/');

  // No '@' at all, or the first '/' comes at-or-before the first '@': any
  // '@' here is NOT a provider-prefix separator, it's part of an
  // already-slash-delimited id — e.g. Vertex/ORQ-style version suffixes
  // (`google/claude-opus-4-1@20250805`, live-verified 2026-09-12 against
  // ORQ.ai's /v2/router/models). Converting that '@' would corrupt a
  // genuinely-routable id, so leave it untouched.
  if (atIndex === -1 || (slashIndex !== -1 && slashIndex <= atIndex)) {
    return trimmed;
  }

  // The '@' precedes any '/' (or there is no '/' yet): this is a
  // provider-prefix separator — `provider@model` or `provider@nested/path`.
  // Convert the FIRST '@' to '/' regardless of how many more '/' segments
  // follow in the model part, so nested hub-of-hub ids normalize fully
  // instead of being left half-converted. Root-caused 2026-09-12: ids like
  // `groq@meta-llama/llama-4-scout-17b-16e-instruct` or
  // `togetherai@deepseek-ai/DeepSeek-V3` (live-verified real shapes on
  // ORQ.ai's router listing, which already emits most of these pre-slashed
  // as `groq/meta-llama/...` — but the same provider@nested/path shape can
  // still arrive from other hubs or historical rows) were previously left
  // as `vendor@nested/path` because the old check bailed out early on
  // seeing ANY '/' in the string, never reaching this conversion — causing
  // 25 of 27 DB rows to be misdiagnosed as "missing" when they were only
  // unnormalized.
  const provider = trimmed.slice(0, atIndex).trim();
  const model = trimmed.slice(atIndex + 1).trim();
  if (provider && model) {
    return `${provider}/${model}`;
  }

  return trimmed;
}

function normalizeProviderToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

export class OpenAICompatibleHubModelFetcher extends BaseProviderModelFetcher {
  protected providerName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelListPaths: string[];
  private readonly authHeaderName: string;
  private readonly authScheme: string;
  private readonly secondaryAuthHeaderName?: string;
  private readonly secondaryAuthScheme?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly modelDenylist: Set<string>;
  private readonly apiKeyOptional: boolean;
  private readonly log;

  constructor(config: OpenAICompatibleHubModelFetcherConfig) {
    super();
    this.providerName = config.providerName
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.modelListPaths = (
      config.modelListPaths && config.modelListPaths.length > 0
        ? config.modelListPaths
        : ['/models', '/v1/models', '/llm/models', '/info/models']
    ).filter((path, index, all) => all.indexOf(path) === index);
    this.authHeaderName = config.authHeaderName || 'Authorization';
    this.authScheme = config.authScheme || 'Bearer';
    this.secondaryAuthHeaderName = config.secondaryAuthHeaderName;
    this.secondaryAuthScheme = config.secondaryAuthScheme;
    this.extraHeaders = config.extraHeaders || {};
    this.apiKeyOptional = config.apiKeyOptional === true;
    // Denylist from config OR from env: <PROVIDER_UPPER>_MODEL_DENYLIST=model1,model2
    const envKey = `${this.providerName.toUpperCase().replace(/-/g, '_')}_MODEL_DENYLIST`;
    const fromEnv = process.env[envKey]
      ? process.env[envKey]!.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    this.modelDenylist = new Set([...(config.modelDenylist ?? []), ...fromEnv]);
    if (this.modelDenylist.size > 0) {
      this.log = logger.child({ component: `${this.providerName}-fetcher` });
      this.log.info({ denylist: [...this.modelDenylist] }, 'Model denylist active for hub fetcher');
    }
    this.log = logger.child({ component: `${this.providerName}-fetcher` });
  }

  async getModels(): Promise<ProviderModel[]> {
    const looksMockOrTest = this.apiKey.includes('mock') || this.apiKey.includes('test-');
    const missingAndRequired = !this.apiKey && !this.apiKeyOptional;
    if (missingAndRequired || looksMockOrTest) {
      this.log.warn(
        { apiKeyOptional: this.apiKeyOptional, hasKey: Boolean(this.apiKey) },
        'API key appears to be missing (and required) or mock/test, skipping model discovery'
      );
      return [];
    }

    for (const path of this.modelListPaths) {
      try {
        const response = await fetch(this.buildUrl(path), {
          method: 'GET',
          headers: this.buildRequestHeaders(),
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            this.log.debug(
              { path, status: response.status },
              'Hub model discovery endpoint not found at this path, trying next'
            );
            continue;
          }

          const errorText = await this.safeReadResponseText(response);
          this.log.warn(
            { path, status: response.status, body: errorText.slice(0, 400) },
            'Hub model discovery endpoint returned non-success status'
          );

          if (response.status === 401 || response.status === 403) {
            return [];
          }
          continue;
        }

        const payload = (await response.json()) as unknown;
        const rawModels = this.extractRawModels(payload);
        if (rawModels.length === 0) {
          continue;
        }

        const converted = rawModels
          .map((rawModel) => this.convertRawModel(rawModel, path))
          .filter((model): model is ProviderModel => Boolean(model))
          .filter((model) => !this.modelDenylist.has(model.id));

        if (converted.length > 0) {
          return converted;
        }
      } catch (error) {
        this.log.debug(
          { path, error: error instanceof Error ? error.message : String(error) },
          'Hub model discovery request failed, trying next endpoint'
        );
      }
    }

    return [];
  }

  private buildRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': HUB_FETCHER_USER_AGENT,
    };

    // apiKeyOptional providers (vllm, lm-studio, xinference) commonly run
    // with no auth at all — omit the header rather than send a bare "Bearer"
    // with no token, which some strict servers reject.
    if (this.apiKey) {
      headers[this.authHeaderName] = this.authScheme
        ? `${this.authScheme} ${this.apiKey}`.trim()
        : this.apiKey;

      if (this.secondaryAuthHeaderName) {
        const scheme = this.secondaryAuthScheme || this.authScheme;
        headers[this.secondaryAuthHeaderName] = scheme
          ? `${scheme} ${this.apiKey}`.trim()
          : this.apiKey;
      }
    }

    for (const [key, value] of Object.entries(this.extraHeaders)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        headers[key] = value;
      }
    }

    return headers;
  }

  private buildUrl(path: string): string {
    // A modelListPaths entry that is itself an absolute URL overrides baseUrl
    // entirely, rather than being appended to it. Needed for providers whose
    // chat baseUrl and model-catalog endpoint live under different roots —
    // e.g. GitHub Models serves chat at https://models.github.ai/inference/*
    // but the catalog listing at https://models.github.ai/catalog/models
    // (NOT nested under /inference). Plain concatenation of baseUrl + a
    // relative "/catalog/models" path 404s.
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private async safeReadResponseText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private extractRawModels(payload: unknown): RawModelRecord[] {
    if (Array.isArray(payload)) {
      return payload.filter((item): item is RawModelRecord =>
        Boolean(item && typeof item === 'object')
      );
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const record = payload as Record<string, unknown>;
    const possibleArrays = [
      record.data,
      record.models,
      record.results,
      record.items,
      record.entries,
    ];

    for (const candidate of possibleArrays) {
      if (Array.isArray(candidate)) {
        return candidate.filter((item): item is RawModelRecord =>
          Boolean(item && typeof item === 'object')
        );
      }
    }

    return [];
  }

  private convertRawModel(rawModel: RawModelRecord, sourcePath: string): ProviderModel | null {
    const rawModelId = this.resolveRawModelId(rawModel);

    if (!rawModelId) {
      return null;
    }

    const modelId = normalizeHubModelId(rawModelId);
    const displayName =
      this.extractString(rawModel, ['display_name', 'displayName', 'name', 'title']) || modelId;

    let contextWindow =
      this.extractNumber(rawModel, [
        'context_window',
        'contextWindow',
        'context_length',
        'max_context_length',
        'maxContextLength',
        // vLLM/SGLang-hosted surfaces (wafer serverless) expose the hard
        // context cap under this name at the top level of each model card.
        'max_model_len',
      ]) || HUB_FETCHER_DEFAULT_CONTEXT_WINDOW;

    let maxOutputTokens =
      this.extractNumber(rawModel, [
        'max_output_tokens',
        'maxOutputTokens',
        'max_completion_tokens',
        'maxCompletionTokens',
      ]) || 4096;

    const vendorExt = this.extractVendorExtension(rawModel);
    if (vendorExt && contextWindow === HUB_FETCHER_DEFAULT_CONTEXT_WINDOW) {
      contextWindow =
        this.extractNumber(vendorExt, ['context_length', 'context_window']) ||
        HUB_FETCHER_DEFAULT_CONTEXT_WINDOW;
    }

    // Poe (and other OpenRouter-style hubs) nest the per-model output cap
    // under a `context_window` OBJECT — `{ context_length, max_output_tokens }`
    // — rather than at the top level. The key-list lookup above only reads
    // scalar values, so this object is (correctly) skipped by `contextWindow`
    // there, but nothing previously looked inside it for `max_output_tokens`.
    // Live-verified 2026-09 against Poe's own /v1/models: every one of its
    // 344 catalog models carries a real value here (e.g. gpt-4o: 8192,
    // claude-haiku-4.5: 64000), yet 100% of Poe rows showed the generic 4096
    // default because Poe has no top-level duplicate of this field the way
    // it duplicates `context_length`. Only fills in when still at the
    // generic default, same convention as the wafer/zai gap-fills above —
    // never overrides a real top-level value.
    const nestedContextWindow =
      rawModel.context_window &&
      typeof rawModel.context_window === 'object' &&
      !Array.isArray(rawModel.context_window)
        ? (rawModel.context_window as RawModelRecord)
        : undefined;
    if (nestedContextWindow) {
      if (contextWindow === HUB_FETCHER_DEFAULT_CONTEXT_WINDOW) {
        contextWindow =
          this.extractNumber(nestedContextWindow, ['context_length', 'contextWindow']) ||
          HUB_FETCHER_DEFAULT_CONTEXT_WINDOW;
      }
      if (maxOutputTokens === 4096) {
        maxOutputTokens =
          this.extractNumber(nestedContextWindow, ['max_output_tokens', 'maxOutputTokens']) ||
          maxOutputTokens;
      }
    }

    const metadata = this.buildMetadata(rawModel, sourcePath, modelId, rawModelId);
    let capabilities = this.extractCapabilities(metadata, modelId);

    // Fallback: infer capabilities from model ID patterns when provider metadata
    // did not yield any capabilities.
    if (!capabilities || capabilities.length === 0) {
      const inferred = inferCapabilitiesFromModelId(modelId);
      if (inferred) {
        capabilities = inferred.capabilities as ModelCapability[];
        if (metadata) {
          metadata.endpoint = inferred.endpoint;
          metadata.inferredType = inferred.modelType;
        }
      } else {
        // Default: models in /v1/models are most likely chat models
        capabilities = ['chat', 'text_generation'] as ModelCapability[];
      }
    }

    const pricing = this.extractPricing(rawModel);

    // Gap-fill: only when the provider's own response left both context and
    // pricing at their generic defaults (i.e. it supplied neither field) —
    // never overrides a real, provider-supplied value.
    const gapFill = HUB_METADATA_GAP_FILL[this.providerName]?.[modelId];
    if (
      gapFill &&
      contextWindow === HUB_FETCHER_DEFAULT_CONTEXT_WINDOW &&
      pricing.inputCostPer1M === 0 &&
      pricing.outputCostPer1M === 0
    ) {
      contextWindow = gapFill.contextWindow;
      pricing.inputCostPer1M = gapFill.inputCostPer1M;
      pricing.outputCostPer1M = gapFill.outputCostPer1M;
    }

    return {
      id: modelId,
      name: modelId,
      displayName,
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  private buildMetadata(
    rawModel: RawModelRecord,
    sourcePath: string,
    modelId: string,
    rawModelId: string
  ): ModelMetadata {
    const metadata: ModelMetadata = {
      source: `${this.providerName}-api`,
      discoveryPath: sourcePath,
      provider: this.providerName,
      executionProvider: this.providerName,
    };

    const originalProvider =
      this.extractOriginalProviderFromId(modelId) ||
      this.extractOriginalProviderFromId(rawModelId) ||
      this.extractDeclaredProvider(rawModel);
    if (originalProvider) {
      metadata.originalProvider = originalProvider;
      metadata.executionProviders = [this.providerName, originalProvider];
    } else {
      metadata.executionProviders = [this.providerName];
    }
    if (rawModelId !== modelId) {
      metadata.rawModelId = rawModelId;
    }

    const description = this.extractString(rawModel, ['description', 'summary', 'details']);
    if (description) {
      metadata.description = description;
    }

    const endpoint = this.extractString(rawModel, ['endpoint', 'api', 'target_endpoint']);
    if (endpoint) {
      metadata.endpoint = endpoint;
    }

    const supportedParameters = this.extractStringArray(rawModel, [
      'supported_parameters',
      'supportedParameters',
      'parameters',
    ]);
    if (supportedParameters.length > 0) {
      metadata.supported_parameters = supportedParameters;
      // Derive uses_max_completion_tokens from supported_parameters
      if (supportedParameters.includes('max_completion_tokens')) {
        metadata.uses_max_completion_tokens = true;
      }
    }

    const declaredCapabilities = this.extractStringArray(rawModel, [
      'capabilities',
      'features',
      'supported_capabilities',
      'supportedCapabilities',
    ]) as ModelCapability[];

    // `supported_endpoint_types` (UnoRouter and similar OpenAI-compatible
    // aggregators): a vendor-declared list of backend route labels for the
    // model. Mapped via ENDPOINT_TYPE_CAPABILITY_MAP (see that constant's
    // doc comment for the live-verified values and why only a subset of
    // them carry capability information) and folded into the same
    // `declaredCapabilities` bucket as `capabilities`/`features`/etc above —
    // this is provider-declared, not inferred, so it must win over the
    // model-id regex fallback further down in `convertRawModel`.
    const declaredEndpointTypes = this.extractStringArray(rawModel, [
      'supported_endpoint_types',
      'supportedEndpointTypes',
    ]);
    for (const endpointType of declaredEndpointTypes) {
      const mapped = ENDPOINT_TYPE_CAPABILITY_MAP[normalizeProviderToken(endpointType)];
      if (!mapped) continue;
      for (const capability of mapped) {
        if (!declaredCapabilities.includes(capability)) {
          declaredCapabilities.push(capability);
        }
      }
    }

    // Vendor-extension capabilities (wafer serverless): per-surface boolean
    // flags under `wafer.capabilities` — {vision, tools, reasoning, ...} —
    // are the declared source of truth, not the model-id heuristics.
    const vendorExt = this.extractVendorExtension(rawModel);
    const vendorCapabilityFlags = vendorExt?.capabilities as
      | Record<string, unknown>
      | undefined;
    if (vendorCapabilityFlags && typeof vendorCapabilityFlags === 'object') {
      const inferred: ModelCapability[] = [];
      if (vendorCapabilityFlags.reasoning === true) inferred.push('reasoning');
      if (vendorCapabilityFlags.vision === true) inferred.push('vision');
      if (vendorCapabilityFlags.tools === true) {
        inferred.push('tool_use', 'function_calling');
      }
      if (inferred.length > 0) {
        metadata.capabilities = [...declaredCapabilities, ...inferred];
      }
    } else if (declaredCapabilities.length > 0) {
      metadata.capabilities = declaredCapabilities;
    }

    // OpenRouter-style hubs (Poe included) nest the modality declaration
    // under an `architecture` OBJECT — `{ input_modalities, output_modalities,
    // modality }` — rather than at the top level. Only the top-level shape
    // was read here, so this structured, provider-declared "modality-derived"
    // signal (the strongest source after an explicit capability list — see
    // model-capability-merger.ts) was silently dropped for every Poe model:
    // vision detection fell through to the weak description-text keyword
    // regex instead, which live-verified 2026-09 MISSED real vision-capable
    // models whose description just doesn't happen to say "image"/"vision"
    // (e.g. Poe's `claude-haiku-4.5`: `architecture.input_modalities:
    // ["text","image"]`, i.e. genuinely accepts image input, but its
    // description text never uses either word, so the regex fallback never
    // fired and the row carried no `vision` capability at all).
    const nestedArchitecture =
      rawModel.architecture &&
      typeof rawModel.architecture === 'object' &&
      !Array.isArray(rawModel.architecture)
        ? (rawModel.architecture as RawModelRecord)
        : undefined;

    const inputModalities = [
      ...this.extractStringArray(rawModel, ['input_modalities', 'inputModalities']),
      ...(nestedArchitecture
        ? this.extractStringArray(nestedArchitecture, ['input_modalities', 'inputModalities'])
        : []),
    ];
    const outputModalities = [
      ...this.extractStringArray(rawModel, ['output_modalities', 'outputModalities']),
      ...(nestedArchitecture
        ? this.extractStringArray(nestedArchitecture, ['output_modalities', 'outputModalities'])
        : []),
    ];
    if (inputModalities.length > 0 || outputModalities.length > 0) {
      metadata.architecture = {
        input_modalities: [...new Set(inputModalities)],
        output_modalities: [...new Set(outputModalities)],
      };
    }

    return metadata;
  }

  private extractDeclaredProvider(rawModel: RawModelRecord): string | undefined {
    const candidates = ['owned_by', 'provider', 'vendor', 'model_provider', 'source_provider'];
    for (const key of candidates) {
      const value = rawModel[key];
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = normalizeProviderToken(value);
      if (!normalized || normalized === this.providerName) {
        continue;
      }
      return normalized;
    }
    return undefined;
  }

  /**
   * Vendor-extension blob on the model card. Wafer serverless layers its
   * capabilities/pricing under a `wafer` key on an otherwise standard
   * OpenAI-shaped /v1/models entry; extract it here so lookups below can
   * consult it without special-casing every call site per provider.
   */
  private extractVendorExtension(rawModel: RawModelRecord): Record<string, unknown> | undefined {
    const vendor = rawModel.wafer;
    return vendor && typeof vendor === 'object' && !Array.isArray(vendor)
      ? (vendor as Record<string, unknown>)
      : undefined;
  }

  private extractPricing(rawModel: RawModelRecord): ProviderModel['pricing'] {
    // Wafer serverless reports prices as CENTS per million tokens under
    // `wafer.pricing.input_cents_per_million` / `output_cents_per_million`.
    // Convert to the USD-per-1M unit every other path in this file emits.
    const vendorExt = this.extractVendorExtension(rawModel);
    const vendorPricing = vendorExt?.pricing as Record<string, unknown> | undefined;
    if (vendorPricing && typeof vendorPricing === 'object') {
      const inputCents = this.extractNumber(vendorPricing, [
        'input_cents_per_million',
        'inputCentsPerMillion',
      ]);
      const outputCents = this.extractNumber(vendorPricing, [
        'output_cents_per_million',
        'outputCentsPerMillion',
      ]);
      if (inputCents !== undefined || outputCents !== undefined) {
        return {
          inputCostPer1M: inputCents !== undefined ? inputCents / 100 : 0,
          outputCostPer1M: outputCents !== undefined ? outputCents / 100 : 0,
          currency: 'USD',
        };
      }
    }

    const directInputCostPer1M = this.extractNumber(rawModel, [
      'inputCostPer1M',
      'input_cost_per_1m',
      'prompt_cost_per_1m',
    ]);
    const directOutputCostPer1M = this.extractNumber(rawModel, [
      'outputCostPer1M',
      'output_cost_per_1m',
      'completion_cost_per_1m',
    ]);

    if (directInputCostPer1M !== undefined || directOutputCostPer1M !== undefined) {
      return {
        inputCostPer1M: directInputCostPer1M || 0,
        outputCostPer1M: directOutputCostPer1M || 0,
        currency: this.extractString(rawModel, ['currency', 'pricing_currency']) || 'USD',
      };
    }

    const pricingObject =
      rawModel.pricing && typeof rawModel.pricing === 'object'
        ? (rawModel.pricing as Record<string, unknown>)
        : undefined;

    const prompt = this.extractNumberish(
      pricingObject || rawModel,
      pricingObject ? ['prompt', 'input', 'prompt_price', 'promptPrice'] : ['prompt', 'input']
    );
    const completion = this.extractNumberish(
      pricingObject || rawModel,
      pricingObject
        ? ['completion', 'output', 'completion_price', 'completionPrice']
        : ['completion', 'output']
    );

    return {
      inputCostPer1M: this.normalizeTokenPriceToPer1M(prompt),
      outputCostPer1M: this.normalizeTokenPriceToPer1M(completion),
      currency: this.extractString(pricingObject || rawModel, ['currency']) || 'USD',
    };
  }

  // Above this, a computed per-1M price is treated as a unit-detection
  // failure rather than a genuine price — no real published API price for
  // chat completions is known to exceed this (current known max ~$75/Mtok
  // for the priciest frontier output tokens). Observed corruption this
  // guards against: qwen3.5-omni-flash / qwen-turbo / deepseek-v4-pro rows
  // computed at $250-$1200/Mtok (~1000x too high) via the unit-guessing
  // heuristic below, which then poisoned the experiment budget governor
  // (H-B mini-run: quality_multipass blew a $20 arm cap on 2 executions).
  private static readonly PLAUSIBLE_MAX_PER_1M = 100;

  // Canonical (v4/v1) UUID shape — used to detect an opaque internal id so
  // `resolveRawModelId` can fall back to `refId`. See that method's doc
  // comment for the live-verified ORQ.ai case this guards against.
  private static readonly OPAQUE_UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private normalizeTokenPriceToPer1M(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return 0;
    }

    // Heuristic (inherently ambiguous — different hubs declare "prompt"/
    // "completion" price in different units with no field to disambiguate):
    // - very small values (&lt;0.0001) are almost certainly $/token
    // - mid-range values (0.0001-1) are almost certainly $/1k-tokens — this
    //   is the OpenAI-legacy convention several OAI-compat hubs follow, and
    //   was previously misclassified as $/token (×1e6 instead of ×1000),
    //   producing prices ~1000x too high.
    // - larger values are likely already normalized $/1M-tokens.
    let normalized: number;
    if (value < 0.0001) {
      normalized = value * 1_000_000;
    } else if (value < 1) {
      normalized = value * 1_000;
    } else {
      normalized = value;
    }

    // Plausibility clamp: whichever bucket guessed wrong, don't let an
    // implausible price reach the catalog/DB — 0 reads as "unknown" (see
    // PricingMode.none), not "free", so downstream cost estimation falls
    // back to a real default instead of the corrupted figure.
    return normalized <= OpenAICompatibleHubModelFetcher.PLAUSIBLE_MAX_PER_1M ? normalized : 0;
  }

  private extractOriginalProviderFromId(modelId: string): string | undefined {
    const normalizedModelId = normalizeHubModelId(modelId).trim().toLowerCase();
    if (!normalizedModelId) {
      return undefined;
    }

    // workspace@provider/model
    const atIndex = normalizedModelId.indexOf('@');
    const slashIndex = normalizedModelId.indexOf('/');
    if (atIndex > -1 && slashIndex > atIndex) {
      const provider = normalizedModelId.slice(atIndex + 1, slashIndex).trim();
      if (provider && provider !== this.providerName) {
        return provider;
      }
    }

    // provider/model
    if (slashIndex > 0) {
      const provider = normalizedModelId.slice(0, slashIndex).trim();
      if (provider && provider !== this.providerName) {
        return provider;
      }
    }

    // provider@model
    if (atIndex > 0) {
      const provider = normalizedModelId.slice(0, atIndex).trim();
      if (provider && provider !== this.providerName) {
        return provider;
      }
    }

    return undefined;
  }

  private extractString(source: RawModelRecord, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  }

  /**
   * Some hubs' catalog listings key each row by an opaque internal id (a
   * UUID) instead of the human-readable "vendor/model" slug every other
   * source in this fetcher's coverage uses (execution routing and the DB's
   * established id convention both depend on that slug). ORQ.ai's Platform
   * API (`GET /v2/models`) is the confirmed live case: `id` is a UUID like
   * `e48808a5-afa1-4428-a080-259340e89ab0`, while a separate `refId` field
   * carries the real identity, always exactly `${provider}/${model_id}`
   * (live-verified 2026-09-12 against all 244 rows on that endpoint — zero
   * exceptions). Discovery is now pointed at ORQ.ai's router listing
   * (`/v2/router/models`, a plain OpenAI-shaped list that already returns
   * the correct slug directly — see central-model-discovery-service.ts's
   * orqai-hub source) so this branch should not fire in normal operation;
   * it exists as a fallback in case that endpoint is ever unreachable and
   * discovery falls through to the Platform API path.
   *
   * Scoped narrowly to the UUID case so it cannot affect any other hub:
   * no other provider's id convention produces bare UUIDs (see
   * hub-fetcher-model-list-shapes.test.ts for the full set of real shapes
   * this fetcher already parses), and `refId` is not a field name any other
   * hub uses for anything else.
   */
  private resolveRawModelId(rawModel: RawModelRecord): string | undefined {
    const candidate = this.extractString(rawModel, ['id', 'model', 'model_id', 'name', 'slug']);
    if (candidate && OpenAICompatibleHubModelFetcher.OPAQUE_UUID_PATTERN.test(candidate)) {
      const refId = this.extractString(rawModel, ['refId']);
      if (refId && !OpenAICompatibleHubModelFetcher.OPAQUE_UUID_PATTERN.test(refId)) {
        return refId;
      }
    }
    return candidate;
  }

  private extractStringArray(source: RawModelRecord, keys: string[]): string[] {
    for (const key of keys) {
      const value = source[key];
      if (!Array.isArray(value)) {
        continue;
      }
      const parsed = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return [];
  }

  private extractNumberish(source: RawModelRecord, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private extractNumber(source: RawModelRecord, keys: string[]): number | undefined {
    return this.extractNumberish(source, keys);
  }
}
