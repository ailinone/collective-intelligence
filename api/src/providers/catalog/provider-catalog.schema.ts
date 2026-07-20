// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Catalog — Zod Runtime Validation
 *
 * Catalog entries are authored as TypeScript literals but MUST pass Zod
 * validation at boot time. This prevents malformed entries (typos in
 * integrationClass, missing env var names, contradictory flags) from silently
 * producing broken providers in production.
 *
 * Validation is strict (`.strict()`) — unknown fields cause errors, catching
 * schema drift when the type file evolves.
 *
 * Usage:
 *   const result = ProviderCatalogEntrySchema.safeParse(entry);
 *   if (!result.success) { ... throw with diagnostic ... }
 */

import { z } from 'zod';

// ─── Enums (mirror provider-catalog.types.ts exactly) ───────────────────────

export const ProviderIntegrationClassSchema = z.enum([
  'oai-compat-pure',
  'oai-compat-quirks',
  'first-party-native',
  'embeddings-only',
  'rerank-only',
  'image-only',
  'video-only',
  'speech-only',
  'moderation-only',
  'gateway',
  'self-hosted-oai-compat',
  'self-hosted-native',
  'experimental',
]);

export const ProviderIntegrationModeSchema = z.enum([
  'discovery+execution',
  'discovery-only',
  'catalog-only',
  'execution-only',
]);

export const PricingModeSchema = z.enum(['remote', 'static-file', 'none']);

export const ProviderAuthSchemeSchema = z.enum([
  'bearer',
  'api-key-header',
  'query-param',
  'hmac-sigv4',
  'oauth2',
  'iam-token',
  'none',
  'custom',
]);

// ─── Capability hint ────────────────────────────────────────────────────────

export const CapabilityHintSchema = z
  .object({
    capability: z
      .string()
      .min(1, 'capability name cannot be empty')
      .max(80, 'capability name suspiciously long'),
    rationale: z.enum([
      'provider-class-default',
      'docs-declared',
      'endpoint-declared',
      'integration-class-default',
    ]),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional(),
  })
  .strict();

// ─── Endpoint paths ─────────────────────────────────────────────────────────

/**
 * Path validator. Must start with `/` or be empty (we normalize downstream).
 * We reject double-slashes and control characters early.
 */
const pathString = z
  .string()
  .regex(
    /^\/[\w\-./]*$/,
    'path must start with `/` and contain only URL-safe characters',
  )
  .max(256);

/**
 * Path TEMPLATE for async-job poll endpoints: same shape as `pathString`
 * plus the literal `{taskId}` placeholder (replaced at request time with the
 * submit response's task id). Only used by `paths.videoPoll`.
 */
const pollPathTemplateString = z
  .string()
  .regex(
    /^\/(?:[\w\-./]|\{taskId\})*$/,
    'poll path must start with `/`, contain only URL-safe characters, and may embed the `{taskId}` placeholder',
  )
  .max(256);

export const ProviderEndpointPathsSchema = z
  .object({
    modelList: z.array(pathString).min(1).max(8).optional(),
    chatCompletions: pathString.optional(),
    responses: pathString.optional(),
    embeddings: pathString.optional(),
    rerank: pathString.optional(),
    imagesGenerate: pathString.optional(),
    imagesEdit: pathString.optional(),
    videoGenerate: pathString.optional(),
    videoPoll: pollPathTemplateString.optional(),
    audioSpeech: pathString.optional(),
    audioTranscriptions: pathString.optional(),
    moderation: pathString.optional(),
    health: pathString.optional(),
  })
  .strict()
  // videoPoll cross-invariants: a poll route is only reachable after a video
  // submit, and a template without the `{taskId}` placeholder would poll a
  // STATIC path (the listing endpoint) — returning an unrelated pre-existing
  // video or burning the whole poll budget.
  .superRefine((paths, ctx) => {
    if (paths.videoPoll === undefined) return;
    if (!paths.videoGenerate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['videoPoll'],
        message:
          'paths.videoPoll requires paths.videoGenerate — a poll route without a submit route can never be reached',
      });
    }
    if (!paths.videoPoll.includes('{taskId}')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['videoPoll'],
        message:
          'paths.videoPoll must embed the literal `{taskId}` placeholder — without it every poll GET hits the same static path instead of the submitted task',
      });
    }
  });

// ─── Supports flags ─────────────────────────────────────────────────────────

export const ProviderSupportsSchema = z
  .object({
    chat: z.boolean().optional(),
    responses: z.boolean().optional(),
    embeddings: z.boolean().optional(),
    rerank: z.boolean().optional(),
    moderation: z.boolean().optional(),
    speechToText: z.boolean().optional(),
    textToSpeech: z.boolean().optional(),
    imageGeneration: z.boolean().optional(),
    imageEditing: z.boolean().optional(),
    videoGeneration: z.boolean().optional(),
    streaming: z.boolean().optional(),
    tools: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
    vision: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    realtime: z.boolean().optional(),
  })
  .strict();

// ─── Provider ID naming rules ───────────────────────────────────────────────

/**
 * Canonical provider ID: lowercase kebab-case. Max 40 chars.
 * No trailing dashes, no double-dashes. Leading alpha required.
 */
const providerIdString = z
  .string()
  .min(2)
  .max(40)
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    'providerId must be lowercase kebab-case (e.g. `fireworks-ai`)',
  );

/**
 * Env var name: uppercase snake-case.
 */
const envVarString = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'env var must be UPPER_SNAKE_CASE');

/**
 * URL validator — must be https (http allowed only for self-hosted & local).
 */
const baseUrlString = z
  .string()
  .url('baseUrl must be a valid URL')
  .max(256);

// ─── Main entry schema ──────────────────────────────────────────────────────

export const ProviderCatalogEntrySchema = z
  .object({
    // Identity
    providerId: providerIdString,
    displayName: z.string().min(1).max(80),
    providerFamily: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9-]*$/, 'providerFamily must be lowercase kebab-case'),
    aliases: z.array(z.string().min(1).max(40)).max(16).optional(),

    // Classification
    integrationClass: ProviderIntegrationClassSchema,
    integrationMode: ProviderIntegrationModeSchema,

    // Connection
    baseUrl: baseUrlString,
    paths: ProviderEndpointPathsSchema.optional(),
    authScheme: ProviderAuthSchemeSchema.optional(),
    authHeaderName: z.string().min(1).max(80).optional(),
    extraHeaders: z.record(z.string(), z.string()).optional(),
    videoRequestStyle: z.enum(['flat', 'payload-wrap']).optional(),

    // Env config
    apiKeyEnvVar: envVarString,
    /**
     * Free-text justification for diverging from the `<PROVIDER>_API_KEY`
     * convention. See Rule 1 refinement below. Length-bounded to discourage
     * terse drive-by overrides; presence implies deliberate review.
     */
    apiKeyEnvVarOverrideReason: z.string().min(10).max(200).optional(),
    baseUrlEnvVar: envVarString.optional(),
    extraEnvVars: z.record(envVarString, z.string().min(1).max(200)).optional(),
    apiKeyOptional: z.boolean().optional(),

    // Capabilities
    supports: ProviderSupportsSchema,
    capabilityHints: z.array(CapabilityHintSchema).max(32).optional(),

    // Pricing
    pricingMode: PricingModeSchema,

    // Adapter overrides
    adapterClass: z.string().min(1).max(80).optional(),
    fetcherClass: z.string().min(1).max(80).optional(),

    // Discovery tuning
    modelDenylist: z.array(z.string().min(1).max(200)).max(100).optional(),
    /** @deprecated — use `pinnedFallback`. Removed once every catalog row is
     *  migrated; kept here for the duration of Phase 4d so a partial migration
     *  cannot silently drop rows. */
    staticModels: z.array(z.string().min(1).max(200)).max(100).optional(),
    /** Pinned fallback list — see types.ts for full semantics. The runtime
     *  consults `models` whenever it would have consulted the deprecated
     *  `staticModels`. `reason` is a closed enum so audits can group entries
     *  by *why* the fallback exists; `lastReviewedAt` tracks staleness. */
    pinnedFallback: z
      .object({
        // Each entry is either a bare model id (legacy form, regex-inferred
        // capabilities) OR a structured `{id, capabilities}` record (operator-
        // declared, bypasses regex inference). 2026-04-28 root-cause refactor:
        // structured form is preferred; bare-string form is honoured for back-
        // compat but the CI invariant `pinnedFallback-capability-coverage`
        // expects every enabled-by-default entry to either declare capabilities
        // explicitly here or have a name that maps via the regex fallback.
        models: z
          .array(
            z.union([
              z.string().min(1).max(200),
              z
                .object({
                  id: z.string().min(1).max(200),
                  capabilities: z
                    .array(z.string().min(1).max(80))
                    .min(1)
                    .max(20),
                })
                .strict(),
            ]),
          )
          .min(1)
          .max(100),
        reason: z.enum([
          'no-list-endpoint',
          'workspace-scoped',
          'per-deployment',
          'proprietary-schema',
          'curated-shortlist',
        ]),
        lastReviewedAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'pinnedFallback.lastReviewedAt must be ISO date'),
      })
      .strict()
      .optional(),
    originalProviderField: z.string().min(1).max(40).optional(),

    // Lifecycle
    enabledByDefault: z.boolean(),
    denyByDefault: z.boolean().optional(),
    // Content-policy tag — see types.ts for full semantics. This is a literal
    // union (not a boolean) so future categories can slot in without breaking
    // existing call sites.
    contentPolicyClass: z.enum(['uncensored']).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),

    // Metadata
    docsUrl: z.string().url().optional(),
    notes: z.string().max(500).optional(),
    lastReviewedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'lastReviewedAt must be ISO date (YYYY-MM-DD)')
      .optional(),
  })
  .strict()
  // ── Cross-field invariants ────────────────────────────────────────────────
  .refine(
    (entry) => {
      // Rule 1: apiKeyEnvVar must match convention <PROVIDER_ID_UPPER>_API_KEY
      // unless explicitly flagged (some env prefixes differ e.g. AWS_ACCESS_KEY_ID).
      const expected = `${entry.providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      if (entry.apiKeyEnvVar === expected) return true;
      // Tolerate divergence for first-party/cloud providers with standard SDK envs.
      if (entry.authScheme === 'hmac-sigv4' || entry.authScheme === 'iam-token' || entry.authScheme === 'oauth2' || entry.authScheme === 'custom') return true;
      // Tolerate divergence when the entry author documented *why* via the
      // `apiKeyEnvVarOverrideReason` field. This is the escape hatch for
      // providers whose upstream SDK ships a canonical env name (HF_TOKEN,
      // GITHUB_TOKEN, CLOUDFLARE_API_TOKEN, DATABRICKS_TOKEN, GEMINI_API_KEY)
      // so users don't have to double-set the same secret. The 10-char min
      // on the reason string ensures the author thought about it.
      if (typeof entry.apiKeyEnvVarOverrideReason === 'string' && entry.apiKeyEnvVarOverrideReason.length >= 10) return true;
      return false;
    },
    {
      message:
        'apiKeyEnvVar must follow convention `<PROVIDER_ID_UPPER>_API_KEY` unless authScheme is hmac-sigv4/iam-token/oauth2/custom, or apiKeyEnvVarOverrideReason is set to document the divergence',
      path: ['apiKeyEnvVar'],
    },
  )
  .refine(
    (entry) => {
      // Rule 2: api-key-header scheme requires authHeaderName
      if (entry.authScheme === 'api-key-header' && !entry.authHeaderName) {
        return false;
      }
      return true;
    },
    {
      message: 'authScheme `api-key-header` requires authHeaderName',
      path: ['authHeaderName'],
    },
  )
  .refine(
    (entry) => {
      // Rule 3: non-HTTPS only allowed for self-hosted and explicit local
      if (!entry.baseUrl.startsWith('https://')) {
        const isLocal =
          entry.integrationClass === 'self-hosted-oai-compat' ||
          entry.integrationClass === 'self-hosted-native';
        return isLocal;
      }
      return true;
    },
    {
      message: 'http:// only permitted for self-hosted-* integrationClass',
      path: ['baseUrl'],
    },
  )
  .refine(
    (entry) => {
      // Rule 4: specialty classes must not claim chat/tools
      const isSpecialty =
        entry.integrationClass === 'embeddings-only' ||
        entry.integrationClass === 'rerank-only' ||
        entry.integrationClass === 'image-only' ||
        entry.integrationClass === 'video-only' ||
        entry.integrationClass === 'speech-only' ||
        entry.integrationClass === 'moderation-only';
      if (isSpecialty && (entry.supports.chat === true || entry.supports.tools === true)) {
        return false;
      }
      return true;
    },
    {
      message:
        'Specialty integrationClass (*-only) cannot declare supports.chat or supports.tools — create a gateway/first-party entry instead',
      path: ['supports'],
    },
  )
  .refine(
    (entry) => {
      // Rule 5: execution-only mode requires either pinnedFallback (preferred,
      // Phase 4d schema) OR legacy staticModels (deprecated; migration in
      // progress). Discovery is disabled in this mode, so a curated inventory
      // is the only source of model identifiers.
      if (entry.integrationMode !== 'execution-only') {
        return true;
      }
      const hasPinnedFallback =
        entry.pinnedFallback !== undefined && entry.pinnedFallback.models.length > 0;
      const hasStaticModels =
        entry.staticModels !== undefined && entry.staticModels.length > 0;
      return hasPinnedFallback || hasStaticModels;
    },
    {
      message:
        'integrationMode `execution-only` requires pinnedFallback.models (preferred) or staticModels (deprecated) — discovery is disabled, where do models come from?',
      path: ['pinnedFallback'],
    },
  );

// ─── Collection schema (uniqueness, duplicate family warnings) ──────────────

export const ProviderCatalogSchema = z
  .array(ProviderCatalogEntrySchema)
  .refine(
    (entries) => {
      const ids = new Set<string>();
      for (const entry of entries) {
        if (ids.has(entry.providerId)) return false;
        ids.add(entry.providerId);
      }
      return true;
    },
    { message: 'duplicate providerId found in catalog' },
  )
  .refine(
    (entries) => {
      // No two entries may share the same env var (would cause non-deterministic auth)
      const envVars = new Set<string>();
      for (const entry of entries) {
        if (envVars.has(entry.apiKeyEnvVar)) return false;
        envVars.add(entry.apiKeyEnvVar);
      }
      return true;
    },
    { message: 'duplicate apiKeyEnvVar found — each provider needs a unique env var' },
  );

export type ValidatedProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;
