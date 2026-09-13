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
 * catalog provider and reports what actually changed — replacing the stale
 * `docs/provider-runtime-matrix.csv` snapshot with a freshly measured one.
 *
 * ── Why this is NOT a single green/red (rewritten 2026-09-04, LOTE AK) ────
 *
 * The original version collapsed every provider to one traffic light derived
 * from a single question: "did /models return ≥1 model?". That conflates at
 * least five independent failure modes, and gets two of them backwards:
 *
 *   - An `execution-only` catalog row has NO /models endpoint BY DESIGN
 *     (azure-openai, aws-bedrock, voyage, and every row declaring
 *     `discoveryStatus: 'unavailable-upstream'`). Scoring it on discovery
 *     manufactured a permanent red for a provider that may be perfectly
 *     healthy — and buried real reds in the noise.
 *   - A provider whose discovery answers fine can still be unusable: expired
 *     key, zero balance, quota exhausted, or 5xx on the execution path.
 *     "/models returned something" said green to all four.
 *
 * So each provider is now scored on five INDEPENDENT dimensions, each with
 * its own `not-applicable` state, and the roll-up verdict is derived from
 * them rather than replacing them:
 *
 *   discovery    can we enumerate this provider's inventory?
 *   credential   does the key authenticate?
 *   billing      is there balance/quota to actually spend?
 *   upstream     is the vendor reachable and not rate-limiting us?
 *   execution    has a real call to this provider succeeded recently?
 *
 * The first four come from the discovery snapshot's ProviderErrorClass
 * taxonomy (auth_failed / insufficient_credit / quota_exceeded /
 * rate_limited / provider_5xx / provider_timeout / endpoint_not_found ...),
 * which the control plane already computes. The fifth comes from the
 * ProviderHealthRegistry, which records per-(provider,model) execution
 * outcomes. No new probing system is introduced — this reads what the
 * operability plane already measures.
 *
 * Fetch-only, no project imports — runs against a DEPLOYED ci-api exactly
 * like an operator would (the API process holds the keys; this driver only
 * triggers the probe and reads results).
 *
 * Flow: POST /discover-now (force a live probe) → GET /discovery + GET
 * /health (read results) → diff vs the committed CSV snapshot → write report.
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
import { pathToFileURL } from 'node:url';
import { classifyProvider, csvStatus } from './revalidate-providers-classify.mjs';

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

// ─── Dimension classification ───────────────────────
//
// The scoring logic lives in a sibling module so it can be unit-tested
// without importing this shebang-bearing driver (see that file for why the
// shebang matters on a Windows checkout), and so this file stays what it is:
// fetch, diff, report.

/** Load the committed snapshot for the before/after diff. */
export function loadSnapshot(cwd = process.cwd()) {
  const csv = join(cwd, 'docs', 'provider-runtime-matrix.csv');
  if (!existsSync(csv)) return {};
  const lines = readFileSync(csv, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const pid = head.indexOf('providerId');
  const st = head.indexOf('status');
  const mode = head.indexOf('integrationMode');
  const out = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    if (cols[pid]) {
      out[cols[pid]] = { status: cols[st] || 'unknown', integrationMode: cols[mode] || '' };
    }
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

  // Execution evidence is a SEPARATE read: the health registry knows whether
  // real calls have succeeded, which discovery cannot tell us.
  log('Reading execution health records (GET /health) ...');
  let healthByProvider = new Map();
  try {
    const health = await api('GET', '/v1/admin/operability/health');
    for (const r of health.records ?? []) {
      if (!healthByProvider.has(r.providerId)) healthByProvider.set(r.providerId, []);
      healthByProvider.get(r.providerId).push(r);
    }
    log(`  health registry: ${health.totalRecords ?? 0} records over ${healthByProvider.size} providers`);
  } catch (e) {
    log(`  health read failed (execution dimension stays "unknown"): ${e.message}`);
  }

  const before = loadSnapshot();
  const rows = results.map((r) => {
    const snap = before[r.providerId] ?? { status: 'unknown', integrationMode: '' };
    const dims = classifyProvider(r, healthByProvider.get(r.providerId) ?? [], snap.integrationMode);
    const now = csvStatus(dims);
    return {
      providerId: r.providerId,
      before: snap.status,
      after: now,
      integrationMode: snap.integrationMode,
      modelCount: r.modelCount ?? 0,
      healthState: r.healthState,
      reason: r.reason,
      errorClass: r.errorClass,
      probeLatencyMs: r.probeLatencyMs,
      dimensions: dims,
      verdict: dims.verdict,
      flipped: snap.status !== now,
    };
  }).sort((a, b) => a.providerId.localeCompare(b.providerId));

  const gained = rows.filter((r) => r.before !== 'green' && r.after === 'green');
  const lost = rows.filter((r) => r.before === 'green' && r.after !== 'green');
  const byVerdict = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const blocked = (v) => rows.filter((r) => r.verdict === v);

  // ── Write artifacts ───────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `provider-revalidation-${ts}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary: {
          total: rows.length,
          byVerdict,
          gained: gained.length,
          lost: lost.length,
        },
        rows,
      },
      null,
      2
    )
  );

  const dimTable = (verdict, blurb) => {
    const list = blocked(verdict);
    return [
      `## ${verdict} (${list.length}) — ${blurb}`,
      list.length
        ? '| Provider | modo | errorClass | reason |\n|---|---|---|---|\n' +
          list
            .map(
              (r) =>
                `| ${r.providerId} | ${r.integrationMode || '?'} | ${r.errorClass || ''} | ${(r.reason || '').slice(0, 60)} |`
            )
            .join('\n')
        : '_(nenhum)_',
      ``,
    ].join('\n');
  };

  const md = [
    `# Provider Re-Validation — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    ``,
    `Live probe of ${rows.length} providers. Cada provider é pontuado em CINCO dimensões independentes`,
    `(discovery, credential, billing, upstream, execution) — "\`/models\` respondeu" NÃO é, sozinho, sinal de verde.`,
    `Linhas \`execution-only\` não têm endpoint de listagem por design: a dimensão discovery é \`not-applicable\` nelas.`,
    ``,
    `| Veredito | Providers |`,
    `|---|---|`,
    ...Object.entries(byVerdict)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `| ${v} | **${n}** |`),
    ``,
    `Recém-green: **${gained.length}** · Regressões: ${lost.length}`,
    ``,
    dimTable('unusable-credential-missing', 'nenhuma chave provisionada — criar o secret'),
    dimTable('unusable-credential', 'chave inválida/expirada — rotacionar'),
    dimTable('unusable-billing', 'saldo ou cota esgotados — recarregar'),
    dimTable('unusable-upstream', 'vendor 5xx/timeout — nada a fazer do nosso lado'),
    dimTable('unusable-discovery', 'endpoint de listagem falhou/sumiu'),
    dimTable('unusable-execution', 'chamadas reais falhando apesar da descoberta'),
    dimTable('degraded-rate-limited', 'vendor limitando taxa — recuar, não rotacionar chave'),
    dimTable('degraded-no-inventory', 'respondeu mas com zero modelos'),
    dimTable('unproven', 'sem evidência suficiente ainda (execution-only sem chamada real)'),
    lost.length
      ? `\n## ⚠️ Regressões (${lost.length})\n` +
        lost.map((r) => `- ${r.providerId}: ${r.before}→${r.after} (${r.verdict}${r.reason ? `: ${r.reason}` : ''})`).join('\n')
      : '',
    ``,
  ].join('\n');
  const mdFile = join(outDir, `provider-revalidation-${ts}.md`);
  writeFileSync(mdFile, md);

  // ── Console summary ───────────────────────────────────────────────────────
  log('─────────────────────────────────────────────');
  log(
    Object.entries(byVerdict)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v}: ${n}`)
      .join(' | ')
  );
  log(`recém-green: ${gained.length} | regressões: ${lost.length}`);
  const focus = ONLY.length ? gained.filter((r) => ONLY.includes(r.providerId)) : gained;
  for (const r of focus.slice(0, 40)) log(`  ✅ ${r.providerId}: ${r.before}→${r.after} (${r.modelCount} modelos)`);
  log(`Relatório: ${mdFile}`);
  log('─────────────────────────────────────────────');
}

// Only run when invoked directly — the classifier above is imported by
// `revalidate-providers-classification.test.ts`, and importing must not
// trigger a live probe.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
