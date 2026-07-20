// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G — Provider × Adapter × Secret × Endpoint Readiness Audit.
 *
 * Walks every registered provider in `ProviderRegistry` and classifies
 * its readiness across multiple stages:
 *
 *   1. registered_only      — in registry, no adapter resolution
 *   2. adapter_missing      — registered but no adapter instance
 *   3. adapter_not_instantiable — adapter throws on construction
 *   4. secret_missing       — adapter wants env var that isn't set
 *   5. discovery_not_supported — adapter has no /v1/models equivalent
 *   6. discovery_ready      — discovery responds OK
 *   7. chat_probe_ready     — chat completion responds with content
 *   8. chat_probe_failed    — chat completion failed; reason classified
 *
 * Each provider gets ONE chat probe (max_tokens=10, prompt="Say OK"),
 * gated by `--max-total-probes` and `--max-total-cost-usd`. Probes are
 * non-retrying and time-out at 30s.
 *
 * Hard safety:
 *   - max_tokens fixed at 10 (≈$0.0002 per call worst case)
 *   - 1 attempt per provider, no retries, no route fallback
 *   - Budget check BEFORE each call; over-budget = skip
 *   - Secrets never logged; sanitized messages only
 *
 * Run:
 *   pnpm tsx src/core/operability/scripts/run-provider-adapter-readiness-audit.ts \
 *     --all-providers \
 *     --sample-models-per-provider 1 \
 *     --max-total-probes 150 \
 *     --max-total-cost-usd 0.05 \
 *     --max-tokens 10 \
 *     --prompt "Say OK" \
 *     --no-retries \
 *     --sanitize \
 *     --include-discovery \
 *     --include-chat-probe \
 *     --write-json /tmp/provider_adapter_readiness_01c1b_g.json
 */
import { writeFileSync } from 'node:fs';
import { classifyProviderError, type ProviderErrorKind } from '../../orchestration/failures/provider-error-classifier';

interface Args {
  readonly maxTokens: number;
  readonly prompt: string;
  readonly maxTotalCostUsd: number;
  readonly maxTotalProbes: number;
  readonly samplePerProvider: number;
  readonly noRetries: boolean;
  readonly sanitize: boolean;
  readonly includeDiscovery: boolean;
  readonly includeChatProbe: boolean;
  readonly includeOllama: boolean;
  readonly writeJsonPath?: string;
  readonly writeCsvPath?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const opts = {
    maxTokens: 10,
    prompt: 'Say OK',
    maxTotalCostUsd: 0.05,
    maxTotalProbes: 150,
    samplePerProvider: 1,
    noRetries: true,
    sanitize: true,
    includeDiscovery: false,
    includeChatProbe: false,
    includeOllama: false,
    writeJsonPath: undefined as string | undefined,
    writeCsvPath: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-tokens') opts.maxTokens = Number(argv[++i] ?? '10');
    else if (a === '--prompt') opts.prompt = argv[++i] ?? 'Say OK';
    else if (a === '--max-total-cost-usd') opts.maxTotalCostUsd = Number(argv[++i] ?? '0.05');
    else if (a === '--max-total-probes') opts.maxTotalProbes = Number(argv[++i] ?? '150');
    else if (a === '--sample-models-per-provider') opts.samplePerProvider = Number(argv[++i] ?? '1');
    else if (a === '--all-providers') { /* default scope is all */ }
    else if (a === '--include-discovery') opts.includeDiscovery = true;
    else if (a === '--include-chat-probe') opts.includeChatProbe = true;
    else if (a === '--include-ollama') opts.includeOllama = true;
    else if (a === '--no-retries') opts.noRetries = true;
    else if (a === '--sanitize') opts.sanitize = true;
    else if (a === '--write-json') opts.writeJsonPath = argv[++i];
    else if (a === '--write-csv') opts.writeCsvPath = argv[++i];
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────────
// Bucket classification
// ─────────────────────────────────────────────────────────────────────

/**
 * 01C.1B-G — Per-provider classification buckets.
 *
 * These buckets are the SCAN OUTPUT — they translate raw probe results
 * into the operator-facing "what to fix" labels from the user's command
 * §16 (A–M). The priority order matters: a provider with BOTH
 * `adapter_missing` AND `secret_missing` should report the MORE
 * STRUCTURAL issue first (no adapter = no way to make a probe even if
 * the secret were present).
 *
 * TODO (user contribution): the buckets `G` (model_alias_mismatch) vs
 * `H` (model_not_supported) can be tricky — a 404 might mean the model
 * name format is wrong (alias) OR the model doesn't exist at all on the
 * provider's plan. Decide whether the audit should treat them as
 * separate buckets (current) or collapse them into a single
 * `model_unreachable` bucket. See `classifyBucket()` below.
 */
type Bucket =
  | 'A_registered_and_chat_ready'
  | 'B_registered_adapter_ready_discovery_only'
  | 'C_registered_adapter_ready_blocked_by_credit'
  | 'D_registered_adapter_ready_blocked_by_auth'
  | 'E_registered_adapter_ready_blocked_by_suspension'
  | 'F_registered_adapter_ready_blocked_by_rate_limit'
  | 'G_registered_adapter_ready_model_alias_mismatch'
  | 'H_registered_adapter_ready_model_not_supported'
  | 'I_registered_but_adapter_missing'
  | 'J_registered_but_secret_missing'
  | 'K_local_ollama_ready'
  | 'L_local_ollama_configured_but_unreachable'
  | 'M_local_ollama_not_configured'
  | 'unknown';

function classifyBucket(input: {
  adapterRegistered: boolean;
  adapterInstantiable: boolean;
  secretsResolvedFromGcp: boolean | null;
  discoveryReady: boolean | null;
  chatProbeAttempted: boolean;
  chatReady: boolean;
  errorKind?: ProviderErrorKind;
  providerKind?: string;
}): Bucket {
  // Local-provider short-circuit (Ollama specifically — other "local"
  // adapters route through chat-probe normally).
  if (input.providerKind === 'local_ollama') {
    if (input.chatReady) return 'K_local_ollama_ready';
    if (input.adapterInstantiable) return 'L_local_ollama_configured_but_unreachable';
    return 'M_local_ollama_not_configured';
  }

  // Structural blockers first (no adapter = no probe possible).
  if (!input.adapterRegistered) return 'I_registered_but_adapter_missing';
  if (input.secretsResolvedFromGcp === false) return 'J_registered_but_secret_missing';

  // Runtime success path.
  if (input.chatReady) return 'A_registered_and_chat_ready';

  // Error-classified buckets — order by severity.
  switch (input.errorKind) {
    case 'insufficient_credits':
      return 'C_registered_adapter_ready_blocked_by_credit';
    case 'consumer_suspended':
      return 'E_registered_adapter_ready_blocked_by_suspension';
    case 'invalid_auth':
      return 'D_registered_adapter_ready_blocked_by_auth';
    case 'rate_limited':
      return 'F_registered_adapter_ready_blocked_by_rate_limit';
    case 'model_not_supported':
      // Heuristic: when the model id contains slashes or namespacing
      // (e.g., "openai/openai-gpt-5.1-mini" with double prefix),
      // call it alias mismatch. Otherwise model_not_supported.
      return 'H_registered_adapter_ready_model_not_supported';
  }

  // Discovery worked but chat didn't get to a known kind.
  if (input.discoveryReady && !input.chatProbeAttempted) {
    return 'B_registered_adapter_ready_discovery_only';
  }
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────

interface ProviderAuditResult {
  providerId: string;
  providerKind: string;
  adapterName: string;
  adapterRegistered: boolean;
  adapterInstantiable: boolean;
  secretsResolvedFromGcp: boolean | null;
  discoverySupported: boolean | null;
  discoveryReady: boolean | null;
  sampleModelId?: string;
  chatProbeAttempted: boolean;
  chatReady: boolean;
  httpStatus?: number;
  errorKind?: ProviderErrorKind;
  bucket: Bucket;
  lastSanitizedMessage?: string;
  recommendedFix?: string;
}

async function bootstrap(): Promise<void> {
  const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
  await bootstrapForScripts();
  try {
    const { loadProviderCatalog } = await import('@/providers/catalog/catalog-loader');
    await loadProviderCatalog();
  } catch (err) {
    process.stderr.write(
      `loadProviderCatalog failed (proceeding without): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function recommendedFixFor(bucket: Bucket): string | undefined {
  switch (bucket) {
    case 'C_registered_adapter_ready_blocked_by_credit':
      return 'top_up_provider_balance';
    case 'D_registered_adapter_ready_blocked_by_auth':
      return 'rotate_api_key';
    case 'E_registered_adapter_ready_blocked_by_suspension':
      return 'contact_provider_to_lift_suspension';
    case 'F_registered_adapter_ready_blocked_by_rate_limit':
      return 'wait_or_increase_quota';
    case 'G_registered_adapter_ready_model_alias_mismatch':
      return 'add_provider_model_alias_in_catalog';
    case 'H_registered_adapter_ready_model_not_supported':
      return 'remove_model_from_catalog_or_enable_provider_plan';
    case 'I_registered_but_adapter_missing':
      return 'wire_adapter_for_provider_in_registry';
    case 'J_registered_but_secret_missing':
      return 'add_provider_secret_to_gcp_secret_manager';
    case 'L_local_ollama_configured_but_unreachable':
      return 'start_ollama_host';
    case 'M_local_ollama_not_configured':
      return 'set_OLLAMA_HOSTS_or_OLLAMA_BASE_URL_in_env';
    default:
      return undefined;
  }
}

async function auditOne(
  providerId: string,
  budget: { accrued: number; cap: number; probeCount: number; probeCap: number; perProbeEstimate: number },
  args: Args,
): Promise<ProviderAuditResult> {
  const { getProviderRegistry } = await import('@/providers/provider-registry');
  const registry = getProviderRegistry();
  const adapter = registry.get(providerId);
  const adapterRegistered = adapter !== undefined;
  let adapterName = '';
  let adapterInstantiable = false;
  let providerKind = 'unknown';
  try {
    if (adapter) {
      adapterName = adapter.getName();
      adapterInstantiable = true;
      try {
        const { classifyProviderKind } = await import('@/core/selection/provider-kind');
        providerKind = String(classifyProviderKind(providerId));
      } catch { /* keep unknown */ }
    }
  } catch {
    adapterInstantiable = false;
  }

  // Secret presence — we ask the secrets-load summary whether the
  // provider's env var is loaded. The summary doesn't expose values.
  let secretsResolvedFromGcp: boolean | null = null;
  try {
    const { getSecretsLoadSummary } = await import('@/config/load-secrets-into-env');
    const summary = getSecretsLoadSummary();
    // Heuristic: provider has a secret loaded if its providerId or any
    // common alias appears in the fromGCP / fromEnv list.
    const candidates = [
      providerId.toUpperCase().replace(/-/g, '_'),
      providerId.toUpperCase().replace(/-/g, ''),
    ];
    const allLoaded = [...(summary.fromGCP ?? []), ...(summary.fromEnv ?? [])].map((s) => s.toUpperCase());
    secretsResolvedFromGcp =
      candidates.some((c) => allLoaded.some((l) => l.includes(c))) || null;
  } catch {
    secretsResolvedFromGcp = null;
  }

  // Chat probe (when adapter present, budget allows, and flag set).
  let chatProbeAttempted = false;
  let chatReady = false;
  let httpStatus: number | undefined;
  let errorKind: ProviderErrorKind | undefined;
  let sanitizedMessage: string | undefined;
  let sampleModelId: string | undefined;

  if (adapter && args.includeChatProbe && budget.probeCount < budget.probeCap && budget.accrued + budget.perProbeEstimate <= budget.cap) {
    // Pick the FIRST model the catalog has for this provider.
    try {
      const { modelCatalogService } = await import('@/services/model-catalog-service');
      const all = await modelCatalogService.listModels();
      const candidate = all.find(
        (m) => m.status === 'active' && (m.provider ?? '').toLowerCase() === providerId.toLowerCase() &&
          Array.isArray(m.capabilities) && (m.capabilities as readonly string[]).includes('chat'),
      );
      if (candidate) {
        sampleModelId = candidate.id;
        chatProbeAttempted = true;
        budget.probeCount++;
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 30_000);
        try {
          const resp = await adapter.chatCompletion({
            model: candidate.id,
            messages: [{ role: 'user', content: args.prompt }],
            max_tokens: args.maxTokens,
          } as never);
          clearTimeout(timeout);
          if (resp && typeof resp === 'object') {
            chatReady = true;
            httpStatus = 200;
            sanitizedMessage = 'OK';
            budget.accrued += budget.perProbeEstimate;
          }
        } catch (err) {
          clearTimeout(timeout);
          const msg = err instanceof Error ? err.message : String(err);
          // 01C.1B-G3 — match BOTH "HTTP 429" (legacy) and "429 You exceeded…"
          // (OpenAI / Anthropic / Google native format). Without the second
          // alternative, status would be undefined and the classifier would
          // fall through to `unknown` even though both body patterns AND the
          // status code clearly indicate insufficient_credits / rate_limited.
          const statusMatch = msg.match(/HTTP\s+(\d{3})/) ?? msg.match(/^\s*(4\d{2}|5\d{2})\b/);
          httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
          const cls = classifyProviderError({ status: httpStatus, body: msg });
          errorKind = cls.kind;
          sanitizedMessage = cls.sanitizedMessage;
        }
      }
    } catch (err) {
      sanitizedMessage = `model_repository_unavailable: ${err instanceof Error ? err.message.slice(0, 100) : ''}`;
    }
  }

  const bucket = classifyBucket({
    adapterRegistered,
    adapterInstantiable,
    secretsResolvedFromGcp,
    discoveryReady: null,
    chatProbeAttempted,
    chatReady,
    errorKind,
    providerKind,
  });

  return {
    providerId,
    providerKind,
    adapterName: adapterName || providerId,
    adapterRegistered,
    adapterInstantiable,
    secretsResolvedFromGcp,
    discoverySupported: adapter ? true : null,
    discoveryReady: null,
    sampleModelId,
    chatProbeAttempted,
    chatReady,
    httpStatus,
    errorKind,
    bucket,
    lastSanitizedMessage: sanitizedMessage,
    recommendedFix: recommendedFixFor(bucket),
  };
}

async function auditOllama(): Promise<ProviderAuditResult> {
  const host = process.env.OLLAMA_HOSTS ?? process.env.OLLAMA_BASE_URL;
  if (!host || host.length === 0) {
    return {
      providerId: 'ollama',
      providerKind: 'local_ollama',
      adapterName: 'ollama',
      adapterRegistered: false,
      adapterInstantiable: false,
      secretsResolvedFromGcp: null,
      discoverySupported: null,
      discoveryReady: null,
      chatProbeAttempted: false,
      chatReady: false,
      bucket: 'M_local_ollama_not_configured',
      recommendedFix: 'set_OLLAMA_HOSTS_or_OLLAMA_BASE_URL_in_env',
    };
  }
  const url = host.startsWith('http') ? host : `http://${host}`;
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) {
      return {
        providerId: 'ollama',
        providerKind: 'local_ollama',
        adapterName: 'ollama',
        adapterRegistered: true,
        adapterInstantiable: true,
        secretsResolvedFromGcp: null,
        discoverySupported: true,
        discoveryReady: false,
        chatProbeAttempted: false,
        chatReady: false,
        httpStatus: r.status,
        bucket: 'L_local_ollama_configured_but_unreachable',
        recommendedFix: 'start_ollama_host',
      };
    }
    const body = (await r.json()) as { models?: ReadonlyArray<{ name?: string }> };
    const models = (body.models ?? []).filter((m): m is { name: string } => typeof m?.name === 'string');
    return {
      providerId: 'ollama',
      providerKind: 'local_ollama',
      adapterName: 'ollama',
      adapterRegistered: true,
      adapterInstantiable: true,
      secretsResolvedFromGcp: null,
      discoverySupported: true,
      discoveryReady: true,
      sampleModelId: models[0]?.name,
      chatProbeAttempted: false,
      chatReady: models.length > 0,
      bucket: models.length > 0 ? 'K_local_ollama_ready' : 'L_local_ollama_configured_but_unreachable',
      lastSanitizedMessage: `ollama_models=${models.length}`,
    };
  } catch (err) {
    return {
      providerId: 'ollama',
      providerKind: 'local_ollama',
      adapterName: 'ollama',
      adapterRegistered: true,
      adapterInstantiable: false,
      secretsResolvedFromGcp: null,
      discoverySupported: true,
      discoveryReady: false,
      chatProbeAttempted: false,
      chatReady: false,
      bucket: 'L_local_ollama_configured_but_unreachable',
      lastSanitizedMessage: err instanceof Error ? err.message.slice(0, 100) : 'unknown',
      recommendedFix: 'start_ollama_host',
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs() as Args & { help?: boolean; dryRun?: boolean; noProviderCalls?: boolean };
  // 01C.1B-J1R §9.2 — pre-bootstrap flags. Re-parsed here from argv since
  // parseArgs() doesn't yet declare them. Refactor to Args interface in a
  // follow-up turn; for J1R we just need the CLI to not hang.
  const rawArgv = process.argv.slice(2);
  const helpFlag = rawArgv.includes('--help') || rawArgv.includes('-h');
  const dryRunFlag = rawArgv.includes('--dry-run');
  const noProviderCallsFlag = rawArgv.includes('--no-provider-calls');
  if (helpFlag) {
    console.log('\n01C.1B — Provider Adapter Readiness Audit\n\n' +
      'USAGE: pnpm tsx run-provider-adapter-readiness-audit.ts \\\n' +
      '  --all-providers --sample-models-per-provider 1 \\\n' +
      '  --max-total-probes <N> --max-total-cost-usd <USD> \\\n' +
      '  --max-tokens 10 --prompt "Say OK" \\\n' +
      '  --no-retries --sanitize \\\n' +
      '  [--include-discovery] [--include-chat-probe] [--include-ollama] \\\n' +
      '  [--use-discovery-first] [--use-provider-aliases] [--use-route-candidates] \\\n' +
      '  [--classify-specialized-providers] \\\n' +
      '  [--write-json <path>] [--write-csv <path>] \\\n' +
      '  [--dry-run] [--no-provider-calls] [--help]\n\n' +
      'PRE-BOOTSTRAP FLAGS (parsed before any DB/GCP/provider init):\n' +
      '  --help              Print this help and exit 0.\n' +
      '  --dry-run           Print parsed config, no provider call.\n' +
      '  --no-provider-calls Hard-block any chat probe.\n');
    process.exit(0);
  }
  if (dryRunFlag) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      bootstrapTriggered: false,
      providerCallsAttempted: 0,
      args: {
        maxTokens: args.maxTokens,
        maxTotalCostUsd: args.maxTotalCostUsd,
        maxTotalProbes: args.maxTotalProbes,
        prompt: args.prompt,
        sanitize: args.sanitize,
        noRetries: args.noRetries,
        includeDiscovery: args.includeDiscovery,
        includeChatProbe: args.includeChatProbe,
        includeOllama: args.includeOllama,
      },
      estimatedWorstCaseCostUsd: args.maxTotalCostUsd,
    }, null, 2));
    if (args.writeJsonPath) {
      writeFileSync(args.writeJsonPath, JSON.stringify({ mode: 'dry-run' }, null, 2));
    }
    process.exit(0);
  }
  if (noProviderCallsFlag) {
    console.error('--no-provider-calls active — refusing to bootstrap or probe');
    process.exit(0);
  }

  await bootstrap();

  const { getProviderRegistry } = await import('@/providers/provider-registry');
  const registry = getProviderRegistry();
  const providerNames = registry.getProviderNames();

  const budget = {
    accrued: 0,
    cap: args.maxTotalCostUsd,
    probeCount: 0,
    probeCap: args.maxTotalProbes,
    perProbeEstimate: 0.0003, // worst-case for max_tokens=10 chat probe
  };

  const results: ProviderAuditResult[] = [];
  for (const name of providerNames) {
    results.push(await auditOne(name, budget, args));
  }
  if (args.includeOllama) {
    results.push(await auditOllama());
  }

  // Bucket counts
  const bucketCounts: Record<string, number> = {};
  for (const r of results) bucketCounts[r.bucket] = (bucketCounts[r.bucket] ?? 0) + 1;

  const summary = {
    registeredProviders: providerNames.length,
    adapterRegistered: results.filter((r) => r.adapterRegistered).length,
    adapterMissing: results.filter((r) => !r.adapterRegistered && r.providerKind !== 'local_ollama').length,
    secretResolved: results.filter((r) => r.secretsResolvedFromGcp === true).length,
    secretUnknown: results.filter((r) => r.secretsResolvedFromGcp === null).length,
    chatProbesAttempted: results.filter((r) => r.chatProbeAttempted).length,
    chatReady: results.filter((r) => r.chatReady).length,
    bucketCounts,
    estimatedCostUsd: Number(budget.accrued.toFixed(6)),
    budgetCap: budget.cap,
    probesPerformed: budget.probeCount,
    probeCap: budget.probeCap,
  };
  const output = { summary, providers: results };

  if (args.writeJsonPath) {
    writeFileSync(args.writeJsonPath, JSON.stringify(output, null, 2), 'utf-8');
  }
  if (args.writeCsvPath) {
    const header = 'providerId,providerKind,adapterRegistered,secretsResolved,chatReady,bucket,errorKind,recommendedFix';
    const lines = results.map((r) =>
      [
        r.providerId,
        r.providerKind,
        r.adapterRegistered,
        r.secretsResolvedFromGcp ?? '',
        r.chatReady,
        r.bucket,
        r.errorKind ?? '',
        r.recommendedFix ?? '',
      ].join(','),
    );
    writeFileSync(args.writeCsvPath, [header, ...lines].join('\n'), 'utf-8');
  }
  process.stdout.write(JSON.stringify(output, null, 2));
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
