// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1F §10 — Discovery alias learning script.
 *
 * CATALOG-FIRST: queries the local `models` table (filled by prior
 * discovery runs) for each (provider, logical-model) pair, runs the
 * J1F learner, and writes a snapshot the J1E resolver can consume.
 *
 * NO chat completions. NO external HTTP calls. The only network
 * activity is to the local Postgres `ci-postgres` container.
 *
 * USAGE:
 *   pnpm tsx src/core/operability/scripts/run-provider-discovery-alias-learning.ts \
 *     --providers <csv> \
 *     --logical-models <csv> \
 *     --use-internal-catalog \
 *     --write-json <path> \
 *     --write-md <path> \
 *     --write-alias-snapshot <path> \
 *     --no-chat-completions \
 *     --no-provider-generation \
 *     --sanitize
 */
import { prisma } from '@/database/client';
import {
  learnAliasForProvider,
  type DiscoveredModelRow,
  type DiscoveryAliasLearningResult,
} from '@/core/orchestration/model-routing/provider-discovery-alias-learner';
import { parseLogicalModelTokens } from '@/core/orchestration/model-routing/provider-discovery-alias-learner';
import fs from 'node:fs';

interface Args {
  providers: string[];
  logicalModels: string[];
  writeJsonPath?: string;
  writeMdPath?: string;
  writeAliasSnapshotPath?: string;
  useInternalCatalog: boolean;
  useCachedDiscovery: boolean;
  useProviderModelList: boolean;
  useExistingAliases: boolean;
  noChatCompletions: boolean;
  noProviderGeneration: boolean;
  dryRun: boolean;
  sanitize: boolean;
  preferLiveModelList: boolean;
  maxCacheAgeMs: number;
  maxExternalDiscoveryCalls: number;
  timeoutMs: number;
  includeRawModelIds: boolean;
  includeSanitizedModelSamples: boolean;
  failOnSecretLeak: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    providers: [],
    logicalModels: [],
    useInternalCatalog: true,
    useCachedDiscovery: false,
    useProviderModelList: false,
    useExistingAliases: false,
    noChatCompletions: true,
    noProviderGeneration: true,
    dryRun: false,
    sanitize: true,
    preferLiveModelList: false,
    maxCacheAgeMs: 86_400_000,
    maxExternalDiscoveryCalls: 0,
    timeoutMs: 12_000,
    includeRawModelIds: false,
    includeSanitizedModelSamples: true,
    failOnSecretLeak: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--providers': a.providers = v.split(',').map((x) => x.trim()).filter(Boolean); i++; break;
      case '--logical-models': a.logicalModels = v.split(',').map((x) => x.trim()).filter(Boolean); i++; break;
      case '--write-json': a.writeJsonPath = v; i++; break;
      case '--write-md': a.writeMdPath = v; i++; break;
      case '--write-alias-snapshot': a.writeAliasSnapshotPath = v; i++; break;
      case '--use-internal-catalog': a.useInternalCatalog = true; break;
      case '--use-cached-discovery': a.useCachedDiscovery = true; break;
      case '--use-provider-model-list': a.useProviderModelList = true; break;
      case '--use-existing-aliases': a.useExistingAliases = true; break;
      case '--no-chat-completions': a.noChatCompletions = true; break;
      case '--no-provider-generation': a.noProviderGeneration = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--sanitize': a.sanitize = true; break;
      case '--prefer-live-model-list': a.preferLiveModelList = v === 'true'; i++; break;
      case '--max-cache-age-ms': a.maxCacheAgeMs = Number(v); i++; break;
      case '--max-external-discovery-calls': a.maxExternalDiscoveryCalls = Number(v); i++; break;
      case '--timeout-ms': a.timeoutMs = Number(v); i++; break;
      case '--include-raw-model-ids': a.includeRawModelIds = v === 'true'; i++; break;
      case '--include-sanitized-model-samples': a.includeSanitizedModelSamples = v === 'true'; i++; break;
      case '--fail-on-secret-leak': a.failOnSecretLeak = v === 'true'; i++; break;
      case '--help':
        process.stdout.write('Usage: see file header\n');
        process.exit(0);
    }
  }
  return a;
}

async function loadCatalogRowsForLogical(
  logicalModelId: string,
  providerIds: readonly string[],
): Promise<readonly DiscoveredModelRow[]> {
  const tokens = parseLogicalModelTokens(logicalModelId);
  if (!tokens) return [];
  // Build a broad family+version ILIKE filter. The learner's safety
  // guards will then strictly score each row.
  const versionPatterns = tokens.versionMinor
    ? [`${tokens.versionMajor}.${tokens.versionMinor}`, `${tokens.versionMajor}-${tokens.versionMinor}`]
    : [tokens.versionMajor];
  const orFilter = providerIds.flatMap((p) =>
    versionPatterns.flatMap((v) => [
      { providerId: p, name: { contains: `${tokens.family}`, mode: 'insensitive' as const }, AND: [{ name: { contains: v, mode: 'insensitive' as const } }] },
      { providerId: p, id: { contains: `${tokens.family}`, mode: 'insensitive' as const }, AND: [{ id: { contains: v, mode: 'insensitive' as const } }] },
    ])
  );
  const rows = await prisma.model.findMany({
    where: { OR: orFilter, status: { not: 'disabled' } },
    select: { providerId: true, id: true, name: true },
    take: 500,
  });
  return rows.map((r) => ({ providerId: r.providerId, id: r.id, name: r.name }));
}

async function main() {
  const args = parseArgs();
  const log = (msg: string) => process.stderr.write(`[j1f-learner] ${msg}\n`);

  if (!args.useInternalCatalog && !args.useCachedDiscovery && !args.useProviderModelList) {
    process.stderr.write('ERROR: at least one of --use-internal-catalog / --use-cached-discovery / --use-provider-model-list required\n');
    process.exit(1);
  }
  if (args.useProviderModelList) {
    process.stderr.write('NOTE: --use-provider-model-list deferred — J1F implementation is catalog-first; provider /v1/models calls are future work.\n');
  }
  log(`providers=${args.providers.length} logicalModels=${args.logicalModels.length}`);

  const results: DiscoveryAliasLearningResult[] = [];
  for (const logical of args.logicalModels) {
    const rows = await loadCatalogRowsForLogical(logical, args.providers);
    log(`logical=${logical} catalog rows=${rows.length}`);
    for (const provider of args.providers) {
      const r = learnAliasForProvider({
        providerId: provider,
        logicalModelId: logical,
        discoveredRows: rows,
      });
      results.push(r);
    }
  }

  const succeeded = results.filter((r) => r.selected).map((r) => ({
    providerId: r.providerId,
    logicalModelId: r.logicalModelId,
    apiModelId: r.selected!.apiModelId,
    confidence: r.selected!.confidence,
    matchKind: r.selected!.matchKind,
  }));
  const failed = results.filter((r) => !r.selected).map((r) => ({
    providerId: r.providerId,
    logicalModelId: r.logicalModelId,
    unresolvedReason: r.unresolvedReason,
    candidatesCount: r.candidates.length,
  }));

  const summary = {
    stage: '01C.1B-J1F',
    generatedAt: new Date().toISOString(),
    externalModelListCalls: 0,
    chatCompletionsExecuted: 0,
    generationCostUsd: 0,
    totalLogicalModels: args.logicalModels.length,
    totalProvidersAttempted: args.providers.length,
    totalPairsAttempted: args.providers.length * args.logicalModels.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    succeeded,
    failed,
    perPair: results.map((r) => ({
      providerId: r.providerId,
      logicalModelId: r.logicalModelId,
      candidatesCount: r.candidates.length,
      selected: r.selected
        ? {
            apiModelId: r.selected.apiModelId,
            confidence: r.selected.confidence,
            matchKind: r.selected.matchKind,
            evidenceDisplayName: args.includeSanitizedModelSamples ? r.selected.evidence.displayName : undefined,
          }
        : null,
      unresolvedReason: r.unresolvedReason ?? null,
    })),
  };

  // Alias snapshot — feeds the J1E resolver
  const aliasSnapshot = {
    stage: '01C.1B-J1F',
    generatedAt: new Date().toISOString(),
    source: 'internal_catalog',
    entries: succeeded.map((s) => ({
      providerId: s.providerId,
      logicalModelId: s.logicalModelId,
      apiModelId: s.apiModelId,
      confidence: s.confidence,
      matchKind: s.matchKind,
      source: 'discovery_alias_snapshot',
    })),
  };

  if (args.writeJsonPath) fs.writeFileSync(args.writeJsonPath, JSON.stringify(summary, null, 2));
  if (args.writeAliasSnapshotPath) fs.writeFileSync(args.writeAliasSnapshotPath, JSON.stringify(aliasSnapshot, null, 2));
  if (args.writeMdPath) {
    const md = [
      '# 01C.1B-J1F Provider Discovery Alias Learning',
      '',
      `Generated: ${summary.generatedAt}`,
      `Total pairs: ${summary.totalPairsAttempted}`,
      `Succeeded: ${summary.succeededCount}`,
      `Failed: ${summary.failedCount}`,
      '',
      '## Succeeded',
      '| Provider | Logical | apiModelId | Confidence | Match kind |',
      '|----------|---------|------------|------------|------------|',
      ...succeeded.map((s) =>
        `| ${s.providerId} | \`${s.logicalModelId}\` | \`${s.apiModelId}\` | ${s.confidence} | ${s.matchKind} |`),
      '',
      '## Failed',
      '| Provider | Logical | Unresolved reason | Candidates |',
      '|----------|---------|-------------------|-----------:|',
      ...failed.map((f) => `| ${f.providerId} | \`${f.logicalModelId}\` | ${f.unresolvedReason} | ${f.candidatesCount} |`),
    ];
    fs.writeFileSync(args.writeMdPath, md.join('\n'));
  }

  process.stdout.write(JSON.stringify({
    stage: summary.stage,
    succeededCount: summary.succeededCount,
    failedCount: summary.failedCount,
    chatCompletionsExecuted: summary.chatCompletionsExecuted,
    externalModelListCalls: summary.externalModelListCalls,
    generationCostUsd: summary.generationCostUsd,
  }, null, 2));
  process.stdout.write('\n');

  await prisma.$disconnect();
}

main().catch((err) => {
  process.stderr.write(`[j1f-learner] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
