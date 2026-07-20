// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — G→G2 Reclassification Report.
 *
 * Reads a G-audit JSON file, applies `applyG2Reclassification`, and
 * prints a terminal-friendly report:
 *   - G bucket distribution
 *   - G2 bucket distribution
 *   - per-provider migration diff
 *   - candidates for canonical reprobe (G_alias_probable with apiModelId)
 *
 * Run:
 *   pnpm tsx src/core/operability/scripts/run-g2-reclassification-report.ts \
 *     --in ./tmp/provider_adapter_readiness_01c1b_g2.json \
 *     --out ./tmp/provider_readiness_g2.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { applyG2Reclassification, type GAuditRecordLike } from '../apply-g2-reclassification';
import {
  BUCKET_DESCRIPTIONS,
  type ProviderReadinessBucket,
} from '../provider-readiness-buckets';

function parseArgs(): { inPath: string; outPath?: string } {
  const argv = process.argv.slice(2);
  let inPath = './tmp/provider_adapter_readiness_01c1b_g2.json';
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') inPath = argv[++i] ?? inPath;
    else if (a === '--out') outPath = argv[++i];
  }
  return { inPath, outPath };
}

function main(): void {
  const { inPath, outPath } = parseArgs();
  const raw = readFileSync(inPath, 'utf8');
  // Tolerate curl-trailer style JSON output by trimming to last '}'.
  const lastBrace = raw.lastIndexOf('}');
  const trimmed = raw.slice(0, lastBrace + 1);
  const parsed: unknown = JSON.parse(trimmed);

  // The G audit JSON is either a bare array or { summary, providers/records/results: [...] }.
  let records: readonly GAuditRecordLike[];
  if (Array.isArray(parsed)) {
    records = parsed as readonly GAuditRecordLike[];
  } else {
    const obj = parsed as {
      providers?: readonly GAuditRecordLike[];
      records?: readonly GAuditRecordLike[];
      results?: readonly GAuditRecordLike[];
    };
    records = obj.providers ?? obj.records ?? obj.results ?? [];
  }

  // Caller-supplied refinement hints. We seed these from evidence we
  // gathered across G (see MEMORY + prior dry-runs) — keeping the list
  // narrow and conservative.
  const hints = {
    // Providers that need deployment endpoint or region.
    requiresDeployment: ['azure-openai', 'aws-bedrock', 'vertex-ai', 'sap-ai-core', 'aws-sagemaker', 'databricks', 'snowflake', 'watsonx'],
    // Providers known to have catalog id mismatch (binding row → wrong adapter).
    catalogIdMismatched: ['sambanova', 'perplexity', 'replicate'],
    // Providers we suspect of secret-alias loader mismatch (Loader uses
    // different env var name than adapter expects). Conservative empty
    // for now — fill from D-bucket revalidation.
    secretAliasMismatched: [] as string[],
    // Providers we suspect of auth-header / base-url mismatch.
    authHeaderMismatched: [] as string[],
    // Providers explicitly skipped by budget cap during this run.
    skippedByBudget: [] as string[],
  };

  const out = applyG2Reclassification({
    gAudit: records,
    ...hints,
  });

  // ── Distribution: G before ───────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║         01C.1B-G2 — G→G2 Reclassification Report                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log(`\nTotal providers in audit: ${records.length}`);
  console.log(`Reclassified (bucket changed): ${out.diff.length}`);

  console.log('\n── G distribution (BEFORE) ────────────────────────────────────────');
  const beforePairs = Object.entries(out.distributionBefore).sort((a, b) => b[1] - a[1]);
  for (const [bucket, count] of beforePairs) {
    console.log(`  ${count.toString().padStart(3, ' ')}  ${bucket}`);
  }

  // ── Distribution: G2 after ───────────────────────────────────────
  console.log('\n── G2 distribution (AFTER) ────────────────────────────────────────');
  const afterPairs = Object.entries(out.distributionAfter).sort((a, b) => b[1] - a[1]);
  for (const [bucket, count] of afterPairs) {
    const desc = BUCKET_DESCRIPTIONS[bucket as ProviderReadinessBucket] ?? '';
    console.log(`  ${count.toString().padStart(3, ' ')}  ${bucket.padEnd(45, ' ')}  ${desc}`);
  }

  // ── Diff: providers that moved bucket ──────────────────────────────
  console.log('\n── Migration diff (per-provider) ──────────────────────────────────');
  for (const d of out.diff) {
    console.log(`  ${d.providerId.padEnd(22, ' ')}  ${d.from.padEnd(48, ' ')} → ${d.to}`);
    console.log(`  ${''.padEnd(22, ' ')}    reason: ${d.reason}`);
  }

  // ── Canonical reprobe candidates ───────────────────────────────────
  const reprobeCandidates = out.records.filter(
    (r) => r.bucketG2 === 'G_model_alias_mismatch_probable' && r.canonicalProbeApiModelId,
  );
  console.log('\n── Canonical reprobe candidates (G_alias_probable with resolved apiModelId) ──');
  if (reprobeCandidates.length === 0) {
    console.log('  (none — no providers have catalog_alias rewrite available)');
  } else {
    for (const r of reprobeCandidates) {
      console.log(
        `  ${r.providerId.padEnd(22, ' ')}  catalog=${(r.canonicalProbeModelId ?? '-').padEnd(40, ' ')}  api=${r.canonicalProbeApiModelId}  (source=${r.canonicalProbeSource})`,
      );
    }
  }

  // ── Buckets needing action ─────────────────────────────────────────
  const actionableBuckets: ProviderReadinessBucket[] = [
    'C_blocked_by_credit',
    'D_blocked_by_auth_confirmed',
    'G_model_alias_mismatch_probable',
    'H_model_not_supported_confirmed',
    'I_adapter_missing',
    'J_secret_missing',
    'N_specialized_non_chat_provider',
    'O_no_catalog_model_bound_to_provider',
    'V_unknown_unclassified',
  ];
  console.log('\n── Providers per actionable bucket ────────────────────────────────');
  for (const bucket of actionableBuckets) {
    const providers = out.records.filter((r) => r.bucketG2 === bucket);
    if (providers.length === 0) continue;
    console.log(`\n  ${bucket}  (${providers.length})`);
    for (const p of providers) {
      console.log(`    - ${p.providerId}`);
    }
  }

  // ── Write the full G2 JSON if requested ────────────────────────────
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n✓ Wrote G2 reclassification to ${outPath}`);
  }

  // ── Final verdict ──────────────────────────────────────────────────
  const aReady = out.records.filter((r) => r.bucketG2 === 'A_chat_ready').length;
  const kReady = out.records.filter((r) => r.bucketG2 === 'K_local_ollama_ready').length;
  const totalReady = aReady + kReady;
  const truelyUnknown = out.records.filter((r) => r.bucketG2 === 'V_unknown_unclassified').length;
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                                     ║');
  console.log('╠═══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Chat-ready providers:           ${totalReady.toString().padStart(3, ' ')} / ${records.length.toString().padEnd(3, ' ')}                          ║`);
  console.log(`║  Reclassified out of unknown:    ${(records.filter((r: { bucket: string }) => r.bucket === 'unknown').length - truelyUnknown).toString().padStart(3, ' ')}                                  ║`);
  console.log(`║  Still V_unknown_unclassified:   ${truelyUnknown.toString().padStart(3, ' ')}                                  ║`);
  console.log(`║  Reprobe candidates (G alias):   ${reprobeCandidates.length.toString().padStart(3, ' ')}                                  ║`);
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
}

main();
