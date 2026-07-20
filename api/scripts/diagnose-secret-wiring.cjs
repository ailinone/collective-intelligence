#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cross-reference PROVIDER_SECRETS candidates against actual GCP secret names.
 *
 * Reads the operator-supplied GCP secret-name list (GCP_SECRETS_LIST_FILE, default scripts/.gcp-secrets-list.txt) and
 * src/config/load-secrets-into-env.ts. For each tuple, reports:
 *   ✅ at least one candidate exists in GCP (tuple works as-is)
 *   ⚠️ tuple wired but no candidate matches a GCP secret (loader query 404s)
 *   ❌ no GCP secret exists for this envVar at all (operator must provision)
 */

const fs = require('node:fs');
const path = require('node:path');

const LOADER = path.join(__dirname, '..', 'src/config/load-secrets-into-env.ts');
// Operator-supplied inventory of GCP secret names (one per line); not shipped with the repo.
const GCP_LIST = process.env.GCP_SECRETS_LIST_FILE || path.join(__dirname, '.gcp-secrets-list.txt');
// Prefix used when naming secrets in GCP Secret Manager (e.g. "<prefix>-openai-api-key").
const GCP_SECRETS_PREFIX = (process.env.GCP_SECRETS_PREFIX || 'app') + '-';

const gcpSecrets = new Set(
  fs.readFileSync(GCP_LIST, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith(GCP_SECRETS_PREFIX) ? s.slice(GCP_SECRETS_PREFIX.length) : s))
);

const src = fs.readFileSync(LOADER, 'utf8');
const tupleRe = /\{\s*envVar:\s*'([A-Z_][A-Z0-9_]*)'\s*,\s*secretKeys:\s*\[([^\]]+)\]\s*\}/g;
const tuples = [];
let m;
while ((m = tupleRe.exec(src)) !== null) {
  const envVar = m[1];
  const candidates = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  tuples.push({ envVar, candidates });
}

const ok = [];
const wrongCandidates = [];
const noGcp = [];
const okButFirstCandidateMisses = [];
for (const t of tuples) {
  const matching = t.candidates.filter(c => gcpSecrets.has(c));
  if (matching.length > 0) {
    ok.push({ ...t, matching });
    if (!gcpSecrets.has(t.candidates[0])) {
      okButFirstCandidateMisses.push({ ...t, matching });
    }
  } else {
    const sameSlug = [...gcpSecrets].filter(s => {
      const slug = t.envVar.toLowerCase().replace(/_/g, '-').replace(/-api-key$|-key$|-token$|-pat$|-apikey$/, '');
      return s === slug || s === slug + '-key' || s === slug + '-api-key' || s === slug + '-token';
    });
    if (sameSlug.length > 0) wrongCandidates.push({ ...t, gcpHas: sameSlug });
    else noGcp.push(t);
  }
}

const allWiredCandidates = new Set(tuples.flatMap(t => t.candidates));
const orphanGcpSecrets = [...gcpSecrets].filter(s => !allWiredCandidates.has(s)).sort();

console.log('═══════════════════════════════════════════════════════════');
console.log(`PROVIDER_SECRETS tuples: ${tuples.length}`);
console.log(`GCP provider secrets:    ${gcpSecrets.size}`);
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`✅ WIRED CORRECTLY (${ok.length}) — at least one candidate matches a GCP secret`);
for (const t of ok) {
  const matchStr = t.matching.length === 1 ? t.matching[0] : `${t.matching[0]} (+ ${t.matching.length - 1} more)`;
  console.log(`   ${t.envVar.padEnd(36)} → ${GCP_SECRETS_PREFIX}${matchStr}`);
}

console.log(`\n⚠️  GCP HAS THE SECRET BUT WIRING MISSES (${wrongCandidates.length}) — adjust loader candidates`);
for (const t of wrongCandidates) {
  console.log(`   ${t.envVar}`);
  console.log(`     current candidates: ${t.candidates.map(c => `'${c}'`).join(', ')}`);
  console.log(`     GCP actually has:   ${t.gcpHas.map(s => `'${GCP_SECRETS_PREFIX}${s}'`).join(', ')}`);
}

console.log(`\n❌ NO GCP SECRET (${noGcp.length}) — operator must provision`);
for (const t of noGcp) {
  console.log(`   ${t.envVar.padEnd(36)} expects: ${t.candidates.map(c => `${GCP_SECRETS_PREFIX}${c}`).join(' OR ')}`);
}

console.log(`\n📋 ORPHAN GCP SECRETS (${orphanGcpSecrets.length}) — exist in GCP but no tuple references them`);
for (const s of orphanGcpSecrets) console.log(`   ${GCP_SECRETS_PREFIX}${s}`);

console.log(`\n🔄 OK BUT FIRST CANDIDATE MISSES (${okButFirstCandidateMisses.length}) — works, but loader makes wasted GCP calls before finding the right one`);
for (const t of okButFirstCandidateMisses) {
  console.log(`   ${t.envVar.padEnd(36)} first='${t.candidates[0]}' actual='${t.matching[0]}'`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Summary: ${ok.length} ok (${okButFirstCandidateMisses.length} suboptimal), ${wrongCandidates.length} need adjust, ${noGcp.length} missing in GCP, ${orphanGcpSecrets.length} orphan GCP`);
console.log('═══════════════════════════════════════════════════════════');
