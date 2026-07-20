// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4B §8/§11 — Inventory probe runner (CLI).
 *
 * Thin orchestrator. Reuses (NOT duplicates):
 *   - `PROVIDER_SPECS`, `specForRoute`, `probeOne`, `ProbeArgs`,
 *     `ProbeResult` from `run-live-chat-operability-audit.ts`
 *   - `LiveChatOperabilityStore` for state recording
 *   - `buildInventoryPlan()` from `live-chat-inventory-planner.ts`
 *   - `deriveCanonicalModelIdentity` from `canonical-model-identity.ts`
 *
 * Modes:
 *   --plan-only / --no-provider-calls  → only emit the plan
 *   default (provider probes allowed)  → execute plan within budget cap
 *
 * SAFETY:
 *   - max-total-cost-usd hard-caps; default 0.012
 *   - max-tokens defaults to 10
 *   - temperature = 0 (hardcoded inside probeOne via buildBody)
 *   - sanitize is always on (no Authorization in logs)
 *   - never executes dryRun=false
 *   - never executes consensus real
 */
import fs from 'node:fs';
import type { Model } from '@/types';
import {
  PROVIDER_SPECS,
  specForRoute,
  probeOne,
  type ProbeArgs,
  type ProbeResult,
} from './run-live-chat-operability-audit';
import { buildInventoryPlan, type LiveChatInventoryPlan } from '../live-chat-inventory-planner';
import { getLiveChatOperabilityStore } from '../live-chat-operability-state';

interface InvArgs {
  modelsPerProvider: number;
  maxModelsPerProvider: number;
  maxTotalEndpointProbes: number;
  maxTotalCostUsd: number;
  maxTokens: number;
  prompt: string;
  noProviderCalls: boolean;
  sanitize: boolean;
  writePlan?: string;
  writeSummary?: string;
  writeResults?: string;
  writeSnapshotPath?: string;
  /** Optional: load catalog from a pre-dumped JSON file (array of Model
   *  rows) instead of calling getModelRepository(). Lets the planner
   *  run without booting the full app dependency graph. */
  catalogFromFile?: string;
}

function parseArgs(): InvArgs {
  const argv = process.argv.slice(2);
  const out: InvArgs = {
    modelsPerProvider: 3,
    maxModelsPerProvider: 5,
    maxTotalEndpointProbes: 120,
    maxTotalCostUsd: 0.012,
    maxTokens: 10,
    prompt: 'Say OK',
    noProviderCalls: false,
    sanitize: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--models-per-provider') out.modelsPerProvider = Number(argv[++i]);
    else if (a === '--max-models-per-provider') out.maxModelsPerProvider = Number(argv[++i]);
    else if (a === '--max-total-endpoint-probes') out.maxTotalEndpointProbes = Number(argv[++i]);
    else if (a === '--max-total-cost-usd') out.maxTotalCostUsd = Number(argv[++i]);
    else if (a === '--max-tokens') out.maxTokens = Number(argv[++i]);
    else if (a === '--prompt') out.prompt = String(argv[++i]);
    else if (a === '--no-provider-calls' || a === '--plan-only') out.noProviderCalls = true;
    else if (a === '--write-plan') out.writePlan = String(next), i++;
    else if (a === '--write-summary') out.writeSummary = String(next), i++;
    else if (a === '--write-results' || a === '--write-json') out.writeResults = String(next), i++;
    else if (a === '--write-snapshot' || a === '--snapshot-path') out.writeSnapshotPath = String(next), i++;
    else if (a === '--temperature') i++; // accepted + ignored (probe is always temp=0)
    else if (a === '--sanitize') out.sanitize = true; // already default
    else if (a === '--catalog-from-file') out.catalogFromFile = String(next), i++;
    else if (a === '--no-retries' || a === '--inventory-from-catalog' || a === '--providers-with-local-secrets-only' || a === '--exclude-specialized-non-chat-providers' || a === '--bootstrap-runtime') {
      // accepted no-ops (flags documented in spec; behaviors are built-in defaults)
    }
  }
  // SAFETY: hard caps
  out.maxTokens = Math.min(10, Math.max(1, out.maxTokens));
  out.maxTotalCostUsd = Math.min(0.012, Math.max(0, out.maxTotalCostUsd));
  out.maxTotalEndpointProbes = Math.min(120, Math.max(0, out.maxTotalEndpointProbes));
  out.maxModelsPerProvider = Math.min(5, Math.max(1, out.maxModelsPerProvider));
  out.modelsPerProvider = Math.min(out.maxModelsPerProvider, Math.max(1, out.modelsPerProvider));
  return out;
}

function detectSecrets(): Set<string> {
  // Map a providerId → its env-var name (mirrored from PROVIDER_SPECS).
  // For each entry, check that the env var is set + non-empty.
  const out = new Set<string>();
  for (const [providerId, spec] of Object.entries(PROVIDER_SPECS)) {
    const v = process.env[spec.envVar];
    if (v && v.length >= 4) out.add(providerId);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // 1) Load catalog. Two modes:
  //    a) --catalog-from-file: read pre-dumped JSON (fastest; bypasses
  //       model-repository init which boots heavy dependency graph).
  //    b) Default: lazy-import model-repository and call searchModels.
  let catalog: readonly Model[];
  if (args.catalogFromFile) {
    if (!fs.existsSync(args.catalogFromFile)) {
      throw new Error(`--catalog-from-file not found: ${args.catalogFromFile}`);
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(args.catalogFromFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('catalog file must be an array');
    catalog = parsed as Model[];
  } else {
    const { getModelRepository } = await import('@/services/model-repository');
    const repo = getModelRepository();
    catalog = await repo.searchModels({
      status: 'active',
      capabilities: ['chat'],
      limit: 10_000,
    });
  }

  // 2) Spec + secret sets.
  const providersWithSpec = new Set(Object.keys(PROVIDER_SPECS));
  const providersWithSecret = detectSecrets();

  // 3) Plan. NOTE: the planner's budget cap is independent from the
  // execution cap. When `--max-total-cost-usd 0` is passed to disable
  // execution (plan-only mode), the planner still needs a non-zero cap
  // to enumerate candidates. We use the maximum recoverable cap
  // (0.012 from spec §3) for the planner, and rely on the execution
  // loop below to enforce the user's actual `--max-total-cost-usd`.
  const planCostCapUsd = Math.max(0.012, args.maxTotalCostUsd);
  const plan: LiveChatInventoryPlan = buildInventoryPlan({
    catalog,
    providersWithSpec,
    providersWithSecret,
    modelsPerProvider: args.modelsPerProvider,
    maxModelsPerProvider: args.maxModelsPerProvider,
    maxTotalEndpointProbes: args.maxTotalEndpointProbes,
    maxTotalCostUsd: planCostCapUsd,
  });

  if (args.writePlan) {
    fs.writeFileSync(args.writePlan, JSON.stringify(plan, null, 2));
    console.error(`Plan written: ${args.writePlan}  (${plan.plannedProbes.length} probes)`);
  }
  if (args.writeSummary) {
    fs.writeFileSync(args.writeSummary, JSON.stringify(plan.summary, null, 2));
    console.error(`Summary written: ${args.writeSummary}`);
  }

  // 4) Stop here if --plan-only / --no-provider-calls
  if (args.noProviderCalls) {
    console.log(JSON.stringify({ mode: 'plan-only', ...plan.summary }, null, 2));
    return;
  }

  // 5) Execute probes within budget cap.
  const store = getLiveChatOperabilityStore();
  const probeArgs: ProbeArgs = {
    maxTokens: args.maxTokens,
    prompt: args.prompt,
    sanitize: args.sanitize,
    source: 'direct_chat_probe' as const,
    maxTotalCostUsd: args.maxTotalCostUsd,
    noRetries: true,
  };
  const results: ProbeResult[] = [];
  let accruedCostUsd = 0;
  const perProbeWorstCase = 0.00001;

  for (const planned of plan.plannedProbes) {
    if (accruedCostUsd + perProbeWorstCase > args.maxTotalCostUsd) break;
    if (results.length >= args.maxTotalEndpointProbes) break;
    const spec = specForRoute(planned.providerId, planned.apiModelId);
    if (!spec) {
      // Shouldn't happen since planner pre-filters by providersWithSpec.
      continue;
    }
    const result = await probeOne(spec, probeArgs);
    results.push(result);
    accruedCostUsd += perProbeWorstCase;
  }

  // 6) Persist snapshot if requested.
  if (args.writeSnapshotPath) {
    await store.writeSnapshot(args.writeSnapshotPath);
    console.error(`Snapshot written: ${args.writeSnapshotPath}`);
  }

  // 7) Persist results if requested.
  if (args.writeResults) {
    const enriched = {
      stage: '01C.1B-J1D-R4B-INVENTORY',
      generatedAt: new Date().toISOString(),
      plannedCount: plan.plannedProbes.length,
      executedCount: results.length,
      accruedCostUsd,
      maxTotalCostUsd: args.maxTotalCostUsd,
      maxTokens: args.maxTokens,
      prompt: args.prompt,
      // Merge each probe result with its planned-probe metadata so
      // downstream validators can see canonical + context-window data.
      results: results.map((r) => {
        const planned = plan.plannedProbes.find(
          (p) => p.providerId === r.providerId && p.apiModelId === r.modelId,
        );
        return {
          ...r,
          apiModelId: r.modelId,
          catalogModelId: planned?.catalogModelId,
          canonicalModelId: planned?.canonicalModelId,
          family: planned?.family,
          vendor: planned?.vendor,
          contextWindow: planned?.contextWindow,
          maxOutputTokens: planned?.maxOutputTokens,
          capabilities: planned?.capabilities,
          selectionReason: planned?.selectionReason,
          status: r.chatReady ? 'live_ready' : 'not_live_ready',
          liveReady: r.chatReady,
          costUsd: perProbeWorstCase,
        };
      }),
      summary: plan.summary,
    };
    fs.writeFileSync(args.writeResults, JSON.stringify(enriched, null, 2));
  }

  // 8) Stdout summary (machine-readable).
  console.log(
    JSON.stringify(
      {
        stage: '01C.1B-J1D-R4B-INVENTORY',
        plannedCount: plan.plannedProbes.length,
        executedCount: results.length,
        accruedCostUsd,
        readyCount: results.filter((r) => r.chatReady).length,
        failedCount: results.filter((r) => !r.chatReady).length,
        distinctProvidersProbed: new Set(results.map((r) => r.providerId)).size,
        ...plan.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('inventory_fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
