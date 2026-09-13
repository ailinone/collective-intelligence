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
import { deriveFromCatalogEntry } from './provider-catalog.types';

/**
 * GAP-A10 (LOTE AM, 2026-09-05) proof of concept: plan/token-plan rows that
 * share a vendor's protocol quirks with an existing sibling row and differ
 * ONLY in host + plan-bound credential are declared via
 * `deriveFromCatalogEntry(parent, overrides)` instead of copy-pasting the
 * parent's `integrationClass`/`supports`/`pricingMode`/etc. by hand — see
 * that function's doc comment in provider-catalog.types.ts and GAP-A10 in
 * reports/provider-integration-gap-register.json for the full rationale.
 *
 * These three consts must be declared before `PROVIDER_CATALOG` below (they
 * are referenced from inside that one array literal, both directly — at
 * these rows' original position — and via `deriveFromCatalogEntry()` at
 * their derived sibling's position).
 */
const ALIBABA_CODING_ENTRY: ProviderCatalogEntry = {
  providerId: 'alibaba-coding',
  displayName: 'Alibaba Coding Plan',
  providerFamily: 'alibaba',
  integrationClass: 'oai-compat-pure',
  integrationMode: 'discovery+execution',
  baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  baseUrlEnvVar: 'ALIBABA_CODING_BASE_URL',
  authScheme: 'bearer',
  apiKeyEnvVar: 'ALIBABA_CODING_API_KEY',
  supports: { chat: true, streaming: true, tools: true },
  pricingMode: 'none',
  enabledByDefault: true,
  priority: 30,
  docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
  notes:
    'LOTE AI (2026-09-03); coding-plan deployment profile of alibaba family (plan-bound credential); NOT yet live-probed.',
  lastReviewedAt: '2026-09-03',
};

const ZAI_CODING_ENTRY: ProviderCatalogEntry = {
  providerId: 'zai-coding',
  displayName: 'Z.AI Coding Plan',
  providerFamily: 'zai',
  integrationClass: 'oai-compat-pure',
  integrationMode: 'discovery+execution',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  baseUrlEnvVar: 'ZAI_CODING_BASE_URL',
  authScheme: 'bearer',
  apiKeyEnvVar: 'ZAI_CODING_API_KEY',
  supports: { chat: true, streaming: true, tools: true },
  pricingMode: 'none',
  enabledByDefault: true,
  priority: 30,
  docsUrl: 'https://docs.z.ai/devpack/overview',
  notes:
    'LOTE AI (2026-09-03); coding-plan profile of zai family (api.z.ai intl host); NOT yet live-probed. LOTE AM (2026-09-05) capability audit, MEDIUM confidence: jsonMode underclaim noted (response_format documented on the general zai API sharing this host family, NOT independently confirmed for this exact coding-plan proxy path) but NOT added — below this catalog\'s HIGH-confidence bar for additions.',
  lastReviewedAt: '2026-09-05',
};

const MINIMAX_TOKEN_PLAN_ENTRY: ProviderCatalogEntry = {
  providerId: 'minimax-token-plan',
  displayName: 'MiniMax Token Plan',
  providerFamily: 'minimax',
  integrationClass: 'oai-compat-pure',
  integrationMode: 'discovery+execution',
  baseUrl: 'https://api.minimax.io/v1',
  baseUrlEnvVar: 'MINIMAX_TOKEN_PLAN_BASE_URL',
  authScheme: 'bearer',
  apiKeyEnvVar: 'MINIMAX_TOKEN_PLAN_API_KEY',
  supports: { chat: true, streaming: true, tools: true },
  pricingMode: 'none',
  enabledByDefault: true,
  priority: 30,
  docsUrl: 'https://platform.minimax.io/docs/token-plan/intro',
  notes:
    'LOTE AJ: GAP-A9 blocker obsolete — Token Plan is OpenAI-compatible (GET /v1/models docs-verified). Subscription Key (sk-cp-*) NOT interchangeable with pay-as-you-go MINIMAX_API_KEY. NOT live-probed. LOTE AM capability audit, MEDIUM: vision underclaim noted (confirmed on shared platform.minimax.io API, not independently for this host) but NOT added — see minimax-token-plan-cn (HIGH, vision added there).',
  lastReviewedAt: '2026-09-05',
};

/**
 * LOTE AR (2026-09-06) GAP-A10 rollout: three more sibling pairs found by a
 * full-catalog scan to be pure mechanical spreads (identical `supports`,
 * identical integrationClass, no capability-audit or route-evidence
 * asymmetry between hosts) — see GAP-A10 in
 * reports/provider-integration-gap-register.json for the full evidence per
 * pair and for the 7 pairs evaluated and correctly NOT converted.
 */
const MOONSHOT_ENTRY: ProviderCatalogEntry = {
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
};

const MINIMAX_ENTRY: ProviderCatalogEntry = {
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
  notes:
    'abab6 / Hailuo family. Was switch case; migrated 2026-04-21. Live-verified 2026-08-01: real key confirmed — GET /v1/models 200 (8 models). POST /v1/chat/completions with MiniMax-M3 → 200. M-series models emit a `<think>` preamble by default; low max_tokens can truncate mid-think — expected, not a fault. Parsers should account for the think block.',
  lastReviewedAt: '2026-08-01',
};

const OPENCODE_ZEN_ENTRY: ProviderCatalogEntry = {
  providerId: 'opencode-zen',
  displayName: 'OpenCode Zen',
  providerFamily: 'opencode',
  integrationClass: 'oai-compat-pure',
  integrationMode: 'discovery+execution',
  baseUrl: 'https://opencode.ai/zen/v1',
  baseUrlEnvVar: 'OPENCODE_ZEN_BASE_URL',
  authScheme: 'bearer',
  apiKeyEnvVar: 'OPENCODE_ZEN_API_KEY',
  supports: { chat: true, streaming: true, tools: true },
  pricingMode: 'none',
  enabledByDefault: true,
  priority: 30,
  docsUrl: 'https://opencode.ai/docs/zen',
  notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.',
  lastReviewedAt: '2026-09-03',
};

const STEPFUN_STEP_PLAN_ENTRY: ProviderCatalogEntry = {
  providerId: 'stepfun-step-plan',
  displayName: 'StepFun Step Plan',
  providerFamily: 'stepfun',
  integrationClass: 'oai-compat-pure',
  integrationMode: 'discovery+execution',
  baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  baseUrlEnvVar: 'STEPFUN_STEP_PLAN_BASE_URL',
  authScheme: 'bearer',
  apiKeyEnvVar: 'STEPFUN_STEP_PLAN_API_KEY',
  supports: { chat: true, streaming: true, tools: true, reasoning: true },
  pricingMode: 'none',
  enabledByDefault: true,
  priority: 30,
  docsUrl: 'https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api',
  notes:
    'LOTE AI (2026-09-03); step-plan profile of stepfun family (intl host); NOT yet live-probed. Deliberately narrower supports than the flagship `stepfun` row (no vision/embeddings/audio) — the Step Plan bundles only specific reasoning models.',
  lastReviewedAt: '2026-09-03',
};

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
    notes:
      'Custom LPU hardware, sub-second latency for Llama/Mixtral/Gemma. Dedicated adapter injects reasoning_format/reasoning_effort/service_tier for OSS-reasoning models (gpt-oss, deepseek-r1, qwen-qwq, compound-beta).',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'togetherai',
    displayName: 'Together AI',
    providerFamily: 'togetherai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.together.ai/v1',
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
    notes:
      '2026-07-30: operator corrected the provisioned key to the canonical tgp_v1_* format (D1 2026-04-24 "key_" prefix was non-canonical, caused 401s). Live-verified POST /v1/chat/completions, real content + usage. baseUrl updated api.together.xyz → api.together.ai to match current docs (docs.together.ai/docs/quickstart + .../inference/openai-compatibility); .xyz still works identically, just no longer the documented-canonical domain. Docs also list TTS/STT via compat layer — unverified, gap.',
    lastReviewedAt: '2026-07-30',
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
      // LOTE AK (2026-09-04): the 2026-04-22 "no /models endpoint" verdict is
      // OBSOLETE. Route-existence probe (unauthenticated, discriminated against
      // a control path on the same host):
      //   GET /v1/models            → 401 invalid_api_key   (route EXISTS)
      //   GET /v1/zzz-control-probe → 404                   (route absent)
      //   GET /models               → 404                   (legacy path absent)
      // A 401 where an unknown path 404s proves the listing route is real and
      // merely auth-gated, so discovery is now the inventory of record and the
      // stale Sonar pinnedFallback (which still carried the retired
      // sonar-*-online SKUs) is gone.
      modelList: ['/v1/models'],
      chatCompletions: '/chat/completions',
    },
    supports: {
      chat: true,
      streaming: true,
    },
    capabilityHints: [
      { capability: 'web_search', rationale: 'provider-class-default', confidence: 0.85 },
      { capability: 'deep_research', rationale: 'docs-declared', confidence: 0.7 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.perplexity.ai/api-reference/chat-completions',
    notes:
      'All models are web-search-grounded. Response includes citations[], related_questions[], images[]. Dedicated adapter preserves those extension fields on PerplexityChatResponse. LOTE AK (2026-09-04): pinnedFallback dropped — route-existence probe proved GET /v1/models is real (401 vs 404 on a control path), so the Sonar inventory now comes from live discovery instead of a 2026-04 hand list that still named the retired sonar-{small,medium,large}-online SKUs.',
    lastReviewedAt: '2026-09-04',
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
    notes:
      'Wafer-scale inference; fastest Llama-70B in market. Dedicated adapter normalizes max_completion_tokens ↔ max_tokens per Cerebras docs.',
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
    notes:
      'D1 2026-04-24: key provisioned (<prefix>-hyperbolic-api-key, 73B "<redacted-key-prefix>…") and auth accepted; /v1/chat returns 402 {"detail":"Insufficient funds, please see https://docs.hyperbolic.xyz/docs/hyperbolic-pricing"}. Classified upstream-suspended (not credentials-missing) because the credential itself is valid — only the account balance is zero. Operator top-up unblocks live-validation.',
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
    notes:
      'EU data sovereignty; GDPR-compliant inference. Live-verified 2026-08-01 with the real key (<prefix>-nscale-key, ~1207B JWT bearer token): GET /v1/models 200 (23 models incl. Kimi-K2.5, gpt-oss-120b/20b, Qwen3 variants, Llama-4-Scout, FLUX.1-schnell) and POST /v1/chat/completions 200 real completion (Qwen/Qwen3-4B-Instruct-2507, vLLM backend). The catalog\'s credentials-missing classification was stale — the secret was already provisioned.',
    lastReviewedAt: '2026-08-01',
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
    notes:
      'Deprecated for new signups. Entry retained for existing enterprise deployments via ANYSCALE_BASE_URL override. D1 2026-04-24: key provisioned (<prefix>-anyscale-api-key, 236B "<redacted-key-prefix>…") but api.endpoints.anyscale.com returns HTML shutdown notice "Effective August 1, 2024 ... Multi-tenant access to LLM models has been removed." Permanent vendor-side shutdown; classified upstream-suspended. Unblock via private Hosted deployment with ANYSCALE_BASE_URL override.',
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
    notes:
      'Large long-tail HF-model marketplace. Dedicated thin adapter for per-provider observability (logs/metrics scope to `provider: featherless-ai`). No model identifiers hardcoded — the catalog/discovery service is sole source of truth; the adapter is identity-only over the hub.',
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
    notes:
      'RDU hardware; fast Llama-405B inference. Dedicated adapter only labels observability and exposes FAST_TIER_MODELS hint.',
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
    notes:
      'Smaller provider; smoke-test with real key before relying on routing. 2026-08-01: real key confirmed live — GET /v1/models 200 (10 models); auth genuinely checked (bogus key → 401). POST /v1/chat/completions → 402 "Insufficient credits, no active subscription" on 4 real model ids — zero balance, not credentials-missing. Blocked on billing at synthetic.new/billing.',
    lastReviewedAt: '2026-08-01',
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
    notes:
      'D1 2026-04-24: key provisioned (<prefix>-chutes-api-key) and auth accepted; /v1/chat returned 402 (account balance $0.0). Live-verified 2026-07-29 after operator top-up: GET /v1/models 200 (15 TEE models, this key is TEE-only by provisioning), POST /v1/chat/completions 200 for Qwen/Qwen3-32B-TEE and unsloth/Mistral-Nemo-Instruct-2407-TEE — zero 402s. No integration changes needed.',
    lastReviewedAt: '2026-07-29',
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
    // LOTE AS (2026-09-06): live-fetched https://docs.z.ai/api-reference/
    // video/generate-video today. CogVideoX-3 `size` enum drives resolution
    // AND aspect ratio (no separate ratio field); `duration` is a closed
    // 5|10 enum, not a continuous range.
    videoCapabilityAttributes: {
      maxDurationSeconds: 10,
      allowedDurationsSeconds: [5, 10],
      maxResolution: '4K', // docs: "Maximum support for 4K resolution"
      supportedAspectRatios: [
        '1280x720',
        '720x1280',
        '1024x1024',
        '1920x1080',
        '1080x1920',
        '2048x1080',
        '3840x2160',
      ],
      // `with_audio` — "Whether to generate AI sound effects". Real vendor
      // capability (declared here for selection-time exclusion accuracy),
      // but NOT YET wired end-to-end in this codebase — LOTE AS Part 1 only
      // plumbs `generateAudio` through to BytePlus's `generate_audio` and
      // Google Veo's own `parameters.generateAudio`. A request against zai
      // with generateAudio:true will not be EXCLUDED here, but will also not
      // currently receive `with_audio` in the real request body (the generic
      // OpenAICompatibleHubAdapter has no such passthrough). Wiring this is
      // a real follow-up, not a regression introduced here: before this
      // change, no soundtrack option existed for ANY provider.
      nativeAudioSupport: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.z.ai/devpack/quick-start',
    notes:
      'GLM-4 family; strong Chinese + multilingual. Video via CogVideoX. Live-verified 2026-08-01 with the real key (<prefix>-zai-key, 49B): POST /chat/completions against open.bigmodel.cn returns HTTP 200 real completions for glm-4.5, glm-4.5-flash, and glm-4-plus. Deprecated ids glm-4/glm-4-flash/glm-4-air/glm-3-turbo now return HTTP 400 error code 1211 "model not found" — a stale-model-id issue on this account, not an auth/domain problem (bigmodel.cn baseUrl is correct as-is).',
    lastReviewedAt: '2026-08-01',
  },
  {
    providerId: 'xiaomi-mimo',
    displayName: 'Xiaomi MiMo',
    providerFamily: 'xiaomi-mimo',
    aliases: ['xiaomi', 'mimo'],
    integrationClass: 'oai-compat-pure',
    // 2026-08-01: WRONG-DOMAIN FIX. platform.xiaomimimo.com is the
    // console/marketing SPA, not the API — GET /v1/models there returns
    // HTTP 200 but Content-Type text/html (the React app shell), and
    // POST /v1/chat/completions returns a raw nginx/openresty 403 that is
    // IDENTICAL for a valid key and a garbage key (auth never evaluated on
    // this host). The correct API host, confirmed against Xiaomi's
    // own docs (mimo.mi.com/docs/en-US/api/chat/openai-api,
    // mimo.mi.com/docs/en-US/quick-start/summary/first-api-call), is
    // api.xiaomimimo.com — a genuine, working /v1/models discovery
    // endpoint that returns real JSON with the SAME key. Switched back to
    // discovery+execution now that a live /v1/models surface exists; the
    // old execution-only + pinnedFallback (3 stale/invented model ids that
    // don't even exist on this host) is no longer needed.
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'XIAOMI_MIMO_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    capabilityHints: [
      { capability: 'multilingual_chinese', rationale: 'provider-class-default', confidence: 0.85 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call',
    notes:
      'Live-verified 2026-08-01: real key confirmed. GET api.xiaomimimo.com/v1/models 200 (6 models). POST /v1/chat/completions → 402 "Insufficient account balance"; bogus key on the same host → 401, proving auth works and the only blocker is zero balance (the old platform.xiaomimimo.com host never evaluated auth at all). Uses dedicated XiaomiMimoAdapter for identity/circuit-breaker scoping.',
    adapterClass: 'XiaomiMimoAdapter',
    lastReviewedAt: '2026-08-01',
  },
  {
    providerId: 'v0',
    displayName: 'v0 (Vercel)',
    providerFamily: 'v0',
    integrationClass: 'first-party-native',
    // 2026-08-02: WRONG-SHAPE FIX. The previous oai-compat-pure assumption
    // targeted a /v1/chat/completions surface that doesn't exist on v0's
    // app router (404 identical for valid key/garbage key/no auth header —
    // never even reached an auth gate). v0's real Platform API is a
    // stateful chat resource (POST /v1/chats, {"message": "..."}) — see
    // V0Adapter (api/src/providers/v0/v0-adapter.ts) for the full wire
    // contract. Still no /v1/models endpoint (Projects/Chats/Deployments
    // only per the official overview), so pinnedFallback stays required;
    // its 5 ids are now the real modelConfiguration.modelId enum instead
    // of the prior stale/invented v0-1.5-md/v0-1.5-sm/v0-1.0-md.
    //
    // 2026-09-09: TOOL-CALLING CAPABILITY-MISMATCH FIX. `supports.tools`
    // and the `tool_use` pinnedFallback tags were WRONG — verified against
    // the documented POST /chats request schema
    // (https://v0.app/docs/api/platform/reference/chats/create): there is
    // no `tools`/`tool_choice`/`functions` field at all. The two fields
    // that look adjacent are NOT a caller-supplied-JSON-schema substitute:
    //   - `attachedSkillIds`/`skills` reference pre-registered skills.sh /
    //     memory / project skills (max 3) — domain-knowledge attachments,
    //     not arbitrary function definitions.
    //   - `mcpServerIds` references MCP servers pre-registered out-of-band
    //     (Create MCP Server API / dashboard) that v0 may consult
    //     autonomously server-side during generation; there is no per-
    //     request inline tool schema, and no `tool_calls` surfaced back to
    //     the caller to execute — the opposite shape of this codebase's
    //     `ChatRequest.tools`/`tool_choice` contract, which
    //     `V0Adapter.chatCompletion`/`buildV0Message` never read anyway.
    // Removed `tools: true` and every `tool_use` tag below accordingly so
    // the router stops treating v0 as function-calling-capable.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.v0.dev/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'V0_API_KEY',
    adapterClass: 'V0Adapter',
    supports: {
      chat: true,
      streaming: true,
    },
    pinnedFallback: {
      reason: 'no-list-endpoint',
      // Real modelConfiguration.modelId enum (create-chat + send-message
      // reference pages) — explicit capabilities so the CI invariant
      // `pinnedFallback-capability-coverage` passes. No `tool_use`: v0's
      // Platform API has no tools/tool_choice/functions field (see the
      // 2026-09-09 note above) — none of these models can honor
      // caller-supplied function-calling.
      models: [
        { id: 'v0-auto', capabilities: ['chat', 'streaming', 'code_generation'] },
        { id: 'v0-mini', capabilities: ['chat', 'streaming', 'code_generation'] },
        { id: 'v0-pro', capabilities: ['chat', 'streaming', 'code_generation'] },
        { id: 'v0-max', capabilities: ['chat', 'streaming', 'code_generation'] },
        { id: 'v0-max-fast', capabilities: ['chat', 'streaming', 'code_generation'] },
      ],
      lastReviewedAt: '2026-09-09',
    },
    capabilityHints: [
      {
        capability: 'frontend_code_generation',
        rationale: 'provider-class-default',
        confidence: 0.8,
      },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://v0.app/docs/api/platform/overview',
    notes:
      'Frontend/UI code generation via v0\'s stateful chat API, not OAI chat/completions. 2026-08-02: dedicated V0Adapter built (POST /chats, latestVersion.files[] + messages[]); real key live-tested end-to-end; pinnedFallback ids corrected to the real modelConfiguration.modelId enum. 2026-09-09: removed false tool_use/supports.tools claim — POST /chats has no tools/tool_choice field; attachedSkillIds/mcpServerIds are pre-registered refs, not caller function-calling.',
    lastReviewedAt: '2026-09-09',
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
    notes:
      'Gateway routing to OpenAI/Anthropic/xAI/etc. Models namespaced `provider/model`; adapter attributes the real owner via parseModelId(). Image/reasoning/rerank/moderation surface; video is AI-SDK-only, no published REST. 2026-08-01: real key confirmed — GET /v1/models 200 (312 models). POST /v1/chat/completions → 402 insufficient_funds (account-wide; BYOK does not bypass per Vercel\'s own error text) — needs operator top-up, not a credential/code fix.',
    lastReviewedAt: '2026-08-01',
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
    notes:
      'OAI-compatible chat surface. Dedicated adapter injects the required `wandb-project` header from $WANDB_PROJECT at request time (env hot-swap safe).',
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
      { capability: 'rerank', rationale: 'endpoint-declared', confidence: 0.9 },
      { capability: 'long_context_embedding', rationale: 'docs-declared', confidence: 0.8 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 60,
    docsUrl: 'https://docs.voyageai.com/docs/introduction',
    notes:
      'Top-tier embeddings + rerank. voyage-3, voyage-code-3, voyage-rerank-2. Voyage does NOT expose GET /v1/models (confirmed 404 via live probe 2026-04-22); discovery is skipped, model IDs are resolved from the catalog/DB. Dedicated adapter implements /v1/embeddings + /v1/rerank and explicitly rejects chat calls.',
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
    notes:
      'ByteDance/Volcano ARK — Doubao models. Strong Chinese coverage. ARK does NOT expose a bulk /models route — dedicated adapter returns empty getModels() and validates the ep-<timestamp>-<random> endpoint-id format.',
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
    notes:
      'IAM token exchange against iam.cloud.ibm.com/identity/token. Requires WATSONX_APIKEY + WATSONX_PROJECT_ID; version pinned 2024-05-31. 2026-08-01 review (no live call): APIKEY is real, but PROJECT_ID/URL are not provisioned. PROJECT_ID is a hard blocker (adapter throws before any request); URL soft-defaults to us-south. healthCheck() only probes the IAM exchange, so it can read healthy while chat/embeddings throw.',
    adapterClass: 'WatsonxAdapter',
    lastReviewedAt: '2026-08-01',
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
    notes:
      'JWT key-pair auth via SnowflakeCortexAdapter. Requires SNOWFLAKE_PAT + SNOWFLAKE_USER + SNOWFLAKE_ACCOUNT set together (account-scoped baseUrl). Adapter wired 2026-06-15.',
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
    notes:
      'OAuth2 client_credentials via SapAiCoreAdapter. Requires SAP_AI_CORE_CLIENT_ID + SAP_AI_CORE_CLIENT_SECRET + SAP_AI_CORE_AUTH_URL set together (+ optional resource group). Adapter wired 2026-06-15.',
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
    notes:
      'Vector + raster image gen with style controls. Dedicated adapter validates model × style pairs before the wire. Live-verified 2026-08-01: real key confirmed — POST /images/generations 200 with a real image_id + url; fetched url confirmed a genuine ~3.1MB png. Catalog\'s credentials-missing tag was stale.',
    lastReviewedAt: '2026-08-01',
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
      { capability: 'image_to_video', rationale: 'docs-declared', confidence: 0.9 },
    ],
    // LOTE AS (2026-09-06): live-browsed https://docs.dev.runwayml.com/api
    // today (full current API reference). Generation-time output tops out at
    // 1584x672 (~1.06MP, under 1080p) — 4K exists ONLY on the separate
    // /v1/video_upscale post-processing endpoint, not generation.
    // `ratio` accepts the union of image_to_video + text_to_video enums
    // (pixel-dimension strings verbatim, not derived '16:9' labels).
    videoCapabilityAttributes: {
      maxDurationSeconds: 10,
      minDurationSeconds: 2,
      maxResolution: '1584x672',
      supportedAspectRatios: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'],
      // Audio is a completely separate endpoint (/v1/sound_effect,
      // /v1/text_to_speech), never returned attached to the generated video.
      nativeAudioSupport: false,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.dev.runwayml.com/',
    notes:
      'Video-from-image + act-one motion transfer. Requires X-Runway-Version header (already sent by RunwayMLAdapter). Async-job API: POST /v1/image_to_video → poll GET /v1/tasks/{id}. Live-verified 2026-08-01: real key confirmed — GET /v1/organization 200, creditBalance 0; baseUrl confirmed correct (api.dev.runwayml.com is the real prod host, not a sandbox leftover). POST /v1/text_to_video → 400 no credits. Blocked purely on billing.',
    lastReviewedAt: '2026-08-01',
  },
  {
    // LOTE AU (2026-09-08) — genuinely new integration, NOT the same vendor
    // as `runwayml` above: aivideoapi.com is a third-party aggregator that
    // wraps RunwayML's models behind its own bespoke REST shape and its own
    // separate credential (`AIVIDEOAPI_API_KEY`); it does not call Runway's
    // own api.dev.runwayml.com host at all.
    providerId: 'aivideoapi',
    displayName: 'AI Video API (Runway)',
    providerFamily: 'aivideoapi',
    integrationClass: 'video-only',
    integrationMode: 'execution-only',
    baseUrl: 'https://api.aivideoapi.com',
    authScheme: 'api-key-header',
    // Raw key, no "Bearer " prefix — OpenAPI declares `type: apiKey` on the
    // `Authorization` header for every operation (not `type: http, scheme:
    // bearer`). See AivideoapiAdapter's class doc for the full citation.
    authHeaderName: 'Authorization',
    apiKeyEnvVar: 'AIVIDEOAPI_API_KEY',
    adapterClass: 'AivideoapiAdapter',
    paths: {
      // Documentation purposes only — AivideoapiAdapter is a dedicated
      // adapter (like RunwayML/BFL/Topaz above) and owns its own routing
      // across all 5 submit endpoints + the shared /status poll internally;
      // it does not consult `paths` at runtime. text-to-video is listed here
      // as the representative "primary" generation route.
      videoGenerate: '/runway/generate/text',
      // No `videoPoll` here: the schema's poll-path template regex forbids
      // `?`/`=` (it's designed for path-segment polling like RunwayML's own
      // `/v1/tasks/{taskId}`), but aivideoapi's real poll route is a QUERY
      // PARAM — `GET /status?uuid={taskId}` — built entirely inside
      // AivideoapiAdapter (which doesn't consult `paths` at runtime anyway;
      // see the `notes` field below for the real mechanics).
    },
    // No /models route is documented, and `pinnedFallback` is a closed,
    // shrink-only legacy allowlist as of the zero-hardcoded-model-inventory
    // guard (`zero-hardcoded-model-inventory.test.ts`) — new rows may not
    // add to it. `discoveryStatus: 'unavailable-upstream'` is the sanctioned
    // path for a genuinely new execution-only row with no machine-readable
    // listing: the catalog/discovery layer honestly advertises ZERO models
    // for aivideoapi, while `AivideoapiAdapter.isKnownModel()` still
    // validates the documented `model` field values (gen2/gen3/gen4) at
    // call time for any caller that names one directly.
    discoveryStatus: 'unavailable-upstream',
    supports: {
      videoGeneration: true,
    },
    capabilityHints: [
      { capability: 'text_to_video', rationale: 'docs-declared', confidence: 0.9 },
      { capability: 'image_to_video', rationale: 'docs-declared', confidence: 0.9 },
      { capability: 'video_to_video', rationale: 'docs-declared', confidence: 0.85 },
    ],
    // Docs (2026-09-08, all 11 reference pages fetched — see AivideoapiAdapter
    // class doc): generate/text and generate/video both document `time`/
    // implicit duration of 5 or 10 seconds for gen3; extend adds "4 seconds
    // for Gen2, 5 seconds for Gen3" on top of an already-generated clip
    // (not captured here — that's a delta on a follow-up call, not a
    // ceiling on a single generation).
    videoCapabilityAttributes: {
      maxDurationSeconds: 10,
      minDurationSeconds: 5,
      allowedDurationsSeconds: [5, 10],
      nativeAudioSupport: false,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://aivideoapi.readme.io/reference/runwaygeneratetext',
    notes:
      'Third-party aggregator wrapping RunwayML Gen2/3/4 (NOT Runway\'s own API — separate host/credential from `runwayml`). 5 submit routes (text/image/imageDescription/video/extend) share one poll endpoint (GET /status?uuid=). aivideoapi\'s own OpenAPI spec ships an empty response schema on every endpoint — AivideoapiAdapter uses multi-candidate field extraction, not a guessed shape. Contract-verified 2026-09-08 via live doc fetch; not yet live-probed (see PR).',
    lastReviewedAt: '2026-09-08',
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
      // (upscale, denoise, sharpen, recovery).
      //
      // CORRECTED 2026-09-05 (LOTE AP). These ids used to read 'standard' and
      // 'high-fidelity', which are NOT values the API accepts — they never
      // matched `TopazAdapter.ENHANCE_MODELS`, and since Topaz has no /models
      // endpoint this pinned list IS the inventory of record. The moment
      // anything actually routed an enhancement request here, `imageEdit`
      // rejected the selected model with `topaz: unknown model standard`. The
      // mismatch was invisible for as long as no executor existed; wiring
      // `image_upscale`/`image_denoise` made it load-bearing. Ids below are the
      // documented `model` form values (see topaz-adapter.ts header).
      //
      // `image_editing` is retained per pipeline because that is the adapter
      // method these run through, NOT because Topaz honours a prompt — it does
      // not. See the gap register (GAP-AP-2).
      models: [
        {
          id: 'standard_v2',
          capabilities: ['image_upscale', 'image_denoise', 'image_editing'],
        },
        {
          id: 'high_fidelity_v2',
          capabilities: ['image_upscale', 'image_denoise', 'image_editing'],
        },
        { id: 'art_and_cg', capabilities: ['image_upscale', 'image_editing'] },
        { id: 'low_resolution', capabilities: ['image_upscale', 'image_editing'] },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-09-05',
    },
    supports: {
      imageEditing: true,
    },
    capabilityHints: [
      { capability: 'image_upscale', rationale: 'docs-declared', confidence: 0.9 },
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
    providerId: 'cartesia',
    displayName: 'Cartesia',
    providerFamily: 'cartesia',
    integrationClass: 'speech-only',
    // 2026-09-12: NEW catalog row — cartesia previously ran only through
    // the legacy `provider-registry.ts` switch case + a hardcoded
    // `cartesia-audio` discovery source in
    // central-model-discovery-service.ts. That discovery source was
    // ALREADY audited once (2026-09-10, PR #564): its original `GET
    // /models` call 404s live in production (Cartesia has never exposed
    // that route), and the fix at the time switched it to `GET /voices`.
    // That fix was itself wrong in a subtler way — `/voices` lists VOICE
    // personas (UUID + display name, e.g. "Skylar - Friendly Guide"), a
    // different resource type from a TTS MODEL (`sonic-3`, `sonic-3.5`,
    // ...); treating voices as models fabricated bogus "model" rows.
    // Re-verified 2026-09-12 against Cartesia's own docs
    // (https://docs.cartesia.ai/api-reference/tts/bytes — the `POST
    // /tts/bytes` reference page, which is where `model_id` is
    // documented as a request PARAMETER, not a listable resource — plus
    // https://docs.cartesia.ai/build-with-cartesia/tts-models/latest and
    // .../tts-models/api-changes for the model roster) and against the
    // official `cartesia-js` SDK's current `main` branch (GitHub API
    // file-tree check, 2026-09-12): there is no `models` resource file —
    // only `access-token`, `agents`, `datasets`, `fine-tunes`,
    // `pronunciation-dicts`, `stt`, `tts`, `voice-changer`, `voices`. No
    // model-listing endpoint exists at all, on either surface. Migrated
    // to `execution-only` + `pinnedFallback` (topaz/v0 pattern) instead
    // of attempting a second wrong-shape discovery fix; the old switch
    // case and hardcoded discovery source were removed in the same
    // change (see provider-registry.ts and
    // central-model-discovery-service.ts).
    //
    // Auth note: Cartesia's own API reference documents
    // `Authorization: Bearer $CARTESIA_API_KEY` (+ a `Cartesia-Version`
    // date header) for `POST /tts/bytes`, matching what the discovery
    // audit above already found for `/voices`. `CartesiaAdapter`'s own
    // `authHeaders()` (execution path: `textToSpeech`/`healthCheck`)
    // still sends `X-API-Key` — a separate, pre-existing execution-path
    // bug, out of scope for this discovery-only change and NOT fixed
    // here; flagged separately. `authScheme` below records the real
    // vendor contract regardless, since execution-only + pinnedFallback
    // means this catalog row never issues its own HTTP call.
    integrationMode: 'execution-only',
    baseUrl: 'https://api.cartesia.ai',
    authScheme: 'bearer',
    apiKeyEnvVar: 'CARTESIA_API_KEY',
    adapterClass: 'CartesiaAdapter',
    pinnedFallback: {
      // Real, currently-"Stable" TTS model families per Cartesia's own
      // lifecycle docs (docs.cartesia.ai/build-with-cartesia/tts-models/
      // api-changes, fetched 2026-09-12). Deliberately EXCLUDES:
      //   - bare `sonic` — sunsetted June 1, 2026, now returns
      //     `model_sunsetted` on every call.
      //   - `sonic-2` / `sonic-turbo` — documented sunset October 20,
      //     2026 (about 5 weeks out from this review date); not pinned
      //     as default inventory this close to retirement.
      //   - `sonic-preview` — vendor docs say "not intended for
      //     production use... subject to change without notice".
      //   - the `sonic-latest` / `sonic-3-latest` aliases — the same
      //     lifecycle page flags them as deprecated aliases.
      models: [
        { id: 'sonic-3', capabilities: ['text_to_speech', 'streaming'] },
        { id: 'sonic-3.5', capabilities: ['text_to_speech', 'streaming'] },
        { id: 'sonic-3.6', capabilities: ['text_to_speech', 'streaming'] },
      ],
      reason: 'no-list-endpoint',
      lastReviewedAt: '2026-09-12',
    },
    supports: {
      textToSpeech: true,
      streaming: true,
    },
    capabilityHints: [
      { capability: 'text_to_speech', rationale: 'docs-declared', confidence: 0.9 },
    ],
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 20,
    docsUrl: 'https://docs.cartesia.ai/api-reference/tts/bytes',
    notes:
      'TTS-only, WebSocket + REST (POST /tts/bytes). No /models endpoint on either surface (REST docs or cartesia-js SDK) — verified 2026-09-12. Wired via CartesiaAdapter factory; execution-only + pinnedFallback (no-list-endpoint), same pattern as topaz/v0.',
    lastReviewedAt: '2026-09-12',
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
    notes:
      'FLUX family. Uses x-key header (not Bearer). Async-job protocol — submit → poll → download. Live-verified 2026-08-01: real key confirmed, baseUrl/authScheme correct. POST /v1/flux-pro-1.1 and /v1/flux-dev both → 402 "Insufficient credits" (401/422 controls confirm auth genuinely works). Blocked purely on account funding, not credentials-missing.',
    adapterClass: 'BflAdapter',
    lastReviewedAt: '2026-08-01',
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
    // Live-probed 2026-04-22 via GCP secret `<prefix>-302-key`: upstream returned
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
      //
      // `function_calling`/`tool_use`/`json_mode` correction (2026-09-09):
      // ReplicateAdapter#chatCompletion / #chatCompletionStream build every
      // prediction's `input` from ONLY {prompt, max_tokens, temperature,
      // top_p} via messagesToPrompt() — there is no code path that forwards
      // ChatRequest.tools / tool_choice into any Replicate prediction, for
      // any model. Unlike OpenAI-compatible providers, Replicate has no
      // universal request schema: each hosted model's Cog wrapper defines
      // its own `openapi_schema.input`, so "does this model support tools"
      // has to be verified per model against the live schema, not assumed.
      // Live-fetched schemas (`GET https://replicate.com/{owner}/{name}/api/schema`,
      // 2026-09-09) confirm none of the three previously-flagged entries
      // expose a tools/functions field:
      //   - anthropic/claude-3.5-sonnet: the model page now 404s (Replicate
      //     has removed it; claude-3.7-sonnet also 404s). The still-live
      //     anthropic/claude-4-sonnet wrapper — same Cog-wrapper family/
      //     publisher — exposes only {image, prompt, max_tokens,
      //     system_prompt, extended_thinking, max_image_resolution,
      //     thinking_budget_tokens}. No `tools`/`tool_choice` field exists
      //     anywhere in the Anthropic-on-Replicate wrapper lineage.
      //   - meta/meta-llama-3-70b-instruct: input schema is exactly
      //     {prompt, max_tokens, min_tokens, temperature, top_p, top_k,
      //     prompt_template, presence_penalty, frequency_penalty}. No tools.
      //   - openai/gpt-4o-mini: input schema is exactly {prompt, messages,
      //     image_input, system_prompt, temperature, top_p,
      //     max_completion_tokens, presence_penalty, frequency_penalty}. No
      //     `tools`/`tool_choice` field (and no `response_format` either,
      //     so `json_mode` was equally unearned — removed alongside it).
      // `vision`/`multimodal` stay on gpt-4o-mini and the Anthropic entry:
      // `image_input` / `image` are real fields in the respective schemas.
      // See replicate-adapter.test.ts "tool-calling capability gap" block
      // and pinned-fallback-capability-coverage.test.ts for the regression
      // guards tied to this correction.
      //
      // Dead-pin follow-up (2026-09-09, same-day re-check): the
      // `anthropic/claude-3.5-sonnet` and `mistralai/mistral-7b-instruct-v0.2`
      // ids referenced above are no longer just capability-mismatched — the
      // model pages themselves 404 (`curl -sL -o /dev/null -w '%{http_code}'
      // https://replicate.com/<owner>/<name>` = 404 for both, reconfirmed
      // live). Any router picking either id would fail at request time with
      // a 404, independent of capability matching. Fixed here:
      //   - anthropic/claude-3.5-sonnet → anthropic/claude-4-sonnet (still
      //     HTTP 200; anthropic/claude-4.5-sonnet is also live but its
      //     schema drops `extended_thinking`/`thinking_budget_tokens`, so
      //     claude-4-sonnet is the closer match to the capability set this
      //     row already declared). Capabilities are unchanged — the schema
      //     quoted above (no tools field; `image` field; `extended_thinking`
      //     + `thinking_budget_tokens` fields) was fetched FROM
      //     claude-4-sonnet directly, so `chat, streaming, vision,
      //     multimodal, reasoning` still hold verbatim.
      //   - mistralai/mistral-7b-instruct-v0.2 → removed, no replacement.
      //     mistralai/mistral-7b-instruct-v0.1 also 404s on
      //     `/api/schema` and its `/versions` page states "No versions have
      //     been pushed to this model yet" — the model's base page 200s
      //     (the owner/name namespace exists) but there is no runnable
      //     version behind it, so it is not an adequate substitute either.
      //     No other live `mistralai/mistral-7b-instruct-*` slug was found.
      models: [
        {
          id: 'anthropic/claude-4-sonnet',
          capabilities: ['chat', 'streaming', 'vision', 'multimodal', 'reasoning'],
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
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'meta/meta-llama-3-8b-instruct',
          capabilities: ['chat', 'streaming'],
        },
        {
          id: 'openai/gpt-4o-mini',
          capabilities: ['chat', 'streaming', 'vision', 'multimodal'],
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
      lastReviewedAt: '2026-09-09',
    },
    docsUrl: 'https://replicate.com/docs',
    notes:
      'Predictions API (async-by-default, sync via Prefer: wait). Models are invoked as owner/name or owner/name:version. Adapter handles SSE streams for LLM models and downloads output URLs for image/audio models.',
    adapterClass: 'ReplicateAdapter',
    lastReviewedAt: '2026-09-09',
  },
  {
    // Bytez — multi-modality hub with a quirky OAI-compat surface.
    // apiKeyEnvVar wired to GCP secret <prefix>-bytez-key (2026-04-22).
    //
    // URL LAYOUT (documented, confirmed by docs.bytez.com/http-reference):
    //   Chat  (OAI-compat): POST https://api.bytez.com/models/v2/openai/v1/chat/completions
    //   Models list (native shape, NOT OAI):
    //                         GET  https://api.bytez.com/models/v2/list/models?task=chat
    //     Response: { error, output: [{ modelId, task, meter, meterPrice, params, ramRequired }] }
    //   Auth header format: `Authorization: <token>` — bare token, NO
    //     `Bearer ` prefix (docs.bytez.com/http-reference/list/models.md
    //     confirms this for the native list endpoint specifically). The OAI
    //     chat/embeddings path keeps `Bearer <token>` per the OAI-compat
    //     convention. CONFIRMED as the root cause of the 2026-09 production
    //     0-models incident (see 2026-09-09 note below) — the native
    //     fetcher was sending `Bearer <token>` here too, which this
    //     specific endpoint does not accept.
    //
    //   2026-09-10 PRODUCTION 500 INVESTIGATION: live probes against the
    //   native list endpoint (real key, GCP secret <prefix>-bytez-key) got the
    //   same 500 `{"error":"Expected parameter(s): modelId","output":[]}` —
    //   or, on other attempts, a clean 200 with `output: []` — with EITHER
    //   `Bearer <key>` or the bare-token header format; the sibling
    //   `/models/v2/list/tasks` endpoint 200s with the same key in both
    //   formats (key is valid, auth isn't what's failing), and no-auth
    //   correctly 401s. Passing any non-empty `?modelId=` makes the 500 go
    //   away but the response is then always `output: []` regardless of
    //   modelId/task. Bytez's own current OpenAPI spec for this endpoint
    //   (github.com/Bytez-com/docs, docs/http-reference/openapi.yaml,
    //   operationId getModels) documents only an optional `task` param, no
    //   `modelId`, and only 401/429 as error responses — not 500. This is a
    //   vendor-side bug in the live endpoint that contradicts Bytez's own
    //   published spec, NOT an auth-header-format issue on our side; see the
    //   class-level doc comment in bytez-native-model-fetcher.ts for the
    //   full probe log. The auth-header-format fix is still correct per spec
    //   and worth keeping, but does not by itself restore discovery.
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
    notes:
      'Multi-modality hub. OAI-compat chat/embeddings at /models/v2/openai/v1/... (quirk, not /v1/...). Native discovery via BytezNativeModelFetcher (GET /models/v2/list/models, non-OAI shape). 2026-09-10: prod 500s are a vendor-side bug on that endpoint (undocumented modelId requirement, empty output regardless of auth header format) per Bytez\'s own OpenAPI spec, NOT the auth-header issue fixed by PR #544. Full root-cause + live-probe evidence in the fetcher class doc comment.',
    adapterClass: 'BytezAdapter',
    fetcherClass: 'BytezNativeModelFetcher',
    lastReviewedAt: '2026-09-10',
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
    notes:
      'OAI-compat chat router + TTS/STT/voice-clone. Basic auth (key already base64-encoded in GCP). Discovery endpoints both return 404 (router/v1/models and /v1/models) — catalog supplies model IDs. Orphan-closure entry: the InworldAdapter class existed but was never wired until 2026-04-22.',
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
      CLOUDFLARE_ACCOUNT_ID:
        'Cloudflare account ID — substituted into the Workers AI baseUrl path segment at adapter construction time. Required.',
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
    notes:
      "OAI-compatible surface at account-scoped URL. Model ids use @cf/vendor/name convention (e.g. @cf/meta/llama-3-8b-instruct). Workers AI has dedicated per-account neuron rate limits that do NOT share with the account's overall CF API quota — diagnose 429s via cf-ray + x-ratelimit-* response headers.",
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
    notes:
      'Router that dispatches to TogetherAI/Fireworks/Replicate/etc. using a single HF_TOKEN. Single-tenant billing across heterogeneous backends. Uses dedicated adapter to inject `x-use-cache: false` for benchmark runs (hub default is a cache hit which ruins timing measurement).',
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
      "Drop-in OpenAI-compat shim at /v1beta/openai. Same API key as the native `google` adapter (GEMINI_API_KEY). Use this for uniform wire-protocol routing via LiteLLM/OpenRouter-style aggregators; use the native GoogleAdapter for vision/video/grounded-search features that the OAI shim doesn't expose.",
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
    // Model catalog lives at /catalog/models on the top-level API host, NOT
    // nested under this baseUrl's /inference path — and paths.modelList only
    // accepts relative paths (ProviderEndpointPathsSchema's pathString regex
    // requires a leading "/"), so it can't express a different host either.
    // Discovery is wired as a dedicated hardcoded source (github-models-native
    // in central-model-discovery-service.ts) instead of the generic
    // catalog-bridge path.
    notes:
      'GitHub PAT-auth aggregator (OpenAI/Meta/Mistral/Cohere). Free tier: 50 req/day rate limit on cheap models (429s = caller quota). Model ids: `{publisher}/{name}`. 2026-09-09: 0 live rows despite a real GITHUB_TOKEN secret (<prefix>-github-models-token, since 2026-04-24) -- NOT credential/wiring. Unauth GET models.github.ai/catalog/models -> HTTP 410 github_models_retirement_brownout: GitHub is retiring the product. External/vendor-side; re-probe before assuming a code regression.',
    adapterClass: 'GitHubModelsAdapter',
    lastReviewedAt: '2026-09-09',
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
    integrationMode: 'discovery+execution',
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
    // GAP-AK-6 (2026-09-05): pinnedFallback REMOVED in favour of real
    // workspace enumeration. The pinned list was a snapshot of the canonical
    // Databricks Foundation Model APIs, but a serving endpoint is workspace-
    // PRIVATE: an admin can name endpoints arbitrarily and can provision
    // none of the pinned ones, so the list was simultaneously over-claiming
    // (endpoints this workspace does not have) and under-claiming (custom
    // endpoints it does). The `databricks-workspace` discovery source in
    // central-model-discovery-service.ts now enumerates
    // GET /api/2.0/serving-endpoints with the DATABRICKS_TOKEN already wired
    // here, and reports zero when the workspace is unreachable rather than a
    // fictional inventory. NOT live-validated — no workspace credential.
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
    notes:
      'Self-hosted OpenAI-compatible server. Set VLLM_BASE_URL to enable. Uses dedicated VllmAdapter for apiKeyOptional handling + named identity.',
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
    notes:
      'Local OAI-compatible server bundled with LM Studio desktop. No auth by default. Uses LmStudioAdapter for apiKeyOptional + named identity.',
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
    notes:
      'Self-hosted multi-modality runtime. XinferenceAdapter exposes a Cohere-compatible /v1/rerank method on top of the hub OAI surface.',
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
    docsUrl:
      'https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/protocol/extension_generate.html',
    notes:
      'Triton KServe v2 HTTP protocol — POST /v2/models/{model}/infer with INPUT/OUTPUT tensor arrays. Adapter converts OAI embedding request into Triton tensor shape and flattens response tensor back to float32[].',
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
  MOONSHOT_ENTRY,
  MINIMAX_ENTRY,
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
    notes:
      'Multi-upstream aggregator (OpenAI, Anthropic, Google, etc.). Was switch case; migrated 2026-04-21. Probe 2026-07-17: video route discovered at POST /videos (see paths).',
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
    // Was 'remote' — corrected 2026-09. Live probe of the real /models
    // response (937 entries) never returns a price field under any name
    // (checked every raw key plus a full-payload substring search for
    // "price"/"cost" — zero hits outside free-text descriptions). AIML's
    // AimlModelFetcher already hardcodes pricing to {0, 0} for this exact
    // reason; 'remote' falsely implied the vendor's own API supplies pricing
    // the way OpenRouter's does. See aiml-model-fetcher.ts's file header.
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 25,
    docsUrl: 'https://docs.aimlapi.com/',
    notes:
      'Multi-modal aggregator. modelsBaseUrl quirk in legacy config: /models served from bare host. Migrated 2026-04-21. Pricing audit 2026-09: /models never returns pricing (verified live); AimlModelFetcher.info field names corrected from context_length/max_tokens to the real contextLength/outputMax, which had pinned every model to the generic 8192/4096 defaults.',
    lastReviewedAt: '2026-09-09',
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
    notes:
      'Image/video generation router. Quirks: paths differ from standard /v1/images/*. Was switch case; migrated 2026-04-21.',
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
    notes:
      'Unified gateway proxying many upstreams. Was switch case; migrated 2026-04-21. D1 2026-04-24: live-validated — new <prefix>-heliconeai-api-key (<redacted-key-prefix>… 43B Virtual Key) replaces legacy <prefix>-heliconeai-key (11B "PLACEHOLDER"). Gateway routed gpt-4o-mini /chat 200 (1003B completion). Helicone injects its observability shim and forwards to the target vendor (OpenAI here); works with any target-model/Helicone-Target-Url configuration.',
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
    notes:
      'Multi-model aggregator. Was switch case; migrated 2026-04-21. Probe 2026-07-17: video route discovered at POST /videos (see paths).',
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
    notes:
      'Local Ollama server. Set OLLAMA_URL (e.g. http://localhost:11434/v1) to enable. Dedicated OllamaAdapter gives named identity for logs/metrics and a subclass seat for future native /api/* endpoints (tags, pull, generate).',
    adapterClass: 'OllamaAdapter',
    lastReviewedAt: '2026-04-22',
  },
  {
    providerId: 'local-llama',
    displayName: 'Local LLM (dedicated Ollama host)',
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
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    notes:
      "LOCAL_LLAMA_URL points at a dedicated external CPU host (<ollama-host>) — despite the 'llama.cpp' name this slot originally documented, the running server is native Ollama (systemd ollama.service, v0.31.1), confirmed live 2026-07-31 from the production API host (not the probe environment, which can't reach it — firewalled to the production IP by design): GET /v1/models 200 (qwen2.5:7b/3b/1.5b); POST /v1/chat/completions (qwen2.5:1.5b) 200, real content.",
    lastReviewedAt: '2026-07-31',
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
    // LOTE AK (2026-09-04): promoted execution-only → discovery+execution.
    // The 2026-04-23 premise ("the default hub discovery parser skips the
    // `{models: [...]}` body") is FALSE against the current parser:
    // `OpenAICompatibleHubModelFetcher.extractRawModels` probes
    // `data | models | results | items | entries`, so Writer's own
    // `{models: [{id, name}]}` shape is consumed natively — see the contract
    // test `hub-fetcher-model-list-shapes.test.ts`. Route existence
    // re-confirmed 2026-09-04 by a discriminated unauthenticated probe:
    //   GET /v1/models            → 401 fail.auth        (route EXISTS)
    //   GET /v1/zzz-control-probe → 404 fail.resource    (route absent)
    // Post-closure probe (2026-04-23) against /v1/chat/completions using
    // palmyra-x-004 returned HTTP 200 "PONG" — execution path verified.
    integrationMode: 'discovery+execution',
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
    // LOTE AK (2026-09-04): pinnedFallback REMOVED. The hand-curated Palmyra
    // list dated from 2026-04-23 and was a snapshot of GET /v1/models taken
    // by hand because the parser was believed unable to read Writer's shape.
    // It can (see the integrationMode comment above), so the live endpoint is
    // the inventory of record and the snapshot is gone rather than left to rot.
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://dev.writer.com',
    notes:
      'Enterprise Palmyra-family chat + generation; OAI-compat execution path. LOTE AK (2026-09-04): promoted to discovery+execution — GET /v1/models returns `{models:[...]}`, already consumed by the hub parser (data|models|results|items|entries), route proven by 401-vs-404-control probe; 2026-04 pinnedFallback dropped. palmyra-vision needs Writer-specific content shape (standard OAI multimodal array returns 400); deferred to an adapter extension.',
    lastReviewedAt: '2026-09-04',
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
    notes:
      'Solar LLM family + document-AI embeddings. OAI-compat. Orphan-closure entry 2026-04-23: adapter class existed at providers/upstage/ but was never wired. Post-closure live probes (chat, embeddings, jsonMode) all 200.',
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
    notes:
      'Reka Core / Flash / Edge multimodal chat. OAI-compat surface. Orphan-closure entry 2026-04-23: adapter class existed at providers/rekaai/ but was never wired.',
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
  // already exist (<prefix>-baidu-{key,secret,base-url}), but they back the
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
    notes:
      'Arcee SLM family (Trinity). OAI-compat chat, OpenRouter-style /models metadata. Reasoning at message.reasoning_content (streaming: delta.reasoning_content) — NOT message.reasoning as previously documented; unverified until 2026-07-29. Lot M 2026-04-23. D1 2026-04-24: 402 insufficient-credits. Live-verified 2026-07-29 after a $5 top-up: GET /v1/models 200 (trinity-mini renamed to trinity-large-thinking), POST /v1/chat/completions 200 (real content+usage), stream:true 200 (SSE, [DONE]).',
    lastReviewedAt: '2026-07-29',
  },
  {
    providerId: 'atlascloud',
    displayName: 'AtlasCloud',
    providerFamily: 'atlascloud',
    aliases: ['atlas-cloud'],
    integrationClass: 'oai-compat-pure',
    // LOTE AK (2026-09-04): promoted execution-only → discovery+execution and
    // the pinnedFallback deleted. The "no public GET /models" verdict was
    // never probed — it came from reading the docs site. A live probe now
    // shows the endpoint is not just present but PUBLIC:
    //   GET /v1/models            → 200 {"code":200,"msg":"succeed","data":[…]}
    //   GET /v1/zzz-control-probe → 401 {"code":401,"msg":"unauthorized"}
    // The body nests an OpenAI-shaped array under `data`, which the hub
    // parser already consumes. The three pinned ids were also wrong against
    // that live body (real ids are vendor-prefixed, e.g.
    // "Qwen/Qwen3-235B-A22B-Instruct-2507"), so keeping them would have kept
    // routing traffic at models this host does not serve.
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.atlascloud.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ATLASCLOUD_API_KEY',
    // LOTE AN (2026-09-05) regression fix: the LOTE AK probe above already
    // proved GET /v1/models answers 200 with NO Authorization header — but
    // apiKeyOptional was never set when pinnedFallback was deleted. Without
    // it, catalog-provider-plugin's credential gate throws "missing API key"
    // before the request is ever issued, so in any environment without
    // ATLASCLOUD_API_KEY the pool silently went from 3 pinned models to 0.
    // Same pattern already fixed for mancer in 8f4cf393. Execution
    // (chat/completions) still requires a real key.
    apiKeyOptional: true,
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
    notes:
      'GPU cloud aggregator. Multi-surface (chat+image) under a single OAI-compat base URL. LOTE AK (2026-09-04): promoted to discovery+execution — GET /v1/models answers 200 UNAUTHENTICATED with an OAI-shaped array under `data` (control path on the same host 401s), so the docs-derived "no public /models" verdict was wrong and the 3 pinned ids were stale vs the live body. Probe 2026-07-17: no OAI-style video route (404 both candidates) — video de-advertised until a real route is proven.',
    lastReviewedAt: '2026-09-04',
  },
  {
    providerId: 'avian',
    displayName: 'Avian.io',
    providerFamily: 'avian',
    aliases: ['avian-io'],
    integrationClass: 'oai-compat-pure',
    // LOTE AK (2026-09-04): promoted execution-only → discovery+execution and
    // the pinnedFallback deleted. "No /models endpoint documented" was a
    // docs-absence claim, never a probe. Live probe:
    //   GET /v1/models            → 200 {"object":"list","data":[…]} (public,
    //                               pure OpenAI shape, with context_length +
    //                               display_name metadata the pinned list lacked)
    //   GET /v1/zzz-control-probe → 404 (Django not-found page)
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.avian.io/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AVIAN_API_KEY',
    // LOTE AN (2026-09-05) regression fix: the LOTE AK probe above already
    // proved GET /v1/models answers 200 with NO Authorization header — but
    // apiKeyOptional was never set when pinnedFallback was deleted. Without
    // it, catalog-provider-plugin's credential gate throws "missing API key"
    // before the request is ever issued, so in any environment without
    // AVIAN_API_KEY the pool silently went from 3 pinned models to 0. Same
    // pattern already fixed for mancer in 8f4cf393. Execution
    // (chat/completions) still requires a real key.
    apiKeyOptional: true,
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://avian.io/docs',
    notes:
      'OAI-compat inference aggregator (deepseek, moonshot, z-ai routes). LOTE AK (2026-09-04): promoted to discovery+execution — GET /v1/models answers 200 UNAUTHENTICATED in pure OpenAI shape (control path on the same host 404s), carrying context_length/display_name the 3-entry pinned list did not. The "no /models documented" note was an absence-of-docs claim, never a probe.',
    lastReviewedAt: '2026-09-04',
  },
  {
    // Baidu Qianfan (ERNIE platform) — promoted to canonical Lot M 2026-04-23.
    //
    // Pre-promotion state: 3 GCP secrets existed (<prefix>-baidu-{key,secret,base-url})
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
    integrationMode: 'discovery+execution',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    baseUrlEnvVar: 'BAIDU_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'QIANFAN_API_KEY',
    apiKeyEnvVarOverrideReason:
      'QIANFAN_API_KEY matches the v2 bce-v3/... bearer format at qianfan.baidubce.com/v2. Legacy ERNIE_API_KEY / ERNIE_SECRET_KEY remain mapped for the v1 AK+SK OAuth flow, not this v2 runtime path.',
    // LOTE AL (2026-09-05) GAP-AK-6 resolution: the 'no-list-endpoint'
    // premise above was WRONG — Baidu's official v2 API docs
    // (cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y, "GET获取模型列表") document
    // GET /v2/models returning a standard OpenAI-shape {"object":"list",
    // "data":[{id, context_length, pricing, ...}]} body, already covered by
    // extractRawModels' `record.data` case and convertRawModel's `id`/
    // `context_length` field reads — no new parser needed. The 403
    // AccessDenied (not 404) recorded against this exact path in
    // liveProbes.loteAK_2026_09_04 corroborates the route is real and just
    // auth-gated. Promoted execution-only -> discovery+execution and the
    // fabricated 3-model pinnedFallback below was removed accordingly.
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
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y',
    notes:
      'PRC-region. Content-safety filters applied server-side. Two auth paths: v1 AK+SK→OAuth (legacy) and v2 bce-v3 bearer (canonical). Sublote A probe 2026-04-23: both surfaces alive (401/200-error-coded without auth). LOTE AL (2026-09-05): GET /v2/models promoted to live discovery — 403 AccessDenied without a key, expected 200 once QIANFAN_API_KEY is provisioned.',
    lastReviewedAt: '2026-09-05',
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
    notes:
      'Serverless + Dedicated GPU platform. Two-plane API: inference at api.gmi-serving.com, provisioning/IAM at console.gmicloud.ai. Video API distinct from LLM API. Sublote C1 2026-04-23: /v1/chat and /v1/embeddings return 404 "No matching target server found for model X" BEFORE auth validation — model routing is pre-auth; 404 with unknown model does NOT imply bad key. Lot M 2026-04-23.',
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
    notes:
      'Zero-logs vLLM behind LiteLLM proxy. Roleplay catalog (Sao10K, TheDrummer, Magnum). Domain mismatch: docs on docs.infermatic.ai, API on api.totalgpt.ai. Extra sampling params (top_k, repetition_penalty); some models reject system prompts. Tools NOT documented. Lot M 2026-04-23. D1 2026-04-24: live-validated — <prefix>-infermatic-api-key (25B <redacted-key-prefix>…) is model-scoped LiteLLM Virtual Key; Qwen-Qwen3-30B-A3B chat 200 (476B). Key ACL pins model list.',
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
    //
    // 2026-09-10: REVERTED execution-only → catalog-only. PR #555
    // (fix/inflection-real-discovery) live-re-probed with a real,
    // locally-provisioned INFLECTION_API_KEY (api/.gcp-secrets.env) while
    // investigating the zero-hardcode discovery classification, and found
    // the 2026-06-15 promotion's premise false: the ENTIRE
    // api.inflection.ai host, not just /v1/discovery/configs, is
    // unreachable. Every path/method/auth combination tried — GET and
    // POST; 8 candidate discovery paths; the /v1/chat/completions surface
    // this very row was promoted for; the legacy /external/api/inference
    // shape; a same-host nonsense control path; real key, garbage key, no
    // key at all — returns an identical generic nginx 404. Ruled out as a
    // network/environment artifact: a live, current `CN=inflection.ai`
    // TLS cert, and the same client reached api.openai.com/api.github.com
    // normally in the same session. developers.inflection.ai (docsUrl)
    // fails DNS resolution outright. With `integrationMode: 'execution-only'`
    // + `enabledByDefault: true`, catalog-loader.ts was constructing a
    // real execution plugin for this row at every boot and routing live
    // chat-completion attempts at a host that 404s unconditionally —
    // `enabledByDefault: false` was considered but rejected: it is a
    // soft, env-overridable gate (still registers when INFLECTION_API_KEY
    // is set, which it is), and per phase-5-catalog-invariants.test.ts
    // ('enabled-by-default' + 'no-deny-by-default') neither
    // `enabledByDefault: false` (reserved for self-hosted/apiKeyOptional
    // rows) nor `denyByDefault` (retired Phase 4b) is a legal gate here.
    // `catalog-only` is the same unconditional, unwritable-around gate
    // already used for relace (also first-party-native, also
    // pinnedFallback, also no working adapter) and is what this row
    // itself carried before the now-disproven 2026-06-15 promotion.
    // enabledByDefault stays true (never-censored/never-hidden policy —
    // the row remains visible catalog inventory); pinnedFallback is
    // unchanged. See consolidation-matrix.ts (defunct-unreachable bucket)
    // for the operational-classification counterpart of this change.
    integrationMode: 'catalog-only',
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
    notes:
      'OpenAI-compat API at https://api.inflection.ai/v1. pinnedFallback: inflection_3_pi, inflection_3_productivity, Pi-3.1 (no-list-endpoint). REVERTED execution-only -> catalog-only 2026-09-10: PR #555 re-probed with a real INFLECTION_API_KEY, found the WHOLE host dead (identical nginx 404 every path/method/auth combo, incl. /v1/chat/completions); docsUrl fails DNS. Not a network artifact (live TLS cert; openai/github respond normally same session). See consolidation-matrix.ts defunct-unreachable.',
    lastReviewedAt: '2026-09-10',
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
    // LOTE AL (2026-09-04) GAP-R1: consolidation-matrix.ts (Sublote B,
    // 2026-04-23) already documents that GET /oai/v1/models returns 200
    // PUBLICLY (9 models) when NO Authorization header is sent — only
    // /chat/completions validates the Bearer. Without apiKeyOptional the
    // catalog's own gate (catalog-provider-plugin.ts) throws
    // "missing API key" before ever issuing that request, so in any
    // credential-less environment discovery never runs even though the
    // vendor itself permits it. Chat/completions still requires a real key
    // and correctly 401s without one.
    apiKeyOptional: true,
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    contentPolicyClass: 'uncensored',
    priority: 5,
    docsUrl: 'https://docs.mancer.tech',
    notes:
      'Roleplay/creative ("No filters, No guidelines, No constraints"). Tagged contentPolicyClass=uncensored — fully admitted per universal "habilitado e nunca censurado" policy (Phase 4b 2026-04-28); tag is informational, downstream surfaces may filter. Credit-based pricing (not USD/token). 9 models incl. MythoMax-13B, Goliath-120B, Magnum-72B-v4. SillyTavern primary client. Lot M 2026-04-23. apiKeyOptional=true added LOTE AL (2026-09-04): /models is public.',
    lastReviewedAt: '2026-09-04',
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
    notes:
      'TEE-attested LLM gateway (NVIDIA H100/H200 Confidential Computing). Every response carries cryptographic attestation verifiable at /phala-cloud/confidential-ai/verify. Aggregates upstream models (Anthropic, OpenAI, DeepSeek, Qwen) running inside enclaves. Lot M 2026-04-23.',
    lastReviewedAt: '2026-04-23',
  },
  {
    providerId: 'relace',
    displayName: 'Relace',
    providerFamily: 'relace',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    // GAP-AK-6 closure (LOTE AT, 2026-09-09): the official OpenAPI spec
    // (https://docs.relace.ai/api-reference/openapi.json) declares TWO
    // servers — `models.relace.ai` (all model APIs) and `api.relace.run`
    // (repo management). `instantapply.endpoint.relace.run` (the previous
    // baseUrl) does not appear in that spec at all — it was a stale/legacy
    // host. `models.relace.ai` also serves `GET /v1/chat/completions`
    // ("Send an OpenAI-compatible chat completions request to a
    // Relace-hosted model") with a free-form `model` string field (example
    // values quoted in the spec: `deepseek-ai/DeepSeek-V4-Flash-0731`,
    // `moonshotai/kimi-k3`) — a real oai-compat-pure surface, no dedicated
    // adapter needed (same pattern as morph/chutes/gmi below).
    baseUrl: 'https://models.relace.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'RELACE_API_KEY',
    // Discovery: GET /models lives at the HOST ROOT (`models.relace.ai/models`),
    // NOT under this row's `/v1` baseUrl, and `paths.modelList` only accepts
    // relative paths (ProviderEndpointPathsSchema requires a leading "/", so
    // it always concatenates onto baseUrl) — the same shape-mismatch already
    // documented on the `github-models` row above. Wired as a dedicated
    // `relace-native` aggregator source in central-model-discovery-service.ts
    // (OpenAICompatibleHubModelFetcher with an absolute modelListPaths
    // override), not through this row's generic catalog-bridge fetcher.
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.relace.ai',
    // GAP-AK-6 closure (LOTE AT, 2026-09-09): confirmed via the official
    // OpenAPI spec that `GET /models` on models.relace.ai is real — "Get the
    // catalog for open-weight models hosted by Relace", `{data:[{id, name,
    // context_length, max_output_length, pricing, input_modalities,
    // output_modalities, supported_features, ...}]}` (extractRawModels'
    // `record.data` case + convertRawModel's `id`/`context_length` reads,
    // same as qianfan's LOTE AL closure). Bearer-authed. Promoted
    // catalog-only -> discovery+execution; pinnedFallback removed; moved
    // registry entry from `non-compliant-hardcoded-inventory` to
    // `compliant-dynamic-discovery` (consolidation-matrix.ts) and out of
    // `LEGACY_PINNED_INVENTORY` (zero-hardcoded-model-inventory.test.ts).
    //
    // Deliberately OUT OF SCOPE for this row: Relace's proprietary specialty
    // tool endpoints — `POST /v1/code/apply` (fixed model `relace-apply-3`,
    // literally the sole enum value in `InstantApplyRequest.model`),
    // `POST /v1/code/compact`, `POST /v2/code/rank`, `POST
    // /v1/search/chat/completions` (relace-search). None of these appear in
    // the `GET /models` catalog above — they are single-purpose, fixed-model
    // tool contracts (not a family of interchangeable chat models this
    // catalog's `pinnedFallback`/discovery semantics are meant to enumerate),
    // so they are not modeled as catalog rows here. The previous pin also
    // carried `relace-code-reranker` and `relace-embedding` as separate
    // pinned "models" — neither string appears ANYWHERE in the official
    // OpenAPI spec (no `/v1/embeddings` path exists at all), so those two
    // were unverified/likely-fabricated identifiers, not merely undiscovered
    // ones; dropped rather than carried forward. If code-apply/rerank/search
    // are wanted as first-class features later, they need a dedicated
    // tool-capability integration (their own adapter, not a pinned model
    // row) — tracked separately, not blocking this discovery fix.
    notes:
      'General-purpose open-weight model hosting (models.relace.ai): OAI-compatible /v1/chat/completions + real GET /models discovery (Bearer). Distinct from Relace\'s specialty code-edit/rerank/search tool endpoints (fixed single-purpose contracts, e.g. relace-apply-3), which are intentionally NOT modeled as catalog "models" — see the discovery-closure comment above. No RELACE_API_KEY provisioned in this environment; discovery returns [] until one is.',
    lastReviewedAt: '2026-09-09',
  },
  {
    providerId: 'siliconflow',
    displayName: 'SiliconFlow',
    providerFamily: 'siliconflow',
    aliases: ['silicon-flow'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.siliconflow.com/v1',
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
    // LOTE AS (2026-09-06): live-browsed
    // https://docs.siliconflow.com/en/api-reference/videos/videos_submit
    // today. No `duration` field exists on the endpoint at all (length is
    // fixed per Wan-AI model) — deliberately left unset here rather than
    // fabricated. `image_size` doubles as the resolution/ratio enum.
    videoCapabilityAttributes: {
      maxResolution: '720p',
      supportedAspectRatios: ['16:9', '9:16', '1:1'],
      // No audio field on the endpoint — verified absence, not "undocumented".
      nativeAudioSupport: false,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 5,
    docsUrl: 'https://docs.siliconflow.cn',
    notes:
      '2026-07-30: baseUrl corrected .cn → .com — GENUINE integration bug, not a key problem. SiliconFlow runs two separate regional platforms (china-domestic .cn vs international .com) with SEPARATE, non-interchangeable account/key namespaces. This account is on the international platform: .cn 401 "Api key is invalid" (bare-JSON) even freshly regenerated; identical key against .com 200, real chat completion + usage, prompt_cache_hit/miss_tokens fields confirm oai-compat-quirks shape.',
    lastReviewedAt: '2026-07-30',
  },
  {
    providerId: 'stepfun',
    displayName: 'StepFun',
    providerFamily: 'stepfun',
    aliases: ['step', 'step-ai'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.stepfun.ai/v1',
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
    notes:
      '2026-07-30: baseUrl corrected .com → .ai — GENUINE integration bug, opposite domain mapping from siliconflow (StepFun\'s .com is china-domestic, .ai is international). .com 401 "Incorrect API key provided" even freshly regenerated; .ai 200 real model list (step-3.5-flash, stepaudio-2.5-*, step-image-edit-2). Model lineup renamed to step-3.x gen — old step-1-8k id is gone (404, not auth). step-3.5-flash chat 200 (reasoning model; verified via reasoning_content).',
    lastReviewedAt: '2026-07-30',
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
    // LOTE AS (2026-09-06): live-fetched
    // https://docs.venice.ai/api-reference/endpoint/video today (Seedance
    // passthrough). `resolution` varies per underlying model — '2160p'/'4k'
    // is the ceiling across the family.
    videoCapabilityAttributes: {
      maxDurationSeconds: 30,
      maxResolution: '4k',
      supportedAspectRatios: [
        '1:1',
        '2:3',
        '3:2',
        '3:4',
        '4:3',
        '4:5',
        '5:4',
        '9:16',
        '9:21',
        '16:9',
        '21:9',
        'adaptive',
        'auto',
      ],
      // `audio: boolean` (default true) — "For models which support audio
      // generation". Same wiring caveat as zai: real vendor capability,
      // declared for selection-time exclusion accuracy, not yet plumbed
      // end-to-end (LOTE AS Part 1 wires only BytePlus + Google Veo).
      nativeAudioSupport: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    contentPolicyClass: 'uncensored',
    priority: 5,
    docsUrl: 'https://docs.venice.ai',
    notes:
      'Privacy-first, no retention. Tagged contentPolicyClass=uncensored (Phase 4b 2026-04-28; informational, downstream may filter). venice_parameters: enable_web_search, character_slug, E2EE, reasoning. Async /audio/queue + /video/queue. Double-path /api/v1. Safety headers x-venice-is-blurred / -contains-minor. Sublote A 2026-04-23: /models PUBLIC; /chat HTTP 402 (USDC Base L2 eip155:8453) alt to bearer — impl bearer-only. Lot M.',
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
    docsUrl:
      'https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope',
    notes:
      'Qwen + DeepSeek hosted via Dashscope OAI-compat endpoint. Adds qwen-coder, qwen-vl, qwen-flash, qvq-max + DeepSeek-V3.x mirrors. The pre-existing alibaba-model-fetcher.ts handles discovery (wraps OpenAI client against compatible-mode/v1); this catalog row adds the runtime adapter via the standard hub bridge. Operator override DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 for mainland China region.',
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
    integrationMode: 'discovery+execution',
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
    // GAP-AK-6 (2026-09-05): pinnedFallback REMOVED. The comment it carried
    // ("we pin a curated roster … operators should expand this list as AWS
    // publishes new SKUs") described a maintenance burden that no operator
    // was ever going to keep up with, and the roster was already frozen at
    // 2026-05-06. ListFoundationModels is the vendor-authoritative inventory
    // and the aws-bedrock-hub discovery source already calls it with the
    // credentials wired here; the pins only ever masked its absence.
    // NOT live-validated — no AWS credential in this environment.
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
    notes:
      'AWS Bedrock Converse API. SigV4 auth via AWS SDK default credential chain (AWS_ACCESS_KEY_ID/SECRET, AWS_BEARER_TOKEN_BEDROCK, container role, etc.). Region from AWS_BEDROCK_REGION or AWS_REGION (default us-east-1). Inference-profile ARNs supported via AWS_BEDROCK_INFERENCE_PROFILE_ARN for cross-region routing.',
    lastReviewedAt: '2026-05-06',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE O (2026-07-10) — Apertis + Inception Labs onboarding.
  //
  // Both had GCP secrets provisioned by the operator (<prefix>-apertis-key,
  // <prefix>-inception-key) ahead of the catalog rows. No live probe was run
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
    notes:
      'Multi-vendor gateway (400+ models, new-api-style). ApertisAdapter disables its native fallback_models so failures surface to our orchestrator. Probe 2026-07-16: SSE/embeddings/STT proven; imageGen+TTS routes exist, upstream 429-saturated (unconfirmed); rerank 404 + images/edits drops the model field — both removed from supports (see paths comments). dall-e-2 absent; use dall-e-3/gpt-image-*. Video async, out of scope. sk-sub- keys 403 on /audio.',
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
    capabilityHints: [{ capability: 'diffusion_lm', rationale: 'docs-declared', confidence: 0.6 }],
    pricingMode: 'none',
    enabledByDefault: true,
    docsUrl: 'https://docs.inceptionlabs.ai/get-started/get-started',
    notes:
      'dLLM (diffusion). NEVER send diffusing:true — confirmed live 2026-07-16: chunks carry diffusion_meta and the FULL rewritten text (naive delta concatenation duplicates output); InceptionAdapter drops the flag and logs. Normal SSE + tool-calling proven same day. temperature server-clamped [0.5,1.0]; adapter clamps client-side. Text-only. FIM/Next-Edit out of scope (non-chat payload).',
    lastReviewedAt: '2026-07-16',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LOTE P (2026-07-11) — EmpirioLabs AI onboarding.
  //
  // Held back in LOTE O pending live validation (docs cited an unfamiliar
  // domain/model lineup — Qwen3-Max, Seed 2.0 Pro, Kling O3, GLM-TTS —
  // that didn't match any known catalog). Operator re-authenticated gcloud
  // (device-code flow) and the real <prefix>-empiriolabs-key was probed live:
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
      // PRODUCTION INCIDENT (2026-09-08): once credits were funded, the
      // submit above started succeeding for real (`{job_id, status, poll_url}`
      // — top-level, no `data` wrapper) and every single subsequent poll 404'd
      // for the full 300s budget, e.g. task 5bd00840-7c59-42d3-9891-
      // 7371138ee963. Root cause confirmed against EmpirioLabs' own docs
      // (docs.empiriolabs.ai/api-reference/api-reference/jobs/retrieve-job,
      // and its OpenAPI spec's create-video description: "Always async.
      // Returns a job_id and polling URL immediately; poll GET
      // /v1/jobs/<job-id> for the final video URL."): EmpirioLabs does NOT
      // nest polling under the submit path like FastRouter does — it uses a
      // single UNIFIED jobs endpoint shared by every async capability, and
      // even hands the client that exact URL back in the submit response's
      // `poll_url` field. The hub adapter's default poll-path fallback
      // (`<videoGenerate>/<taskId>` = `/videos/generations/{taskId}`) is
      // therefore always wrong for this provider — hence the 404 on every
      // attempt, never resolving no matter how long the poll budget runs.
      // The completed-job body also nests output under `result.data[].url`,
      // not the generic `data[]`/`generations[]` shapes (see
      // extractVideoItems's `result.data[]` branch, openai-compatible-hub-
      // adapter.ts).
      videoPoll: '/jobs/{taskId}',
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
    notes:
      'Multi-vendor gateway (134+ models). Probe 2026-07-16: SSE, embeddings, rerank (/reranks PLURAL) and system-override all proven. CAVEAT: deepseek-v4-flash streams into delta.reasoning_content at low max_tokens. Only /v1/chat/completions wired. Video route live (2026-07-17, blocked only by 402 credits). FIXED 2026-09-08: funded video polls 404 because EmpirioLabs uses a separate unified /v1/jobs/{id} endpoint, not <submitPath>/{id} — see paths.videoPoll.',
    lastReviewedAt: '2026-09-08',
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
    notes:
      'Meta-aggregator (20 upstream providers). Discovery unauthenticated; execution paths carry a TRAILING SLASH. Probe 2026-07-16: SSE + /responses/ proven (azure/gpt-4o-mini routing visible, cost breakdown in payload). 424 = ITS upstream vendor failed — classified retryable server_error by provider-error-classifier. Its concentrate/redact-v1 listing is a PII-redaction feature, not an inference vendor.',
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
    notes:
      'Meta-aggregator (20 upstream, BYOK). /api/v1 canonical (docs show both prefixes). Probe 2026-07-16: SSE proven (:FASTROUTER PROCESSING comment keep-alives + own final usage chunk with cost+provider before [DONE]); embeddings proven; :flex suffix proven (service_tier flex). Model ids provider/model may carry :price/:throughput/:flex — do not strip. fastrouter/auto not used (ci does its own selection). 402 = insufficient credits. Probe 2026-07-17: video async-queue surface mapped live (see paths).',
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
  // Live-probed 2026-07-13 with the real <prefix>-perplexity-api-key (same
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
    notes:
      'Second Perplexity surface (same account/key as `perplexity`): /v1/agent, Responses-style, NOT chat/completions. REAL token streaming since 2026-07-16 (response.output_text.delta / response.completed; NO [DONE]; gappy sequence_number) — unit-tested against the live-captured fixture. Tools proven live (flat shape; toolu_bdrk_ ids reveal Bedrock-served Anthropic). Moonshot kimi-k2.7-code works but hangs intermittently when cold — orchestrator timeout+fallback covers it.',
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
    notes:
      "Meta-gateway to ~100 upstream providers / 70k+ models behind api.ailin.one's own orchestration. Discovery uses the generic hub fetcher against a richer native /v1/models shape it only partly understands (see header comment) — operability filtering is a known follow-up gap. Auth is X-API-Key; api.ailin.one also accepts bearerAuth JWT for user sessions, not used here (static server credential).",
    lastReviewedAt: '2026-07-13',
  },
  // ──────────────────────────────────────────────────────────────────────────
  // Sakana AI (Fugu) — added 2026-07-29 in PR #234, promoted to fully
  // operational the same day once the operator activated pay-as-you-go
  // billing on the account (previously had no active subscription, so every
  // chat/completions call 429'd regardless of integration correctness).
  //   - GET /v1/models -> 200, real 5-model array (fugu, fugu-ultra,
  //     fugu-ultra-20260615, fugu-ultra-v1.0, fugu-ultra-v1.1) even though
  //     NEITHER docs page (console.sakana.ai/get-started or /models)
  //     documents this endpoint. Shape matches the generic
  //     OpenAICompatibleHubModelFetcher (`data[].id`) — no dedicated
  //     fetcher/pinnedFallback needed.
  //   - POST /v1/chat/completions: after billing activation, a real
  //     end-to-end re-verification was run directly against the live API
  //     (2026-07-29, GCP secret `<prefix>-sakana-ai-key`) and confirmed chat,
  //     streaming, tool calls, JSON mode, and vision ALL genuinely work —
  //     real HTTP 200 responses with correct, sensible content, not merely
  //     the absence of an error. Vision in particular is now evidence-
  //     backed rather than doc-inferred: a multimodal request containing an
  //     inline image correctly identified the image's content, and
  //     prompt_tokens jumped sharply on that call versus text-only calls —
  //     proof the image was actually processed, not silently dropped. That
  //     DIRECTLY CONTRADICTS console.sakana.ai/models' own capability
  //     table, which marks Vision unsupported (✗); the live probe is
  //     trusted over the vendor's apparently stale/incorrect docs.
  //   - Observed quirk, noted but not acted on: `usage.completion_tokens_
  //     details.reasoning_tokens` showed up on a plain `fugu` call even
  //     though nothing in the request asked for reasoning — worth watching,
  //     not itself a reason to change anything (`supports.reasoning` was
  //     already `true`).
  //   - fugu-ultra appears to route requests through an internal
  //     multi-agent orchestration layer (matches its docs' "routes 1-3
  //     agents" description) — `usage.prompt_tokens_details.
  //     orchestration_input_tokens` reflects that on fugu-ultra calls.
  //   - fugu-cyber / fugu-cyber-v1.0 are excluded via modelDenylist: the
  //     pricing docs say cyber "requires access request approval" and is
  //     "available only through pay-as-you-go billing"; this key's
  //     /v1/models response does not list either cyber model, consistent
  //     with no cyber entitlement. Deliberately not advertising a model
  //     most keys can't call.
  //   - pricingMode is `none`, not `remote`: neither /v1/models nor
  //     chat/completions responses expose pricing/context-window fields,
  //     and this catalog's `static-file` PricingMode is reserved/
  //     unimplemented. For reference only (marketing page, not machine-
  //     read): fugu-ultra $5/$30 per 1M in/out tokens standard, $10/$45
  //     above 272K context, $0.50/$1.00 cached; fugu-cyber $6/$36 standard,
  //     $12/$54 above 272K, $0.60/$1.20 cached; base fugu has no per-token
  //     price — subscription-only (Standard $20/mo, Pro $100/mo, Max
  //     $200/mo).
  //   - apiKeyEnvVar follows the `<PROVIDER_ID_UPPER>_API_KEY` convention
  //     (SAKANA_AI_API_KEY, not the shorter SAKANA_API_KEY) per Rule 1 in
  //     provider-catalog.schema.ts — Sakana has no well-known upstream SDK
  //     env-var name to justify an override.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'sakana-ai',
    displayName: 'Sakana AI (Fugu)',
    providerFamily: 'sakana-ai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.sakana.ai/v1',
    baseUrlEnvVar: 'SAKANA_AI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SAKANA_AI_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      reasoning: true,
    },
    pricingMode: 'none',
    modelDenylist: ['fugu-cyber', 'fugu-cyber-v1.0'],
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://console.sakana.ai/get-started',
    notes:
      'Fugu chat/tools/reasoning/vision models. Live-verified 2026-07-29: /v1/models works (5 real models). Billing activated same day; end-to-end re-verification confirmed chat, streaming, tools, JSON mode, and vision all genuinely work — real HTTP 200s with correct content. Vision is evidence-backed despite console.sakana.ai/models marking it unsupported. fugu-cyber excluded via modelDenylist (approval-gated). pricingMode=none: no pricing in API responses; see header comment for detail.',
    lastReviewedAt: '2026-07-29',
  },
  // ──────────────────────────────────────────────────────────────────────────
  // Maritaca AI (Sabiá) — added 2026-08-01. Brazilian LLM provider (Sabiá 4
  // family, PT-BR focused).
  //   - GET https://chat.maritaca.ai/api/v1/models -> 200, real 6-model
  //     array (sabia-4, sabia-4-br-sp, sabia-4-thinking,
  //     sabia-4-thinking-br-sp, sabiazinho-4, sabiazinho-4-br-sp). Docs
  //     (docs.maritaca.ai/pt/api/comeco-rapido) never mention a /v1/models
  //     list endpoint, but it genuinely works — the docs were WRONG on this
  //     point. GET .../api/models (no /v1) returns byte-identical output,
  //     no redirect; catalog uses the /v1 path for consistency with every
  //     other row in this file.
  //   - POST .../api/v1/chat/completions AND POST .../api/chat/completions
  //     (no /v1) are BOTH real, reachable routes: a bogus path 404s with
  //     {"detail":"Not Found"}, but both these paths pass straight through
  //     to a structured {code:"insufficient_funds"} 403 — proof the
  //     request was parsed, authenticated, and the model validated before
  //     billing rejected it. Could NOT obtain an actual HTTP 200 chat
  //     completion: this GCP key's MariTalk account currently has zero
  //     active credits ("Sorry, you need have active credits to use
  //     MariTalk via API."). Catalog uses the /v1 path for consistency; the
  //     no-/v1 alias also works if ever needed.
  //   - Auth confirmed standard OpenAI-style Bearer: an invalid key gets a
  //     distinct 401 {code:"invalid_api_key"}, vs the 403 insufficient_funds
  //     above for the real (valid) key — proves auth succeeds and it's a
  //     billing gate, not an auth failure.
  //   - Model ids confirmed via TWO independent live signals (not guessed
  //     from docs): the /v1/models array above, and the 404
  //     model_not_found error body for a deliberately bogus model name,
  //     which echoes the exact canonical list + aliases: sabia-4 (alias
  //     sabiá-4), sabia-4-br-sp, sabia-4-thinking (alias sabiá-4-thinking),
  //     sabia-4-thinking-br-sp, sabiazinho-4 (aliases sabia-4-small,
  //     sabiazim-4), sabiazinho-4-br-sp. The docs-mentioned alias
  //     "sabia-4-2026-01-06" does NOT appear in either live signal, so it
  //     is deliberately omitted here rather than guessed.
  //   - tools (function-calling) and jsonMode (response_format=
  //     json_object) requests were both submitted live against sabia-4 and
  //     passed through to the same insufficient_funds gate (not rejected
  //     as malformed) — combined with dedicated docs pages
  //     (/pt/chamada-funcao, /pt/ferramentas, /pt/structured-outputs) this
  //     is treated as strong-confidence support, NOT a verified 200.
  //     stream:true was accepted the same way but streaming is deliberately
  //     left OFF supports since it was never observed producing real SSE
  //     chunks end-to-end.
  //   - reasoning: true reflects the documented Sabiá 4 Thinking tier (a
  //     dedicated reasoning/agentic model family, confirmed to exist via
  //     live discovery above) — docs-declared, not live-response-verified
  //     (blocked by the same billing gate).
  //   - vision NOT set: no vision capability is mentioned anywhere in the
  //     gathered Maritaca docs, unlike Sakana above.
  //   - embeddings intentionally omitted: Maritaca's own docs say they
  //     don't offer an embeddings model and point to DeepInfra's
  //     intfloat/multilingual-e5-large instead.
  //   - pricingMode is `none`: no per-token pricing exposed in /v1/models
  //     or chat/completions responses; rate limits are spend-tier based
  //     (R$0–R$5000+), informational only.
  //   - apiKeyEnvVar follows the `<PROVIDER_ID_UPPER>_API_KEY` convention
  //     (MARITACA_AI_API_KEY, not e.g. MARITACA_API_KEY) per Rule 1 in
  //     provider-catalog.schema.ts — no well-known upstream SDK env-var
  //     name to justify an override.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'maritaca-ai',
    displayName: 'Maritaca AI (Sabiá)',
    providerFamily: 'maritaca-ai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://chat.maritaca.ai/api/v1',
    baseUrlEnvVar: 'MARITACA_AI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MARITACA_AI_API_KEY',
    supports: {
      chat: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.maritaca.ai/pt/api/comeco-rapido',
    notes:
      'Sabiá 4 family (Brazilian Portuguese). Live-verified 2026-08-01: /v1/models genuinely works (6 real models) though docs imply no discovery endpoint. Both /v1/chat/completions and /chat/completions are real routes but blocked by insufficient_funds (zero credits on this key) — could not obtain an actual 200. tools/jsonMode/reasoning are docs-declared + request-accepted-not-rejected, not 200-verified. streaming unconfirmed, left off. No embeddings (Maritaca points to DeepInfra e5-large instead).',
    lastReviewedAt: '2026-08-01',
  },
  // ──────────────────────────────────────────────────────────────────────────
  // LOTE AA (2026-08-02) — BytePlus ModelArk. Dedicated multimodal adapter.
  //
  // DISTINCT FROM `volcano` ABOVE. ModelArk is ByteDance's international
  // (non-China) deployment; Volcengine Ark is the mainland one. Separate
  // hosts, TLDs, control planes, model catalogs, and provably
  // non-interchangeable credentials — a ModelArk key does not authenticate
  // against Volcengine and vice versa. The `volcano` row is deliberately
  // untouched, and this row claims NEITHER of volcano's `ark`/`bytedance`
  // aliases (the alias-collision invariant only rejects alias-vs-providerId
  // duplication, so reusing them would pass CI while being semantically
  // ambiguous during normalisation).
  //
  // baseUrl carries three separate traps, all live-verified:
  //   · `/api/v3`, NOT `/v1` — a client appending /v1 404s on everything;
  //   · TLD is `bytepluses.com` (PLURAL) — docs/console are byteplus.com;
  //   · region token is `ap-southeast` with NO `-1` (only the AK/SK control
  //     plane, on a different host entirely, uses ap-southeast-1).
  //
  // integrationMode is discovery+execution because GET /api/v3/models is
  // REAL: live probe returned 200 with 52 models carrying richer metadata
  // than OpenAI's listing (domain, task_type[], modalities, token_limits,
  // features.{tools,structured_outputs}). Pre-implementation research had
  // concluded discovery was impossible without AK/SK request signing; the
  // live probe disproved that, so there is deliberately NO pinnedFallback
  // here — the vendor's own listing is the inventory of record.
  //
  // `supports` reflects what the ADAPTER IMPLEMENTS against routes proven
  // to exist — not what the provider is capable of. Not declared, with
  // reasons:
  //   · responses — /responses EXISTS upstream (it reached the model gate
  //     and returned 404 ModelNotOpen, so the route is real) but
  //     BytePlusModelArkAdapter contains zero Responses-API code: every
  //     chat path goes to /chat/completions. The Responses API has a
  //     different content-part and tool schema that was not implemented.
  //     Declaring it would break this row's own stated rule, and
  //     paths.responses is omitted for the same reason paths.moderation is
  //     (below) — a path present is a path a generic fallback can fire at.
  //   · mcp — remote MCP tools are SUPPORTED upstream but Responses-API
  //     only (POST /responses + `ark-beta-mcp: true` + tools[{type:'mcp'}]).
  //     Chat Completions has no mcp tool type, so a Chat-API-only adapter
  //     cannot reach it. Implementing MCP means implementing /responses.
  //   · textToSpeech — /audio/speech is an absent route; ModelArk has no
  //     speech synthesis at all (Seedance generate_audio is a video
  //     soundtrack, not TTS).
  //   · moderation — /moderations is an absent route; moderation exists
  //     only as output-side metadata on chat responses.
  //   · rerank — not on the ModelArk data plane (it belongs to the separate
  //     Knowledge-Base/RAG product, different host, AK/SK-signed).
  //   · speechToText — IMPLEMENTED and callable (chat + input_audio part),
  //     but deliberately NOT advertised: it is an LLM understanding task
  //     with prompt-dependent formatting, not an ASR endpoint, and should
  //     not be router-selectable over a real ASR provider until measured.
  //
  // Implemented but outside any ProviderAdapter contract, so they appear in
  // neither `paths` nor `supports` — they are plain public methods on the
  // adapter, following the countTokens precedent: countTokens
  // (POST /tokenization), batchChatCompletion (POST /batch/chat/completions),
  // uploadFile (POST /files, multipart), generateAsset3D (the same
  // /contents/generations/tasks route as video, result at content.file_url).
  //
  // Known upstream capability with no ci surface at all: STREAMING image
  // generation (stream:true on /images/generations — SSE with typed
  // image_generation.partial_succeeded/partial_failed/completed events and
  // no [DONE] sentinel). ci has no streaming-image method to map it onto.
  //
  // Route-existence method: ModelArk's gateway answers unknown routes with
  // HTTP 200 and an EMPTY body (verified against a deliberately bogus
  // path), never a 404 — so absent routes were identified against that
  // control, not assumed from documentation.
  //
  // paths.imagesEdit intentionally points at /images/generations: editing
  // is the same route with an `image` field and a JSON (not multipart)
  // body. /images/edits does not exist. paths.moderation and
  // paths.audioTranscriptions are deliberately ABSENT so no generic
  // fallback can fire at a route that isn't there.
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'byteplus',
    displayName: 'BytePlus ModelArk',
    providerFamily: 'byteplus',
    aliases: ['modelark', 'byteplus-modelark'],
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    authScheme: 'bearer',
    apiKeyEnvVar: 'BYTEPLUS_API_KEY',
    adapterClass: 'BytePlusModelArkAdapter',
    paths: {
      modelList: ['/models'],
      chatCompletions: '/chat/completions',
      embeddings: '/embeddings/multimodal',
      imagesGenerate: '/images/generations',
      imagesEdit: '/images/generations',
      videoGenerate: '/contents/generations/tasks',
      videoPoll: '/contents/generations/tasks/{taskId}',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      reasoning: true,
      embeddings: true,
      imageGeneration: true,
      imageEditing: true,
      videoGeneration: true,
    },
    capabilityHints: [
      { capability: 'multilingual_chinese', rationale: 'provider-class-default', confidence: 0.85 },
      { capability: 'video_generation', rationale: 'endpoint-declared', confidence: 0.9 },
    ],
    // LOTE AS (2026-09-06): real, code-verified limits (byteplus-adapter.ts's
    // own RATIOS/RESOLUTIONS sets, ~1782-1788). Duration is NOT recorded here
    // — `frames` (a [29,289] lattice) takes precedence over `duration`
    // upstream and `duration` itself is passed through UNCAPPED by the
    // adapter, so no single "max seconds" figure would be honest.
    videoCapabilityAttributes: {
      maxResolution: '4K',
      supportedAspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      // Seedance `generate_audio` — a real video soundtrack switch, see notes.
      nativeAudioSupport: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk/1099455',
    notes:
      'ByteDance international — NOT volcano/Volcengine (non-interchangeable keys). Live 2026-08-02: auth works (GET /models 200 w/ 52 models, /ping and /tokenization 200; 401 on bad key), but account 3003814011 has ZERO models activated — every inference route 404s ModelNotOpen, a Console entitlement action, not a defect. Unknown routes answer 200+empty body; absent routes (/images/edits, /audio/*, /moderations) proven vs a bogus control. Real upstream, NOT claimed: responses, mcp, image streaming.',
    lastReviewedAt: '2026-08-02',
  },
  // ──────────────────────────────────────────────────────────────────────────
  // LOTE AB (2026-08-10) — DigitalOcean Serverless Inference. New catalog
  // row, no dedicated adapter: genuinely OpenAI-schema-compatible (Bearer
  // auth, POST /v1/chat/completions with standard messages/choices/usage
  // shape, SSE streaming with chat.completion.chunk objects, GET /v1/models
  // returning the standard {data:[{id,object,owned_by,created}],object:
  // "list"} shape) — same conclusion pattern as sakana-ai/maritaca-ai
  // (`oai-compat-pure`, no adapterClass override), NOT the BytePlus
  // ModelArk path (no non-standard field names, no Responses-API-only
  // surface, no multimodal-embeddings-only route).
  //
  // FULL LIVE END-TO-END VERIFICATION, same GCP secret `<prefix>-digitalocean-
  // key` used throughout (a `doo_v1_`-prefixed token — DO's OAuth/app-token
  // format, one of two credential types the docs say are interchangeable
  // with a dedicated model-access-key for this API; value never logged):
  //   - GET /v1/models -> 200, 74 real models spanning DO's own catalog
  //     (llama3.3-70b-instruct, deepseek-v4-pro, glm-5.2, qwen3.5-397b-a17b,
  //     kimi-k2.6, nemotron-3-ultra-550b, gemma-4-31B-it, mistral-3-14B,
  //     openai-gpt-oss-120b/20b, deepseek-r1-distill-llama-70b, ...) PLUS
  //     re-hosted frontier vendor models under DO-flat (hyphenated, not
  //     slash-prefixed) ids: anthropic-claude-5-sonnet, anthropic-claude-
  //     opus-5, anthropic-claude-haiku-4.5, openai-gpt-5.5, openai-gpt-4o,
  //     openai-o3, etc. `owned_by` is NOT uniformly "digitalocean" as the
  //     design-phase docs research assumed — it varies (anthropic, openai,
  //     digitalocean per-model) — but ids stay flat single-namespace
  //     strings, never vendor/model-style routing prefixes, so `gateway`
  //     classification is still not warranted; recorded here as a
  //     correction to the design note for future reference.
  //   - POST /v1/chat/completions (llama3.3-70b-instruct) -> 200, real
  //     content ("pong"), real usage tokens.
  //   - stream:true -> real SSE chat.completion.chunk events, correctly
  //     assembled, ordinary OpenAI shape.
  //   - tools -> a weather-lookup prompt correctly produced
  //     finish_reason:"tool_calls" with the right function name + JSON
  //     arguments.
  //   - response_format:{type:"json_object"} -> 200 with valid, on-topic
  //     JSON content.
  //   - POST /v1/embeddings (bge-m3) -> 200, real float vector.
  //   - glm-5.2 returned a populated `reasoning_content` field distinct
  //     from `content` on a step-by-step arithmetic prompt — genuine
  //     reasoning-model behavior, not name-inferred.
  //   - vision attempted (nemotron-nano-12b-v2-vl, inline base64 image):
  //     the model demonstrably received the image (prompt_tokens jumped
  //     ~10x vs text-only calls) but answered the color prompt WRONG and
  //     with garbled template-leakage tokens — inconclusive, not a clean
  //     confirmation. `vision` deliberately left OFF supports per this
  //     session's evidence bar (contrast with sakana-ai, where vision was
  //     unambiguously correct).
  //   - imageGeneration (stable-diffusion-3.5-large), videoGeneration
  //     (wan2-2-t2v-a14b), textToSpeech (qwen3-tts-voicedesign), and
  //     rerank (bge-reranker-v2-m3) all have real model ids in the live
  //     /v1/models listing but were NOT probed this session — deferred to
  //     a follow-up lot, same minimal-surface-first convention as
  //     sakana-ai/maritaca-ai's initial rows.
  //   - Rate limits (response headers, not docs): X-Ratelimit-Limit/
  //     Remaining/Reset-Requests, plus separate Tokens-Per-Day and
  //     Embedding-Tokens-Per-Minute/Day variants — more granular than the
  //     flat 5000/hr + 250/min the marketing docs describe.
  //   - pricingMode is `none`: no price field anywhere in /v1/models or
  //     chat/completions responses.
  //   - apiKeyEnvVar follows the `<PROVIDER_ID_UPPER>_API_KEY` convention
  //     (DIGITALOCEAN_API_KEY) per Rule 1 in provider-catalog.schema.ts —
  //     DO's own curl examples use `$DIGITALOCEAN_TOKEN`, but that is a doc
  //     convenience string, not an SDK-enforced name, so no override
  //     reason is warranted (same reasoning as maritaca-ai).
  //   - Out of scope, deliberately: the Agent Inference API (separate
  //     per-agent subdomain + `agent_access_key` auth, docs call it
  //     "independent of the main DigitalOcean control-plane API") and the
  //     Billing API (api.digitalocean.com, no inference-cost granularity
  //     documented; per-request usage is already in every chat response's
  //     `usage` object).
  // ──────────────────────────────────────────────────────────────────────────
  {
    providerId: 'digitalocean',
    displayName: 'DigitalOcean Serverless Inference',
    providerFamily: 'digitalocean',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://inference.do-ai.run/v1',
    baseUrlEnvVar: 'DIGITALOCEAN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'DIGITALOCEAN_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      embeddings: true,
      reasoning: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.digitalocean.com/products/inference/',
    notes:
      'Serverless Inference — re-hosts 70+ models (Llama, DeepSeek, Qwen, GLM, Kimi, Gemma, Mistral, Nemotron, plus Anthropic/OpenAI under flat DO ids) via one OpenAI-compatible surface. Live-verified 2026-08-10: /v1/models (74), chat, streaming, tools, jsonMode, /v1/embeddings all real HTTP 200s; glm-5.2 showed real reasoning_content. Vision attempted but inconclusive (wrong answer, garbled) — left off. Image/video/TTS/rerank models exist live but unprobed; deferred.',
    lastReviewedAt: '2026-08-10',
  },

  // ──────────────────────────────────────────────────────────────────────
  // LOTE AC (2026-08-21) — Wafer serverless onboarding.
  //
  // Wafer's pay-as-you-go Serverless surface (docs.wafer.ai/serverless):
  // OpenAI-compatible base URL https://pass.wafer.ai/v1 (POST
  // /v1/chat/completions, GET /v1/models) plus an Anthropic-compatible
  // /v1/messages. Bearer auth. Same conclusion pattern as
  // sakana-ai/maritaca-ai/digitalocean: `oai-compat-pure`, no dedicated
  // adapter — the generic hub adapter covers the chat surface as-is.
  //
  // NOT live-validated this session: the GCP secret `<prefix>-waferai-key` is
  // provisioned but gcloud ADC requires interactive reauth here (same
  // honest pattern as fastrouter LOTE R, pre-promotion). Classified
  // `no-live-validation` in consolidation-matrix.ts. Discovery shape is
  // docs-confirmed: GET /v1/models returns the standard
  // `{object:"list",data:[...]}` shape with two Wafer-specific layers the
  // generic hub fetcher now reads (LOTE AC):
  //   - top-level `max_model_len` (hard context cap) and `zdr_supported`;
  //   - a `wafer` vendor blob per card: `capabilities.{vision,tools,
  //     reasoning}` booleans + `pricing.{input,output,cache_read}_cents_per_
  //     million}` — the fetcher converts cents→USD per 1M and seeds
  //     metadata.capabilities from the booleans (see
  //     openai-compatible-hub-model-fetcher.ts extractVendorExtension).
  //
  // Wire quirks recorded for future execution work (all docs-verified,
  // none blocking the catalog row):
  //   - Streaming: Wafer AUTO-INJECTS stream_options include_usage on
  //     every stream — final SSE chunk always carries usage; no
  //     client-side stream_options needed.
  //   - Tool calls on streams arrive as ONE full tool_calls array in a
  //     single chunk (never argument-by-argument deltas).
  //   - Reasoning defaults OFF on every reasoning-capable model; must be
  //     explicitly enabled (thinking:{type:'enabled'} / reasoning_effort /
  //     enable_thinking). Kimi-K2.7-Code is always-on and rejects forced
  //     tool_choice ("required"/specific function → 400).
  //   - Kimi-K2.6 strips temperature/top_p/n/penalties (Moonshot upstream
  //     enforces fixed sampling).
  //   - Request-scoped ZDR via `Wafer-ZDR: required` header on models
  //     whose card says zdr_supported — deliberately NOT set globally in
  //     the row (non-ZDR models would fail); opt in per-request later.
  //   - Files/Metrics/Usage APIs and tokenized /v1/completions (ebnf/
  //     constrained decoding) exist but are out of scope for the chat
  //     surface — same minimal-surface-first convention as prior lots.
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'wafer',
    displayName: 'Wafer',
    providerFamily: 'wafer',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://pass.wafer.ai/v1',
    baseUrlEnvVar: 'WAFER_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'WAFER_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.wafer.ai/serverless',
    notes:
      'Wafer Serverless (pass.wafer.ai/v1) — first-party hosted models (GLM, Kimi, Qwen) under one OpenAI-compatible surface; also Anthropic-compatible /v1/messages. Model cards carry a `wafer` blob (capabilities + cents/M pricing) the generic hub fetcher reads since LOTE AC. Streaming always includes usage; tool_calls arrive whole in one chunk. Reasoning defaults OFF. ZDR is per-model (Wafer-ZDR header), not global. Not yet live-probed (gcloud ADC expired; <prefix>-waferai-key provisioned).',
    lastReviewedAt: '2026-08-21',
  },

  // ──────────────────────────────────────────────────────────────────────
  // LOTE AD (2026-08-21) — Vivgrid onboarding.
  //
  // Managed Skills platform (Yomo-backed): OpenAI-compatible Model API at
  // https://api.vivgrid.com/v1/chat/completions (Bearer auth) plus hosted
  // function-calling skills, agent eval and observability. Distinctive
  // quirk: chat requests are documented WITHOUT a `model` field — the model
  // is configured per-project in the Vivgrid Console and managed server-
  // side, so switching models needs no code change. The docs' models page
  // publishes a large curated catalog (Claude/GPT/Gemini/DeepSeek/GLM/Kimi/
  // MiniMax + image models) with per-model pricing, context and tool-call
  // capability tables — that static page is the inventory of record here.
  //
  // LOTE AR (2026-09-06) GAP-AK-6 resolution: the 'no machine-readable
  // /models surface' premise above was WRONG. An authenticated probe with
  // the real <prefix>-vivgrid-key secret found GET /v1/models -> 200, a
  // genuine OpenAI-shaped {object:"list",data:[{id,object,created,
  // owned_by}]} body listing real model ids (BAAI/bge-m3, claude-haiku-4-5,
  // claude-opus-4-6/4-7/4-8, ...) — while the same key against a nonsense
  // control path on the same host returns 405. Unauthenticated versions of
  // both still return 401 (confirming the prior blanket-middleware read was
  // correct for a credential-less probe), but with a real key the two paths
  // discriminate cleanly. Promoted execution-only -> discovery+execution;
  // pinnedFallback deleted, same pattern as qianfan (LOTE AL).
  //
  // NOT live-validated end-to-end in THIS environment (no credential
  // entered this session); the promotion rests on a prior session's
  // authenticated probe result (see reports/provider-integration-gap-
  // register.json GAP-AK-6). Also note the separate APP_KEY/APP_SECRET
  // credential pair is for BUILDING/deploying Managed Skills — NOT an
  // inference credential; only the API key surface is wired here. Managed
  // Skills/eval/observability surfaces are out of scope, same minimal-
  // surface-first convention as prior lots.
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'vivgrid',
    displayName: 'Vivgrid',
    providerFamily: 'vivgrid',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.vivgrid.com/v1',
    baseUrlEnvVar: 'VIVGRID_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VIVGRID_API_KEY',
    paths: {
      chatCompletions: '/chat/completions',
    },
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://vivgrid.com/docs/introduction',
    notes:
      'Managed Skills platform (Yomo). OpenAI-compatible Model API; docs\' chat examples pass NO `model` field — model is console-managed per project (switching needs no code change). LOTE AR (2026-09-06): GET /v1/models promoted to live discovery — real OpenAI-list shape confirmed with a real key, 405 on a control path (see GAP-AK-6). Per-model USD pricing still published on the docs models page. APP_KEY/APP_SECRET are for deploying skills, NOT inference.',
    lastReviewedAt: '2026-09-06',
  },

  // ──────────────────────────────────────────────────────────────────────
  // LOTE AE (2026-08-21) — UnoRouter onboarding.
  //
  // Gateway aggregating 200+ models from OpenAI, Anthropic, Google,
  // DeepSeek, Qwen and 50+ other providers behind one OpenAI-compatible
  // endpoint (https://api.unorouter.com/v1, Bearer). Also speaks native
  // Anthropic (ANTHROPIC_BASE_URL) and Gemini CLI protocols on the same
  // host — only the OpenAI surface is wired here.
  //
  // Endpoint existence PROVEN by differential probe (2026-08-21):
  // GET /v1/models → 401 anon, while GET /v1/nonexistent-xyz → 404 — the
  // auth gate is per-route, so the models route exists and needs the key.
  // Response shape not yet observed (needs the key) but docs promise any
  // OpenAI SDK works unchanged → generic hub fetcher.
  //
  // Distinctive semantics: `:free`-suffixed ids (e.g. gpt-oss-120b:free)
  // are FREE-tier routes pinned to free upstream pools that never touch
  // the balance; the bare id is the paid variant. DO NOT strip the suffix
  // when normalizing (same rule as fastrouter\'s :price/:throughput).
  // Group pinning, spend limits, IP allowlists and expiry on keys;
  // automatic failover between provider groups; prompt-cache reads at a
  // discount / cache writes at ~1.25x input.
  //
  // NOT live-validated: gcloud ADC locked this session (<prefix>-unorouter-
  // key provisioned but unfetchable) — no-live-validation bucket.
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'unorouter',
    displayName: 'UnoRouter',
    providerFamily: 'unorouter',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.unorouter.com/v1',
    baseUrlEnvVar: 'UNOROUTER_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'UNOROUTER_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://unorouter.com/pt-BR/docs/platform/quickstart',
    notes:
      'Gateway (200+ models, 50+ upstreams, many free). Model ids carry routing suffixes — `:free` = free-tier pool, bare id = paid; never strip on normalize. Endpoint existence proven by 401-vs-404 differential probe; shape not yet observed (key locked in GCP). Also speaks native Anthropic/Gemini protocols (unwired). Prompt-cache reads discounted, writes ~1.25x.',
    lastReviewedAt: '2026-08-21',
  },

  // ──────────────────────────────────────────────────────────────────────
  // LOTE AF (2026-08-21) — Umans Code onboarding.
  //
  // First-party open-weight serving platform (own GPUs): Anthropic-
  // compatible /v1/messages AND OpenAI-compatible /v1/chat/completions on
  // https://api.code.umans.ai — only the OpenAI surface is wired here
  // (baseUrl includes /v1). Curated lineup (umans-kimi-k3, umans-coder,
  // umans-deepseek-v4-pro-0813, umans-deepseek-v4-flash-0731, umans-flash,
  // umans-kimi-k2.7, umans-glm-5.2) — NOT a gateway; they run the models
  // themselves.
  //
  // DISCOVERY LIVE-CONFIRMED 2026-08-21, unauthenticated: GET /v1/models
  // → 200, standard `{object:"list",data:[{id,object,created,owned_by,
  // context_length,pricing:{input,output}}]}` shape — the generic hub
  // fetcher consumes it as-is (pricing already USD-per-1M floats). A
  // richer public /v1/models/info endpoint (keyed map with deprecation,
  // base_model.provider, capabilities) exists for future enrichment.
  //
  // Reasoning: same knobs on both routes (thinking / reasoning_effort,
  // cross-accepted); umans-kimi-k2.7 ALWAYS thinks; kimi-k3 defaults max
  // but honors "none"; k3 strips temperature/top_p server-side (removed,
  // not rejected). Reasoning streams in `reasoning_content`.
  //
  // Deprecations (docs, sunset dates): umans-kimi-k2.7 → 2026-08-10
  // (ALREADY PAST at onboarding — still listed by /v1/models; expect it
  // to disappear), umans-glm-5.2 → 2026-08-23. Prefer kimi-k3 /
  // deepseek-v4-pro for new routing; pool-builder ranking will age these
  // out naturally once upstream drops them.
  //
  // Execution NOT live-validated (gcloud ADC locked; <prefix>-umans-key
  // provisioned). Web-search header (X-Umans-Websearch-Provider), usage/
  // status APIs out of scope this lot.
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'umans',
    displayName: 'Umans Code',
    providerFamily: 'umans',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.code.umans.ai/v1',
    baseUrlEnvVar: 'UMANS_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'UMANS_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      reasoning: true,
      vision: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://app.umans.ai/offers/code/docs',
    notes:
      'First-party open-weight coder platform (own GPUs; Kimi K3/K2.7, DeepSeek V4, GLM, Qwen-flash aliases). Discovery live-confirmed anon 2026-08-21: /v1/models 200, standard shape with context_length + USD/1M pricing. Also Anthropic-compatible /v1/messages (unwired). kimi-k2.7 always thinks; k3 strips temperature/top_p; sunset: kimi-k2.7 2026-08-10 (past), glm-5.2 2026-08-23. Execution not yet probed (gcloud ADC expired).',
    lastReviewedAt: '2026-08-21',
  },

  // ──────────────────────────────────────────────────────────────────────
  // LOTE AG (2026-08-21) — TrustedRouter onboarding.
  //
  // Attested OpenRouter-compatible gateway ("0 prompt or output logs,
  // always"): https://api.trustedrouter.com/v1 (Bearer <redacted-key-prefix>…),
  // OpenAI + OpenRouter surface (chat/completions, responses, embeddings,
  // videos, GET /v1/models). Fail-closed privacy floors via body
  // `provider.min_privacy: "zdr" | "confidential"` (hard minimum — request
  // fails before inference if no route satisfies it).
  //
  // DISCOVERY LIVE-CONFIRMED 2026-08-21, unauthenticated: GET /v1/models
  // → 200, 559 models, EXACT OpenRouter shape (`{data:[{id,name,
  // context_length,architecture:{input_modalities,output_modalities},
  // pricing:{prompt,completion as per-token USD strings},top_provider}]}`)
  // — the generic hub fetcher already reads this shape (same as openrouter;
  // per-token strings normalize to $/1M). A `trustedrouter` vendor blob
  // carries privacy posture (attested_gateway, ZDR flags, jurisdiction).
  //
  // Model ids are "vendor/model" routing ids plus router presets
  // (trustedrouter/auto, /eu, /socrates*, Synth iris/prometheus/zeus,
  // openpatcher-*) — do NOT strip prefixes; presets are deliberately NOT
  // used (ci does its own selection, same decision as fastrouter/auto).
  // EU regional gateway, Bedrock group-buy, batch API, MCP server and
  // user-listed models are out of scope this lot.
  //
  // Execution NOT live-validated (gcloud ADC locked; <prefix>-trustedrouter-
  // key provisioned).
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'trustedrouter',
    displayName: 'TrustedRouter',
    providerFamily: 'trustedrouter',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.trustedrouter.com/v1',
    baseUrlEnvVar: 'TRUSTEDROUTER_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'TRUSTEDROUTER_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      embeddings: true,
      reasoning: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://trustedrouter.com/docs',
    notes:
      'Attested OpenRouter-compatible gateway (559 models live-confirmed anon 2026-08-21; exact OpenRouter /models shape with per-token USD pricing strings). Fail-closed privacy floors: provider.min_privacy zdr|confidential. ids are vendor/model routing ids + router presets (auto/eu/socrates/Synth) — never strip prefixes; presets unused (ci selects itself). EU gateway + Bedrock group-buy out of scope. Execution not yet probed (gcloud ADC expired).',
    lastReviewedAt: '2026-08-21',
  },

  // ──────────────────────────────────────────────────────────────────────
  // LOTE AH (2026-09-03) — provider-roster reconciliation batch 1.
  //
  // 25 new rows from the operator's provider-expansion roster: hosted
  // OpenAI-compatible platforms (baseten, kilo-gateway, llama, longcat,
  // iflow, modelscope, near-ai, ollama-cloud, regolo, sarvam, stackit,
  // tinfoil, vultr, ovhcloud, crusoe, hetzner, io-intelligence, lilac,
  // kimi-coding) plus China/regional siblings of already-live families
  // (alibaba-cn, moonshot-cn, siliconflow-cn, stepfun-cn, minimax-cn,
  // xiaomi-token-plan) whose wire protocol is identical to the existing
  // canonical row and whose separation is forced by separate account/
  // credential namespaces (documented in LOTE W for siliconflow/stepfun;
  // same vendor pattern for the rest).
  //
  // Onboarding shape follows the wafer precedent (docs-onboarding, honest
  // no-probe classification): baseUrl/auth/paths from the roster + vendor
  // docs (baseten, kilo and meta docs fetched and confirmed this lot;
  // others roster-supplied against their documented OpenAI-compatible
  // surfaces). NO live probe ran this session (terminal execution
  // unavailable) — every row below is classified 'no-live-validation' in
  // consolidation-matrix.ts. Discovery strategy: dynamic GET /models on
  // the documented OpenAI-compatible surface for all rows.
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'baseten',
    displayName: 'Baseten Model APIs',
    providerFamily: 'baseten',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://inference.baseten.co/v1',
    baseUrlEnvVar: 'BASETEN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'BASETEN_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      reasoning: true,
    },
    pricingMode: 'remote',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.baseten.co/inference/model-apis/overview',
    notes:
      'Docs-confirmed 2026-09-03 (fetched): OpenAI Chat Completions at inference.baseten.co/v1, Bearer, GET /v1/models with pricing/context/features metadata. ALL models support tools/structured outputs/JSON mode; reasoning+vision per model (GLM 5.x, DeepSeek, Nemotron families). Vendor/model slugs (zai-org/GLM-5.2) — never strip prefixes. Also beta Anthropic-compatible /v1/messages (unwired). Not yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'kilo-gateway',
    displayName: 'Kilo Gateway',
    providerFamily: 'kilo-gateway',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    baseUrlEnvVar: 'KILO_GATEWAY_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'KILO_GATEWAY_API_KEY',
    originalProviderField: 'provider',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://docs.kilo.ai/gateway',
    notes:
      'Docs-confirmed 2026-09-03 (fetched): universal gateway (500+ models, Anthropic/OpenAI/Google/upstream routers) consumed via the Vercel-AI-SDK OpenAI provider against api.kilo.ai/api/gateway — OpenAI-compatible paths on that base. BYOK + market-rate routing + Kilo Pass token plans. vendor/model routing ids (anthropic/claude-opus-4.8) — never strip. Not yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'llama',
    // LOTE AK (2026-09-04): absorbed the duplicate `meta` row created by
    // LOTE AJ. Both rows described the SAME service (identical displayName
    // and providerFamily) and `meta` pointed at llama.developer.meta.com,
    // which is the docs/console host, not an API host — it blanket-302s every
    // path (including /v1/models and /v1/chat/completions) to
    // ai.developer.meta.com. The real API host answers here.
    aliases: ['llama-api', 'meta', 'meta-ai'],
    displayName: 'Meta Llama API',
    providerFamily: 'meta',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.llama.com/compat/v1',
    baseUrlEnvVar: 'LLAMA_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'LLAMA_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 35,
    docsUrl: 'https://ai.developer.meta.com/',
    notes:
      "Meta's first-party Llama API, OpenAI-compatible at /compat/v1. LOTE AK (2026-09-04) route probe: /compat/v1/models and /v1/models both 401 invalid_api_key (real, auth-gated), while llama.developer.meta.com 302s EVERY path to the ai.developer.meta.com docs site. Absorbed the duplicate `meta` row (aliases llama-api/meta/meta-ai) that pointed at that docs host. Vendor announced a wind-down of this preview (secondary sources); endpoint still answered 2026-09-04.",
    lastReviewedAt: '2026-09-04',
  },
  {
    providerId: 'longcat',
    displayName: 'LongCat AI',
    providerFamily: 'longcat',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.longcat.chat/openai',
    baseUrlEnvVar: 'LONGCAT_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'LONGCAT_API_KEY',
    supports: {
      chat: true,
      streaming: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://longcat.chat/platform/docs/',
    notes:
      'LongCat (Meituan) OpenAI-compatible surface at api.longcat.chat/openai (chat/completions, models; Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'iflow',
    displayName: 'iFlow AI',
    providerFamily: 'iflow',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://apis.iflow.cn/v1',
    baseUrlEnvVar: 'IFLOW_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'IFLOW_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://platform.iflow.cn/en/docs',
    notes:
      'iFlow (China) OpenAI-compatible API at apis.iflow.cn/v1 (Bearer; multi-model gateway incl. Kimi/GLM/DeepSeek/Qwen). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'modelscope',
    displayName: 'ModelScope API-Inference',
    providerFamily: 'modelscope',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    baseUrlEnvVar: 'MODELSCOPE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MODELSCOPE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      embeddings: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://modelscope.cn/docs/model-service/API-Inference/intro',
    notes:
      'Alibaba ModelScope API-Inference (China; distinct from DashScope) — OpenAI-compatible /v1 with Bearer SDK tokens (ms-xxxx). Thousands of community models. Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'near-ai',
    displayName: 'NEAR AI Cloud',
    providerFamily: 'near-ai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://cloud-api.near.ai/v1',
    baseUrlEnvVar: 'NEAR_AI_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'NEAR_AI_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      rerank: true,
      speechToText: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.near.ai/',
    notes:
      'NEAR AI Cloud inference — OpenAI-compatible /v1 (chat/completions, models; Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'ollama-cloud',
    displayName: 'Ollama Cloud',
    providerFamily: 'ollama-cloud',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://ollama.com/v1',
    baseUrlEnvVar: 'OLLAMA_CLOUD_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'OLLAMA_CLOUD_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.ollama.com/cloud',
    notes:
      'Hosted Ollama Cloud (ollama.com/v1, Bearer) — DISTINCT from the self-hosted `ollama` row (localhost:11434): different host, credential-required, managed runtimes. OpenAI-compatible chat/completions + models. Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'regolo',
    displayName: 'Regolo AI',
    providerFamily: 'regolo',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.regolo.ai/v1',
    baseUrlEnvVar: 'REGOLO_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'REGOLO_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      rerank: true,
      speechToText: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.regolo.ai/',
    notes:
      'Regolo AI (EU-hosted) OpenAI-compatible /v1 (chat/completions, embeddings, models; Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'sarvam',
    displayName: 'Sarvam AI',
    providerFamily: 'sarvam',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.sarvam.ai/v1',
    baseUrlEnvVar: 'SARVAM_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SARVAM_API_KEY',
    supports: {
      chat: true,
      speechToText: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
      jsonMode: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.sarvam.ai/api-reference-docs/getting-started/models',
    notes:
      'Sarvam AI (India; Sarvam-2B/1L, Llama, Qwen, Kimi, GLM) — OpenAI-compatible /v1 chat/completions + models (Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'stackit',
    displayName: 'STACKIT AI Model Serving',
    providerFamily: 'stackit',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1',
    baseUrlEnvVar: 'STACKIT_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'STACKIT_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/basics/available-shared-models',
    notes:
      'STACKIT (Schwarz Group, EU/German sovereignty) AI Model Serving shared-tier OpenAI-compatible endpoint (Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'tinfoil',
    displayName: 'Tinfoil',
    providerFamily: 'tinfoil',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://inference.tinfoil.sh/v1',
    baseUrlEnvVar: 'TINFOIL_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'TINFOIL_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      speechToText: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.tinfoil.sh/',
    notes:
      'Tinfoil confidential inference (secure enclaves, attested TLS) — OpenAI-compatible /v1 (chat/completions, models; Bearer). Per-model enclave hosts resolve via tinfoil.sh; the hub uses the default inference host. Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'vultr',
    displayName: 'Vultr Inference',
    providerFamily: 'vultr',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.vultrinference.com/v1',
    baseUrlEnvVar: 'VULTR_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'VULTR_API_KEY',
    supports: {
      chat: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://api.vultrinference.com/',
    notes:
      'Vultr serverless inference — OpenAI-compatible /v1 (chat/completions, embeddings, models; Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'ovhcloud',
    displayName: 'OVHcloud AI Endpoints',
    providerFamily: 'ovhcloud',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    baseUrlEnvVar: 'OVHCLOUD_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'OVHCLOUD_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      speechToText: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/',
    notes:
      'OVHcloud AI Endpoints (EU) — OpenAI-compatible /v1 (chat/completions, embeddings, models; Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'crusoe',
    displayName: 'Crusoe Managed Inference',
    providerFamily: 'crusoe',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.inference.crusoecloud.com/v1',
    baseUrlEnvVar: 'CRUSOE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'CRUSOE_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.crusoecloud.com/managed-inference/overview',
    notes:
      'Crusoe Managed Inference — OpenAI-compatible /v1 (chat/completions, models; Bearer; csk- keys). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'hetzner',
    displayName: 'Hetzner Inference',
    providerFamily: 'hetzner',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://inference.hetzner.com/api/v1',
    baseUrlEnvVar: 'HETZNER_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'HETZNER_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://experiments.hetzner.com/docs/inference',
    notes:
      'Hetzner Inference (experimental; EU) — OpenAI-compatible /api/v1 (chat/completions, models; Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'io-intelligence',
    displayName: 'IO Intelligence',
    providerFamily: 'io-intelligence',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.intelligence.io.solutions/api/v1',
    baseUrlEnvVar: 'IO_INTELLIGENCE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'IO_INTELLIGENCE_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      streaming: true,
      tools: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://io.net/docs/guides/intelligence/io-intelligence',
    notes:
      'io.net IO Intelligence — 200+ hosted models behind an OpenAI-compatible /api/v1 (Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'lilac',
    displayName: 'Lilac',
    providerFamily: 'lilac',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.getlilac.com/v1',
    baseUrlEnvVar: 'LILAC_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'LILAC_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
      reasoning: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.getlilac.com/inference/models',
    notes:
      'Lilac (BYOK inference accelerator; Kimi/GLM/DeepSeek/Qwen families) — OpenAI-compatible /v1 (Bearer). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'kimi-coding',
    displayName: 'Kimi For Coding',
    providerFamily: 'moonshot',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.kimi.com/coding/v1',
    baseUrlEnvVar: 'KIMI_CODING_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'KIMI_CODING_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
    notes:
      'Moonshot Kimi For Coding subscription endpoint (api.kimi.com/coding/v1) — OpenAI-compatible chat/completions (Bearer; kimi-k2.x coding models; separate credential/plan from api.moonshot.ai pay-as-you-go). Base URL roster- and docs-supplied; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'alibaba-cn',
    displayName: 'Alibaba Cloud China (DashScope)',
    providerFamily: 'alibaba',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnvVar: 'DASHSCOPE_CN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ALIBABA_CN_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      rerank: true,
      speechToText: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/models',
    notes:
      'China-domestic DashScope compatible-mode sibling of the intl `alibaba` row — identical OAI wire protocol, separate account/key namespace (same split the repo live-proved for siliconflow/stepfun in LOTE W). NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  // GAP-A10 (LOTE AR, 2026-09-06): derived from MOONSHOT_ENTRY — supports are
  // byte-for-byte identical between the two hosts and no capability-audit
  // finding anywhere flags jsonMode/vision/tools as asymmetric between them
  // (unlike zai-coding-cn). Differences are limited to baseUrl/env-var/
  // pricingMode/priority/docsUrl, all expressed as overrides.
  deriveFromCatalogEntry(MOONSHOT_ENTRY, {
    providerId: 'moonshot-cn',
    displayName: 'Moonshot AI China',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlEnvVar: 'MOONSHOT_CN_BASE_URL',
    apiKeyEnvVar: 'MOONSHOT_CN_API_KEY',
    pricingMode: 'none',
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    notes:
      'China-domestic Moonshot endpoint (api.moonshot.cn) — identical OAI wire protocol to the live `moonshot` row (.ai), separate account/key namespace. A prior probe-target drift against .cn caused a false 401 verdict once before (see consolidation-matrix moonshot note) — always probe the host matching this row\'s key. NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  }),
  {
    providerId: 'siliconflow-cn',
    displayName: 'SiliconFlow China',
    providerFamily: 'siliconflow',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.siliconflow.cn/v1',
    baseUrlEnvVar: 'SILICONFLOW_CN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SILICONFLOW_CN_API_KEY',
    supports: {
      chat: true,
      embeddings: true,
      rerank: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://cloud.siliconflow.cn/models',
    notes:
      'China-domestic SiliconFlow platform (.cn) — LIVE-PROVEN protocol family (LOTE W): .com and .cn are separate platforms with non-interchangeable account/key namespaces; .cn errors with bare-JSON string bodies (quirks class, same as the .com row). Needs its own <prefix>-siliconflow-cn-key. NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'stepfun-cn',
    displayName: 'StepFun China',
    providerFamily: 'stepfun',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.stepfun.com/v1',
    baseUrlEnvVar: 'STEPFUN_CN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'STEPFUN_CN_API_KEY',
    supports: {
      chat: true,
      speechToText: true,
      textToSpeech: true,
      streaming: true,
      tools: true,
      jsonMode: true,
      vision: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://platform.stepfun.com/docs/zh/overview/concept',
    notes:
      'China-domestic StepFun platform (.com — NOTE the inverted mapping vs siliconflow: .com is domestic here, .ai is international; both facts live-probed in LOTE W). Separate account/key namespace from the live `stepfun` (.ai) row. NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  // GAP-A10 (LOTE AR, 2026-09-06): derived from MINIMAX_ENTRY — supports are
  // identical ({chat,streaming,tools,vision}) and no capability-audit finding
  // flags an asymmetry between the two hosts; the CN row's notes add only
  // informational detail (an unwired Anthropic-compatible surface) that does
  // not contradict or narrow the shared supports set.
  deriveFromCatalogEntry(MINIMAX_ENTRY, {
    providerId: 'minimax-cn',
    displayName: 'MiniMax China',
    baseUrl: 'https://api.minimaxi.com/v1',
    baseUrlEnvVar: 'MINIMAX_CN_BASE_URL',
    apiKeyEnvVar: 'MINIMAX_CN_API_KEY',
    pricingMode: 'none',
    docsUrl: 'https://platform.minimaxi.com/docs/guides/quickstart',
    notes:
      'China-domestic MiniMax platform (api.minimaxi.com) — same OAI wire protocol family as the live `minimax` row (api.minimax.io; M-series emits <think> preamble by default), separate account/key namespace. Also exposes an Anthropic-compatible /anthropic/v1 surface on the same host (unwired — OAI surface chosen, same decision as wafer/umans). NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  }),
  {
    providerId: 'xiaomi-token-plan',
    displayName: 'Xiaomi MiMo Token Plan',
    providerFamily: 'xiaomi-mimo',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    baseUrlEnvVar: 'XIAOMI_TOKEN_PLAN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'XIAOMI_TOKEN_PLAN_API_KEY',
    supports: {
      chat: true,
      streaming: true,
      tools: true,
    },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://platform.xiaomimimo.com/',
    notes:
      'Subscription token-plan sibling of `xiaomi-mimo` — same OAI wire protocol on plan-scoped regional hosts: cn token-plan-cn.xiaomimimo.com (default here), Europe token-plan-ams.xiaomimimo.com, Singapore token-plan-sgp.xiaomimimo.com (select via XIAOMI_TOKEN_PLAN_BASE_URL; plan credentials are region-bound). NOT yet live-probed; parent row is balance-blocked (upstream-suspended).',
    lastReviewedAt: '2026-09-03',
  },
  // ──────────────────────────────────────────────────────────────────────
  // LOTE AI (2026-09-03) — provider-roster convergence batch 2.
  //
  // 95 rows closing every remaining programmatically-integrable roster
  // entry: hosted OpenAI-compatible platforms, routers/gateways, China
  // coding/token-plan deployment profiles of already-live families
  // (alibaba/zai/volcano/stepfun/tencent/opencode/kuae/scnet/clinepass),
  // and three self-hosted localhost runtimes (atomic-chat, lynkr,
  // privatemode) mirroring the ollama/lm-studio row shape.
  //
  // All hosted rows: docs-onboarded from the operator roster + vendor
  // docs; NO live probe ran this session (no credentials provisioned) —
  // every row is classified 'no-live-validation' in consolidation-matrix.
  // baseUrlEnvVar overrides are wired so a wrong/stale roster URL can be
  // corrected at runtime without a code change. Self-hosted rows are
  // opt-in local runtimes (authScheme none, apiKeyOptional) and classify
  // as self-hosted-runtime-dependent for discovery compliance.
  // ──────────────────────────────────────────────────────────────────────
  { providerId: 'abacus', displayName: 'Abacus AI RoutellM', providerFamily: 'abacus', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://routellm.abacus.ai/v1', baseUrlEnvVar: 'ABACUS_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ABACUS_API_KEY', supports: { chat: true, speechToText: true, textToSpeech: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://abacus.ai/help/api', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'abliteration', displayName: 'Abliteration.ai', providerFamily: 'abliteration', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.abliteration.ai/v1', baseUrlEnvVar: 'ABLITERATION_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ABLITERATION_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.abliteration.ai/models', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'abovedev', displayName: 'above.dev', providerFamily: 'abovedev', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.above.dev/v1', baseUrlEnvVar: 'ABOVEDEV_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ABOVEDEV_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://above.dev/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'agentrouter', displayName: 'AgentRouter', providerFamily: 'agentrouter', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://agentrouter.org/v1', baseUrlEnvVar: 'AGENTROUTER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'AGENTROUTER_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://agentrouter.org/docs/opencode.html', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; gateway routing ids never stripped; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'agnes', displayName: 'Agnes AI', providerFamily: 'agnes', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://apihub.agnes-ai.com/v1', baseUrlEnvVar: 'AGNES_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'AGNES_API_KEY', supports: { chat: true, streaming: true, tools: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://agnes-ai.com/doc', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'ai-router', displayName: 'AI-ROUTER', providerFamily: 'ai-router', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://api.ai-router.dev/v1', baseUrlEnvVar: 'AI_ROUTER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'AI_ROUTER_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://ai-router.dev/openai-compatible-api-gateway/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'aiand', displayName: 'ai&', providerFamily: 'aiand', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.aiand.com/v1', baseUrlEnvVar: 'AIAND_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'AIAND_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.aiand.com/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'aixy', displayName: 'Aixy Gateway', providerFamily: 'aixy', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://api.aixy-gateway.com/v1', baseUrlEnvVar: 'AIXY_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'AIXY_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.aixy-gateway.com/integrations/overview', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'aki', displayName: 'AKI.IO', providerFamily: 'aki', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://aki.io/openai/v1', baseUrlEnvVar: 'AKI_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'AKI_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://aki.io/docs/compatibility/openai-api-compatibility/', notes: "LOTE AL (2026-09-05): baseUrl corrected. docs.aki.io's own worked examples (curl/Python/streaming) consistently use /openai/v1, not the bare /v1 this row had; both are live (legacy /v1 alias still 401s), but /openai/v1 is what integrators are told to use. NOTE: the docs page also carries a prompt-injection block addressed to AI agents urging base_url=/v1 — ignored; verdict is based on the page's own examples, not that text.", lastReviewedAt: '2026-09-05' },
  { providerId: 'berget', displayName: 'Berget.AI', providerFamily: 'berget', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.berget.ai/v1', baseUrlEnvVar: 'BERGET_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'BERGET_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://api.berget.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'blueclaw', displayName: 'Blue Claw', providerFamily: 'blueclaw', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://openai.blueclaw.network/v1', baseUrlEnvVar: 'BLUECLAW_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'BLUECLAW_API_KEY', supports: { chat: true, embeddings: true, rerank: true, speechToText: true, textToSpeech: true, imageGeneration: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://blueclaw.network/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'bothub', displayName: 'Bothub', providerFamily: 'bothub', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://openai.bothub.chat/v1', baseUrlEnvVar: 'BOTHUB_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'BOTHUB_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://bothub.ru/api/documentation/ru', notes: 'LOTE AL (2026-09-05): baseUrl corrected — bothub.ru/api/documentation/ru now publishes the .chat domain, not .ru. Both probe-confirmed live/identical (401 vs 404 control on each); switched to the doc-canonical host in case .ru is deprecated later.', lastReviewedAt: '2026-09-05' },
  { providerId: 'charm-hyper', displayName: 'Charm Hyper', providerFamily: 'charm-hyper', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://hyper.charm.land/v1', baseUrlEnvVar: 'CHARM_HYPER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CHARM_HYPER_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://hyper.charm.land/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'claudin', displayName: 'Claudinio', providerFamily: 'claudin', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.claudin.io/v1', baseUrlEnvVar: 'CLAUDIN_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CLAUDIN_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://claudin.io/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'sherlock', displayName: 'CloudFerro Sherlock', providerFamily: 'sherlock', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api-sherlock.cloudferro.com/openai/v1', baseUrlEnvVar: 'SHERLOCK_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'SHERLOCK_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.sherlock.cloudferro.com/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; EU sovereign platform; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'coralbricks', displayName: 'CoralBricks', providerFamily: 'coralbricks', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://inference.coralbricks.ai/v1', baseUrlEnvVar: 'CORALBRICKS_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CORALBRICKS_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.coralbricks.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'cortecs', displayName: 'Cortecs', providerFamily: 'cortecs', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.cortecs.ai/v1', baseUrlEnvVar: 'CORTECS_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CORTECS_API_KEY', supports: { chat: true, embeddings: true, streaming: true, tools: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://api.cortecs.ai/v1/models', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'crofai', displayName: 'CrofAI', providerFamily: 'crofai', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://crof.ai/v1', baseUrlEnvVar: 'CROFAI_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CROFAI_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://crof.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'crossmodel', displayName: 'CrossModel', providerFamily: 'crossmodel', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.crossmodel.ai/v1', baseUrlEnvVar: 'CROSSMODEL_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CROSSMODEL_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.crossmodel.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'drun', displayName: 'D.Run', providerFamily: 'drun', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://chat.d.run/v1', baseUrlEnvVar: 'DRUN_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'DRUN_API_KEY', supports: { chat: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.d.run/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'daoxe', displayName: 'DaoXE', providerFamily: 'daoxe', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://daoxe.com/v1', baseUrlEnvVar: 'DAOXE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'DAOXE_API_KEY', supports: { chat: true, embeddings: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://daoxe.com/pricing', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'dinference', displayName: 'DInference', providerFamily: 'dinference', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.dinference.com/v1', baseUrlEnvVar: 'DINFERENCE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'DINFERENCE_API_KEY', supports: { chat: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://dinference.com/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'echo', displayName: 'Echo (TracerML)', providerFamily: 'echo', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://echo.tracerml.ai/v1', baseUrlEnvVar: 'ECHO_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ECHO_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://echo.tracerml.ai/docs/api', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'evroc', displayName: 'evroc Think', providerFamily: 'evroc', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://models.think.evroc.com/v1', baseUrlEnvVar: 'EVROC_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'EVROC_API_KEY', supports: { chat: true, embeddings: true, speechToText: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.evroc.com/products/think/overview.html', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; EU sovereign cloud; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'freemodel', displayName: 'FreeModel', providerFamily: 'freemodel', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.freemodel.dev/v1', baseUrlEnvVar: 'FREEMODEL_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'FREEMODEL_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://freemodel.dev/', notes: 'LOTE AL (2026-09-05): baseUrl corrected to the officially-documented host (Python SDK snippet on freemodel.dev uses api.freemodel.dev). The old cc.freemodel.dev is also live but serves a DIFFERENT model catalog — not just an alias; keep FREEMODEL_BASE_URL available if cc. is what an account was actually issued.', lastReviewedAt: '2026-09-05' },
  { providerId: 'frogbot', displayName: 'FrogBot', providerFamily: 'frogbot', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://app.frogbot.ai/api/v1', baseUrlEnvVar: 'FROGBOT_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'FROGBOT_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.frogbot.ai/', notes: "LOTE AL (2026-09-05) FLAG: docs.frogbot.ai describes an OPEN-SOURCE SELF-HOSTED agent framework, not a hosted API. LOTE AR (2026-09-06) sharpened, not resolved: /api/v1/* is a REAL, LIVE, blanket-auth-gated namespace (401 on both /models and a control path) — same inconclusive-auth-first-middleware shape as replicate/vivgrid/runwayml/topaz; the SPA-shell-everywhere read only held OUTSIDE /api/v1. No credential exists in GCP. See GAP-AR-1; catalog-fit is still an operator call.", lastReviewedAt: '2026-09-06' },
  { providerId: 'greenpt', displayName: 'GreenPT', providerFamily: 'greenpt', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.greenpt.ai/v1', baseUrlEnvVar: 'GREENPT_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'GREENPT_API_KEY', supports: { chat: true, embeddings: true, rerank: true, speechToText: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.greenpt.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'hpcai', displayName: 'HPC-AI', providerFamily: 'hpcai', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.hpc-ai.com/inference/v1', baseUrlEnvVar: 'HPCAI_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'HPCAI_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.hpc-ai.com/doc/docs/quickstart/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'impossibl', displayName: 'Impossibl', providerFamily: 'impossibl', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.impossibl.com/v1', baseUrlEnvVar: 'IMPOSSIBL_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'IMPOSSIBL_API_KEY', supports: { chat: true, embeddings: true, speechToText: true, textToSpeech: true, streaming: true, tools: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://impossibl.com/docs/models', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'inceptron', displayName: 'Inceptron', providerFamily: 'inceptron', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.inceptron.io/v1', baseUrlEnvVar: 'INCEPTRON_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'INCEPTRON_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.inceptron.io/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'inference-net', displayName: 'Inference.net', providerFamily: 'inference-net', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.inference.net/v1', baseUrlEnvVar: 'INFERENCE_NET_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'INFERENCE_NET_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.inference.net/api/api-quickstart', notes: 'LOTE AL (2026-09-05): baseUrl was WRONG, not merely unverified — inference.net (no api. subdomain) is just the marketing site (301-redirect loop on both a real and a control path, no real API there). docs.inference.net confirms api.inference.net/v1; probe-confirmed 200 on /models, structured 400 on an invalid control path.', lastReviewedAt: '2026-09-05' },
  { providerId: 'inferx', displayName: 'InferX', providerFamily: 'inferx', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://model.inferx.net/v1', baseUrlEnvVar: 'INFERX_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'INFERX_API_KEY', supports: { chat: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://inferx.net/docs/quickstart', notes: "LOTE AL (2026-09-05): baseUrl aligned to inferx.net/docs's official client example (/v1, no /endpoints segment); both shapes probe-identically (401 'no tenant context'). Docs explicitly warn production URLs are TENANT-SCOPED — INFERX_BASE_URL override is the real fix, not just the path.", lastReviewedAt: '2026-09-05' },
  { providerId: 'iteracompute', displayName: 'IteraCompute', providerFamily: 'iteracompute', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.iteracompute.com/v1', baseUrlEnvVar: 'ITERACOMPUTE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ITERACOMPUTE_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://iteracompute.com/docs.html', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'jalapeno', displayName: 'Jalapeno Cloud', providerFamily: 'jalapeno', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.jalapeno-cloud.ai/v1', baseUrlEnvVar: 'JALAPENO_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'JALAPENO_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.jalapeno-cloud.ai/docs/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'jieko', 'displayName': 'Jiekou.AI', providerFamily: 'jieko', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.jiekou.ai/openai', baseUrlEnvVar: 'JIEKO_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'JIEKO_API_KEY', supports: { chat: true, embeddings: true, rerank: true, speechToText: true, textToSpeech: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.jiekou.ai/docs/support/quickstart', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'kenari', displayName: 'kKenari', providerFamily: 'kenari', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://kenari.id/v1', baseUrlEnvVar: 'KENARI_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'KENARI_API_KEY', supports: { chat: true, embeddings: true, rerank: true, speechToText: true, textToSpeech: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://kenari.id/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'klok', displayName: 'klokintegration.se', providerFamily: 'klok', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api-gw.klok.ipaas.se/proxy/kloker-key/v1', baseUrlEnvVar: 'KLOK_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'KLOK_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://klokintegration.se/docs/ai-api', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; key-in-path proxy URL — never log full URL; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'kosmik', displayName: 'Kosmik Compute', providerFamily: 'kosmik', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.koscompute.com/v1', baseUrlEnvVar: 'KOSMIK_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'KOSMIK_API_KEY', supports: { chat: true, speechToText: true, textToSpeech: true, streaming: true, tools: true, jsonMode: true, vision: true, reasoning: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://api.koscompute.com/docs/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'llmtech', displayName: 'LLM Tech', providerFamily: 'llmtech', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.llmtech.eu/v1', baseUrlEnvVar: 'LLMTECH_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'LLMTECH_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://llmtech.eu/models/qwen3.8-27b', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'llmtr', displayName: 'LLMTR', providerFamily: 'llmtr', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://llmtr.com/v1', baseUrlEnvVar: 'LLMTR_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'LLMTR_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://llmtr.com/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'lucidquery', displayName: 'LucidQuery', providerFamily: 'lucidquery', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.lucidquery.com/v1', baseUrlEnvVar: 'LUCIDQUERY_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'LUCIDQUERY_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://lucidquery.com/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'meganova', displayName: 'Meganova', providerFamily: 'meganova', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.meganova.ai/v1', baseUrlEnvVar: 'MEGANOVA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'MEGANOVA_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.meganova.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'mixlayer', displayName: 'Mixlayer', providerFamily: 'mixlayer', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://models.mixlayer.ai/v1', baseUrlEnvVar: 'MIXLAYER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'MIXLAYER_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.mixlayer.com/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'moark', displayName: 'Moark', providerFamily: 'moark', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://moark.com/v1', baseUrlEnvVar: 'MOARK_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'MOARK_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://moark.com/docs/openapi/v1', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'modeloracle', displayName: 'Model Oracle AI', providerFamily: 'modeloracle', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.modeloracle.com/api/v1', baseUrlEnvVar: 'MODELORACLE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'MODELORACLE_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://modeloracle.com/setup/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'modelis', displayName: 'Modelis', providerFamily: 'modelis', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://modelishub.com/v1', baseUrlEnvVar: 'MODELIS_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'MODELIS_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://modelishub.com/pricing', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'neosmith', displayName: 'NeoSmith', providerFamily: 'neosmith', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://router.neosmith.ai/v1', baseUrlEnvVar: 'NEOSMITH_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'NEOSMITH_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://neosmith.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'neuralwatt', displayName: 'Neuralwatt', providerFamily: 'neuralwatt', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.neuralwatt.com/v1', baseUrlEnvVar: 'NEURALWATT_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'NEURALWATT_API_KEY', supports: { chat: true, embeddings: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://portal.neuralwatt.com/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'nova', displayName: 'Amazon Nova API', providerFamily: 'nova', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.nova.amazon.com/v1', baseUrlEnvVar: 'NOVA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'NOVA_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://nova.amazon.com/dev/documentation', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; distinct service/credential surface from aws-bedrock; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'ofox', displayName: 'Ofox', providerFamily: 'ofox', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.ofox.ai/v1', baseUrlEnvVar: 'OFOX_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'OFOX_API_KEY', supports: { chat: true, embeddings: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://ofox.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'openreason', displayName: 'OpenReason', providerFamily: 'openreason', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.openreason.app/v1', baseUrlEnvVar: 'OPENREASON_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'OPENREASON_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://openreason.app/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'opper', displayName: 'Opper', providerFamily: 'opper', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.opper.ai/v3/compat', baseUrlEnvVar: 'OPPER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'OPPER_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://opper.ai/models', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'orcarouter', displayName: 'OrcaRouter', providerFamily: 'orcarouter', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://api.orcarouter.ai/v1', baseUrlEnvVar: 'ORCAROUTER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ORCAROUTER_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.orcarouter.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'pendra', displayName: 'Pendra', providerFamily: 'pendra', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.pendra.ai/api/v1', baseUrlEnvVar: 'PENDRA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'PENDRA_API_KEY', supports: { chat: true, embeddings: true, rerank: true, speechToText: true, textToSpeech: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://pendra.ai/docs/integrations/opencode', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'pioneer', displayName: 'Pioneer', providerFamily: 'pioneer', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.pioneer.ai/v1', baseUrlEnvVar: 'PIONEER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'PIONEER_API_KEY', supports: { chat: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://agent.pioneer.ai/llms.txt', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'poolside', displayName: 'Poolside', providerFamily: 'poolside', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://inference.poolside.ai/v1', baseUrlEnvVar: 'POOLSIDE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'POOLSIDE_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://platform.poolside.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'qihang', displayName: 'QiHang', providerFamily: 'qihang', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.qhaigc.net/v1', baseUrlEnvVar: 'QIHANG_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'QIHANG_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.qhaigc.net/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'qiniu', displayName: 'Qiniu AIToken', providerFamily: 'qiniu', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.qnaigc.com/v1', baseUrlEnvVar: 'QINIU_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'QINIU_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://developer.qiniu.com/aitokenapi', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'routingrun', displayName: 'routing.run', providerFamily: 'routingrun', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://api.routing.run/v1', baseUrlEnvVar: 'ROUTINGRUN_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ROUTINGRUN_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.routing.run/api-reference/models', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'runinfra', displayName: 'RunInfra', providerFamily: 'runinfra', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.runinfra.ai/v1', baseUrlEnvVar: 'RUNINFRA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'RUNINFRA_API_KEY', supports: { chat: true, responses: true, embeddings: true, rerank: true, speechToText: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://runinfra.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'scx', displayName: 'SCX.ai', providerFamily: 'scx', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.scx.ai/v1', baseUrlEnvVar: 'SCX_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'SCX_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://platform.scx.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'sensenova', displayName: 'SenseNova', providerFamily: 'sensenova', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://token.sensenova.cn/v1', baseUrlEnvVar: 'SENSENOVA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'SENSENOVA_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://platform.sensenova.cn/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'standardcompute', displayName: 'Standard Compute', providerFamily: 'standardcompute', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.stdcmpt.com/v1', baseUrlEnvVar: 'STANDARDCOMPUTE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'STANDARDCOMPUTE_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://standardcompute.com/models', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'subconscious', displayName: 'Subconscious', providerFamily: 'subconscious', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.subconscious.dev/v1', baseUrlEnvVar: 'SUBCONSCIOUS_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'SUBCONSCIOUS_API_KEY', supports: { chat: true, streaming: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.subconscious.dev/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'submodel', displayName: 'submodel', providerFamily: 'submodel', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://llm.submodel.ai/v1', baseUrlEnvVar: 'SUBMODEL_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'SUBMODEL_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://submodel.gitbook.io/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'tensorx', displayName: 'TensorX', providerFamily: 'tensorx', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.tensorx.ai/v1', baseUrlEnvVar: 'TENSORX_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'TENSORX_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.tensorx.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'thegrid', displayName: 'The Grid AI', providerFamily: 'thegrid', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.thegrid.ai/v1', baseUrlEnvVar: 'THEGRID_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'THEGRID_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://thegrid.ai/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'tokengo', displayName: 'TokenGo', providerFamily: 'tokengo', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.tokengo.com/v1', baseUrlEnvVar: 'TOKENGO_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'TOKENGO_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.tokengo.com/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'tokenrouter', displayName: 'TokenRouter', providerFamily: 'tokenrouter', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://api.tokenrouter.com/v1', baseUrlEnvVar: 'TOKENROUTER_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'TOKENROUTER_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.tokenrouter.com/docs/tokenrouter-feature-guide/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'vancine', displayName: 'Vancine', providerFamily: 'vancine', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://vancine.com/v1', baseUrlEnvVar: 'VANCINE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'VANCINE_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://vancine.com/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'xpersona', displayName: 'Xpersona', providerFamily: 'xpersona', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://www.xpersona.co/v1', baseUrlEnvVar: 'XPERSONA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'XPERSONA_API_KEY', supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.xpersona.co/docs', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'zeldoc', displayName: 'Zeldoc', providerFamily: 'zeldoc', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.zeldoc.ai/v1', baseUrlEnvVar: 'ZELDOC_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ZELDOC_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.zeldoc.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'zenifra', displayName: 'Zenifra', providerFamily: 'zenifra', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://ai.zenifra.com/v1', baseUrlEnvVar: 'ZENIFRA_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ZENIFRA_API_KEY', supports: { chat: true, streaming: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.zenifra.com/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'zenmux', displayName: 'ZenMux', providerFamily: 'zenmux', integrationClass: 'gateway', integrationMode: 'discovery+execution', baseUrl: 'https://zenmux.ai/api/v1', baseUrlEnvVar: 'ZENMUX_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ZENMUX_API_KEY', supports: { chat: true, embeddings: true, rerank: true, streaming: true, tools: true, jsonMode: true, vision: true, reasoning: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.zenmux.ai/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; gateway routing ids never stripped; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'clarifai', displayName: 'Clarifai', providerFamily: 'clarifai', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.clarifai.com/v2/ext/openai/v1', baseUrlEnvVar: 'CLARIFAI_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CLARIFAI_API_KEY', supports: { chat: true, streaming: true, tools: true, embeddings: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.clarifai.com/compute/inference/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; /v2/ext/openai OAI extension surface; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  // ── LOTE AI — plan/profile rows of live families ─────────────────────
  OPENCODE_ZEN_ENTRY,
  // GAP-A10 (LOTE AR, 2026-09-06): derived from OPENCODE_ZEN_ENTRY — both
  // plain object literals with identical supports/integrationClass/pricing/
  // priority/docsUrl; opencode-go's own notes already documented the
  // parent/child relationship in prose. provider-integration-evidence.json
  // shows both rows probed 2026-09-04 with the same verdict, no asymmetry.
  deriveFromCatalogEntry(OPENCODE_ZEN_ENTRY, {
    providerId: 'opencode-go',
    displayName: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    baseUrlEnvVar: 'OPENCODE_GO_BASE_URL',
    apiKeyEnvVar: 'OPENCODE_GO_API_KEY',
    notes: 'LOTE AI (2026-09-03); Go plan deployment profile of OpenCode Zen (same family, plan-bound credential); NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  }),
  { providerId: 'kuae', displayName: 'KUAE Cloud Coding Plan', providerFamily: 'kuae', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://coding-plan-endpoint.kuaecloud.net/v1', baseUrlEnvVar: 'KUAE_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'KUAE_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.mthreads.com/kuaecloud/kuaecloud-doc-online/coding_plan/', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; Moore Threads KUAE coding-plan endpoint; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'scnet', displayName: 'SCNet Token Plan', providerFamily: 'scnet', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.scnet.cn/api/llm/v1', baseUrlEnvVar: 'SCNET_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'SCNET_API_KEY', supports: { chat: true, embeddings: true, textToSpeech: true, streaming: true, tools: true, jsonMode: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/plans/token-plan.html', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'clinepass', displayName: 'ClinePass', providerFamily: 'clinepass', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.cline.bot/api/v1', baseUrlEnvVar: 'CLINEPASS_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'CLINEPASS_API_KEY', supports: { chat: true, streaming: true, tools: true, vision: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://docs.cline.bot/getting-started/clinepass', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; subscription plan credential, distinct from github-models; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'tencent-coding', displayName: 'Tencent Coding Plan', providerFamily: 'tencent', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3', baseUrlEnvVar: 'TENCENT_CODING_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'TENCENT_CODING_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://cloud.tencent.com/document/product/1772/128947', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; plan-bound credential; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'tencent-plan', displayName: 'Tencent Token Plan', providerFamily: 'tencent', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3', baseUrlEnvVar: 'TENCENT_PLAN_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'TENCENT_PLAN_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://cloud.tencent.com/document/product/1823/130060', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'tencent-tokenhub', displayName: 'Tencent TokenHub', providerFamily: 'tencent', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://tokenhub.tencentmaas.com/v1', baseUrlEnvVar: 'TENCENT_TOKENHUB_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'TENCENT_TOKENHUB_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://cloud.tencent.com/document/product/1823/130050', notes: 'LOTE AI (2026-09-03) roster+docs onboarding; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  ALIBABA_CODING_ENTRY,
  // GAP-A10 POC (LOTE AM, 2026-09-05): derived from ALIBABA_CODING_ENTRY —
  // identical protocol/supports/pricing, differs only in host + credential.
  deriveFromCatalogEntry(ALIBABA_CODING_ENTRY, {
    providerId: 'alibaba-coding-cn',
    displayName: 'Alibaba Coding Plan China',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    baseUrlEnvVar: 'ALIBABA_CODING_CN_BASE_URL',
    apiKeyEnvVar: 'ALIBABA_CODING_CN_API_KEY',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    notes: 'LOTE AI (2026-09-03); China coding-plan profile of alibaba family; NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  }),
  { providerId: 'alibaba-token-plan', displayName: 'Alibaba Token Plan', providerFamily: 'alibaba', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', baseUrlEnvVar: 'ALIBABA_TOKEN_PLAN_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ALIBABA_TOKEN_PLAN_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/token-plan-overview', notes: 'LOTE AI (2026-09-03); token-plan deployment profile of alibaba family; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  { providerId: 'alibaba-token-plan-cn', displayName: 'Alibaba Token Plan China', providerFamily: 'alibaba', integrationClass: 'oai-compat-pure', integrationMode: 'discovery+execution', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', baseUrlEnvVar: 'ALIBABA_TOKEN_PLAN_CN_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'ALIBABA_TOKEN_PLAN_CN_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.alibabacloud.com/help/zh/model-studio/token-plan-overview', notes: 'LOTE AI (2026-09-03); China token-plan profile of alibaba family; NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  ZAI_CODING_ENTRY,
  // zai-coding-cn is kept as an independent full row rather than derived from
  // ZAI_CODING_ENTRY: the LOTE AM capability audit found the two hosts'
  // jsonMode evidence to be asymmetric (a MEDIUM-confidence underclaim on the
  // intl host, not confirmed at all for this CN host) — exactly the kind of
  // quiet capability drift `basedOn` inheritance could otherwise paper over
  // if a future edit added jsonMode to the parent. See ZAI_CODING_ENTRY's
  // notes for the underclaim detail.
  {
    providerId: 'zai-coding-cn',
    displayName: 'Zhipu AI Coding Plan',
    providerFamily: 'zai',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    baseUrlEnvVar: 'ZAI_CODING_CN_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ZAI_CODING_CN_API_KEY',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    notes:
      'LOTE AI (2026-09-03); coding-plan profile of zai family (open.bigmodel.cn host); NOT yet live-probed. LOTE AM (2026-09-05) capability audit, HIGH confidence, no discrepancy: chat/streaming/tools all confirmed against this host\'s own docs, nothing to add.',
    lastReviewedAt: '2026-09-05',
  },
  { providerId: 'volcano-coding', displayName: 'Volcengine Ark Coding Plan', providerFamily: 'volcano', integrationClass: 'oai-compat-quirks', integrationMode: 'discovery+execution', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', baseUrlEnvVar: 'VOLCANO_CODING_BASE_URL', authScheme: 'bearer', apiKeyEnvVar: 'VOLCANO_CODING_API_KEY', supports: { chat: true, streaming: true, tools: true }, pricingMode: 'none', enabledByDefault: true, priority: 30, docsUrl: 'https://www.volcengine.com/docs/82379/1928261', notes: 'LOTE AI (2026-09-03); coding-plan profile of volcano family (same Ark quirks family); NOT yet live-probed.', lastReviewedAt: '2026-09-03' },
  STEPFUN_STEP_PLAN_ENTRY,
  // GAP-A10 POC (LOTE AM, 2026-09-05): derived from STEPFUN_STEP_PLAN_ENTRY —
  // identical protocol/supports/pricing, differs only in host + credential.
  deriveFromCatalogEntry(STEPFUN_STEP_PLAN_ENTRY, {
    providerId: 'stepfun-step-plan-cn',
    displayName: 'StepFun Step Plan China',
    baseUrl: 'https://api.stepfun.com/step_plan/v1',
    baseUrlEnvVar: 'STEPFUN_STEP_PLAN_CN_BASE_URL',
    apiKeyEnvVar: 'STEPFUN_STEP_PLAN_CN_API_KEY',
    docsUrl: 'https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api',
    notes: 'LOTE AI (2026-09-03); step-plan profile of stepfun family (China host); NOT yet live-probed.',
    lastReviewedAt: '2026-09-03',
  }),
  // ── LOTE AI — self-hosted localhost runtimes (mirror ollama shape) ────
  {
    providerId: 'atomic-chat',
    displayName: 'Atomic Chat (Local)',
    providerFamily: 'atomic-chat',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://127.0.0.1:1337/v1',
    baseUrlEnvVar: 'ATOMIC_CHAT_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'ATOMIC_CHAT_API_KEY',
    apiKeyOptional: true,
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://atomic.chat/',
    notes: 'Self-hosted local runtime (LOTE AI 2026-09-03). Opt-in via ATOMIC_CHAT_URL; unreachable-from-CI is a missing local runtime, not an upstream outage.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'lynkr',
    displayName: 'Lynkr (Local)',
    providerFamily: 'lynkr',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://127.0.0.1:8081/v1',
    baseUrlEnvVar: 'LYNKR_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'LYNKR_API_KEY',
    apiKeyOptional: true,
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://github.com/Fast-Editor/Lynkr',
    notes: 'Self-hosted local runtime (LOTE AI 2026-09-03). Opt-in via LYNKR_URL; same semantics as atomic-chat.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'privatemode',
    displayName: 'Privatemode AI (Local)',
    providerFamily: 'privatemode',
    integrationClass: 'self-hosted-oai-compat',
    integrationMode: 'discovery+execution',
    baseUrl: 'http://localhost:8080/v1',
    baseUrlEnvVar: 'PRIVATEMODE_URL',
    authScheme: 'none',
    apiKeyEnvVar: 'PRIVATEMODE_API_KEY',
    apiKeyOptional: true,
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 10,
    docsUrl: 'https://docs.privatemode.ai/api/overview',
    notes: 'Self-hosted confidential gateway runtime (LOTE AI 2026-09-03). Opt-in via PRIVATEMODE_URL; same semantics as atomic-chat.',
    lastReviewedAt: '2026-09-03',
  },
  // ──────────────────────────────────────────────────────────────────────
  // LOTE AJ (2026-09-03) — false-NPI reopenings + research verdicts.
  //
  // 12 rows closing the falsely-classified NOT_PROGRAMMATICALLY_INTEGRABLE
  // set (account/product/deployment-scoped != non-integrable), the
  // GAP-A9-blocked rows (premise obsolete: OAI-compat surfaces verified),
  // and the research-verdict IMPLEMENT rows from the unresolved list.
  // All rows: docs-onboarded 2026-09-03; NO live probe ran (no credentials).
  // execution-only rows carry NO model inventory (zero-hardcode policy) —
  // discovery is unavailable-upstream or operator-validated for those.
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'cloudflare-ai-gateway',
    displayName: 'Cloudflare AI Gateway',
    providerFamily: 'cloudflare-ai-gateway',
    integrationClass: 'gateway',
    integrationMode: 'execution-only',
    baseUrl: 'https://gateway.ai.cloudflare.com/v1',
    baseUrlEnvVar: 'CLOUDFLARE_AI_GATEWAY_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'CLOUDFLARE_AI_GATEWAY_API_KEY',
    discoveryStatus: 'unavailable-upstream',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://developers.cloudflare.com/ai-gateway/',
    notes:
      'LOTE AJ (2026-09-03): reopened false NPI classification (account-scoped is not non-integrable). Docs-verified: set CLOUDFLARE_AI_GATEWAY_BASE_URL to https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat (OpenAI SDK baseURL); alternative REST surface api.cloudflare.com/client/v4/accounts/{account}/ai/v1. No gateway model-list endpoint documented -> execution-only, no fabricated inventory. Universal endpoint deprecated. NOT live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'merge',
    aliases: ['merge-gateway', 'mergegateway'],
    displayName: 'Merge Gateway',
    providerFamily: 'merge',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api-gateway.merge.dev/v1',
    baseUrlEnvVar: 'MERGE_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MERGE_API_KEY',
    originalProviderField: 'vendor',
    supports: { chat: true, embeddings: true, streaming: true, tools: true, jsonMode: true, vision: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.merge.dev/merge-gateway/',
    notes:
      'LOTE AJ (2026-09-03): reopened false NPI classification (/ai-sdk surface is not non-integrability). Docs-verified: GET /v1/models + /v1/vendors (cursor pagination, limit<=500), OAI-compat POST /v1/chat/completions with BARE model names; native /responses shape differs from OpenAI Responses (point SDKs at /v1/openai); Anthropic-compat /messages; attribution via top-level vendor field + x-merge-vendor header. NOT live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'infomaniak',
    displayName: 'Infomaniak AI Tools',
    providerFamily: 'infomaniak',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    // LOTE AK (2026-09-04): host CORRECTED. `api.ai.infomaniak.com` does not
    // resolve at all (DNS failure, not a 404) — the row would have died at
    // boot with a network error rather than a clean auth error. The real
    // surface is product-scoped on the main API host, probe-confirmed:
    //   GET /2/ai/1/openai/v1/models            → 401 authentication_error
    //   GET /2/ai/1/openai/v1/zzz-control-probe → 404 not_found_error
    // `{product_id}` follows the azure-openai / databricks precedent for
    // account-scoped path segments. LOTE AM (2026-09-05, GAP-A11): resolved
    // automatically now via baseUrlTemplateVars + INFOMANIAK_PRODUCT_ID —
    // the operator no longer has to reconstruct the whole URL by hand.
    // INFOMANIAK_BASE_URL is kept as a full-string override for anyone who
    // still prefers it (or needs to bypass templating entirely); it wins
    // over the template when set, per resolveBaseUrl()'s resolution order.
    baseUrl: 'https://api.infomaniak.com/2/ai/{product_id}/openai/v1',
    baseUrlEnvVar: 'INFOMANIAK_BASE_URL',
    baseUrlTemplateVars: { product_id: 'INFOMANIAK_PRODUCT_ID' },
    authScheme: 'bearer',
    apiKeyEnvVar: 'INFOMANIAK_API_KEY',
    supports: { chat: true, streaming: true, tools: true, embeddings: true, jsonMode: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://developer.infomaniak.com/docs/api/get/2/ai/%7Bproduct_id%7D/openai/v1/models',
    notes:
      'Product-scoped OAI-compat surface (deployment param, not a non-integrability). LOTE AK: host corrected — api.ai.infomaniak.com does NOT resolve; real base is api.infomaniak.com/2/ai/{product_id}/openai/v1 (401 vs 404 control). LOTE AM (GAP-A11): {product_id} now resolves via baseUrlTemplateVars — set INFOMANIAK_PRODUCT_ID. Capability audit HIGH: jsonMode added (response_format documented on this endpoint\'s OpenAPI spec). Not probed with a real key.',
    lastReviewedAt: '2026-09-05',
  },
  {
    providerId: 'tinker',
    aliases: ['thinking-machines', 'thinkingmachines'],
    displayName: 'Thinking Machines Tinker',
    providerFamily: 'tinker',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'execution-only',
    baseUrl: 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1',
    baseUrlEnvVar: 'TINKER_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'TINKER_API_KEY',
    discoveryStatus: 'unavailable-upstream',
    supports: { chat: true, streaming: true, reasoning: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/openai/',
    notes:
      'LOTE AJ (2026-09-03): GAP-A9 premise obsolete - OAI-compat chat/completions surface exists (docs-verified). UPSTREAM_BETA: vendor labels the compat APIs beta/internal-use - NOT production-certifiable while beta. Quirks: separate_reasoning (default true), reasoning_effort. No HTTP model list (checkpoints via SDK/CLI only) -> execution-only, zero inventory; models enter via operator-validated/execution-observed discovery. Anthropic-compat surface also exists. NOT live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  MINIMAX_TOKEN_PLAN_ENTRY,
  // GAP-A10 POC (LOTE AM, 2026-09-05): derived from MINIMAX_TOKEN_PLAN_ENTRY,
  // with a `supports` override — the capability audit found HIGH-confidence
  // vision evidence for THIS host specifically (platform.minimaxi.com's own
  // chat-completions reference documents image_url content parts) that does
  // not carry the same confidence for the parent's host, so it is declared
  // explicitly here rather than inherited.
  deriveFromCatalogEntry(MINIMAX_TOKEN_PLAN_ENTRY, {
    providerId: 'minimax-token-plan-cn',
    displayName: 'MiniMax Token Plan China',
    baseUrl: 'https://api.minimax.cn/v1',
    baseUrlEnvVar: 'MINIMAX_TOKEN_PLAN_CN_BASE_URL',
    apiKeyEnvVar: 'MINIMAX_TOKEN_PLAN_CN_API_KEY',
    supports: { chat: true, streaming: true, tools: true, vision: true },
    docsUrl: 'https://platform.minimaxi.com/docs/token-plan/intro',
    notes:
      'LOTE AJ: China Token Plan host api.minimax.cn per current docs (PAYG minimax-cn row still targets api.minimaxi.com — deliberate). sk-cp-* key not interchangeable with PAYG keys. NOT live-probed. LOTE AM capability audit, HIGH: vision added — platform.minimaxi.com\'s own chat-completions reference documents image_url content parts (MiniMax-M3) for this host.',
    lastReviewedAt: '2026-09-05',
  }),
  {
    providerId: 'llmgateway',
    aliases: ['llm-gateway', 'devpass', 'devpass-llm-gateway'],
    displayName: 'LLM Gateway',
    providerFamily: 'llmgateway',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    // LOTE AK (2026-09-04): TLD CORRECTED, .net → .io. `api.llmgateway.net`
    // does not resolve (DNS failure) — the row was dead on arrival. The
    // session's own evidence file already named api.llmgateway.io; the
    // catalog had drifted from it. Probe: GET https://api.llmgateway.io/v1/models
    // → 200 PUBLIC with a real OpenAI-shaped list (architecture/modalities
    // metadata included).
    baseUrl: 'https://api.llmgateway.io/v1',
    baseUrlEnvVar: 'LLMGATEWAY_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'LLMGATEWAY_API_KEY',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://llmgateway.io/',
    notes:
      'OAI-compat gateway with multi-upstream routing. LOTE AK (2026-09-04): baseUrl TLD corrected .net→.io — api.llmgateway.net does not resolve, while GET api.llmgateway.io/v1/models answers 200 PUBLIC with a real OpenAI-shaped list, confirming host and discovery. Roster row DevPass LLM Gateway shares this endpoint: aliased provisionally pending confirmation of the billing-plan relationship; promote to its own profile row if credentials or base URL diverge.',
    lastReviewedAt: '2026-09-04',
  },
  {
    providerId: 'modal',
    displayName: 'Modal',
    providerFamily: 'modal',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'execution-only',
    baseUrl: 'https://modal.run',
    baseUrlEnvVar: 'MODAL_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'MODAL_API_KEY',
    discoveryStatus: 'unavailable-upstream',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://modal.com/docs/guide/endpoints',
    notes:
      'LOTE AJ (2026-09-03): modelled as deployment-scoped inference, not a global model provider. Set MODAL_BASE_URL to a workspace endpoint https://{workspace}--{label}.modal.run serving /v1/chat/completions (modal endpoint create --model ...); auth via workspace proxy token (Bearer wk-*.ws-* or Modal-Key/Modal-Secret). No global model list; workspace endpoint enumeration is out of server runtime scope -> execution-only, no fabricated inventory. NOT live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'auriko',
    displayName: 'Auriko',
    providerFamily: 'auriko',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.auriko.ai/v1',
    baseUrlEnvVar: 'AURIKO_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AURIKO_API_KEY',
    supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.auriko.ai/',
    notes:
      'LOTE AJ (2026-09-03): research verdict IMPLEMENT (docs fetched 2026-09-03). LLM router/gateway: OpenAI-compatible Chat Completions + Responses preview + model-directory API; Bearer key. NOT live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'saladcloud',
    displayName: 'SaladCloud AI Gateway',
    providerFamily: 'saladcloud',
    integrationClass: 'gateway',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://ai.salad.cloud/v1',
    baseUrlEnvVar: 'SALADCLOUD_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'SALADCLOUD_API_KEY',
    supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true, reasoning: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.salad.com/ai-gateway/tutorials/getting-started',
    notes:
      'LOTE AJ (2026-09-03): research verdict IMPLEMENT (docs fetched, quickstart updated 2026-09-02). OpenAI-compatible /v1/chat/completions (streaming, tool calls) on distributed consumer-GPU capacity; live /v1/models; org-scoped Bearer key; UPSTREAM_BETA per vendor. NOT live-probed.',
    lastReviewedAt: '2026-09-03',
  },
  {
    providerId: 'ebcloud',
    displayName: 'EBCloud',
    providerFamily: 'ebcloud',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://maas-api.ebcloud.com/v1',
    baseUrlEnvVar: 'EBCLOUD_BASE_URL',
    authScheme: 'bearer',
    apiKeyEnvVar: 'EBCLOUD_API_KEY',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.ebtech.com/ai/model-api.html',
    notes:
      'OpenAI-compatible Model API (DeepSeek/GLM/Kimi/Qwen/MiniMax, per-token CNY billing). LOTE AL (2026-09-05): the LOTE AK host (api.ebcloud.com, DNS-dead) is now REPLACED — maas-api.ebcloud.com resolves and probe-confirms a real route (401 vs 404 control). docs.ebtech.com does not print the literal hostname in text, so EBCLOUD_BASE_URL stays available as an override if this differs from what an account is actually issued.',
    lastReviewedAt: '2026-09-05',
  },
  // LOTE AK (2026-09-04): the `meta` row that LOTE AJ appended here was a
  // DUPLICATE of `llama` above — same displayName, same providerFamily, and a
  // baseUrl (llama.developer.meta.com/v1) that is the vendor's docs host, not
  // an API host: it 302s every path to ai.developer.meta.com. Its aliases
  // (llama-api, meta, meta-ai) now live on `llama`, whose api.llama.com base
  // is probe-confirmed. See the evidence block in that row.
  // ──────────────────────────────────────────────────────────────────────
  // LOTE AL (2026-09-04/05) — reopened false NPI classifications, round 2.
  //
  // 4 rows closing NOT_PROGRAMMATICALLY_INTEGRABLE verdicts that were built
  // on wrong-company evidence (a same-named-but-different product, or a
  // stale docs page). All 4 are documented, generic, Bearer-key REST
  // surfaces distinct from the products the original NPI verdict examined.
  // Docs-onboarded this session; NOT live-probed (no credentials).
  // ──────────────────────────────────────────────────────────────────────
  {
    providerId: 'ambient',
    displayName: 'Ambient',
    providerFamily: 'ambient',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.ambient.xyz/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AMBIENT_API_KEY',
    supports: { chat: true, streaming: true, tools: true, jsonMode: true, reasoning: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://ambient.xyz/',
    notes:
      'LOTE AL (2026-09-05): reopened false NPI — the prior verdict (LOTE AJ) evidenced the WRONG company (Ambient.ai, physical-security VMS), not ambient.xyz. This is a decentralized verifiable-inference network with an OpenAI/Anthropic-compatible REST API (Proof-of-Logits). GET /v1/models confirmed PUBLIC 200 (glm-5.2, gemma-4-26b-a4b-it, qwen3.6/3.8-27b). Do not re-conflate with the unrelated Ambient.ai.',
    lastReviewedAt: '2026-09-05',
  },
  {
    providerId: 'amd',
    displayName: 'AMD Radeon Cloud (Token Factory)',
    providerFamily: 'amd',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'AMD_API_KEY',
    supports: { chat: true, streaming: true, tools: true, jsonMode: true, reasoning: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://amd-aim.github.io/radeon-cloud-docs/',
    notes:
      "LOTE AL (2026-09-05): reopened false NPI — the prior verdict examined only the AI Developer Program landing page (GPU credits/self-hosted ROCm), missing this separate 'Token Factory' docs site: a hosted, OpenAI/Anthropic-compatible REST API (GET /v1/models, POST /v1/chat+messages), Bearer key format rc-<48hex>. 401 login-required vs 404 on an unmounted version segment confirms a real gateway. NOT live-probed (no key minted).",
    lastReviewedAt: '2026-09-05',
  },
  {
    providerId: 'anyapi',
    displayName: 'AnyAPI',
    providerFamily: 'anyapi',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.anyapi.ai/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'ANYAPI_API_KEY',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://docs.anyapi.ai/',
    notes:
      'LOTE AL (2026-09-05): reopened false NPI — the prior verdict examined the WRONG domain (any-api.com, an APILayer third-party marketplace). The real product is anyapi.ai: unified REST API for 400+ models, OpenAI-compatible /v1/chat/completions, Bearer key. Probe-confirmed: /v1/models 401 structured auth_error vs an unrelated /v1/nonexistent path 403 plain-text RBAC-deny (different code path, route is real).',
    lastReviewedAt: '2026-09-05',
  },
  {
    providerId: 'bailing',
    displayName: 'Bailing (Ant Ling)',
    providerFamily: 'bailing',
    aliases: ['ant-ling'],
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.ant-ling.com/v1',
    authScheme: 'bearer',
    apiKeyEnvVar: 'BAILING_API_KEY',
    supports: { chat: true, streaming: true, tools: true, jsonMode: true, vision: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    docsUrl: 'https://developer.ant-ling.com/zh',
    notes:
      "LOTE AL (2026-09-05): reopened false NPI — the original doc URL (alipaytbox.yuque.com) is STALE, migrated 2026-04-22 to developer.ant-ling.com, which documents a byte-for-byte OpenAI-compatible API (Ling/Ming/Ring models), Bearer key. api.tbox.cn (old guess) is a DIFFERENT product (Ant Toolbox, needs a proprietary SDK token) and stays non-integrable. Probe: api.ant-ling.com/v1/models 401 vs control 404.",
    lastReviewedAt: '2026-09-05',
  },
] as const satisfies readonly ProviderCatalogEntry[];
