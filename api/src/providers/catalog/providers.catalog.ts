// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Catalog — Data-Driven Entries
 *
 * Each entry registers ONE provider. Adding a new OpenAI-compatible provider
 * typically costs ~15 lines here and ZERO lines in `provider-registry.ts`.
 *
 * AUTHORING RULES (enforced by Zod schema):
 *   - `providerId`: lowercase-kebab-case, unique.
 *   - `apiKeyEnvVar`: must match `<PROVIDER_ID_UPPER>_API_KEY` unless the
 *      authScheme is hmac-sigv4/iam-token/oauth2/custom.
 *   - `baseUrl`: https only, unless self-hosted.
 *   - `supports` reflects the provider's declared surface. Hints go to
 *      `capabilityHints`. The PER-MODEL capability resolution is STILL done
 *      by the HCRA merger with full provenance.
 *
 * WHAT THIS CATALOG IS NOT:
 *   - It is NOT a per-model capability table.
 *   - It is NOT an authoritative pricing source.
 *   - It is NOT a replacement for the first-party adapters (OpenAI, Anthropic,
 *      Google, etc.) — those remain as dedicated classes in provider-registry.ts.
 *
 * WHEN TO ADD HERE vs WRITE A NEW ADAPTER:
 *   - Provider speaks OpenAI `/v1/chat/completions` and `/v1/models` → catalog entry only.
 *   - Provider has quirks (citations, custom headers, non-standard list path) →
 *      catalog entry with `integrationClass: 'oai-compat-quirks'` + overrides.
 *   - Provider has a fundamentally different API shape (Bedrock Converse,
 *      Anthropic Messages, Vertex Generate) → dedicated adapter class +
 *      `adapterClass` field pointing to it.
 */

import type { ProviderCatalogEntry } from './provider-catalog.types';

/**
 * Complete catalog. Order is the preferred registration order, which also
 * becomes the default execution priority tiebreaker (earlier = higher).
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // LOTE A — OpenAI-compatible pure providers
  // These speak the OpenAI protocol faithfully. Reuse the hub fetcher/adapter.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'groq',
    displayName: 'Groq',
    providerFamily: 'groq',
    integrationClass: 'oai-compat-quirks', // reasoning_format / reasoning_effort / service_tier — not pure
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.groq.com/openai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'GROQ_API_KEY',
    adapterClass: 'GroqAdapter',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true, // llama-3.2 vision family
    },
    capabilityHints: [
      { capability: 'low_latency', rationale: 'provider-class-default', confidence: 0.7 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 50,
    docsUrl: 'https://console.groq.com/docs/api-reference',
    notes: 'Custom LPU hardware, sub-second latency for Llama/Mixtral/Gemma. Dedicated adapter injects reasoning_format/reasoning_effort/service_tier for OSS-reasoning models (gpt-oss, deepseek-r1, qwen-qwq, compound-beta).',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'togetherai',
    displayName: 'Together AI',
    providerFamily: 'togetherai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.together.xyz/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'TOGETHERAI_API_KEY',
    // Live probe 2026-07-17: POST /videos/generations EXISTS and requires the
    // Together-specific body `{model, payload:{...}}` — the flat OAI shape is
    // rejected with "validation failed for field 'payload': expected
    // required". Video model ids validated as accepted at the field layer:
    // openai/sora-2, google/veo-3.0-fast, kwaivgI/kling-2.1-standard (their
    // GET /v1/models lists them with type "video"). Inner payload fields are
    // per-model; response/poll contract still to be proven by a first real
    // generation.
    videoRequestStyle: 'payload-wrap',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      imageGeneration: true, // FLUX, SDXL hosted
      vision: true,
      videoGeneration: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 40,
    docsUrl: 'https://docs.together.ai/reference',
    notes: 'D1 2026-04-24: provisioned key (ailin-togetherai-api-key) returned 401 on /v1/chat — "key_" prefix non-canonical; operator to re-issue if chat 401 persists. Probe 2026-07-17: video surface live-validated to the field-validation layer with THIS key (payload-wrap body; see videoRequestStyle) — auth accepted there.',
    lastReviewedAt: '2026-07-17',
    originalProviderField: 'organization',
  },
  {
    providerId: 'fireworks-ai',
    displayName: 'Fireworks AI',
    providerFamily: 'fireworks-ai',
    aliases: ['fireworks', 'fireworks_ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'FIREWORKS_AI_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      imageGeneration: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 40,
    docsUrl: 'https://docs.fireworks.ai/api-reference',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'deepinfra',
    displayName: 'DeepInfra',
    providerFamily: 'deepinfra',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    authScheme: 'bearer',
    apiKeyEnvVar: 'DEEPINFRA_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      imageGeneration: true,
      speechToText: true,
      textToSpeech: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://deepinfra.com/docs',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'perplexity',
    displayName: 'Perplexity AI',
    providerFamily: 'perplexity',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.perplexity.ai',
    authScheme: 'bearer',
    apiKeyEnvVar: 'PERPLEXITY_API_KEY',
    adapterClass: 'PerplexityAdapter',
    paths: {
      // Perplexity has no /models endpoint. The pinnedFallback below carries
      // the canonical Sonar family list (Phase 4d, 2026-04-28 — was staticModels).
      chatCompletions: '/chat/completions',
    },
    pinnedFallback: {
      // Operator-declared capabilities (root-cause refactor 2026-04-28).
      // All Sonar models are research-grounded chat with web_search; the
      // *-reasoning-* family adds extended reasoning. Declared here directly
      // so the catalog-bridge does NOT fall back to name-regex inference.
      models: [
        { id: 'sonar-small-online', capabilities: ['chat', 'streaming', 'web_search'] },
        { id: 'sonar-medium-online', capabilities: ['chat', 'streaming', 'web_search'] },
        { id: 'sonar-large-online', capabilities: ['chat', 'streaming', 'web_search'] },
        { id: 'sonar-pro', capabilities: ['chat', 'streaming', 'web_search'] },
        {
          id: 'sonar-reasoning',
          capabilities: ['chat', 'streaming', 'web_search', 'reasoning', 'thinking_mode'],
        },
        {
          id: 'sonar-reasoning-pro',
          capabilities: ['chat', 'streaming', 'web_search', 'reasoning', 'thinking_mode'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-22',
    },
    supports: {
      chat: true,
      streaming: true,
    },
    capabilityHints: [
      { capability: 'web_search', rationale: 'provider-class-default', confidence: 0.85 },
      { capability: 'deep_research', rationale: 'docs-declared', confidence: 0.70 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.perplexity.ai/api-reference/chat-completions',
    notes: 'All models are web-search-grounded. Response includes citations[], related_questions[], images[]. Dedicated adapter preserves those extension fields on PerplexityChatResponse.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'cerebras',
    displayName: 'Cerebras',
    providerFamily: 'cerebras',
    integrationClass: 'oai-compat-quirks', // max_completion_tokens normalization
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.cerebras.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    adapterClass: 'CerebrasAdapter',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    capabilityHints: [
      { capability: 'low_latency', rationale: 'provider-class-default', confidence: 0.75 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 45,
    docsUrl: 'https://inference-docs.cerebras.ai/api-reference',
    notes: 'Wafer-scale inference; fastest Llama-70B in market. Dedicated adapter normalizes max_completion_tokens ↔ max_tokens per Cerebras docs.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'hyperbolic',
    displayName: 'Hyperbolic',
    providerFamily: 'hyperbolic',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'HYPERBOLIC_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      imageGeneration: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.hyperbolic.xyz/',
    notes: 'D1 2026-04-24: key provisioned (ailin-hyperbolic-api-key, 73B "sk_liv…") and auth accepted; /v1/chat returns 402 {"detail":"Insufficient funds, please see https://docs.hyperbolic.xyz/docs/hyperbolic-pricing"}. Classified upstream-suspended (not credentials-missing) because the credential itself is valid — only the account balance is zero. Operator top-up unblocks live-validation.',
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'nscale',
    displayName: 'Nscale (EU)',
    providerFamily: 'nscale',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://inference.api.nscale.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'NSCALE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    capabilityHints: [
      { capability: 'eu_sovereign', rationale: 'provider-class-default', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://docs.nscale.com/docs/inference/chat',
    notes: 'EU data sovereignty; GDPR-compliant inference.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'anyscale',
    displayName: 'Anyscale Endpoints',
    providerFamily: 'anyscale',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.endpoints.anyscale.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ANYSCALE_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true, // Anyscale deprecated public endpoints mid-2024; secret provisioned but vendor-side suspended. Adapter still resolves for ANYSCALE_BASE_URL private deployments.
    priority: 10,
    notes: 'Deprecated for new signups. Entry retained for existing enterprise deployments via ANYSCALE_BASE_URL override. D1 2026-04-24: key provisioned (ailin-anyscale-api-key, 236B "aph0_C…") but api.endpoints.anyscale.com returns HTML shutdown notice "Effective August 1, 2024 ... Multi-tenant access to LLM models has been removed." Permanent vendor-side shutdown; classified upstream-suspended. Unblock via private Hosted deployment with ANYSCALE_BASE_URL override.',
    baseUrlEnvVar: 'ANYSCALE_BASE_URL',
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'featherless-ai',
    displayName: 'Featherless AI',
    providerFamily: 'featherless-ai',
    aliases: ['featherless', 'featherless_ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.featherless.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'FEATHERLESS_AI_API_KEY',
    adapterClass: 'FeatherlessAdapter',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://featherless.ai/docs/completions',
    notes: 'Large long-tail HF-model marketplace. Dedicated thin adapter for per-provider observability (logs/metrics scope to `provider: featherless-ai`). No model identifiers hardcoded — the catalog/discovery service is sole source of truth; the adapter is identity-only over the hub.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'nebius',
    displayName: 'Nebius AI Studio',
    providerFamily: 'nebius',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.studio.nebius.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'NEBIUS_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      imageGeneration: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.nebius.com/studio/inference',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'lambda-ai',
    displayName: 'Lambda AI',
    providerFamily: 'lambda-ai',
    aliases: ['lambda', 'lambdalabs'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.lambdalabs.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'LAMBDA_AI_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.lambdalabs.com/public-cloud/lambda-inference-api/',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'sambanova',
    displayName: 'SambaNova Cloud',
    providerFamily: 'sambanova',
    integrationClass: 'oai-compat-pure', // wire protocol is pure OAI; adapter only adds tier hints
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.sambanova.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SAMBANOVA_API_KEY',
    adapterClass: 'SambanovaAdapter',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    capabilityHints: [
      { capability: 'low_latency', rationale: 'provider-class-default', confidence: 0.7 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 40,
    docsUrl: 'https://docs.sambanova.ai/cloud/docs/get-started/overview',
    notes: 'RDU hardware; fast Llama-405B inference. Dedicated adapter only labels observability and exposes FAST_TIER_MODELS hint.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'scaleway',
    displayName: 'Scaleway Generative APIs',
    providerFamily: 'scaleway',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.scaleway.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SCALEWAY_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    capabilityHints: [
      { capability: 'eu_sovereign', rationale: 'provider-class-default', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://www.scaleway.com/en/docs/generative-apis/',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'synthetic',
    displayName: 'Synthetic',
    providerFamily: 'synthetic',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.synthetic.new/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SYNTHETIC_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://synthetic.new/landing/home',
    notes: 'Smaller provider; smoke-test with real key before relying on routing.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'morph',
    displayName: 'Morph',
    providerFamily: 'morph',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.morphllm.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MORPH_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://docs.morphllm.com/',
    notes: 'Fast code-editing specialist. Verify baseUrl before enabling.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'chutes',
    displayName: 'Chutes',
    providerFamily: 'chutes',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://llm.chutes.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'CHUTES_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://chutes.ai/',
    notes: 'D1 2026-04-24: key provisioned (ailin-chutes-api-key, 102B "cpk_8f…") and auth accepted; /v1/chat (Qwen/Qwen3-32B-TEE) returns 402 {"detail":{"message":"Quota exceeded and account balance is $0.0, please pay with fiat or send tao to..."}}. Chutes accepts fiat or TAO (Bittensor token) credit. Classified upstream-suspended. Operator top-up unblocks live-validation.',
    lastReviewedAt: '2026-04-24',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE B — User-prioritized providers
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'zai',
    displayName: 'Z.AI (Zhipu)',
    providerFamily: 'zai',
    aliases: ['zhipu', 'zhipuai', 'bigmodel'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ZAI_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      imageGeneration: true,
      videoGeneration: true,
    },
    capabilityHints: [
      { capability: 'multilingual_chinese', rationale: 'provider-class-default', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.z.ai/devpack/quick-start',
    notes: 'GLM-4 family; strong Chinese + multilingual. Video via CogVideoX.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'xiaomi-mimo',
    displayName: 'Xiaomi MiMo',
    providerFamily: 'xiaomi-mimo',
    aliases: ['xiaomi', 'mimo'],
    integrationClass: 'oai-compat-pure',
    // 2026-04-29: live probe of platform.xiaomimimo.com/v1/models returns the
    // platform's HTML homepage (no JSON listing endpoint exists). Switched
    // to execution-only with pinnedFallback so the catalog row materializes.
    // Model IDs sourced from the Vercel AI Gateway listing (xiaomi/mimo-v2-pro,
    // xiaomi/mimo-v2-flash) plus the platform's own docs (Omni multimodal).
    integrationMode: 'execution-only',
    baseUrl: 'https://platform.xiaomimimo.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'XIAOMI_MIMO_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pinnedFallback: {
      reason: 'no-list-endpoint',
      // Structured form with capabilities — same rationale as v0 above:
      // `mimo-*` ids don't match any built-in regex, so bare strings would
      // trip the `pinnedFallback-capability-coverage` invariant.
      //
      // Architectural note (2026-04-28): the model's Chinese-language
      // affinity is NOT in this strict capabilities array. It lives in
      // `capabilityHints` below (fuzzy soft hint, confidence 0.85) — the
      // strict capabilities surface answers "can the model perform action
      // X?" (boolean), while language strength is a fuzzy quality, not a
      // discrete capability surface. Other Chinese-trained providers
      // (qwen, glm, ernie, deepseek) follow the same convention.
      models: [
        { id: 'mimo-v2-pro', capabilities: ['chat', 'streaming', 'tool_use'] },
        { id: 'mimo-v2-flash', capabilities: ['chat', 'streaming'] },
        { id: 'mimo-omni', capabilities: ['chat', 'streaming', 'vision', 'multimodal'] },
      ],
      lastReviewedAt: '2026-04-29',
    },
    capabilityHints: [
      { capability: 'multilingual_chinese', rationale: 'provider-class-default', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://platform.xiaomimimo.com/#/docs/welcome',
    notes: 'New platform; no /v1/models listing — pinnedFallback covers the 3 published SKUs (MiMo-V2-Pro, V2-Flash, Omni). Cross-checked against Vercel AI Gateway listing 2026-04-29. Uses dedicated XiaomiMimoAdapter for named identity in metrics + circuit-breaker scoping.',
    adapterClass: 'XiaomiMimoAdapter',
    lastReviewedAt: '2026-04-29',
  },
  {
    providerId: 'v0',
    displayName: 'v0 (Vercel)',
    providerFamily: 'v0',
    integrationClass: 'oai-compat-pure',
    // 2026-04-29: live probe api.v0.dev/v1/models returns 404 (Not Found —
    // {"error":{"type":"not_found_error"}}). v0 has no models-listing endpoint;
    // their public docs (v0.app/docs/api/platform/overview) describe a chats
    // / projects / deployments shape, not a model selector. Falling back to
    // pinned list of advertised SKUs. Note: v0 is also exposed via Vercel AI
    // Gateway as `vercel/v0-...` — but the gateway listing today shows zero
    // vercel-owned entries, so the direct row is the canonical reach.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.v0.dev/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'V0_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pinnedFallback: {
      reason: 'no-list-endpoint',
      // Explicit capabilities (not bare strings) so the CI invariant
      // `pinnedFallback-capability-coverage` passes — `v0-*` ids don't match
      // any built-in name-regex, so bare strings would fail the coverage check.
      models: [
        { id: 'v0-1.5-md', capabilities: ['chat', 'streaming', 'tool_use', 'code_generation'] },
        { id: 'v0-1.5-sm', capabilities: ['chat', 'streaming', 'code_generation'] },
        { id: 'v0-1.0-md', capabilities: ['chat', 'streaming', 'code_generation'] },
      ],
      lastReviewedAt: '2026-04-29',
    },
    capabilityHints: [
      { capability: 'frontend_code_generation', rationale: 'provider-class-default', confidence: 0.8 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://v0.app/docs/api/platform/overview',
    notes: 'Specialized in frontend/UI code generation. No /v1/models endpoint — pinnedFallback enumerates the published SKUs.',
    lastReviewedAt: '2026-04-29',
  },
  {
    providerId: 'vercel-ai-gateway',
    displayName: 'Vercel AI Gateway',
    providerFamily: 'vercel-ai-gateway',
    aliases: ['vercel_ai_gateway', 'vercel-gateway'],
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VERCEL_AI_GATEWAY_API_KEY',
    adapterClass: 'VercelAIGatewayAdapter',
    paths: {
      // Vercel implements the OpenAI surface verbatim — confirmed against
      // https://vercel.com/docs/ai-gateway/capabilities/image-generation/openai
      // ("Image-only models use the OpenAI Images API (`/v1/images/generations`)
      // for specialized image creation"). Multimodal LLMs that generate images
      // (Nano Banana, GPT-5 image variants) use `/v1/chat/completions` with
      // images returned in the response's `images` array. Embeddings follow
      // the OpenAI default. Topology: baseUrl already includes `/v1`, so
      // paths here are relative to that.
      //
      // VIDEO: deliberately omitted. The video docs (2026-04-29) only show
      // AI SDK's `experimental_generateVideo` — no published REST shape.
      // When Vercel publishes a REST endpoint, add `videoGenerate` here.
      chatCompletions: '/chat/completions',
      embeddings: '/embeddings',
      imagesGenerate: '/images/generations',
    },
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      // 2026-04-29: align with Vercel's capability matrix. Gateway proxies
      // image (Recraft, BFL, Topaz routes), video (Runway, Topaz), reasoning
      // (o1/o3/Claude-thinking), and exposes web-search via the Responses
      // proxy when the upstream supports it. `rerank`/`moderation` follow
      // when the upstream model declares them via owned_by.
      imageGeneration: true,
      // 2026-07-17: videoGeneration REMOVED — it contradicted the VIDEO note
      // in `paths` above ("deliberately omitted... no published REST shape")
      // and made all 21 vercel video-tagged models enter the execution pool
      // just to 404 on /v1/videos/generations (live sweep re-confirmed: 404
      // on both /videos/generations and /videos). Re-add together with a
      // paths.videoGenerate when Vercel publishes a REST video endpoint.
      reasoning: true,
      rerank: true,
      moderation: true,
    },
    capabilityHints: [
      // `web_search` is not a `supports` flag (catalog enum stops at modality
      // flags); surface it via capabilityHint so the merger picks it up for
      // OpenAI/xAI/Perplexity routes that expose it through the gateway.
      // Rationale `docs-declared`: vercel.com/docs/ai-gateway/capabilities/web-search.
      { capability: 'web_search', rationale: 'docs-declared', confidence: 0.6 },
    ],
    originalProviderField: 'owned_by',
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://vercel.com/docs/ai-gateway',
    notes: 'Gateway routing to OpenAI/Anthropic/xAI/etc. Models namespaced as `provider/model`; adapter exposes parseModelId() + attributeFromDiscovery() so the capability merger attributes to the real owner. Image/video/reasoning/rerank/moderation surface; paths.imagesGenerate=/images/generations matches the OAI Images endpoint. videoGeneration=true reflects model surface, NOT REST availability — Vercel video is AI-SDK-only as of 2026-04-29 (no published REST).',
    lastReviewedAt: '2026-04-29',
  },
  {
    // providerId is `wandb` (not `wandb-inference`) so the convention
    // `WANDB_API_KEY` holds — matches W&B's published SDK/CLI env var name.
    // The longer form lives in aliases for inbound normalization.
    providerId: 'wandb',
    displayName: 'Weights & Biases Inference',
    providerFamily: 'wandb',
    aliases: ['wandb-inference', 'weave'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.inference.wandb.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'WANDB_API_KEY',
    adapterClass: 'WandbAdapter',
    extraEnvVars: {
      WANDB_PROJECT: 'W&B project slug required on requests (header wandb-project)',
    },
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://docs.wandb.ai/weave/quickstart-inference',
    notes: 'OAI-compatible chat surface. Dedicated adapter injects the required `wandb-project` header from $WANDB_PROJECT at request time (env hot-swap safe).',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'voyage',
    displayName: 'Voyage AI',
    providerFamily: 'voyage',
    aliases: ['voyage_ai', 'voyageai'],
    integrationClass: 'embeddings-only',
    // Voyage does NOT expose GET /v1/models (confirmed HTTP 404 on live probe
    // 2026-04-22; cross-checked against docs.voyageai.com — the public API
    // reference covers only /embeddings, /multimodalembeddings, and /rerank).
    // Model identifiers are therefore sourced from the catalog's own
    // enumeration (see MongoDB-hosted Voyage "Models Overview" for the
    // canonical family list). Execution-only reflects that truthfully.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.voyageai.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VOYAGE_API_KEY',
    adapterClass: 'VoyageAdapter',
    paths: {
      embeddings: '/embeddings',
      rerank: '/rerank',
    },
    // Voyage exposes no /models endpoint (execution-only). The pinnedFallback
    // list below covers the stable families as of 2026-04 per blog.voyageai.com
    // and mongodb.com/docs/voyageai/models:
    //   - Voyage-4 series: shared embedding space, interchangeable.
    //   - voyage-3 / voyage-3-lite retained as "previous generation" for
    //     existing indexes; not removed yet per vendor.
    //   - Domain-specific: finance-2, law-2, code-2, code-3, multilingual-2.
    //   - Multimodal: voyage-multimodal-3.
    //   - Rerankers: rerank-2, rerank-2-lite, rerank-2.5, rerank-2.5-lite.
    // Expand when Voyage publishes a new generation; remove deprecated IDs
    // only after the vendor end-of-life window closes.
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='no-list-endpoint' (HTTP 404 confirmed by live probe 2026-04-22).
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Voyage's surface
      // splits cleanly: voyage-* are embedding models (multimodal-3 also
      // accepts image input); rerank-* are retrieval rerankers. Declared
      // here so the catalog-bridge does NOT regex-infer rerank-* as chat
      // (the regex table previously matched them via `rerank-` only after
      // the moderation/transcription rules were ordered correctly).
      models: [
        { id: 'voyage-4-large', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-4', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-4-lite', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-4-nano', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-3', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-3-lite', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-code-3', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-code-2', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-finance-2', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-law-2', capabilities: ['embedding', 'embeddings'] },
        { id: 'voyage-multilingual-2', capabilities: ['embedding', 'embeddings'] },
        {
          id: 'voyage-multimodal-3',
          capabilities: ['embedding', 'embeddings', 'multimodal', 'vision'],
        },
        { id: 'rerank-2.5', capabilities: ['reranking', 'retrieval'] },
        { id: 'rerank-2.5-lite', capabilities: ['reranking', 'retrieval'] },
        { id: 'rerank-2', capabilities: ['reranking', 'retrieval'] },
        { id: 'rerank-2-lite', capabilities: ['reranking', 'retrieval'] },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      embeddings: true,
      rerank: true,
    },
    capabilityHints: [
      { capability: 'rerank', rationale: 'endpoint-declared', confidence: 0.90 },
      { capability: 'long_context_embedding', rationale: 'docs-declared', confidence: 0.80 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 60,
    docsUrl: 'https://docs.voyageai.com/docs/introduction',
    notes: 'Top-tier embeddings + rerank. voyage-3, voyage-code-3, voyage-rerank-2. Voyage does NOT expose GET /v1/models (confirmed 404 via live probe 2026-04-22); discovery is skipped, model IDs are resolved from the catalog/DB. Dedicated adapter implements /v1/embeddings + /v1/rerank and explicitly rejects chat calls.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'volcano',
    displayName: 'Volcano Engine (Volcengine)',
    providerFamily: 'volcano',
    aliases: ['volcengine', 'ark', 'bytedance'],
    integrationClass: 'oai-compat-quirks', // model = endpoint id, no bulk /models route
    integrationMode: 'discovery+execution',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VOLCANO_API_KEY',
    adapterClass: 'VolcanoAdapter',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    capabilityHints: [
      { capability: 'multilingual_chinese', rationale: 'provider-class-default', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://www.volcengine.com/docs/82379/1099455',
    notes: 'ByteDance/Volcano ARK — Doubao models. Strong Chinese coverage. ARK does NOT expose a bulk /models route — dedicated adapter returns empty getModels() and validates the ep-<timestamp>-<random> endpoint-id format.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'watsonx',
    displayName: 'IBM watsonx.ai',
    providerFamily: 'watsonx',
    aliases: ['ibm-watsonx', 'ibm_watsonx'],
    integrationClass: 'first-party-native',
    // Promoted from catalog-only → discovery+execution now that WatsonxAdapter
    // implements the IAM token exchange (+cache), x-watsonx-project-id header,
    // and /ml/v1/text/chat + /ml/v1/text/embeddings routes with version pin.
    integrationMode: 'discovery+execution',
    baseUrl: 'https://us-south.ml.cloud.ibm.com',
    authScheme: 'iam-token',
    apiKeyEnvVar: 'WATSONX_APIKEY',
    baseUrlEnvVar: 'WATSONX_URL',
    extraEnvVars: {
      WATSONX_PROJECT_ID: 'watsonx.ai project ID (required on all generate calls)',
      WATSONX_URL: 'Region-specific host (overrides baseUrl) — us-south, eu-de, jp-tok...',
      WATSONX_ZENAPIKEY: 'Alternative: ZenAPIKey for Cloud Pak for Data',
    },
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://www.ibm.com/watsonx/developer/',
    notes: 'IAM token exchange against https://iam.cloud.ibm.com/identity/token (grant_type=urn:ibm:params:oauth:grant-type:apikey). Requires WATSONX_APIKEY + WATSONX_PROJECT_ID. API version pinned to 2024-05-31.',
    adapterClass: 'WatsonxAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'snowflake',
    displayName: 'Snowflake Cortex',
    providerFamily: 'snowflake',
    integrationClass: 'first-party-native',
    // Promoted from catalog-only → discovery+execution: SnowflakeCortexAdapter
    // (registered in default-adapter-factories) implements JWT key-pair auth,
    // account-scoped baseUrl substitution, and getModels() discovery.
    integrationMode: 'discovery+execution',
    baseUrl: 'https://snowflake.example.snowflakecomputing.com',
    authScheme: 'custom',
    apiKeyEnvVar: 'SNOWFLAKE_PAT',
    extraEnvVars: {
      SNOWFLAKE_ACCOUNT: 'Account identifier (orgname-accountname)',
      SNOWFLAKE_USER: 'Username for key-pair auth',
      SNOWFLAKE_WAREHOUSE: 'Compute warehouse (optional)',
      SNOWFLAKE_BASE_URL: 'Override for baseUrl — https://<account>.snowflakecomputing.com',
    },
    baseUrlEnvVar: 'SNOWFLAKE_BASE_URL',
    supports: {
      chat: true,
      streaming: true,
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api',
    notes: 'JWT key-pair auth via SnowflakeCortexAdapter. Requires SNOWFLAKE_PAT + SNOWFLAKE_USER + SNOWFLAKE_ACCOUNT set together (account-scoped baseUrl). Adapter wired 2026-06-15.',
    adapterClass: 'SnowflakeCortexAdapter',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'sap',
    displayName: 'SAP Generative AI Hub',
    providerFamily: 'sap',
    aliases: ['sap-ai-core', 'sap-genai'],
    integrationClass: 'first-party-native',
    // Promoted from catalog-only → discovery+execution: SapAiCoreAdapter
    // (registered in default-adapter-factories) implements OAuth2 client_credentials
    // token exchange, AI-Resource-Group header injection, and getModels() discovery.
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
    authScheme: 'oauth2',
    apiKeyEnvVar: 'SAP_AI_CORE_CLIENT_ID',
    extraEnvVars: {
      SAP_AI_CORE_CLIENT_SECRET: 'OAuth2 client secret',
      SAP_AI_CORE_AUTH_URL: 'OAuth2 token endpoint',
      SAP_AI_CORE_RESOURCE_GROUP: 'Resource group (default: default)',
      SAP_AI_CORE_BASE_URL: 'Region-specific base URL',
    },
    baseUrlEnvVar: 'SAP_AI_CORE_BASE_URL',
    supports: {
      chat: true,
      streaming: true,
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://help.sap.com/docs/sap-ai-core',
    notes: 'OAuth2 client_credentials via SapAiCoreAdapter. Requires SAP_AI_CORE_CLIENT_ID + SAP_AI_CORE_CLIENT_SECRET + SAP_AI_CORE_AUTH_URL set together (+ optional resource group). Adapter wired 2026-06-15.',
    adapterClass: 'SapAiCoreAdapter',
    lastReviewedAt: '2026-04-21',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE C — Image/Video specialties
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'recraft',
    displayName: 'Recraft',
    providerFamily: 'recraft',
    integrationClass: 'image-only',
    integrationMode: 'execution-only', // no /models endpoint
    baseUrl: 'https://external.api.recraft.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'RECRAFT_API_KEY',
    adapterClass: 'RecraftAdapter',
    paths: {
      imagesGenerate: '/images/generations',
    },
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Recraft v3/v2
      // are pure image-generation models — no /models endpoint exists, so
      // the catalog row IS the source of truth.
      models: [
        { id: 'recraftv3', capabilities: ['image_generation', 'image_editing'] },
        { id: 'recraftv2', capabilities: ['image_generation'] },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      imageGeneration: true,
    },
    capabilityHints: [
      { capability: 'vector_image_generation', rationale: 'docs-declared', confidence: 0.85 },
      { capability: 'brand_style_consistency', rationale: 'docs-declared', confidence: 0.75 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://www.recraft.ai/docs/api-reference/getting-started',
    notes: 'Vector + raster image gen with style controls. Dedicated adapter validates model × style pairs before the wire (v3 has vector families + any, v2 is raster-only).',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'runwayml',
    displayName: 'RunwayML',
    providerFamily: 'runwayml',
    integrationClass: 'video-only',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.dev.runwayml.com',
    authScheme: 'bearer',
    apiKeyEnvVar: 'RUNWAYML_API_KEY',
    adapterClass: 'RunwayMLAdapter',
    extraHeaders: {
      'X-Runway-Version': '2024-11-06',
    },
    paths: {
      videoGenerate: '/v1/image_to_video',
    },
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Runway gen3*
      // are video generation slots; act-one is video-to-video character
      // performance transfer. No /models endpoint, so these are authoritative.
      models: [
        {
          id: 'gen3a_turbo',
          capabilities: ['video_generation', 'image_to_video'],
        },
        {
          id: 'gen3_alpha',
          capabilities: ['video_generation', 'image_to_video'],
        },
        { id: 'act-one', capabilities: ['video_generation', 'video_to_video'] },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      videoGeneration: true,
      imageGeneration: true,
    },
    capabilityHints: [
      { capability: 'image_to_video', rationale: 'docs-declared', confidence: 0.90 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.dev.runwayml.com/',
    notes: 'Video-from-image + act-one motion transfer. Requires X-Runway-Version header. Async-job API: POST /v1/image_to_video → poll GET /v1/tasks/{id} until terminal status. Dedicated adapter owns the polling budget.',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'topaz',
    displayName: 'Topaz Labs',
    providerFamily: 'topaz',
    integrationClass: 'image-only',
    // 2026-05-06: flipped catalog-only → execution-only. The TopazImageAdapter
    // exists at providers/topaz/topaz-adapter.ts AND is wired in the factory
    // registry (see default-adapter-factories.ts: registerAdapterFactory
    // 'TopazImageAdapter'). Topaz exposes no /models listing endpoint —
    // pinnedFallback below is the canonical inventory.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.topazlabs.com/image/v1',
    authScheme: 'api-key-header',
    authHeaderName: 'X-API-Key',
    apiKeyEnvVar: 'TOPAZ_API_KEY',
    pinnedFallback: {
      // Topaz Image API exposes a fixed roster of image-enhance pipelines
      // (upscale, denoise, sharpen, recovery). The 'standard'/'high-fidelity'
      // pair is the canonical chat-routable surface; expand when the API
      // grows new model variants.
      models: [
        { id: 'standard', capabilities: ['image_upscale', 'image_editing', 'image_denoise'] },
        { id: 'high-fidelity', capabilities: ['image_upscale', 'image_editing'] },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-05-06',
    },
    supports: {
      imageEditing: true,
    },
    capabilityHints: [
      { capability: 'image_upscale', rationale: 'docs-declared', confidence: 0.90 },
      { capability: 'image_denoise', rationale: 'docs-declared', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://www.topazlabs.com/api',
    notes: 'Image upscale/enhance only — async job API. Wired via TopazImageAdapter factory.',
    adapterClass: 'TopazImageAdapter',
    lastReviewedAt: '2026-05-06',
  },
  {
    // providerId is `bfl` (not `black-forest-labs`) so the convention
    // `BFL_API_KEY` holds — matches BFL's published env var name. The full
    // brand name stays in `displayName` + `aliases` for humans + inbound norm.
    providerId: 'bfl',
    displayName: 'Black Forest Labs (FLUX)',
    providerFamily: 'bfl',
    aliases: ['black-forest-labs', 'flux'],
    integrationClass: 'image-only',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.bfl.ai/v1',
    authScheme: 'api-key-header',
    authHeaderName: 'x-key',
    apiKeyEnvVar: 'BFL_API_KEY',
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Black Forest Labs
      // FLUX is image-generation + edit. The pro-1.1-ultra variant adds
      // higher-fidelity output but the surface is identical.
      models: [
        { id: 'flux-pro-1.1', capabilities: ['image_generation', 'image_editing'] },
        { id: 'flux-pro', capabilities: ['image_generation', 'image_editing'] },
        { id: 'flux-dev', capabilities: ['image_generation'] },
        { id: 'flux-schnell', capabilities: ['image_generation'] },
        {
          id: 'flux-pro-1.1-ultra',
          capabilities: ['image_generation', 'image_editing'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      imageGeneration: true,
      imageEditing: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.bfl.ai/',
    notes: 'FLUX family. Uses x-key header (not Bearer). Async-job protocol — submit → poll → download.',
    adapterClass: 'BflAdapter',
    lastReviewedAt: '2026-04-29',
  },
  {
    // 302.AI — OAI-compatible aggregator at api.302.ai/v1. Migrated out of
    // the provider-registry.ts switch in 2026-04-22 (residue-closure phase).
    //
    // ── Why providerId is `ai302` and not `302ai` ───────────────────────────
    // Our providerId regex requires a leading alpha character
    // (`/^[a-z][a-z0-9]*.../`). The user-facing name "302ai" begins with a
    // digit, so it can't be a canonical providerId. We keep `302ai` as an
    // alias so historical `config.providers[].name === '302ai'` still resolves
    // and users don't need to migrate their configs.
    //
    // Live-probed 2026-04-22 via GCP secret `ailin-302-key`: upstream returned
    // HTTP 401 with `Insufficient account balance`. That means auth + routing
    // are correct (the token was accepted) — the account simply has zero credit.
    // Classification: "integrated, live-auth-accepted, balance-exhausted".
    providerId: 'ai302',
    displayName: '302.AI',
    providerFamily: 'ai302',
    aliases: ['302ai', '302-ai', '302'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.302.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AI302_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      embeddings: true,
      imageGeneration: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 8,
    docsUrl: 'https://302.ai/',
    notes:
      'OAI-compatible aggregator. Models-list endpoint works when account has balance. Historical user config `{name: "302ai"}` still resolves via the alias table.',
    lastReviewedAt: '2026-04-22',
  },
  {
    // Replicate — first-party-native predictions API. Model versions (not names)
    // drive execution. Sync predictions via `Prefer: wait` header. The adapter
    // existed for months before the catalog migration and is fully functional;
    // this row is the missing factory registration that lets it be resolved.
    providerId: 'replicate',
    displayName: 'Replicate',
    providerFamily: 'replicate',
    integrationClass: 'first-party-native',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.replicate.com/v1',
    baseUrlEnvVar: 'REPLICATE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'REPLICATE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      imageGeneration: true,
      textToSpeech: true,
      speechToText: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 15,
    // Replicate's /v1/models endpoint returns thousands of public predictions,
    // most of which are non-LLM or private to their authors. A wholesale
    // discovery import is worse than a curated canonical list, so this stays
    // execution-only with a deliberate shortlist. Expand when product wants
    // additional Replicate-hosted families on the benchmark grid.
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='curated-shortlist' — the dedicated reason for "endpoint works
    // but signal-to-noise ratio favours a hand-picked list".
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Replicate routes
      // by `owner/name` slug — capabilities are model-specific, NOT inferable
      // from the slug alone (claude-3.5-sonnet is chat+vision; whisper is
      // STT; flux is image; stable-diffusion is image). Declared here so the
      // catalog-bridge does not regress to regex inference, which would
      // mistype `openai/whisper` (whisper-prefixed) as STT-only and miss
      // claude's vision capability entirely.
      models: [
        {
          id: 'anthropic/claude-3.5-sonnet',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'tool_use',
            'reasoning',
          ],
        },
        {
          id: 'black-forest-labs/flux-pro',
          capabilities: ['image_generation', 'image_editing'],
        },
        {
          id: 'black-forest-labs/flux-schnell',
          capabilities: ['image_generation'],
        },
        {
          id: 'meta/meta-llama-3-70b-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        {
          id: 'meta/meta-llama-3-8b-instruct',
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'mistralai/mistral-7b-instruct-v0.2',
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'openai/gpt-4o-mini',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'json_mode',
          ],
        },
        {
          id: 'openai/whisper',
          capabilities: ['speech_to_text', 'transcription', 'audio'],
        },
        {
          id: 'stability-ai/stable-diffusion-3',
          capabilities: ['image_generation'],
        },
      ],
      reason: 'curated-shortlist',
      lastReviewedAt: '2026-04-28',
    },
    docsUrl: 'https://replicate.com/docs',
    notes: 'Predictions API (async-by-default, sync via Prefer: wait). Models are invoked as owner/name or owner/name:version. Adapter handles SSE streams for LLM models and downloads output URLs for image/audio models.',
    adapterClass: 'ReplicateAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    // Bytez — multi-modality hub with a quirky OAI-compat surface.
    // apiKeyEnvVar wired to GCP secret ailin-bytez-key (2026-04-22).
    //
    // URL LAYOUT (documented, confirmed by docs.bytez.com/http-reference):
    //   Chat  (OAI-compat): POST https://api.bytez.com/models/v2/openai/v1/chat/completions
    //   Models list (native shape, NOT OAI):
    //                         GET  https://api.bytez.com/models/v2/list/models?task=chat
    //     Response: { error, output: [{ modelId, task, meter, meterPrice, params, ramRequired }] }
    //   Auth header format: `Authorization: <token>` (sample in docs omits
    //     the `Bearer ` prefix; the hub adapter currently sends `Bearer <token>`,
    //     which several OAI-compat gateways also accept — verify during the
    //     first live probe).
    //
    // Classification consequences:
    //   - `oai-compat-quirks` (not `-pure`) because the OAI path is nested
    //     under `/models/v2/openai/v1` instead of the customary `/v1`.
    //   - `discovery+execution` (Phase 4d, 2026-04-28): the dedicated
    //     `BytezNativeModelFetcher` consumes `/models/v2/list/models`
    //     (non-OAI shape `{error, output:[{modelId,task,...}]}`) and
    //     transforms it into the discovery pipeline's `ProviderModel`
    //     shape. This unlocks Bytez's full ~100k-model HuggingFace surface
    //     instead of the 4-row hand-picked list that previously seeded
    //     execution-only mode.
    //   - Image/speech modalities ride on separate native endpoints (see
    //     docs.bytez.com/http-reference/examples/open-source/*) and are
    //     intentionally NOT in `supports` here — the OAI hub adapter can't
    //     route them without modality-specific transforms. The native
    //     fetcher still surfaces those model IDs for visibility, but
    //     execution requires the modality-specific transforms to land.
    providerId: 'bytez',
    displayName: 'Bytez',
    providerFamily: 'bytez',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.bytez.com/models/v2/openai/v1',
    baseUrlEnvVar: 'BYTEZ_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'BYTEZ_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 12,
    docsUrl: 'https://docs.bytez.com/http-reference/oaiCompliant/chatCompletions',
    notes: 'Multi-modality hub over HuggingFace + custom models. OAI-compat chat/embeddings live at /models/v2/openai/v1/... — NOT /v1/... (quirk). Native discovery GET /models/v2/list/models returns non-OAI shape {error, output:[{modelId,task,...}]}; consumed by BytezNativeModelFetcher (Phase 4d 2026-04-28 — was execution-only with 4 staticModels). Confirmed 2026-04-22 via docs + live probe (old /v1 baseUrl returned HTTP 404 on every path).',
    adapterClass: 'BytezAdapter',
    fetcherClass: 'BytezNativeModelFetcher',
    lastReviewedAt: '2026-04-28',
  },
  {
    // Inworld AI — router + TTS/STT specialist with an OAI-compat chat surface.
    // Orphan-closure entry (2026-04-22): InworldAdapter existed on disk but was
    // never registered in the catalog or provider-registry, so the class was
    // never instantiated. This row + the InworldAdapter factory registration
    // in default-adapter-factories.ts close the orphan.
    //
    // QUIRK 1 — Basic auth (not Bearer).
    //   The INWORLD_API_KEY is already base64-encoded (132 chars in GCP). The
    //   adapter passes `authScheme: 'Basic'` into its hub metadata so the hub's
    //   buildRequestHeaders() prepends `Basic ` (not `Bearer `) at every HTTP
    //   site. Catalog authScheme is 'custom' because the schema enum has no
    //   discrete 'basic' value — the catalog surface is auth-agnostic and the
    //   adapter encodes the concrete scheme.
    //
    // QUIRK 2 — discovery broken on both documented paths.
    //   Live probe 2026-04-22:
    //     GET https://api.inworld.ai/router/v1/models → HTTP 404
    //     GET https://api.inworld.ai/v1/models         → HTTP 404
    //   Upstream docs at https://docs.inworld.ai don't publish a discovery
    //   endpoint; the canonical router surface only exposes chat. So this
    //   entry is `execution-only` with staticModels — the discovery merger
    //   must not probe HTTP for this provider.
    //
    // QUIRK 3 — provider-prefixed model IDs.
    //   Inworld's router exposes upstream model IDs verbatim with their
    //   family prefix (openai/gpt-4o-mini, anthropic/claude-3-haiku, etc.),
    //   which is why the catalog can enumerate a short list without caring
    //   about Inworld's private inventory — the adapter forwards the id.
    //
    // QUIRK 4 — TTS/STT/voice-clone endpoints on the same adapter.
    //   InworldAdapter overrides textToSpeech/speechToText + adds
    //   cloneVoice() on top of the hub. Exposing those in `supports` is
    //   deferred — the CapabilityHintSchema doesn't yet carve out voice-clone,
    //   and speech tests against a metered endpoint burn quota. Until a
    //   capability-level audit happens, `supports.chat` is the safe minimum.
    providerId: 'inworld',
    displayName: 'Inworld AI',
    providerFamily: 'inworld',
    aliases: ['inworld_ai'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.inworld.ai',
    baseUrlEnvVar: 'INWORLD_BASE_URL',
    authScheme: 'custom',
    apiKeyEnvVar: 'INWORLD_API_KEY',
    adapterClass: 'InworldAdapter',
    supports: {
      chat: true,
      streaming: true,
    },
    // Minimum viable pinned fallback — live-probed 2026-04-22 at
    //   POST /v1/chat/completions { model: 'openai/gpt-4o-mini', ... }
    // returned HTTP 200 with a valid ChatCompletion ("Pong!"). Additional
    // families are listed by provider-prefix convention; the router accepts
    // any upstream model ID it has a route for, so this list is
    // intentionally illustrative rather than exhaustive.
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='no-list-endpoint' (router/v1/models AND /v1/models both 404).
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Inworld routes
      // upstream models verbatim; capabilities follow the upstream family.
      // GPT-4o + claude-3-5-sonnet carry vision/multimodal; the rest are
      // text-only chat at the time of pinning.
      models: [
        {
          id: 'openai/gpt-4o-mini',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'json_mode',
          ],
        },
        {
          id: 'openai/gpt-4o',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'json_mode',
          ],
        },
        {
          id: 'anthropic/claude-3-haiku',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        {
          id: 'anthropic/claude-3-5-sonnet',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'tool_use',
            'reasoning',
          ],
        },
        {
          id: 'mistralai/mistral-large',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'meta-llama/llama-3.1-70b-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://docs.inworld.ai',
    notes: 'OAI-compat chat router + TTS/STT/voice-clone. Basic auth (key already base64-encoded in GCP). Discovery endpoints both return 404 (router/v1/models and /v1/models) — catalog supplies model IDs. Orphan-closure entry: the InworldAdapter class existed but was never wired until 2026-04-22.',
    lastReviewedAt: '2026-04-22',
  },
  {
    // Cloudflare Workers AI — OAI-compatible surface on CF's edge, with an
    // account-scoped URL that the hub can't template declaratively. The
    // dedicated adapter substitutes CLOUDFLARE_ACCOUNT_ID into the baseUrl
    // at construction time. Added 2026-04-22.
    providerId: 'cloudflare-workers-ai',
    displayName: 'Cloudflare Workers AI',
    providerFamily: 'cloudflare',
    aliases: ['cloudflare', 'workers-ai', 'cf-workers-ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    // Placeholder — real URL is constructed by the adapter from CLOUDFLARE_ACCOUNT_ID.
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'CLOUDFLARE_API_TOKEN',
    apiKeyEnvVarOverrideReason:
      'CLOUDFLARE_API_TOKEN is the canonical CF-wide env (Cloudflare SDK, wrangler, R2/Workers/DNS). CLOUDFLARE_WORKERS_AI_API_KEY would force users to double-set the same account-scoped token.',
    extraEnvVars: {
      CLOUDFLARE_ACCOUNT_ID: 'Cloudflare account ID — substituted into the Workers AI baseUrl path segment at adapter construction time. Required.',
    },
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
    notes: 'OAI-compatible surface at account-scoped URL. Model ids use @cf/vendor/name convention (e.g. @cf/meta/llama-3-8b-instruct). Workers AI has dedicated per-account neuron rate limits that do NOT share with the account\'s overall CF API quota — diagnose 429s via cf-ray + x-ratelimit-* response headers.',
    adapterClass: 'CloudflareWorkersAIAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    // HuggingFace Inference Providers — OAI-compatible router that fans out
    // to TogetherAI, Fireworks, Replicate, SambaNova, Cerebras, Nebius, etc.
    // on the user's behalf using HF_TOKEN. Uniquely valuable because HF billing
    // deducts from a single source even when inference is physically served
    // by third-party providers.
    providerId: 'huggingface',
    displayName: 'Hugging Face Inference',
    providerFamily: 'huggingface',
    aliases: ['hf', 'hf-inference', 'hf-inference-providers', 'huggingface-inference'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://router.huggingface.co/v1',
    baseUrlEnvVar: 'HUGGINGFACE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'HF_TOKEN',
    apiKeyEnvVarOverrideReason:
      'HF_TOKEN is the canonical env used by the HF CLI, huggingface_hub SDK, and every HF tutorial. HUGGINGFACE_API_KEY would double-set the same token across the hf-login cache and this app.',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 18,
    docsUrl: 'https://huggingface.co/docs/inference-providers/index',
    notes: 'Router that dispatches to TogetherAI/Fireworks/Replicate/etc. using a single HF_TOKEN. Single-tenant billing across heterogeneous backends. Uses dedicated adapter to inject `x-use-cache: false` for benchmark runs (hub default is a cache hit which ruins timing measurement).',
    adapterClass: 'HuggingFaceInferenceAdapter',
    lastReviewedAt: '2026-04-22',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE C.1 — Enterprise hyperscaler gateways (Batch 6)
  //
  // Major-cloud-hosted OpenAI-compatible endpoints with non-trivial URL
  // composition. Each needs a dedicated adapter because the catalog's
  // declarative baseUrl field can't express per-tenant path substitution.
  // Pattern mirrors Cloudflare Workers AI (Batch 5) — factory-time resolution
  // of tenant-scoped variables into a concrete baseUrl; fail-soft sentinel URL
  // when config is missing so unrelated providers can still boot.
  // ──────────────────────────────────────────────────────────────────────────
  {
    // Azure OpenAI — deployment-scoped URL with api-version query string.
    // Most-deployed enterprise LLM gateway on the planet. Single adapter
    // instance per deployment — multi-deployment workspaces register N
    // instances via AZURE_OPENAI_DEPLOYMENTS env (factory handles expansion
    // as a future enhancement; MVP is single-deployment via AZURE_OPENAI_DEPLOYMENT).
    providerId: 'azure-openai',
    displayName: 'Azure OpenAI',
    providerFamily: 'azure-openai',
    aliases: ['azure', 'aoai', 'microsoft-azure-openai'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'execution-only',
    // Placeholder — real URL is constructed by the adapter from
    // AZURE_OPENAI_RESOURCE_NAME + AZURE_OPENAI_DEPLOYMENT + AZURE_OPENAI_API_VERSION.
    baseUrl: 'https://{resource_name}.openai.azure.com/openai/deployments/{deployment}',
    authScheme: 'custom',
    apiKeyEnvVar: 'AZURE_OPENAI_API_KEY',
    extraEnvVars: {
      AZURE_OPENAI_RESOURCE_NAME:
        'Azure resource subdomain (before `.openai.azure.com`). Required unless AZURE_OPENAI_ENDPOINT is set.',
      AZURE_OPENAI_DEPLOYMENT:
        'Azure deployment alias (admin-chosen at deploy time). Required — Azure URLs embed the deployment as a path segment.',
      AZURE_OPENAI_API_VERSION:
        'API version stamp (e.g. 2024-10-21). Required on every request as query string. Defaults to a known-GA version if unset.',
      AZURE_OPENAI_ENDPOINT:
        'Full endpoint override for sovereign clouds (.openai.azure.us, .openai.azure.cn) or private-link FQDNs. Takes precedence over AZURE_OPENAI_RESOURCE_NAME.',
    },
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true, // GPT-4o deployments
      imageGeneration: true, // DALL-E 3 deployments
      textToSpeech: true,
      speechToText: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    // Azure deployments are admin-named aliases that wrap canonical OpenAI
    // models. We list the canonical OpenAI identities here — the adapter
    // resolves the runtime deployment alias via AZURE_OPENAI_DEPLOYMENT, but
    // the benchmark grid wants to know "is gpt-4o available through Azure?",
    // not "is {arbitrary-alias} available". Azure's convention uses `gpt-35`
    // (not `gpt-3.5`) in deployment URLs — keep both spellings here so
    // operators who mirror either convention resolve.
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='per-deployment' — there is no global Azure /models endpoint;
    // the listing is per-deployment and operator-scoped.
    pinnedFallback: {
      // Operator-declared (root-cause refactor 2026-04-28). Azure mirrors
      // the canonical OpenAI families — chat (gpt-*), reasoning (o1-*),
      // and embeddings (text-embedding-*). Capabilities follow OpenAI's
      // declared surface for each family at the model's API version.
      models: [
        {
          id: 'gpt-35-turbo',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'gpt-35-turbo-16k',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'gpt-4',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'gpt-4-turbo',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'json_mode',
          ],
        },
        {
          id: 'gpt-4o',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'json_mode',
          ],
        },
        {
          id: 'gpt-4o-mini',
          capabilities: [
            'chat',
            'streaming',
            'vision',
            'multimodal',
            'function_calling',
            'json_mode',
          ],
        },
        {
          id: 'o1-mini',
          capabilities: ['chat', 'streaming', 'reasoning', 'thinking_mode'],
        },
        {
          id: 'o1-preview',
          capabilities: ['chat', 'streaming', 'reasoning', 'thinking_mode'],
        },
        {
          id: 'text-embedding-3-large',
          capabilities: ['embedding', 'embeddings'],
        },
        {
          id: 'text-embedding-3-small',
          capabilities: ['embedding', 'embeddings'],
        },
        {
          id: 'text-embedding-ada-002',
          capabilities: ['embedding', 'embeddings'],
        },
      ],
      reason: 'per-deployment',
      lastReviewedAt: '2026-04-28',
    },
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/reference',
    notes:
      'Deployment-scoped URL: POST https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={v}. Uses `api-key` header (not Authorization: Bearer) for subscription keys; Microsoft Entra ID bearer tokens work via Authorization header. One adapter instance per deployment — operators with multiple deployments register multiple instances.',
    adapterClass: 'AzureOpenAIAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    // Google AI Studio (Gemini) — OAI-compatible shim endpoint. Distinct
    // from the native `google` provider (which uses @google/generative-ai
    // SDK and native /v1beta/models/{m}:generateContent surface). This
    // entry is for third-party routers that want vanilla OAI-compat chat.
    providerId: 'gemini-openai',
    displayName: 'Google AI Studio (Gemini OAI)',
    providerFamily: 'google',
    aliases: ['google-ai-studio-openai', 'gemini-oai', 'gemini-openai-compat'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlEnvVar: 'GEMINI_OPENAI_BASE_URL',
    authScheme: 'bearer',
    // Google accepts either GEMINI_API_KEY or GOOGLE_AI_STUDIO_API_KEY — the
    // env loader maps both. Catalog declares the canonical one.
    apiKeyEnvVar: 'GEMINI_API_KEY',
    apiKeyEnvVarOverrideReason:
      'GEMINI_API_KEY is canonical in ai.google.dev docs, @google/generative-ai SDK, and Google AI Studio. The native `google` adapter shares it — GEMINI_OPENAI_API_KEY would fork one secret twice.',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    notes:
      'Drop-in OpenAI-compat shim at /v1beta/openai. Same API key as the native `google` adapter (GEMINI_API_KEY). Use this for uniform wire-protocol routing via LiteLLM/OpenRouter-style aggregators; use the native GoogleAdapter for vision/video/grounded-search features that the OAI shim doesn\'t expose.',
    adapterClass: 'GeminiOpenAIAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    // GitHub Models — Microsoft's PAT-auth aggregator that surfaces OpenAI,
    // Meta, Mistral, Cohere models under a single GH-account-scoped endpoint.
    // Positioned as developer playground; aggressive per-PAT rate limits.
    providerId: 'github-models',
    displayName: 'GitHub Models',
    providerFamily: 'github-models',
    aliases: ['github', 'gh-models', 'github-marketplace-models'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://models.github.ai/inference',
    baseUrlEnvVar: 'GITHUB_MODELS_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'GITHUB_TOKEN',
    apiKeyEnvVarOverrideReason:
      'GITHUB_TOKEN is canonical for every GitHub surface — gh CLI, Actions, REST/GraphQL, Octokit. GitHub Models accepts the same PAT; GITHUB_MODELS_API_KEY would force a second PAT per account.',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true, // gpt-4o + Llama Vision deployments
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://docs.github.com/en/github-models',
    notes:
      'GitHub PAT-auth aggregator (OpenAI / Meta / Mistral / Cohere). Free tier has aggressive per-PAT daily+monthly rate limits (50 req/day free tier for cheap models) — 429s are CALLER quota, not provider health. Model ids follow `{publisher}/{name}` convention (e.g. openai/gpt-4o, meta/Meta-Llama-3.1-70B-Instruct). Model catalog at /catalog/models (not /v1/models).',
    adapterClass: 'GitHubModelsAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    // Databricks Model Serving — workspace-scoped, endpoint-scoped URL.
    // Like Azure: one adapter instance per serving endpoint. Multi-endpoint
    // workspaces register multiple instances.
    providerId: 'databricks',
    displayName: 'Databricks Model Serving',
    providerFamily: 'databricks',
    aliases: ['databricks-model-serving', 'databricks-foundation-models'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'execution-only',
    // Placeholder — real URL is constructed by the adapter from
    // DATABRICKS_HOST + DATABRICKS_SERVING_ENDPOINT.
    baseUrl: 'https://{workspace_host}/serving-endpoints/{endpoint}',
    authScheme: 'bearer',
    apiKeyEnvVar: 'DATABRICKS_TOKEN',
    apiKeyEnvVarOverrideReason:
      'DATABRICKS_TOKEN is canonical for the Databricks CLI, databricks-sdk-py, Terraform provider, and every example. DATABRICKS_API_KEY would fork a secret the SDK already reads by name.',
    extraEnvVars: {
      DATABRICKS_HOST:
        'Databricks workspace hostname (e.g. my-co.cloud.databricks.com, dbc-abc123.cloud.databricks.com). Required.',
      DATABRICKS_SERVING_ENDPOINT:
        'Serving endpoint name (admin-chosen). Required — the endpoint IS the model for this adapter instance.',
    },
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    // Databricks Foundation Model APIs are named canonically regardless of
    // workspace — the `databricks-*` prefix is stable across every
    // workspace-region and bills through the same pay-per-token SKU. Admins
    // can ALSO create custom serving endpoints (arbitrary aliases), but those
    // are workspace-local; the benchmark grid only meaningfully references
    // the canonical FM APIs. Expand as Databricks ships new foundation SKUs.
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='workspace-scoped' — every Databricks /serving-endpoints listing
    // is workspace-private.
    pinnedFallback: {
      models: [
        // BGE = BAAI's bge-large-en — pure embedding model.
        {
          id: 'databricks-bge-large-en',
          capabilities: ['embedding', 'embeddings'],
        },
        // DBRX is Databricks' MoE chat model with native tool-use.
        {
          id: 'databricks-dbrx-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // GTE = Alibaba's general text embedding.
        {
          id: 'databricks-gte-large-en',
          capabilities: ['embedding', 'embeddings'],
        },
        // Llama 3.1/3.3 instruct: native tool-use, streaming chat.
        {
          id: 'databricks-meta-llama-3-1-405b-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        {
          id: 'databricks-meta-llama-3-1-70b-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        {
          id: 'databricks-meta-llama-3-3-70b-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // Mixtral 8x7B instruct: chat + streaming + tools.
        {
          id: 'databricks-mixtral-8x7b-instruct',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // MPT predates native tool-use; chat + streaming only.
        {
          id: 'databricks-mpt-30b-instruct',
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'databricks-mpt-7b-instruct',
          capabilities: ['chat', 'streaming'],
        },
      ],
      reason: 'workspace-scoped',
      lastReviewedAt: '2026-04-28',
    },
    docsUrl: 'https://docs.databricks.com/en/machine-learning/model-serving/',
    notes:
      'Workspace + endpoint-scoped URL: POST https://{workspace}.cloud.databricks.com/serving-endpoints/{endpoint}/chat/completions. Endpoint names are admin-chosen aliases (e.g. databricks-llama-3-70b-instruct, databricks-meta-llama-3-3-70b-instruct). One adapter instance per serving endpoint — for multi-endpoint workspaces, register multiple instances.',
    adapterClass: 'DatabricksAdapter',
    lastReviewedAt: '2026-04-22',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE D — Self-hosted / local inference
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'vllm',
    displayName: 'vLLM (self-hosted)',
    providerFamily: 'vllm',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:8000/v1',
    baseUrlEnvVar: 'VLLM_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VLLM_API_KEY',
    apiKeyOptional: true, // vLLM doesn't require auth by default
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    notes: 'Self-hosted OpenAI-compatible server. Set VLLM_BASE_URL to enable. Uses dedicated VllmAdapter for apiKeyOptional handling + named identity.',
    adapterClass: 'VllmAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'lm-studio',
    displayName: 'LM Studio',
    providerFamily: 'lm-studio',
    aliases: ['lmstudio', 'lm_studio'],
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:1234/v1',
    baseUrlEnvVar: 'LM_STUDIO_BASE_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'LM_STUDIO_API_KEY',
    apiKeyOptional: true,
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://lmstudio.ai/docs/local-server',
    notes: 'Local OAI-compatible server bundled with LM Studio desktop. No auth by default. Uses LmStudioAdapter for apiKeyOptional + named identity.',
    adapterClass: 'LmStudioAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'xinference',
    displayName: 'Xinference (Xorbits)',
    providerFamily: 'xinference',
    aliases: ['xorbits', 'xinf'],
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:9997/v1',
    baseUrlEnvVar: 'XINFERENCE_BASE_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'XINFERENCE_API_KEY',
    apiKeyOptional: true,
    supports: {
      chat: true,
      embeddings: true,
      rerank: true,
      streaming: true,
      imageGeneration: true,
      speechToText: true,
      textToSpeech: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://inference.readthedocs.io/en/latest/index.html',
    notes: 'Self-hosted multi-modality runtime. XinferenceAdapter exposes a Cohere-compatible /v1/rerank method on top of the hub OAI surface.',
    adapterClass: 'XinferenceAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'triton',
    displayName: 'NVIDIA Triton Inference Server',
    providerFamily: 'triton',
    aliases: ['triton-inference-server', 'nvidia-triton'],
    integrationClass: 'self-hosted-native',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:8000',
    baseUrlEnvVar: 'TRITON_BASE_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'TRITON_API_KEY',
    apiKeyOptional: true,
    supports: {
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/protocol/extension_generate.html',
    notes: 'Triton KServe v2 HTTP protocol — POST /v2/models/{model}/infer with INPUT/OUTPUT tensor arrays. Adapter converts OAI embedding request into Triton tensor shape and flattens response tensor back to float32[].',
    adapterClass: 'TritonAdapter',
    lastReviewedAt: '2026-04-22',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE E — Migrated from provider-registry.ts switch (2026-04-21)
  //
  // These providers WERE hardcoded switch cases in provider-registry.ts
  // that all instantiated `OpenAICompatibleHubAdapter` with nothing but a
  // baseUrl + apiKey. Moving them here is a lossless migration — the same
  // adapter is built by `CatalogProviderPlugin.initialize()`, sourced from
  // the same env vars. The payoff: the switch shrinks from 41 → 21 cases,
  // and every provider added from now on is a data-row, not code.
  // ──────────────────────────────────────────────────────────────────────────

  // ─── E.1 — Cloud OAI-compatible hubs (single-provider endpoints) ─────────
  {
    providerId: 'nvidia',
    displayName: 'NVIDIA NIM',
    providerFamily: 'nvidia',
    // Lot B (2026-04-22) deleted `case 'nvidia-hub':` from
    // provider-registry.ts. The alias is re-attached here so historical
    // `config.providers[].name === 'nvidia-hub'` entries (or any external
    // caller that still says "nvidia-hub") still resolve to this single
    // catalog row. Same NVIDIA_API_KEY, same integrate.api.nvidia.com
    // endpoint — purely a rename/identity harmonization.
    aliases: ['nvidia-hub'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    baseUrlEnvVar: 'NVIDIA_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 40,
    docsUrl: 'https://docs.api.nvidia.com/nim/',
    notes: 'NVIDIA-hosted NIM microservices. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    providerFamily: 'moonshot',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.moonshot.ai/v1',
    baseUrlEnvVar: 'MOONSHOT_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://platform.moonshot.ai/docs/intro',
    notes: 'Kimi K2 / long-context family. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'minimax',
    displayName: 'MiniMax',
    providerFamily: 'minimax',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.minimax.io/v1',
    baseUrlEnvVar: 'MINIMAX_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://platform.minimaxi.com/document/ChatCompletion',
    notes: 'abab6 / Hailuo family. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'friendli',
    displayName: 'Friendli',
    providerFamily: 'friendli',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.friendli.ai/serverless/v1',
    baseUrlEnvVar: 'FRIENDLI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'FRIENDLI_API_KEY',
    // Team ID header is required for serverless billing attribution. The
    // default below mirrors `config/index.ts`; users override via
    // FRIENDLI_TEAM_ID at runtime — since `extraHeaders` is static JSON at
    // catalog build time, we keep the declared default here. Teams must
    // set their own FRIENDLI_TEAM_ID env if the default is stale.
    extraHeaders: {
      'X-Friendli-Team': process.env.FRIENDLI_TEAM_ID || '',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.friendli.ai/',
    notes: 'Serverless endpoints for open-source LLMs. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },

  // ─── E.2 — Multi-provider aggregators / routers ──────────────────────────
  {
    providerId: 'aihubmix',
    displayName: 'AiHubMix',
    providerFamily: 'aihubmix',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://aihubmix.com/v1',
    baseUrlEnvVar: 'AIHUBMIX_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AIHUBMIX_API_KEY',
    paths: {
      // Live probe 2026-07-17: `/videos/generations` is 404 here, but POST
      // /videos EXISTS and validates ("Missing required parameter: 'prompt'",
      // Aihubmix_api_error) — a video route the catalog didn't know about.
      // Response/poll contract still to be proven by a first real generation.
      videoGenerate: '/videos',
    },
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      vision: true,
      imageGeneration: true,
      videoGeneration: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://aihubmix.com/docs',
    notes: 'Multi-upstream aggregator (OpenAI, Anthropic, Google, etc.). Was switch case; migrated 2026-04-21. Probe 2026-07-17: video route discovered at POST /videos (see paths).',
    lastReviewedAt: '2026-07-17',
  },
  {
    providerId: 'novita',
    displayName: 'Novita AI',
    providerFamily: 'novita',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.novita.ai/openai/v1',
    baseUrlEnvVar: 'NOVITA_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'NOVITA_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      imageGeneration: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://novita.ai/docs/',
    notes: 'GPU-as-a-service + LLM hub. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'aiml',
    displayName: 'AI/ML API',
    providerFamily: 'aiml',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.aimlapi.com/v1',
    baseUrlEnvVar: 'AIML_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AIML_API_KEY',
    paths: {
      // Model list lives on the bare host, not under /v1
      modelList: ['/models', '/v1/models'],
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
      imageGeneration: true,
      speechToText: true,
      textToSpeech: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://docs.aimlapi.com/',
    notes: 'Multi-modal aggregator. modelsBaseUrl quirk in legacy config: /models served from bare host. Migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'imagerouter',
    displayName: 'ImageRouter',
    providerFamily: 'imagerouter',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.imagerouter.io',
    baseUrlEnvVar: 'IMAGEROUTER_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'IMAGEROUTER_API_KEY',
    // Image + video paths are non-standard; routed through the OpenAI-shape
    // endpoints under /v1/openai/*. Catalog declares these so the hub adapter
    // targets the right URLs at runtime.
    paths: {
      imagesGenerate: '/v1/openai/images/generations',
      imagesEdit: '/v1/openai/images/edits',
      videoGenerate: '/v1/openai/videos/generations',
      modelList: ['/v1/models'],
    },
    supports: {
      chat: false,
      imageGeneration: true,
      imageEditing: true,
      videoGeneration: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://imagerouter.io/docs',
    notes: 'Image/video generation router. Quirks: paths differ from standard /v1/images/*. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'orqai',
    displayName: 'ORQ.ai',
    providerFamily: 'orqai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.orq.ai/v2/router',
    baseUrlEnvVar: 'ORQAI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ORQAI_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.orq.ai/',
    notes: 'LLM operations router. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'edenai',
    displayName: 'Eden AI',
    providerFamily: 'edenai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.edenai.run/v3/llm',
    baseUrlEnvVar: 'EDENAI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'EDENAI_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.edenai.co/reference/llm_chat_create',
    notes: 'Multi-provider AI platform aggregator. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'heliconeai',
    displayName: 'Helicone AI Gateway',
    providerFamily: 'heliconeai',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://ai-gateway.helicone.ai/v1',
    baseUrlEnvVar: 'HELICONEAI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'HELICONEAI_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.helicone.ai/getting-started/integration-method/gateway',
    notes: 'Unified gateway proxying many upstreams. Was switch case; migrated 2026-04-21. D1 2026-04-24: live-validated — new ailin-heliconeai-api-key (sk-hel… 43B Virtual Key) replaces legacy ailin-heliconeai-key (11B "PLACEHOLDER"). Gateway routed gpt-4o-mini /chat 200 (1003B completion). Helicone injects its observability shim and forwards to the target vendor (OpenAI here); works with any target-model/Helicone-Target-Url configuration.',
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'cometapi',
    displayName: 'CometAPI',
    providerFamily: 'cometapi',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.cometapi.com/v1',
    baseUrlEnvVar: 'COMETAPI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'COMETAPI_API_KEY',
    paths: {
      // Live probe 2026-07-17: `/videos/generations` is 404 ("Invalid URL"),
      // but POST /videos EXISTS and validates ("model name is required",
      // comet_api_error). Response/poll contract still to be proven by a
      // first real generation.
      videoGenerate: '/videos',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      videoGeneration: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://www.cometapi.com/docs',
    notes: 'Multi-model aggregator. Was switch case; migrated 2026-04-21. Probe 2026-07-17: video route discovered at POST /videos (see paths).',
    lastReviewedAt: '2026-07-17',
  },
  {
    providerId: 'nanogpt',
    displayName: 'Nano GPT',
    providerFamily: 'nanogpt',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://nano-gpt.com/api/v1',
    baseUrlEnvVar: 'NANOGPT_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'NANOGPT_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://nano-gpt.com/docs',
    notes: 'Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'requesty',
    displayName: 'Requesty',
    providerFamily: 'requesty',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://router.requesty.ai/v1',
    baseUrlEnvVar: 'REQUESTY_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'REQUESTY_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.requesty.ai/',
    notes: 'LLM router. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'poe',
    displayName: 'Poe by Quora',
    providerFamily: 'poe',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.poe.com/v1',
    baseUrlEnvVar: 'POE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'POE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://creator.poe.com/docs/external-applications/openai-compatible-api',
    notes: 'Poe OpenAI-compatible endpoint. Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'routeway',
    displayName: 'Routeway',
    providerFamily: 'routeway',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.routeway.ai/v1',
    baseUrlEnvVar: 'ROUTEWAY_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ROUTEWAY_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 15,
    docsUrl: 'https://routeway.ai/docs',
    notes: 'Was switch case; migrated 2026-04-21.',
    lastReviewedAt: '2026-04-21',
  },

  // ─── E.3 — Local OAI-compatible sidecars ─────────────────────────────────
  //
  // These are migrated as `self-hosted-oai-compat`. They use a synthetic
  // apiKeyEnvVar for schema compliance but `apiKeyOptional: true` means the
  // adapter doesn't require it. The legacy config injected literal strings
  // like `apiKey: 'local'` — the catalog path uses whatever env value is
  // present (empty string if nothing set), which the hub adapter tolerates
  // for local servers that don't authenticate.
  //
  // enabledByDefault: true (per the universal "habilitado e nunca censurado"
  // policy). Loader still skips at boot when baseUrlEnvVar is unset — the
  // health check just fails-soft and the entry lands in the skipped bucket.
  {
    providerId: 'ollama',
    displayName: 'Ollama (Local LLM)',
    providerFamily: 'ollama',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:11434/v1',
    // Legacy env var is OLLAMA_URL (not _BASE_URL). Honored here via
    // baseUrlEnvVar so existing deployments keep working.
    baseUrlEnvVar: 'OLLAMA_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'OLLAMA_API_KEY',
    apiKeyOptional: true,
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    pricingMode: 'none',
    // Opt-in: loader only registers when OLLAMA_URL is set in env.
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    notes: 'Local Ollama server. Set OLLAMA_URL (e.g. http://localhost:11434/v1) to enable. Dedicated OllamaAdapter gives named identity for logs/metrics and a subclass seat for future native /api/* endpoints (tags, pull, generate).',
    adapterClass: 'OllamaAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'local-llama',
    displayName: 'Local LLM (llama.cpp)',
    providerFamily: 'local-llama',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:8080/v1',
    baseUrlEnvVar: 'LOCAL_LLAMA_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'LOCAL_LLAMA_API_KEY',
    apiKeyOptional: true,
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md',
    notes: 'llama.cpp server in OpenAI-compat mode. Set LOCAL_LLAMA_URL to enable.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'local-kobold',
    displayName: 'Local VLM (KoboldCpp)',
    providerFamily: 'local-kobold',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:5001/v1',
    baseUrlEnvVar: 'LOCAL_KOBOLD_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'LOCAL_KOBOLD_API_KEY',
    apiKeyOptional: true,
    supports: {
      chat: true,
      streaming: true,
      vision: true, // GGUF + mmproj path
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://github.com/LostRuins/koboldcpp',
    notes: 'KoboldCpp vision-capable local server. Set LOCAL_KOBOLD_URL to enable.',
    lastReviewedAt: '2026-04-21',
  },
  {
    providerId: 'local-embeddings',
    displayName: 'Local Embeddings (ONNX)',
    providerFamily: 'local-embeddings',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:8081/v1',
    baseUrlEnvVar: 'LOCAL_EMBEDDINGS_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'LOCAL_EMBEDDINGS_API_KEY',
    apiKeyOptional: true,
    supports: {
      embeddings: true,
      rerank: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://onnxruntime.ai/',
    notes: 'ONNX Runtime embeddings + rerank server. Set LOCAL_EMBEDDINGS_URL to enable.',
    lastReviewedAt: '2026-04-21',
  },
  // ── Orphan closure (2026-04-23) — Lot B (Writer/Upstage/Reka) ─────────
  // Each of these three OpenAI-compatible providers had an adapter class on
  // disk (WriterAdapter, UpstageAdapter, RekaAIAdapter) and a working key
  // in GCP Secret Manager, but no catalog row and no factory registration —
  // i.e., the exact Inworld failure mode closed in 2026-04-22.
  //
  // Direct fetch probes executed this session against /v1/chat/completions
  // returned HTTP 200 for all three using the loaded keys. Post-closure
  // re-probe via the wired pipeline is scheduled as part of this turn; until
  // that completes, consolidation-matrix.ts pins them to a closure-transient
  // bucket. Mechanically they are full canonical providers from now on.
  {
    providerId: 'writer',
    displayName: 'Writer',
    providerFamily: 'writer',
    integrationClass: 'oai-compat-quirks',
    // execution-only because GET /v1/models returns `{models: [{id, name}]}`
    // (Writer's own shape), not OpenAI's `{data: [{id, object, ...}]}` —
    // the default hub discovery parser skips the body and discovers zero
    // models. Same mitigation as Inworld: hand-supply model IDs here.
    // Post-closure probe (2026-04-23) against /v1/chat/completions using
    // palmyra-x-004 returned HTTP 200 "PONG" — execution path verified.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.writer.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'WRITER_API_KEY',
    adapterClass: 'WriterAdapter',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    // Sourced directly from GET /v1/models on 2026-04-23 with the canonical
    // key. This list reflects upstream AT probe time; treating it as
    // illustrative (not authoritative) — the router accepts any upstream
    // model ID Writer serves. Update when a discovery-parser enhancement
    // lands that handles the `{models: [...]}` shape.
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='proprietary-schema' — `/v1/models` returns Writer's own
    // `{models: [...]}` shape (not OpenAI `{data: [...]}`), which the default
    // OAI hub parser cannot consume; a dedicated `WriterModelFetcher` would
    // unblock discovery+execution but is deferred to a follow-up.
    pinnedFallback: {
      models: [
        // Palmyra X family — flagship general chat with native tools + JSON mode.
        {
          id: 'palmyra-x-004',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'palmyra-x5',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'palmyra-x4',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        {
          id: 'palmyra-x-003-instruct',
          capabilities: ['chat', 'streaming', 'function_calling', 'json_mode'],
        },
        // palmyra-vision IS multimodal upstream, but requires Writer-specific
        // content shape (see notes); declare vision so downstream callers can
        // route correctly even though the adapter currently rejects standard
        // OAI multimodal content arrays.
        {
          id: 'palmyra-vision',
          capabilities: ['chat', 'streaming', 'vision', 'multimodal'],
        },
        // Domain-specialised palmyras: chat-only (no documented tools/JSON).
        {
          id: 'palmyra-med',
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'palmyra-fin',
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'palmyra-creative',
          capabilities: ['chat', 'streaming'],
        },
      ],
      reason: 'proprietary-schema',
      lastReviewedAt: '2026-04-28',
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://dev.writer.com',
    notes: 'Enterprise Palmyra-family chat + generation. OAI-compat execution path (chat/completions); non-standard `{models: [...]}` discovery shape — catalog supplies model IDs until discovery-parser supports the shape. palmyra-vision is listed upstream but requires Writer-specific content shape (standard OAI multimodal content array returns 400 OpenrouterException); vision support deferred to a dedicated adapter extension. Orphan-closure entry 2026-04-23.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'upstage',
    displayName: 'Upstage',
    providerFamily: 'upstage',
    aliases: ['upstage-ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.upstage.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'UPSTAGE_API_KEY',
    adapterClass: 'UpstageAdapter',
    // jsonMode capability confirmed via post-closure probe 2026-04-23
    // against solar-pro with response_format={type:'json_object'} — returned
    // valid {"ok": true}. Upstage's JSON-mode requires the prompt to
    // contain the literal substring "json" (identical to OpenAI's rule).
    // embeddings confirmed via /v1/embeddings probe on solar-embedding-1-
    // large-query: HTTP 200 with real float array.
    supports: {
      chat: true,
      streaming: true,
      embeddings: true,
      tools: true,
      jsonMode: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://developers.upstage.ai',
    notes: 'Solar LLM family + document-AI embeddings. OAI-compat. Orphan-closure entry 2026-04-23: adapter class existed at providers/upstage/ but was never wired. Post-closure live probes (chat, embeddings, jsonMode) all 200.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'rekaai',
    displayName: 'Reka AI',
    providerFamily: 'reka',
    aliases: ['reka', 'reka-ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.reka.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'REKA_API_KEY',
    apiKeyEnvVarOverrideReason:
      'REKA_API_KEY is canonical in docs.reka.ai and their Python SDK. providerId `rekaai` disambiguates the adapter filename; env follows upstream to avoid double-setting the same secret.',
    adapterClass: 'RekaAIAdapter',
    supports: {
      chat: true,
      streaming: true,
      vision: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://docs.reka.ai',
    notes: 'Reka Core / Flash / Edge multimodal chat. OAI-compat surface. Orphan-closure entry 2026-04-23: adapter class existed at providers/rekaai/ but was never wired.',
    lastReviewedAt: '2026-04-23',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE M — 2026-04-23 complementary lot (13 entries)
  //
  // Research basis: per-provider documentation audit on 2026-04-23 against
  // each vendor's official docs URL. All integration classes, auth schemes,
  // and base URLs derived from the authoritative docs (not inferred).
  //
  // Credential state for this lot: all 13 are in credentials-missing /
  // secret-absent at catalog-time (no GCP secret provisioned under any
  // known alias). Exception: `qianfan` is a promotion — 3 Baidu secrets
  // already exist (ailin-baidu-{key,secret,base-url}), but they back the
  // v1 legacy AK+SK OAuth flow, NOT the v2 bce-v3 bearer path this entry
  // canonicalizes; so qianfan enters bucket credentials-missing /
  // auth-incomplete until a QIANFAN_API_KEY (bce-v3 format) is provisioned.
  //
  // Not added this lot (documented in NON_CANONICAL_HISTORICAL_CLAIMS):
  //   - liquid    — no first-party production API; LFM only via OpenRouter
  //   - modelrun  — domain does not resolve (ECONNREFUSED); unverifiable
  //   - ncompass  — base_url unverified in public docs; requires operator
  //                 signup to discover the exact endpoint before canonicalizing
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'arcee',
    displayName: 'Arcee AI',
    providerFamily: 'arcee',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.arcee.ai/api/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ARCEE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      reasoning: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://docs.arcee.ai',
    notes: 'Arcee SLM family (Trinity). OAI-compat chat with OpenRouter-style /models metadata (context_length, pricing, supported_features). Reasoning exposed at response.choices[0].message.reasoning. Lot M 2026-04-23. D1 2026-04-24: key provisioned (ailin-arcee-api-key, 37B "rcai-a…") and auth accepted; /v1/chat (trinity-mini) returns 402 {"detail":"Insufficient credits. Required: 0.000037, Available: 0.000000"}. Classified upstream-suspended.',
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'atlascloud',
    displayName: 'AtlasCloud',
    providerFamily: 'atlascloud',
    aliases: ['atlas-cloud'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.atlascloud.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ATLASCLOUD_API_KEY',
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='no-list-endpoint' (vendor docs document none).
    pinnedFallback: {
      models: [
        // DeepSeek-V3 chat — OAI-compat tools + streaming.
        {
          id: 'deepseek-v3',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // ByteDance Seedream-3.0 — image generation.
        {
          id: 'seedream-3.0',
          capabilities: ['image_generation'],
        },
        // Kling v2.0 — video generation.
        {
          id: 'kling-v2.0',
          capabilities: ['video_generation'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      chat: true,
      streaming: true,
      vision: true,
      imageGeneration: true,
      // 2026-07-17: videoGeneration REMOVED — live probe proved POST
      // /v1/videos/generations AND /v1/videos are both 404 here ("404 page
      // not found"), so the flag only fed the execution pool guaranteed
      // failures for the kling-v2.0 pinned model. Re-add together with a
      // paths.videoGenerate once the real Atlas video route is discovered
      // and live-proven.
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://www.atlascloud.ai/docs',
    notes: 'GPU cloud aggregator. Multi-surface (chat+image+video) under a single OAI-compat base URL. No public GET /models; static model IDs taken from docs. Lot M 2026-04-23. Probe 2026-07-17: no OAI-style video route (404 both candidates) — video de-advertised until a real route is proven.',
    lastReviewedAt: '2026-07-17',
  },
  {
    providerId: 'avian',
    displayName: 'Avian.io',
    providerFamily: 'avian',
    aliases: ['avian-io'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.avian.io/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AVIAN_API_KEY',
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='no-list-endpoint' (no /models endpoint documented).
    pinnedFallback: {
      models: [
        // DeepSeek V3.2 — chat + streaming + tools (OAI-compat).
        {
          id: 'deepseek/deepseek-v3.2',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // Moonshot Kimi K2.6 — chat + streaming + tools + 200k context.
        {
          id: 'moonshotai/kimi-k2.6',
          capabilities: ['chat', 'streaming', 'function_calling', 'long_context'],
        },
        // Z.AI GLM-5.1 — chat + streaming + tools.
        {
          id: 'z-ai/glm-5.1',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://avian.io/docs',
    notes: 'OAI-compat inference aggregator (deepseek, moonshot, z-ai routes). Static model list per docs; no /models endpoint documented. Lot M 2026-04-23.',
    lastReviewedAt: '2026-04-23',
  },
  {
    // Baidu Qianfan (ERNIE platform) — promoted to canonical Lot M 2026-04-23.
    //
    // Pre-promotion state: 3 GCP secrets existed (ailin-baidu-{key,secret,base-url})
    // with load-secrets-into-env.ts mapping ERNIE_API_KEY / ERNIE_SECRET_KEY /
    // BAIDU_BASE_URL, but no catalog row and no adapter — classic
    // "secret-descoberto-mas-não-canônico".
    //
    // Qianfan documents TWO auth paths:
    //   v1 (legacy): AK+SK → OAuth access_token → ?access_token= query param
    //               against aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat
    //   v2 (current OAI-compat): bce-v3/... bearer key against
    //               qianfan.baidubce.com/v2
    //
    // We canonicalize v2 (OAI-compat-quirks). v1 would require a dedicated
    // native adapter that does not exist in this repo; v2 unlocks
    // chat/stream/tools/embed/vision without new adapter code.
    //
    // The existing AK+SK secrets remain mapped (load-secrets-into-env.ts) for
    // any legacy caller that still wants the v1 path, but they are NOT
    // sufficient for this catalog entry's runtime. A QIANFAN_API_KEY
    // (bce-v3/... format) must be provisioned separately in GCP before
    // execution is possible — until then bucket = credentials-missing /
    // auth-incomplete.
    providerId: 'qianfan',
    displayName: 'Baidu Qianfan (ERNIE)',
    providerFamily: 'qianfan',
    aliases: ['baidu', 'ernie', 'baidu-qianfan'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'execution-only',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    baseUrlEnvVar: 'BAIDU_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'QIANFAN_API_KEY',
    apiKeyEnvVarOverrideReason:
      'QIANFAN_API_KEY matches the v2 bce-v3/... bearer format at qianfan.baidubce.com/v2. Legacy ERNIE_API_KEY / ERNIE_SECRET_KEY remain mapped for the v1 AK+SK OAuth flow, not this v2 runtime path.',
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='no-list-endpoint' — Qianfan v2 docs do not document a generic
    // model-list endpoint; ERNIE family IDs are vendor-published.
    pinnedFallback: {
      models: [
        // ERNIE 4.0 8k context — chat + streaming + tools (per Qianfan docs).
        {
          id: 'ernie-4.0-8k',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // ERNIE 3.5 8k context — chat + streaming (tools support partial in 3.5).
        {
          id: 'ernie-3.5-8k',
          capabilities: ['chat', 'streaming', 'function_calling'],
        },
        // ERNIE X1.1 — reasoning model (Baidu's deep-think SKU).
        {
          id: 'ernie-x1.1',
          capabilities: ['chat', 'streaming', 'reasoning', 'thinking_mode'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      embeddings: true,
      vision: true,
      imageGeneration: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html',
    notes: 'PRC-region. Content-safety filters applied server-side. Two auth paths: v1 AK+SK→OAuth (legacy, not wired in this repo) and v2 bce-v3 bearer (our canonical). Sublote A probe 2026-04-23: v2 /chat/completions with empty bearer → HTTP 401 invalid_iam_token (expected); v1 /wenxinworkshop/chat/ernie-4.0-8k with empty access_token → HTTP 200 error_code=3 "Unsupported openapi method" (host reachable, method routing rejects empty auth). Both surfaces confirmed alive.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'gmi',
    displayName: 'GMICloud',
    providerFamily: 'gmi',
    aliases: ['gmicloud', 'gmi-cloud', 'gmi-serving'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.gmi-serving.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'GMI_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
      embeddings: true,
      imageGeneration: true,
      videoGeneration: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.gmicloud.ai',
    notes: 'Serverless + Dedicated GPU platform. Two-plane API: inference at api.gmi-serving.com, provisioning/IAM at console.gmicloud.ai. Video API distinct from LLM API. Sublote C1 2026-04-23: /v1/chat and /v1/embeddings return 404 "No matching target server found for model X" BEFORE auth validation — model routing is pre-auth; 404 with unknown model does NOT imply bad key. Lot M 2026-04-23.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'infermatic',
    displayName: 'Infermatic',
    providerFamily: 'infermatic',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.totalgpt.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'INFERMATIC_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.infermatic.ai',
    notes: "Zero-logs vLLM behind LiteLLM proxy. Roleplay catalog (Sao10K, TheDrummer, Magnum). Domain mismatch: docs on docs.infermatic.ai, API on api.totalgpt.ai. Extra sampling params (top_k, repetition_penalty); some models reject system prompts. Tools NOT documented. Lot M 2026-04-23. D1 2026-04-24: live-validated — ailin-infermatic-api-key (25B sk-12T…) is model-scoped LiteLLM Virtual Key; Qwen-Qwen3-30B-A3B chat 200 (476B). Key ACL pins model list.",
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'inflection',
    displayName: 'Inflection AI (Pi)',
    providerFamily: 'inflection',
    aliases: ['inflection-ai', 'pi', 'pi-inflection'],
    integrationClass: 'oai-compat-pure',
    // 2026-06-15: Inflection shipped a standard OpenAI-compatible API at
    // https://api.inflection.ai/v1 (chat/completions + embeddings, Bearer auth).
    // The old proprietary /external/api/inference path needed a custom adapter;
    // the OAI surface does not. Promoted catalog-only → execution-only — there is
    // no /v1/models listing (discovery is the non-standard /v1/discovery/configs),
    // so the pinnedFallback shortlist below is the inventory.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.inflection.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'INFLECTION_API_KEY',
    pinnedFallback: {
      models: [
        // Inflection-3 Pi — emotionally-intelligent companion chat.
        {
          id: 'inflection_3_pi',
          capabilities: ['chat', 'streaming'],
        },
        // Inflection-3 Productivity — instruction-following + JSON-output tuned.
        {
          id: 'inflection_3_productivity',
          capabilities: ['chat', 'streaming', 'json_mode'],
        },
        // Pi-3.1 — beta agentic SKU.
        {
          id: 'Pi-3.1',
          capabilities: ['chat', 'streaming'],
        },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-06-15',
    },
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://developers.inflection.ai',
    notes: 'OpenAI-compatible API at https://api.inflection.ai/v1 (chat/completions + embeddings, Bearer auth) — no custom adapter needed (the old /external/api/inference proprietary path did). No /v1/models listing (discovery is /v1/discovery/configs, non-standard shape); pinnedFallback carries the documented chat SKUs: inflection_3_pi, inflection_3_productivity (on /v1), Pi-3.1 (legacy OAI-compat path). Promoted first-party-native/catalog-only → oai-compat-pure/execution-only 2026-06-15.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'mancer',
    displayName: 'Mancer',
    providerFamily: 'mancer',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://neuro.mancer.tech/oai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MANCER_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    contentPolicyClass: 'uncensored',
    priority: 5,
    docsUrl: 'https://docs.mancer.tech',
    notes: 'Roleplay/creative ("No filters, No guidelines, No constraints"). Tagged contentPolicyClass=uncensored — fully admitted per universal "habilitado e nunca censurado" policy (Phase 4b 2026-04-28); tag is informational, downstream surfaces may filter. Credit-based pricing (not USD/token). 9 models incl. MythoMax-13B, Goliath-120B, Magnum-72B-v4. SillyTavern primary client. Lot M 2026-04-23.',
    lastReviewedAt: '2026-04-28',
  },
  {
    providerId: 'phala',
    displayName: 'Phala (RedPill TEE)',
    providerFamily: 'phala',
    aliases: ['redpill', 'red-pill'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.redpill.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'PHALA_API_KEY',
    apiKeyEnvVarOverrideReason:
      'RedPill (api.redpill.ai) is the runtime face of Phala Network. We canonicalize env var to `phala` for providerId parity; `redpill-key` / `redpill-api-key` stay as GCP aliases.',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.phala.network',
    notes: 'TEE-attested LLM gateway (NVIDIA H100/H200 Confidential Computing). Every response carries cryptographic attestation verifiable at /phala-cloud/confidential-ai/verify. Aggregates upstream models (Anthropic, OpenAI, DeepSeek, Qwen) running inside enclaves. Lot M 2026-04-23.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'relace',
    displayName: 'Relace',
    providerFamily: 'relace',
    integrationClass: 'first-party-native',
    integrationMode: 'catalog-only',
    baseUrl: 'https://instantapply.endpoint.relace.run/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'RELACE_API_KEY',
    // Phase 4d (2026-04-28): renamed staticModels → pinnedFallback with
    // reason='proprietary-schema'. Relace exposes specialty surfaces
    // (/v1/code/apply, /v1/code/rerank, /v1/embeddings) instead of a
    // generic /v1/models listing — proprietary schema, dedicated
    // RelaceAdapter required. Curated shortlist is the canonical inventory
    // until adapter lands.
    pinnedFallback: {
      models: [
        // Code-apply specialty: structured-edit application, NOT general chat.
        // 'code_edit' captures the surface; we also tag 'coding' for
        // capability-search discoverability (canonical enum value).
        {
          id: 'relace-apply-3',
          capabilities: ['code_edit', 'coding'],
        },
        // Code reranker — reranking + retrieval over a code corpus.
        {
          id: 'relace-code-reranker',
          capabilities: ['reranking', 'retrieval', 'coding'],
        },
        // Code-tuned embedding.
        {
          id: 'relace-embedding',
          capabilities: ['embedding', 'embeddings', 'coding'],
        },
      ],
      reason: 'proprietary-schema',
      lastReviewedAt: '2026-04-28',
    },
    supports: {
      // Specialty code-edit — standard chat surfaces intentionally NOT declared.
      // Proprietary surfaces (codeApply, codeRerank) are not in the generic
      // `supports` enum; documented in notes below until the schema grows.
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.relace.ai',
    notes: 'Specialty code-edit API — NOT a general-purpose chat provider. Proprietary /v1/code/apply merge endpoint (>10k tok/s). Also offers rerank, embed, retrieval. Requires dedicated RelaceAdapter with custom surfaces (codeApply, codeRerank); integrationMode=catalog-only until adapter exists. Precedent: morph. Lot M 2026-04-23.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'siliconflow',
    displayName: 'SiliconFlow',
    providerFamily: 'siliconflow',
    aliases: ['silicon-flow'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.siliconflow.cn/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SILICONFLOW_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
      embeddings: true,
      rerank: true,
      imageGeneration: true,
      imageEditing: true,
      videoGeneration: true,
      speechToText: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.siliconflow.cn',
    notes: 'PRC-region primary (.cn); .com fronts same service. Full multi-surface: chat+image+video+audio+rerank. Supports enable_thinking + thinking_budget (128–32768). Returns x-siliconcloud-trace-id header. Lot M 2026-04-23. D1 2026-04-24: key provisioned (ailin-siliconflow-api-key, 51B "sk-hhc…") but /v1/chat returns 401 bare-JSON "Api key is invalid" (15B oai-compat-quirks shape). sk- prefix non-canonical; probable format mismatch. Sub-class: auth-incomplete.',
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'stepfun',
    displayName: 'StepFun',
    providerFamily: 'stepfun',
    aliases: ['step', 'step-ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.stepfun.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'STEPFUN_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
      embeddings: true,
      imageGeneration: true,
      imageEditing: true,
      speechToText: true,
      textToSpeech: true,
      videoGeneration: true,
      realtime: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://platform.stepfun.com/docs',
    notes: 'OpenAI SDK v1.0+ drop-in compat. Dual-region: api.stepfun.com (PRC) / api.stepfun.ai (global). Realtime voice + cloning. 10-min timeout → 503. Lot M 2026-04-23. D1 2026-04-24: key provisioned (ailin-stepfun-api-key, 65B) but /v1/chat returns 401 OAI-shape {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}. Endpoint alive; specific key rejected. Operator must verify key-account binding. Sub-class: auth-incomplete.',
    lastReviewedAt: '2026-04-24',
  },
  {
    providerId: 'venice',
    displayName: 'Venice AI',
    providerFamily: 'venice',
    aliases: ['venice-ai'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.venice.ai/api/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VENICE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      embeddings: true,
      imageGeneration: true,
      imageEditing: true,
      speechToText: true,
      textToSpeech: true,
      videoGeneration: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    contentPolicyClass: 'uncensored',
    priority: 5,
    docsUrl: 'https://docs.venice.ai',
    notes: 'Privacy-first, no retention. Tagged contentPolicyClass=uncensored (Phase 4b 2026-04-28; informational, downstream may filter). venice_parameters: enable_web_search, character_slug, E2EE, reasoning. Async /audio/queue + /video/queue. Double-path /api/v1. Safety headers x-venice-is-blurred / -contains-minor. Sublote A 2026-04-23: /models PUBLIC; /chat HTTP 402 (USDC Base L2 eip155:8453) alt to bearer — impl bearer-only. Lot M.',
    lastReviewedAt: '2026-04-28',
  },
  // ── Alibaba Cloud (Dashscope / Qwen) — closed 2026-05-06 ──────────────
  // Closes 154 orphan rows in DB that had `provider_id='alibaba'` but no
  // catalog entry. The Alibaba model fetcher
  // (services/model-fetchers/alibaba-model-fetcher.ts) was already
  // populating the DB via `discoverySource: 'alibaba-native'` against
  // Dashscope's OpenAI-compatible endpoint. The runtime adapter side was
  // missing — this row + the standard hub-extending OAI factory wires it
  // through. Dashscope-intl (Singapore) is the default region; operators
  // in mainland China should override DASHSCOPE_BASE_URL to the
  // dashscope.aliyuncs.com endpoint.
  {
    providerId: 'alibaba',
    displayName: 'Alibaba Cloud (Dashscope / Qwen)',
    providerFamily: 'alibaba',
    aliases: ['qwen', 'dashscope', 'alicloud', 'alibaba-cloud'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'QWEN_API_KEY',
    apiKeyEnvVarOverrideReason:
      'QWEN_API_KEY is the canonical env var documented in Dashscope upstream docs and SDK examples',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      embeddings: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope',
    notes: 'Qwen + DeepSeek hosted via Dashscope OAI-compat endpoint. Adds qwen-coder, qwen-vl, qwen-flash, qvq-max + DeepSeek-V3.x mirrors. The pre-existing alibaba-model-fetcher.ts handles discovery (wraps OpenAI client against compatible-mode/v1); this catalog row adds the runtime adapter via the standard hub bridge. Operator override DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 for mainland China region.',
    lastReviewedAt: '2026-05-06',
  },
  // ── AWS Bedrock — closed 2026-05-06 ───────────────────────────────────
  // Closes 125 orphan rows in DB that had `provider_id='aws-bedrock'` but
  // no catalog entry (the legacy switch-case path in provider-registry.ts
  // is unreachable because no config.providers entry has `name:
  // 'aws-bedrock'`). Bedrock requires SigV4 signing — proprietary schema —
  // so integrationClass=first-party-native and a dedicated factory binding
  // (`AwsBedrockAdapter`) constructs the adapter with region + creds from
  // env. Auth methods, in priority order:
  //   1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN)
  //   2. AWS_BEARER_TOKEN_BEDROCK (newer Bedrock-direct auth)
  //   3. Container/Lambda role via AWS SDK default credential chain
  // The factory passes ALL of these through; the adapter chooses based on
  // SDK precedence.
  {
    providerId: 'aws-bedrock',
    displayName: 'AWS Bedrock',
    providerFamily: 'aws-bedrock',
    aliases: ['bedrock', 'aws', 'amazon', 'bedrock-runtime', 'aws-bedrock-runtime'],
    integrationClass: 'first-party-native',
    integrationMode: 'execution-only',
    // Region is selected at request time inside the adapter; baseUrl here
    // is informational/placeholder. AWS SDK constructs the actual URL.
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    // hmac-sigv4: Bedrock auth is AWS Signature V4. The SDK signs each
    // request with credentials from the standard AWS credential chain
    // (env vars → shared config → instance role). Declaring the canonical
    // scheme here also satisfies Zod Rule 1's apiKeyEnvVar exemption for
    // SigV4 — AWS_ACCESS_KEY_ID is the SDK's convention and would force
    // users to double-set if we added an `AWS_BEDROCK_API_KEY` alternative.
    authScheme: 'hmac-sigv4',
    apiKeyEnvVar: 'AWS_ACCESS_KEY_ID',
    apiKeyOptional: true, // role-based auth path bypasses ACCESS_KEY_ID
    adapterClass: 'AwsBedrockAdapter',
    pinnedFallback: {
      // Bedrock model IDs are vendor-pinned identifiers (anthropic.claude-*,
      // amazon.nova-*, meta.llama3-*, mistral.*). The Bedrock /foundation-models
      // listing endpoint returns thousands of vendor variants — we pin a
      // curated roster of the most commonly-used canonical IDs. Operators
      // should expand this list as AWS publishes new SKUs.
      models: [
        { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', capabilities: ['chat', 'tool_use', 'vision', 'streaming'] },
        { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', capabilities: ['chat', 'tool_use', 'streaming'] },
        { id: 'anthropic.claude-3-opus-20240229-v1:0', capabilities: ['chat', 'tool_use', 'vision', 'streaming'] },
        { id: 'amazon.nova-pro-v1:0', capabilities: ['chat', 'tool_use', 'vision', 'streaming'] },
        { id: 'amazon.nova-lite-v1:0', capabilities: ['chat', 'tool_use', 'vision', 'streaming'] },
        { id: 'amazon.nova-micro-v1:0', capabilities: ['chat', 'streaming'] },
        { id: 'meta.llama3-1-70b-instruct-v1:0', capabilities: ['chat', 'streaming'] },
        { id: 'meta.llama3-1-8b-instruct-v1:0', capabilities: ['chat', 'streaming'] },
        { id: 'mistral.mistral-large-2407-v1:0', capabilities: ['chat', 'tool_use', 'streaming'] },
        { id: 'cohere.command-r-plus-v1:0', capabilities: ['chat', 'tool_use', 'streaming'] },
        { id: 'cohere.embed-english-v3', capabilities: ['embeddings'] },
        { id: 'cohere.embed-multilingual-v3', capabilities: ['embeddings'] },
        { id: 'amazon.titan-embed-text-v2:0', capabilities: ['embeddings'] },
      ],
      reason: 'curated-shortlist',
      lastReviewedAt: '2026-05-06',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 40,
    docsUrl: 'https://docs.aws.amazon.com/bedrock/',
    notes: 'AWS Bedrock Converse API. SigV4 auth via AWS SDK default credential chain (AWS_ACCESS_KEY_ID/SECRET, AWS_BEARER_TOKEN_BEDROCK, container role, etc.). Region from AWS_BEDROCK_REGION or AWS_REGION (default us-east-1). Inference-profile ARNs supported via AWS_BEDROCK_INFERENCE_PROFILE_ARN for cross-region routing.',
    lastReviewedAt: '2026-05-06',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE O (2026-07-10) — Apertis + Inception Labs onboarding.
  //
  // Both had GCP secrets provisioned by the operator (ailin-apertis-key,
  // ailin-inception-key) ahead of the catalog rows. No live probe was run
  // this session (gcloud ADC needed interactive reauth, unavailable
  // non-interactively) — see consolidation-matrix.ts 'no-live-validation'
  // bucket. Two sibling providers researched in the same pass — EmpirioLabs
  // AI and Concentrate AI — are intentionally NOT added yet: EmpirioLabs
  // pending a live smoke-test (its docs cite an unfamiliar domain/model
  // lineup), Concentrate AI pending its own bespoke discovery fetcher
  // (nested per-provider model shape, doesn't fit the generic hub fetcher).
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'apertis',
    displayName: 'Apertis',
    providerFamily: 'apertis',
    // Gateway: re-serves 400+ models from 30+ upstream vendors (OpenAI,
    // Anthropic, Google, xAI, Qwen, DeepSeek, ...) behind one OpenAI-
    // compatible surface. `owned_by` on /v1/models attributes the real
    // upstream vendor per model.
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.apertis.ai/v1',
    paths: {
      embeddings: '/embeddings',
      // rerank REMOVED 2026-07-16: /v1/rerank returns 404 "Invalid URL" —
      // the route does not exist on the gateway even though reranker models
      // (BAAI/bge-reranker-v2-m3, Qwen3-Reranker-*) appear in ITS /v1/models
      // catalog. Advertised-but-unrouted; re-add only after a live 200.
      imagesGenerate: '/images/generations',
      // imagesEdit REMOVED 2026-07-16: the /v1/images/edits route parses the
      // multipart body but DROPS the `model` form field — every attempt
      // (model first, model last, different model ids) failed with
      // `The model '' does not exist`. Gateway-side defect; a standard
      // OpenAI SDK images.edit() call would fail identically.
      audioSpeech: '/audio/speech',
      audioTranscriptions: '/audio/transcriptions',
    },
    authScheme: 'bearer',
    apiKeyEnvVar: 'APERTIS_API_KEY',
    adapterClass: 'ApertisAdapter',
    originalProviderField: 'owned_by',
    supports: {
      chat: true,
      streaming: true, // live-probed 2026-07-16: token SSE + [DONE]
      embeddings: true, // live-probed 2026-07-16: text-embedding-3-small 200
      // rerank / imageEditing removed 2026-07-16 — see the paths comments:
      // both surfaces are broken on the provider side (unrouted endpoint /
      // dropped multipart field), not merely untested.
      imageGeneration: true, // route exists; upstream 429-saturated during the 2026-07-16 probe (dall-e-3), so functionally unconfirmed
      speechToText: true, // live-probed 2026-07-16: whisper-1 transcribed real audio
      textToSpeech: true, // route exists (tts-1 in catalog); upstream 429-saturated on all 3 probe attempts, functionally unconfirmed
      vision: true,
    },
    pricingMode: 'none', // hybrid subscription-multiplier + PAYG billing; doesn't fit the remote per-token extractor
    enabledByDefault: true,
    docsUrl: 'https://docs.apertis.ai/api/',
    notes: 'Multi-vendor gateway (400+ models, new-api-style). ApertisAdapter disables its native fallback_models so failures surface to our orchestrator. Probe 2026-07-16: SSE/embeddings/STT proven; imageGen+TTS routes exist, upstream 429-saturated (unconfirmed); rerank 404 + images/edits drops the model field — both removed from supports (see paths comments). dall-e-2 absent; use dall-e-3/gpt-image-*. Video async, out of scope. sk-sub- keys 403 on /audio.',
    lastReviewedAt: '2026-07-16',
  },
  {
    providerId: 'inception',
    displayName: 'Inception Labs (Mercury)',
    providerFamily: 'inception',
    // First-party inference (NOT a broker) — Mercury is a diffusion LLM
    // (dLLM), not autoregressive. OpenAI-compatible chat shape with real
    // quirks: restricted sampling-param surface and a `diffusing` streaming
    // mode with a non-standard SSE contract (see InceptionAdapter).
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'INCEPTION_API_KEY',
    adapterClass: 'InceptionAdapter',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
    capabilityHints: [
      { capability: 'diffusion_lm', rationale: 'docs-declared', confidence: 0.6 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    docsUrl: 'https://docs.inceptionlabs.ai/get-started/get-started',
    notes: 'dLLM (diffusion). NEVER send diffusing:true — confirmed live 2026-07-16: chunks carry diffusion_meta and the FULL rewritten text (naive delta concatenation duplicates output); InceptionAdapter drops the flag and logs. Normal SSE + tool-calling proven same day. temperature server-clamped [0.5,1.0]; adapter clamps client-side. Text-only. FIM/Next-Edit out of scope (non-chat payload).',
    lastReviewedAt: '2026-07-16',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE P (2026-07-11) — EmpirioLabs AI onboarding.
  //
  // Held back in LOTE O pending live validation (docs cited an unfamiliar
  // domain/model lineup — Qwen3-Max, Seed 2.0 Pro, Kling O3, GLM-TTS —
  // that didn't match any known catalog). Operator re-authenticated gcloud
  // (device-code flow) and the real ailin-empiriolabs-key was probed live:
  // GET /v1/models 200 (134+ models incl. real Kling/DeepSeek/Zhipu/Qwen
  // entries) and POST /v1/chat/completions 200 with deepseek-v4-flash
  // ("pong", cost_usd tracked in the response). The domain and models are
  // real — validation gate satisfied, plain catalog-only entry (no quirks
  // requiring a dedicated adapter surfaced for the chat surface).
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'empiriolabs',
    displayName: 'EmpirioLabs AI',
    providerFamily: 'empiriolabs',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.empiriolabs.ai/v1',
    paths: {
      embeddings: '/embeddings',
      rerank: '/reranks',
      // Live probe 2026-07-17: POST /videos/generations resolves MODELS
      // (body {} → "model_not_found" naming a model, i.e. the route exists
      // and got past routing to model resolution). Production attempt on the
      // same day returned 402 insufficient_credits — the surface works; the
      // only blocker is account balance (operator funding decision).
      videoGenerate: '/videos/generations',
    },
    authScheme: 'bearer',
    apiKeyEnvVar: 'EMPIRIOLABS_API_KEY',
    // Confirmed via live probe: model entries carry `"provider":"<vendor>"`
    // (e.g. "kling", "zhipu", "deepseek"), not OpenAI's `owned_by`.
    originalProviderField: 'provider',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      embeddings: true,
      rerank: true,
      videoGeneration: true,
    },
    pricingMode: 'none', // heterogeneous per-unit billing (token/request/image/second); per-response cost_usd is real but /models pricing shape doesn't fit the remote extractor
    enabledByDefault: true,
    docsUrl: 'https://docs.empiriolabs.ai/welcome',
    notes: 'Multi-vendor gateway (134+ models). Probe 2026-07-16: SSE, embeddings (text-embedding-v4), rerank (/reranks PLURAL, qwen3-rerank) and system-override all proven — our system message fully replaces the platform default. Its catalog category field is authoritative (embedding/reranker). CAVEAT: deepseek-v4-flash streams into delta.reasoning_content, content empty at low max_tokens — budget generously. Only /v1/chat/completions wired. Probe 2026-07-17: video route live (blocked only by 402 credits).',
    lastReviewedAt: '2026-07-17',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE Q (2026-07-12) — Concentrate AI onboarding.
  //
  // Meta-aggregator: re-serves OpenAI/Anthropic/Bedrock/Vertex/Azure/Mistral/
  // Cohere/xAI/DeepSeek/MiniMax/z.ai/Moonshot/etc behind one surface (its own
  // `list-providers` enumerates 20 upstream slugs, incl. itself as
  // `concentrate`/`redact` — a PII-redaction feature, not a real inference
  // vendor). Per operator decision (2026-07-10): no gap-filler dedup engineering
  // — cataloged as a normal `gateway`, trusting the pool-builder's cost/quality
  // ranking to naturally deprioritize routes with proxy markup.
  //
  // Discovery is UNAUTHENTICATED — live-probed without any key 2026-07-12:
  // GET /v1/models/providers 200 (20 provider slugs, matches doc exactly) and
  // GET /v1/models/ 200 (`{object:"list",data:[{id,owned_by,...}]}` — same
  // shape the generic hub fetcher already expects, so NO custom fetcher is
  // needed despite the nested per-provider shape on the enrichment endpoints
  // (list-models-by-provider/get-model/get-provider-info) — those are richer
  // cross-reference endpoints we don't need for basic catalog population.
  // Execution (chat/completions) requires the provisioned key; gcloud ADC
  // expired again this session before it could be probed live — see
  // consolidation-matrix.ts `no-live-validation`.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'concentrate',
    displayName: 'Concentrate AI',
    providerFamily: 'concentrate',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.concentrate.ai/v1',
    paths: {
      modelList: ['/models/'],
      chatCompletions: '/chat/completions/',
      responses: '/responses/',
    },
    authScheme: 'bearer',
    apiKeyEnvVar: 'CONCENTRATE_API_KEY',
    originalProviderField: 'owned_by',
    supports: {
      chat: true,
      responses: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none', // pricing lives on the enrichment endpoints (get-model/get-provider-info), not on the flat /v1/models/ list the generic extractor reads
    enabledByDefault: true,
    docsUrl: 'https://concentrate.ai/docs/api-reference/introduction',
    notes: 'Meta-aggregator (20 upstream providers). Discovery unauthenticated; execution paths carry a TRAILING SLASH. Probe 2026-07-16: SSE + /responses/ proven (azure/gpt-4o-mini routing visible, cost breakdown in payload). 424 = ITS upstream vendor failed — classified retryable server_error by provider-error-classifier. Its concentrate/redact-v1 listing is a PII-redaction feature, not an inference vendor.',
    lastReviewedAt: '2026-07-16',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE R (2026-07-13) — FastRouter onboarding.
  //
  // Meta-aggregator ("control plane for routing across multiple LLM
  // providers") — re-serves 20 upstream providers (OpenAI, Anthropic, Azure,
  // Bedrock, Vertex, Groq, Together, Fireworks, DeepInfra, Moonshot, MiniMax,
  // Perplexity, X-AI, Nebius, Baseten, FAL AI, Leonardo, Pollo, BytePlus,
  // itself). Per operator decision (2026-07-10, same as apertis/empiriolabs/
  // concentrate): no gap-filler dedup engineering — cataloged as a normal
  // `gateway`, trusting the pool-builder's cost/quality ranking.
  //
  // Discovery is UNAUTHENTICATED — live-probed without any key 2026-07-13:
  // GET /api/v1/providers 200 (21 provider_id/label pairs) and GET
  // /api/v1/models 200 (real data, `{data:[{id,creator,pricing,...}]}` —
  // same shape the generic hub fetcher expects, INCLUDING a `pricing` object
  // directly on the flat list — unlike apertis/empiriolabs/concentrate,
  // pricingMode can be `remote` here). Execution (chat/completions) requires
  // the provisioned key; gcloud ADC was mid-reauth at catalog-row time — see
  // consolidation-matrix.ts `no-live-validation`.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'fastrouter',
    displayName: 'FastRouter',
    providerFamily: 'fastrouter',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.fastrouter.ai/api/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'FASTROUTER_API_KEY',
    // Confirmed via live probe: model entries carry `"creator":"<vendor>"`
    // (e.g. "Anthropic", "Google", "DeepSeek"), not OpenAI's `owned_by`.
    originalProviderField: 'creator',
    paths: {
      // Live probe 2026-07-17: video is an ASYNC QUEUE at POST /videos
      // (`/videos/generations` has NEVER existed here — 404 Route not found).
      // Submit returns `{data:{taskId,status:"processing"}}` (FastRouter runs
      // its own upstream failover per fr_failover_history); poll GET
      // /videos/{taskId} until data.generations[]/fastrouter_assets.urls[]
      // appear. No cancel route (DELETE and /cancel both 404). CAUTION: the
      // submit endpoint accepts `{model}` WITHOUT prompt and starts a real
      // billable job — never probe it with a routable model id.
      videoGenerate: '/videos',
      videoPoll: '/videos/{taskId}',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      embeddings: true,
      reasoning: true,
      videoGeneration: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    docsUrl: 'https://docs.fastrouter.ai/',
    notes: 'Meta-aggregator (20 upstream, BYOK). /api/v1 canonical (docs show both prefixes). Probe 2026-07-16: SSE proven (:FASTROUTER PROCESSING comment keep-alives + own final usage chunk with cost+provider before [DONE]); embeddings proven; :flex suffix proven (service_tier flex). Model ids provider/model may carry :price/:throughput/:flex — do not strip. fastrouter/auto not used (ci does its own selection). 402 = insufficient credits. Probe 2026-07-17: video async-queue surface mapped live (see paths).',
    lastReviewedAt: '2026-07-17',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE S (2026-07-13) — Perplexity Agent API onboarding.
  //
  // Operator asked whether the EXISTING `perplexity` row (classic Sonar-only
  // /chat/completions) also served Anthropic/OpenAI/Google/xAI/Z.AI/Moonshot/
  // NVIDIA models. It doesn't — but a SEPARATE Perplexity product does: the
  // "Agent API" (`/v1/agent`, aliased `/v1/responses`), a genuinely different
  // wire protocol (Responses-style input/output, not messages/choices) under
  // the SAME Perplexity account/key. Modeled as its own catalog row rather
  // than extending `perplexity` — the two surfaces have disjoint model
  // namespaces (sonar-* vs vendor/model), disjoint wire shapes, and one
  // catalog row = one execution surface is the established convention here.
  //
  // Live-probed 2026-07-13 with the real ailin-perplexity-api-key (same
  // GCP secret as the classic `perplexity` row — no separate key was
  // provisioned; PROVIDER_SECRETS below points PERPLEXITY_AGENT_API_KEY at
  // the same secret names):
  //   - GET /v1/models 200, AUTHENTICATED, real OpenAI-list shape
  //     (`{data:[{id,object,owned_by,created}]}`) — 32 models across
  //     anthropic/google/nvidia/openai/xai/perplexity(-owned: glm-5.2,
  //     kimi-k2.7-code, sonar).
  //   - POST /v1/agent 200 for: anthropic/claude-haiku-4-5, openai/gpt-5.4-mini
  //     (NOT "gpt-5-mini" — that id doesn't exist, hangs), google/gemini-3.5-flash,
  //     xai/grok-4.5, perplexity/glm-5.2 (z.ai). Also confirmed `input` accepts
  //     a role+content array (same shape as our ChatMessage[]), not just a
  //     flat string.
  //   - perplexity/kimi-k2.7-code (Moonshot): accepted by model-id validation
  //     (wrong ids reject fast with 400; this one doesn't) but every live call
  //     hung with zero response bytes past 90s — left wired, NOT confirmed
  //     working. Not in live-validation evidence below for that reason.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'perplexity-agent',
    displayName: 'Perplexity Agent API',
    providerFamily: 'perplexity-agent',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.perplexity.ai/v1',
    authScheme: 'bearer',
    // Shares the same physical credential as the classic `perplexity` row
    // (one Perplexity account, two API surfaces) — deliberately a distinct
    // env var (not a typo/dup) so PROVIDER_SECRETS can source both from the
    // same GCP secret independently. Naturally matches the <PROVIDERID>_API_KEY
    // convention (perplexity-agent -> PERPLEXITY_AGENT_API_KEY); no Zod Rule 1
    // override needed.
    apiKeyEnvVar: 'PERPLEXITY_AGENT_API_KEY',
    adapterClass: 'PerplexityAgentAdapter',
    originalProviderField: 'owned_by',
    supports: {
      chat: true,
      streaming: true, // real SSE since 2026-07-16 — Responses-dialect parser in the adapter (shape captured live)
      tools: true, // live-probed 2026-07-16: flat Responses-style tools in, function_call items out (adapter converts both directions)
      reasoning: true,
    },
    pricingMode: 'none', // /v1/models discovery response carries no pricing object (unlike fastrouter); cost is only visible per-response (usage.cost) after a real call
    enabledByDefault: true,
    docsUrl: 'https://docs.perplexity.ai/docs/agent-api/models',
    notes: 'Second Perplexity surface (same account/key as `perplexity`): /v1/agent, Responses-style, NOT chat/completions. REAL token streaming since 2026-07-16 (response.output_text.delta / response.completed; NO [DONE]; gappy sequence_number) — unit-tested against the live-captured fixture. Tools proven live (flat shape; toolu_bdrk_ ids reveal Bedrock-served Anthropic). Moonshot kimi-k2.7-code works but hangs intermittently when cold — orchestrator timeout+fallback covers it.',
    lastReviewedAt: '2026-07-16',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE T (2026-07-13) — Ailin gateway. Self-referential meta-provider. Lets
  // any deployment of this engine (this codebase, self-hosted by a third
  // party) reach the full ~100-provider / 70k+-model catalog through a single
  // AILIN_API_KEY instead of provisioning every upstream provider's own key
  // directly — see api.ailin.one's own docs/reference/endpoints/authentication.md,
  // which already documents AILIN_API_KEY as the `X-API-Key` credential
  // customers send inbound. This entry is the outbound mirror: THIS engine,
  // acting as a client of api.ailin.one. Inert for Ailin's own canonical
  // api.ailin.one deployment, since nothing there sets AILIN_API_KEY — the
  // loader's missing-api-key skip path (catalog-loader.ts) makes that a no-op,
  // not a self-call loop.
  //
  // discovery+execution, with a known heuristic gap: chat/embeddings/images/
  // audio were verified against api.ailin.one's own openapi-spec.yaml to be
  // bare OpenAI-compatible request/response shape at the generic hub's
  // default paths (no `paths` override needed). GET /v1/models was checked
  // too — its `data[]` items carry `id` and `originProvider` (both understood
  // by the generic fetcher: `id` always, `originProvider` via
  // `originalProviderField` below) but ALSO ailin-native fields the generic
  // fetcher does not understand (`operability`, `nonOperationalReasons`,
  // `fallbackChain`, `resolvedProvider`). Net effect: discovery will surface
  // every listed model, including ones ailin's own orchestration currently
  // marks `non_operational` — those may 4xx on execution until a dedicated
  // fetcher maps the richer shape (follow-up, not guessed at here). Given
  // the ~70k-model, constantly-shifting catalog, a hand-pinned fallback list
  // would be stale on arrival and violates this project's no-static-model
  // rule, so this entry accepts the heuristic gap over inventing one.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'ailin',
    displayName: 'Ailin (api.ailin.one)',
    providerFamily: 'ailin',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.ailin.one/v1',
    authScheme: 'api-key-header',
    authHeaderName: 'X-API-Key',
    apiKeyEnvVar: 'AILIN_API_KEY',
    originalProviderField: 'originProvider',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      reasoning: true,
      imageGeneration: true,
      imageEditing: true,
      speechToText: true,
      textToSpeech: true,
      moderation: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 0,
    notes: 'Meta-gateway to ~100 upstream providers / 70k+ models behind api.ailin.one\'s own orchestration. Discovery uses the generic hub fetcher against a richer native /v1/models shape it only partly understands (see header comment) — operability filtering is a known follow-up gap. Auth is X-API-Key; api.ailin.one also accepts bearerAuth JWT for user sessions, not used here (static server credential).',
    lastReviewedAt: '2026-07-13',
  },
] as const satisfies readonly ProviderCatalogEntry[];
