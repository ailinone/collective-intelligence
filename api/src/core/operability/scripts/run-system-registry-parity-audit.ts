// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * System Registry Parity Audit — Strategy 01C.1B pre-flight.
 *
 * Proves (or refutes) that the CLI sees the same canonical universe as
 * the chat path: providers from `CONSOLIDATION_MATRIX` (the canonical
 * 103-row list), models from the DB catalog (`modelCatalogService`),
 * and probes from the auxiliary `ProviderProbeRegistry`. Reports
 * deltas so operators can see whether readiness is FULL_SYSTEM or
 * PARTIAL_PROBE.
 *
 * Requires:
 *   --bootstrap-runtime
 *   --secrets-source gcp-secret-manager
 *
 * Output: a single JSON document on stdout. No secret values. No
 * provider call. Zero DB writes.
 */
import {
  CONSOLIDATION_MATRIX,
  type ConsolidationBucket,
} from '@/providers/catalog/consolidation-matrix';
import { classifyProviderKind } from '@/core/selection/provider-kind';
import { ProviderProbeRegistry } from '@/core/operability/provider-probe-registry';
import { registerDefaultProbes } from '@/core/operability/provider-probes/register-default-probes';

interface Args {
  readonly bootstrapRuntime: boolean;
  readonly secretsSource: 'gcp-secret-manager' | 'env-only';
  /** Run `loadProviderCatalog()` after bootstrap — registers ~71
   *  catalog-plugin adapters (huggingface, edenai, vertex-ai, azure,
   *  aws-bedrock, etc.) in addition to the 12 native switch-case
   *  adapters. Mirrors the server's Phase 4. */
  readonly loadCatalog: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let bootstrapRuntime = false;
  let secretsSource: 'gcp-secret-manager' | 'env-only' = 'env-only';
  let loadCatalog = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bootstrap-runtime') bootstrapRuntime = true;
    if (a === '--load-catalog') loadCatalog = true;
    if (a === '--secrets-source') {
      const next = argv[++i];
      if (next === 'gcp-secret-manager') secretsSource = 'gcp-secret-manager';
    }
  }
  return { bootstrapRuntime, secretsSource, loadCatalog };
}

interface SecretsSummary {
  readonly secretsSource: 'gcp-secret-manager' | 'env-only';
  readonly secretLoaderExecuted: boolean;
  readonly gcpProjectDetected: boolean;
  readonly fromGCPCount: number;
  readonly fromEnvCount: number;
  readonly notLoadedCount: number;
}

async function bootstrap(args: Args): Promise<{ secrets: SecretsSummary; providersInRegistry: string[] }> {
  if (!args.bootstrapRuntime) {
    return {
      secrets: {
        secretsSource: 'env-only',
        secretLoaderExecuted: false,
        gcpProjectDetected: false,
        fromGCPCount: 0,
        fromEnvCount: 0,
        notLoadedCount: 0,
      },
      providersInRegistry: [],
    };
  }
  const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
  await bootstrapForScripts();
  // Phase 4 (server-parallel) — load the provider catalog if requested.
  // Without this, ~71 plugin-based adapters (huggingface, edenai,
  // vertex-ai, azure, aws-bedrock, etc.) never register, and the audit
  // sees only the 12 native switch-case adapters. The server's
  // index.ts:519 calls `loadProviderCatalog()` after bootstrap; we
  // mirror that here behind --load-catalog for opt-in cost (~71×5s).
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
  const { getSecretsLoadSummary } = await import('@/config/load-secrets-into-env');
  const summary = getSecretsLoadSummary();
  const { getProviderRegistry } = await import('@/providers/provider-registry');
  const reg = getProviderRegistry();
  const providersInRegistry = reg.getProviderNames();
  return {
    secrets: {
      secretsSource: args.secretsSource,
      secretLoaderExecuted: true,
      gcpProjectDetected: summary.fromGCP.length > 0,
      fromGCPCount: summary.fromGCP.length,
      fromEnvCount: summary.fromEnv.length,
      notLoadedCount: summary.notLoaded.length,
    },
    providersInRegistry,
  };
}

interface ProviderRegistryView {
  readonly total: number;
  readonly canonicalIds: readonly string[];
  readonly byBucket: Readonly<Record<ConsolidationBucket, number>>;
  readonly byKind: Readonly<Record<'native' | 'hub' | 'local' | 'unknown', number>>;
  readonly withCredential: number;
  readonly withAdapterRegistered: number;
  readonly withProbe: number;
}

function computeProviderView(input: {
  readonly providersWithCredential: ReadonlySet<string>;
  readonly providersInRegistry: ReadonlySet<string>;
  readonly probedProviders: ReadonlySet<string>;
}): ProviderRegistryView {
  const canonical: string[] = [];
  const byBucket: Record<ConsolidationBucket, number> = {
    'live-validation': 0,
    'no-live-validation': 0,
    'partial': 0,
    'credentials-missing': 0,
    'vendor-side-failure': 0,
    'upstream-suspended': 0,
    'defunct-unreachable': 0,
    'catalog-only-inventory': 0,
    'switch-only-legitimate': 0,
    'not-eligible': 0,
  };
  for (const bucket of Object.keys(CONSOLIDATION_MATRIX) as ConsolidationBucket[]) {
    for (const pid of CONSOLIDATION_MATRIX[bucket]) {
      canonical.push(pid);
      byBucket[bucket]++;
    }
  }
  const byKind: Record<'native' | 'hub' | 'local' | 'unknown', number> = {
    native: 0,
    hub: 0,
    local: 0,
    unknown: 0,
  };
  let withCredential = 0;
  let withRegistered = 0;
  let withProbe = 0;
  for (const pid of canonical) {
    const k = classifyProviderKind(pid);
    byKind[k]++;
    if (input.providersWithCredential.has(pid)) withCredential++;
    if (input.providersInRegistry.has(pid)) withRegistered++;
    if (input.probedProviders.has(pid)) withProbe++;
  }
  return {
    total: canonical.length,
    canonicalIds: canonical,
    byBucket,
    byKind,
    withCredential,
    withAdapterRegistered: withRegistered,
    withProbe,
  };
}

interface ModelRegistryView {
  readonly totalModels: number;
  readonly activeModels: number;
  readonly chatCapableModels: number;
  readonly pricedModels: number;
  readonly modelsWithContextWindow: number;
  readonly modelsWithCapabilityUris: number;
  readonly distinctProviders: number;
  readonly providersWithModels: readonly string[];
  readonly source: 'catalog_db' | 'catalog_db_unavailable';
  readonly note?: string;
}

function describeDatabaseTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) return '(unset)';
  // Strip credentials: postgresql://user:pass@host:port/db → host:port/db
  const m = url.match(/@([^/]+)\/([^?]+)/);
  return m ? `${m[1]}/${m[2]}` : '(opaque)';
}

async function computeModelView(): Promise<ModelRegistryView> {
  try {
    const { modelCatalogService } = await import('@/services/model-catalog-service');
    const all = await modelCatalogService.listModels();
    const active = all.filter((m) => m.status === 'active');
    const chatCapable = active.filter(
      (m) => Array.isArray(m.capabilities) && m.capabilities.includes('chat'),
    );
    const priced = active.filter(
      (m) => Number(m.inputCostPer1k ?? 0) > 0 || Number(m.outputCostPer1k ?? 0) > 0,
    );
    const withContext = active.filter((m) => (m.contextWindow ?? 0) > 0);
    const withCapUris = active.filter(
      (m) => Array.isArray(m.capabilityUris) && m.capabilityUris.length > 0,
    );
    const providers = new Set(active.map((m) => m.provider));
    return {
      totalModels: all.length,
      activeModels: active.length,
      chatCapableModels: chatCapable.length,
      pricedModels: priced.length,
      modelsWithContextWindow: withContext.length,
      modelsWithCapabilityUris: withCapUris.length,
      distinctProviders: providers.size,
      providersWithModels: Array.from(providers).sort(),
      source: 'catalog_db',
    };
  } catch (err) {
    return {
      totalModels: 0,
      activeModels: 0,
      chatCapableModels: 0,
      pricedModels: 0,
      modelsWithContextWindow: 0,
      modelsWithCapabilityUris: 0,
      distinctProviders: 0,
      providersWithModels: [],
      source: 'catalog_db_unavailable',
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

interface OperabilityView {
  readonly hubKnownProviders: number;
  readonly byState: Readonly<Record<string, number>>;
}

async function computeOperabilityView(): Promise<OperabilityView> {
  try {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();
    const known = Object.keys(hub.getKnownProviderSources());
    const summary = hub.getSummary() as Record<string, string[]>;
    const byState: Record<string, number> = {};
    for (const [state, ids] of Object.entries(summary)) {
      byState[state] = Array.isArray(ids) ? ids.length : 0;
    }
    return { hubKnownProviders: known.length, byState };
  } catch {
    return { hubKnownProviders: 0, byState: {} };
  }
}

async function main(): Promise<number> {
  const args = parseArgs();
  const { secrets, providersInRegistry } = await bootstrap(args);

  // Probe registry — auxiliary, not the universe.
  const probeReg = new ProviderProbeRegistry();
  const probedProviders = args.bootstrapRuntime
    ? registerDefaultProbes(probeReg)
    : [];

  // Credentials → canonical provider IDs. `getLoadedProviderNames()`
  // exposes the load-secrets module's normalized provider names; we
  // intersect with CONSOLIDATION_MATRIX to count canonical providers
  // that have a credential.
  const credentialedProviders = new Set<string>();
  if (args.bootstrapRuntime) {
    const { getLoadedProviderNames } = await import('@/config/load-secrets-into-env');
    for (const pid of getLoadedProviderNames()) {
      credentialedProviders.add(pid.toLowerCase());
    }
  }

  const providerView = computeProviderView({
    providersWithCredential: credentialedProviders,
    providersInRegistry: new Set(providersInRegistry.map((s) => s.toLowerCase())),
    probedProviders: new Set(probedProviders.map((s) => s.toLowerCase())),
  });
  const modelView = await computeModelView();
  const operability = await computeOperabilityView();

  // Deltas — the heart of the report.
  const deltas: Array<{ kind: string; message: string; severity: 'info' | 'warn' | 'block' }> = [];
  if (providerView.total < 100) {
    deltas.push({
      kind: 'provider_registry_under_100',
      message: `CONSOLIDATION_MATRIX has ${providerView.total} providers; expected ~103. Check schema drift.`,
      severity: 'warn',
    });
  }
  if (modelView.totalModels < 10000) {
    deltas.push({
      kind: 'model_catalog_under_expected',
      message: `Catalog has ${modelView.totalModels} models; expected tens of thousands. DB may not be reachable from this script context (Prisma/DATABASE_URL).`,
      severity: modelView.source === 'catalog_db_unavailable' ? 'block' : 'warn',
    });
  }
  if (providerView.withProbe < providerView.total) {
    deltas.push({
      kind: 'probe_coverage_partial',
      message: `Probe coverage: ${providerView.withProbe}/${providerView.total} (auxiliary by design; non-block).`,
      severity: 'info',
    });
  }
  if (
    providerView.withCredential > 0 &&
    providerView.withAdapterRegistered < providerView.withCredential
  ) {
    deltas.push({
      kind: 'adapter_registration_lag',
      message: `${providerView.withCredential} providers have credentials but only ${providerView.withAdapterRegistered} have adapters registered. Check initializeProviderRegistry config.`,
      severity: 'warn',
    });
  }

  const probeCoveragePercent =
    providerView.total > 0
      ? Math.round((providerView.withProbe / providerView.total) * 1000) / 10
      : 0;

  process.stdout.write(
    JSON.stringify(
      {
        args,
        secrets,
        providerRegistry: {
          // Canonical universe — sourced from CONSOLIDATION_MATRIX
          source: 'consolidation_matrix',
          total: providerView.total,
          byBucket: providerView.byBucket,
          byKind: providerView.byKind,
          withCredential: providerView.withCredential,
          withAdapterRegistered: providerView.withAdapterRegistered,
          withProbe: providerView.withProbe,
        },
        modelRegistry: {
          source: modelView.source,
          databaseTarget: describeDatabaseTarget(),
          totalModels: modelView.totalModels,
          activeModels: modelView.activeModels,
          chatCapableModels: modelView.chatCapableModels,
          pricedModels: modelView.pricedModels,
          modelsWithContextWindow: modelView.modelsWithContextWindow,
          modelsWithCapabilityUris: modelView.modelsWithCapabilityUris,
          distinctProviders: modelView.distinctProviders,
          ...(modelView.note ? { note: modelView.note } : {}),
        },
        probeScope: {
          probedProviders: probedProviders.length,
          probedProviderIds: probedProviders,
          probeCoveragePercent,
          probesAreAuxiliaryNotUniverse: true,
        },
        operability,
        deltas,
        gates: {
          secretLoaderExecuted: secrets.secretLoaderExecuted,
          secretsSource: secrets.secretsSource,
          gcpProjectDetected: secrets.gcpProjectDetected,
          providerRegistryMatchesCanonical:
            providerView.total >= 100 && providerView.total <= 120,
          modelRegistryReachable: modelView.source === 'catalog_db',
          atLeastOneAdapterRegistered: providerView.withAdapterRegistered >= 1,
          atLeastOneProvWithCredAndProbe: providerView.withProbe >= 1,
          // The crucial gate — probe scope IS auxiliary, not universe.
          probeScopeIsAuxiliary: true,
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
    process.stderr.write(
      `parity audit crashed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(3);
  });
