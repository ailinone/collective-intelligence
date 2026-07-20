// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G3 §10 — Provider Canonical Model Reprobe.
 *
 * Takes a list of providers (typically the G_alias_probable + H_confirmed
 * buckets from G3) and re-issues a SINGLE chat probe per provider using
 * the canonical model resolver:
 *
 *   1. Tries discovery-first (provider's /models endpoint) for the freshest
 *      model id.
 *   2. Falls back to last-success.
 *   3. Falls back to catalog with alias rewrite (PROVIDER_MODEL_ALIASES).
 *   4. Falls back to catalog direct.
 *
 * Outputs a reclassification: G_alias_probable → G2_alias_confirmed or
 * H_model_not_supported_confirmed; H_confirmed may move back to A_chat_ready
 * if discovery surfaces a working model.
 *
 * Hard safety:
 *   - max_tokens=10, prompt="Say OK"
 *   - 1 attempt per provider, no retries
 *   - --max-total-cost-usd cap (defaults to $0.01)
 *   - Sanitized error messages only
 *
 * Run:
 *   pnpm tsx src/core/operability/scripts/run-provider-canonical-model-reprobe.ts \
 *     --providers chutes,huggingface,nvidia,v0,inworld,fireworks-ai \
 *     --use-discovery-first \
 *     --use-provider-aliases \
 *     --sample-models-per-provider 1 \
 *     --max-total-probes 12 \
 *     --max-total-cost-usd 0.01 \
 *     --max-tokens 10 \
 *     --prompt "Say OK" \
 *     --no-retries \
 *     --sanitize \
 *     --write-json tmp/provider_canonical_reprobe_01c1b_g3.json
 *
 * NOTE: This script is BILLABLE. Operator must explicitly run it; the
 * orchestration layer does not invoke it automatically. The script will
 * abort early if any safety flag is missing.
 */
import { writeFileSync } from 'node:fs';
import {
  resolveCanonicalProbeModel,
  type CanonicalProbeModel,
} from '../provider-canonical-model-resolver';
import { classifyProviderError } from '../../orchestration/failures/provider-error-classifier';
import type { ProviderReadinessBucket } from '../provider-readiness-buckets';

interface Args {
  readonly providers: readonly string[];
  readonly useDiscoveryFirst: boolean;
  readonly useProviderAliases: boolean;
  readonly maxTotalProbes: number;
  readonly maxTotalCostUsd: number;
  readonly maxTokens: number;
  readonly prompt: string;
  readonly noRetries: boolean;
  readonly sanitize: boolean;
  readonly writeJsonPath?: string;
  readonly writeCsvPath?: string;
  // 01C.1B-J1R §9.2 — pre-bootstrap flags. Parsed BEFORE any DB/GCP/provider init.
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly noProviderCalls: boolean;
  readonly useRouteCandidates: boolean;
}

const HELP_TEXT = `
01C.1B — Provider Canonical Model Reprobe

USAGE:
  pnpm tsx run-provider-canonical-model-reprobe.ts \\
    --providers <comma,separated,list> \\
    [--use-discovery-first] [--use-provider-aliases] [--use-route-candidates] \\
    [--sample-models-per-provider <n>] \\
    [--max-total-probes <n>] \\
    [--max-total-cost-usd <usd>] \\
    [--max-tokens <n>] \\
    [--prompt <text>] \\
    --no-retries --sanitize \\
    [--write-json <path>] [--write-csv <path>] \\
    [--dry-run] [--no-provider-calls] [--help]

PRE-BOOTSTRAP FLAGS (parsed before any DB/GCP/provider init):
  --help              Print this help and exit 0. No bootstrap.
  --dry-run           Print parsed config + would-probe summary. No provider call.
  --no-provider-calls Hard-block any provider chat completion. Errors if attempted.

SAFETY (required for billable):
  --no-retries        Cascade never retries the same route.
  --sanitize          Strip secrets from error/log output.

BUDGET CAP:
  --max-total-cost-usd <= 0.05 (script enforces).
`;

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const o = {
    providers: [] as string[],
    useDiscoveryFirst: false,
    useProviderAliases: false,
    maxTotalProbes: 12,
    maxTotalCostUsd: 0.01,
    maxTokens: 10,
    prompt: 'Say OK',
    noRetries: false,
    sanitize: false,
    writeJsonPath: undefined as string | undefined,
    writeCsvPath: undefined as string | undefined,
    help: false,
    dryRun: false,
    noProviderCalls: false,
    useRouteCandidates: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--providers') o.providers = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--use-discovery-first') o.useDiscoveryFirst = true;
    else if (a === '--use-provider-aliases') o.useProviderAliases = true;
    else if (a === '--use-route-candidates') o.useRouteCandidates = true;
    else if (a === '--sample-models-per-provider') i++;
    else if (a === '--max-total-probes') o.maxTotalProbes = Number(argv[++i] ?? '12');
    else if (a === '--max-total-cost-usd') o.maxTotalCostUsd = Number(argv[++i] ?? '0.01');
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i] ?? '10');
    else if (a === '--prompt') o.prompt = argv[++i] ?? 'Say OK';
    else if (a === '--no-retries') o.noRetries = true;
    else if (a === '--sanitize') o.sanitize = true;
    else if (a === '--write-json') o.writeJsonPath = argv[++i];
    else if (a === '--write-csv') o.writeCsvPath = argv[++i];
    // 01C.1B-J1R §9.2 pre-bootstrap flags
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-provider-calls') o.noProviderCalls = true;
  }
  return o;
}

interface ReprobeResult {
  readonly providerId: string;
  readonly canonicalModelChosen?: CanonicalProbeModel | null;
  readonly chatReady: boolean;
  readonly httpStatus?: number;
  readonly errorKind?: string;
  readonly sanitizedMessage?: string;
  readonly bucketBefore?: string;
  readonly bucketAfter: ProviderReadinessBucket;
  readonly costUsd: number;
  readonly skipped?: string;
}

async function reprobeOne(
  providerId: string,
  args: Args,
  budget: { accruedUsd: number; capUsd: number; probesUsed: number; probeCap: number; perProbeUsd: number },
): Promise<ReprobeResult> {
  if (budget.accruedUsd + budget.perProbeUsd > budget.capUsd) {
    return {
      providerId,
      chatReady: false,
      bucketAfter: 'T_probe_skipped_by_budget_or_policy',
      costUsd: 0,
      skipped: 'budget_cap_reached',
    };
  }
  if (budget.probesUsed >= budget.probeCap) {
    return {
      providerId,
      chatReady: false,
      bucketAfter: 'T_probe_skipped_by_budget_or_policy',
      costUsd: 0,
      skipped: 'probe_cap_reached',
    };
  }

  // Resolve the canonical model.
  const { getProviderRegistry } = await import('@/providers/provider-registry');
  const registry = getProviderRegistry();
  const adapter = registry.get(providerId);
  if (!adapter) {
    return {
      providerId,
      chatReady: false,
      bucketAfter: 'I_adapter_missing',
      costUsd: 0,
      skipped: 'no_adapter',
    };
  }

  // Step 1: discovery-first if enabled.
  let discoveredModels: Array<{ id: string }> = [];
  if (args.useDiscoveryFirst) {
    try {
      const list = (adapter as { listModels?: () => Promise<unknown[]> }).listModels?.();
      const arr = (await list) ?? [];
      discoveredModels = (arr as Array<{ id?: string; name?: string }>).map((m) => ({
        id: String(m.id ?? m.name ?? ''),
      })).filter((m) => m.id.length > 0);
    } catch { /* discovery may be unavailable; proceed */ }
  }

  // Step 2: load catalog candidates from modelCatalogService.
  let catalogModels: Array<{ id: string; capabilities?: readonly string[] }> = [];
  try {
    const { modelCatalogService } = await import('@/services/model-catalog-service');
    const all = await modelCatalogService.listModels();
    catalogModels = all
      .filter((m) => m.status === 'active' && (m.provider ?? '').toLowerCase() === providerId.toLowerCase())
      .map((m) => ({ id: m.id, capabilities: m.capabilities as readonly string[] }));
  } catch { /* catalog may be unavailable; proceed with discovery only */ }

  const canonical = resolveCanonicalProbeModel({
    providerId,
    catalogModels,
    discoveredModels,
  });

  if (!canonical) {
    return {
      providerId,
      canonicalModelChosen: null,
      chatReady: false,
      bucketAfter: 'O_no_catalog_model_bound_to_provider',
      costUsd: 0,
      skipped: 'no_candidate_model',
    };
  }

  // Step 3: issue the chat probe.
  budget.probesUsed++;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  let chatReady = false;
  let httpStatus: number | undefined;
  let errorKind: string | undefined;
  let sanitizedMessage: string | undefined;
  try {
    const resp = await adapter.chatCompletion({
      model: canonical.apiModelId,
      messages: [{ role: 'user', content: args.prompt }],
      max_tokens: args.maxTokens,
    } as never);
    clearTimeout(timeout);
    if (resp && typeof resp === 'object') {
      chatReady = true;
      httpStatus = 200;
      sanitizedMessage = 'OK';
      budget.accruedUsd += budget.perProbeUsd;
    }
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    const statusMatch = msg.match(/HTTP\s+(\d{3})/) ?? msg.match(/^\s*(4\d{2}|5\d{2})\b/);
    httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
    const cls = classifyProviderError({ status: httpStatus, body: msg });
    errorKind = cls.kind;
    sanitizedMessage = cls.sanitizedMessage;
  }

  let bucketAfter: ProviderReadinessBucket;
  if (chatReady) {
    bucketAfter = 'A_chat_ready';
  } else if (errorKind === 'insufficient_credits') {
    bucketAfter = 'C_blocked_by_credit';
  } else if (errorKind === 'invalid_auth') {
    bucketAfter = 'D_blocked_by_auth_confirmed';
  } else if (errorKind === 'rate_limited') {
    bucketAfter = 'F_rate_limited';
  } else if (errorKind === 'model_not_supported') {
    bucketAfter = 'H_model_not_supported_confirmed';
  } else {
    bucketAfter = 'V_unknown_unclassified';
  }

  return {
    providerId,
    canonicalModelChosen: canonical,
    chatReady,
    httpStatus,
    errorKind,
    sanitizedMessage,
    bucketAfter,
    costUsd: chatReady ? budget.perProbeUsd : 0,
  };
}

async function bootstrap(): Promise<void> {
  const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
  await bootstrapForScripts();
  try {
    const { loadProviderCatalog } = await import('@/providers/catalog/catalog-loader');
    await loadProviderCatalog();
  } catch {
    /* tolerate missing catalog loader */
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  // 01C.1B-J1R §9.2 — pre-bootstrap flags. Exit BEFORE any DB/GCP/provider init.
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (args.dryRun) {
    // No bootstrap, no provider call. Just echo parsed config.
    const summary = {
      mode: 'dry-run',
      bootstrapTriggered: false,
      providerCallsAttempted: 0,
      args: {
        providers: args.providers,
        maxTotalProbes: args.maxTotalProbes,
        maxTotalCostUsd: args.maxTotalCostUsd,
        maxTokens: args.maxTokens,
        useDiscoveryFirst: args.useDiscoveryFirst,
        useProviderAliases: args.useProviderAliases,
        useRouteCandidates: args.useRouteCandidates,
        noRetries: args.noRetries,
        sanitize: args.sanitize,
        noProviderCalls: args.noProviderCalls,
      },
      estimatedWorstCaseProbes: args.providers.length,
      estimatedWorstCaseCostUsd: Math.min(args.maxTotalCostUsd, args.providers.length * 0.0005),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (args.writeJsonPath) {
      writeFileSync(args.writeJsonPath, JSON.stringify(summary, null, 2));
    }
    process.exit(0);
  }

  // Standard validations (still pre-bootstrap so we fail fast).
  if (args.providers.length === 0) {
    console.error('--providers <comma,separated,list> is required');
    process.exit(2);
  }
  if (!args.noRetries) {
    console.error('--no-retries is REQUIRED — billable probe must not retry');
    process.exit(2);
  }
  if (!args.sanitize) {
    console.error('--sanitize is REQUIRED — billable probe must sanitize bodies');
    process.exit(2);
  }
  if (args.maxTotalCostUsd > 0.05) {
    console.error('--max-total-cost-usd must be ≤ 0.05 for this script');
    process.exit(2);
  }
  if (args.noProviderCalls) {
    console.error('--no-provider-calls active — refusing to bootstrap or execute provider calls');
    process.exit(0);
  }

  await bootstrap();

  const perProbeUsd = 0.0005;  // worst-case estimate at max_tokens=10
  const budget = {
    accruedUsd: 0,
    capUsd: args.maxTotalCostUsd,
    probesUsed: 0,
    probeCap: args.maxTotalProbes,
    perProbeUsd,
  };

  const results: ReprobeResult[] = [];
  for (const providerId of args.providers) {
    const r = await reprobeOne(providerId, args, budget);
    results.push(r);
    console.log(`  ${providerId.padEnd(20)}  ${r.bucketAfter.padEnd(40)}  cost=${r.costUsd.toFixed(4)}`);
  }

  const summary = {
    total: results.length,
    chatReady: results.filter((r) => r.chatReady).length,
    totalCostUsd: results.reduce((a, b) => a + b.costUsd, 0),
    distribution: results.reduce<Record<string, number>>((acc, r) => {
      acc[r.bucketAfter] = (acc[r.bucketAfter] ?? 0) + 1;
      return acc;
    }, {}),
  };

  console.log('\n── Summary ──');
  console.log(JSON.stringify(summary, null, 2));

  if (args.writeJsonPath) {
    writeFileSync(args.writeJsonPath, JSON.stringify({ summary, results }, null, 2));
    console.log(`✓ Wrote ${args.writeJsonPath}`);
  }
}

main().catch((err) => {
  console.error('canonical-reprobe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
