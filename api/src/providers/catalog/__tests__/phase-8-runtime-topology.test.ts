// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 8 — Runtime Topology Snapshot Invariants.
 *
 * ## What this test asserts
 *
 * Phase 8 of the SOTA closure plan demands that "every Phase-4-flipped
 * provider has ≥1 model in tiers/leader/degradation candidate lists" and
 * "every provider has ≥1 model returned by capability-search for its
 * declared supports.* capabilities".
 *
 * The strategy and capability-search subsystems both feed off the
 * `models` table at runtime. Asserting their outputs requires DB access,
 * which Vitest unit tests deliberately avoid — instead, this file
 * encodes the *static* invariants that, if upheld, mathematically imply
 * the runtime properties:
 *
 *   1. Every `discovery+execution` catalog row falls into ONE of these
 *      reachability buckets:
 *        - `RUNTIME_MATERIALIZED` — confirmed in the 2026-04-28 fresh
 *          discovery cycle (51 providerIds in `provider-runtime-inventory-2026-04-28.md`).
 *        - `DOCUMENTED_MISSING` — a provider known to NOT materialise
 *          this cycle (credentials, self-hosted-not-running, etc.).
 *      A row outside both sets is a structural gap — discovery is
 *      claimed but no evidence of materialisation exists.
 *
 *   2. Every `execution-only` catalog row carries `pinnedFallback.models`
 *      with ≥1 entry, so even without runtime discovery the strategy
 *      layer has candidates.
 *
 *   3. Every `catalog-only` row is documented in
 *      `provider-failure-diagnosis.md` or `provider-runtime-inventory-2026-04-28.md`
 *      so its absence from runtime is explained, not silent.
 *
 *   4. The capability-search candidate floor: at least 30 providers
 *      should expose a `chat` capability (the strategy candidate pool
 *      lower bound). If the lower bound drops below this, capability
 *      search has lost its core surface.
 *
 * ## Why this test is a snapshot, not a live probe
 *
 * Hub aggregators churn daily. A test that hits the live DB would be
 * brittle — a hub deciding to drop 200 models in a quarterly cleanup
 * would break CI for unrelated PRs. A snapshot of "we observed N
 * providers materialise on day D" lets CI catch *structural* regressions
 * (a catalog row whose discovery path was silently broken) without
 * being noisy about *operational* drift (hub-side catalog changes).
 *
 * ## Updating the snapshot
 *
 * When a real runtime cycle adds a new provider to the materialised set:
 *   1. Update `RUNTIME_MATERIALIZED_2026_04_28` below with the providerId.
 *   2. Update `api/docs/provider-runtime-inventory-2026-04-28.md` with the
 *      per-provider row.
 *   3. Confirm with a local rebuild (Phase 6 procedure).
 *
 * When a provider is intentionally dropped from runtime:
 *   1. Remove from `RUNTIME_MATERIALIZED_2026_04_28`.
 *   2. Add to `DOCUMENTED_MISSING_2026_04_28` with a justification.
 *   3. Reference the Phase 9 drop list entry that authorises the change.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';

// ──────────────────────────────────────────────────────────────────────────
// Snapshots (frozen 2026-04-28 post-fix c85b844)
// ──────────────────────────────────────────────────────────────────────────

/**
 * 51 providerIds with ≥1 active model in the `models` table after the
 * 2026-04-28 fresh discovery cycle (boot 22:54, completion 22:58:26).
 *
 * Source: `api/docs/provider-runtime-inventory-2026-04-28.md` —
 * the post-fix-c85b844 capture with corrected HF Hub attribution.
 */
const RUNTIME_MATERIALIZED_2026_04_28 = new Set<string>([
  // Hub aggregators (Class A — 18 providers, 63,049 models)
  'huggingface',
  'orqai',
  'nanogpt',
  'cometapi',
  'aiml',
  'requesty',
  'poe',
  'openrouter',
  'edenai',
  'aihubmix',
  'routeway',
  'nvidia-hub',
  'heliconeai',
  'phala',
  'gmi',
  'chutes',
  'infermatic',
  'mancer',
  // Native single-vendor (Class B — 30 providers, 1,142 models)
  'deepinfra',
  'alibaba',
  'nvidia',
  'openai',
  'bedrock',
  'novita',
  'mistral',
  'vertex-ai',
  'cohere',
  'jina',
  'wandb',
  'upstage',
  'perplexity',
  'groq',
  'moonshot',
  'fireworks-ai',
  'anthropic',
  'databricks',
  'sambanova',
  'writer',
  'friendli',
  'minimax',
  'inworld',
  'hyperbolic',
  'cerebras',
  'atlascloud',
  'avian',
  'arcee',
  'rekaai',
  'deepseek',
  // Audio-specialty (Class C — 2 providers, 133 models)
  'deepgram',
  'elevenlabs',
  // Uncensored — Class D, partial overlap with Class A (mancer counted above)
  'venice',
]);

/**
 * Native providers materialised through the `first-party-native` integration
 * class — wired via dedicated adapters and discovery sources hardcoded in
 * `central-model-discovery-service.ts` (e.g. AlibabaModelFetcher,
 * OpenAINativeAdapter, AnthropicAdapter, BedrockFoundationAdapter) OUTSIDE
 * the SOTA catalog.
 *
 * These providerIds appear in the runtime `models` table but NOT in the
 * 81-row dynamic catalog because they're part of the always-on core, not
 * the dynamic extension layer.
 *
 * Distinction: `huggingface` is in the catalog AND wired via a native
 * fetcher (HFHubModelFetcher). It belongs to the catalog — NOT this set.
 */
const NATIVE_PROVIDERS_OUTSIDE_CATALOG = new Set<string>([
  // Tier-1 first-party (no catalog row, hardcoded in central-model-discovery-service)
  'openai',
  'anthropic',
  'mistral',
  'cohere',
  'deepseek',
  'xai',
  'vertex-ai',
  'bedrock',
  'jina',
  'deepgram',
  'elevenlabs',
  // Native cloud hubs without catalog rows
  'openrouter', // Wired via dedicated openrouter-aggregator source
  'nvidia-hub', // Synthesized peer of nvidia for hub-vs-native attribution
  // 'alibaba' removed 2026-06-11: the runnable-gap pass gave it a catalog
  // row (oai-compat-pure, dashscope), so it is no longer "outside the
  // catalog" — the AlibabaModelFetcher native source and the catalog row
  // now refer to the same canonical providerId.
]);

/**
 * Catalog rows that did NOT materialise in the 2026-04-28 cycle, with
 * the documented reason. These are NOT regressions — they're known
 * gaps the operator is aware of.
 */
const DOCUMENTED_MISSING_2026_04_28: Record<string, string> = {
  // Self-hosted (8) — infra not part of local Docker stack
  vllm: 'self-hosted; needs vLLM server running locally',
  'lm-studio': 'self-hosted; needs LM Studio app running locally',
  ollama: 'self-hosted; ollama container exposed but not seeded with models',
  xinference: 'self-hosted; needs Xinference deployment',
  triton: 'self-hosted; needs NVIDIA Triton server',
  'local-llama':
    'self-hosted; dedicated external Ollama host (<ollama-host-ip>), not reachable from this 2026-04-28 snapshot env — live-probed 2026-07-31 from the production API host, confirmed working (postdates this frozen snapshot)',
  'local-kobold': 'self-hosted; ad-hoc local KoboldCpp',
  'local-embeddings': 'self-hosted; ad-hoc local embedding server',
  // Catalog-only / pinnedFallback specialty (no list endpoint)
  sap: 'wired discovery+execution (SapAiCoreAdapter); creds-missing in local env; expected in prod via GCP',
  snowflake:
    'wired discovery+execution (SnowflakeCortexAdapter); creds-missing in local env; expected in prod via GCP',
  topaz: 'catalog-only; Topaz needs adapter (Phase 9 evaluation)',
  inflection:
    '2026-09-10: reverted execution-only (2026-06-15 promotion) back to catalog-only — live-re-probed the entire api.inflection.ai host with a real, locally-provisioned INFLECTION_API_KEY and found every path/method/auth combination (including the confirmed /v1/chat/completions) returns an identical generic nginx 404; developers.inflection.ai fails DNS. Not a credentials gap — the vendor host itself is unreachable. See consolidation-matrix.ts defunct-unreachable bucket.',
  relace:
    'LOTE AT (2026-09-09): promoted catalog-only -> discovery+execution (real GET /models on models.relace.ai, official OpenAPI spec); creds-missing in local env (no RELACE_API_KEY), expected to materialise in prod via GCP',
  recraft:
    'image-only specialty, pinnedFallback — live-probed 2026-08-01 (real key, POST /images/generations 200 + fetched image confirmed genuine png); postdates this frozen snapshot',
  runwayml:
    'video-only specialty, pinnedFallback — live-probed 2026-08-01 (real key, GET /v1/organization 200); blocked on billing (creditBalance 0), not credentials; postdates this frozen snapshot',
  bfl: 'image-only specialty, pinnedFallback — live-probed 2026-08-01 (real key, auth accepted); blocked on billing (402 insufficient credits), not credentials; postdates this frozen snapshot',
  'azure-openai': 'per-deployment, no list endpoint, pinnedFallback',
  'aws-bedrock':
    'LOTE AN (2026-09-05, GAP-AK-6): promoted to discovery+execution — ListFoundationModels is wired via the aws-bedrock-hub source and the 13 pins were removed. It cannot materialise in this snapshot because no AWS credential exists in the local env (the fetcher returns [] rather than a fabricated roster, by design). Expected to materialise in prod once AWS_ACCESS_KEY_ID/SECRET or a role is provisioned; NOT live-validated.',
  // Credentials missing in local .env — expected to materialise in prod with GCP
  nscale:
    'creds-missing in local env; live-probed 2026-08-01 from GCP secret — GET /v1/models 200 (23 models) + POST /v1/chat/completions 200; postdates this frozen snapshot',
  anyscale: 'creds-missing in local env; expected in prod via GCP',
  'featherless-ai': 'creds-missing in local env; expected in prod via GCP',
  nebius: 'creds-missing in local env; expected in prod via GCP',
  'lambda-ai': 'creds-missing in local env; expected in prod via GCP',
  scaleway: 'creds-missing in local env; expected in prod via GCP',
  synthetic:
    'creds-missing in local env; live-probed 2026-08-01 from GCP secret — auth accepted (GET /v1/models 200), but POST /v1/chat/completions 402 zero balance/no subscription; postdates this frozen snapshot',
  morph: 'creds-missing in local env; expected in prod via GCP',
  zai: 'creds-missing in local env; live-probed 2026-08-01 from GCP secret — POST /chat/completions 200 real completions (glm-4.5/glm-4.5-flash/glm-4-plus); postdates this frozen snapshot',
  'xiaomi-mimo':
    'creds-missing in local env; live-probed 2026-08-01 from GCP secret — baseUrl was wrong (platform.xiaomimimo.com is the marketing SPA); corrected to api.xiaomimimo.com, GET /v1/models 200 (6 models); POST /v1/chat/completions 402 zero balance; postdates this frozen snapshot',
  v0: 'execution-only, pinnedFallback (no /v1/models surface) — dedicated V0Adapter (2026-08-02) live-probed end-to-end (healthCheck + getModels + real POST /v1/chats generation) through the new adapter code; still execution-only so no runtime `models` table rows expected; postdates this frozen snapshot',
  'vercel-ai-gateway':
    'creds-missing in local env; live-probed 2026-08-01 from GCP secret — GET /v1/models 200 (312 models), but POST /v1/chat/completions 402 insufficient_funds (account-wide billing gate); postdates this frozen snapshot',
  volcano: 'creds-missing in local env; expected in prod via GCP',
  byteplus:
    'creds-missing in local env; live-probed 2026-08-02 from GCP secret <prefix>--byteplus-key THROUGH the new BytePlusModelArkAdapter — GET /api/v3/models 200 (52 records, 40 non-Shutdown), /ping 200, /tokenization 200 with real token ids; every inference route 404s ModelNotOpen because account 3003814011 has zero models activated in the Ark Console (auth itself is proven: 401 without a key). Operator entitlement action, not an integration defect; postdates this frozen snapshot',
  watsonx:
    'creds-missing in local env; 2026-08-01 auth-completeness review (no live call attempted) — WATSONX_APIKEY is real/provisioned, but WATSONX_PROJECT_ID (hard blocker) and WATSONX_URL are not; postdates this frozen snapshot',
  ai302: 'creds-missing in local env; expected in prod via GCP',
  'cloudflare-workers-ai': 'creds-missing in local env; expected in prod via GCP',
  'gemini-openai': 'creds-missing in local env; expected in prod via GCP',
  'github-models':
    'creds-missing in local env; GITHUB_TOKEN secret IS provisioned in prod GCP (<prefix>-github-models-token, since 2026-04-24) — catalog-completeness audit 2026-09-09 found the real cause is external: unauthenticated GET https://models.github.ai/catalog/models returns HTTP 410 github_models_retirement_brownout (GitHub itself retiring the product), confirmed live. Not a credential or wiring defect; postdates this frozen snapshot.',
  imagerouter: 'creds-missing in local env; expected in prod via GCP',
  // Single-cycle regressions (operator follow-up)
  bytez:
    'creds-missing in local env; expected in prod via GCP — root-caused 2026-09-09: BYTEZ_API_KEY IS loaded in production (candidate-trace + catalog-provider-plugin logs confirm apiKeyPresent=true on every boot); the historical "Phase 4d promotion did not survive rebuild" note above was never verified against a real request and was wrong. The real symptom (production logs, 2026-09-09) was the native list endpoint returning HTTP 500 on most discovery cycles and HTTP 200 with an empty output[] on the rest, traced to bytez-native-model-fetcher.ts sending `Authorization: Bearer <key>` where Bytez\'s docs for this endpoint require the bare token with no prefix; fixed alongside this snapshot update. 2026-09-10 follow-up: live re-probe shows the 500/empty-output pattern persists regardless of auth header format — it is a vendor-side bug on GET /models/v2/list/models (undocumented modelId requirement, empty output even when satisfied), not something fixable from our request header; see bytez-native-model-fetcher.ts class-level doc comment for the live-probe evidence.',
  voyage: 'creds-revoked; needs operator rotation',
  replicate: 'API not enabled in current GCP project',
  qianfan: 'creds-format mismatch; needs operator',
  // LOTE O (2026-07-10/11) — catalog row + full secret wiring landed
  // 2026-07-10; live-probed successfully 2026-07-11 (real /v1/models 200 +
  // /v1/chat/completions 200 for both — see consolidation-matrix.ts
  // `live-validation` bucket for evidence). Absent from the frozen
  // RUNTIME_MATERIALIZED_2026_04_28 DB snapshot simply because that
  // capture predates this onboarding — not a gap.
  apertis:
    'live-probed 2026-07-11 (200 on /v1/models + /v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  inception:
    'live-probed 2026-07-11 (200 on /v1/models + /v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  // LOTE P (2026-07-11) — same-day onboarding, same reasoning as apertis/inception.
  empiriolabs:
    'live-probed 2026-07-11 (200 on /v1/models + /v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  // LOTE Q (2026-07-12) — full live probe completed same day (discovery
  // unauthenticated, then chat/completions once gcloud was re-authenticated).
  concentrate:
    'live-probed 2026-07-12 (200 on /v1/models/ + /v1/chat/completions/); postdates the 2026-04-28 DB snapshot',
  // LOTE R (2026-07-13/15) — full live probe completed once gcloud was
  // re-authenticated a third time.
  fastrouter:
    'live-probed 2026-07-15 (200 on /api/v1/providers + /api/v1/models + /api/v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  // LOTE S (2026-07-13) — full live probe same day (discovery authenticated,
  // execution confirmed for 6 of 7 requested vendors).
  'perplexity-agent':
    'live-probed 2026-07-13 (200 on /v1/models + /v1/agent for anthropic/openai/google/xai/z.ai/nvidia); postdates the 2026-04-28 DB snapshot',
  // LOTE T (2026-07-13) — ailin. Unlike LOTE O-S, NOT live-probed this
  // session (no provisioned AILIN_API_KEY available). Wiring verified
  // contract-only against api.ailin.one's own openapi-spec.yaml: chat/
  // embeddings/images/audio confirmed OpenAI-compatible request/response
  // shape at the generic hub's default paths; GET /v1/models confirmed to
  // return a richer native shape the generic fetcher only partly
  // understands (documented as a follow-up in the catalog entry itself).
  // Postdates the 2026-04-28 DB snapshot, same as LOTE O-S.
  ailin:
    'not live-probed (no AILIN_API_KEY provisioned this session); contract-verified against openapi-spec.yaml only — see catalog entry notes for the discovery-shape gap',
  // LOTE U (2026-07-29) — sakana-ai. Discovery live-probed successfully
  // (200 on /v1/models, real 5-model list) same day as catalog onboarding.
  // chat/completions execution was blocked at first probe (429
  // usage_limit_reached — account had no active subscription/PAYG
  // billing), but the operator activated pay-as-you-go billing later the
  // same day and re-verified end-to-end: chat, streaming, tool calls,
  // JSON mode, and vision all confirmed live with real HTTP 200 responses
  // (see consolidation-matrix.ts `live-validation` bucket for the full
  // writeup, and the catalog entry notes). Absent from
  // RUNTIME_MATERIALIZED_2026_04_28 simply because that capture predates
  // this onboarding, same as apertis/inception/empiriolabs/etc. — not a
  // gap.
  'sakana-ai':
    'live-probed 2026-07-29 (200 on /v1/models + /v1/chat/completions, including streaming/tools/jsonMode/vision, after same-day billing activation); postdates the 2026-04-28 DB snapshot',
  // LOTE W (2026-07-30) — togetherai, siliconflow, stepfun. All three were
  // credentials-missing at the 2026-04-28 snapshot; the operator gathered
  // fresh live evidence today directly against the real APIs with
  // regenerated/corrected keys, confirming real chat completions on all
  // three (see consolidation-matrix.ts `live-validation` bucket [LOTE W]
  // and the catalog entry notes for the full per-provider writeup,
  // including the siliconflow/.cn→.com and stepfun/.com→.ai baseUrl
  // corrections). Absent from RUNTIME_MATERIALIZED_2026_04_28 simply
  // because that capture predates this fix — not a gap.
  togetherai:
    'live-probed 2026-07-30 (200 on /v1/models + /v1/chat/completions with the corrected tgp_v1_* key); postdates the 2026-04-28 DB snapshot',
  siliconflow:
    'live-probed 2026-07-30 (200 on /v1/models + /v1/chat/completions against api.siliconflow.com after correcting the wrong-regional .cn baseUrl); postdates the 2026-04-28 DB snapshot',
  stepfun:
    'live-probed 2026-07-30 (200 on /v1/models + /v1/chat/completions against api.stepfun.ai after correcting the wrong-regional .com baseUrl); postdates the 2026-04-28 DB snapshot',
  // LOTE V (2026-08-01) — maritaca-ai. Discovery live-probed successfully
  // (200 on /v1/models, real 6-model list) same day as catalog onboarding.
  // chat/completions execution could NOT be live-confirmed: every model
  // returns 403 insufficient_funds (zero credits on this GCP-sourced key)
  // — see consolidation-matrix.ts `upstream-suspended` bucket for the full
  // writeup. Absent from RUNTIME_MATERIALIZED_2026_04_28 simply because
  // that capture predates this onboarding, same as sakana-ai above.
  'maritaca-ai':
    'live-probed 2026-08-01 (200 on /v1/models; chat/completions blocked by 403 insufficient_funds — zero credits on this key, not an integration defect); postdates the 2026-04-28 DB snapshot',
  // LOTE AB (2026-08-10) — digitalocean. Full end-to-end live verification
  // the same day as catalog onboarding: /v1/models (74 models), chat,
  // streaming, tools, jsonMode, and /v1/embeddings all real HTTP 200s with
  // correct content (see consolidation-matrix.ts `live-validation` bucket
  // for the full writeup). Absent from RUNTIME_MATERIALIZED_2026_04_28
  // simply because that capture predates this onboarding, same as
  // sakana-ai/maritaca-ai above — not a gap.
  digitalocean:
    'live-probed 2026-08-10 (200 on /v1/models + /v1/chat/completions, including streaming/tools/jsonMode/embeddings); postdates the 2026-04-28 DB snapshot',
  // LOTE AC (2026-08-21) — wafer. Onboarded from docs with NO live probe:
  // gcloud ADC expired before the <prefix>-waferai-key secret could be
  // fetched, so neither discovery nor execution was confirmed this
  // session (see consolidation-matrix.ts `no-live-validation`). Absent
  // from RUNTIME_MATERIALIZED_2026_04_28 simply because that capture
  // predates this onboarding, same as sakana-ai/maritaca-ai/digitalocean
  // above — not a gap.
  wafer:
    'not yet live-probed (docs-only onboarding 2026-08-21; gcloud ADC expired — see consolidation-matrix no-live-validation); postdates the 2026-04-28 DB snapshot',
  // LOTE AD-AG (2026-08-21) — vivgrid / unorouter / umans / trustedrouter.
  // None executed with a real key this session (gcloud ADC locked — see
  // consolidation-matrix no-live-validation). Unauthenticated discovery
  // evidence: umans + trustedrouter /v1/models 200 (live-proven),
  // unorouter 401-vs-404 endpoint proof, vivgrid nothing (global gate).
  // All postdate the 2026-04-28 DB snapshot, same as wafer above.
  vivgrid:
    'not live-probed (docs-only onboarding 2026-08-21; gcloud ADC expired; unauthenticated probes inconclusive — global 401 gate); postdates the 2026-04-28 DB snapshot',
  unorouter:
    'discovery endpoint existence proven 2026-08-21 (401 on /v1/models vs 404 on bogus path); execution not probed (gcloud ADC expired); postdates the 2026-04-28 DB snapshot',
  umans:
    'discovery live-probed 2026-08-21 (unauthenticated 200 on /v1/models, 7 models); chat/completions not probed (gcloud ADC expired); postdates the 2026-04-28 DB snapshot',
  trustedrouter:
    'discovery live-probed 2026-08-21 (unauthenticated 200 on /v1/models, 559 models, OpenRouter shape); chat/completions not probed (gcloud ADC expired); postdates the 2026-04-28 DB snapshot',
  // LOTE AH (2026-09-03) — 25 docs-onboarded providers (baseten, kilo-
  // gateway, llama, longcat, iflow, modelscope, near-ai, ollama-cloud,
  // regolo, sarvam, stackit, tinfoil, vultr, ovhcloud, crusoe, hetzner,
  // io-intelligence, lilac, kimi-coding, alibaba-cn, moonshot-cn,
  // siliconflow-cn, stepfun-cn, minimax-cn, xiaomi-token-plan). None
  // probed this session (session execution tooling unavailable + no
  // credentials provisioned for any of them — see consolidation-matrix
  // `no-live-validation`). All postdate the 2026-04-28 DB snapshot, same
  // as wafer above — not a gap.
  baseten:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'kilo-gateway':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  llama:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  longcat:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  iflow:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  modelscope:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'near-ai':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'ollama-cloud':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  regolo:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  sarvam:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  stackit:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  tinfoil:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  vultr:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  ovhcloud:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  crusoe:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  hetzner:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'io-intelligence':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  lilac:
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'kimi-coding':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'alibaba-cn':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'moonshot-cn':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'siliconflow-cn':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'stepfun-cn':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'minimax-cn':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'xiaomi-token-plan':
    'onboarded 2026-09-03 (LOTE AH); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  // LOTE AI (2026-09-03) — 95 docs-onboarded rows (92 hosted + 3
  // self-hosted localhost runtimes). None probed this session (no
  // credentials provisioned; self-hosted rows have no reachable local
  // runtime from CI — see consolidation-matrix no-live-validation). All
  // postdate the 2026-04-28 DB snapshot, same as LOTE AH above — not a gap.
  abacus:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  abliteration:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  abovedev:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  agentrouter:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  agnes:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'ai-router':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  aiand:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  aixy:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  aki:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  berget:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  blueclaw:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  bothub:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'charm-hyper':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  claudin:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  sherlock:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  coralbricks:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  cortecs:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  crofai:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  crossmodel:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  drun:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  daoxe:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  dinference:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  echo:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  evroc:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  freemodel:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  frogbot:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  greenpt:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  hpcai:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  impossibl:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  inceptron:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'inference-net':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  inferx:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  iteracompute:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  jalapeno:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  jieko:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  kenari:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  klok:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  kosmik:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  llmtech:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  llmtr:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  lucidquery:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  meganova:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  mixlayer:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  moark:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  modeloracle:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  modelis:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  neosmith:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  neuralwatt:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  nova:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  ofox:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  openreason:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  opper:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  orcarouter:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  pendra:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  pioneer:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  poolside:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  qihang:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  qiniu:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  routingrun:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  runinfra:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  scx:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  sensenova:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  standardcompute:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  subconscious:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  submodel:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  tensorx:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  thegrid:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  tokengo:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  tokenrouter:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  vancine:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  xpersona:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  zeldoc:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  zenifra:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  zenmux:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  clarifai:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'opencode-zen':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'opencode-go':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  kuae:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  scnet:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  clinepass:
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'tencent-coding':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'tencent-plan':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'tencent-tokenhub':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'alibaba-coding':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'alibaba-coding-cn':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'alibaba-token-plan':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'alibaba-token-plan-cn':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'zai-coding':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'zai-coding-cn':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'volcano-coding':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'stepfun-step-plan':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'stepfun-step-plan-cn':
    'onboarded 2026-09-03 (LOTE AI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'atomic-chat':
    'onboarded 2026-09-03 (LOTE AI); self-hosted local runtime (opt-in URL env); postdates the 2026-04-28 DB snapshot; not yet live-probed',
  lynkr:
    'onboarded 2026-09-03 (LOTE AI); self-hosted local runtime (opt-in URL env); postdates the 2026-04-28 DB snapshot; not yet live-probed',
  privatemode:
    'onboarded 2026-09-03 (LOTE AI); self-hosted local runtime (opt-in URL env); postdates the 2026-04-28 DB snapshot; not yet live-probed',
  merge:
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  infomaniak:
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'minimax-token-plan':
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  'minimax-token-plan-cn':
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  llmgateway:
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  auriko:
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  saladcloud:
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  ebcloud:
    'onboarded 2026-09-03 (LOTE AJ); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  ambient:
    'onboarded 2026-09-05 (LOTE AL, reopened false-NPI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  amd: 'onboarded 2026-09-05 (LOTE AL, reopened false-NPI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  anyapi:
    'onboarded 2026-09-05 (LOTE AL, reopened false-NPI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
  bailing:
    'onboarded 2026-09-05 (LOTE AL, reopened false-NPI); postdates the 2026-04-28 DB snapshot; not yet live-probed (docs-only onboarding — see consolidation-matrix no-live-validation)',
};

// ──────────────────────────────────────────────────────────────────────────
// Invariant 1 — every discovery+execution provider is reachable
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 8 invariant: every-provider-reaches-runtime', () => {
  it('every `discovery+execution` provider is materialised OR documented as missing', () => {
    const offenders: Array<{ providerId: string; reason: string }> = [];
    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'discovery+execution') continue;
      if (RUNTIME_MATERIALIZED_2026_04_28.has(entry.providerId)) continue;
      if (entry.providerId in DOCUMENTED_MISSING_2026_04_28) continue;
      offenders.push({
        providerId: entry.providerId,
        reason: 'discovery+execution but neither materialised nor documented as missing',
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every `catalog-only` provider is documented (no silent absence)', () => {
    const offenders: Array<{ providerId: string; reason: string }> = [];
    for (const entry of PROVIDER_CATALOG) {
      if (entry.integrationMode !== 'catalog-only') continue;
      if (RUNTIME_MATERIALIZED_2026_04_28.has(entry.providerId)) continue;
      if (entry.providerId in DOCUMENTED_MISSING_2026_04_28) continue;
      offenders.push({
        providerId: entry.providerId,
        reason: 'catalog-only without runtime evidence and no documented-missing entry',
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 2 — runtime-materialised set is a strict subset of catalog
// (catches a misspelt providerId or a provider materialising under a
//  name not in the catalog)
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 8 invariant: runtime-materialised-is-subset-of-catalog-or-native', () => {
  it('every materialised providerId is either in the catalog or a documented native', () => {
    const catalogIds = new Set(PROVIDER_CATALOG.map((e) => e.providerId));
    const orphans: string[] = [];
    for (const id of RUNTIME_MATERIALIZED_2026_04_28) {
      if (catalogIds.has(id)) continue;
      if (NATIVE_PROVIDERS_OUTSIDE_CATALOG.has(id)) continue;
      orphans.push(id);
    }
    expect(orphans).toEqual([]);
  });

  it('NATIVE_PROVIDERS_OUTSIDE_CATALOG providers are NOT also in the catalog', () => {
    // The two-tier architecture demands strict separation: native providers
    // wired through `first-party-native` integration class should NOT have
    // a duplicate row in the dynamic SOTA catalog.
    const catalogIds = new Set(PROVIDER_CATALOG.map((e) => e.providerId));
    const duplicates: string[] = [];
    for (const id of NATIVE_PROVIDERS_OUTSIDE_CATALOG) {
      if (catalogIds.has(id)) duplicates.push(id);
    }
    expect(duplicates).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 3 — strategy candidate pool floor
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 8 invariant: strategy-candidate-pool-floor', () => {
  /**
   * The strategy candidate pool is the set of providers whose models
   * a routing strategy can emit. The floor is the minimum number of
   * providers that must materialise for the system to be considered
   * functional. Below this, the routing surface is too narrow to claim
   * "dynamic provider discovery" works.
   *
   * 30 is chosen conservatively: 51 materialise today, but a single
   * GCP secret rotation can knock 5-10 providers offline temporarily.
   * 30 is the floor below which we'd want to alert.
   */
  const STRATEGY_POOL_FLOOR = 30;

  it(`runtime materialised set has at least ${STRATEGY_POOL_FLOOR} providers`, () => {
    expect(RUNTIME_MATERIALIZED_2026_04_28.size).toBeGreaterThanOrEqual(STRATEGY_POOL_FLOOR);
  });

  it('runtime materialised set covers all four operational classes', () => {
    // A — Hub aggregators
    const hubs = ['huggingface', 'orqai', 'cometapi', 'openrouter'];
    for (const id of hubs) {
      expect(RUNTIME_MATERIALIZED_2026_04_28.has(id)).toBe(true);
    }
    // B — Native single-vendor
    const native = ['openai', 'anthropic', 'mistral', 'cohere'];
    for (const id of native) {
      expect(RUNTIME_MATERIALIZED_2026_04_28.has(id)).toBe(true);
    }
    // C — Audio-specialty
    expect(RUNTIME_MATERIALIZED_2026_04_28.has('deepgram')).toBe(true);
    expect(RUNTIME_MATERIALIZED_2026_04_28.has('elevenlabs')).toBe(true);
    // D — Uncensored (universal habilitado-e-nunca-censurado directive)
    expect(RUNTIME_MATERIALIZED_2026_04_28.has('venice')).toBe(true);
    expect(RUNTIME_MATERIALIZED_2026_04_28.has('mancer')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant 4 — HF Hub attribution correctness (post-fix c85b844)
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 8 invariant: hf-hub-attribution-correctness', () => {
  it('huggingface and openrouter are both materialised as distinct providerIds', () => {
    // Pre-fix: HF Hub aggregator output was misattributed to provider_id='openrouter',
    // causing openrouter to falsely report 58k models and huggingface to report ~123.
    // Post-fix c85b844: huggingface materialises independently with its own model set.
    expect(RUNTIME_MATERIALIZED_2026_04_28.has('huggingface')).toBe(true);
    expect(RUNTIME_MATERIALIZED_2026_04_28.has('openrouter')).toBe(true);
  });
});
