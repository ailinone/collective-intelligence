#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// CICD-4 dependency-vulnerability gate (production scope).
//
// Why not `pnpm audit`: the npm registry audit endpoint pnpm targets is retired
// (HTTP 410 "Use the bulk advisory endpoint instead"), so `pnpm audit` cannot
// run in CI. This script resolves the dependency set and queries the OSV.dev
// batch API (stable, public, no auth).
//
// Scope: PRODUCTION dependencies only. SEC-02 is about runtime deps; dev-only
// tooling (vitest, vite, ...) is intentionally excluded. Pass the tree via
// `--pnpm-list <file>` where <file> is the output of
//   pnpm --dir api list --prod --depth Infinity --json
// (preferred, exact prod closure). If omitted, falls back to scanning a raw
// pnpm-lock.yaml (prod+dev — noisier).
//
// Policy: FAIL on any non-allowlisted CRITICAL. HIGH advisories are reported
// loudly but do NOT block (several current prod highs are transitive
// WebSocket-DoS advisories with no fixed release yet); they are tracked for a
// dedicated remediation pass. MODERATE/LOW are ignored.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const pnpmListIdx = args.indexOf('--pnpm-list');
const PNPM_LIST = pnpmListIdx >= 0 ? args[pnpmListIdx + 1] : null;
const LOCKFILE = PNPM_LIST ? null : (args.find((a) => !a.startsWith('--')) || 'api/pnpm-lock.yaml');
const BLOCK_SEVERITIES = new Set(['CRITICAL']);
const REPORT_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

// Advisories accepted with a tracked remediation plan (applies to blocking only).
const ALLOWLIST = new Map([
  ['GHSA-rcmh-qjqh-p98v', 'nodemailer addressparser DoS (HIGH) — needs nodemailer 7.x major upgrade; tracked SEC-02 follow-up'],
  ['CVE-2025-14874', 'alias of GHSA-rcmh-qjqh-p98v (nodemailer)'],
]);

function collectFromPnpmList(json) {
  const set = new Map();
  const roots = Array.isArray(json) ? json : [json];
  const visit = (deps) => {
    for (const name of Object.keys(deps || {})) {
      const node = deps[name];
      if (!node || typeof node !== 'object') continue;
      if (node.version && /^\d/.test(node.version)) set.set(`${name}@${node.version}`, { name, version: node.version });
      visit(node.dependencies);
    }
  };
  for (const r of roots) {
    visit(r.dependencies);
    visit(r.devDependencies); // present only if --prod was NOT used; harmless otherwise
    visit(r.optionalDependencies);
  }
  return [...set.values()];
}

function collectFromLockfile(text) {
  const set = new Map();
  const re = /^\s+'?((?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d[^:'()\s]*)/i;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    if (m[2].includes('link:') || m[2].includes('file:')) continue;
    set.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] });
  }
  return [...set.values()];
}

async function fetchJson(url, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

function severityOf(vuln) {
  const ds = vuln.database_specific && vuln.database_specific.severity;
  if (typeof ds === 'string') return ds.toUpperCase();
  const vec = (vuln.severity || []).find((s) => /CVSS/.test(s.type));
  if (vec && typeof vec.score === 'string') {
    const m = /\/([0-9]+(?:\.[0-9]+)?)$/.exec(vec.score);
    const num = m ? parseFloat(m[1]) : NaN;
    if (!Number.isNaN(num)) return num >= 9 ? 'CRITICAL' : num >= 7 ? 'HIGH' : num >= 4 ? 'MODERATE' : 'LOW';
  }
  return 'UNKNOWN';
}

async function main() {
  let pkgs;
  if (PNPM_LIST) {
    pkgs = collectFromPnpmList(JSON.parse(readFileSync(PNPM_LIST, 'utf8')));
    console.log(`OSV scan (production scope): ${pkgs.length} packages from ${PNPM_LIST}`);
  } else {
    pkgs = collectFromLockfile(readFileSync(LOCKFILE, 'utf8'));
    console.log(`OSV scan (full lockfile): ${pkgs.length} packages from ${LOCKFILE}`);
  }
  if (pkgs.length === 0) {
    console.error('No packages parsed — refusing to pass a scan that inspected nothing.');
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < pkgs.length; i += 500) {
    const chunk = pkgs.slice(i, i + 500);
    const body = { queries: chunk.map((p) => ({ package: { ecosystem: 'npm', name: p.name }, version: p.version })) };
    const resp = await fetchJson('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    (resp.results || []).forEach((r, idx) => {
      for (const v of r.vulns || []) results.push({ pkg: chunk[idx], id: v.id });
    });
  }

  const byId = new Map();
  for (const r of results) {
    if (!byId.has(r.id)) byId.set(r.id, new Set());
    byId.get(r.id).add(`${r.pkg.name}@${r.pkg.version}`);
  }

  const blocking = [];
  const highs = [];
  for (const [id, pkgset] of byId) {
    const detail = await fetchJson(`https://api.osv.dev/v1/vulns/${id}`).catch(() => null);
    const sev = detail ? severityOf(detail) : 'UNKNOWN';
    if (!REPORT_SEVERITIES.has(sev)) continue;
    const aliases = new Set([id, ...((detail && detail.aliases) || [])]);
    const allowed = [...aliases].some((a) => ALLOWLIST.has(a));
    const row = { id, sev, pkgs: [...pkgset].join(', '), summary: (detail && detail.summary) || '', allowed };
    if (BLOCK_SEVERITIES.has(sev) && !allowed) blocking.push(row);
    else highs.push(row);
  }

  if (highs.length) {
    console.log(`\n⚠️  HIGH / accepted advisories in production deps (${highs.length}) — reported, NOT blocking:`);
    for (const r of highs) console.log(`  [${r.sev}]${r.allowed ? '(allowlisted)' : ''} ${r.id}  ${r.pkgs}\n      ${r.summary}`);
    console.log('  → Track these for a dedicated dependency-remediation pass.');
  }

  if (blocking.length) {
    console.error(`\n❌ ${blocking.length} unaccepted CRITICAL advisory(ies) in production deps:`);
    for (const r of blocking) console.error(`  [${r.sev}] ${r.id}  ${r.pkgs}\n      ${r.summary}\n      https://osv.dev/vulnerability/${r.id}`);
    console.error('\nRemediate via pnpm.overrides (api/package.json) or add a justified ALLOWLIST entry.');
    process.exit(1);
  }

  console.log(`\n✅ No unaccepted CRITICAL advisories in production dependencies.`);
}

main().catch((e) => {
  console.error('OSV scan failed to run (fail-closed):', e && e.message ? e.message : e);
  process.exit(1);
});
