// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Catalog — Type Definitions
 *
 * Data-driven catalog of LLM providers. Each entry describes HOW TO INTEGRATE
 * a provider (discovery + execution + auth + routing), NOT what capabilities
 * its models have. Capability inference stays in the model-capability-merger
 * (ADR-022 HCRA pipeline) and uses multi-signal fusion.
 *
 * Design decisions (documented, not hardcoded):
 *
 *   1. `capabilityHints` are *weak* signals. They feed the merger at confidence
 *      ≤ 0.50 alongside name-regex, never override `provider-declared@0.85`.
 *      See `model-capability-merger.ts` for fusion rules.
 *
 *   2. `providerFamily` is used for equivalence (L2 model-equivalence-service)
 *      and hub-route attribution (e.g. `openai/gpt-4o` on a broker routes to
 *      `providerFamily: 'openai'` for tool-surface inference).
 *
 *   3. `integrationMode` drives WHICH fetcher/adapter classes get instantiated.
 *      Selection is deterministic: catalog field → class, no switch-case at
 *      call sites.
 *
 *   4. `capabilityHints` is intentionally `string[]` (not `ModelCapability[]`)
 *      to allow catalog entries to declare hints for capabilities NOT yet in
 *      the enum (e.g. `rerank`, `moderation`, `image_upscale`). The HCRA
 *      ontology, not the enum, is the source of truth for capability URIs.
 */

/**
 * Integration class — determines WHICH fetcher/adapter factory to use.
 *
 * - `oai-compat-pure`: Bare OpenAI `/v1/chat/completions` shape. Works out-of-box
 *    with `OpenAICompatibleHubModelFetcher` + `OpenAICompatibleHubAdapter`.
 * - `oai-compat-quirks`: OpenAI shape with provider-specific transformation
 *    (citations, extra auth headers, non-standard `/models` path). Uses the
 *    same base classes but with `requestTransform`/`responseTransform` hooks.
 * - `first-party-native`: Proprietary API shape (Anthropic Messages, Google
 *    Generative Language, Bedrock Converse, etc.). Requires a dedicated
 *    adapter class named via `adapterClass`.
 * - `embeddings-only`, `rerank-only`, `image-only`, `video-only`, `speech-only`,
 *    `moderation-only`: Single-modality provider. Discovery and execution are
 *    scoped to that modality. Not considered for text chat routing.
 * - `gateway`: Provider is itself a broker/hub routing to multiple upstreams
 *    (OpenRouter, Vercel AI Gateway, Clarifai). Discovery reveals many models
 *    from other families — `originalProvider` attribution is critical.
 * - `self-hosted-oai-compat`: Same as oai-compat-pure but expected on localhost
 *    or a private endpoint. No API key required by default; health check is
 *    more important than auth.
 * - `self-hosted-native`: Proprietary self-hosted runtime (Triton HTTP, Petals).
 * - `experimental`: Listed for inventory but `enabledByDefault: false`. Not
 *    wired into the registry until explicitly promoted.
 */
export type ProviderIntegrationClass =
  | 'oai-compat-pure'
  | 'oai-compat-quirks'
  | 'first-party-native'
  | 'embeddings-only'
  | 'rerank-only'
  | 'image-only'
  | 'video-only'
  | 'speech-only'
  | 'moderation-only'
  | 'gateway'
  | 'self-hosted-oai-compat'
  | 'self-hosted-native'
  | 'experimental';

/**
 * Integration mode for discovery + execution coherence.
 *
 * - `discovery+execution`: Full stack integration. Models discovered via
 *    fetcher AND callable via adapter. This is the default for viable providers.
 * - `discovery-only`: Models listed (useful for catalog/equivalence) but
 *    execution blocked. Used when provider has a `/models` endpoint but no
 *    chat/completion API compatible with our adapter surface.
 * - `catalog-only`: Entry exists for inventory/classification; neither discovery
 *    nor execution active. Used for LiteLLM-listed providers that we don't yet
 *    have credentials for but want to surface in internal tooling.
 * - `execution-only`: Rare — provider supports chat/completion but no model
 *    listing endpoint. Requires a manual model whitelist in `staticModels`.
 */
export type ProviderIntegrationMode =
  | 'discovery+execution'
  | 'discovery-only'
  | 'catalog-only'
  | 'execution-only';

/**
 * Pricing discovery mode.
 *
 * - `remote`: Provider API returns pricing in `/models` response (OpenRouter,
 *    some hubs). Extracted by the fetcher.
 * - `static-file`: Pricing shipped in a local JSON alongside the catalog
 *    (fallback for providers without remote pricing). NOT implemented yet —
 *    reserved for future.
 * - `none`: Unknown pricing. Model rows get `inputCostPer1M: 0`. Selection
 *    treats `0` as "unknown" (not "free") — see `dynamic-model-selector`.
 */
export type PricingMode = 'remote' | 'static-file' | 'none';

/**
 * Auth scheme for the provider's `/models` + chat endpoints.
 *
 * - `bearer`: Standard `Authorization: Bearer <key>`. Default.
 * - `api-key-header`: Custom header name (e.g. `x-api-key`, `Api-Key`).
 *    The header name is declared in `authHeaderName`.
 * - `query-param`: Key passed as `?api_key=...` (legacy, some small providers).
 * - `hmac-sigv4`: AWS SigV4 (Bedrock, SageMaker). Requires `aws-sigv4-adapter`.
 * - `oauth2`: OAuth2 client credentials flow (SAP, some enterprise clouds).
 * - `iam-token`: IBM IAM / OCI signing — requires regional token exchange.
 * - `none`: Self-hosted, localhost, no auth (still typed for clarity).
 * - `custom`: Provider has a unique scheme not worth generalizing. Adapter
 *    class handles it entirely. Catalog just declares `custom` as a flag.
 */
export type ProviderAuthScheme =
  | 'bearer'
  | 'api-key-header'
  | 'query-param'
  | 'hmac-sigv4'
  | 'oauth2'
  | 'iam-token'
  | 'none'
  | 'custom';

/**
 * Capability hint — a WEAK signal that flows into the HCRA capability merger.
 *
 * IMPORTANT: these are NOT the model's final capabilities. They express
 * "providers of this class typically expose this capability surface" and
 * feed the merger at confidence 0.4–0.5 (below `provider-declared`).
 *
 * The string values are free-form to allow forward-compat with the ontology
 * (e.g. `rerank`, `image_upscale`, `moderation` — not yet in the enum).
 */
export interface CapabilityHint {
  /** Capability name — matches HCRA ontology preferredLabel or synonym. */
  readonly capability: string;
  /** Hint source — appears in the provenance record. */
  readonly rationale:
    | 'provider-class-default'
    | 'docs-declared'
    | 'endpoint-declared'
    | 'integration-class-default';
  /** Confidence 0..1. Default 0.45 for class-default, 0.60 for docs-declared. */
  readonly confidence?: number;
}

/**
 * Endpoint paths — all optional, defaults derived from `integrationClass`.
 */
export interface ProviderEndpointPaths {
  /** Path for `GET /models` (or equivalent listing endpoint). */
  readonly modelList?: readonly string[];
  /** Path for chat completions. Default `/chat/completions`. */
  readonly chatCompletions?: string;
  /** Path for responses API. Only set when provider supports OpenAI Responses. */
  readonly responses?: string;
  /** Path for embeddings. Default `/embeddings`. */
  readonly embeddings?: string;
  /** Path for rerank. No sensible default — only set when provider supports rerank. */
  readonly rerank?: string;
  /** Path for image generation. Default `/images/generations`. */
  readonly imagesGenerate?: string;
  /** Path for image edits. Default `/images/edits`. */
  readonly imagesEdit?: string;
  /** Path for video generation. No default — only when provider supports video. */
  readonly videoGenerate?: string;
  /**
   * Poll path template for providers whose video generation is an ASYNC JOB
   * QUEUE (submit → taskId → poll). `{taskId}` is replaced with the id the
   * submit response returned. When absent, the hub adapter falls back to
   * `<videoGenerate>/<taskId>`. Only meaningful together with `videoGenerate`.
   * Live-proven example (probe 2026-07-17): FastRouter `POST /videos` returns
   * `{data:{taskId,status:"processing"}}` and `GET /videos/{taskId}` reports
   * job status until `generations[]` appear.
   */
  readonly videoPoll?: string;
  /** Path for text-to-speech. Default `/audio/speech`. */
  readonly audioSpeech?: string;
  /** Path for speech-to-text. Default `/audio/transcriptions`. */
  readonly audioTranscriptions?: string;
  /** Path for moderation. Default `/moderations`. */
  readonly moderation?: string;
  /** Path for health check. Default: first `modelList` path. */
  readonly health?: string;
}

/**
 * Pinned-fallback model entry — bare id OR id + operator-declared capabilities.
 *
 * 2026-04-28 root-cause refactor (Phase-10 follow-up): the bare-string form
 * forces the catalog-bridge into name-regex inference (confidence 0.20, the
 * weakest source in the fusion hierarchy). The structured form lets operators
 * declare the real capability set directly — which becomes a `provider-declared`
 * equivalent in the discovery emit, skipping regex inference entirely.
 *
 * Use the structured form for any pinned model that ships in the default
 * registration set. The CI invariant `pinnedFallback-capability-coverage`
 * fails if an enabled-by-default provider's pinnedFallback contains a bare
 * string whose name-regex inference returns no match.
 */
export type PinnedModelEntry =
  | string
  | {
      readonly id: string;
      /** Operator-declared capabilities — feed the catalog-bridge directly,
       *  bypassing name-regex inference. `string[]` (not `ModelCapability[]`)
       *  to match the forward-compat philosophy of `capabilityHints`. */
      readonly capabilities: readonly string[];
    };

/**
 * Normalize a `PinnedModelEntry` to its `{id, capabilities}` form. Bare strings
 * yield an empty `capabilities` array — the consumer can then choose whether
 * to fall back to inference or treat that as a tagging gap.
 */
export function normalizePinnedModelEntry(
  entry: PinnedModelEntry,
): { id: string; capabilities: readonly string[] } {
  if (typeof entry === 'string') {
    return { id: entry, capabilities: [] };
  }
  return { id: entry.id, capabilities: entry.capabilities };
}

/**
 * Extract just the model IDs from a pinnedFallback list. Convenience for
 * call sites that only need the id list (existing string-based callers).
 */
export function pinnedModelIds(entries: readonly PinnedModelEntry[]): string[] {
  return entries.map((e) => (typeof e === 'string' ? e : e.id));
}

/**
 * Provider catalog entry — the source of truth for one provider integration.
 */
export interface ProviderCatalogEntry {
  // ─── Identity ────────────────────────────────────────────────────────────
  /** Canonical provider ID used throughout the system. Lowercase, kebab-case. */
  readonly providerId: string;
  /** Human-readable name shown in UIs and logs. */
  readonly displayName: string;
  /** Family for equivalence (e.g. 'openai', 'anthropic', 'meta'). Hub providers
   *  that re-serve first-party models point their `providerFamily` at themselves,
   *  with `originalProviderField` guiding attribution in the merger. */
  readonly providerFamily: string;
  /** Aliases tolerated on input (e.g. for hub `owned_by` canonicalization). */
  readonly aliases?: readonly string[];

  // ─── Classification ──────────────────────────────────────────────────────
  readonly integrationClass: ProviderIntegrationClass;
  readonly integrationMode: ProviderIntegrationMode;

  // ─── Connection ──────────────────────────────────────────────────────────
  /** Base URL for all API calls. May include path prefix (e.g. `/v1`). */
  readonly baseUrl: string;
  /** Paths (all optional — classes supply defaults). */
  readonly paths?: ProviderEndpointPaths;
  /** Auth scheme; default `bearer`. */
  readonly authScheme?: ProviderAuthScheme;
  /** Header name for `api-key-header` scheme. */
  readonly authHeaderName?: string;
  /** Extra headers sent on every request (static). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Body shape the provider's video-generation endpoint expects.
   * - `flat` (default): OpenAI-videos style — `{model, prompt, duration, ...}`.
   * - `payload-wrap`: Together-style — `{model, payload: {prompt, ...}}`;
   *   everything except `model` nests under a required `payload` map.
   *   Live-proven (probe 2026-07-17): Together rejects the flat shape with
   *   "validation failed for field 'payload': expected required".
   */
  readonly videoRequestStyle?: 'flat' | 'payload-wrap';

  // ─── Configuration via environment ───────────────────────────────────────
  /** Primary env var for the API key. Convention: `<PROVIDER_ID_UPPER>_API_KEY`. */
  readonly apiKeyEnvVar: string;
  /**
   * Justification for diverging from the `<PROVIDER_ID_UPPER>_API_KEY`
   * convention. When set, Zod Rule 1 accepts the divergence. Use ONLY when
   * the provider's upstream SDK ships with a well-known canonical env var
   * name (e.g. `HF_TOKEN`, `GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`,
   * `DATABRICKS_TOKEN`, `GEMINI_API_KEY`) such that following the convention
   * would force users to double-set the same secret.
   *
   * NOT for convenience or typo-compatibility — PR reviewers should reject
   * a new override that isn't backed by upstream docs. Prefer renaming to
   * convention whenever the upstream SDK has no canonical name.
   */
  readonly apiKeyEnvVarOverrideReason?: string;
  /** Override env var for base URL (defaults to the catalog value). */
  readonly baseUrlEnvVar?: string;
  /** Extra env vars (org, project, tenant, region). Shape: varName → purpose. */
  readonly extraEnvVars?: Readonly<Record<string, string>>;
  /** If true, absence of the API key disables the provider silently (no warning). */
  readonly apiKeyOptional?: boolean;

  // ─── Capability surface ──────────────────────────────────────────────────
  /** High-level modality flags. These are CATALOG-LEVEL — feed HCRA as hints. */
  readonly supports: Readonly<{
    chat?: boolean;
    responses?: boolean;
    embeddings?: boolean;
    rerank?: boolean;
    moderation?: boolean;
    speechToText?: boolean;
    textToSpeech?: boolean;
    imageGeneration?: boolean;
    imageEditing?: boolean;
    videoGeneration?: boolean;
    streaming?: boolean;
    tools?: boolean;
    jsonMode?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    realtime?: boolean;
  }>;
  /** Additional hints for the capability merger. May reference ontology URIs
   *  or plain strings that match preferredLabel/synonyms. */
  readonly capabilityHints?: readonly CapabilityHint[];

  // ─── Pricing ─────────────────────────────────────────────────────────────
  readonly pricingMode: PricingMode;

  // ─── Adapter selection (optional explicit override) ──────────────────────
  /** If set, registry uses this adapter class instead of the class-default.
   *  Typical values: `OpenAICompatibleHubAdapter` (default for oai-compat-*),
   *  or a first-party class name. Unknown values log a warning and fall back. */
  readonly adapterClass?: string;
  /** Fetcher class override — same semantics as `adapterClass` for discovery. */
  readonly fetcherClass?: string;

  // ─── Discovery tuning ────────────────────────────────────────────────────
  /** Model IDs to exclude from discovery. Also honored via `<PROVIDER>_MODEL_DENYLIST` env. */
  readonly modelDenylist?: readonly string[];
  /**
   * Pinned fallback model list — used when discovery either cannot run (no
   * /models endpoint) or should not be authoritative (curated shortlist).
   *
   * The runtime consults `pinnedFallback.models` whenever it would have
   * consulted the deprecated `staticModels` field. The richer shape forces
   * callers to declare *why* the fallback exists, and to record when it was
   * last reviewed — both of which the old `staticModels` array could not.
   *
   * Capability declaration (2026-04-28 root-cause refactor)
   * ──────────────────────────────────────────────────────
   * Each entry can be either a bare model id (`string`) or a structured
   * record `{ id, capabilities }`. The structured form is operator-declared
   * — when present, the catalog-bridge skips regex inference entirely and
   * trusts the catalog. The bare-string form is kept for backward compat
   * but is now considered an anti-pattern: regex inference at confidence
   * 0.20 is the weakest signal in the fusion hierarchy and should never be
   * the sole evidence for an enabled-by-default model.
   *
   * Use the structured form for any provider whose /models endpoint cannot
   * be probed. The capabilities array is `string[]` (not `ModelCapability[]`)
   * to mirror `capabilityHints.capability` and allow forward-compat with
   * ontology entries not yet in the enum (e.g. `reranking`, `moderation`).
   * Unknown strings are filtered at the runtime boundary.
   *
   * Reasons (extend the literal union when a new category appears; downstream
   * filters depend on the closed set):
   *   - 'no-list-endpoint'   — /models is 404 / unsupported by the upstream
   *   - 'workspace-scoped'   — /models exists but returns workspace-private
   *                            entries that don't generalise (e.g. Databricks)
   *   - 'per-deployment'     — /models is per-deployment, no global listing
   *                            (e.g. Azure OpenAI)
   *   - 'proprietary-schema' — provider responds non-OAI; adapter not yet wired
   *   - 'curated-shortlist'  — /models works, but exposes thousands of
   *                            irrelevant entries; we keep a hand-picked list.
   */
  readonly pinnedFallback?: {
    readonly models: readonly PinnedModelEntry[];
    readonly reason:
      | 'no-list-endpoint'
      | 'workspace-scoped'
      | 'per-deployment'
      | 'proprietary-schema'
      | 'curated-shortlist';
    /** ISO date — when this fallback was last manually reviewed. Surfaces in
     *  audits so stale lists can be flagged. */
    readonly lastReviewedAt: string;
  };
  /**
   * @deprecated Phase 4d (2026-04-28): superseded by `pinnedFallback.models`.
   *
   * Retained as an OPTIONAL field so the schema (Zod) and runtime consumers
   * (catalog-provider-plugin, central-model-discovery-service) can keep their
   * "use pinnedFallback if present, else staticModels" safety-net during the
   * migration window. The catalog itself has zero `staticModels:` entries —
   * every row is on the new shape — so this field is effectively the empty
   * set in production. Once the deprecation period closes (target: one full
   * release cycle without re-introduction), drop this field, the Zod entry,
   * and the consumer fallback branches in a single commit. */
  readonly staticModels?: readonly string[];
  /** Field name on raw `/models` entries that declares the originating first-party
   *  provider (for gateway/hub providers). Common: `owned_by`, `provider`, `vendor`. */
  readonly originalProviderField?: string;

  // ─── Lifecycle ───────────────────────────────────────────────────────────
  /** If false, the loader skips registration at boot (but catalog entry remains for docs). */
  readonly enabledByDefault: boolean;
  /** If true, the loader denies registration even with credentials present.
   *  Used to quarantine known-bad providers without deleting the entry. */
  readonly denyByDefault?: boolean;
  /** Content-policy classification. `uncensored` providers participate fully in
   *  routing (per the universal "habilitado e nunca censurado" policy, 2026-04-28),
   *  but downstream consumers can use this tag to filter at the surface layer
   *  (e.g. omit from a moderated default model list while keeping them reachable
   *  via explicit selection). This is informational metadata, NOT a registration
   *  gate — `enabledByDefault` and `denyByDefault` remain the only gates. */
  readonly contentPolicyClass?: 'uncensored';
  /** Priority for execution routing tiebreaker (higher = preferred). Default 0. */
  readonly priority?: number;

  // ─── Metadata ────────────────────────────────────────────────────────────
  readonly docsUrl?: string;
  readonly notes?: string;
  /** ISO date string — when the catalog entry was last reviewed. Used in audits. */
  readonly lastReviewedAt?: string;
}

/**
 * Utility: narrow `ProviderCatalogEntry` to oai-compat subtypes.
 * Used by the plugin bridge to decide fetcher/adapter selection.
 */
export function isOpenAICompatibleEntry(
  entry: ProviderCatalogEntry,
): entry is ProviderCatalogEntry & {
  integrationClass:
    | 'oai-compat-pure'
    | 'oai-compat-quirks'
    | 'self-hosted-oai-compat'
    | 'gateway';
} {
  return (
    entry.integrationClass === 'oai-compat-pure' ||
    entry.integrationClass === 'oai-compat-quirks' ||
    entry.integrationClass === 'self-hosted-oai-compat' ||
    entry.integrationClass === 'gateway'
  );
}

/**
 * Utility: specialty providers that should NOT be treated as text-chat models
 * in the router (they're scoped to one modality).
 */
export function isSpecialtyEntry(entry: ProviderCatalogEntry): boolean {
  return (
    entry.integrationClass === 'embeddings-only' ||
    entry.integrationClass === 'rerank-only' ||
    entry.integrationClass === 'image-only' ||
    entry.integrationClass === 'video-only' ||
    entry.integrationClass === 'speech-only' ||
    entry.integrationClass === 'moderation-only'
  );
}
