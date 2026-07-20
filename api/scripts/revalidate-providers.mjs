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
 * Provider Live Re-Validation (audit follow-up, 2026-06-15).
 *
 * After provisioning/recharging provider API keys, this re-probes EVERY
 * catalog provider against its live discovery endpoint and reports which
 * flipped red→green — replacing the stale `docs/provider-runtime-matrix.csv`
 * snapshot with a freshly measured one. It does NOT fake status: green here
 * means the provider's /models actually responded with ≥1 model under the
 * current keys.
 *
 * Fetch-only, no project imports — runs against a DEPLOYED ci-api exactly
 * like an operator would (the API process holds the keys; this driver only
 * triggers the probe and reads results).
 *
 * Flow: POST /discover-now (force a live probe) → GET /discovery (read
 * per-provider results) → diff vs the committed CSV snapshot → write report.
 *
 * Required env:
 *   API_BASE     internal target only, e.g. http://ci-api:3000 or
 *                http://localhost:3000 (no trailing slash). This calls
 *                /v1/admin/operability/*, which is not part of the public
 *                contract — never point this at the public hostname.
 *   ADMIN_TOKEN  bearer for an admin/owner key
 * Optional:
 *   SETTLE_MS=8000   wait after discover-now before reading results
 *   ONLY=            comma list of providerIds to focus the diff print
 *
 * Exit 0 always (reporting tool); writes reports/provider-revalidation-<ts>.{json,md}.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API_BASE = (process.env.API_BASE || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

function log(m) { console.log(`[revalidate] ${m}`); }
function die(m) { console.error(`\n✖ ${m}\n`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Map a live discovery result to the matrix status vocabulary. */
function liveStatus(r) {
  if (r.status === 'available' && (r.modelCount ?? 0) > 0) return 'green';
  if (r.status === 'available') return 'amber';        // responded but 0 models (discovery/materialization)
  return 'red';                                        // unavailable / error
}

/** Load the committed snapshot for the before/after diff. */
function loadSnapshot() {
  const csv = join(process.cwd(), 'docs', 'provider-runtime-matrix.csv');
  if (!existsSync(csv)) return {};
  const lines = readFileSync(csv, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const pid = head.indexOf('providerId'), st = head.indexOf('status');
  const out = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    if (cols[pid]) out[cols[pid]] = cols[st] || 'unknown';
  }
  return out;
}

async function main() {
  if (!API_BASE) die('API_BASE is required.');
  if (!ADMIN_TOKEN) die('ADMIN_TOKEN is required.');
  log(`Target: ${API_BASE}`);

  log('Forcing a live discovery probe (POST /discover-now) ...');
  try { await api('POST', '/v1/admin/operability/discover-now'); }
  catch (e) { log(`discover-now returned non-2xx (continuing to read current snapshot): ${e.message}`); }
  log(`Waiting ${SETTLE_MS}ms for discovery to settle ...`);
  await sleep(SETTLE_MS);

  log('Reading per-provider discovery results (GET /discovery) ...');
  const disc = await api('GET', '/v1/admin/operability/discovery');
  const results = Array.isArray(disc.results) ? disc.results : [];
  if (results.length === 0) die('Discovery returned no results — is the scheduler enabled and providers loaded?');

  const before = loadSnapshot();
  const rows = results.map((r) => {
    const now = liveStatus(r);
    const prev = before[r.providerId] ?? 'unknown';
    return {
      providerId: r.providerId,
      before: prev,
      after: now,
      modelCount: r.modelCount ?? 0,
      healthState: r.healthState,
      reason: r.reason,
      errorClass: r.errorClass,
      flipped: prev !== now,
    };
  }).sort((a, b) => a.providerId.localeCompare(b.providerId));

  const gained = rows.filter((r) => r.before !== 'green' && r.after === 'green');
  const lost = rows.filter((r) => r.before === 'green' && r.after !== 'green');
  const stillRed = rows.filter((r) => r.after === 'red');
  const greenNow = rows.filter((r) => r.after === 'green');

  // ── Write artifacts ───────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `provider-revalidation-${ts}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), summary: { total: rows.length, green: greenNow.length, gained: gained.length, lost: lost.length, stillRed: stillRed.length }, rows }, null, 2));

  const md = [
    `# Provider Re-Validation — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    ``,
    `Live probe of ${rows.length} providers via \`/v1/admin/operability/discovery\`. Status measured, not assumed: **green** = /models returned ≥1 model under current keys.`,
    ``,
    `| Métrica | Valor |`,
    `|---|---|`,
    `| Green agora | **${greenNow.length}** / ${rows.length} |`,
    `| Recém-green (red/amber→green) | **${gained.length}** |`,
    `| Regrediram (green→red/amber) | ${lost.length} |`,
    `| Ainda red | ${stillRed.length} |`,
    ``,
    `## ✅ Recém-green (${gained.length})`,
    gained.length ? '| Provider | antes | depois | modelos |\n|---|---|---|---|\n' + gained.map((r) => `| ${r.providerId} | ${r.before} | ${r.after} | ${r.modelCount} |`).join('\n') : '_(nenhum)_',
    ``,
    `## ❌ Ainda red (${stillRed.length}) — chave/saldo/infra pendente`,
    stillRed.length ? '| Provider | reason | errorClass |\n|---|---|---|\n' + stillRed.map((r) => `| ${r.providerId} | ${(r.reason || '').slice(0, 50)} | ${r.errorClass || ''} |`).join('\n') : '_(nenhum)_',
    lost.length ? `\n## ⚠️ Regressões (${lost.length})\n` + lost.map((r) => `- ${r.providerId}: ${r.before}→${r.after} (${r.reason || ''})`).join('\n') : '',
    ``,
  ].join('\n');
  const mdFile = join(outDir, `provider-revalidation-${ts}.md`);
  writeFileSync(mdFile, md);

  // ── Console summary ───────────────────────────────────────────────────────
  log('─────────────────────────────────────────────');
  log(`green: ${greenNow.length}/${rows.length} | recém-green: ${gained.length} | ainda red: ${stillRed.length} | regressões: ${lost.length}`);
  const focus = ONLY.length ? gained.filter((r) => ONLY.includes(r.providerId)) : gained;
  for (const r of focus.slice(0, 40)) log(`  ✅ ${r.providerId}: ${r.before}→${r.after} (${r.modelCount} modelos)`);
  if (stillRed.length) log(`  … ${stillRed.length} ainda red — ver ${mdFile}`);
  log(`Relatório: ${mdFile}`);
  log('─────────────────────────────────────────────');
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
