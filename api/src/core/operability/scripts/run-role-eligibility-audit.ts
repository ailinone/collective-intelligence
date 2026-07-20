// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.1B-J — Role Eligibility Audit.
 *
 * Computes per-role eligibility against the FULL system registry
 * (not a 64/256 pool sample) so the dry-run failure mode
 * `no_eligible_judge` can be diagnosed honestly. Three questions:
 *
 *   1. How many models in the full chat-capable catalog satisfy
 *      the strict judge contract? (chat AND structured-output AND
 *      ≥16k context AND ≤cost cap AND usable provider)
 *   2. Which constraint dominates rejection — context, structured
 *      output, cost, or operability?
 *   3. Are there candidates if we relax structured-output to
 *      capability-unknown? If we drop context to 8k? If we widen
 *      cost? (Surface counts for tiered fallback policy decisions.)
 *
 * NEVER calls a provider. Reads catalog from the same modelCatalogService
 * the chat path uses. Sanitized JSON output — no secrets in `topCandidates`.
 *
 * Run:
 *   pnpm tsx src/core/operability/scripts/run-role-eligibility-audit.ts \
 *     --role judge \
 *     --bootstrap-runtime \
 *     --secrets-source gcp-secret-manager \
 *     --load-catalog \
 *     --full-registry \
 *     --max-cost-usd 0.10 \
 *     --context-min 16000 \
 *     --require-structured-output true \
 *     --include-legacy-capabilities true \
 *     --include-capability-uris true \
 *     --explain-rejections true
 */
import type { Model } from '@/types';

interface Args {
  readonly role: 'judge' | 'participant' | 'synthesizer' | 'fallback_single';
  readonly bootstrapRuntime: boolean;
  readonly secretsSource: 'gcp-secret-manager' | 'env-only';
  readonly loadCatalog: boolean;
  readonly fullRegistry: boolean;
  readonly maxCostUsd: number;
  readonly contextMin: number;
  readonly requireStructuredOutput: boolean;
  readonly includeLegacyCapabilities: boolean;
  readonly includeCapabilityUris: boolean;
  readonly explainRejections: boolean;
  readonly maxTopCandidates: number;
  /** Token estimate for cost calculation. Defaults align with judge
   *  workload: small prompt + small completion + JSON parsing. */
  readonly judgePromptTokens: number;
  readonly judgeCompletionTokens: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let role: Args['role'] = 'judge';
  let bootstrapRuntime = false;
  let secretsSource: Args['secretsSource'] = 'env-only';
  let loadCatalog = false;
  let fullRegistry = false;
  let maxCostUsd = 0.10;
  let contextMin = 16000;
  let requireStructuredOutput = true;
  let includeLegacyCapabilities = true;
  let includeCapabilityUris = true;
  let explainRejections = true;
  let maxTopCandidates = 20;
  let judgePromptTokens = 1500;
  let judgeCompletionTokens = 500;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') role = (argv[++i] ?? 'judge') as Args['role'];
    else if (a === '--bootstrap-runtime') bootstrapRuntime = true;
    else if (a === '--load-catalog') loadCatalog = true;
    else if (a === '--full-registry') fullRegistry = true;
    else if (a === '--secrets-source') {
      const next = argv[++i];
      if (next === 'gcp-secret-manager') secretsSource = 'gcp-secret-manager';
    } else if (a === '--max-cost-usd') maxCostUsd = Number(argv[++i] ?? '0.10');
    else if (a === '--context-min') contextMin = Number(argv[++i] ?? '16000');
    else if (a === '--require-structured-output') requireStructuredOutput = (argv[++i] ?? 'true') === 'true';
    else if (a === '--include-legacy-capabilities') includeLegacyCapabilities = (argv[++i] ?? 'true') === 'true';
    else if (a === '--include-capability-uris') includeCapabilityUris = (argv[++i] ?? 'true') === 'true';
    else if (a === '--explain-rejections') explainRejections = (argv[++i] ?? 'true') === 'true';
    else if (a === '--max-top-candidates') maxTopCandidates = Number(argv[++i] ?? '20');
    else if (a === '--prompt-tokens') judgePromptTokens = Number(argv[++i] ?? '1500');
    else if (a === '--completion-tokens') judgeCompletionTokens = Number(argv[++i] ?? '500');
  }

  return {
    role,
    bootstrapRuntime,
    secretsSource,
    loadCatalog,
    fullRegistry,
    maxCostUsd,
    contextMin,
    requireStructuredOutput,
    includeLegacyCapabilities,
    includeCapabilityUris,
    explainRejections,
    maxTopCandidates,
    judgePromptTokens,
    judgeCompletionTokens,
  };
}

async function bootstrap(args: Args): Promise<{ secretsSource: string; loaded: boolean }> {
  if (!args.bootstrapRuntime) {
    return { secretsSource: args.secretsSource, loaded: false };
  }
  const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
  await bootstrapForScripts();
  if (args.loadCatalog) {
    try {
      const { loadProviderCatalog } = await import('@/providers/catalog/catalog-loader');
      await loadProviderCatalog();
    } catch (err) {
      process.stderr.write(
        `loadProviderCatalog failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return { secretsSource: args.secretsSource, loaded: true };
}

// ── Capability detection ───────────────────────────────────────────────
//
// Reads BOTH the modern `capability_uris` (canonical) AND legacy
// `capabilities[]` (string array) so the audit reflects what the
// resolver actually sees. capability_uris is the schema-versioned source;
// legacy is the array consumed by `modelHasCapability` in
// `model-role-resolver.ts:95`.

interface CapabilityProbe {
  readonly hasChat: boolean;
  readonly hasJsonMode: boolean;
  readonly hasFunctionCalling: boolean;
  readonly hasToolUse: boolean;
  readonly hasAnyStructuredOutput: boolean;
  readonly structuredOutputSource: 'capabilities_legacy' | 'capability_uris' | 'metadata' | 'unknown';
  readonly capabilitySource: 'capability_uris' | 'capabilities_legacy' | 'metadata' | 'unknown';
}

function probeCapabilities(model: Model, args: Args): CapabilityProbe {
  // The Model type doesn't have a typed `capability_uris` field yet — peek
  // via metadata. Operators surface capability_uris via either model.metadata
  // (catalog-loader stage) OR a future schema field.
  const meta = (model.metadata ?? {}) as Record<string, unknown>;
  const capUris = (() => {
    const fromMeta = (meta.capability_uris ?? meta.capabilityUris) as unknown;
    if (Array.isArray(fromMeta) && fromMeta.every((u) => typeof u === 'string')) {
      return fromMeta as readonly string[];
    }
    return [] as readonly string[];
  })();
  const legacyCaps: readonly string[] = Array.isArray(model.capabilities)
    ? (model.capabilities as readonly string[])
    : [];

  const includeLegacy = args.includeLegacyCapabilities;
  const includeUris = args.includeCapabilityUris;

  const legacyHas = (c: string) => includeLegacy && legacyCaps.includes(c);
  const urisHas = (cap: string) =>
    includeUris &&
    capUris.some((u) => u === cap || u.endsWith(`/${cap}`) || u.endsWith(`:${cap}`));

  const hasChat = legacyHas('chat') || urisHas('chat') || urisHas('text_generation');
  const hasJsonMode = legacyHas('json_mode') || urisHas('json_mode') || urisHas('structured_output');
  const hasFunctionCalling = legacyHas('function_calling') || urisHas('function_calling');
  const hasToolUse = legacyHas('tool_use') || urisHas('tool_use') || urisHas('tools');
  const hasAnyStructuredOutput = hasJsonMode || hasFunctionCalling || hasToolUse;

  let structuredOutputSource: CapabilityProbe['structuredOutputSource'] = 'unknown';
  if (hasJsonMode || hasFunctionCalling || hasToolUse) {
    if (legacyHas('json_mode') || legacyHas('function_calling') || legacyHas('tool_use')) {
      structuredOutputSource = 'capabilities_legacy';
    } else if (urisHas('json_mode') || urisHas('function_calling') || urisHas('tool_use') || urisHas('structured_output') || urisHas('tools')) {
      structuredOutputSource = 'capability_uris';
    }
  }
  let capabilitySource: CapabilityProbe['capabilitySource'] = 'unknown';
  if (legacyCaps.length > 0) capabilitySource = 'capabilities_legacy';
  else if (capUris.length > 0) capabilitySource = 'capability_uris';

  return {
    hasChat,
    hasJsonMode,
    hasFunctionCalling,
    hasToolUse,
    hasAnyStructuredOutput,
    structuredOutputSource,
    capabilitySource,
  };
}

// ── Cost estimation ───────────────────────────────────────────────────

interface CostProbe {
  readonly estimatedCostUsd: number;
  readonly pricingSource: 'catalog' | 'provider' | 'estimated' | 'unknown';
  readonly withPricing: boolean;
}

function probeCost(model: Model, args: Args): CostProbe {
  const input = typeof model.inputCostPer1k === 'number' ? model.inputCostPer1k : null;
  const output = typeof model.outputCostPer1k === 'number' ? model.outputCostPer1k : null;
  if (input === null && output === null) {
    return { estimatedCostUsd: 0, pricingSource: 'unknown', withPricing: false };
  }
  const promptTokens = args.judgePromptTokens;
  const completionTokens = args.judgeCompletionTokens;
  const cost =
    ((input ?? 0) * promptTokens) / 1000 +
    ((output ?? 0) * completionTokens) / 1000;
  return {
    estimatedCostUsd: Math.max(0, cost),
    pricingSource: 'catalog',
    withPricing: true,
  };
}

// ── Provider operability ──────────────────────────────────────────────

interface OperabilityProbe {
  readonly state: 'usable' | 'unknown' | 'no_credits' | 'auth_failed' | 'rate_limited';
  readonly providerKind: 'hub' | 'native' | 'local' | 'unknown';
}

async function probeOperability(model: Model): Promise<OperabilityProbe> {
  let state: OperabilityProbe['state'] = 'unknown';
  let providerKind: OperabilityProbe['providerKind'] = 'unknown';
  try {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();
    const record = hub.getProviderState(model.provider);
    if (record) {
      const op = record.operabilityState;
      if (op === 'healthy' || op === 'degraded' || op === 'recovering') {
        if (record.balanceStatus === 'no_credits') state = 'no_credits';
        else state = 'usable';
      } else if (op === 'auth_failed') state = 'auth_failed';
      else if (op === 'rate_limited') state = 'rate_limited';
      else if (op === 'no_credits') state = 'no_credits';
      else state = 'unknown';
    }
  } catch {
    /* hub unreachable — state stays unknown */
  }
  try {
    const { classifyProviderKind } = await import('@/core/selection/provider-kind');
    providerKind = classifyProviderKind(model.provider) as OperabilityProbe['providerKind'];
  } catch {
    /* keep unknown */
  }
  return { state, providerKind };
}

// ── Audit per model ───────────────────────────────────────────────────

type RejectionReason =
  | 'not_chat_capable'
  | 'context_window_too_small'
  | 'json_output_not_supported'
  | 'pricing_missing'
  | 'cost_over_budget'
  | 'provider_not_usable'
  | 'credential_missing'
  | 'excluded_model';

interface ModelAudit {
  readonly model: Model;
  readonly caps: CapabilityProbe;
  readonly cost: CostProbe;
  readonly op: OperabilityProbe;
  readonly rejections: readonly RejectionReason[];
  readonly score: number;
}

function judgeRejections(audit: Omit<ModelAudit, 'rejections' | 'score'>, args: Args): RejectionReason[] {
  const r: RejectionReason[] = [];
  if (!audit.caps.hasChat) r.push('not_chat_capable');
  if ((audit.model.contextWindow ?? 0) < args.contextMin) r.push('context_window_too_small');
  if (args.requireStructuredOutput && !audit.caps.hasAnyStructuredOutput) {
    r.push('json_output_not_supported');
  }
  if (!audit.cost.withPricing) {
    r.push('pricing_missing');
  } else if (audit.cost.estimatedCostUsd > args.maxCostUsd) {
    r.push('cost_over_budget');
  }
  if (audit.op.state === 'auth_failed' || audit.op.state === 'no_credits' || audit.op.state === 'rate_limited') {
    r.push('provider_not_usable');
  }
  return r;
}

function scoreCandidate(audit: ModelAudit): number {
  // Rank judge candidates by:
  //   - quality (1.0)
  //   - reliability (0.7)
  //   - low cost (0.6)
  //   - context window bonus (0.3 → larger > smaller)
  const perf = audit.model.performance ?? {};
  const quality = typeof perf.quality === 'number' ? perf.quality : 0.5;
  const reliability = typeof perf.reliability === 'number' ? perf.reliability : 0.5;
  const costRatio = audit.cost.withPricing
    ? Math.min(1, audit.cost.estimatedCostUsd / 0.10)
    : 0.5;
  const ctxBonus = Math.min(1, (audit.model.contextWindow ?? 0) / 64000);
  return quality * 1.0 + reliability * 0.7 + (1 - costRatio) * 0.6 + ctxBonus * 0.3;
}

// ── Main ──────────────────────────────────────────────────────────────

async function listAllChatCapable(): Promise<Model[]> {
  const { modelCatalogService } = await import('@/services/model-catalog-service');
  const all = await modelCatalogService.listModels();
  return all.filter((m) => m.status === 'active');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const bootResult = await bootstrap(args);

  // Pull the full active catalog.
  const all = await listAllChatCapable();
  const chatCapableModels: ModelAudit[] = [];
  // We need to await operability for every model — but it's a sync hub
  // lookup wrapped in an async import; do it once via Promise.all on
  // chunks for memory friendliness.
  const CHUNK = 1000;
  for (let i = 0; i < all.length; i += CHUNK) {
    const slice = all.slice(i, i + CHUNK);
    const enriched = await Promise.all(
      slice.map(async (m) => {
        const caps = probeCapabilities(m, args);
        const cost = probeCost(m, args);
        const op = await probeOperability(m);
        const partial: Omit<ModelAudit, 'rejections' | 'score'> = { model: m, caps, cost, op };
        const rejections = judgeRejections(partial, args);
        const score = scoreCandidate({ ...partial, rejections, score: 0 });
        return { ...partial, rejections, score };
      }),
    );
    chatCapableModels.push(...enriched);
  }

  const chatCapableOnly = chatCapableModels.filter((a) => a.caps.hasChat);

  // ── Bucket counts ───────────────────────────────────────────────────
  const withContextWindow = {
    gte8k: 0,
    gte16k: 0,
    gte32k: 0,
    gte64k: 0,
    gte128k: 0,
  };
  const structuredOutput = {
    jsonMode: 0,
    functionCalling: 0,
    toolUse: 0,
    anyStructuredOutput: 0,
    structuredOutputUnknown: 0,
  };
  const pricing = {
    withPricing: 0,
    missingPricing: 0,
    estimatedUnder010Usd: 0,
    estimatedOver010Usd: 0,
  };
  const operability = {
    usable: 0,
    noCredits: 0,
    authFailed: 0,
    rateLimited: 0,
    unknown: 0,
  };
  for (const a of chatCapableOnly) {
    const ctx = a.model.contextWindow ?? 0;
    if (ctx >= 8_000) withContextWindow.gte8k++;
    if (ctx >= 16_000) withContextWindow.gte16k++;
    if (ctx >= 32_000) withContextWindow.gte32k++;
    if (ctx >= 64_000) withContextWindow.gte64k++;
    if (ctx >= 128_000) withContextWindow.gte128k++;
    if (a.caps.hasJsonMode) structuredOutput.jsonMode++;
    if (a.caps.hasFunctionCalling) structuredOutput.functionCalling++;
    if (a.caps.hasToolUse) structuredOutput.toolUse++;
    if (a.caps.hasAnyStructuredOutput) structuredOutput.anyStructuredOutput++;
    else structuredOutput.structuredOutputUnknown++;
    if (a.cost.withPricing) {
      pricing.withPricing++;
      if (a.cost.estimatedCostUsd <= args.maxCostUsd) pricing.estimatedUnder010Usd++;
      else pricing.estimatedOver010Usd++;
    } else {
      pricing.missingPricing++;
    }
    operability[a.op.state === 'auth_failed' ? 'authFailed' : a.op.state === 'no_credits' ? 'noCredits' : a.op.state === 'rate_limited' ? 'rateLimited' : a.op.state === 'usable' ? 'usable' : 'unknown']++;
  }

  // ── Eligibility tiers ──────────────────────────────────────────────
  const strict = chatCapableOnly.filter((a) => a.rejections.length === 0);
  // "withoutOperability" = every other constraint passes, only
  // operability would have rejected. Tier used to estimate how many
  // judges become eligible once provider auth/credits sort out.
  const withoutOperability = chatCapableOnly.filter((a) => {
    const nonOpRejections = a.rejections.filter(
      (r) => r !== 'provider_not_usable',
    );
    return nonOpRejections.length === 0;
  });
  // structured-output-unknown variant: relax the structured output rejection
  // when capabilitySource was unknown (i.e., the model has no capabilities
  // array at all — we cannot prove it lacks json mode).
  const withUnknownStructuredOutputAllowed = chatCapableOnly.filter((a) => {
    const onlyStructuredMissing =
      a.rejections.includes('json_output_not_supported') &&
      a.caps.capabilitySource === 'unknown';
    if (!onlyStructuredMissing) return false;
    const others = a.rejections.filter((r) => r !== 'json_output_not_supported');
    return others.length === 0;
  });
  // Context fallback to 8k: only when 16k context is the ONLY rejection.
  const withContext8kFallback = chatCapableOnly.filter((a) => {
    if (!a.rejections.includes('context_window_too_small')) return false;
    if ((a.model.contextWindow ?? 0) < 8_000) return false;
    const others = a.rejections.filter((r) => r !== 'context_window_too_small');
    return others.length === 0;
  });

  // ── Rejection breakdown over ALL chat-capable ──────────────────────
  const rejectionReasonCounts: Record<RejectionReason, number> = {
    not_chat_capable: 0,
    context_window_too_small: 0,
    json_output_not_supported: 0,
    pricing_missing: 0,
    cost_over_budget: 0,
    provider_not_usable: 0,
    credential_missing: 0,
    excluded_model: 0,
  };
  for (const a of chatCapableOnly) {
    for (const r of a.rejections) rejectionReasonCounts[r]++;
  }
  rejectionReasonCounts.not_chat_capable = chatCapableModels.length - chatCapableOnly.length;

  // ── Top candidates ────────────────────────────────────────────────
  const topCandidates = strict
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, args.maxTopCandidates)
    .map((a) => ({
      modelId: a.model.id,
      providerId: a.model.provider,
      routeId: a.model.id, // route mapping not surfaced through Model type
      providerKind: a.op.providerKind,
      contextWindow: a.model.contextWindow ?? 0,
      supportsJsonMode: a.caps.hasJsonMode,
      supportsFunctionCalling: a.caps.hasFunctionCalling,
      supportsToolUse: a.caps.hasToolUse,
      estimatedCostUsd: Number(a.cost.estimatedCostUsd.toFixed(6)),
      pricingSource: a.cost.pricingSource,
      capabilitySource: a.caps.capabilitySource,
      operabilityState: a.op.state,
      score: Number(a.score.toFixed(4)),
      selectionTrace: [],
    }));

  const distinctProviders = new Set(chatCapableModels.map((a) => a.model.provider));
  const result = {
    role: args.role,
    registryScope: 'full_system_registry',
    bootstrap: bootResult,
    args: {
      maxCostUsd: args.maxCostUsd,
      contextMin: args.contextMin,
      requireStructuredOutput: args.requireStructuredOutput,
      includeLegacyCapabilities: args.includeLegacyCapabilities,
      includeCapabilityUris: args.includeCapabilityUris,
      judgePromptTokens: args.judgePromptTokens,
      judgeCompletionTokens: args.judgeCompletionTokens,
    },
    providerUniverseCount: distinctProviders.size,
    modelUniverseCount: chatCapableModels.length,
    routeUniverseCount: chatCapableModels.length,
    chatCapableCount: chatCapableOnly.length,
    withContextWindow,
    structuredOutput,
    pricing,
    operability,
    eligible: {
      strict: strict.length,
      withoutOperability: withoutOperability.length,
      withUnknownStructuredOutputAllowed: withUnknownStructuredOutputAllowed.length,
      withContext8kFallback: withContext8kFallback.length,
    },
    rejectionReasonCounts,
    topCandidates,
  };

  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
