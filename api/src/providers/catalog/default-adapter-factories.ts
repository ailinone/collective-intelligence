// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Default adapter factory registrations.
 *
 * Each factory here is a tiny, declarative binding from a catalog
 * `adapterClass` string to a concrete adapter constructor. This file is the
 * single point where the catalog learns which dedicated adapter classes
 * exist — adding a new one is: create the adapter class, add one entry
 * here, point the catalog row at it.
 *
 * ### Module shape
 *
 * All registrations happen inside `registerDefaultAdapterFactories()` so the
 * act of registering has an explicit call site that `catalog-loader` invokes
 * at boot. Registering at module import time would couple load order to
 * import order in ways tests can't reset reliably.
 *
 * ### Idempotency
 *
 * Safe to call many times. Duplicate registrations are logged-and-ignored
 * by `registerAdapterFactory` itself — we just call it once per factory.
 */

import {
  registerAdapterFactory,
  type AdapterFactory,
  type AdapterFactoryContext,
} from './adapter-factory-registry';

import { VoyageAdapter } from '../voyage/voyage-adapter';
import { WatsonxAdapter } from '../watsonx/watsonx-adapter';
import { GroqAdapter } from '../groq/groq-adapter';
import { PerplexityAdapter } from '../perplexity/perplexity-adapter';
import { CerebrasAdapter } from '../cerebras/cerebras-adapter';
import { SambanovaAdapter } from '../sambanova/sambanova-adapter';
import { VercelAIGatewayAdapter } from '../vercel-ai-gateway/vercel-ai-gateway-adapter';
import { VolcanoAdapter } from '../volcano/volcano-adapter';
// Batch 2 — media specialists + W&B
import { WandbAdapter } from '../wandb/wandb-adapter';
import { RecraftAdapter } from '../recraft/recraft-adapter';
import { RunwayMLAdapter } from '../runwayml/runwayml-adapter';
import { TopazAdapter } from '../topaz/topaz-adapter';
// Batch 3 — enterprise auth + self-hosted + Xiaomi
import { SnowflakeCortexAdapter } from '../snowflake/snowflake-cortex-adapter';
import { SapAiCoreAdapter } from '../sap/sap-ai-core-adapter';
import { VllmAdapter } from '../vllm/vllm-adapter';
import { LmStudioAdapter } from '../lmstudio/lmstudio-adapter';
import { XinferenceAdapter } from '../xinference/xinference-adapter';
import { XiaomiMimoAdapter } from '../xiaomi/xiaomi-mimo-adapter';
// Batch 4 — orphan adapter wiring + ecosystem hubs + KServe
import { ReplicateAdapter } from '../replicate/replicate-adapter';
import { BytezAdapter } from '../bytez/bytez-adapter';
import { HuggingFaceInferenceAdapter } from '../huggingface/huggingface-inference-adapter';
import { TritonAdapter } from '../triton/triton-adapter';
// Batch 5 — edge-scoped OAI + dedicated Ollama
import { CloudflareWorkersAIAdapter } from '../cloudflare/cloudflare-workers-ai-adapter';
import { OllamaAdapter } from '../ollama/ollama-adapter';
// Batch 6 — enterprise hyperscaler gateways
import { AzureOpenAIAdapter } from '../azure/azure-openai-adapter';
import { GeminiOpenAIAdapter } from '../gemini-openai/gemini-openai-adapter';
import { GitHubModelsAdapter } from '../github-models/github-models-adapter';
import { DatabricksAdapter } from '../databricks/databricks-adapter';
// Lot A — close out providers with GCP secrets wired (+ dedicated observability).
import { FeatherlessAdapter } from '../featherless/featherless-adapter';
// Orphan closure (2026-04-22) — InworldAdapter existed on disk but was never
// instantiated. Catalog row + factory registration close the orphan.
import { InworldAdapter } from '../inworld/inworld-adapter';
// Orphan closure (2026-04-23) — Lot B. Writer, Upstage, Reka all had adapter
// classes on disk and working keys in GCP but no catalog row + no factory
// registration. Same failure mode as Inworld 2026-04-22.
import { WriterAdapter } from '../writer/writer-adapter';
import { UpstageAdapter } from '../upstage/upstage-adapter';
import { RekaAIAdapter } from '../rekaai/rekaai-adapter';
// Image-only async-job specialist (2026-04-29) — BFL/FLUX. Same async pattern
// as Topaz/Runway: submit → poll → download.
import { BflAdapter } from '../bfl/bfl-adapter';
// AWS Bedrock (2026-05-06) — orphan closure. AwsBedrockAdapter existed at
// providers/aws-bedrock/ and a legacy switch-case path in provider-registry.ts
// constructed it, but no config.providers entry had `name: 'aws-bedrock'`,
// so the legacy path was unreachable. Adding the catalog row + this factory
// closes the gap (same pattern as Inworld/Writer/Upstage/Reka/Bfl).
import { AWSBedrockAdapter } from '../aws-bedrock/aws-bedrock-adapter';
// LOTE O (2026-07-10) — Apertis (gateway) + Inception Labs (first-party
// dLLM). Both are thin hub extensions; the value-add is in the request/
// response quirks each class encodes (see the adapter files themselves).
import { ApertisAdapter } from '../apertis/apertis-adapter';
import { InceptionAdapter } from '../inception/inception-adapter';
// LOTE S (2026-07-13) — Perplexity Agent API. Genuinely non-OAI wire shape
// (Responses-style input/output) requires overriding chatCompletion/
// chatCompletionStream — see the adapter file for the full rationale.
import { PerplexityAgentAdapter } from '../perplexity-agent/perplexity-agent-adapter';

/**
 * Convert the factory context into the `OpenAICompatibleHubAdapterConfig`
 * shape that hub-extending adapters consume. Kept private here so the
 * individual factory closures stay readable.
 */
function buildHubConfig(ctx: AdapterFactoryContext) {
  return {
    name: ctx.entry.providerId,
    enabled: true,
    providerName: ctx.entry.providerId,
    displayName: ctx.entry.displayName,
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    metadata: {
      authHeaderName: ctx.entry.authHeaderName,
      authScheme:
        ctx.entry.authScheme === 'bearer'
          ? 'Bearer'
          : ctx.entry.authScheme === 'api-key-header'
            ? ''
            : ctx.entry.authScheme === 'none'
              ? undefined
              : 'Bearer',
      extraHeaders: ctx.extraHeaders
        ? { ...ctx.extraHeaders }
        : ctx.entry.extraHeaders
          ? { ...ctx.entry.extraHeaders }
          : undefined,
      chatCompletionsPath: ctx.entry.paths?.chatCompletions,
      embeddingsPath: ctx.entry.paths?.embeddings,
      moderationsPath: ctx.entry.paths?.moderation,
      videosPath: ctx.entry.paths?.videoGenerate,
      videoPollPath: ctx.entry.paths?.videoPoll,
      videoRequestStyle: ctx.entry.videoRequestStyle,
      imagesPath: ctx.entry.paths?.imagesGenerate,
      imagesEditsPath: ctx.entry.paths?.imagesEdit,
      audioSpeechPath: ctx.entry.paths?.audioSpeech,
      audioTranscriptionsPath: ctx.entry.paths?.audioTranscriptions,
      modelListPath: ctx.entry.paths?.modelList?.[0],
      apiKeyOptional: ctx.entry.apiKeyOptional === true,
    },
  };
}

// ─── Factory bindings ───────────────────────────────────────────────────

const voyageFactory: AdapterFactory = (ctx) =>
  new VoyageAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

const watsonxFactory: AdapterFactory = (ctx) =>
  new WatsonxAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    projectId: process.env.WATSONX_PROJECT_ID,
  });

const groqFactory: AdapterFactory = (ctx) => new GroqAdapter(buildHubConfig(ctx));
const perplexityFactory: AdapterFactory = (ctx) => new PerplexityAdapter(buildHubConfig(ctx));
const cerebrasFactory: AdapterFactory = (ctx) => new CerebrasAdapter(buildHubConfig(ctx));
const sambanovaFactory: AdapterFactory = (ctx) => new SambanovaAdapter(buildHubConfig(ctx));
const vercelFactory: AdapterFactory = (ctx) => new VercelAIGatewayAdapter(buildHubConfig(ctx));
const volcanoFactory: AdapterFactory = (ctx) => new VolcanoAdapter(buildHubConfig(ctx));

// ── Batch 2 ──────────────────────────────────────────────────────────────
// W&B is a hub extension (OAI-compat) that injects `wandb-project` header.
const wandbFactory: AdapterFactory = (ctx) => new WandbAdapter(buildHubConfig(ctx));

// Media specialists — direct extensions (non-OAI surfaces).
const recraftFactory: AdapterFactory = (ctx) =>
  new RecraftAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

const runwaymlFactory: AdapterFactory = (ctx) =>
  new RunwayMLAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    // apiVersion override: catalog `extraHeaders['X-Runway-Version']` wins if set,
    // otherwise adapter uses DEFAULT_API_VERSION. Both are acceptable.
    apiVersion:
      ctx.entry.extraHeaders?.['X-Runway-Version'] ||
      ctx.extraHeaders?.['X-Runway-Version'] ||
      undefined,
  });

const topazFactory: AdapterFactory = (ctx) =>
  new TopazAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

// ── Batch 3 ──────────────────────────────────────────────────────────────
// Enterprise auth: direct-extension (non-OAI wire + custom token exchange).
const snowflakeFactory: AdapterFactory = (ctx) =>
  new SnowflakeCortexAdapter({
    apiKey: ctx.apiKey, // Snowflake PAT — not used for signing but kept for compat
    baseUrl: ctx.baseUrl,
    account: process.env.SNOWFLAKE_ACCOUNT,
    user: process.env.SNOWFLAKE_USER,
    privateKeyPem: process.env.SNOWFLAKE_PRIVATE_KEY_PEM,
    privateKeyPassphrase: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
  });

const sapFactory: AdapterFactory = (ctx) =>
  new SapAiCoreAdapter({
    apiKey: ctx.apiKey, // treated as clientId if SAP_AI_CORE_CLIENT_ID unset
    baseUrl: ctx.baseUrl,
    authUrl: process.env.SAP_AI_CORE_AUTH_URL,
    clientId: process.env.SAP_AI_CORE_CLIENT_ID,
    clientSecret: process.env.SAP_AI_CORE_CLIENT_SECRET,
    resourceGroup: process.env.SAP_AI_CORE_RESOURCE_GROUP,
  });

// Self-hosted OAI-compat — hub-extending thin wrappers.
const vllmFactory: AdapterFactory = (ctx) => new VllmAdapter(buildHubConfig(ctx));
const lmStudioFactory: AdapterFactory = (ctx) => new LmStudioAdapter(buildHubConfig(ctx));
const xinferenceFactory: AdapterFactory = (ctx) => new XinferenceAdapter(buildHubConfig(ctx));
const xiaomiFactory: AdapterFactory = (ctx) => new XiaomiMimoAdapter(buildHubConfig(ctx));

// ── Batch 4 ──────────────────────────────────────────────────────────────
// Replicate — direct extension (predictions API, not OAI). The adapter
// pre-dates catalog migration; only the factory+row were missing.
// ReplicateAdapter uses the richer `ProviderConfig` from @/types (requires
// `name` + `enabled`), unlike the base-adapter ProviderConfig used by
// Snowflake/SAP/Triton. Keep this factory explicit until that split is
// unified in Batch 5+.
const replicateFactory: AdapterFactory = (ctx) =>
  new ReplicateAdapter({
    name: ctx.entry.providerId,
    enabled: true,
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

// Bytez + HuggingFace — hub-extending (OAI-compat).
const bytezFactory: AdapterFactory = (ctx) => new BytezAdapter(buildHubConfig(ctx));
const huggingfaceFactory: AdapterFactory = (ctx) =>
  new HuggingFaceInferenceAdapter(buildHubConfig(ctx));

// Triton — direct extension (KServe v2 protocol). Input tensor name can be
// overridden by operators via the catalog row's extraHeaders in future; for
// now, the adapter's own default ("TEXT") handles the common BGE/E5 deploys.
const tritonFactory: AdapterFactory = (ctx) =>
  new TritonAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

// ── Batch 5 ──────────────────────────────────────────────────────────────
// Cloudflare Workers AI — hub-extending with account-scoped URL substitution
// at construction time. The `baseUrl` in the catalog row is a template; the
// adapter replaces `{account_id}` with CLOUDFLARE_ACCOUNT_ID from env, or
// fails loudly with a sentinel URL that produces a visible 403 on first call.
const cloudflareFactory: AdapterFactory = (ctx) => {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  // Don't pass the catalog's templated baseUrl — the adapter synthesizes a
  // real URL from accountId. Passing the template string would bypass that
  // synthesis and ship the literal `{account_id}` to the wire (404).
  const hubConfig = buildHubConfig(ctx);
  return new CloudflareWorkersAIAdapter({
    ...hubConfig,
    accountId,
    // Replace the templated baseUrl with the computed one. Operators
    // overriding via CLOUDFLARE_WORKERS_AI_BASE_URL or the catalog's
    // baseUrlEnvVar still win — the adapter honors config.baseUrl first.
    baseUrl:
      hubConfig.baseUrl && !hubConfig.baseUrl.includes('{account_id}')
        ? hubConfig.baseUrl
        : undefined,
  });
};

// Ollama — hub-extending thin wrapper. Pure identity + apiKeyOptional default.
const ollamaFactory: AdapterFactory = (ctx) => new OllamaAdapter(buildHubConfig(ctx));

// ── Batch 6 ──────────────────────────────────────────────────────────────
// Enterprise hyperscaler gateways. Each adapter handles its own URL
// composition; the factory's job is just to thread env-var config through
// and avoid passing the catalog's templated baseUrl to the adapter (same
// guard pattern as Cloudflare in Batch 5).

// Azure OpenAI — deployment-scoped URL. Reads resource + deployment + api
// version from env; catalog baseUrl is a template that we DON'T pass through.
const azureOpenAIFactory: AdapterFactory = (ctx) => {
  const hubConfig = buildHubConfig(ctx);
  return new AzureOpenAIAdapter({
    ...hubConfig,
    resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME || process.env.AZURE_OPENAI_RESOURCE,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    // Drop the templated baseUrl — adapter synthesizes from env. Operator
    // override path (explicit catalog baseUrl, or AZURE_OPENAI_ENDPOINT)
    // still wins because both go through the adapter's resolution priority.
    baseUrl:
      hubConfig.baseUrl &&
      !hubConfig.baseUrl.includes('{resource_name}') &&
      !hubConfig.baseUrl.includes('{deployment}')
        ? hubConfig.baseUrl
        : undefined,
  });
};

// Gemini OAI-compat — pure hub wrapper, no URL substitution needed.
const geminiOpenAIFactory: AdapterFactory = (ctx) =>
  new GeminiOpenAIAdapter(buildHubConfig(ctx));

// GitHub Models — pure hub wrapper with modelListPath override.
const githubModelsFactory: AdapterFactory = (ctx) =>
  new GitHubModelsAdapter(buildHubConfig(ctx));

// Featherless — pure hub thin wrapper (OAI-compat). Long-tail HF marketplace.
// No URL substitution, no custom auth; the adapter exists for per-provider
// observability and for future provider-specific feature hooks.
const featherlessFactory: AdapterFactory = (ctx) =>
  new FeatherlessAdapter(buildHubConfig(ctx));

// Inworld — router + TTS/STT specialist. The adapter takes a narrow
// { apiKey, baseUrl } shape (NOT the full hub config) because it owns its
// own hub-config construction internally and injects `authScheme: 'Basic'`
// plus custom TTS/STT paths. We pass through only what it consumes.
const inworldFactory: AdapterFactory = (ctx) =>
  new InworldAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

// ── Orphan-closure Lot B (2026-04-23) ───────────────────────────────────
// Writer / Upstage / Reka are pure OpenAI-compat thin wrappers over
// OpenAICompatibleHubAdapter (see adapter class files — they consume the
// full hub config shape, not the Inworld-style narrow one). Factory shape
// therefore matches Groq/Cerebras/Bytez: one-line buildHubConfig call.
const writerFactory: AdapterFactory = (ctx) => new WriterAdapter(buildHubConfig(ctx));
const upstageFactory: AdapterFactory = (ctx) => new UpstageAdapter(buildHubConfig(ctx));
const rekaaiFactory: AdapterFactory = (ctx) => new RekaAIAdapter(buildHubConfig(ctx));

// ── Async-job image specialist (2026-04-29) ─────────────────────────────
// BFL takes a narrow { apiKey, baseUrl } shape — same as Topaz/Runway. Body
// shape and per-model-URL routing are owned by the adapter, so the factory
// is a one-liner.
const bflFactory: AdapterFactory = (ctx) =>
  new BflAdapter({
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });

// Databricks — workspace + endpoint-scoped URL. Same guard as Azure.
const databricksFactory: AdapterFactory = (ctx) => {
  const hubConfig = buildHubConfig(ctx);
  return new DatabricksAdapter({
    ...hubConfig,
    workspaceHost: process.env.DATABRICKS_HOST,
    endpoint: process.env.DATABRICKS_SERVING_ENDPOINT,
    baseUrl:
      hubConfig.baseUrl &&
      !hubConfig.baseUrl.includes('{workspace_host}') &&
      !hubConfig.baseUrl.includes('{endpoint}')
        ? hubConfig.baseUrl
        : undefined,
  });
};

// AWS Bedrock (2026-05-06) — first-party-native (SigV4 via AWS SDK). The
// adapter ignores the catalog `apiKey` (Bedrock auth happens inside the
// AWS SDK against AWS_ACCESS_KEY_ID/SECRET or role chain) and builds its
// own signed URL per-request. We thread region + optional inference-profile
// ARN here from env. Same env vars the legacy switch-case in
// provider-registry.ts:575 reads — kept consistent so behavior is identical
// once the catalog row replaces the legacy switch.
const awsBedrockFactory: AdapterFactory = (ctx) =>
  new AWSBedrockAdapter({
    name: ctx.entry.providerId, // 'aws-bedrock' — registry key
    enabled: true,
    apiKey: ctx.apiKey, // AWS_ACCESS_KEY_ID for telemetry; SDK uses chain
    baseUrl: ctx.baseUrl, // informational; SDK builds per-region URL
    region:
      process.env.AWS_BEDROCK_REGION ||
      process.env.AWS_REGION ||
      'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    inferenceProfileArn: process.env.AWS_BEDROCK_INFERENCE_PROFILE_ARN,
  });

// LOTE O (2026-07-10) — pure hub thin wrappers; each adapter's quirks live
// in its own class (fallback-disable for Apertis, temperature-clamp +
// diffusing-guard for Inception), so the factories are one-liners.
const apertisFactory: AdapterFactory = (ctx) => new ApertisAdapter(buildHubConfig(ctx));
const inceptionFactory: AdapterFactory = (ctx) => new InceptionAdapter(buildHubConfig(ctx));

// LOTE S (2026-07-13) — also a hub thin wrapper at the config-construction
// level (buildHubConfig covers auth/baseUrl/paths identically); the wire-
// shape override lives entirely inside the adapter class itself.
const perplexityAgentFactory: AdapterFactory = (ctx) =>
  new PerplexityAgentAdapter(buildHubConfig(ctx));

/**
 * Register the project's first-party adapter factories. Called once from the
 * catalog loader. Additional provider batches register by adding entries here.
 */
export function registerDefaultAdapterFactories(): void {
  // Direct-extension adapters (non-OAI shape).
  registerAdapterFactory('VoyageAdapter', voyageFactory);
  registerAdapterFactory('WatsonxAdapter', watsonxFactory);

  // Hub-extending adapters.
  registerAdapterFactory('GroqAdapter', groqFactory);
  registerAdapterFactory('PerplexityAdapter', perplexityFactory);
  registerAdapterFactory('CerebrasAdapter', cerebrasFactory);
  registerAdapterFactory('SambanovaAdapter', sambanovaFactory);
  registerAdapterFactory('VercelAIGatewayAdapter', vercelFactory);
  registerAdapterFactory('VolcanoAdapter', volcanoFactory);

  // Batch 2 — hub extension (W&B) + media specialists (Recraft, Runway, Topaz).
  registerAdapterFactory('WandbAdapter', wandbFactory);
  registerAdapterFactory('RecraftAdapter', recraftFactory);
  registerAdapterFactory('RunwayMLAdapter', runwaymlFactory);
  registerAdapterFactory('TopazImageAdapter', topazFactory);

  // Batch 3 — enterprise auth (Snowflake JWT, SAP OAuth2) + self-hosted + Xiaomi.
  registerAdapterFactory('SnowflakeCortexAdapter', snowflakeFactory);
  registerAdapterFactory('SapAiCoreAdapter', sapFactory);
  registerAdapterFactory('VllmAdapter', vllmFactory);
  registerAdapterFactory('LmStudioAdapter', lmStudioFactory);
  registerAdapterFactory('XinferenceAdapter', xinferenceFactory);
  registerAdapterFactory('XiaomiMimoAdapter', xiaomiFactory);

  // Batch 4 — orphan Replicate adapter + Bytez + HuggingFace Inference + Triton KServe.
  registerAdapterFactory('ReplicateAdapter', replicateFactory);
  registerAdapterFactory('BytezAdapter', bytezFactory);
  registerAdapterFactory('HuggingFaceInferenceAdapter', huggingfaceFactory);
  registerAdapterFactory('TritonAdapter', tritonFactory);

  // Batch 5 — Cloudflare Workers AI (account-scoped URL) + dedicated Ollama.
  registerAdapterFactory('CloudflareWorkersAIAdapter', cloudflareFactory);
  registerAdapterFactory('OllamaAdapter', ollamaFactory);

  // Batch 6 — enterprise hyperscaler gateways.
  registerAdapterFactory('AzureOpenAIAdapter', azureOpenAIFactory);
  registerAdapterFactory('GeminiOpenAIAdapter', geminiOpenAIFactory);
  registerAdapterFactory('GitHubModelsAdapter', githubModelsFactory);
  registerAdapterFactory('DatabricksAdapter', databricksFactory);

  // Lot A — close out providers with GCP secrets pre-wired.
  registerAdapterFactory('FeatherlessAdapter', featherlessFactory);

  // Orphan closure (2026-04-22) — InworldAdapter now wired through the
  // catalog path. Previously the class existed at providers/inworld/ but
  // was never instantiated, so the provider silently never ran.
  registerAdapterFactory('InworldAdapter', inworldFactory);

  // Orphan-closure Lot B (2026-04-23) — same pattern, three providers at
  // once. Keys were already in GCP and probed 200 via direct fetch this
  // session; these registrations make the closed-pipeline path work.
  registerAdapterFactory('WriterAdapter', writerFactory);
  registerAdapterFactory('UpstageAdapter', upstageFactory);
  registerAdapterFactory('RekaAIAdapter', rekaaiFactory);

  // Async-job image specialist (2026-04-29) — BFL/FLUX. Catalog row already
  // declared `integrationClass: 'image-only'` but `adapterClass` was missing,
  // so the registry could never resolve it. Adding the row + factory closes
  // the gap. Same async-job protocol as Topaz/Runway.
  registerAdapterFactory('BflAdapter', bflFactory);

  // AWS Bedrock (2026-05-06) — first-party-native (SigV4). Catalog row +
  // factory pair closes 125 orphan DB rows that previously had no runtime
  // adapter (the legacy switch-case path was unreachable).
  registerAdapterFactory('AwsBedrockAdapter', awsBedrockFactory);

  // LOTE O (2026-07-10) — Apertis + Inception Labs onboarding.
  registerAdapterFactory('ApertisAdapter', apertisFactory);
  registerAdapterFactory('InceptionAdapter', inceptionFactory);

  // LOTE S (2026-07-13) — Perplexity Agent API.
  registerAdapterFactory('PerplexityAgentAdapter', perplexityAgentFactory);
}
