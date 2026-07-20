// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Load Secrets into Environment
 * 
 * This module loads critical secrets from GCP Secret Manager
 * and injects them into process.env BEFORE config validation.
 * 
 * This allows the existing config system to work without refactoring,
 * while still using GCP Secret Manager as the source of truth.
 * 
 * Call order:
 * 1. initializeSecretsManager()
 * 2. loadSecretsIntoEnv() ← This file
 * 3. validateConfig()
 */

import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { loadSecret } from './secrets-loader';

/**
 * Critical secrets that must be loaded from GCP
 * These are injected into process.env for config compatibility
 */
interface CriticalSecret {
  envVar: string;
  secretKey: string;
  required: boolean;
  defaultValue?: string;
}

const CRITICAL_SECRETS: CriticalSecret[] = [
  { envVar: 'DATABASE_URL', secretKey: 'database-url', required: true },
  { envVar: 'JWT_SECRET', secretKey: 'jwt-secret', required: true },
  { envVar: 'REDIS_PASSWORD', secretKey: 'redis-password', required: false, defaultValue: '' },
  { envVar: 'GCS_FILES_BUCKET', secretKey: 'gcs-files-bucket', required: false },
  { envVar: 'SMTP_PASS', secretKey: 'smtp-pass', required: false },
  { envVar: 'STRIPE_SECRET_KEY', secretKey: 'stripe-secret-key', required: false },
  { envVar: 'STRIPE_WEBHOOK_SECRET', secretKey: 'stripe-webhook-secret', required: false },
  { envVar: 'STRIPE_PUBLISHABLE_KEY', secretKey: 'stripe-publishable-key', required: false },
  // Phase 2c shadow ensemble bearer token. Optional because the coord-
  // stable wire is disabled by default in production
  // (CI_ENSEMBLE_COORDINATOR_ENABLED=false). When operator flips it on,
  // the GCP secret `coord-ensemble-token` MUST also be set with the
  // value to share with coord-serving's COORD_SERVING_AUTH_TOKEN.
  { envVar: 'CI_ENSEMBLE_COORDINATOR_TOKEN', secretKey: 'coord-ensemble-token', required: false },
];

/**
 * Provider API keys (loaded from GCP if not in env)
 * CRITICAL: GCP provider automatically adds prefix 'ailin-' to secret keys
 * So 'openai-key' becomes 'ailin-openai-key' in GCP Secret Manager
 * These keys match the actual secret names in GCP (without the prefix, provider adds it)
 */
interface ProviderSecretBinding {
  envVar: string;
  secretKeys: readonly string[];
}

export const PROVIDER_SECRETS: readonly ProviderSecretBinding[] = [
  { envVar: 'OPENAI_API_KEY', secretKeys: ['openai-key'] },
  { envVar: 'ANTHROPIC_API_KEY', secretKeys: ['anthropic-key'] },
  { envVar: 'GOOGLE_API_KEY', secretKeys: ['google-key'] },
  { envVar: 'DEEPSEEK_API_KEY', secretKeys: ['deepseek-key'] },
  { envVar: 'XAI_API_KEY', secretKeys: ['xai-key'] },
  { envVar: 'MISTRAL_API_KEY', secretKeys: ['mistral-key'] },
  { envVar: 'COHERE_API_KEY', secretKeys: ['cohere-key'] },
  { envVar: 'NVIDIA_API_KEY', secretKeys: ['nvidia-key', 'nvidia-api-key'] },
  { envVar: 'AIHUBMIX_API_KEY', secretKeys: ['aihubmix-key', 'aihubmix-api-key'] },
  { envVar: 'NOVITA_API_KEY', secretKeys: ['novita-key', 'novita-api-key'] },
  { envVar: 'MOONSHOT_API_KEY', secretKeys: ['moonshot-key', 'moonshot-api-key'] },
  { envVar: 'MINIMAX_API_KEY', secretKeys: ['minimax-key', 'minimax-api-key'] },
  { envVar: 'JINA_API_KEY', secretKeys: ['jina-key', 'jina-api-key'] },
  { envVar: 'GOOGLE_MAPS_API_KEY', secretKeys: ['google-maps-key', 'google-maps-api-key'] },
  { envVar: 'FRIENDLI_API_KEY', secretKeys: ['friendli-key', 'friendli-api-key'] },
  { envVar: 'FRIENDLI_TEAM_ID', secretKeys: ['friendli-team-id'] },
  { envVar: 'AIML_API_KEY', secretKeys: ['aiml-key', 'aiml-api-key'] },
  { envVar: 'IMAGEROUTER_API_KEY', secretKeys: ['imagerouter-key', 'imagerouter-api-key'] },
  { envVar: 'OPENROUTER_API_KEY', secretKeys: ['openrouter-key'] },
  { envVar: 'COMETAPI_API_KEY', secretKeys: ['cometapi-key', 'cometapi-api-key'] },
  { envVar: 'NANOGPT_API_KEY', secretKeys: ['nanogpt-key', 'nanogpt-api-key'] },
  { envVar: 'REQUESTY_API_KEY', secretKeys: ['requesty-key', 'requesty-api-key'] },
  { envVar: 'AI302_API_KEY', secretKeys: ['302-key', '302ai-key'] },
  { envVar: 'POE_API_KEY', secretKeys: ['poe-key', 'poe-api-key'] },
  { envVar: 'ROUTEWAY_API_KEY', secretKeys: ['routeway-key', 'routeway-api-key'] },
  // Hub providers support both key naming conventions for compatibility.
  { envVar: 'ORQAI_API_KEY', secretKeys: ['orqai-key', 'orqai-api-key'] },
  { envVar: 'ORQAI_MODEL_DENYLIST', secretKeys: ['orqai-model-denylist'] },
  { envVar: 'EDENAI_API_KEY', secretKeys: ['edenai-key', 'edenai-api-key'] },
  { envVar: 'HELICONEAI_API_KEY', secretKeys: ['heliconeai-key', 'heliconeai-api-key'] },
  { envVar: 'VERTEX_AI_API_KEY', secretKeys: ['vertex-key'] },
  { envVar: 'VERTEX_AI_PROJECT_ID', secretKeys: ['vertex-project-id'] },
  { envVar: 'QWEN_API_KEY', secretKeys: ['qwen-key-2'] },
  { envVar: 'ALIBABA_KEY_ID', secretKeys: ['alibaba-key-id'] },
  { envVar: 'ALIBABA_KEY_SECRET', secretKeys: ['alibaba-key-secret'] },
  { envVar: 'ERNIE_API_KEY', secretKeys: ['baidu-key'] },
  { envVar: 'ERNIE_SECRET_KEY', secretKeys: ['baidu-secret'] },
  { envVar: 'BAIDU_BASE_URL', secretKeys: ['baidu-base-url'] },
  { envVar: 'AWS_ACCESS_KEY_ID', secretKeys: ['aws-key-id'] },
  { envVar: 'AWS_SECRET_ACCESS_KEY', secretKeys: ['aws-secret'] },
  { envVar: 'AWS_BEARER_TOKEN_BEDROCK', secretKeys: ['aws-bearer-token'] },
  // Batch 7.1: Bedrock region + inference-profile ARN can now be set via
  // GCP Secret Manager. Useful for deploys that route Bedrock to a specific
  // region (e.g. us-west-2) or via cross-region inference profiles without
  // baking these into the docker image.
  { envVar: 'AWS_BEDROCK_REGION', secretKeys: ['aws-bedrock-region'] },
  { envVar: 'AWS_BEDROCK_INFERENCE_PROFILE_ARN', secretKeys: ['aws-bedrock-inference-profile-arn'] },
  // Batch 8.1: SageMaker endpoint routing. A deploy can point this adapter
  // at a specific deployed endpoint via a secret rather than baking the
  // endpoint name into the image. The region override lets the adapter
  // hit an endpoint in a different region from the general AWS_REGION
  // used by other services (SES, S3).
  { envVar: 'AWS_SAGEMAKER_REGION', secretKeys: ['aws-sagemaker-region'] },
  { envVar: 'AWS_SAGEMAKER_ENDPOINT_NAME', secretKeys: ['aws-sagemaker-endpoint-name'] },
  { envVar: 'AWS_SAGEMAKER_PAYLOAD_SCHEMA', secretKeys: ['aws-sagemaker-payload-schema'] },
  { envVar: 'AWS_SAGEMAKER_CUSTOM_ATTRIBUTES', secretKeys: ['aws-sagemaker-custom-attributes'] },
  { envVar: 'AZURE_OPENAI_API_KEY', secretKeys: ['azure-openai-api-key'] },
  { envVar: 'AZURE_OPENAI_ENDPOINT', secretKeys: ['azure-openai-endpoint'] },
  { envVar: 'AZURE_OPENAI_DEPLOYMENT', secretKeys: ['azure-openai-deployment'] },
  // Audio-first providers (STT, TTS, STS)
  { envVar: 'DEEPGRAM_API_KEY', secretKeys: ['deepgram-key'] },
  { envVar: 'CARTESIA_API_KEY', secretKeys: ['cartesia-key'] },
  { envVar: 'ELEVENLABS_API_KEY', secretKeys: ['elevenlabs-key'] },
  // Translation provider
  { envVar: 'PALABRAAI_CLIENT_ID', secretKeys: ['palabraai-id'] },
  { envVar: 'PALABRAAI_CLIENT_SECRET', secretKeys: ['palabraai-key'] },
  { envVar: 'OCI_TENANCY_ID', secretKeys: ['oci-tenancy-id'] },
  { envVar: 'OCI_USER_ID', secretKeys: ['oci-user-id'] },
  { envVar: 'OCI_FINGERPRINT', secretKeys: ['oci-fingerprint'] },
  { envVar: 'OCI_PRIVATE_KEY', secretKeys: ['oci-private-key'] },
  { envVar: 'OCI_REGION', secretKeys: ['oci-region'] },
  // 2026-04-22: New GCP secrets (5 providers). The GCP provider auto-prefixes
  // 'ailin-', so 'wandb-key' maps to ailin-wandb-key in Secret Manager.
  // Voyage lists both 'voyageai-key' (current upstream name) and 'voyage-key'
  // (conventional fallback) because the canonical spelling is still unstable.
  { envVar: 'WANDB_API_KEY', secretKeys: ['wandb-key', 'wandb-api-key'] },
  { envVar: 'VOYAGE_API_KEY', secretKeys: ['voyageai-key', 'voyage-key', 'voyage-api-key'] },
  { envVar: 'BYTEZ_API_KEY', secretKeys: ['bytez-key', 'bytez-api-key'] },
  { envVar: 'CEREBRAS_API_KEY', secretKeys: ['cerebras-key', 'cerebras-api-key'] },
  { envVar: 'FEATHERLESS_AI_API_KEY', secretKeys: ['featherless-key', 'featherless-api-key'] },
  // Batch 6 — enterprise hyperscaler gateways (2026-04-22).
  // Azure OpenAI already has API_KEY/ENDPOINT/DEPLOYMENT wired above;
  // these fill in the remaining URL-template parameters.
  { envVar: 'AZURE_OPENAI_RESOURCE_NAME', secretKeys: ['azure-openai-resource-name', 'azure-openai-resource'] },
  { envVar: 'AZURE_OPENAI_API_VERSION', secretKeys: ['azure-openai-api-version'] },
  // Gemini OAI-compat shares the API key with the native `google` provider.
  // Two env-var aliases: GEMINI_API_KEY (canonical upstream) and
  // GOOGLE_AI_STUDIO_API_KEY (legacy). The adapter reads either.
  //
  // 2026-04-23 final pass: `vertex-key` added as a fallback source because
  // it was verified working against generativelanguage.googleapis.com this
  // session (HTTP 200, 50 Gemini models) while `google-key` is suspended
  // (403 CONSUMER_SUSPENDED). The Vertex/Gemini API-key split is
  // mostly historical — a Google Cloud API key scoped for Gemini works
  // equally on aistudio and on the generativelanguage surface, as long as
  // the key's GCP project has the API enabled. Putting `vertex-key` at
  // the END of the fallback preserves existing behavior (gemini-key /
  // google-ai-studio-key / google-key are still preferred when present)
  // while letting the vertex-key unlock gemini-openai today.
  { envVar: 'GEMINI_API_KEY', secretKeys: ['google-key', 'gemini-key', 'google-ai-studio-key', 'vertex-key'] },
  // GitHub Models uses a GitHub PAT. Operators typically already have this
  // in env (it's the same PAT used for gh CLI); the GCP path is a fallback
  // for service accounts that need isolated tokens.
  { envVar: 'GITHUB_TOKEN', secretKeys: ['github-models-token', 'github-token', 'github-pat'] },
  // Databricks workspace token + config.
  { envVar: 'DATABRICKS_TOKEN', secretKeys: ['databricks-token', 'databricks-pat'] },
  { envVar: 'DATABRICKS_HOST', secretKeys: ['databricks-host'] },
  { envVar: 'DATABRICKS_SERVING_ENDPOINT', secretKeys: ['databricks-serving-endpoint'] },
  // Inworld AI — orphan closure 2026-04-22. Key is already base64-encoded
  // in GCP (132 chars) because Inworld uses Basic auth, not Bearer. The
  // adapter does NOT re-encode; it passes the secret verbatim into the
  // `Basic ` header. Never base64-encode this value at load time.
  { envVar: 'INWORLD_API_KEY', secretKeys: ['inworld-key', 'inworld-api-key'] },
  // ── Orphan-closure Lot B (2026-04-23) ──────────────────────────────────
  // Three providers closed in a single lot because they share identical
  // shape (thin OAI-compat wrappers) and were all already present in GCP
  // Secret Manager but not wired into env loading. Each tuple lists the
  // preferred secret key first and legacy-or-alternate names as fallbacks.
  { envVar: 'WRITER_API_KEY', secretKeys: ['writer-key', 'writer-api-key'] },
  { envVar: 'UPSTAGE_API_KEY', secretKeys: ['upstage-key', 'upstage-api-key'] },
  // Reka's canonical upstream name is "reka" but the key is stored in GCP
  // as `ailin-rekaai-key` (matching the catalog providerId, not the upstream
  // name). `reka-key` is kept as a fallback in case the secret is ever
  // renamed to match upstream naming later.
  { envVar: 'REKA_API_KEY', secretKeys: ['rekaai-key', 'reka-key', 'reka-api-key'] },
  // ── LOTE M (2026-04-23) — complement lot: 13 new env-var mappings. ─────
  // Every provider below landed a catalog row this lot and is classified
  // in CONSOLIDATION_MATRIX['credentials-missing'] (secret-absent sub-class
  // for 12, auth-incomplete for qianfan). Each mapping is wired NOW so the
  // moment an operator provisions the corresponding GCP secret, the key
  // propagates to process.env without a code change. The first element of
  // each secretKeys array is the preferred upstream-convention name; any
  // follow-up entries are fallbacks for historical or legacy aliases.
  { envVar: 'ARCEE_API_KEY', secretKeys: ['arcee-api-key', 'arcee-key'] },
  { envVar: 'ATLASCLOUD_API_KEY', secretKeys: ['atlascloud-key', 'atlascloud-api-key', 'atlas-cloud-key'] },
  { envVar: 'AVIAN_API_KEY', secretKeys: ['avian-key', 'avian-api-key', 'avian-io-key'] },
  // Qianfan (Baidu) v2 bce-v3 bearer. Distinct from the legacy v1 AK+SK
  // material in ERNIE_API_KEY / ERNIE_SECRET_KEY / BAIDU_BASE_URL above —
  // both mappings are intentionally kept so an operator can populate either
  // path (v1 OAuth or v2 bearer) depending on which runtime surface is
  // used. The canonical catalog row `qianfan` reads QIANFAN_API_KEY only.
  { envVar: 'QIANFAN_API_KEY', secretKeys: ['qianfan-key', 'qianfan-api-key', 'baidu-qianfan-key'] },
  { envVar: 'GMI_API_KEY', secretKeys: ['gmi-key', 'gmi-api-key', 'gmicloud-key'] },
  { envVar: 'INFERMATIC_API_KEY', secretKeys: ['infermatic-api-key', 'infermatic-key', 'totalgpt-key'] },
  { envVar: 'INFLECTION_API_KEY', secretKeys: ['inflection-key', 'inflection-api-key', 'inflection-ai-key'] },
  // Mancer (tagged contentPolicyClass=uncensored in catalog; per the universal
  // "habilitado e nunca censurado" policy from Phase 4b, 2026-04-28, the
  // catalog row is fully admitted to routing — the tag is informational so
  // downstream surfaces can opt to filter it from a moderated default list).
  { envVar: 'MANCER_API_KEY', secretKeys: ['mancer-key', 'mancer-api-key'] },
  // Phala / RedPill TEE — upstream docs use REDPILL_API_KEY but we wire
  // PHALA_API_KEY as the canonical env var (see apiKeyEnvVarOverrideReason
  // in catalog row `phala`). Legacy `redpill-*` secret names are accepted
  // as fallbacks so an operator storing under either convention works.
  { envVar: 'PHALA_API_KEY', secretKeys: ['phala-key', 'phala-api-key', 'redpill-key', 'redpill-api-key'] },
  { envVar: 'RELACE_API_KEY', secretKeys: ['relace-key', 'relace-api-key'] },
  { envVar: 'SILICONFLOW_API_KEY', secretKeys: ['siliconflow-api-key', 'siliconflow-key', 'silicon-flow-key'] },
  { envVar: 'STEPFUN_API_KEY', secretKeys: ['stepfun-api-key', 'stepfun-key', 'step-key'] },
  // Venice (tagged contentPolicyClass=uncensored in catalog). Same Phase-4b
  // treatment as Mancer — admitted, never censored, with the tag as the
  // audit trail for the policy choice.
  { envVar: 'VENICE_API_KEY', secretKeys: ['venice-key', 'venice-api-key', 'venice-ai-key'] },
  // ── Sublote E1 (2026-04-24) — runtime-wiring closure for D1 matrix ─────
  // Sublote D1 promoted 10 providers to CONSOLIDATION_MATRIX['live-validation']
  // based on direct-probe evidence (via gcloud secrets versions access,
  // bypassing the runtime env loader). 7 of those had no GCP→ENV tuple here,
  // so the catalog-loader could never surface `process.env.<X>_API_KEY` at
  // boot — meaning live-validated providers were silently "not runnable".
  // Wired pre-emptively: the moment an operator provisions the GCP secret
  // AND the container restarts, propagation happens with zero code change.
  // The 3 already-mapped providers (heliconeai, github-models, infermatic)
  // are NOT duplicated — they appear above under their respective batches.
  { envVar: 'GROQ_API_KEY', secretKeys: ['groq-api-key', 'groq-key'] },
  { envVar: 'DEEPINFRA_API_KEY', secretKeys: ['deepinfra-api-key', 'deepinfra-key'] },
  // Hugging Face: upstream canonical env var is `HF_TOKEN` (not
  // HUGGINGFACE_API_KEY); the catalog row's apiKeyEnvVar matches. Primary
  // GCP secret name follows the upstream convention; legacy huggingface-*
  // aliases accepted for operators who stored it under the provider slug.
  { envVar: 'HF_TOKEN', secretKeys: ['huggingface-api-key', 'huggingface-token', 'hf-token', 'huggingface-key'] },
  // Cloudflare Workers AI — requires BOTH api-token AND account-id. The
  // CloudflareWorkersAIAdapter factory (default-adapter-factories.ts line
  // 229-246) reads CLOUDFLARE_ACCOUNT_ID from env and substitutes it into
  // the `{account_id}` URL template. Without the account-id side-car the
  // adapter ships the literal template to the wire → 404 on every call.
  // Side-car is wired here as a separate tuple because it's not an auth
  // credential — it's a URL parameter — so it doesn't belong in
  // ENV_VAR_TO_PROVIDER or LLM_PROVIDER_ENV_VARS below.
  { envVar: 'CLOUDFLARE_API_TOKEN', secretKeys: ['cloudflare-workers-ai-api-key', 'cloudflare-workers-ai-token', 'cloudflare-api-token', 'cloudflare-workers-ai-key'] },
  { envVar: 'CLOUDFLARE_ACCOUNT_ID', secretKeys: ['cloudflare-workers-ai-id', 'cloudflare-account-id', 'cloudflare-workers-ai-account-id'] },
  { envVar: 'PERPLEXITY_API_KEY', secretKeys: ['perplexity-api-key', 'perplexity-key'] },
  // Fireworks AI — note the catalog providerId is `fireworks-ai` (hyphenated)
  // but upstream brand/docs spell it "Fireworks" (no suffix). Four fallbacks
  // cover both conventions + api-key suffix variant.
  { envVar: 'FIREWORKS_AI_API_KEY', secretKeys: ['fireworks-ai-api-key', 'fireworks-ai-key', 'fireworks-key', 'fireworks-api-key'] },
  { envVar: 'SAMBANOVA_API_KEY', secretKeys: ['sambanova-api-key', 'sambanova-key'] },
  // Replicate — flagged by the sublote-e1-runtime-wiring invariant as a
  // pre-existing gap. `replicate` has been in CONSOLIDATION_MATRIX
  // ['live-validation'] since before D1, with adapterClass 'ReplicateAdapter'
  // and apiKeyEnvVar 'REPLICATE_API_KEY', but no tuple was ever added here.
  // Even though integrationMode is 'execution-only' (no /v1/models
  // discovery), the adapter still requires the env var at /predictions
  // call time. Wired here for closure; the GCP secret name follows the
  // provider-slug convention with optional `-api-key` fallback.
  { envVar: 'REPLICATE_API_KEY', secretKeys: ['replicate-key', 'replicate-api-key'] },
  // ── LOTE N (2026-04-27) — catalog↔loader closure for the remaining 22 ─
  // apiKeyEnvVar entries that had catalog rows but NO PROVIDER_SECRETS
  // tuple. Surfaced by `catalog-loader-wiring-completeness.test.ts` (J6
  // invariant). All 22 are real provider rows with adapter classes (or
  // generic OAI-compat hub registration); they were classified in
  // CONSOLIDATION_MATRIX as `credentials-missing` or `disabled-by-default`,
  // and their absence here meant that even after an operator provisioned
  // the GCP secret, `process.env.<X>_API_KEY` would stay empty at boot.
  //
  // Pattern: preferred secret name first (provider-slug `-key`), then
  // upstream-convention `-api-key` fallback, then any historical aliases.
  // The provider-side `aliases` array in providers.catalog.ts is NOT
  // duplicated here — secret-key aliases are about HOW the operator
  // stored the credential, NOT how callers reach the provider.
  //
  // Image/video-only providers (bfl, recraft, runwayml, topaz) are wired
  // here too but are intentionally absent from LLM_PROVIDER_ENV_VARS below
  // because their presence does NOT count toward the "at least one LLM
  // key present" boot-mode gate.
  { envVar: 'TOGETHERAI_API_KEY', secretKeys: ['togetherai-api-key', 'togetherai-key', 'together-key', 'together-api-key'] },
  { envVar: 'ANYSCALE_API_KEY', secretKeys: ['anyscale-api-key', 'anyscale-key'] },
  { envVar: 'HYPERBOLIC_API_KEY', secretKeys: ['hyperbolic-api-key', 'hyperbolic-key'] },
  { envVar: 'CHUTES_API_KEY', secretKeys: ['chutes-api-key', 'chutes-key', 'chutes-ai-key'] },
  { envVar: 'NSCALE_API_KEY', secretKeys: ['nscale-key', 'nscale-api-key'] },
  { envVar: 'NEBIUS_API_KEY', secretKeys: ['nebius-key', 'nebius-api-key'] },
  // Lambda Cloud canonical provider slug is `lambda-ai`; brand is
  // "Lambda" (without -ai). Both spellings tried as fallbacks.
  { envVar: 'LAMBDA_AI_API_KEY', secretKeys: ['lambda-ai-key', 'lambda-key', 'lambda-cloud-key', 'lambda-ai-api-key'] },
  { envVar: 'SCALEWAY_API_KEY', secretKeys: ['scaleway-key', 'scaleway-api-key'] },
  { envVar: 'SYNTHETIC_API_KEY', secretKeys: ['synthetic-key', 'synthetic-api-key', 'synthetic-ai-key'] },
  { envVar: 'MORPH_API_KEY', secretKeys: ['morph-key', 'morph-api-key', 'morph-llm-key'] },
  // Z.ai (catalog providerId = `zai`). Upstream domain z.ai resolves to
  // bigmodel.cn — the GLM family operator. Legacy spelling z-ai accepted.
  { envVar: 'ZAI_API_KEY', secretKeys: ['zai-key', 'zai-api-key', 'z-ai-key', 'glm-key'] },
  { envVar: 'XIAOMI_MIMO_API_KEY', secretKeys: ['xiaomi-mimo-key', 'mimo-key', 'xiaomi-mimo-api-key'] },
  // v0 (Vercel) — code-gen LLM. The catalog providerId is `v0` (one
  // character) so the env var name is `V0_API_KEY` not `V0AI_API_KEY`.
  { envVar: 'V0_API_KEY', secretKeys: ['v0-key', 'v0-api-key', 'vercel-v0-key'] },
  // Vercel AI Gateway — DIFFERENT from v0 above (gateway over many LLMs).
  // The canonical secret name follows the catalog providerId.
  { envVar: 'VERCEL_AI_GATEWAY_API_KEY', secretKeys: ['vercel-ai-gateway-key', 'vercel-ai-gateway-api-key', 'vercel-gateway-key'] },
  // Volcano (Volcengine — ByteDance). Canonical slug `volcano`; brand
  // includes Volcengine + Doubao + Ark. Multiple aliases accepted.
  { envVar: 'VOLCANO_API_KEY', secretKeys: ['volcano-key', 'volcano-api-key', 'volcengine-key', 'doubao-key', 'ark-key'] },
  // IBM watsonx — note the env var is `WATSONX_APIKEY` (no underscore
  // between API and KEY) to match IBM's canonical SDK convention.
  // Side-car env vars (WATSONX_PROJECT_ID, WATSONX_URL) are wired below
  // because they're documented in the catalog row's `extraEnvVars` and
  // adapter requires them at runtime.
  { envVar: 'WATSONX_APIKEY', secretKeys: ['watsonx-apikey', 'watsonx-key', 'watsonx-api-key', 'ibm-watsonx-key'] },
  { envVar: 'WATSONX_PROJECT_ID', secretKeys: ['watsonx-project-id', 'ibm-watsonx-project-id'] },
  { envVar: 'WATSONX_URL', secretKeys: ['watsonx-url', 'ibm-watsonx-url'] },
  // Snowflake Cortex — uses Personal Access Token (PAT), not an API key.
  // Multiple side-cars required by the SnowflakeCortexAdapter:
  // SNOWFLAKE_ACCOUNT (orgname-accountname), SNOWFLAKE_USER (key-pair
  // auth user), SNOWFLAKE_BASE_URL (account-specific host). Side-cars
  // wired here so a single GCP provisioning round materializes the full
  // tuple at boot.
  { envVar: 'SNOWFLAKE_PAT', secretKeys: ['snowflake-pat', 'snowflake-token', 'snowflake-key'] },
  { envVar: 'SNOWFLAKE_ACCOUNT', secretKeys: ['snowflake-account'] },
  { envVar: 'SNOWFLAKE_USER', secretKeys: ['snowflake-user', 'snowflake-username'] },
  { envVar: 'SNOWFLAKE_BASE_URL', secretKeys: ['snowflake-base-url', 'snowflake-url'] },
  // SAP AI Core — OAuth2 client_credentials flow. Catalog providerId is
  // `sap`. The apiKeyEnvVar is `SAP_AI_CORE_CLIENT_ID` (the OAuth client
  // id); the matching client_secret + token URL + base URL are all
  // documented in the catalog row's `extraEnvVars` and required by the
  // SapAiCoreAdapter. Wiring all four together so a single provisioning
  // round closes the loop.
  { envVar: 'SAP_AI_CORE_CLIENT_ID', secretKeys: ['sap-ai-core-client-id', 'sap-client-id'] },
  { envVar: 'SAP_AI_CORE_CLIENT_SECRET', secretKeys: ['sap-ai-core-client-secret', 'sap-client-secret'] },
  { envVar: 'SAP_AI_CORE_AUTH_URL', secretKeys: ['sap-ai-core-auth-url', 'sap-auth-url'] },
  { envVar: 'SAP_AI_CORE_BASE_URL', secretKeys: ['sap-ai-core-base-url', 'sap-base-url'] },
  // W&B Inference side-car — WANDB_API_KEY (auth) is already wired in
  // Batch 7 above; WANDB_PROJECT is the project slug header required on
  // every chat call. Wiring here closes the side-car gap.
  { envVar: 'WANDB_PROJECT', secretKeys: ['wandb-project', 'wandb-project-slug'] },
  // Image-only providers (no LLM gate participation, see comment below).
  // bfl auth header is `x-key` (not Bearer) — see catalog `authHeaderName`.
  { envVar: 'BFL_API_KEY', secretKeys: ['bfl-key', 'bfl-api-key', 'flux-key', 'black-forest-labs-key'] },
  { envVar: 'RECRAFT_API_KEY', secretKeys: ['recraft-key', 'recraft-api-key'] },
  { envVar: 'RUNWAYML_API_KEY', secretKeys: ['runwayml-key', 'runwayml-api-key', 'runway-key'] },
  { envVar: 'TOPAZ_API_KEY', secretKeys: ['topaz-key', 'topaz-api-key', 'topaz-labs-key'] },
  // ── LOTE O (2026-07-10) — Apertis + Inception Labs onboarding ─────────
  // Operator pre-provisioned both GCP secrets ahead of the catalog rows
  // (ailin-apertis-key, ailin-inception-key). secretKeys match exactly —
  // the GCP provider auto-prepends the `ailin-` prefix (see file header).
  { envVar: 'APERTIS_API_KEY', secretKeys: ['apertis-key', 'apertis-api-key'] },
  { envVar: 'INCEPTION_API_KEY', secretKeys: ['inception-key', 'inception-api-key'] },
  // ── LOTE P (2026-07-11) — EmpirioLabs AI, live-validated after gate ────
  { envVar: 'EMPIRIOLABS_API_KEY', secretKeys: ['empiriolabs-key', 'empiriolabs-api-key'] },
  // ── LOTE Q (2026-07-12) — Concentrate AI ───────────────────────────────
  { envVar: 'CONCENTRATE_API_KEY', secretKeys: ['concentrate-key', 'concentrate-api-key'] },
  // ── LOTE R (2026-07-13) — FastRouter ────────────────────────────────────
  { envVar: 'FASTROUTER_API_KEY', secretKeys: ['fastrouter-key', 'fastrouter-api-key'] },
  // ── LOTE S (2026-07-13) — Perplexity Agent API ──────────────────────────
  // Same physical credential as PERPLEXITY_API_KEY above (one Perplexity
  // account, two API surfaces) — deliberately sources from the SAME GCP
  // secret names, not a new one.
  { envVar: 'PERPLEXITY_AGENT_API_KEY', secretKeys: ['perplexity-api-key', 'perplexity-key'] },
  // ── LOTE T (2026-07-13) — Ailin gateway (self-referential meta-provider) ──
  // No GCP secret provisioned yet — inert until an operator sets AILIN_API_KEY
  // for a self-hosted deployment. secretKeys follow the same naming
  // convention as the rest of this file in case one is provisioned later.
  { envVar: 'AILIN_API_KEY', secretKeys: ['ailin-key', 'ailin-api-key', 'ailin-gateway-key'] },
] as const;

// ─── Provider Key Status Tracking ──────────────────────────────────────────
// Tracks which provider API keys were successfully loaded, from which source,
// and when. Used by the Self-Healing Discovery (L1) to know when to retry
// discovery for native providers whose keys arrived late (GCP delay/failure).

export interface ProviderKeyStatus {
  loaded: boolean;
  source: 'gcp' | 'env' | 'none';
  timestamp: Date;
  envVar: string;
}

/**
 * Module-level state: populated during loadSecretsIntoEnv() for each provider.
 * Key = normalized provider name (lowercase, e.g., 'openai', 'anthropic').
 */
const providerKeyStatusMap = new Map<string, ProviderKeyStatus>();

/**
 * Mapping from env var name to normalized provider name.
 * Allows the discovery service to map env vars to provider sources.
 */
const ENV_VAR_TO_PROVIDER: Record<string, string> = {
  // Native API providers
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GOOGLE_API_KEY: 'google',
  DEEPSEEK_API_KEY: 'deepseek',
  XAI_API_KEY: 'xai',
  MISTRAL_API_KEY: 'mistral',
  COHERE_API_KEY: 'cohere',
  JINA_API_KEY: 'jina',
  // Cloud hubs — 2026-04-23: use canonical providerId 'nvidia' (legacy
  // alias 'nvidia-hub' was absorbed into the nvidia catalog row per Lot B;
  // discovery/status consumers read providerKeyStatus by canonical id).
  NVIDIA_API_KEY: 'nvidia',
  AIHUBMIX_API_KEY: 'aihubmix',
  NOVITA_API_KEY: 'novita',
  MOONSHOT_API_KEY: 'moonshot',
  MINIMAX_API_KEY: 'minimax',
  FRIENDLI_API_KEY: 'friendli',
  AIML_API_KEY: 'aiml',
  IMAGEROUTER_API_KEY: 'imagerouter',
  COMETAPI_API_KEY: 'cometapi',
  NANOGPT_API_KEY: 'nanogpt',
  EDENAI_API_KEY: 'edenai',
  HELICONEAI_API_KEY: 'heliconeai',
  POE_API_KEY: 'poe',
  ROUTEWAY_API_KEY: 'routeway',
  REQUESTY_API_KEY: 'requesty',
  // Post-migration canonical providerId is `ai302` (see providers.catalog.ts
  // and the residue-closure note in provider-registry.ts). Legacy `302ai`
  // survives as a catalog alias for pre-migration user configs.
  AI302_API_KEY: 'ai302',
  ORQAI_API_KEY: 'orqai',
  // Routers/aggregators
  OPENROUTER_API_KEY: 'openrouter',
  // Cloud providers
  VERTEX_AI_API_KEY: 'vertex-ai',
  AWS_ACCESS_KEY_ID: 'aws-bedrock',
  AWS_BEARER_TOKEN_BEDROCK: 'aws-bedrock',
  // SageMaker uses the same shared AWS creds as Bedrock, so `AWS_ACCESS_KEY_ID`
  // keeps mapping to `aws-bedrock` (first-listed wins) — but the endpoint-
  // specific env var is only meaningful for SageMaker. When operators wire
  // this, Self-Healing Discovery will attribute the key presence to the
  // SageMaker provider specifically.
  AWS_SAGEMAKER_ENDPOINT_NAME: 'aws-sagemaker',
  AZURE_OPENAI_API_KEY: 'azure-openai',
  // Regional/specialized
  QWEN_API_KEY: 'qwen',
  ERNIE_API_KEY: 'ernie',
  // Audio providers
  DEEPGRAM_API_KEY: 'deepgram',
  CARTESIA_API_KEY: 'cartesia',
  ELEVENLABS_API_KEY: 'elevenlabs',
  // Inference + embedding providers newly onboarded 2026-04-22
  WANDB_API_KEY: 'wandb',
  VOYAGE_API_KEY: 'voyage',
  BYTEZ_API_KEY: 'bytez',
  CEREBRAS_API_KEY: 'cerebras',
  FEATHERLESS_AI_API_KEY: 'featherless-ai', // canonical catalog id (2026-04-23 drift fix)
  // Batch 6 — enterprise hyperscaler gateways (2026-04-22). Gemini OAI-compat
  // is registered as a SEPARATE provider from the native `google` entry so
  // the self-healing discovery service can track them independently (they
  // have different failure modes — native uses @google/generative-ai SDK
  // with its own error surfaces; OAI-compat uses standard fetch).
  GEMINI_API_KEY: 'gemini-openai',
  GITHUB_TOKEN: 'github-models',
  DATABRICKS_TOKEN: 'databricks',
  // Orphan closure (2026-04-22) — Inworld now has a catalog row + adapter
  // factory. Mapping the env var to the provider slug lets Self-Healing
  // Discovery attribute key presence to the correct provider.
  INWORLD_API_KEY: 'inworld',
  // Orphan-closure Lot B (2026-04-23). Slug = catalog providerId. Writer
  // and Upstage are self-evident; Reka's slug is `rekaai` (the catalog
  // row's canonical providerId — aliases 'reka' + 'reka-ai' resolve to it).
  WRITER_API_KEY: 'writer',
  UPSTAGE_API_KEY: 'upstage',
  REKA_API_KEY: 'rekaai',
  // ── LOTE M (2026-04-23) — complement lot, 13 providers ──────────────
  // Slug = catalog providerId (NOT the upstream brand for phala/qianfan
  // which intentionally diverge — see catalog rows for rationale):
  //   phala    — canonical slug; upstream brand is "RedPill"
  //   qianfan  — canonical slug; upstream brand is "Baidu Qianfan / ERNIE"
  //   gmi      — canonical slug; upstream brand is "GMICloud"
  ARCEE_API_KEY: 'arcee',
  ATLASCLOUD_API_KEY: 'atlascloud',
  AVIAN_API_KEY: 'avian',
  QIANFAN_API_KEY: 'qianfan',
  GMI_API_KEY: 'gmi',
  INFERMATIC_API_KEY: 'infermatic',
  INFLECTION_API_KEY: 'inflection',
  MANCER_API_KEY: 'mancer',
  PHALA_API_KEY: 'phala',
  RELACE_API_KEY: 'relace',
  SILICONFLOW_API_KEY: 'siliconflow',
  STEPFUN_API_KEY: 'stepfun',
  VENICE_API_KEY: 'venice',
  // ── Sublote E1 (2026-04-24) — runtime-wiring closure for D1 matrix ───
  // 7 provider slugs whose env vars gained GCP→ENV tuples in this lot.
  // Slug = catalog providerId exactly (so Self-Healing Discovery can
  // attribute key-loaded events to the right provider). CLOUDFLARE_ACCOUNT_ID
  // is intentionally absent — that's a URL parameter, not an auth credential,
  // so mapping it to a provider slug would be semantically wrong (the same
  // account-id could conceivably scope multiple Cloudflare providers).
  GROQ_API_KEY: 'groq',
  DEEPINFRA_API_KEY: 'deepinfra',
  HF_TOKEN: 'huggingface',
  CLOUDFLARE_API_TOKEN: 'cloudflare-workers-ai',
  PERPLEXITY_API_KEY: 'perplexity',
  FIREWORKS_AI_API_KEY: 'fireworks-ai',
  SAMBANOVA_API_KEY: 'sambanova',
  // Replicate — pre-existing live-validation gap closed by sublote E1.
  // See the matching comment on the PROVIDER_SECRETS tuple above.
  REPLICATE_API_KEY: 'replicate',
  // ── LOTE N (2026-04-27) — catalog↔loader closure (22 new env vars) ──
  // Every entry below maps an env var to its canonical providerId so the
  // L1 Self-Healing Discovery Service can attribute key-loaded events
  // when the corresponding GCP secret is provisioned. Slugs match the
  // catalog providerId exactly (NOT upstream brand) — see catalog rows
  // for cases where they diverge (e.g. `sap` not `sap-ai-core`, `v0` not
  // `vercel-v0`, `volcano` not `volcengine`). Side-car env vars
  // (WATSONX_PROJECT_ID, SNOWFLAKE_ACCOUNT, SAP_AI_CORE_CLIENT_SECRET,
  // etc.) are NOT mapped here — they're auth or URL parameters, not
  // credentials, so attributing them to a provider would conflate
  // credential-presence with side-car-completeness in discovery telemetry.
  TOGETHERAI_API_KEY: 'togetherai',
  ANYSCALE_API_KEY: 'anyscale',
  HYPERBOLIC_API_KEY: 'hyperbolic',
  CHUTES_API_KEY: 'chutes',
  NSCALE_API_KEY: 'nscale',
  NEBIUS_API_KEY: 'nebius',
  LAMBDA_AI_API_KEY: 'lambda-ai',
  SCALEWAY_API_KEY: 'scaleway',
  SYNTHETIC_API_KEY: 'synthetic',
  MORPH_API_KEY: 'morph',
  ZAI_API_KEY: 'zai',
  XIAOMI_MIMO_API_KEY: 'xiaomi-mimo',
  V0_API_KEY: 'v0',
  VERCEL_AI_GATEWAY_API_KEY: 'vercel-ai-gateway',
  VOLCANO_API_KEY: 'volcano',
  WATSONX_APIKEY: 'watsonx',
  SNOWFLAKE_PAT: 'snowflake',
  SAP_AI_CORE_CLIENT_ID: 'sap',
  // Image / video-only providers. Still mapped to a slug so Self-Healing
  // Discovery can record key-presence events — but their env vars do NOT
  // appear in LLM_PROVIDER_ENV_VARS (image surfaces don't satisfy the
  // "at least one LLM key" boot gate).
  BFL_API_KEY: 'bfl',
  RECRAFT_API_KEY: 'recraft',
  RUNWAYML_API_KEY: 'runwayml',
  TOPAZ_API_KEY: 'topaz',
  // ── LOTE O (2026-07-10) ────────────────────────────────────────────────
  APERTIS_API_KEY: 'apertis',
  INCEPTION_API_KEY: 'inception',
  // ── LOTE P (2026-07-11) ────────────────────────────────────────────────
  EMPIRIOLABS_API_KEY: 'empiriolabs',
  // ── LOTE Q (2026-07-12) ────────────────────────────────────────────────
  CONCENTRATE_API_KEY: 'concentrate',
  // ── LOTE R (2026-07-13) ────────────────────────────────────────────────
  FASTROUTER_API_KEY: 'fastrouter',
  // ── LOTE S (2026-07-13) ────────────────────────────────────────────────
  PERPLEXITY_AGENT_API_KEY: 'perplexity-agent',
  // ── LOTE T (2026-07-13) ────────────────────────────────────────────────
  AILIN_API_KEY: 'ailin',
};

/**
 * Returns the status of all provider API keys.
 * Used by Self-Healing Discovery to determine which native sources can run.
 */
export function getProviderKeyStatus(): ReadonlyMap<string, ProviderKeyStatus> {
  return providerKeyStatusMap;
}

/**
 * Returns provider names that have valid (non-empty, non-mock) API keys loaded.
 */
export function getLoadedProviderNames(): string[] {
  return Array.from(providerKeyStatusMap.entries())
    .filter(([, status]) => status.loaded)
    .map(([name]) => name);
}

/**
 * Check if a specific provider has a loaded API key.
 */
export function isProviderKeyLoaded(providerName: string): boolean {
  return providerKeyStatusMap.get(providerName.toLowerCase())?.loaded ?? false;
}

const LLM_PROVIDER_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'NVIDIA_API_KEY',
  'AIHUBMIX_API_KEY',
  'NOVITA_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'JINA_API_KEY',
  'FRIENDLI_API_KEY',
  'AIML_API_KEY',
  'IMAGEROUTER_API_KEY',
  'OPENROUTER_API_KEY',
  'ORQAI_API_KEY',
  'EDENAI_API_KEY',
  'HELICONEAI_API_KEY',
  'VERTEX_AI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AZURE_OPENAI_API_KEY',
  'QWEN_API_KEY',
  'ERNIE_API_KEY',
  'COMETAPI_API_KEY',
  'NANOGPT_API_KEY',
  'REQUESTY_API_KEY',
  'AI302_API_KEY',
  'POE_API_KEY',
  'ROUTEWAY_API_KEY',
  // Added 2026-04-22 — these keys now count toward the "at least one LLM key
  // present" gate that avoids DEGRADED_SELF_HOSTED mode at boot.
  'WANDB_API_KEY',
  'VOYAGE_API_KEY',
  'CEREBRAS_API_KEY',
  'FEATHERLESS_AI_API_KEY',
  // Batch 4 landed BYTEZ catalog row + adapter, so BYTEZ_API_KEY now counts
  // toward the LLM-key-present gate.
  'BYTEZ_API_KEY',
  // Batch 6 — enterprise hyperscaler gateways (2026-04-22). These keys now
  // count toward the "at least one LLM key present" gate; all four have
  // landed catalog rows + adapter classes in this batch.
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'DATABRICKS_TOKEN',
  // Batch 8.1 — AWS SageMaker. Endpoint name is the meaningful trigger:
  // AWS creds alone are ambiguous (could be Bedrock or S3), but an
  // endpoint name implies "SageMaker is provisioned here".
  'AWS_SAGEMAKER_ENDPOINT_NAME',
  // Orphan closure (2026-04-22) — Inworld AI now counts toward the
  // "at least one LLM key present" gate now that the catalog row +
  // adapter factory are wired.
  'INWORLD_API_KEY',
  // Orphan-closure Lot B (2026-04-23). All three are fully canonical now.
  'WRITER_API_KEY',
  'UPSTAGE_API_KEY',
  'REKA_API_KEY',
  // ── LOTE M (2026-04-23) complement lot ──────────────────────────────
  // Each of the 13 keys below counts toward the "at least one LLM key
  // present" gate, the same way all catalog-wired keys do. Note that
  // mancer and venice carry contentPolicyClass=uncensored (2026-04-28
  // Phase 4b — the prior denyByDefault gate was removed per the universal
  // "habilitado e nunca censurado" policy); their keys count toward the
  // gate exactly like any other LLM key — surface-level filtering is now
  // a downstream concern, not a routing one.
  // qianfan here is QIANFAN_API_KEY (v2 bce-v3 bearer); the legacy v1
  // ERNIE_API_KEY was already listed above this marker.
  'ARCEE_API_KEY',
  'ATLASCLOUD_API_KEY',
  'AVIAN_API_KEY',
  'QIANFAN_API_KEY',
  'GMI_API_KEY',
  'INFERMATIC_API_KEY',
  'INFLECTION_API_KEY',
  'MANCER_API_KEY',
  'PHALA_API_KEY',
  'RELACE_API_KEY',
  'SILICONFLOW_API_KEY',
  'STEPFUN_API_KEY',
  'VENICE_API_KEY',
  // ── Sublote E1 (2026-04-24) — runtime-wiring closure for D1 matrix ───
  // These 7 providers landed in CONSOLIDATION_MATRIX['live-validation']
  // during Sublote D1 but had no GCP→ENV tuple above → their keys could
  // not count toward the "at least one LLM key present" gate even when
  // GCP Secret Manager held the key. Listed here so a restart after the
  // operator's provisioning cycle propagates the key-present signal to
  // the DEGRADED_SELF_HOSTED avoidance logic. CLOUDFLARE_ACCOUNT_ID is
  // intentionally absent — it's a URL parameter, not an LLM credential.
  'GROQ_API_KEY',
  'DEEPINFRA_API_KEY',
  'HF_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'PERPLEXITY_API_KEY',
  'FIREWORKS_AI_API_KEY',
  'SAMBANOVA_API_KEY',
  // Replicate — pre-existing live-validation gap closed by sublote E1.
  // See the matching comments on the PROVIDER_SECRETS tuple and
  // ENV_VAR_TO_PROVIDER entry above.
  'REPLICATE_API_KEY',
  // ── LOTE N (2026-04-27) — catalog↔loader closure ─────────────────────
  // 18 LLM-class providers added to the boot-mode gate. The 4 image/
  // video-only providers (bfl, recraft, runwayml, topaz) are
  // intentionally OMITTED — their key presence does not signal the
  // server has any text-generation capability, so they should not
  // satisfy the "at least one LLM key present" check.
  'TOGETHERAI_API_KEY',
  'ANYSCALE_API_KEY',
  'HYPERBOLIC_API_KEY',
  'CHUTES_API_KEY',
  'NSCALE_API_KEY',
  'NEBIUS_API_KEY',
  'LAMBDA_AI_API_KEY',
  'SCALEWAY_API_KEY',
  'SYNTHETIC_API_KEY',
  'MORPH_API_KEY',
  'ZAI_API_KEY',
  'XIAOMI_MIMO_API_KEY',
  'V0_API_KEY',
  'VERCEL_AI_GATEWAY_API_KEY',
  'VOLCANO_API_KEY',
  'WATSONX_APIKEY',
  'SNOWFLAKE_PAT',
  'SAP_AI_CORE_CLIENT_ID',
  // ── LOTE O (2026-07-10) — Apertis + Inception Labs, both chat-capable ──
  'APERTIS_API_KEY',
  'INCEPTION_API_KEY',
  // ── LOTE P (2026-07-11) — EmpirioLabs AI, chat-capable ─────────────────
  'EMPIRIOLABS_API_KEY',
  // ── LOTE Q (2026-07-12) — Concentrate AI, chat-capable ─────────────────
  'CONCENTRATE_API_KEY',
  // ── LOTE R (2026-07-13) — FastRouter, chat-capable ─────────────────────
  'FASTROUTER_API_KEY',
  // ── LOTE S (2026-07-13) — Perplexity Agent API, chat-capable ───────────
  'PERPLEXITY_AGENT_API_KEY',
  // ── LOTE T (2026-07-13) — Ailin gateway, chat-capable ──────────────────
  'AILIN_API_KEY',
] as const;

/**
 * Self-hosted / sidecar endpoints that can keep the server alive in a
 * DEGRADED mode when every external LLM API key is missing.
 *
 * Design rationale:
 *   Without this fallback, a single failure (expired GCP ADC, rotated
 *   service account, network blip during boot) produces an infinite
 *   restart loop. With it, the server boots in `degraded_self_hosted`
 *   mode: only local/sidecar models are usable, requests are tagged
 *   via last-resort-policy.ts (execution_mode=last_resort_self_hosted,
 *   excluded_from_benchmark=true), and ops gets a clear warning
 *   instead of a crash loop.
 *
 *   This ties directly into Bloco P1.10 (self-hosted last-resort policy)
 *   but at boot-time scope rather than per-request scope.
 */
const SELF_HOSTED_ENV_VARS = [
  'OLLAMA_URL',
  'SELF_HOSTED_LLM_URL',
  'LOCAL_LLAMA_URL',
  'LOCAL_KOBOLD_URL',
] as const;

/**
 * Load critical secrets from GCP into process.env
 * 
 * This function is called AFTER SecretsManager initialization
 * and BEFORE config validation.
 * 
 * It loads secrets from GCP and injects them into process.env,
 * allowing the existing config system to work without modification.
 */
export async function loadSecretsIntoEnv(): Promise<void> {
  const log = logger.child({ component: 'secrets-loader' });

  log.info('Loading critical secrets from GCP Secret Manager into environment...');

  let loaded = 0;
  let skipped = 0;
  let failed = 0;
  let sanitizedKeys = 0;
  let providerSecretsLoaded = 0;
  // Tracks env values that were authoritatively replaced by GCP fetches.
  // Useful diagnostic for operators verifying that GCP is the source of truth.
  let overwrittenFromGcp = 0;

  const forceLoadRealKeys = process.env.TEST_USE_REAL_API_KEYS === 'true';

  // ── GCP-authoritative mode ─────────────────────────────────────────────
  // When SECRETS_PROVIDER_PRIMARY=gcp the operator has declared GCP as the
  // source of truth. The legacy "skip if env already populated" path then
  // contradicts that declaration: env_file / docker-compose / shell exports
  // silently win and GCP fetches are never even attempted, which is exactly
  // the failure mode that hid populated GCP secrets (e.g. HF_TOKEN) from
  // /v1/models. In authoritative mode we ALWAYS attempt the GCP fetch and
  // overwrite the pre-existing env value when GCP returns one. The fallback
  // is symmetric: a GCP miss preserves the existing env value (no zeroing).
  //
  // Operators can override:
  //   SECRETS_GCP_AUTHORITATIVE=false → keep legacy skip-if-exists semantics
  //   SECRETS_GCP_AUTHORITATIVE=true  → force authoritative even with env primary
  const gcpPrimaryEnv = (process.env.SECRETS_PROVIDER_PRIMARY || '').trim().toLowerCase() === 'gcp';
  const explicitAuthoritative = (process.env.SECRETS_GCP_AUTHORITATIVE || '').trim().toLowerCase();
  const gcpAuthoritative =
    explicitAuthoritative === 'true' ||
    (explicitAuthoritative !== 'false' && gcpPrimaryEnv);

  // Tests already use TEST_USE_REAL_API_KEYS=true to force GCP fetches even
  // when local mocks are present. The two flags are independent triggers
  // for the same effect; either one disables skip-if-exists.
  const authoritativeFetch = gcpAuthoritative || forceLoadRealKeys;

  log.info(
    {
      gcpPrimary: gcpPrimaryEnv,
      gcpAuthoritative,
      forceLoadRealKeys,
      authoritativeFetch,
    },
    'Secret loading mode resolved'
  );

  // Load critical secrets (required)
  for (const { envVar, secretKey, required, defaultValue } of CRITICAL_SECRETS) {
    const existingValue = process.env[envVar];
    const shouldOverrideMockStripe =
      forceLoadRealKeys &&
      envVar.startsWith('STRIPE_') &&
      typeof existingValue === 'string' &&
      (existingValue.includes('mock') || existingValue.includes('test'));

    // Skip if already in env, UNLESS:
    //  - we're in GCP-authoritative mode (operator declared GCP as source of truth), OR
    //  - we're forcing real keys and detected mock Stripe keys.
    if (existingValue && !shouldOverrideMockStripe && !gcpAuthoritative) {
      log.debug({ envVar, source: 'env' }, 'Secret already in environment, skipping GCP load');
      skipped++;
      continue;
    }

    try {
      const value = await loadSecret(secretKey, required);
      if (value) {
        const wasOverwrite = Boolean(existingValue) && existingValue !== value;
        process.env[envVar] = value;
        if (wasOverwrite) overwrittenFromGcp++;
        log.debug(
          { envVar, secretKey, replaced: Boolean(existingValue), overwrittenFromGcp: wasOverwrite },
          'Secret loaded from GCP into environment'
        );
        loaded++;
      } else if (existingValue && gcpAuthoritative) {
        // Authoritative fetch missed in GCP — fall back to the existing env
        // value rather than zeroing it. This keeps the system bootable when
        // a single secret is absent from GCP without losing the env-provided
        // value.
        log.debug(
          { envVar, secretKey },
          'GCP miss in authoritative mode; preserving existing env value'
        );
        skipped++;
      } else if (defaultValue !== undefined) {
        // Use default value if secret not found and default provided
        process.env[envVar] = defaultValue;
        log.debug({ envVar, secretKey, defaultValue }, 'Secret not found, using default value');
        skipped++;
      } else if (!required) {
        log.debug({ envVar, secretKey }, 'Optional secret not found, skipping');
        skipped++;
      }
    } catch (error) {
      if (defaultValue !== undefined) {
        // Use default value on error if provided
        process.env[envVar] = defaultValue;
        log.warn({ envVar, secretKey, defaultValue, error: getErrorMessage(error) }, 'Failed to load secret, using default value');
        skipped++;
      } else if (required) {
        const errorMsg = getErrorMessage(error);
        log.error(
          { envVar, secretKey, error: errorMsg },
          'Failed to load required secret'
        );
        failed++;
        throw new Error(`Failed to load required secret ${secretKey}: ${errorMsg}`);
      } else {
        log.warn({ envVar, secretKey, error: getErrorMessage(error) }, 'Failed to load optional secret');
        skipped++;
      }
    }
  }

  // Keep compatibility with components that still read GCS_BUCKET_NAME.
  if (!process.env.GCS_BUCKET_NAME && process.env.GCS_FILES_BUCKET) {
    process.env.GCS_BUCKET_NAME = process.env.GCS_FILES_BUCKET;
  }

  // Load provider API keys (optional)
  // CRITICAL: If GCP auth is available, ALWAYS load real keys (API Keys NUNCA DEVEM FALHAR)
  // If TEST_USE_REAL_API_KEYS=true, force load from GCP even if mock keys exist
  // Always replace mock keys with real keys from GCP when available
  // (reuses forceLoadRealKeys defined above)
  
  for (const { envVar, secretKeys } of PROVIDER_SECRETS) {
    const existingValue = process.env[envVar];
    const providerName = ENV_VAR_TO_PROVIDER[envVar];

    // Check if existing value looks like a mock key
    const isMockKey = existingValue && (existingValue.includes('mock') || existingValue.includes('test-'));

    // Skip if real key already exists, UNLESS:
    //  - we're in GCP-authoritative mode (operator declared GCP as source of truth), OR
    //  - test forces real keys (TEST_USE_REAL_API_KEYS=true), OR
    //  - the existing value looks like a mock.
    // The authoritative path lets GCP overwrite stale env_file / shell-exported
    // values, which is the entire point of SECRETS_PROVIDER_PRIMARY=gcp.
    if (existingValue && !authoritativeFetch && !isMockKey) {
      // Record as loaded from env
      if (providerName) {
        providerKeyStatusMap.set(providerName, { loaded: true, source: 'env', timestamp: new Date(), envVar });
      }
      skipped++;
      continue;
    }

    try {
      let loadedSecretValue: string | undefined;
      let resolvedSecretKey = secretKeys[0];

      for (const candidateKey of secretKeys) {
        try {
          const candidateValue = await loadSecret(candidateKey, false);
          if (candidateValue) {
            loadedSecretValue = candidateValue;
            resolvedSecretKey = candidateKey;
            log.debug({ envVar, secretKey: candidateKey, valueLen: candidateValue.length }, 'Secret loaded from GCP');
            break;
          } else {
            log.debug({ envVar, secretKey: candidateKey }, 'Secret returned empty/null from GCP');
          }
        } catch (loadErr) {
          log.warn({ envVar, secretKey: candidateKey, error: loadErr instanceof Error ? loadErr.message : String(loadErr) }, 'Failed to load secret from GCP');
          continue;
        }
      }

      // GCP provider automatically adds prefix 'ailin-' to secretKey
      // So 'openai-key' becomes 'ailin-openai-key' in GCP Secret Manager
      const value = loadedSecretValue;
      if (value) {
        // Sanitize control characters and invisible Unicode.
        // PEM-format keys (-----BEGIN ...) legitimately contain newlines,
        // so use a lighter regex that preserves \n and \r for those values.
        const isPemKey = value.startsWith('-----BEGIN');
        let sanitizedValue = isPemKey
          ? value
              .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '') // Strip control chars EXCEPT \n (0x0A) and \r (0x0D)
              .replace(/[\u200B-\u200D\uFEFF]/g, '')              // Remove zero-width spaces
              .trim()
          : value
              .replace(/[\x00-\x1F\x7F]/g, '')                    // Strip ALL control characters
              .replace(/[\u200B-\u200D\uFEFF]/g, '')              // Remove zero-width spaces
              .trim();
        
        // Log detailed debugging information if sanitization changed the value
        if (sanitizedValue !== value) {
          const removedChars = value.length - sanitizedValue.length;
          sanitizedKeys++;
          log.debug(
            { 
              envVar, 
              secretKey: resolvedSecretKey,
              originalLength: value.length, 
              sanitizedLength: sanitizedValue.length,
              removedChars
            },
            'API key contained invalid characters and was sanitized'
          );
        }
        
        // Always replace mock keys with real keys
        const wasReplaced = !!existingValue;
        const wasOverwriteOfRealValue =
          wasReplaced && !isMockKey && existingValue !== sanitizedValue;

        // CRITICAL: Set process.env and immediately validate
        // Use Object.defineProperty as fallback if direct assignment doesn't work
        // This ensures the value is actually set in the environment
        const _previousValue = process.env[envVar];
        process.env[envVar] = sanitizedValue;

        // Immediately read back to verify (handles any potential async issues)
        const readBackValue = process.env[envVar];

        // Deep validation: check exact match, type, and length
        const isValidMatch = readBackValue === sanitizedValue;
        const isValidType = typeof readBackValue === 'string';
        const isValidLength = readBackValue !== undefined && readBackValue.length === sanitizedValue.length;

        if (!isValidMatch || !isValidType || !isValidLength) {
          log.error(
            {
              envVar,
              secretKey: resolvedSecretKey,
              sanitizedValueLength: sanitizedValue.length,
              readBackValueLength: readBackValue?.length,
            },
            'Secret was loaded but process.env assignment did not persist'
          );
          failed++;
        } else {
          // Success - log and increment counter
          if (wasOverwriteOfRealValue) overwrittenFromGcp++;
          log.debug(
            {
              envVar,
              secretKey: resolvedSecretKey,
              replaced: wasReplaced,
              wasMock: isMockKey,
              overwrittenFromGcp: wasOverwriteOfRealValue,
            },
            'Provider secret loaded from GCP'
          );
          loaded++;
          providerSecretsLoaded++;
          // Record successful load
          if (providerName) {
            providerKeyStatusMap.set(providerName, { loaded: true, source: 'gcp', timestamp: new Date(), envVar });
          }
        }
      } else {
        // GCP returned no value. Decide what's actually in process.env right
        // now: if env had a non-mock value before this loop iteration we
        // preserved it (the authoritative path entered this block but found
        // no GCP value to overwrite with), so we're effectively env-loaded.
        // If env had a mock value, we keep the mock as a degraded fallback
        // and warn loudly. If env had nothing, the provider stays orphaned.
        if (existingValue && !isMockKey) {
          // Authoritative-mode GCP miss with real env value already set:
          // the env value is still in process.env, so report source=env.
          if (providerName) {
            providerKeyStatusMap.set(providerName, { loaded: true, source: 'env', timestamp: new Date(), envVar });
          }
          log.debug(
            { envVar, secretKeys },
            'GCP miss in authoritative mode; preserving existing env value for provider'
          );
        } else {
          if (isMockKey) {
            log.warn(
              { envVar, secretKeys },
              'Mock API key detected but no real key found in GCP - using mock key (this may cause API failures)'
            );
          }
          // Record as not loaded (no GCP value, no usable env value)
          if (providerName) {
            providerKeyStatusMap.set(providerName, { loaded: false, source: 'none', timestamp: new Date(), envVar });
          }
        }
        skipped++;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Only warn if not forcing real keys - if forcing, this is expected to work
      if (forceLoadRealKeys) {
        log.error(
          { envVar, secretKeys, error: errorMessage },
          'Failed to load provider secret from GCP (TEST_USE_REAL_API_KEYS=true)'
        );
        failed++;
      } else {
        if (isMockKey) {
          log.warn(
            { envVar, secretKeys, error: errorMessage },
            'Failed to load provider secret from GCP - will use mock key (this may cause API failures)'
          );
        } else {
          log.debug(
            { envVar, secretKeys, error: errorMessage },
            'Failed to load provider secret from GCP (optional)'
          );
        }
        // Record failure
        if (providerName) {
          providerKeyStatusMap.set(providerName, { loaded: false, source: 'none', timestamp: new Date(), envVar });
        }
        skipped++;
      }
    }
  }

  // ── Env-var aliases (2026-04-28) ────────────────────────────────────────
  //
  // Some operators set a non-canonical name in `.env` for historical reasons
  // (e.g. `REKAAI_API_KEY` instead of the catalog-canonical `REKA_API_KEY`).
  // When GCP is reachable the secret loader populates the canonical name and
  // it just works; when GCP is unreachable the alias would be the only thing
  // set and the catalog row reads the canonical → empty key → silent skip.
  //
  // This pass copies known aliases into their canonical env var if the
  // canonical is empty. It is purely additive — never overwrites an
  // existing canonical value, never logs a warning unless an alias was
  // applied. Add new entries here when a similar mismatch is discovered.
  const ENV_ALIASES: ReadonlyArray<{ canonical: string; alias: string }> = [
    { canonical: 'REKA_API_KEY', alias: 'REKAAI_API_KEY' },
  ];
  for (const { canonical, alias } of ENV_ALIASES) {
    const canonicalValue = process.env[canonical];
    const aliasValue = process.env[alias];
    if ((canonicalValue == null || canonicalValue.trim() === '') && aliasValue && aliasValue.trim() !== '') {
      process.env[canonical] = aliasValue;
      log.info({ canonical, alias }, 'Promoted alias env var to canonical name');
    }
  }

  const gcpPrimary = (process.env.SECRETS_PROVIDER_PRIMARY || '').trim().toLowerCase() === 'gcp';
  const failFastEnv = (process.env.SECRETS_GCP_FAIL_FAST || '').trim().toLowerCase();
  const gcpFailFast = failFastEnv === 'true' || (failFastEnv !== 'false' && gcpPrimary);
  const hasAnyLlmProviderKey = LLM_PROVIDER_ENV_VARS.some((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.trim().length > 0;
  });

  // Hardening (P1.10 at boot scope): even when zero external API keys are
  // loaded, the server can still boot in DEGRADED mode if a self-hosted
  // endpoint is reachable. Every request will then be tagged via the
  // last-resort-policy as execution_mode=last_resort_self_hosted.
  const availableSelfHostedEndpoints = SELF_HOSTED_ENV_VARS.filter((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.trim().length > 0;
  });
  const hasAnySelfHostedFallback = availableSelfHostedEndpoints.length > 0;

  // Opt-out for strict production deployments that must never run in
  // degraded mode. Default: allow degraded boot (safer than crash loops).
  const allowDegradedBoot = (process.env.ALLOW_DEGRADED_BOOT || 'true').trim().toLowerCase() !== 'false';

  if (gcpFailFast && !hasAnyLlmProviderKey) {
    if (hasAnySelfHostedFallback && allowDegradedBoot) {
      log.warn(
        {
          gcpPrimary,
          gcpFailFast,
          providerSecretsLoaded,
          selfHostedEndpoints: availableSelfHostedEndpoints,
          mode: 'degraded_self_hosted',
          docs: 'docs/hardening/last-resort-policy',
        },
        '⚠️ DEGRADED BOOT: zero external LLM credentials, but self-hosted fallback is available. ' +
        'Server will start in last-resort mode. Requests will be tagged excluded_from_benchmark. ' +
        'Fix ADC/GCP credentials to restore full operation.'
      );
      // Intentionally fall through — boot continues
    } else {
      const message = hasAnySelfHostedFallback
        ? 'SECRETS_PROVIDER_PRIMARY=gcp, no LLM provider credentials loaded, and ALLOW_DEGRADED_BOOT=false.'
        : 'SECRETS_PROVIDER_PRIMARY=gcp but no LLM provider credentials are available after secrets bootstrap, ' +
          'and no self-hosted fallback endpoints (OLLAMA_URL, SELF_HOSTED_LLM_URL, LOCAL_LLAMA_URL, LOCAL_KOBOLD_URL) are configured.';
      log.error(
        {
          gcpPrimary,
          gcpFailFast,
          providerSecretsLoaded,
          checkedEnvVars: LLM_PROVIDER_ENV_VARS,
          selfHostedEndpointsChecked: SELF_HOSTED_ENV_VARS,
          allowDegradedBoot,
        },
        message
      );
      throw new Error(
        `${message} Verify GCP Secret Manager access (ADC/Workload Identity) and secret names/prefix, ` +
        `or set OLLAMA_URL for degraded self-hosted boot, or run 'gcloud auth application-default login' if local.`
      );
    }
  }

  // Warn on partial provider key loading — helps detect GCP issues early
  if (hasAnyLlmProviderKey && providerSecretsLoaded > 0 && providerSecretsLoaded < 3) {
    log.warn(
      { providerSecretsLoaded, total: PROVIDER_SECRETS.length },
      `⚠️ Only ${providerSecretsLoaded} provider secrets loaded — possible partial GCP failure`
    );
  }

  // Audio provider diagnostics
  const audioProviders = {
    DEEPGRAM_API_KEY: !!process.env.DEEPGRAM_API_KEY,
    CARTESIA_API_KEY: !!process.env.CARTESIA_API_KEY,
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    OLLAMA_URL: process.env.OLLAMA_URL || '',
    SELF_HOSTED_STT_URL: process.env.SELF_HOSTED_STT_URL || '',
    LOCAL_NLLB_URL: process.env.LOCAL_NLLB_URL || '',
  };
  log.info({ audioProviders }, 'Audio provider env vars after secrets loading');

  log.info(
    {
      loaded,
      skipped,
      failed,
      sanitizedKeys,
      providerSecretsLoaded,
      overwrittenFromGcp,
      gcpAuthoritative,
      total: CRITICAL_SECRETS.length + PROVIDER_SECRETS.length,
    },
    '✅ Secrets loading complete'
  );

  if (failed > 0) {
    throw new Error(`Failed to load ${failed} required secrets`);
  }
}

/**
 * Get summary of secrets loaded.
 *
 * Diagnostic helper for admin endpoints (e.g. /v1/admin/providers/...) that
 * surfaces exactly which provider envVars are populated and from where, so
 * operators can verify SECRETS_PROVIDER_PRIMARY=gcp is actually authoritative
 * and not silently shadowed by stale env values.
 */
export function getSecretsLoadSummary(): {
  fromGCP: string[];
  fromEnv: string[];
  notLoaded: string[];
} {
  const fromGCP: string[] = [];
  const fromEnv: string[] = [];
  const notLoaded: string[] = [];

  for (const status of providerKeyStatusMap.values()) {
    if (!status.loaded) {
      notLoaded.push(status.envVar);
      continue;
    }
    if (status.source === 'gcp') {
      fromGCP.push(status.envVar);
    } else if (status.source === 'env') {
      fromEnv.push(status.envVar);
    }
  }

  return { fromGCP, fromEnv, notLoaded };
}
