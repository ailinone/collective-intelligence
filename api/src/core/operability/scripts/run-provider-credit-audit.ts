// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.1 — Provider Credit Audit CLI.
 *
 * Operator-facing entrypoint for the ProviderCreditAuditService.
 * Modes:
 *   --mode metadata_only       (default; read-only hub + catalog)
 *   --mode non_billable_probe  (additionally calls registered safe probes)
 *   --mode minimal_billable_probe (BLOCKED — refuses to run)
 *
 * Optional:
 *   --max-providers N
 *   --include-aggregators[=true|false]   default true
 *   --include-routers[=true|false]       default true
 *   --include-local[=true|false]         default true
 *
 * Output: a single JSON document on stdout (no decorative logs), so
 * piping into `jq` works. The exit code is 0 when at least the
 * gating fields are computed; 2 when the mode is disallowed.
 *
 * Safety:
 *   - This script NEVER calls chat/completions / responses / generate.
 *   - The probe registry refuses to register probes whose
 *     `billableRisk !== 'none'`, so even
 *     `non_billable_probe` cannot make a billable call.
 *   - The script does not write to the DB.
 */
import { ProviderCreditAuditService } from '@/core/operability/provider-credit-audit-service';
import {
  ProviderProbeRegistry,
} from '@/core/operability/provider-probe-registry';
import { registerDefaultProbes } from '@/core/operability/provider-probes/register-default-probes';
import {
  buildReconciledSnapshot,
} from '@/core/operability/reconciled-operability-snapshot';
import type {
  OperabilityHubView,
  CatalogView,
  ProviderMetadataView,
} from '@/core/operability/provider-credit-audit-service';
import type { ProviderCreditAuditMode } from '@/core/operability/provider-credit-audit-types';

interface Args {
  readonly mode: ProviderCreditAuditMode;
  readonly maxProviders?: number;
  readonly includeAggregators: boolean;
  readonly includeRouters: boolean;
  readonly includeLocal: boolean;
  /** Strategy 01C.1 — invoke `bootstrapForScripts()` so GCP Secret
   *  Manager populates process.env and the provider registry, matching
   *  the server's runtime sequence exactly. */
  readonly bootstrapRuntime: boolean;
  /** Strategy 01C.1 — declared secrets source (`gcp-secret-manager` is
   *  the only currently supported value; reserved for future overrides). */
  readonly secretsSource: 'gcp-secret-manager' | 'env-only';
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let mode: ProviderCreditAuditMode = 'metadata_only';
  let maxProviders: number | undefined;
  let includeAggregators = true;
  let includeRouters = true;
  let includeLocal = true;
  let bootstrapRuntime = false;
  let secretsSource: 'gcp-secret-manager' | 'env-only' = 'env-only';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      const next = argv[++i];
      if (next === 'metadata_only' || next === 'non_billable_probe' || next === 'minimal_billable_probe') {
        mode = next;
      }
    } else if (a === '--max-providers') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) maxProviders = n;
    } else if (a === '--include-aggregators=false') includeAggregators = false;
    else if (a === '--include-routers=false') includeRouters = false;
    else if (a === '--include-local=false') includeLocal = false;
    else if (a === '--bootstrap-runtime') bootstrapRuntime = true;
    else if (a === '--secrets-source') {
      const next = argv[++i];
      if (next === 'gcp-secret-manager') secretsSource = 'gcp-secret-manager';
    }
  }
  return { mode, maxProviders, includeAggregators, includeRouters, includeLocal, bootstrapRuntime, secretsSource };
}

// ─── View adapters around real services ───────────────────────────────

async function buildHubView(extraProviderIds: readonly string[] = []): Promise<OperabilityHubView> {
  const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
  const hub = getProviderOperabilityHub();
  // Union: providers the hub already knows AND providers we've registered
  // a probe for. Operator running this WITHOUT a live server still sees
  // probe results (Ollama, etc.), and operator running it WITH a live
  // server sees probes + hub events combined.
  const hubKnown = Object.keys(hub.getKnownProviderSources());
  const union = Array.from(new Set([...hubKnown, ...extraProviderIds]));
  return {
    getSummary: () => hub.getSummary() as Readonly<Record<string, readonly string[]>>,
    getProviderState: (id: string) => {
      const rec = hub.getProviderState(id);
      return {
        operabilityState: rec.operabilityState,
        balanceStatus: rec.balanceStatus,
        healthScore: rec.healthScore,
        // OperabilityHubView expects `number | undefined`; the underlying
        // record uses `number | null`. Normalize to undefined.
        lastSuccessAt: rec.lastSuccessAt ?? undefined,
      };
    },
    listKnownProviders: () => union,
  };
}

async function buildCatalogView(): Promise<CatalogView> {
  // Lazy: the script can return 0/0 if the catalog isn't reachable.
  // ProviderCreditAuditService treats catalog errors as silent zeros.
  try {
    const { getModelRepository } = await import('@/services/model-repository');
    const repo = getModelRepository();
    return {
      countActiveModelsForProvider: async (id: string) => {
        try {
          const models = await repo.searchModels({ providers: [id], status: 'active', limit: 1000 });
          return models.length;
        } catch {
          return 0;
        }
      },
      countUsableModelsForProvider: async (id: string) => {
        try {
          const models = await repo.searchModels({
            providers: [id],
            status: 'active',
            capabilities: ['chat'],
            limit: 1000,
          });
          return models.length;
        } catch {
          return 0;
        }
      },
    };
  } catch {
    return {
      countActiveModelsForProvider: async () => 0,
      countUsableModelsForProvider: async () => 0,
    };
  }
}

const AGGREGATOR_HINTS: readonly string[] = ['aihub', 'openrouter', 'eden', 'cometapi', 'aihubmix'];
const ROUTER_HINTS: readonly string[] = ['router'];
const LOCAL_HINTS: readonly string[] = ['ollama', 'xinference', 'own-model', 'own_model', 'self-hosted', 'self_hosted', 'localai', 'localhost'];

function buildMetadataView(): ProviderMetadataView {
  return {
    hasCredential: (id: string) => {
      const upper = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const candidates = [
        `${upper}_API_KEY`,
        `${upper.replace(/_/g, '')}_API_KEY`,
        `LLM_PROVIDER_${upper}_API_KEY`,
      ];
      return candidates.some((k) => (process.env[k] ?? '').trim().length > 0);
    },
    isAggregator: (id: string) => {
      const p = id.toLowerCase();
      return AGGREGATOR_HINTS.some((h) => p.includes(h));
    },
    isRouter: (id: string) => {
      const p = id.toLowerCase();
      return ROUTER_HINTS.some((h) => p.includes(h));
    },
    isLocal: (id: string) => {
      const p = id.toLowerCase();
      return LOCAL_HINTS.some((h) => p.includes(h));
    },
  };
}

interface SecretsBootstrapSummary {
  readonly requested: boolean;
  readonly secretsSource: 'gcp-secret-manager' | 'env-only';
  readonly gcpProjectDetected: boolean;
  readonly secretLoaderExecuted: boolean;
  readonly providerCredentialsLoaded: Readonly<Record<string, boolean>>;
  readonly fromGCPCount: number;
  readonly fromEnvCount: number;
  readonly notLoadedCount: number;
  readonly providersInRegistry: number;
  readonly error?: string;
}

async function maybeBootstrap(args: Args): Promise<SecretsBootstrapSummary> {
  if (!args.bootstrapRuntime) {
    return {
      requested: false,
      secretsSource: 'env-only',
      gcpProjectDetected: false,
      secretLoaderExecuted: false,
      providerCredentialsLoaded: {},
      fromGCPCount: 0,
      fromEnvCount: 0,
      notLoadedCount: 0,
      providersInRegistry: 0,
    };
  }

  try {
    const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
    const result = await bootstrapForScripts();
    const { getSecretsLoadSummary } = await import('@/config/load-secrets-into-env');
    const summary = getSecretsLoadSummary();
    // Strategy 01C.1 — derive gcpProjectDetected from successful GCP
    // secret reads. If fromGCPCount > 0, GCP was reachable AND returned
    // values, which is a stronger signal than the env var alone.
    const gcpProjectDetected =
      summary.fromGCP.length > 0 ||
      (process.env.GCP_PROJECT_ID ?? '').trim().length > 0 ||
      (process.env.GOOGLE_CLOUD_PROJECT ?? '').trim().length > 0;

    // Presence-only map by env var name. Never echoes values.
    const loaded: Record<string, boolean> = {};
    for (const ev of summary.fromGCP) loaded[ev] = true;
    for (const ev of summary.fromEnv) loaded[ev] = true;
    for (const ev of summary.notLoaded) {
      if (!(ev in loaded)) loaded[ev] = false;
    }

    return {
      requested: true,
      secretsSource: args.secretsSource,
      gcpProjectDetected,
      secretLoaderExecuted: true,
      providerCredentialsLoaded: loaded,
      fromGCPCount: summary.fromGCP.length,
      fromEnvCount: summary.fromEnv.length,
      notLoadedCount: summary.notLoaded.length,
      providersInRegistry: result.providersEnabled,
    };
  } catch (err) {
    return {
      requested: true,
      secretsSource: args.secretsSource,
      gcpProjectDetected: false,
      secretLoaderExecuted: false,
      providerCredentialsLoaded: {},
      fromGCPCount: 0,
      fromEnvCount: 0,
      notLoadedCount: 0,
      providersInRegistry: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<number> {
  const args = parseArgs();

  if (args.mode === 'minimal_billable_probe') {
    process.stdout.write(
      JSON.stringify(
        {
          mode: args.mode,
          status: 'blocked',
          reason: 'minimal_billable_probe requires per-run authorization; refused by audit service contract',
        },
        null,
        2,
      ) + '\n',
    );
    return 2;
  }

  // Strategy 01C.1 — optional GCP Secret Manager bootstrap. When
  // `--bootstrap-runtime` is set, we run the same secrets-→-env-→-
  // registry sequence the server uses, so the audit sees real
  // credentials and a real ProviderOperabilityHub view.
  const secretsSummary = await maybeBootstrap(args);

  // Build the probe registry first so the hub view can union its
  // providers with the hub's known list.
  let probeRegistry: ProviderProbeRegistry | undefined;
  let registered: readonly string[] = [];
  if (args.mode === 'non_billable_probe') {
    probeRegistry = new ProviderProbeRegistry();
    registered = registerDefaultProbes(probeRegistry);
  }

  const hub = await buildHubView(registered);
  const catalog = await buildCatalogView();
  const metadata = buildMetadataView();

  const service = new ProviderCreditAuditService({ hub, catalog, metadata, probeRegistry });
  const audit = await service.run({
    mode: args.mode,
    maxTotalCostUsd: 0, // metadata + non_billable have no spend
    maxProviders: args.maxProviders,
    includeAggregators: args.includeAggregators,
    includeRouters: args.includeRouters,
    includeLocal: args.includeLocal,
  });
  const snapshot = buildReconciledSnapshot(audit);

  // Strategy 01C.1 — explicit scope tagging. Operators reading the
  // output must NEVER confuse probe scope with full system readiness.
  // We resolve the canonical universe count from CONSOLIDATION_MATRIX
  // so the report shows probeCoveragePercent honestly.
  const { CONSOLIDATION_MATRIX } = await import('@/providers/catalog/consolidation-matrix');
  const canonicalProviderTotal = Object.values(CONSOLIDATION_MATRIX).reduce(
    (n, arr) => n + arr.length,
    0,
  );

  process.stdout.write(
    JSON.stringify(
      {
        args,
        scope: {
          tag: 'provider_probe_scope',
          warning: 'probe_scope_is_auxiliary_not_full_system_readiness',
          canonicalProviderTotal,
          probedProviderTotal: registered.length,
          probeCoveragePercent:
            canonicalProviderTotal > 0
              ? Math.round((registered.length / canonicalProviderTotal) * 1000) / 10
              : 0,
        },
        secretsBootstrap: secretsSummary,
        registeredProbes: registered,
        audit: {
          mode: audit.mode,
          observedAt: audit.observedAt,
          providersInspected: audit.providersInspected,
          providersConfigured: audit.providersConfigured,
          providersWithCredential: audit.providersWithCredential,
          providersUsable: audit.providersUsable,
          providersNoCredits: audit.providersNoCredits,
          providersAuthFailed: audit.providersAuthFailed,
          providersRateLimited: audit.providersRateLimited,
          providersTemporarilyUnavailable: audit.providersTemporarilyUnavailable,
          providersUnknown: audit.providersUnknown,
          routesUsable: audit.routesUsable,
          modelsUsable: audit.modelsUsable,
          localProvidersConsidered: audit.localProvidersConsidered,
          aggregatorsConsidered: audit.aggregatorsConsidered,
          routersConsidered: audit.routersConsidered,
          criticalStaleOperabilityStateCount: audit.criticalStaleOperabilityStateCount,
          staleOperabilityStates: audit.staleOperabilityStates,
          notes: audit.notes,
        },
        snapshot: {
          source: snapshot.source,
          observedAt: snapshot.observedAt,
          safeNonBillableProbeAvailable: snapshot.safeNonBillableProbeAvailable,
          criticalStaleOperabilityStateCount: snapshot.criticalStaleOperabilityStateCount,
          providerCount: Object.keys(snapshot.providerStates).length,
        },
        gates: {
          secretLoaderExecuted: secretsSummary.secretLoaderExecuted,
          gcpProjectDetected: secretsSummary.gcpProjectDetected,
          providersWithCredential: secretsSummary.fromGCPCount + secretsSummary.fromEnvCount > 0,
          atLeastOneProbeRegistered: registered.length >= 1,
          safeNonBillableProbeAvailable: snapshot.safeNonBillableProbeAvailable,
          atLeastOneUsableProvider: audit.providersUsable >= 1,
          atLeastOneUsableModel: audit.modelsUsable >= 1,
          atLeastThreeUsableModels: audit.modelsUsable >= 3,
          noCriticalStale: audit.criticalStaleOperabilityStateCount === 0,
        },
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`audit crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  });
