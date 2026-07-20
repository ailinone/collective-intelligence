// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G3 — Offline Reclassifier.
 *
 * Reads the G2 audit JSON, re-runs every record's `lastSanitizedMessage`
 * through the NEW `classifyProviderError` (post-G3 patch) to surface the
 * effect of the quota / credit regex updates WITHOUT issuing any new
 * billable probes.
 *
 * Then feeds the post-classifier records through `applyG2Reclassification`
 * to produce a G3 distribution.
 *
 * Pure offline; zero network calls.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyProviderError } from '../../orchestration/failures/provider-error-classifier';
import { applyG2Reclassification, type GAuditRecordLike } from '../apply-g2-reclassification';
import {
  BUCKET_DESCRIPTIONS,
  type ProviderReadinessBucket,
} from '../provider-readiness-buckets';

interface AuditJson {
  summary?: unknown;
  providers: readonly GAuditRecordLike[];
}

function parseArgs(): { inPath: string; outPath?: string } {
  const argv = process.argv.slice(2);
  let inPath = './tmp/provider_adapter_readiness_01c1b_g2.json';
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') inPath = argv[++i] ?? inPath;
    else if (argv[i] === '--out') outPath = argv[++i];
  }
  return { inPath, outPath };
}

function reclassifyOne(rec: GAuditRecordLike): GAuditRecordLike {
  // Only re-classify rows where the audit's classification was inconclusive.
  // Skip rows already marked 'A_registered_and_chat_ready' or with a strong
  // pre-existing errorKind that the new patches don't refine.
  const kind = String(rec.errorKind ?? '').toLowerCase();
  const isRefinable = kind === 'unknown' || kind === 'bad_request' || kind === '';
  if (!isRefinable || !rec.lastSanitizedMessage) return rec;

  const reclass = classifyProviderError({
    status: rec.httpStatus,
    body: String(rec.lastSanitizedMessage),
  });

  // If the new classifier still says unknown, leave the record alone.
  if (reclass.kind === 'unknown') return rec;

  // Map errorKind → G-bucket name so downstream migrator picks it up.
  const newBucket = bucketForKind(reclass.kind, rec.bucket);
  return {
    ...rec,
    errorKind: reclass.kind,
    bucket: newBucket,
  };
}

function bucketForKind(kind: string, originalBucket: string): string {
  switch (kind) {
    case 'insufficient_credits':
      return 'C_registered_adapter_ready_blocked_by_credit';
    case 'consumer_suspended':
      return 'E_registered_adapter_ready_blocked_by_suspension';
    case 'invalid_auth':
      return 'D_registered_adapter_ready_blocked_by_auth';
    case 'rate_limited':
      return 'F_registered_adapter_ready_blocked_by_rate_limit';
    case 'model_not_supported':
      return 'H_registered_adapter_ready_model_not_supported';
    default:
      return originalBucket;
  }
}

function main(): void {
  const { inPath, outPath } = parseArgs();
  const raw = readFileSync(inPath, 'utf8');
  const lastBrace = raw.lastIndexOf('}');
  const audit = JSON.parse(raw.slice(0, lastBrace + 1)) as AuditJson;
  const records = audit.providers ?? [];

  // Step 1: offline reclassification with the NEW classifier.
  const reclassified = records.map(reclassifyOne);

  // Diff vs original:
  const reclassDiff: Array<{
    providerId: string;
    fromKind?: string;
    toKind?: string;
    fromBucket?: string;
    toBucket?: string;
  }> = [];
  for (let i = 0; i < records.length; i++) {
    const before = records[i];
    const after = reclassified[i];
    if (before.errorKind !== after.errorKind || before.bucket !== after.bucket) {
      reclassDiff.push({
        providerId: before.providerId,
        fromKind: before.errorKind,
        toKind: after.errorKind,
        fromBucket: before.bucket,
        toBucket: after.bucket,
      });
    }
  }

  // Step 2: apply G2 → G3 migrator with refined hints.
  // After G3, we KNOW:
  //   - perplexity / sambanova have catalog leakage (cross-provider model id in sampleModelId)
  //   - replicate is C_blocked_by_credit (handled by step 1)
  // So we narrow `catalogIdMismatched` to the two confirmed cases.
  const g3 = applyG2Reclassification({
    gAudit: reclassified,
    catalogIdMismatched: ['perplexity', 'sambanova'],
    requiresDeployment: [
      'azure-openai', 'aws-bedrock', 'vertex-ai', 'sap-ai-core',
      'aws-sagemaker', 'databricks', 'snowflake', 'watsonx',
    ],
  });

  // ── Report ──────────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║         01C.1B-G3 — Offline Reclassification Report               ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log(`Total providers: ${records.length}`);
  console.log(`Records reclassified by NEW classifier: ${reclassDiff.length}`);

  if (reclassDiff.length > 0) {
    console.log('\n── Classifier-level reclassifications (G3 patch effect) ──────────');
    for (const d of reclassDiff) {
      console.log(`  ${d.providerId.padEnd(20)}  errorKind: ${d.fromKind ?? '-'} → ${d.toKind ?? '-'}`);
      console.log(`  ${''.padEnd(20)}  bucket:    ${d.fromBucket ?? '-'} → ${d.toBucket ?? '-'}`);
    }
  }

  console.log('\n── G3 distribution ───────────────────────────────────────────────');
  const afterPairs = Object.entries(g3.distributionAfter).sort((a, b) => b[1] - a[1]);
  for (const [bucket, count] of afterPairs) {
    const desc = BUCKET_DESCRIPTIONS[bucket as ProviderReadinessBucket] ?? '';
    console.log(`  ${String(count).padStart(3)}  ${bucket.padEnd(45)}  ${desc}`);
  }

  console.log('\n── Providers per actionable bucket ───────────────────────────────');
  const actionable: ProviderReadinessBucket[] = [
    'A_chat_ready',
    'C_blocked_by_credit',
    'D_blocked_by_auth_confirmed',
    'G_model_alias_mismatch_probable',
    'H_model_not_supported_confirmed',
    'N_specialized_non_chat_provider',
    'O_no_catalog_model_bound_to_provider',
    'P_provider_id_catalog_mismatch',
    'S_provider_requires_deployment_or_endpoint',
    'V_unknown_unclassified',
  ];
  for (const bucket of actionable) {
    const list = g3.records.filter((r) => r.bucketG2 === bucket);
    if (list.length === 0) continue;
    console.log(`\n  ${bucket}  (${list.length})`);
    for (const r of list) console.log(`    - ${r.providerId}`);
  }

  // ── Acceptance gates ──────────────────────────────────────────────
  const a = g3.records.filter((r) => r.bucketG2 === 'A_chat_ready').length;
  const k = g3.records.filter((r) => r.bucketG2 === 'K_local_ollama_ready').length;
  const v = g3.records.filter((r) => r.bucketG2 === 'V_unknown_unclassified').length;
  const vPercent = (v / records.length) * 100;
  const openaiBucket = g3.records.find((r) => r.providerId === 'openai')?.bucketG2 ?? '?';
  const replicateBucket = g3.records.find((r) => r.providerId === 'replicate')?.bucketG2 ?? '?';
  const perplexityBucket = g3.records.find((r) => r.providerId === 'perplexity')?.bucketG2 ?? '?';
  const sambanovaBucket = g3.records.find((r) => r.providerId === 'sambanova')?.bucketG2 ?? '?';

  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║                       GATE STATUS                                 ║');
  console.log('╠═══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Chat-ready (A + K):              ${String(a + k).padStart(3)} / ${String(records.length).padEnd(3)}                          ║`);
  console.log(`║  V_unknown_unclassified:          ${String(v).padStart(3)} (${vPercent.toFixed(1)}%)                          ║`);
  console.log(`║  openai bucket:                   ${openaiBucket.padEnd(35)}║`);
  console.log(`║  replicate bucket:                ${replicateBucket.padEnd(35)}║`);
  console.log(`║  perplexity bucket:               ${perplexityBucket.padEnd(35)}║`);
  console.log(`║  sambanova bucket:                ${sambanovaBucket.padEnd(35)}║`);
  console.log('╚═══════════════════════════════════════════════════════════════════╝');

  // Pass/fail per G3 spec §20.
  const gates = [
    { name: 'openai NOT in V_unknown', pass: openaiBucket !== 'V_unknown_unclassified' },
    { name: 'replicate NOT in P (now C)', pass: replicateBucket !== 'P_provider_id_catalog_mismatch' },
    { name: 'perplexity in P (real)', pass: perplexityBucket === 'P_provider_id_catalog_mismatch' },
    { name: 'sambanova in P (real)', pass: sambanovaBucket === 'P_provider_id_catalog_mismatch' },
    { name: 'V_unknown < 5% of total', pass: vPercent < 5 },
  ];
  console.log('\n── Spec §20 gates ────────────────────────────────────────────────');
  for (const g of gates) {
    console.log(`  [${g.pass ? '✓' : '✗'}]  ${g.name}`);
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({
      ...g3,
      reclassDiff,
    }, null, 2));
    console.log(`\n✓ Wrote G3 to ${outPath}`);
  }
}

main();
