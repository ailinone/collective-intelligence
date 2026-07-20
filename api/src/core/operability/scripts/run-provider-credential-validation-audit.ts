// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G3 §11 — Provider Credential Validation Audit (3-stage).
 *
 * For each provider in `--providers`, runs a 3-stage check to refine
 * D_blocked_by_auth_confirmed into one of:
 *   - D_blocked_by_auth_confirmed   (real invalid key)
 *   - Q_auth_header_or_base_url_mismatch
 *   - R_secret_alias_mismatch
 *   - S_provider_requires_deployment_or_endpoint
 *   - A_chat_ready                   (turns out auth was fine)
 *   - C_blocked_by_credit            (after classifier re-check on probe response)
 *
 * Stages:
 *   1. SECRET PRESENCE — does the loader see the provider's env var?
 *      If not, we know the auth header was sent with the wrong key
 *      (or no key). Classify as R_secret_alias_mismatch.
 *
 *   2. CREDENTIAL ENDPOINT — call a non-billable, no-cost endpoint
 *      first (typically /v1/models, /v1/me, /api/usage, depending on
 *      provider). If this 401s, we know the key value is rejected;
 *      this is D_blocked_by_auth_confirmed. If it 404s with the body
 *      mentioning the resource id / deployment, classify as
 *      S_provider_requires_deployment_or_endpoint.
 *
 *   3. CANONICAL CHAT PROBE — only run if stages 1+2 pass. Use the
 *      canonical resolver to pick the model. Classify result via
 *      classifyProviderError + bucket mapping.
 *
 * Hard safety:
 *   - max_tokens=10, prompt="Say OK"
 *   - 1 attempt per provider, no retries
 *   - --max-total-cost-usd cap (defaults to $0.02)
 *   - Sanitized output, no secret values logged
 *
 * Run:
 *   pnpm tsx src/core/operability/scripts/run-provider-credential-validation-audit.ts \
 *     --providers hyperbolic,xiaomi-mimo,heliconeai,friendli,aihubmix,novita,cometapi,phala \
 *     --secrets-source gcp-secret-manager \
 *     --validate-secret-presence \
 *     --validate-credential-endpoint \
 *     --canonical-chat-probe \
 *     --max-total-probes 24 \
 *     --max-total-cost-usd 0.02 \
 *     --max-tokens 10 \
 *     --prompt "Say OK" \
 *     --no-retries \
 *     --sanitize \
 *     --write-json tmp/provider_credential_validation_01c1b_g3.json
 *
 * NOTE: This script is BILLABLE (stages 2/3 issue real network calls).
 * Operator must explicitly run it; the orchestration layer does not
 * invoke it automatically. The script will abort early if any safety
 * flag is missing.
 */
import { writeFileSync } from 'node:fs';
import { classifyProviderError } from '../../orchestration/failures/provider-error-classifier';
import { resolveCanonicalProbeModel } from '../provider-canonical-model-resolver';
import type { ProviderReadinessBucket } from '../provider-readiness-buckets';

interface Args {
  readonly providers: readonly string[];
  readonly validateSecretPresence: boolean;
  readonly validateCredentialEndpoint: boolean;
  readonly canonicalChatProbe: boolean;
  readonly maxTotalProbes: number;
  readonly maxTotalCostUsd: number;
  readonly maxTokens: number;
  readonly prompt: string;
  readonly noRetries: boolean;
  readonly sanitize: boolean;
  readonly writeJsonPath?: string;
  // 01C.1B-J1R §9.2 — pre-bootstrap flags.
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly noProviderCalls: boolean;
  readonly useRouteCandidates: boolean;
}

const HELP_TEXT = `
01C.1B — Provider Credential Validation Audit (3-stage)

USAGE:
  pnpm tsx run-provider-credential-validation-audit.ts \\
    --providers <comma,separated,list> \\
    --secrets-source gcp-secret-manager \\
    [--validate-secret-presence] [--validate-credential-endpoint] [--canonical-chat-probe] \\
    [--use-route-candidates] \\
    [--max-total-probes <n>] [--max-total-cost-usd <usd>] \\
    [--max-tokens <n>] [--prompt <text>] \\
    --no-retries --sanitize \\
    [--write-json <path>] \\
    [--dry-run] [--no-provider-calls] [--help]

PRE-BOOTSTRAP FLAGS:
  --help              Print this help and exit 0. No bootstrap.
  --dry-run           Print parsed config + would-validate summary. No provider call.
  --no-provider-calls Hard-block any provider chat probe.

BUDGET CAP: --max-total-cost-usd <= 0.05
`;

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const o = {
    providers: [] as string[],
    validateSecretPresence: false,
    validateCredentialEndpoint: false,
    canonicalChatProbe: false,
    maxTotalProbes: 24,
    maxTotalCostUsd: 0.02,
    maxTokens: 10,
    prompt: 'Say OK',
    noRetries: false,
    sanitize: false,
    writeJsonPath: undefined as string | undefined,
    help: false,
    dryRun: false,
    noProviderCalls: false,
    useRouteCandidates: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--providers') o.providers = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--secrets-source') i++;  // accept but ignore (sourced from runtime)
    else if (a === '--validate-secret-presence') o.validateSecretPresence = true;
    else if (a === '--validate-credential-endpoint') o.validateCredentialEndpoint = true;
    else if (a === '--canonical-chat-probe') o.canonicalChatProbe = true;
    else if (a === '--use-route-candidates') o.useRouteCandidates = true;
    else if (a === '--max-total-probes') o.maxTotalProbes = Number(argv[++i] ?? '24');
    else if (a === '--max-total-cost-usd') o.maxTotalCostUsd = Number(argv[++i] ?? '0.02');
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i] ?? '10');
    else if (a === '--prompt') o.prompt = argv[++i] ?? 'Say OK';
    else if (a === '--no-retries') o.noRetries = true;
    else if (a === '--sanitize') o.sanitize = true;
    else if (a === '--write-json') o.writeJsonPath = argv[++i];
    // 01C.1B-J1R §9.2 pre-bootstrap flags
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-provider-calls') o.noProviderCalls = true;
  }
  return o;
}

interface StageResult {
  readonly stage: 'secret_presence' | 'credential_endpoint' | 'canonical_chat_probe';
  readonly pass: boolean;
  readonly httpStatus?: number;
  readonly errorKind?: string;
  readonly sanitizedMessage?: string;
}

interface ProviderValidationResult {
  readonly providerId: string;
  readonly stages: readonly StageResult[];
  readonly finalBucket: ProviderReadinessBucket;
  readonly finalReason: string;
  readonly costUsd: number;
}

async function checkSecretPresence(providerId: string): Promise<StageResult> {
  try {
    const { getSecretsLoadSummary } = await import('@/config/load-secrets-into-env');
    const summary = getSecretsLoadSummary();
    const candidates = [
      providerId.toUpperCase().replace(/-/g, '_'),
      providerId.toUpperCase().replace(/-/g, ''),
    ];
    const allLoaded = [...(summary.fromGCP ?? []), ...(summary.fromEnv ?? [])].map((s) => s.toUpperCase());
    const found = candidates.some((c) => allLoaded.some((l) => l.includes(c)));
    return {
      stage: 'secret_presence',
      pass: found,
      sanitizedMessage: found ? 'secret_loaded' : 'secret_not_in_loader_summary',
    };
  } catch (err) {
    return {
      stage: 'secret_presence',
      pass: false,
      sanitizedMessage: `secret_load_summary_unavailable: ${err instanceof Error ? err.message.slice(0, 80) : ''}`,
    };
  }
}

async function checkCredentialEndpoint(providerId: string): Promise<StageResult> {
  // Most providers expose /v1/models (or equivalent) which is non-billable
  // but credential-sensitive. We delegate to the adapter's listModels()
  // method when available.
  try {
    const { getProviderRegistry } = await import('@/providers/provider-registry');
    const registry = getProviderRegistry();
    const adapter = registry.get(providerId);
    if (!adapter) {
      return {
        stage: 'credential_endpoint',
        pass: false,
        sanitizedMessage: 'no_adapter',
      };
    }
    const list = (adapter as { listModels?: () => Promise<unknown[]> }).listModels?.();
    if (!list) {
      return {
        stage: 'credential_endpoint',
        pass: false,
        sanitizedMessage: 'adapter_has_no_listModels_method',
      };
    }
    const arr = await list;
    return {
      stage: 'credential_endpoint',
      pass: true,
      sanitizedMessage: `listModels_returned_${Array.isArray(arr) ? arr.length : 'non-array'}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const statusMatch = msg.match(/HTTP\s+(\d{3})/) ?? msg.match(/^\s*(4\d{2}|5\d{2})\b/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
    const cls = classifyProviderError({ status: httpStatus, body: msg });
    return {
      stage: 'credential_endpoint',
      pass: false,
      httpStatus,
      errorKind: cls.kind,
      sanitizedMessage: cls.sanitizedMessage,
    };
  }
}

async function checkCanonicalChatProbe(
  providerId: string,
  args: Args,
  budget: { accruedUsd: number; capUsd: number; probesUsed: number; probeCap: number; perProbeUsd: number },
): Promise<StageResult> {
  if (budget.accruedUsd + budget.perProbeUsd > budget.capUsd) {
    return {
      stage: 'canonical_chat_probe',
      pass: false,
      sanitizedMessage: 'budget_cap_reached',
    };
  }
  if (budget.probesUsed >= budget.probeCap) {
    return {
      stage: 'canonical_chat_probe',
      pass: false,
      sanitizedMessage: 'probe_cap_reached',
    };
  }

  try {
    const { getProviderRegistry } = await import('@/providers/provider-registry');
    const registry = getProviderRegistry();
    const adapter = registry.get(providerId);
    if (!adapter) {
      return { stage: 'canonical_chat_probe', pass: false, sanitizedMessage: 'no_adapter' };
    }

    // Use canonical resolver via catalog (discovery already covered in stage 2).
    const { modelCatalogService } = await import('@/services/model-catalog-service');
    const all = await modelCatalogService.listModels();
    const catalogModels = all
      .filter((m) => m.status === 'active' && (m.provider ?? '').toLowerCase() === providerId.toLowerCase())
      .map((m) => ({ id: m.id, capabilities: m.capabilities as readonly string[] }));
    const canonical = resolveCanonicalProbeModel({ providerId, catalogModels });
    if (!canonical) {
      return { stage: 'canonical_chat_probe', pass: false, sanitizedMessage: 'no_canonical_model' };
    }

    budget.probesUsed++;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await adapter.chatCompletion({
        model: canonical.apiModelId,
        messages: [{ role: 'user', content: args.prompt }],
        max_tokens: args.maxTokens,
      } as never);
      clearTimeout(timeout);
      if (resp && typeof resp === 'object') {
        budget.accruedUsd += budget.perProbeUsd;
        return { stage: 'canonical_chat_probe', pass: true, sanitizedMessage: `OK_model=${canonical.apiModelId}` };
      }
      return { stage: 'canonical_chat_probe', pass: false, sanitizedMessage: 'empty_response' };
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      const statusMatch = msg.match(/HTTP\s+(\d{3})/) ?? msg.match(/^\s*(4\d{2}|5\d{2})\b/);
      const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
      const cls = classifyProviderError({ status: httpStatus, body: msg });
      return {
        stage: 'canonical_chat_probe',
        pass: false,
        httpStatus,
        errorKind: cls.kind,
        sanitizedMessage: cls.sanitizedMessage,
      };
    }
  } catch (err) {
    return {
      stage: 'canonical_chat_probe',
      pass: false,
      sanitizedMessage: `unexpected_failure: ${err instanceof Error ? err.message.slice(0, 80) : ''}`,
    };
  }
}

function finalBucketFromStages(stages: readonly StageResult[]): { bucket: ProviderReadinessBucket; reason: string } {
  const sec = stages.find((s) => s.stage === 'secret_presence');
  const cred = stages.find((s) => s.stage === 'credential_endpoint');
  const chat = stages.find((s) => s.stage === 'canonical_chat_probe');

  if (sec && !sec.pass) {
    return { bucket: 'R_secret_alias_mismatch', reason: 'secret not loaded by loader (alias mismatch)' };
  }
  if (cred) {
    if (!cred.pass) {
      if (cred.errorKind === 'invalid_auth') {
        return { bucket: 'D_blocked_by_auth_confirmed', reason: 'credential endpoint returned auth failure' };
      }
      // 404 with "deployment / region" → S
      if (cred.httpStatus === 404 || /deployment|region|endpoint/i.test(cred.sanitizedMessage ?? '')) {
        return { bucket: 'S_provider_requires_deployment_or_endpoint', reason: 'credential endpoint requires deployment/region/endpoint id' };
      }
      if (cred.errorKind === 'insufficient_credits') {
        return { bucket: 'C_blocked_by_credit', reason: 'credential endpoint surfaced credit exhaustion' };
      }
      return { bucket: 'Q_auth_header_or_base_url_mismatch', reason: 'credential endpoint failed without explicit auth reason (header / base URL suspect)' };
    }
  }
  if (chat) {
    if (chat.pass) {
      return { bucket: 'A_chat_ready', reason: 'canonical chat probe succeeded' };
    }
    if (chat.errorKind === 'invalid_auth') {
      return { bucket: 'D_blocked_by_auth_confirmed', reason: 'chat probe failed auth' };
    }
    if (chat.errorKind === 'insufficient_credits') {
      return { bucket: 'C_blocked_by_credit', reason: 'chat probe surfaced credit exhaustion' };
    }
    if (chat.errorKind === 'model_not_supported') {
      return { bucket: 'H_model_not_supported_confirmed', reason: 'canonical model not supported' };
    }
    if (chat.errorKind === 'rate_limited') {
      return { bucket: 'F_rate_limited', reason: 'chat probe rate limited' };
    }
  }
  return { bucket: 'V_unknown_unclassified', reason: 'no stage yielded conclusive evidence' };
}

async function bootstrap(): Promise<void> {
  const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
  await bootstrapForScripts();
  try {
    const { loadProviderCatalog } = await import('@/providers/catalog/catalog-loader');
    await loadProviderCatalog();
  } catch {
    /* tolerate */
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  // 01C.1B-J1R §9.2 — pre-bootstrap flags.
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (args.dryRun) {
    const summary = {
      mode: 'dry-run',
      bootstrapTriggered: false,
      providerCallsAttempted: 0,
      stagesPlanned: [
        args.validateSecretPresence ? 'secret_presence' : null,
        args.validateCredentialEndpoint ? 'credential_endpoint' : null,
        args.canonicalChatProbe ? 'canonical_chat_probe' : null,
      ].filter(Boolean),
      args: {
        providers: args.providers,
        maxTotalProbes: args.maxTotalProbes,
        maxTotalCostUsd: args.maxTotalCostUsd,
        useRouteCandidates: args.useRouteCandidates,
      },
      estimatedWorstCaseCostUsd: Math.min(args.maxTotalCostUsd, args.providers.length * 0.0005),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (args.writeJsonPath) writeFileSync(args.writeJsonPath, JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  if (args.providers.length === 0) {
    console.error('--providers is required');
    process.exit(2);
  }
  if (!args.noRetries) {
    console.error('--no-retries is REQUIRED');
    process.exit(2);
  }
  if (!args.sanitize) {
    console.error('--sanitize is REQUIRED');
    process.exit(2);
  }
  if (args.maxTotalCostUsd > 0.05) {
    console.error('--max-total-cost-usd must be ≤ 0.05');
    process.exit(2);
  }
  if (args.noProviderCalls) {
    console.error('--no-provider-calls active — refusing to bootstrap');
    process.exit(0);
  }

  await bootstrap();

  const perProbeUsd = 0.0005;
  const budget = {
    accruedUsd: 0,
    capUsd: args.maxTotalCostUsd,
    probesUsed: 0,
    probeCap: args.maxTotalProbes,
    perProbeUsd,
  };

  const results: ProviderValidationResult[] = [];
  for (const providerId of args.providers) {
    const stages: StageResult[] = [];
    if (args.validateSecretPresence) stages.push(await checkSecretPresence(providerId));
    if (args.validateCredentialEndpoint) stages.push(await checkCredentialEndpoint(providerId));
    if (args.canonicalChatProbe) stages.push(await checkCanonicalChatProbe(providerId, args, budget));
    const { bucket, reason } = finalBucketFromStages(stages);
    const costUsd = stages.some((s) => s.stage === 'canonical_chat_probe' && s.pass) ? budget.perProbeUsd : 0;
    results.push({ providerId, stages, finalBucket: bucket, finalReason: reason, costUsd });
    console.log(`  ${providerId.padEnd(20)}  ${bucket.padEnd(40)}  ${reason}`);
  }

  const summary = {
    total: results.length,
    chatReady: results.filter((r) => r.finalBucket === 'A_chat_ready').length,
    totalCostUsd: results.reduce((a, b) => a + b.costUsd, 0),
    distribution: results.reduce<Record<string, number>>((acc, r) => {
      acc[r.finalBucket] = (acc[r.finalBucket] ?? 0) + 1;
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
  console.error('credential-validation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
