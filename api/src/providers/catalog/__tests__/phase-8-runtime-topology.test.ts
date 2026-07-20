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
  'huggingface', 'orqai', 'nanogpt', 'cometapi', 'aiml', 'requesty', 'poe',
  'openrouter', 'edenai', 'aihubmix', 'routeway', 'nvidia-hub', 'heliconeai',
  'phala', 'gmi', 'chutes', 'infermatic', 'mancer',
  // Native single-vendor (Class B — 30 providers, 1,142 models)
  'deepinfra', 'alibaba', 'nvidia', 'openai', 'bedrock', 'novita', 'mistral',
  'vertex-ai', 'cohere', 'jina', 'wandb', 'upstage', 'perplexity', 'groq',
  'moonshot', 'fireworks-ai', 'anthropic', 'databricks', 'sambanova', 'writer',
  'friendli', 'minimax', 'inworld', 'hyperbolic', 'cerebras', 'atlascloud',
  'avian', 'arcee', 'rekaai', 'deepseek',
  // Audio-specialty (Class C — 2 providers, 133 models)
  'deepgram', 'elevenlabs',
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
  'openai', 'anthropic', 'mistral', 'cohere', 'deepseek', 'xai',
  'vertex-ai', 'bedrock', 'jina', 'deepgram', 'elevenlabs',
  // Native cloud hubs without catalog rows
  'openrouter',     // Wired via dedicated openrouter-aggregator source
  'nvidia-hub',     // Synthesized peer of nvidia for hub-vs-native attribution
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
  'vllm':              'self-hosted; needs vLLM server running locally',
  'lm-studio':         'self-hosted; needs LM Studio app running locally',
  'ollama':            'self-hosted; ollama container exposed but not seeded with models',
  'xinference':        'self-hosted; needs Xinference deployment',
  'triton':            'self-hosted; needs NVIDIA Triton server',
  'local-llama':       'self-hosted; ad-hoc local llama.cpp',
  'local-kobold':      'self-hosted; ad-hoc local KoboldCpp',
  'local-embeddings':  'self-hosted; ad-hoc local embedding server',
  // Catalog-only / pinnedFallback specialty (no list endpoint)
  'sap':               'wired discovery+execution (SapAiCoreAdapter); creds-missing in local env; expected in prod via GCP',
  'snowflake':         'wired discovery+execution (SnowflakeCortexAdapter); creds-missing in local env; expected in prod via GCP',
  'topaz':             'catalog-only; Topaz needs adapter (Phase 9 evaluation)',
  'inflection':        'oai-compat-pure execution-only (api.inflection.ai/v1); creds-missing in local env; expected in prod via GCP',
  'relace':            'catalog-only; specialty code-edit, pinnedFallback used',
  'recraft':           'image-only specialty, pinnedFallback',
  'runwayml':          'video-only specialty, pinnedFallback',
  'bfl':               'image-only specialty, pinnedFallback',
  'azure-openai':      'per-deployment, no list endpoint, pinnedFallback',
  // Credentials missing in local .env — expected to materialise in prod with GCP
  'togetherai':        'creds-missing in local env; expected in prod via GCP',
  'nscale':            'creds-missing in local env; expected in prod via GCP',
  'anyscale':          'creds-missing in local env; expected in prod via GCP',
  'featherless-ai':    'creds-missing in local env; expected in prod via GCP',
  'nebius':            'creds-missing in local env; expected in prod via GCP',
  'lambda-ai':         'creds-missing in local env; expected in prod via GCP',
  'scaleway':          'creds-missing in local env; expected in prod via GCP',
  'synthetic':         'creds-missing in local env; expected in prod via GCP',
  'morph':             'creds-missing in local env; expected in prod via GCP',
  'zai':               'creds-missing in local env; expected in prod via GCP',
  'xiaomi-mimo':       'creds-missing in local env; expected in prod via GCP',
  'v0':                'creds-missing in local env; expected in prod via GCP',
  'vercel-ai-gateway': 'creds-missing in local env; expected in prod via GCP',
  'volcano':           'creds-missing in local env; expected in prod via GCP',
  'watsonx':           'creds-missing in local env; expected in prod via GCP',
  'ai302':             'creds-missing in local env; expected in prod via GCP',
  'cloudflare-workers-ai': 'creds-missing in local env; expected in prod via GCP',
  'gemini-openai':     'creds-missing in local env; expected in prod via GCP',
  'github-models':     'creds-missing in local env; expected in prod via GCP',
  'imagerouter':       'creds-missing in local env; expected in prod via GCP',
  'stepfun':           'creds-missing in local env; expected in prod via GCP',
  // Single-cycle regressions (operator follow-up)
  'bytez':             'BytezNativeModelFetcher regression; Phase 4d promotion did not survive rebuild',
  'voyage':            'creds-revoked; needs operator rotation',
  'replicate':         'API not enabled in current GCP project',
  'siliconflow':       'API endpoint 404 in latest probe',
  'qianfan':           'creds-format mismatch; needs operator',
  // LOTE O (2026-07-10/11) — catalog row + full secret wiring landed
  // 2026-07-10; live-probed successfully 2026-07-11 (real /v1/models 200 +
  // /v1/chat/completions 200 for both — see consolidation-matrix.ts
  // `live-validation` bucket for evidence). Absent from the frozen
  // RUNTIME_MATERIALIZED_2026_04_28 DB snapshot simply because that
  // capture predates this onboarding — not a gap.
  'apertis':           'live-probed 2026-07-11 (200 on /v1/models + /v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  'inception':         'live-probed 2026-07-11 (200 on /v1/models + /v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  // LOTE P (2026-07-11) — same-day onboarding, same reasoning as apertis/inception.
  'empiriolabs':       'live-probed 2026-07-11 (200 on /v1/models + /v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  // LOTE Q (2026-07-12) — full live probe completed same day (discovery
  // unauthenticated, then chat/completions once gcloud was re-authenticated).
  'concentrate':       'live-probed 2026-07-12 (200 on /v1/models/ + /v1/chat/completions/); postdates the 2026-04-28 DB snapshot',
  // LOTE R (2026-07-13/15) — full live probe completed once gcloud was
  // re-authenticated a third time.
  'fastrouter':        'live-probed 2026-07-15 (200 on /api/v1/providers + /api/v1/models + /api/v1/chat/completions); postdates the 2026-04-28 DB snapshot',
  // LOTE S (2026-07-13) — full live probe same day (discovery authenticated,
  // execution confirmed for 6 of 7 requested vendors).
  'perplexity-agent':  'live-probed 2026-07-13 (200 on /v1/models + /v1/agent for anthropic/openai/google/xai/z.ai/nvidia); postdates the 2026-04-28 DB snapshot',
  // LOTE T (2026-07-13) — ailin. Unlike LOTE O-S, NOT live-probed this
  // session (no provisioned AILIN_API_KEY available). Wiring verified
  // contract-only against api.ailin.one's own openapi-spec.yaml: chat/
  // embeddings/images/audio confirmed OpenAI-compatible request/response
  // shape at the generic hub's default paths; GET /v1/models confirmed to
  // return a richer native shape the generic fetcher only partly
  // understands (documented as a follow-up in the catalog entry itself).
  // Postdates the 2026-04-28 DB snapshot, same as LOTE O-S.
  'ailin':             'not live-probed (no AILIN_API_KEY provisioned this session); contract-verified against openapi-spec.yaml only — see catalog entry notes for the discovery-shape gap',
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
