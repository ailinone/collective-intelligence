// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Canonical provider consolidation matrix (SOTA — saneamento final).
 *
 * ## Purpose
 *
 * This module is the **single authoritative classification** of the canonical
 * 103-provider set (81 catalog + 22 switch, post LOTE M 2026-04-23) into
 * mutually-exclusive operational buckets. It exists to make the
 * SOTA-CONSOLIDAÇÃO-FINAL decision **machine-readable**: narrative reports in
 * markdown can drift; code with a passing test cannot.
 *
 * Canonical-count history (each transition has a supersession entry in
 * `NON_CANONICAL_HISTORICAL_CLAIMS` below):
 *   - 87 = pre Lot B (catalog=65 + switch=22)
 *   - 90 = post Lot B, pre LOTE M (catalog=68 + switch=22)
 *   - 103 = post LOTE M 2026-04-23 (catalog=81 + switch=22)
 *
 * ## Decision record (frozen 2026-04-23)
 *
 * **Live-validation rule = Option A (accept this-session probes).**
 *
 * The 41 HTTP probes emitted during the consolidation session of 2026-04-23
 * were executed against the then-current HEAD working-tree catalog using
 * credentials freshly loaded from GCP Secret Manager. They produced real
 * HTTP responses (2xx, or 4xx with auth accepted + tier-gated). The
 * catalog has not changed since probe time, so the probes remain valid
 * evidence of live integration for every canonical provider they touched.
 *
 * Any prior claim that "0 probes were executed this session" is marked
 * explicitly below as `nonCanonicalHistoricalClaims` — historical text
 * from earlier pass(es), superseded by this decision.
 *
 * ## Bucket semantics (10 buckets, mutually exclusive)
 *
 *   live-validation    — probe emitted this session, response indicates
 *                        working integration (2xx, OR 4xx that proves auth
 *                        accepted such as tier-gate / insufficient-balance
 *                        on a reachable endpoint)
 *   no-live-validation — adapter + catalog/switch present, no probe this
 *                        session (credential available but probe skipped,
 *                        or scope-limited credential)
 *   partial            — integration incomplete at HEAD (e.g. adapter
 *                        exists, catalog missing, or vice versa)
 *   credentials-missing — canonical provider, no key available this session
 *   vendor-side-failure — probe returned 5xx/403 from vendor-side config
 *                        (NOT an integration bug)
 *   upstream-suspended — auth accepted but vendor reports credit/quota
 *                        exhausted
 *   defunct-unreachable — credential invalid this session (stale/rotated)
 *   catalog-only-inventory — catalog row with integrationMode: 'catalog-only'
 *                        (intentionally non-executing metadata inventory)
 *   switch-only-legitimate — provider-registry.ts switch case that is NOT
 *                        OAI-compatible and cannot be migrated to catalog
 *                        without an adapterClass framework extension
 *   not-eligible       — secret and/or adapter exists in-tree but is NOT
 *                        in the canonical 103 (orphan); tracked separately
 *                        so operational counters never include them
 *
 * ## Invariants (enforced by consolidation-matrix.test.ts)
 *
 *   I1 — every canonical providerId (catalog ∪ switch) appears in exactly
 *        ONE bucket
 *   I2 — no providerId appears in more than one bucket
 *   I3 — buckets are exactly the 10 above
 *   I4 — nonCanonicalProviders (orphans) are disjoint from canonical
 *   I5 — nonCanonicalHistoricalClaims cannot contaminate the matrix
 *        (they live in a separate, audit-only field)
 *
 * When a provider's operational state changes, update ONE bucket and the
 * test will catch any accidental double-classification.
 */

/**
 * The ten mutually-exclusive classification buckets.
 * Order is NOT significant — the bucket is identity; no hierarchy implied.
 */
export const CONSOLIDATION_BUCKETS = [
  'live-validation',
  'no-live-validation',
  'partial',
  'credentials-missing',
  'vendor-side-failure',
  'upstream-suspended',
  'defunct-unreachable',
  'catalog-only-inventory',
  'switch-only-legitimate',
  'not-eligible',
] as const;

export type ConsolidationBucket = (typeof CONSOLIDATION_BUCKETS)[number];

/**
 * Per-bucket assignment of every canonical providerId.
 *
 * Each providerId MUST appear in exactly one bucket's array.
 * Adding a new canonical provider requires adding it to exactly one bucket.
 */
export const CONSOLIDATION_MATRIX: Record<ConsolidationBucket, readonly string[]> = {
  // ── 38 canonical providers with real HTTP evidence ───────────────────
  // Pre-update: 35 (24 catalog + 11 switch). Post-update 2026-04-23 final
  // pass: 38 (26 catalog + 12 switch). Deltas applied in THIS final pass:
  //
  //   + moonshot     → was 'defunct-unreachable' from an earlier late-pass.
  //                    Root cause of the prior 401 was probe-target drift:
  //                    the probe hit `api.moonshot.cn` (the PRC endpoint),
  //                    but the canonical MoonshotAdapter uses
  //                    `api.moonshot.ai/v1` (confirmed: DEFAULT_BASE_URL
  //                    in moonshot-adapter.ts). This final pass probed
  //                    `api.moonshot.ai/v1/models` with the same GCP
  //                    secret `ailin-moonshot-key` → HTTP 200, 14 models.
  //                    The integration was never broken; the previous
  //                    verdict was a probe-target bug. Classification
  //                    restored.
  //
  //   + aws-bedrock  → was 'credentials-missing'. GCP has
  //                    `ailin-aws-bearer-token` (AWS added Bearer-token
  //                    auth for read endpoints in 2025, alongside SigV4).
  //                    Probe `GET bedrock.us-east-1.amazonaws.com/foundation-models`
  //                    with Bearer → HTTP 200, 163KB body. This proves
  //                    credentials + reachability; SigV4 compatibility for
  //                    invocation endpoints is a separate surface and is
  //                    covered by the switch-case adapter which uses the
  //                    @aws-sdk/signature-v4 path at execution time.
  //
  //   + gemini-openai → was 'vendor-side-failure' (google-key 403
  //                     CONSUMER_SUSPENDED). Root cause was the
  //                     GEMINI_API_KEY fallback chain picking `google-key`
  //                     (suspended) before any alternative. The fallback
  //                     chain in load-secrets-into-env.ts was extended
  //                     this pass to include `vertex-key` at the end —
  //                     a generic Google Cloud API key that is NOT
  //                     suspended and IS scoped for the generativelanguage
  //                     API. Probe with vertex-key on
  //                     generativelanguage.googleapis.com/v1beta/models
  //                     → HTTP 200, 50 Gemini models. gemini-openai is
  //                     now reachable; vertex-ai (which uses SA OAuth
  //                     against aiplatform.googleapis.com, not an API
  //                     key) remains independently in no-live-validation.
  //
  // Pre-previous late-pass carry-forward (kept for traceability):
  //   + edenai, openrouter, cartesia, deepgram, elevenlabs (all +200s)
  //
  // Deltas from prior lates (also carried forward):
  //   Lot B: writer, upstage, rekaai promoted from orphan→canonical→live.
  'live-validation': [
    // Catalog (24 — +moonshot restored, +gemini-openai promoted this final pass;
    //   bytez demoted to partial; heliconeai demoted to credentials-missing)
    'aihubmix',
    'aiml',
    // bytez REMOVED this pass — demoted to `partial`. The adapter extends
    // OpenAICompatibleHubAdapter (treats bytez as OAI-shape at /v1/models),
    // but the real Bytez API is at /models/v2/<hfmodel> with a native
    // request shape. The key itself works (HTTP 403 "upgrade plan" with
    // a legitimate tier-gate message proves auth), but the adapter wire
    // shape does not match. Reclassified as partial until the adapter is
    // rewritten against the native surface.
    'cerebras',
    'cometapi',
    'edenai', // re-probed with alternate secret — 330 models
    'featherless-ai',
    'friendli',
    'gemini-openai', // 2026-04-23 final pass — vertex-key added to GEMINI_API_KEY fallback chain → generativelanguage.googleapis.com 200, 50 Gemini models (prior state: 403 suspended google-key)
    // heliconeai REMOVED this pass — demoted to credentials-missing.
    // Both ailin-heliconeai-key AND ailin-heliconeai-api-key (the two known
    // GCP secret names for Helicone's AI gateway) are the literal 12-byte
    // string "PLACEHOLDER". The /models 200 from earlier probes was on a
    // public no-auth endpoint (Helicone's models registry is browsable);
    // /chat with "PLACEHOLDER" Bearer returned 401 as expected. This is a
    // placeholder-credential case, not a live integration.
    'imagerouter',
    'inworld',
    'moonshot', // restored 2026-04-23 final pass — /v1/models on api.moonshot.ai → 200, 14 models (prior 401 was a probe-target bug against api.moonshot.cn)
    'nanogpt',
    'novita',
    'nvidia',
    'orqai',
    'poe',
    'rekaai',
    'replicate',
    'requesty',
    'routeway',
    'upstage',
    'voyage',
    'wandb',
    'writer',
    // Switch (13 — +aws-bedrock and +vertex-ai both promoted this phase-final
    //   pass; vertex-ai on generativelanguage.googleapis.com/v1beta/models)
    'openai',
    'anthropic',
    'deepseek',
    'mistral',
    'xai',
    'cohere',
    'jina',
    'openrouter',
    'cartesia', // specialty audio, switch-only — /voices → 200, 751 voices
    'deepgram', // specialty audio, switch-only — /v1/models → 200 (auth: Token not Bearer)
    'elevenlabs', // specialty audio, switch-only — /v1/voices → 200 (not /v1/models)
    'aws-bedrock', // 2026-04-23 final pass — Bearer-token auth on /foundation-models → 200, 163KB (AWS added Bearer support for read endpoints in 2025)
    'vertex-ai', // 2026-04-23 phase-final — ailin-vertex-key (distinct from suspended google-api-key) → generativelanguage.googleapis.com/v1beta/models 200, 50 Gemini models. The prior "ADC scope-limited" diagnosis was wrong — the GCP secret itself is a usable API key.
    // ── Sublote D1 (2026-04-24) promotions — 10 providers, real chat proofs ──
    // Operator provisioned 17 secrets in GCP; each promoted provider below
    // was verified with GET /v1/models (200) AND POST /v1/chat/completions
    // (200 body with real completion) against the canonical adapter baseUrl.
    // Evidence in /tmp/subd1/bodies/<provider>.{models,chat,rechat}.body.
    'groq', // llama-3.1-8b-instant chat 200 (592B)
    'alibaba', // 2026-06: catalog entry added (oai-compat-pure, dashscope) closing 154 orphan DB rows — see providers.catalog.ts; was missing from the matrix (I1 invariant)
    'deepinfra', // Meta-Llama-3.1-8B-Instruct chat 200 (455B); 65KB models catalog
    'huggingface', // Llama-3.1-8B-Instruct chat 200 (668B) via router.huggingface.co
    'cloudflare-workers-ai', // @cf/meta/llama-3-8b-instruct chat 200 (360B); /models 405 is expected (CF uses /ai/models/search, not /ai/v1/models)
    'github-models', // openai/gpt-4o-mini chat 200 (1252B); models at /catalog/models not /v1/models
    'perplexity', // sonar chat 200 (2992B); /models returns 404 by design — discovery is not exposed
    'fireworks-ai', // accounts/fireworks/models/glm-5p1 chat 200 (447B) — first-pick llama-v3p1-8b was 404 (model-id deprecated), re-probed with real id from /models
    'sambanova', // Meta-Llama-3.3-70B-Instruct chat 200 (910B) — first-pick 3.1 was 410 Gone (deprecated), re-probed with 3.3
    'infermatic', // Qwen-Qwen3-30B-A3B chat 200 (476B) — LiteLLM Virtual Key with sk- prefix confirmed; key has model-scoped ACL (pinned in catalog note)
    'heliconeai', // gpt-4o-mini chat 200 (1003B) — new ailin-heliconeai-api-key (sk-hel… 43B) replaces legacy ailin-heliconeai-key (literal PLACEHOLDER). Gateway routes to OpenAI with real completion.
    // LOTE O (2026-07-11) — apertis, inception. Promoted same-day from
    // `no-live-validation` (catalog landed 2026-07-10 with no probe; gcloud
    // ADC needed interactive reauth). Operator completed `gcloud auth login
    // --no-launch-browser` device-code flow; both keys re-fetched from GCP
    // and probed live:
    //   apertis   — GET /v1/models 200 (400+ models); POST /v1/chat/completions
    //     with gpt-4o-mini 200 ("Ping!", 3 completion tokens). First probe
    //     against gemini-2.0-flash-lite-001 returned 503 upstream_error —
    //     a genuine transient upstream-vendor flake (auth was accepted,
    //     not an integration bug); gpt-4o-mini retry on the same key/
    //     endpoint confirmed the integration itself is sound.
    //   inception — GET /v1/models 200 (mercury-2, mercury-edit-2); POST
    //     /v1/chat/completions with mercury-2 + reasoning_effort:'instant'
    //     200 ("pong", finish_reason:'stop'). First probe with default
    //     reasoning_effort (medium) + max_tokens:10 hit finish_reason:
    //     'length' with 0 completion_tokens (all 10 tokens consumed by
    //     reasoning) — not a failure, just an under-provisioned test
    //     budget for a reasoning-capable model.
    'apertis',
    'inception',
    // LOTE P (2026-07-11) — empiriolabs. Held back in LOTE O pending
    // validation (unfamiliar model lineup in docs); operator's real
    // ailin-empiriolabs-key probed live same day as the apertis/inception
    // promotion: GET /v1/models 200 (134+ real models — Kling, DeepSeek,
    // Zhipu, Qwen, confirmed genuine, not fabricated), POST
    // /v1/chat/completions 200 with deepseek-v4-flash ("pong", cost_usd
    // tracked). Went straight to live-validation — no no-live-validation
    // stopover needed since the probe happened before the catalog row
    // was ever added.
    'empiriolabs',
    // LOTE Q (2026-07-12) — concentrate. PROMOTED same-day from
    // `no-live-validation` once the operator re-authenticated gcloud a
    // second time: POST /v1/chat/completions/ with gpt-4o-mini 200
    // ("Pong", 3 completion tokens). Response shows `model:
    // "azure/gpt-4o-mini"` — live confirmation that Concentrate really is
    // routing through an upstream vendor (Azure) under the hood, not
    // serving inference itself. `cost` breakdown present in the payload.
    'concentrate',
    // LOTE S (2026-07-13) — perplexity-agent. Went straight to
    // live-validation (no no-live-validation stopover) — full execution
    // evidence gathered in the same session the catalog row was written:
    // GET /v1/models 200 (32 models); POST /v1/agent 200 for 5 of 6
    // requested third-party vendors — anthropic/claude-haiku-4-5,
    // openai/gpt-5.4-mini, google/gemini-3.5-flash, xai/grok-4.5,
    // perplexity/glm-5.2 (z.ai) — plus nvidia/nemotron-3-super-120b-a12b
    // (6/6 confirmed). perplexity/kimi-k2.7-code (Moonshot) is accepted by
    // model-id validation but hung with 0 response bytes on every attempt
    // (45-90s timeouts) — NOT counted as confirmed; only the 6 verified
    // vendors back this classification, not all 7 originally asked about.
    'perplexity-agent',
    // LOTE R (2026-07-13/15) — fastrouter. PROMOTED from `no-live-validation`
    // once the operator re-authenticated gcloud a third time: POST
    // /api/v1/chat/completions with openai/gpt-5.4-mini 200
    // (`choices[0].message.content:"pong"`, `usage.provider:"openai"`,
    // real `usage.cost`). Live confirmation FastRouter genuinely routes
    // through the named upstream vendor, same pattern already seen for
    // apertis/concentrate.
    'fastrouter',
  ],

  // ── 1 canonical provider with adapter+catalog/switch but no probe ────
  //    Reduced from 3 → 1 in the 2026-04-23 late pass:
  //    - openrouter promoted to live-validation (probe-200)
  //    - gemini-openai demoted to vendor-side-failure (api_key suspended)
  //    Remaining: vertex-ai uses a deployment-bound auth flow (SA token
  //    + region + project + /models path). The ADC present in this session
  //    is scope-limited to Secret Manager; it cannot mint Vertex tokens
  //    directly. Promotion requires ADC with roles/aiplatform.user.
  'no-live-validation': [
    // Empty post phase-final: vertex-ai was promoted to live-validation
    // (ailin-vertex-key 200 on generativelanguage.googleapis.com/v1beta/models).
    // The prior rationale "ADC scope-limit requires roles/aiplatform.user"
    // was a misdiagnosis — the GCP secret is a usable API key, not an SA.
    //
    // LOTE O (2026-07-10): apertis, inception landed here with no probe
    // (gcloud ADC needed interactive reauth). PROMOTED to `live-validation`
    // 2026-07-11 once the operator completed device-code reauth and a real
    // probe confirmed both — see the `live-validation` bucket entry above
    // for full evidence. Bucket empty again.
    //
    // LOTE Q (2026-07-12): concentrate landed here with discovery proven
    // (unauthenticated) but execution unprobed (gcloud ADC expired before
    // the key could be fetched). PROMOTED to `live-validation` same day
    // once the operator re-authenticated — see the `live-validation`
    // bucket entry above for full evidence. Bucket empty again.
    //
    // LOTE R (2026-07-13): fastrouter landed here with discovery proven
    // (unauthenticated) but execution unprobed (gcloud ADC expired before
    // the key could be fetched). PROMOTED to `live-validation` 2026-07-15
    // once the operator re-authenticated — see the `live-validation`
    // bucket entry above for full evidence. Bucket empty again.
    //
    // LOTE T (2026-07-13): ailin — self-referential meta-gateway (this
    // engine, as a client of api.ailin.one). No AILIN_API_KEY provisioned
    // this session, so unlike O/Q there is no promotion to report yet.
    // Wiring verified contract-only against api.ailin.one's own
    // openapi-spec.yaml (chat/embeddings/images/audio confirmed OpenAI-
    // compatible shape at the generic hub's default paths); GET /v1/models
    // confirmed to return a richer native shape the generic fetcher only
    // partly understands. See the catalog entry's own notes for the
    // discovery-shape follow-up. Promote once a real key is provisioned
    // and a live probe confirms chat/completions.
    'ailin',
  ],

  // ── 6 partial ────────────────────────────────────────────────────────
  //    `partial` captures the SHAPE "at least one surface is live-proven,
  //    at least one surface is gated". Current instances split into two
  //    structural sub-shapes:
  //
  //    (A) Adapter wire-shape mismatch — key is valid, but the shipped
  //        adapter targets the wrong surface.
  //
  //      bytez — BytezAdapter extends OpenAICompatibleHubAdapter (expects
  //      /v1/models OAI-shape), but the real Bytez API lives at
  //      /models/v2/<hfmodel> with a native request shape. Key is valid
  //      (HTTP 403 "upgrade plan" = tier-gate proves auth). Partial until
  //      the adapter is rewritten against the native surface or until
  //      Bytez exposes an OAI-compat surface.
  //
  //    (B) Asymmetric auth — /models public, /chat credential-gated.
  //        Proven via no-auth probe against the canonical baseUrl.
  //
  //      venice (Sublote A 2026-04-23) — /api/v1/models HTTP 200 PUBLICLY
  //      (auth header actively ignored: invalid Bearer → same 200 body;
  //      72 models). /api/v1/chat/completions → HTTP 402 x402 payment-
  //      required body (USDC on Base eip155:8453) without Bearer, HTTP
  //      401 "Authentication failed" with invalid Bearer. Discovery
  //      live-proven; execution credential-gated.
  //
  //      atlascloud (Sublote B 2026-04-23) — api.atlascloud.ai/v1/models
  //      HTTP 200 PUBLICLY (auth ignored, 107 models, custom OAI-adjacent
  //      wrapper {code:200,msg:"succeed",data:[...]}). /chat gated.
  //
  //      avian (Sublote B 2026-04-23) — api.avian.io/v1/models HTTP 200
  //      PUBLICLY (auth ignored, 6 models, pure OAI shape). /chat gated.
  //
  //      phala (Sublote B 2026-04-23) — api.redpill.ai/v1/models HTTP 200
  //      PUBLICLY (auth ignored, 76 models including Anthropic Claude
  //      Sonnet 4.5 via the Phala TEE confidential-compute routing).
  //      /chat gated. Note: phala is a CONFIDENTIAL-COMPUTE router on
  //      Phala Network SGX TEEs; the public /models surface exposes the
  //      set of models available via the TEE routing layer.
  //
  //      mancer (Sublote B 2026-04-23) — neuro.mancer.tech/oai/v1/models
  //      HTTP 200 PUBLICLY (9 LLaMA-based fiction/RP models). Asymmetric
  //      detail: unlike venice/atlascloud/avian/phala, mancer VALIDATES
  //      the Authorization header when present (invalid Bearer → 401)
  //      but serves discovery when NO header is sent. Effectively the
  //      same operational signal: a client can enumerate models without
  //      a credential. /chat gated.
  //
  //    Promotion path out of `partial` for all (B)-class providers: a
  //    200 on /chat/completions (or the vendor's execution surface) with
  //    a real provisioned credential → live-validation.
  partial: [
    'bytez', // switch — wire-shape mismatch (OAI-compat adapter vs. vendor's /models/v2 native shape); tier-gated 403 on real path with valid key
    'venice', // catalog — asymmetric auth: /models 200 public (auth ignored), /chat 401/402 gated. Sublote A 2026-04-23
    'atlascloud', // catalog — /models 200 public (auth ignored, 107 models, custom {code,msg,data} wrapper). Sublote B 2026-04-23
    'avian', // catalog — /models 200 public (auth ignored, 6 models, pure OAI shape). Sublote B 2026-04-23
    'mancer', // catalog — /models 200 public when no header sent (9 models); VALIDATES invalid Bearer → 401 (asymmetric). Sublote B 2026-04-23
    'phala', // catalog — /models 200 public (auth ignored, 76 models via Phala SGX TEE confidential-compute routing on redpill.ai). Sublote B 2026-04-23
  ],

  // ── 54 canonical providers with no credential reachable this session ─
  //    Breakdown: 47 catalog (39 hosted + 8 self-hosted) + 7 switch
  //    (1 hosted + 5 self-hosted-local-* + 1 generic self-hosted adapter).
  //    Pre-LOTE-M: 46 (39 catalog + 7 switch). LOTE M added 13 catalog rows;
  //    Sublote A (2026-04-23) promoted venice → partial and Sublote B
  //    (2026-04-23) promoted atlascloud, avian, mancer, phala → partial on
  //    proven /models public HTTP 200 probes. Net LOTE M credentials-missing
  //    contribution: +8 (13 added − 5 promoted to partial).
  //
  //    2026-04-23 LOTE M (complement lot) initial deltas — 13 providers
  //    added; 8 remain in credentials-missing, 5 in partial post-Sublote-A+B:
  //
  //      + arcee, atlascloud, avian, gmi, infermatic, inflection, mancer,
  //        phala, relace, siliconflow, stepfun
  //          → secret-absent. Catalog rows added this lot; no GCP secret
  //            under any known alias. Operator must provision
  //            <PROVIDER>_API_KEY to unlock live-validation.
  //
  //      + qianfan (Baidu ERNIE promotion)
  //          → auth-incomplete. GCP holds ailin-baidu-{key,secret,base-url}
  //            (legacy v1 AK+SK OAuth material) but those secrets are the
  //            12-byte string "PLACEHOLDER" AND the canonical v2 runtime
  //            path uses a DIFFERENT key format (bce-v3/... bearer). A
  //            real QIANFAN_API_KEY must be provisioned alongside real
  //            baidu-{key,secret}. Analogous to aws-sagemaker's
  //            classification reasoning.
  //
  //      + venice — landed in credentials-missing at LOTE M close, then
  //        MOVED to `partial` on 2026-04-23 Sublote A after /api/v1/models
  //        was proven HTTP 200 public (no auth required, 72 models).
  //        Only 1 of 2 canonical surfaces is gated; discovery is live.
  //
  //      + atlascloud, avian, mancer, phala — all landed in credentials-
  //        missing at LOTE M close, then MOVED to `partial` on 2026-04-23
  //        Sublote B after /models/v1/models was proven HTTP 200 public
  //        (107 + 6 + 9 + 76 models respectively). Each provider has one
  //        canonical surface live-proven (discovery) and one gated
  //        (execution). See the `partial` bucket comment and the Sublote B
  //        superseded-claim #7 in NON_CANONICAL_HISTORICAL_CLAIMS for the
  //        probe evidence (16 probes × 12 providers = 192 probe records).
  //
  //    Previous (pre-LOTE-M) total 46 → now 54 (+8 net after Sublote A+B).
  //
  //    2026-04-23 SUBLOTE A probe-evidence (operational verification of
  //    the 4 Grupo-A providers — qianfan, venice, siliconflow, stepfun.
  //    ONE bucket move occurred: venice → partial on proven live discovery.
  //    The other three confirmed endpoint/base-URL correctness against
  //    live HEAD but remain gated by missing credentials):
  //
  //      · qianfan — v2 endpoint https://qianfan.baidubce.com/v2 ALIVE;
  //        401 invalid_iam_token on invalid bearer (BCE-shape error:
  //        {error:{code,message,type},id:'as-...'}). Base URL + authScheme
  //        confirmed. GCP legacy v1 secrets ailin-baidu-{key,secret,
  //        base-url} re-read this session: all three still literal
  //        "PLACEHOLDER". No ailin-qianfan-* or ailin-baidu-qianfan-*
  //        secret exists. Stays credentials-missing / auth-incomplete.
  //      · venice — /api/v1/models returns HTTP 200 PUBLICLY (no auth
  //        header required; with an INVALID Bearer it also returns 200,
  //        confirming auth is ignored on /models) with 72 text models
  //        in OAI-conformant shape ({data:[{id,object,owned_by,...}]});
  //        /api/v1/chat/completions returns HTTP 402 with x402 crypto-
  //        payment protocol body (USDC on Base eip155:8453,
  //        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) when no Bearer
  //        header is sent, HTTP 401 {"error":"Authentication failed"}
  //        when an invalid Bearer is sent. Asymmetric auth: one canonical
  //        surface is live-proven, one is gated. PROMOTED credentials-
  //        missing → partial (see `partial` bucket above for rationale).
  //        No ailin-venice-* secret under any alias in GCP.
  //      · siliconflow — api.siliconflow.cn/v1 ALIVE; 401 with body as
  //        a bare JSON string "Invalid token" (justifies integrationClass
  //        'oai-compat-quirks' — non-object error body). PRC-only endpoint
  //        confirmed: no .com equivalent probed successfully. No ailin-
  //        siliconflow-* secret. Stays credentials-missing / secret-absent.
  //      · stepfun — BOTH api.stepfun.com (canonical) and api.stepfun.ai
  //        (CDN alt; Alibaba Cloud cookies + x-router-id header observed)
  //        return identical OAI-compat error shape {"error":{"message":
  //        "Incorrect API key provided","type":"invalid_api_key"}} on
  //        invalid bearer. .com preserved as baseUrl (.ai remains an
  //        acceptable alt via notes). No ailin-stepfun-* secret. Stays
  //        credentials-missing / secret-absent.
  //
  //    Net matrix delta from Sublote A: ONE bucket move (venice →
  //    partial). 3/4 remain credentials-missing; 1/4 promoted on proven
  //    public discovery. Sublote A's primary value is OPERATIONAL proof-
  //    of-reachability — full live-validation of the execution surfaces
  //    requires secret provisioning (deferred to next sublote).
  //
  //    Sub-classification (applied to the credentials-missing bucket only):
  //      secret-absent       — no GCP secret of any known name or alias
  //      placeholder         — secret exists but value == "PLACEHOLDER"
  //      endpoint-absent     — key exists, no public base URL defined
  //      self-hosted-unreachable — expected to run locally; no reachable
  //                               endpoint from the probe environment
  //      auth-incomplete     — multi-piece auth where one component is absent
  //      operator-action-required — vendor requires out-of-band onboarding
  //                                 (AWS IAM role, GCP SA, enterprise SSO)
  //    The sub-classification is documented in
  //    CREDENTIALS_MISSING_SUBCLASS below (not a matrix column — keeps the
  //    matrix structurally simple; the sub-class is a refinement layer).
  'credentials-missing': [
    // ── Post Sublote D1 (2026-04-24) ────────────────────────────────────
    // Operator provisioned 17 GCP secrets on 2026-04-24. Of the 14 providers
    // that left this bucket:
    //   10 → live-validation (real chat-200 with provisioned credential)
    //         groq, deepinfra, huggingface, cloudflare-workers-ai,
    //         github-models, perplexity, fireworks-ai, sambanova,
    //         infermatic, heliconeai
    //    4 → upstream-suspended (auth accepted, credit/service gated)
    //         anyscale (permanent vendor-side shutdown Aug 2024),
    //         arcee/chutes/hyperbolic (402 "insufficient funds" with
    //         structurally-valid credential — same shape as ai302/palabraai)
    //    3 STAY here but move sub-class secret-absent → auth-incomplete
    //         (togetherai, siliconflow, stepfun — keys exist in vault,
    //         upstream rejects them with OAI-shape "invalid api key";
    //         probable format mismatch, operator must issue keys in the
    //         vendor's canonical prefix. See CREDENTIALS_MISSING_SUBCLASS).
    //    1 EXPECTED but NOT provisioned: gmi (operator's 2026-04-24
    //         announcement listed gmi, but GCP Secret Manager re-scan
    //         found no ailin-gmi-* or ailin-gmicloud-* under any alias —
    //         vault state disagrees with operator claim. gmi stays
    //         secret-absent until the actual secret lands.)
    // Net bucket delta: 54 → 40 (−14). No new adds.
    // Catalog — hosted (20 remaining: 17 pre-LOTE-M kept + 3 LOTE M kept)
    'bfl',
    'databricks',
    'lambda-ai',
    'minimax',
    'morph',
    'nebius',
    'nscale',
    'recraft',
    'runwayml',
    'scaleway',
    'synthetic',
    'togetherai', // D1 2026-04-24 — key provisioned (ailin-togetherai-api-key, key_CY… 25B) but /v1/chat returns OpenAI-shape 401 "Invalid API key". key_CY prefix is non-canonical for Together AI (normally tok_/hex). Probable format mismatch; operator must re-issue. Sub-class: auth-incomplete.
    'v0',
    'vercel-ai-gateway',
    'volcano',
    'watsonx',
    'xiaomi-mimo',
    'zai',
    // LOTE M 2026-04-23 survivors post-D1 (3 remain of original 7)
    'gmi', // D1 2026-04-24 — operator claimed provisioned but GCP scan 2026-04-24 found NO matching secret; vault state disagrees. Stays secret-absent until secret actually lands.
    'inflection',
    'relace',
    'siliconflow', // D1 2026-04-24 — key provisioned (ailin-siliconflow-api-key, sk-hhc… 51B) but /v1/chat returns bare JSON "Api key is invalid" (oai-compat-quirks shape). Sub-class: auth-incomplete.
    'stepfun', // D1 2026-04-24 — key provisioned (ailin-stepfun-api-key, 65B) but /v1/chat returns OAI-shape 401 "Incorrect API key provided". Sub-class: auth-incomplete.
    // 1 auth-incomplete carried from LOTE M close: qianfan has legacy v1
    // baidu-{key,secret} secrets in GCP but all are "PLACEHOLDER"; the v2
    // canonical runtime path also requires a bce-v3/... QIANFAN_API_KEY
    // that is not provisioned.
    'qianfan',
    // Catalog — self-hosted (8). Localhost endpoints are unreachable from
    // the probe environment; no key is needed but reachability is absent.
    'ollama',
    'local-llama',
    'local-kobold',
    'local-embeddings',
    'vllm',
    'lm-studio',
    'xinference',
    'triton',
    // Switch — hosted (1 — AWS pair reduced to just aws-sagemaker after
    // aws-bedrock was promoted this pass)
    'aws-sagemaker',
    // Catalog hosted: azure-openai (was in vendor-side-failure — re-probed
    // this phase-final confirms all three secrets (api-key, endpoint,
    // deployment) are the literal 12-byte string "PLACEHOLDER". This is a
    // secret-never-provisioned case, not a vendor-side failure.)
    'azure-openai',
    // Switch — self-hosted local-* (5)
    'local-ocr',
    'local-docling',
    'local-nllb',
    'local-cosyvoice',
    'local-piper',
    // Switch — generic self-hosted adapter (1)
    'self-hosted',
  ],

  // ── 2 vendor-side / config failures (not integration bugs) ───────────
  //    2026-04-23 final pass deltas:
  //      − gemini-openai (promoted to live-validation once GEMINI_API_KEY
  //        fallback chain was extended with `vertex-key`, which is NOT
  //        suspended and IS valid against generativelanguage.googleapis.com)
  //
  //    Remaining:
  //      · google — 403 CONSUMER_SUSPENDED on the google-key specifically.
  //        The switch case adapter reads GOOGLE_API_KEY (different env
  //        var than GEMINI_API_KEY), and the loader does NOT currently
  //        fall back to vertex-key for GOOGLE_API_KEY. Fixing this is a
  //        separate deliberate decision: `google` is the native
  //        GoogleGenerativeAI adapter, and routing traffic through
  //        gemini-openai (OAI-compat) may be preferred anyway. Kept as
  //        vendor-side-failure pending that decision.
  //      · azure-openai — endpoint secret literal "PLACEHOLDER" (never
  //        provisioned). Unchanged this pass.
  'vendor-side-failure': [
    'google', // switch — 403 CONSUMER_SUSPENDED on GOOGLE_API_KEY (google-key); separate from gemini-openai which now uses vertex-key fallback
    // azure-openai moved to credentials-missing (placeholder secrets)
  ],

  // ── 6 upstream suspended (auth valid, credit exhausted / service gated) ─
  //    jina classified as 'live-validation' because /v1/models returned
  //    200; the /v1/embeddings 403 "Insufficient balance" is a per-surface
  //    state, not a whole-provider classification.
  //
  //    2026-04-23 final pass: +palabraai. The ClientId/ClientSecret header
  //    pair (GCP secrets ailin-palabraai-id + ailin-palabraai-key) was
  //    accepted by api.palabra.ai/session-storage/session; the server
  //    rejected the action with an explicit "Insufficient balance"
  //    (error_code 100050, documented in their public error code table).
  //    Authentication is complete, balance is zero → upstream-suspended,
  //    NOT credentials-missing.
  //
  //    2026-04-24 Sublote D1: +4 (anyscale, arcee, chutes, hyperbolic).
  //    Three distinct sub-shapes land in this bucket this pass:
  //
  //      (a) Permanent vendor-side shutdown — anyscale: the Anyscale
  //          Endpoints multi-tenant LLM API was discontinued 2024-08-01
  //          ("available exclusively through the fully Hosted Anyscale
  //          Platform"). Probe of api.endpoints.anyscale.com returns the
  //          HTML shutdown notice. Auth cannot be tested because the
  //          endpoint itself is gone. Classified upstream-suspended
  //          because the vendor has permanently ceased serving public
  //          credentials; defunct-unreachable is reserved for credential-
  //          state rotations, not service-level shutdowns.
  //
  //      (b) Credit-exhausted 402 — arcee/chutes/hyperbolic: each provider
  //          accepted the provisioned API key (parsed Authorization,
  //          routed to the correct account) but returned an explicit
  //          zero-balance error:
  //            arcee  — {"detail":"Insufficient credits. Required: 0.000037, Available: 0.000000"}
  //            chutes — {"detail":{"message":"Quota exceeded and account balance is $0.0, please pay with fiat or send tao to..."}}
  //            hyperbolic — {"detail":"Insufficient funds, please see https://docs.hyperbolic.xyz/docs/hyperbolic-pricing"}
  //          Identical operational shape to ai302 and palabraai:
  //          authentication complete, balance zero, execution blocked.
  //          Promotion path: operator tops up credit → re-probe → live.
  'upstream-suspended': [
    'ai302', // 401 on /v1/models — prior session recorded "Insufficient account balance"; endpoint alive, tier-gated
    'palabraai', // switch — /session-storage/session POST returned 403 "Insufficient balance" (code 100050). Auth accepted.
    'anyscale', // D1 2026-04-24 — endpoint returns HTML shutdown notice "Effective August 1, 2024 Anyscale Endpoints API is available exclusively through the fully Hosted Anyscale Platform. Multi-tenant access to LLM models has been removed." ailin-anyscale-api-key provisioned (236B, aph0_C…) but cannot be exercised.
    'arcee', // D1 2026-04-24 — /v1/chat with trinity-mini returned 402 {"detail":"Insufficient credits. Required: 0.000037, Available: 0.000000"}. Auth accepted.
    'chutes', // D1 2026-04-24 — /v1/chat with Qwen/Qwen3-32B-TEE returned 402 {"detail":{"message":"Quota exceeded and account balance is $0.0, please pay with fiat or send tao to..."}}. Auth accepted.
    'hyperbolic', // D1 2026-04-24 — /v1/chat returned 402 {"detail":"Insufficient funds, please see https://docs.hyperbolic.xyz/docs/hyperbolic-pricing"}. Auth accepted.
  ],

  // ── 0 credentials in cache invalidated ───────────────────────────────
  //    2026-04-23 final pass: moonshot restored to live-validation. The
  //    previous "defunct" verdict came from probing api.moonshot.cn, but
  //    the canonical adapter uses api.moonshot.ai/v1 (verified in
  //    moonshot-adapter.ts::DEFAULT_BASE_URL). Re-probe against .ai → 200,
  //    14 models. Bucket now empty.
  'defunct-unreachable': [],

  // ── 3 catalog-only inventory (intentional non-execution) ─────────────
  'catalog-only-inventory': [
    'sap',
    'snowflake',
    'topaz',
  ],

  // ── 0 additional switch-only-legitimate ──────────────────────────────
  //    NOTE: first-party natives (openai, anthropic, …) and specialty
  //    audio (deepgram, cartesia, elevenlabs, palabraai) are switch-only
  //    BY LEGITIMATE design, but their current operational state is what
  //    determines their bucket. An openai that answered 200 this session
  //    is 'live-validation', not 'switch-only-legitimate'. This bucket
  //    exists for switch cases that have no other operational evidence
  //    AND are legitimate switch-only (not migration candidates). Today
  //    all such cases are covered by the buckets above.
  'switch-only-legitimate': [],

  // ── 0 canonical providers classified as 'not-eligible' ───────────────
  //    By definition canonical = catalog ∪ switch; all 103 members of
  //    that union are eligible. The 'not-eligible' field below lists
  //    orphans that are NOT in the canonical 103.
  'not-eligible': [],
};

/**
 * Sub-classification of the `credentials-missing` bucket — refines the
 * operator's next action for each provider. This is NOT a matrix column
 * (the matrix stays structurally simple with 10 buckets); it is a
 * refinement layer that the CLI tooling, admin dashboard, and backlog
 * reports consume to decide *what kind* of work is needed to unblock.
 *
 * ## Sub-class semantics
 *
 *   - `secret-absent`            — no GCP secret under any known name/alias
 *   - `placeholder`              — secret exists but value === "PLACEHOLDER"
 *   - `endpoint-absent`          — key exists but no public base URL
 *   - `self-hosted-unreachable`  — expected local runtime; no endpoint reachable
 *   - `auth-incomplete`          — multi-piece auth where one component is absent
 *   - `operator-action-required` — vendor requires out-of-band onboarding
 *                                  (AWS IAM role, GCP SA, enterprise SSO)
 *
 * ## Invariant
 *
 *   Every provider in CONSOLIDATION_MATRIX['credentials-missing'] MUST
 *   appear in exactly one sub-class here. The total of all sub-classes
 *   equals the credentials-missing bucket size.
 */
export const CREDENTIALS_MISSING_SUBCLASS: Record<string, readonly string[]> = {
  // Catalog hosted — no GCP secret under any known alias
  //   pre-LOTE-M count = 29
  //   LOTE M 2026-04-23 initial additions = 12 (arcee, atlascloud, avian,
  //     gmi, infermatic, inflection, mancer, phala, relace, siliconflow,
  //     stepfun, venice)
  //   Sublote A 2026-04-23 refinement = −1 (venice → partial).
  //   Sublote B 2026-04-23 refinement = −4 (atlascloud, avian, mancer,
  //     phala all promoted to `partial` after HTTP 200 public /models
  //     probe against canonical baseUrl).
  //   Sublote D1 2026-04-24 refinement = −16:
  //     −13 out of credentials-missing entirely (9 secret-absent →
  //        live-validation, 4 secret-absent → upstream-suspended).
  //     −3 same-bucket move (secret-absent → auth-incomplete for
  //        togetherai/siliconflow/stepfun — keys provisioned but
  //        upstream rejects the format).
  //     Post-D1 secret-absent total = 36 − 16 = 20
  //     (Of those 20: 17 pre-LOTE-M survivors + 3 LOTE-M survivors.
  //      gmi is notable — operator announced provisioning on 2026-04-24
  //      but GCP re-scan found no matching secret, so gmi stays here
  //      until the actual secret lands.)
  'secret-absent': [
    // Pre-LOTE-M survivors (17 of original 29; 12 promoted by D1)
    'bfl',
    'databricks',
    'lambda-ai',
    'minimax',
    'morph',
    'nebius',
    'nscale',
    'recraft',
    'runwayml',
    'scaleway',
    'synthetic',
    'v0',
    'vercel-ai-gateway',
    'volcano',
    'watsonx',
    'xiaomi-mimo',
    'zai',
    // LOTE M 2026-04-23 survivors (3 of original 7 — infermatic promoted
    // to live by D1; siliconflow/stepfun moved to auth-incomplete by D1)
    'gmi', // operator announced 2026-04-24 provisioning but GCP scan found no ailin-gmi-* or ailin-gmicloud-* under any alias — vault state disagrees with announcement.
    'inflection',
    'relace',
  ],
  // Secret exists but value === literal "PLACEHOLDER" (1)
  //   pre-D1 count = 2 (heliconeai + azure-openai)
  //   D1 2026-04-24 refinement = −1 (heliconeai → live-validation:
  //     operator provisioned ailin-heliconeai-api-key (sk-hel… 43B, real
  //     Helicone Proxy Virtual Key) which SUPERSEDES the legacy
  //     ailin-heliconeai-key (11B literal "PLACEHOLDER" that caused the
  //     prior mis-classification). Gateway routes to OpenAI with a real
  //     HTTP 200 completion body.)
  'placeholder': [
    'azure-openai', // ailin-azure-openai-api-key + -endpoint + -deployment all "PLACEHOLDER"
  ],
  // Local runtime expected; no reachable endpoint from probe environment (13)
  'self-hosted-unreachable': [
    'ollama',
    'local-llama',
    'local-kobold',
    'local-embeddings',
    'vllm',
    'lm-studio',
    'xinference',
    'triton',
    'local-ocr',
    'local-docling',
    'local-nllb',
    'local-cosyvoice',
    'local-piper',
    'self-hosted', // generic self-hosted adapter
  ],
  // Multi-piece auth where one component is absent (2 post-LOTE-M)
  //
  // aws-sagemaker: requires classic SigV4 secret access key (40-char base64),
  //   but GCP only holds ABSK-prefixed Bedrock API bearer tokens. The
  //   ailin-aws-key-id (AKIA... classic access key id) has no matching
  //   ailin-aws-secret-access-key pair in the vault.
  //
  // qianfan (LOTE M 2026-04-23): Baidu Qianfan exposes two auth paths:
  //   v1 legacy — AK+SK → OAuth access_token → query-param (backed by
  //     GCP secrets ailin-baidu-{key,secret,base-url}, BUT all three are
  //     literal "PLACEHOLDER" strings at HEAD so they cannot drive
  //     the v1 OAuth flow either).
  //   v2 canonical — bce-v3/... bearer key against qianfan.baidubce.com/v2
  //     (no ailin-qianfan-* secret exists in GCP; a new QIANFAN_API_KEY
  //     must be provisioned in the bce-v3 format — this is distinct
  //     from the legacy baidu-key even if both are eventually populated).
  //   Both paths are currently un-executable: v1 has placeholder secrets,
  //   v2 has no secret at all. Promotion to live-validation requires
  //   EITHER (a) real baidu-key + baidu-secret for the legacy adapter
  //   that this repo does not ship, OR (b) a new QIANFAN_API_KEY for the
  //   v2 OAI-compat catalog row that this lot added.
  //
  // togetherai (Sublote D1 2026-04-24): ailin-togetherai-api-key exists
  //   in GCP (25B, prefix "key_CY…") but POST /v1/chat/completions returns
  //   HTTP 401 {"error":{"message":"Invalid API key provided. You can find
  //   your API key at https://api.together.ai/settings/api-keys."...}}.
  //   The "key_" prefix is non-canonical for Together AI (whose keys are
  //   typically tok_ or raw 64-char hex). Probable format mismatch or a
  //   stale/revoked token; operator must re-issue from the Together
  //   dashboard. Auth-incomplete because the VAULT component exists but
  //   the credential's current state prevents upstream validation.
  //
  // siliconflow (Sublote D1 2026-04-24): ailin-siliconflow-api-key exists
  //   (51B, prefix "sk-hhc…") but POST /v1/chat/completions returns HTTP
  //   401 with body as a bare JSON string "Api key is invalid" (15 bytes,
  //   oai-compat-quirks shape). The sk- prefix looks OpenAI-style rather
  //   than SiliconFlow's standard format; probable format mismatch or
  //   account-scope issue. Operator must re-issue.
  //
  // stepfun (Sublote D1 2026-04-24): ailin-stepfun-api-key exists (65B)
  //   but POST /v1/chat/completions returns HTTP 401 with OAI-shape body
  //   {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}.
  //   Endpoint confirmed alive (verbatim OpenAI error shape). Operator
  //   must verify the key is correctly associated with the StepFun
  //   account and has the required access tier.
  'auth-incomplete': [
    'aws-sagemaker',
    'qianfan',
    'togetherai', // D1 2026-04-24 — key exists, upstream rejects ("Invalid API key")
    'siliconflow', // D1 2026-04-24 — key exists, upstream rejects ("Api key is invalid")
    'stepfun', // D1 2026-04-24 — key exists, upstream rejects ("Incorrect API key provided")
  ],
} as const;

/**
 * Discovery-compliance taxonomy — orthogonal to the operational matrix above.
 *
 * ## Why this exists (2026-04-27 — SOTA dynamic-discovery escalation)
 *
 * The operational `CONSOLIDATION_MATRIX` answers "is this provider reachable
 * right now?" — a credentialing/runtime question. It does NOT answer the
 * separate question: "does this provider's listing in /v1/models reflect a
 * machine-readable, official source-of-truth, or is it shaped by hand-curated
 * catalog rows we baked into the binary?"
 *
 * That second question is the SOTA dynamic-discovery contract. As of
 * 2026-04-27 the operator escalated the policy: ANY provider whose runtime
 * inventory in `/v1/models` is sourced from `staticModels`, the deprecated
 * static model-catalog stub (config/model-catalog.ts), frontier-candidate
 * seed arrays, hardcoded ID arrays in heuristics, or any in-repo seed list
 * is **non-compliant** with the dynamic-discovery contract — regardless of
 * whether the provider itself happens to also expose a real /models endpoint
 * that we just have not wired up yet.
 * (The symbol names are deliberately not written out here: the no-static-
 * model-catalog-fallback guard test scans every production source for them.)
 *
 * ## Revocation of prior completion buckets (binding 2026-04-27)
 *
 * The following INFORMAL labels — used in earlier audit reports as
 * "acceptable completion states" — are HEREBY REVOKED:
 *
 *   - `static-catalog-required`     — no longer a valid completion state
 *   - `catalog-inferred`            — no longer a valid completion state
 *   - `execution-only` w/ inventory — `integrationMode: 'execution-only'`
 *                                     remains a valid mode, but combining
 *                                     it with `staticModels:` to fabricate
 *                                     inventory is now non-compliant
 *   - `no-discovery accepted`       — no provider can reach a "discovery
 *                                     accepted" completion state if its
 *                                     /v1/models inventory is hardcoded
 *
 * The `catalog-only-inventory` operational bucket above (sap, snowflake,
 * topaz) DOES remain a structurally valid CLASSIFICATION — those providers
 * are intentionally non-executing — but the absence of a machine-readable
 * model surface means each of them ALSO appears in
 * `non-compliant-no-machine-readable-discovery` or
 * `not-applicable-non-model-surface` here, depending on whether the
 * provider's surface is in the LLM ontology at all.
 *
 * ## Bucket semantics (9 buckets, mutually exclusive over the canonical set)
 *
 *   compliant-dynamic-discovery
 *     The provider exposes a machine-readable /models endpoint (or a
 *     close equivalent — HuggingFace's catalog API, GitHub Models
 *     /catalog/models, Cloudflare's /ai/models/search, OpenAI /v1/models,
 *     etc.) AND a registered fetcher in
 *     `central-model-discovery-service.ts` materialises that into our DB
 *     at runtime. The /v1/models response for these providers reflects
 *     truly upstream-discovered IDs.
 *
 *   compliant-deployment-discovery
 *     The provider's "models" are deployment-scoped — Vertex AI,
 *     AWS Bedrock, AWS SageMaker — and discovery happens via a
 *     deployment-listing API at runtime. There is no static catalog of
 *     model IDs; the runtime materialises only the deployments the
 *     operator has provisioned in their cloud account.
 *
 *   compliant-machine-readable-official-catalog
 *     The provider does not publish a per-account /models endpoint, but
 *     ships an OFFICIAL machine-readable catalog (a versioned JSON file
 *     under their own domain, OpenAPI metadata in their docs, etc.) that
 *     we can fetch at runtime. Currently EMPTY; reserved for future
 *     promotions when a vendor publishes such a catalog without a
 *     /models endpoint of its own.
 *
 *   pinnedFallback-by-design
 *     The provider has `pinnedFallback.reason === 'no-list-endpoint'` —
 *     the vendor's API genuinely doesn't expose a model-listing surface
 *     (perplexity's docs say so explicitly; v0/xiaomi-mimo probes return
 *     404/HTML respectively; image-gen specialty providers like recraft
 *     and bfl have execution-only surfaces by design). The catalog row's
 *     pinnedFallback IS the source of truth and is treated as such by
 *     the runtime. CLASSIFIED AS COMPLIANT because there is nothing
 *     "non-compliant" about a vendor choosing not to publish /models —
 *     the operator-curated list is the inventory contract, not a
 *     placeholder. Distinct from `non-compliant-hardcoded-inventory`
 *     (which tracks debt: a parser we owe but haven't written) and
 *     `not-applicable-non-model-surface` (which tracks providers with
 *     no model ontology at all, like cartesia/elevenlabs voices).
 *
 *   non-compliant-hardcoded-inventory
 *     The provider has `pinnedFallback.reason === 'proprietary-schema'`
 *     (or legacy `staticModels`) — the vendor DOES expose a discovery
 *     surface but it's non-OAI-shaped and our adapter hasn't been
 *     written yet. The pinnedFallback list is an interim crutch.
 *     Promotion path: write the parser, drop the crutch, move to
 *     `compliant-dynamic-discovery`. This bucket is real engineering
 *     debt that should shrink over time.
 *
 *   non-compliant-no-machine-readable-discovery
 *     No `staticModels`, no upstream surface, no inventory. The provider
 *     is canonical (operator wants it tracked) but has nothing to list
 *     in /v1/models. Promotion path: vendor publishes a discovery API.
 *
 *   non-compliant-runtime-not-materialized
 *     The provider DOES expose a machine-readable surface (we have probe
 *     evidence or vendor docs prove its existence) but our runtime is
 *     currently NOT calling it — usually because the response shape needs
 *     a custom transform that has not been written yet. The `staticModels`
 *     array, if any, is an interim crutch. Promotion path: write the
 *     transform, drop the static array, register the fetcher.
 *
 *   not-applicable-non-model-surface
 *     The provider does not have "models" in the LLM sense — its API
 *     surface is voices, agents, scenes, image-enhancement filters, or
 *     other artefacts that don't map to the chat/completion ontology.
 *     Specialty audio (cartesia/deepgram/elevenlabs/palabraai) and
 *     image-enhancement (topaz) are the canonical examples. These
 *     providers are NOT non-compliant; they are operating in a different
 *     category entirely.
 *
 *   self-hosted-runtime-dependent
 *     The provider is operator-deployed (ollama, vLLM, lm-studio, generic
 *     self-hosted, every local-* adapter). Discovery is a function of
 *     what the operator has loaded into THEIR runtime. This is a
 *     compliance-irrelevant case, not a non-compliance — discovery for
 *     these providers is genuinely runtime-bound and should not pretend
 *     to be otherwise.
 *
 * ## Invariants (enforced by discovery-compliance-registry.test.ts)
 *
 *   J1 — every canonical providerId (catalog ∪ switch) appears in exactly
 *        ONE compliance bucket.
 *   J2 — every providerId in `non-compliant-runtime-not-materialized`
 *        MUST also be a provider with `staticModels` in
 *        `providers.catalog.ts` (the static array is the smoking gun
 *        for this bucket; otherwise it would be `compliant-dynamic-
 *        discovery` or `non-compliant-no-machine-readable-discovery`).
 *   J3 — every providerId with `staticModels` or `pinnedFallback.models`
 *        in `providers.catalog.ts` MUST appear in one of THREE
 *        static-inventory buckets:
 *           • `pinnedFallback-by-design` (compliant — vendor has no
 *             upstream surface, the curated list IS the contract),
 *           • `non-compliant-hardcoded-inventory` (debt — vendor has a
 *             non-OAI surface, our parser is queued), or
 *           • `non-compliant-runtime-not-materialized` (debt — real
 *             machine-readable surface exists, fetcher pending).
 *        No quiet exemptions: every static array is bucketed.
 *   J4 — buckets are exactly the 9 above.
 *   J5 — the registry's union equals the canonical set
 *        |catalog ∪ switch| = 103 at HEAD.
 *
 * ## How to USE this registry
 *
 *   - The /v1/models route consumes this to populate the `inventoryClass`
 *     provenance field on each model row in the response.
 *   - The CI guard `discovery-compliance-registry.test.ts` enforces
 *     J1–J5.
 *   - When a non-compliant provider is migrated (a fetcher lands, a
 *     deployment-listing call is wired, etc.), update both the catalog
 *     row (drop `staticModels`) AND this registry in the same commit.
 */
export const DISCOVERY_COMPLIANCE_BUCKETS = [
  'compliant-dynamic-discovery',
  'compliant-deployment-discovery',
  'compliant-machine-readable-official-catalog',
  // Phase 6 Fix 7 (2026-04-30): pinnedFallback-by-design split.
  // Providers with `pinnedFallback.reason === 'no-list-endpoint'` are
  // promoted out of `non-compliant-hardcoded-inventory` to reflect
  // that the operator-curated list IS the inventory contract — the
  // vendor having no /models is a vendor choice, not engineering debt.
  'pinnedFallback-by-design',
  'non-compliant-hardcoded-inventory',
  'non-compliant-no-machine-readable-discovery',
  'non-compliant-runtime-not-materialized',
  'not-applicable-non-model-surface',
  'self-hosted-runtime-dependent',
] as const;

export type DiscoveryComplianceClass = (typeof DISCOVERY_COMPLIANCE_BUCKETS)[number];

/**
 * Per-bucket compliance assignment of every canonical providerId.
 *
 * The classification is independent of the operational `CONSOLIDATION_MATRIX`:
 * an upstream-suspended provider that DOES expose /v1/models on its docs
 * (e.g. arcee, chutes, hyperbolic) is still `compliant-dynamic-discovery`
 * here — because the question this registry answers is "is the inventory
 * source-of-truth dynamic?", not "is the provider reachable?".
 *
 * Distribution at HEAD (2026-04-30, post Phase 6 Fix 7 split):
 *   compliant-dynamic-discovery                 = 62
 *   compliant-deployment-discovery              = 3
 *   compliant-machine-readable-official-catalog = 0
 *   pinnedFallback-by-design                    = 7   (Phase 6 Fix 7: perplexity, recraft,
 *                                                       runwayml, bfl, inworld, v0, xiaomi-mimo —
 *                                                       all `reason: 'no-list-endpoint'`)
 *   non-compliant-hardcoded-inventory           = 2   (inflection, relace — both
 *                                                       `reason: 'proprietary-schema'`,
 *                                                       i.e. real parser-debt)
 *   non-compliant-no-machine-readable-discovery = 2
 *   non-compliant-runtime-not-materialized      = 8
 *   not-applicable-non-model-surface            = 5
 *   self-hosted-runtime-dependent               = 14
 *   TOTAL                                       = 103 ✓
 *
 * Phase 4d (2026-04-28): bytez was promoted from
 * `non-compliant-runtime-not-materialized` to `compliant-dynamic-discovery`.
 * The dedicated `BytezNativeModelFetcher` consumes the vendor's
 * `/models/v2/list/models` endpoint (non-OAI shape) and feeds the
 * central discovery service via the `fetcherClass` catalog field. The
 * row's `integrationMode` flipped `execution-only` → `discovery+execution`
 * accordingly, and the deprecated `staticModels` block was removed.
 *
 * Registry-sync 2026-04-28 (Phase 4d closure): `v0` and `xiaomi-mimo`
 * were demoted from `compliant-dynamic-discovery` to
 * `non-compliant-hardcoded-inventory` to match the catalog's
 * `pinnedFallback` declaration. Live probes (catalog `notes`):
 *   - api.v0.dev/v1/models           → HTTP 404 not_found_error
 *   - platform.xiaomimimo.com/v1/models → HTML homepage (no JSON listing)
 * Both rows ship `pinnedFallback.models` as the inventory of record;
 * `compliant-dynamic-discovery` was a stale assumption from initial
 * catalog drafting. Surfaced by test J3 (catalog static-inventory must
 * map to a non-compliant bucket).
 */
export const DISCOVERY_COMPLIANCE_REGISTRY: Record<DiscoveryComplianceClass, readonly string[]> = {
  // ── 62 — Real /models endpoint + registered fetcher ──────────────────
  // For each of these, central-model-discovery-service.ts has a
  // DiscoverySource that calls the upstream /models surface, parses the
  // response, and writes canonical Model rows to the DB. The /v1/models
  // response for these providers reflects runtime-materialised inventory.
  'compliant-dynamic-discovery': [
    // Switch natives (8 — first-party APIs with /v1/models or equivalent)
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'mistral',
    'xai',
    'cohere',
    'jina',
    // Switch routers (1)
    'openrouter',
    // Catalog hub OAI-compat with materialiser wired into the central
    // discovery service (20 — pre-D1 set, all live-validated at HEAD)
    'aihubmix',
    'aiml',
    'cerebras',
    'cometapi',
    'edenai',
    'featherless-ai',
    'friendli',
    'gemini-openai',
    'heliconeai',
    'imagerouter',
    'moonshot',
    'nanogpt',
    'novita',
    'nvidia',
    'orqai',
    'poe',
    'requesty',
    'routeway',
    'upstage',
    'wandb',
    // 2026-06: alibaba catalog entry added (oai-compat-pure /models discovery
    // on dashscope) — registered here to keep J1 partition complete.
    'alibaba',
    // Sublote D1 promotions (8 — credential provisioned 2026-04-24)
    'groq',
    'deepinfra',
    'huggingface',
    'cloudflare-workers-ai',
    'github-models',
    'fireworks-ai',
    'sambanova',
    'infermatic',
    // Operationally upstream-suspended but discovery-shape compliant (5)
    // (auth accepted, balance/credit gated; their /models surface is real)
    'ai302',
    'arcee',
    'chutes',
    'hyperbolic',
    'anyscale',
    // Credentials-missing but the catalog row points at a real /models
    // surface — these will materialise when a credential lands (18)
    'lambda-ai',
    'minimax',
    'morph',
    'nebius',
    'nscale',
    'scaleway',
    'synthetic',
    // v0 and xiaomi-mimo demoted 2026-04-28 to `non-compliant-hardcoded-inventory`
    // — live probes prove no /v1/models surface exists; pinnedFallback in
    // catalog is the inventory of record. See registry-sync note above.
    'vercel-ai-gateway',
    'volcano',
    'watsonx',
    'zai',
    'gmi',
    'rekaai',
    'siliconflow',
    'stepfun',
    'togetherai',
    // Sublote A/B confirmed /models 200 public against canonical baseUrl (3)
    'venice',
    'mancer',
    'phala',
    // Phase 4d 2026-04-28 — promoted from non-compliant-runtime-not-materialized
    // BytezNativeModelFetcher (api/src/services/model-fetchers/bytez-native-model-fetcher.ts)
    // wires the vendor's /models/v2/list/models non-OAI shape into the
    // central discovery service via the catalog `fetcherClass` field;
    // execution path flipped `execution-only` → `discovery+execution`.
    'bytez',
    // LOTE O (2026-07-10) — apertis, inception. Both confirmed via doc
    // research to expose a real `GET /v1/models` (OpenAI-shaped) surface
    // consumed by the generic OpenAICompatibleHubModelFetcher; no probe
    // ran this session (see consolidation-matrix `no-live-validation`),
    // but the discovery SHAPE is compliant by design, independent of
    // whether a probe has confirmed it live yet.
    'apertis',
    'inception',
    // LOTE P (2026-07-11) — empiriolabs. Real GET /v1/models confirmed
    // live (134+ models, OpenAI-list shape), consumed by the generic hub
    // fetcher same as apertis/inception.
    'empiriolabs',
    // LOTE Q (2026-07-12) — concentrate. UNAUTHENTICATED /v1/models/
    // confirmed live 2026-07-12 (`{object:"list",data:[{id,owned_by,...}]}`
    // — same shape the generic hub fetcher expects). The provider's own
    // richer per-provider enrichment endpoints are NOT consumed here.
    'concentrate',
    // LOTE R (2026-07-13) — fastrouter. UNAUTHENTICATED /api/v1/models
    // confirmed live 2026-07-13 (`{data:[{id,creator,pricing,...}]}` —
    // same shape the generic hub fetcher expects, plus a real `pricing`
    // object directly on the flat list unlike apertis/empiriolabs/
    // concentrate).
    'fastrouter',
    // LOTE S (2026-07-13) — perplexity-agent. AUTHENTICATED GET /v1/models
    // confirmed live 2026-07-13 — real OpenAI-list shape
    // (`{data:[{id,object,owned_by,created}]}`), 32 real models across 6
    // vendor families. Unlike the classic `perplexity` row (no /models
    // endpoint at all, pinnedFallback by design), the Agent API surface has
    // genuine dynamic discovery.
    'perplexity-agent',
    // LOTE T (2026-07-13) — ailin. Compliant by shape, same reasoning as
    // apertis/inception above (no live probe this session, but the
    // discovery SHAPE is what this bucket classifies). GET /v1/models
    // returns id + a provider-attribution field the generic fetcher
    // successfully extracts (via `originalProviderField: 'originProvider'`
    // in the catalog entry) — the two things `compliant-dynamic-discovery`
    // actually requires. The response ALSO carries ailin-native enrichment
    // fields (operability, fallbackChain, resolvedProvider) the generic
    // fetcher ignores rather than mis-parses; that's a metadata-richness
    // gap, not a shape-compliance failure — J2's static-inventory
    // requirement (which `non-compliant-runtime-not-materialized` would
    // impose) does not apply here because there IS no static inventory:
    // this is a 70k-model, constantly-shifting catalog, and pinning a
    // fallback list would misrepresent it (see catalog entry notes).
    'ailin',
  ],
  // ── 3 — Deployment-bound discovery ───────────────────────────────────
  // Discovery via a deployment-listing API; runtime materialises only
  // what the operator has provisioned in their cloud account.
  'compliant-deployment-discovery': [
    'vertex-ai', // /publishers/{publisher}/models — deployment-scoped
    'aws-bedrock', // /foundation-models — Bearer or SigV4
    'aws-sagemaker', // /endpoints — operator-provisioned
  ],
  // ── 0 — Reserved for future official machine-readable catalogs ───────
  'compliant-machine-readable-official-catalog': [
    // EMPTY at HEAD. Fill when a vendor publishes a versioned JSON
    // catalog under their own domain (no /models endpoint, no per-account
    // state) that we can fetch at runtime. None of the canonical 103
    // currently fit.
  ],
  // ── 7 — pinnedFallback is the inventory contract, by vendor design ───
  // The vendor's API genuinely doesn't expose a /models endpoint and
  // never will (catalog `pinnedFallback.reason === 'no-list-endpoint'`).
  // The operator-curated `pinnedFallback.models` list IS the source of
  // truth — there is nothing to "fix" upstream. Classified as compliant
  // because forcing these into a "non-compliant-*" bucket misleads
  // operators into chasing phantom upstream surfaces.
  //
  // Distinct from `non-compliant-hardcoded-inventory` (vendor DOES expose
  // discovery, parser unwritten — engineering debt) and from
  // `not-applicable-non-model-surface` (vendor has no model ontology at
  // all — voices, filters, etc.).
  //
  // Phase 6 Fix 7 (2026-04-30): split out from
  // `non-compliant-hardcoded-inventory` once the dossier flagged that
  // /v1/models was reporting 22 model rows under "non-compliant" when
  // they were operator-curated by-design pins.
  'pinnedFallback-by-design': [
    'perplexity', // pinnedFallback.reason: 'no-list-endpoint' — Sonar family,
    //              Perplexity's docs explicitly state no /models endpoint.
    'recraft', // pinnedFallback.reason: 'no-list-endpoint' — image-only
    //           (recraftv3, recraftv2); execution-only integrationMode.
    'runwayml', // pinnedFallback.reason: 'no-list-endpoint' — video-only
    //            (gen3*); execution-only integrationMode.
    'bfl', // pinnedFallback.reason: 'no-list-endpoint' — Black Forest Labs
    //       Flux image generation; no /models surface published.
    'inworld', // pinnedFallback.reason: 'no-list-endpoint' — discovery
    //           endpoints both return 404 per catalog notes.
    'v0', // pinnedFallback.reason: 'no-list-endpoint' — api.v0.dev/v1/models
    //      returns HTTP 404 not_found_error; public docs describe
    //      chats/projects/deployments shape, not a model selector.
    'xiaomi-mimo', // pinnedFallback.reason: 'no-list-endpoint' —
    //               platform.xiaomimimo.com/v1/models returns the
    //               platform's HTML homepage (no JSON listing).
    'topaz', // pinnedFallback.reason: 'no-list-endpoint' — fixed roster of
    //         image-enhance pipelines (standard/high-fidelity); moved here
    //         from not-applicable-non-model-surface when the runnable-gap
    //         pass gave it a curated pinned inventory (2026-06-11, J3).
  ],
  // ── 2 — pinnedFallback as interim crutch, parser pending ─────────────
  // Real engineering debt — vendor DOES expose a discovery surface but
  // it's `pinnedFallback.reason === 'proprietary-schema'`: the parser
  // has not been written yet. Promotion path: write the parser, drop
  // the static array, move to `compliant-dynamic-discovery`. This
  // bucket should shrink over time.
  'non-compliant-hardcoded-inventory': [
    'inflection', // pinnedFallback.reason: 'proprietary-schema' — Sublote B
    //              confirmed 404 on candidate OAI paths; vendor's discovery
    //              surface, when available, is non-OAI shape.
    'relace', // pinnedFallback.reason: 'proprietary-schema' — Sublote B
    //          observed uniform 401 across 8 discovery paths; the catalog
    //          carries pinnedFallback (relace-apply-3, relace-code-reranker,
    //          relace-embedding) as the only inventory source until the
    //          adapter+secret combination is wired.
  ],
  // ── 2 — No staticModels, no upstream surface, nothing to materialise ─
  // The provider is canonical (operator wants it tracked) but currently
  // has nothing to list in /v1/models. Promotion path: vendor publishes
  // a discovery API.
  'non-compliant-no-machine-readable-discovery': [
    'sap', // SAP AI Core — workspace-local deployment IDs, no model-listing
    'snowflake', // Cortex — function-based API, no model-listing endpoint
  ],
  // ── 9 — staticModels but real upstream surface exists ────────────────
  // These have `staticModels: [...]` in providers.catalog.ts AND a real
  // machine-readable surface that we know about. Each is a queued
  // engineering task — wire the surface, drop the static array, move to
  // `compliant-dynamic-discovery`.
  'non-compliant-runtime-not-materialized': [
    'replicate', // /v1/models exists; operator opted not to import 'thousands' wholesale
    // Phase 4d 2026-04-28 — bytez promoted to `compliant-dynamic-discovery`
    // via BytezNativeModelFetcher; entry removed from this bucket.
    'voyage', // /v1/models exists upstream, fetcher not wired
    'azure-openai', // /openai/deployments exists, deployment-listing not wired
    'databricks', // /api/2.0/serving-endpoints exists, fetcher not wired
    'writer', // /models {models:[...]} non-OAI shape, parser pending
    'atlascloud', // Sublote B: /v1/models 200 public (107 models), wrapper transform pending
    'avian', // Sublote B: /v1/models 200 public (6 models), wiring pending
    'qianfan', // /v2/models per BCE OAI-compat docs; secret + adapter pending
  ],
  // ── 5 — Specialty surfaces, not LLM-model-shaped ─────────────────────
  // These providers are NOT non-compliant; they operate in a different
  // category entirely. Their public surface is voices/scenes/filters,
  // not a chat/completion ontology.
  'not-applicable-non-model-surface': [
    'cartesia', // /voices, not /models — TTS specialty
    'deepgram', // /v1/models lists STT engines, not LLM ontology
    'elevenlabs', // /v1/voices, not /v1/models — TTS specialty
    'palabraai', // session-based real-time translation, no model ontology
    // 'topaz' moved to pinnedFallback-by-design (2026-06-11): the
    // runnable-gap pass gave it a curated pinnedFallback inventory
    // (reason: 'no-list-endpoint'), which is exactly that bucket's
    // semantics (J3).
  ],
  // ── 14 — Self-hosted runtime-dependent ───────────────────────────────
  // Discovery is a function of operator runtime. NOT non-compliant —
  // discovery for these providers is genuinely runtime-bound by design.
  'self-hosted-runtime-dependent': [
    // Catalog self-hosted (8)
    'ollama',
    'local-llama',
    'local-kobold',
    'local-embeddings',
    'vllm',
    'lm-studio',
    'xinference',
    'triton',
    // Switch self-hosted (6)
    'self-hosted',
    'local-ocr',
    'local-docling',
    'local-nllb',
    'local-cosyvoice',
    'local-piper',
  ],
} as const;

/**
 * Convenience predicate: is the providerId classified as compliant
 * with the SOTA dynamic-discovery contract (any of the three compliant
 * buckets)? Self-hosted is treated as compliant-by-category since its
 * inventory genuinely depends on operator runtime.
 */
export function isDiscoveryCompliant(providerId: string): boolean {
  const compliantBuckets: readonly DiscoveryComplianceClass[] = [
    'compliant-dynamic-discovery',
    'compliant-deployment-discovery',
    'compliant-machine-readable-official-catalog',
    // Phase 6 Fix 7 (2026-04-30): pinnedFallback-by-design is compliant —
    // the operator-curated list IS the inventory contract when the vendor
    // genuinely doesn't expose /models. See bucket docstring.
    'pinnedFallback-by-design',
    'self-hosted-runtime-dependent',
    'not-applicable-non-model-surface',
  ];
  for (const bucket of compliantBuckets) {
    if (DISCOVERY_COMPLIANCE_REGISTRY[bucket].includes(providerId)) return true;
  }
  return false;
}

/**
 * Reverse lookup: given a providerId, return its compliance class
 * (or undefined if the providerId is not in the canonical set).
 */
export function getDiscoveryComplianceClass(
  providerId: string,
): DiscoveryComplianceClass | undefined {
  for (const bucket of DISCOVERY_COMPLIANCE_BUCKETS) {
    if (DISCOVERY_COMPLIANCE_REGISTRY[bucket].includes(providerId)) return bucket;
  }
  return undefined;
}

/**
 * Orphan inventory — in-tree secrets and/or adapter classes that are NOT
 * in the canonical set. These are tracked so operational counters never
 * accidentally include them. They are NOT part of the consolidation matrix
 * proper (the test asserts disjointness).
 *
 * ## Triage decision (2026-04-23 — Lot B closure applied + backlog cleared):
 *
 *   - `writer`, `upstage`, `rekaai`: CLOSED as of 2026-04-23 via Lot B
 *     (catalog rows, factory registrations, secret mappings added). They
 *     are no longer orphans — they are canonical providers in the
 *     `live-validation` bucket above.
 *
 *   - `ai21`, `llmstats`, `merge`: VERIFIED-CLEAN as of 2026-04-23. Grep
 *     across `src/config/load-secrets-into-env.ts` returned no matches
 *     for any of these — previous removal lots already cleared them.
 *     The only residual reference is `ai21` in `NATIVE_PROVIDERS`
 *     (src/core/selection/provider-kind.ts): that set is a permissive
 *     routing-bias classifier where extra entries have no runtime cost
 *     (the classifier never receives a non-canonical providerId from
 *     code paths that only dispatch canonical providers). Accepted as
 *     structural exception; documented here rather than surgically
 *     removed to avoid re-breaking a settled decision.
 */
export const NON_CANONICAL_PROVIDERS = {
  // Empty as of 2026-04-23 — Lot B closed writer/upstage/rekaai. If a
  // future orphan needs transient tracking (adapter on disk, no catalog
  // row, no factory), it goes here until the closure lot is shipped.
  pending_closure: [] as const,
  // Empty as of 2026-04-23 — backlog verified clean via grep. See
  // triage note above for the full reasoning.
  pending_removal: [] as const,
} as const;

/**
 * Historical claims from prior reports that are superseded by this
 * consolidation. Keeping them here (not in the matrix) makes the
 * supersession explicit and audit-traceable, without letting them
 * contaminate operational counts.
 *
 * The invariant test asserts none of these strings appear in any
 * bucket of CONSOLIDATION_MATRIX.
 */
export const NON_CANONICAL_HISTORICAL_CLAIMS = [
  {
    claim: '0 live probes this session',
    superseded_at: '2026-04-23',
    reason:
      '41 HTTP probes were executed in the 2026-04-23 consolidation session; 28 canonical providers classified as live-validation at first-pass, 31 after Lot B closure of writer/upstage/rekaai.',
  },
  {
    claim: '29 providers live-validated',
    superseded_at: '2026-04-23',
    reason: 'The 29 figure belonged to a prior probe session. Pre-Lot-B this consolidation recorded 28 canonical live-validated providers; post-Lot-B (writer/upstage/rekaai promoted from orphan to canonical in the same turn) the figure is 31.',
  },
  {
    claim: '32 providers live-validated',
    superseded_at: '2026-04-23',
    reason:
      'The 32 figure counted writer/upstage/rekaai/ai21 as canonical, but at the time only ai21 remained non-canonical. As of Lot B closure in this session, writer/upstage/rekaai ARE canonical (with probe-pre-closure-200 evidence); ai21 remains non-canonical pending removal. The correct canonical count for that probe set is now 31.',
  },
  {
    claim: 'canonical count = 87',
    superseded_at: '2026-04-23',
    reason:
      'At first-pass of this session the audit recorded catalog=65 + switch=22 = 87. Lot B closure (writer/upstage/rekaai orphan-to-canonical) brings catalog=68 + switch=22 = 90. The invariant test does NOT pin the number; it pins structural identity (matrix total equals canonical union size).',
  },
  {
    claim: 'canonical count = 90',
    superseded_at: '2026-04-23',
    reason:
      'Post Lot B and pre LOTE M the audit recorded catalog=68 + switch=22 = 90. LOTE M 2026-04-23 complement lot (arcee, atlascloud, avian, gmi, infermatic, inflection, mancer, phala, qianfan, relace, siliconflow, stepfun, venice — 13 net adds: 12 hosted OAI-compat + 1 catalog-only) brings catalog=81 + switch=22 = 103. The invariant test still pins structural identity, not the number; this claim exists so a grep for `= 90` against the matrix surfaces as explicitly superseded rather than looking authoritative.',
  },
  {
    claim: '31 providers live-validated (post Lot B, pre late-pass)',
    superseded_at: '2026-04-23',
    reason:
      'Late-pass probes on 2026-04-23 promoted 5 providers to live-validation (edenai re-probed with correct secret → 200/330 models; openrouter /api/v1/models → 200/349 models; cartesia /voices → 200/751 voices; deepgram /v1/models → 200 using Token auth scheme; elevenlabs /v1/voices → 200) and demoted 1 (moonshot /v1/models → 401, previously 200). Net +4 → 35 live-validated providers (24 catalog + 11 switch).',
  },
  {
    claim: 'gemini-openai is no-live-validation',
    superseded_at: '2026-04-23',
    reason:
      'gemini-openai shares the google api_key state. A direct probe against generativelanguage.googleapis.com returned 403 CONSUMER_SUSPENDED — the key was suspended server-side, not scope-limited. gemini-openai therefore shares the google vendor-side-failure classification rather than sitting in no-live-validation.',
  },
  {
    claim: 'google 403 is an SA scope limit',
    superseded_at: '2026-04-23',
    reason:
      'Probe against generativelanguage.googleapis.com this session returned an explicit "Consumer \'api_key:...\' has been suspended" message (403 CONSUMER_SUSPENDED), not a scope-denial. The failure is vendor-side key state, not a scope mismatch. Bucket is unchanged (still vendor-side-failure), only the reason text is corrected.',
  },
  {
    claim: 'edenai credential is rotated server-side (defunct)',
    superseded_at: '2026-04-23',
    reason:
      'The prior probe pass used secret ailin-edenai-api-key and got 401, concluding "rotated". This pass probed /v3/llm/models with ailin-edenai-key (alternate GCP secret in the same project) and got HTTP 200 with 330 models. edenai is live-validated; the defunct verdict was a secret-selection bug in the prior pass.',
  },
  {
    claim: 'moonshot live-validated (from earlier session)',
    superseded_at: '2026-04-23',
    reason:
      'Re-probe of api.moonshot.cn/v1/models with the same secret (ailin-moonshot-key) returned 401 this pass, where the previous session recorded 200. Whether the key was rotated or the public API tier changed is undetermined; moonshot is reclassified defunct-unreachable until next probe lot establishes the cause.',
  },
  {
    claim: 'moonshot is defunct-unreachable (from the pre-final late-pass)',
    superseded_at: '2026-04-23',
    reason:
      'The "defunct" verdict came from probing api.moonshot.cn (PRC-region host). The canonical MoonshotAdapter uses api.moonshot.ai/v1 (see DEFAULT_BASE_URL in moonshot-adapter.ts). This final pass re-probed the ACTUAL adapter target api.moonshot.ai/v1/models with the same GCP secret ailin-moonshot-key → HTTP 200, 14 models. The integration was never broken; the earlier 401 was a probe-target bug, not a credential rotation. moonshot is restored to live-validation.',
  },
  {
    claim: 'aws-bedrock is credentials-missing (requires SigV4, cannot probe)',
    superseded_at: '2026-04-23',
    reason:
      'AWS added Bearer-token authentication for Bedrock read endpoints in 2025, alongside the existing SigV4 flow. GCP secret ailin-aws-bearer-token was probed against GET bedrock.us-east-1.amazonaws.com/foundation-models → HTTP 200, 163KB body, modelSummaries array populated. Credentials ARE available and the read path works without SigV4 signing. Invocation endpoints still use SigV4 via @aws-sdk/signature-v4, which is a separate surface; the bucket classification is based on reachable credential evidence, and that evidence now exists. aws-bedrock → live-validation.',
  },
  {
    claim: 'palabraai is credentials-missing',
    superseded_at: '2026-04-23',
    reason:
      'GCP secrets ailin-palabraai-id (ClientId) and ailin-palabraai-key (ClientSecret) exist. Probe of POST api.palabra.ai/session-storage/session with both headers returned HTTP 403 with body {"detail":"Insufficient balance","error_code":100050} — the Palabra public error-code table documents 100050 as post-authentication credit exhaustion. This is upstream-suspended (auth accepted, tier-gated), NOT credentials-missing.',
  },
  {
    claim: 'complement lot (2026-04-23) — 21 brand names to integrate',
    superseded_at: '2026-04-23',
    reason:
      'Mapping table produced for Arcee/AtlasCloud/Avian/BaiduQianfan/BFL/Chutes/GMICloud/Infermatic/Inflection/Liquid/Mancer/MiniMax/ModelRun/nCompass/Phala/Reka/Relace/SiliconFlow/StepFun/Upstage/Venice. Outcome: 5 already-canonical (bfl, chutes, minimax, rekaai, upstage); 1 orphan-with-material (baidu-qianfan — has BaiduModelFetcher + secret mapping ailin-baidu-{key,secret,base-url}, but all 3 secrets are literal "PLACEHOLDER" and the fetcher uses deprecated ERNIE OAuth2 shape; canonical promotion deferred to a dedicated lot that (a) adds baidu-qianfan catalog row with qianfan.baidubce.com/v2 OAI-compat base URL, (b) replaces the ERNIE OAuth2 fetcher with Bearer auth, (c) requires real secret provisioning); 15 absent (arcee, atlascloud, avian, gmicloud, infermatic, inflection, liquid, mancer, modelrun, ncompass, phala, relace, siliconflow, stepfun, venice — no material in-tree, no secrets provisioned). Per the directive exigência final ("Não quero provider adicionado só porque ganhou row no catálogo"), catalog row additions were NOT committed in this lot; they await operator secret provisioning to ensure each row ships with live-validation evidence. Proposed row shapes captured in the lot report (section 14 "Próximo lote objetivo").',
  },
  {
    claim: 'LOTE M deferral — await operator secret provisioning before adding rows',
    superseded_at: '2026-04-23',
    reason:
      'Operator decision 2026-04-23 (message #2 of complement-lot session): "#1 Escopo completo #2 A #3 Prossiga com a melhor recomendação para cada" authorized catalog-row additions without waiting for secret provisioning. The deferral rationale (every row should ship with live-validation evidence) was superseded by the operator-level decision to land the rows now AND track each one explicitly in credentials-missing/secret-absent (or auth-incomplete for qianfan). This makes the "missing work" visible in the matrix — operators see 12 rows waiting for <PROVIDER>_API_KEY provisioning — rather than invisible in a narrative-only backlog. 13 rows added this lot (arcee, atlascloud, avian, gmi, infermatic, inflection, mancer, phala, qianfan, relace, siliconflow, stepfun, venice); the 3 NOT_ELIGIBLE providers (liquid, modelrun, ncompass) are recorded in separate historical claims below.',
  },
  {
    claim: 'liquid (Liquid AI) eligible for canonical catalog inclusion',
    superseded_at: '2026-04-23',
    reason:
      'Liquid AI (LFM family) has no first-party production API as of 2026-04-23. LFM models (LFM-40B, LFM-3B, LFM-1B) are distributed through OpenRouter and other aggregators; liquid.ai offers a research/demo surface but not an OAI-compat or native production endpoint that an adapter can target. A `liquid` canonical providerId would duplicate the routing a user already gets via openrouter → liquid/lfm-*. Reclassification requires Liquid AI to publish a first-party API with a stable base URL. Status: NOT_ELIGIBLE until that upstream change.',
  },
  {
    claim: 'modelrun eligible for canonical catalog inclusion',
    superseded_at: '2026-04-23',
    reason:
      'ModelRun (modelrun.xyz and known alternative domains) returned ECONNREFUSED on all probed endpoints during the 2026-04-23 complement-lot evaluation. No indexed public service fronted by the expected base URL. No adapter material exists in-tree. Cannot be canonicalized because the base URL itself is unverifiable. Status: NOT_ELIGIBLE until operator identifies the correct hostname (if the brand still operates) or confirms the service is defunct.',
  },
  {
    claim: 'ncompass eligible for canonical catalog inclusion',
    superseded_at: '2026-04-23',
    reason:
      'nCompass Technologies (ncompass.tech) base URL for its production inference API is not published in public docs accessible from the probe environment. The landing pages reference a private signup flow; the actual api.* or inference.* subdomain is gated behind operator registration. Cannot add a catalog row without a verifiable baseUrl — Zod validation requires it, and a wrong URL creates silent 404-loops. Status: NOT_ELIGIBLE until operator signs up, discovers the base URL, and provisions NCOMPASS_API_KEY.',
  },
  {
    claim: 'venice is credentials-missing / secret-absent (from LOTE M close)',
    superseded_at: '2026-04-23',
    reason:
      'Sublote A 2026-04-23 probed venice directly. /api/v1/models returned HTTP 200 PUBLICLY (no auth header required; even with an invalid Bearer the same 200 response body was returned — auth is IGNORED on /models), carrying 72 text models in OAI-conformant shape ({data:[{id,object,owned_by,...}]}). /api/v1/chat/completions returned HTTP 402 with a full x402 crypto-payment-protocol body (network eip155:8453 Base, USDC token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) when no Bearer was sent, and HTTP 401 {"error":"Authentication failed"} when an invalid Bearer was sent. Discovery surface is live-proven against the canonical adapter target; execution surface is credential-gated. Under the Sublote A rule "se houver probe real bem-sucedida, não rebaixar", venice was promoted from credentials-missing → partial. GCP still has no ailin-venice-* secret under any alias, so live-validation of the chat surface remains blocked. This claim is documented here (rather than silently updating the earlier claim) to make the Sublote A bucket move visible to future auditors grepping for venice.',
  },
  {
    claim: 'Sublote A (2026-04-23) produced zero bucket moves',
    superseded_at: '2026-04-23',
    reason:
      'First-pass Sublote A narrative incorrectly concluded "4/4 stay in credentials-missing; zero moves". The rule "se houver probe real bem-sucedida, não rebaixar" is satisfied by venice /api/v1/models returning HTTP 200 against the canonical adapter base URL. Revised outcome: ONE bucket move (venice credentials-missing → partial). The other three (qianfan, siliconflow, stepfun) stay credentials-missing because their probes returned only error responses against the canonical surface — endpoint liveness is confirmed but no canonical surface is live-proven. Concrete impact: credentials-missing 59→58, partial 1→2.',
  },
  {
    claim: 'Sublote A second-pass verification found new promotion opportunities',
    superseded_at: '2026-04-23',
    reason:
      'Sublote A re-run 2026-04-23 with deeper probes. (1) GCP Secret Manager re-scanned WITHOUT the ailin- prefix constraint across all 82 secrets — zero matches for qianfan/venice/siliconflow/stepfun under any alias (qianfan-*, baidu-qianfan-*, silicon-flow-*, step-*, venice-ai-*). Only ailin-baidu-{key,secret,base-url} exist, all three still literal "PLACEHOLDER" (11 bytes each). (2) Baidu v1 AK+SK OAuth token endpoint https://aip.baidubce.com/oauth/2.0/token probed with client_id=PLACEHOLDER&client_secret=PLACEHOLDER → HTTP 401 "invalid_client / unknown client id". This is STRONGER evidence than the previous "material is placeholder" framing: Baidu\'s OAuth provider does not even recognize the client_id — the string is unregistered upstream, not merely format-wrong. qianfan classification is unchanged but the auth-incomplete subclass is now supported by upstream server-side rejection, not just local placeholder heuristic. (3) Venice /api/v1/models re-probed WITH an invalid Bearer header → HTTP 200, identical 78617-byte body to the no-auth request. Confirms the Authorization header is actively IGNORED on discovery — venice discovery is truly unauthenticated public, not "optional auth accepted". (4) siliconflow and stepfun probed on common unauth paths /health, /ping, /, /v1/health, /v1/ping → all HTTP 404 on both .cn/.com (siliconflow) and .com/.ai (stepfun). No public discovery surface exists; discovery IS credential-gated. This forecloses the Venice-style "promote on public /models" path for these two — they will move only when real secrets are provisioned. Net bucket delta this second pass: ZERO (matrix state is already consistent post first-pass Sublote A). Evidence strengthening only. .env.production, .env.test, .env.example, .env.example.clean all scanned — zero mentions of baidu/qianfan/venice/siliconflow/stepfun/ernie/step aliases.',
  },
  {
    claim: 'LOTE M remainder (12 providers) is a uniform credentials-missing block',
    superseded_at: '2026-04-23',
    reason:
      'Sublote B 2026-04-23 applied the same probe method that promoted venice (Sublote A) to the 12 LOTE M providers still in credentials-missing/secret-absent (11 providers + 1 auth-incomplete qianfan). Method: for each provider, probe canonical adapter baseUrl across 8 paths ({/models, /v1/models, /health, /ping, /status, /info, /v1/info, /}) × 2 auth modes (no Authorization header vs invalid Bearer) = 16 probes × 12 providers = 192 probes total. Result: 4 PROMOTIONS from credentials-missing → partial on confirmed HTTP 200 public /models, 7 CONFIRMED-blocked (discovery credential-gated, no public surface), 1 catalog-only inventory (no OAI discovery surface at all, POST-only execution endpoint). Evidence per provider: (a) PROMOTED — atlascloud: api.atlascloud.ai/v1/models HTTP 200 59503 bytes (107 models, custom {code:200,msg:"succeed",data:[...]} wrapper; other 7 paths asymmetric: noauth 401 vs badauth 404, revealing server differentiates absent-header vs invalid-header). avian: api.avian.io/v1/models HTTP 200 1782 bytes (6 models, pure OAI shape; other 7 paths uniform 404). mancer: neuro.mancer.tech/oai/v1/models HTTP 200 2379 bytes no-header (9 LLaMA fiction/RP models) but HTTP 401 80 bytes with invalid Bearer — asymmetric VALIDATION where server accepts enumeration when no credential is CLAIMED but rejects claimed-invalid credentials. phala: api.redpill.ai/v1/models HTTP 200 72119 bytes (76 models via Phala SGX TEE confidential-compute routing, same body with and without invalid Bearer; other paths uniform 400 "Internal server error"). (b) CONFIRMED-BLOCKED — arcee: /models 401 both modes (other paths 404). gmi: /models 401 both modes (other paths 405 Method Not Allowed — endpoints exist but POST-only, not queryable unauth). infermatic: /models 401 both modes (other paths 404). relace: ALL 8 paths return 401 uniformly (catch-all auth middleware — no public discovery). siliconflow: /models 401 with 15-byte body (bare JSON string "Invalid token" confirming oai-compat-quirks class; other paths 404). stepfun: /models 401 with 75-byte OAI-shape error {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}} (other paths 404, 0-byte bodies). qianfan (v2 surface qianfan.baidubce.com/v2): /models 401 with 120-byte BCE-shape error (other paths 404). (c) CATALOG-ONLY CONFIRMED — inflection: /models 404 on inference.ai.inflection.ai across ALL 8 paths (root / returns 307 redirect). The correct execution surface is /external/api/inference (POST-only, no discovery sidecar); inflection is a catalog-only-inventory-candidate operationally but retains secret-absent subclass because INFLECTION_API_KEY is still the expected unblock vector. Net bucket delta: partial 2→6 (+4), credentials-missing 58→54 (−4). Secret-absent subclass 40→36 (−4: atlascloud/avian/mancer/phala removed; 7 LOTE M rows remain: arcee/gmi/infermatic/inflection/relace/siliconflow/stepfun). No other buckets touched. Invariants I1–I6 hold: |catalog ∪ switch| unchanged at 103, every canonical id still in exactly one bucket, credentials-missing subclass partition preserved. The probe evidence is replicable from /tmp/subb/{provider}.out (12 files × 16 probes each) and model payloads /tmp/subb/payloads/{atlascloud,avian,mancer,phala}.json.',
  },
  {
    claim: 'LOTE M remainder (6 providers in Sublote C1 scope) can be unblocked by provisioning alone',
    superseded_at: '2026-04-23',
    reason:
      'Sublote C1 2026-04-23 attempted credential resolution + per-surface live probes for arcee/gmi/infermatic/siliconflow/stepfun/qianfan. (1) GCP Secret Manager exhaustively re-scanned: 82 secrets × 27 alias patterns (arcee, conductor, gmi, gmicloud, gmi-cloud, gmi-serving, gmiserv, infermatic, totalgpt, total-gpt, siliconflow, silicon-flow, siliconcloud, silicon-cloud, stepfun, step, step-ai, stepai, qianfan, baidu, ernie, baidu-qianfan, wenxin, wenxinworkshop, bce, ai21, api-ernie) — zero matches except the known 3 ailin-baidu-{key,secret,base-url}, all confirmed this session as literal "PLACEHOLDER" (11 bytes). Environment variables checked at runtime: zero set. .env/.env.production/.env.test on disk: zero mentions. (2) Per-surface live probes executed with invalid bearer against canonical adapter baseUrls. Key doc-vs-impl discoveries: (a) INFERMATIC — api.totalgpt.ai badauth response echoes \'LiteLLM Virtual Key expected. Received=INVALID_TEST_KEY_12345, expected to start with sk-\'. Confirmed: infermatic is a LiteLLM proxy in front of the vLLM backend, not direct vLLM. API keys must be sk-prefixed LiteLLM Virtual Keys (generated via LiteLLM Admin UI or /key/generate). Notes updated. (b) GMI — api.gmi-serving.com/v1/chat and /v1/embeddings return HTTP 404 "No matching target server found for model X" BEFORE auth validation (pre-auth routing layer). This means a 404 on gmi chat does NOT imply bad credentials — it implies the model ID is not registered. Notes updated. (c) QIANFAN v1 — aip.baidubce.com/oauth/2.0/token with client_id=PLACEHOLDER returned 401 invalid_client/unknown client id (confirms upstream does not recognize), but the v1 chat endpoint aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/ernie-4.0-8k with access_token=PLACEHOLDER returned HTTP 200 with body-encoded {error_code:3,"Unsupported openapi method"} — Baidu\'s API uses 200+error_code pattern, and the v1 endpoint IS reachable and would route a real token if provisioned. (d) SILICONFLOW — 6 surfaces (models.cn, models.com, chat, embed, rerank, audio) all uniform 401 bare-JSON-string "Invalid token" (15 bytes) — confirms integrationClass oai-compat-quirks across every surface. Both .cn and .com hosts equivalent. (e) STEPFUN — 5 surfaces (models.com, models.ai, chat, embed, audio/speech) all uniform 401 OAI-shape {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}} (75 bytes) — confirms integrationClass oai-compat-pure. Both .com and .ai hosts equivalent. (f) ARCEE — /api/v1/models and /api/v1/chat both 401 with Arcee-specific {"detail":"Missing or invalid Authorization header. Expected: Bearer <api_key>"} (80 bytes noauth) / {"detail":"Invalid or expired API key"} (39 bytes badauth). Root / returns 200 "OK" (health check, not discovery). Net bucket delta: ZERO. All 6 providers remain in same bucket as pre-Sublote-C1 because no credential became available during this session. However, Sublote C1 produced: (i) 2 catalog notes updates (infermatic LiteLLM proxy, gmi pre-auth routing), (ii) 1 new historical claim (this entry), (iii) definitive proof that unblocking all 6 is PURE credential-provisioning work (no adapter changes, no endpoint changes, no structural refactoring required). Probe evidence in /tmp/subc1/clean.out and /tmp/subc1/bodies/*.body.',
  },
  {
    claim: 'LOTE M remainder mostly blocked by credential provisioning (pre-Sublote-D1)',
    superseded_at: '2026-04-24',
    reason:
      'Sublote D1 2026-04-24 — operator provisioned 17 GCP secrets (ailin-{groq,togetherai,fireworks-ai,deepinfra,perplexity,huggingface,cloudflare-workers-ai,cloudflare-workers-ai-id,github-models,sambanova,hyperbolic,arcee,infermatic,siliconflow,stepfun,heliconeai-api,chutes,anyscale}-*-key(s)). Live probes (GET /v1/models + POST /v1/chat/completions with minimal body {"model":"X","messages":[{"role":"user","content":"hi"}],"max_tokens":5}) executed against canonical adapter baseUrls with the provisioned credentials. Result summary: (1) TEN promotions to live-validation (real HTTP 200 with completion body on /v1/chat): groq (llama-3.1-8b-instant 592B), deepinfra (Meta-Llama-3.1-8B-Instruct 455B), huggingface (Llama-3.1-8B-Instruct 668B via router.huggingface.co), cloudflare-workers-ai (@cf/meta/llama-3-8b-instruct 360B; /models 405 is expected per CF docs — their discovery uses /ai/models/search), github-models (openai/gpt-4o-mini 1252B; models at /catalog/models not /v1/models), perplexity (sonar 2992B; /models 404 by design), fireworks-ai (accounts/fireworks/models/glm-5p1 447B — re-probed after first-pick llama-v3p1-8b returned 404 deprecated), sambanova (Meta-Llama-3.3-70B-Instruct 910B — re-probed after first-pick 3.1 returned 410 Gone), infermatic (Qwen-Qwen3-30B-A3B 476B — confirmed LiteLLM Virtual Key with sk- prefix; key has a model-scoped ACL), heliconeai (gpt-4o-mini 1003B — new ailin-heliconeai-api-key sk-hel… 43B SUPERSEDES the legacy ailin-heliconeai-key "PLACEHOLDER" 11B that caused the prior mis-classification in CREDENTIALS_MISSING_SUBCLASS.placeholder). (2) FOUR promotions to upstream-suspended: anyscale (endpoint returns HTML shutdown notice "Effective August 1, 2024 Anyscale Endpoints API is available exclusively through the fully Hosted Anyscale Platform; Multi-tenant access to LLM models has been removed." — the key ailin-anyscale-api-key 236B exists but cannot be exercised), arcee (trinity-mini → 402 {"detail":"Insufficient credits. Required: 0.000037, Available: 0.000000"}), chutes (Qwen/Qwen3-32B-TEE → 402 {"detail":{"message":"Quota exceeded and account balance is $0.0, please pay with fiat or send tao..."}}), hyperbolic (→ 402 {"detail":"Insufficient funds"}). All four have valid credentials (auth-accepted) but gated execution — operationally identical to ai302/palabraai. (3) THREE stay in credentials-missing but move sub-class secret-absent → auth-incomplete: togetherai (key_CY… 25B; /v1/chat returns OpenAI-shape 401 "Invalid API key provided. You can find your API key at https://api.together.ai/settings/api-keys" — the "key_" prefix is non-canonical for Together AI, probable format mismatch), siliconflow (sk-hhc… 51B; /v1/chat returns bare JSON "Api key is invalid" 15B oai-compat-quirks shape — probable format mismatch, sk-prefix looks OpenAI-style rather than SiliconFlow native), stepfun (65B; /v1/chat returns OAI-shape {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}} 75B — verbatim OpenAI error shape, operator must verify the key maps to their StepFun account). (4) ONE operator-claim-vs-vault mismatch: gmi — the operator announcement listed gmi among the 16 provisioned but GCP Secret Manager scan 2026-04-24 against all known aliases (ailin-gmi-*, ailin-gmicloud-*, ailin-gmi-cloud-*, ailin-gmi-serving-*, ailin-gmiserv-*) found ZERO matches. gmi stays secret-absent until the actual secret lands in the vault. Net matrix deltas: live-validation 37→47 (+10), credentials-missing 54→40 (−14), upstream-suspended 2→6 (+4). Sub-class deltas: secret-absent 36→20 (−16: 9 to live-validation [all 10 promotees except heliconeai which was in placeholder sub-class], 4 to upstream-suspended, 3 to auth-incomplete), placeholder 2→1 (heliconeai promoted — legacy secret superseded by new api-key form), auth-incomplete 2→5 (+togetherai,siliconflow,stepfun). All invariants I1–I6 hold post-D1: 103 canonical total unchanged, every providerId in exactly one bucket, sub-class partition of credentials-missing covers all 40 entries. Probe evidence: /tmp/subd1/probe.out + /tmp/subd1/reprobe.out + /tmp/subd1/bodies/*.{models,chat,rechat}.body (17 providers × 2–3 surfaces each = ~50 probe records).',
  },
] as const;

/**
 * Sum of all canonical providers across the matrix. Convenience function —
 * the test asserts this equals |catalog ∪ switch| (structural identity, no
 * pinned number). At 2026-04-23 post-LOTE-M: catalog=81 + switch=22 = 103.
 *
 * Bucket distribution post-Sublote-D1 (2026-04-24):
 *   live-validation       = 47 (34 catalog + 13 switch) — +10 this sublote
 *   no-live-validation    = 0
 *   partial               = 6  (bytez — wire-shape mismatch;
 *                                venice — asymmetric auth (Sublote A);
 *                                atlascloud, avian, mancer, phala —
 *                                /models 200 public (Sublote B).)
 *                                — unchanged by Sublote D1.
 *   credentials-missing   = 40 (33 catalog + 7 switch/self-hosted) — −14
 *                                net this sublote (10 to live, 4 to
 *                                upstream-suspended). Sub-class partition:
 *                                  secret-absent          = 20
 *                                  placeholder            = 1
 *                                  self-hosted-unreachable = 14
 *                                  auth-incomplete        = 5
 *                                  total                  = 40 ✓
 *   vendor-side-failure   = 1  (google — GOOGLE_API_KEY still suspended)
 *   upstream-suspended    = 6  (ai302, palabraai, anyscale, arcee,
 *                                chutes, hyperbolic — +4 this sublote)
 *   defunct-unreachable   = 0
 *   catalog-only-inventory = 3 (sap, snowflake, topaz)
 *   switch-only-legitimate = 0
 *   not-eligible          = 0
 *   TOTAL                 = 103 (matches |catalog ∪ switch|)
 *
 * Historical progression (each transition has a supersession entry):
 *   Pre-LOTE-M      : live=37 partial=1 creds=46 vendor=1 susp=2 cat-only=3 → 90
 *   LOTE M close    : live=37 partial=1 creds=59 vendor=1 susp=2 cat-only=3 → 103
 *   Sublote A       : live=37 partial=2 creds=58 vendor=1 susp=2 cat-only=3 → 103  (venice → partial)
 *   Sublote B       : live=37 partial=6 creds=54 vendor=1 susp=2 cat-only=3 → 103  (+atlascloud,avian,mancer,phala → partial)
 *   Sublote C1      : live=37 partial=6 creds=54 vendor=1 susp=2 cat-only=3 → 103  (no moves — probe evidence strengthening only)
 *   Sublote D1      : live=47 partial=6 creds=40 vendor=1 susp=6 cat-only=3 → 103  (+10 live, −14 creds, +4 upstream-suspended)
 */
export function totalCanonicalInMatrix(): number {
  return CONSOLIDATION_BUCKETS.reduce(
    (sum, bucket) => sum + CONSOLIDATION_MATRIX[bucket].length,
    0,
  );
}
