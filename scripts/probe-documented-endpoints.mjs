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
 * Probes every endpoint documented in the guide's OpenAPI spec against production.
 * Categorizes results: 2xx, 401 (auth required), 403, 404 (missing), 5xx, network errors.
 *
 * Usage:
 *   node scripts/probe-documented-endpoints.mjs [--auth=API_KEY] [--out=path] [--base=https://api.ailin.one]
 */

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const SPEC_PATH = args.spec
  ? path.resolve(args.spec)
  : path.resolve('openapi-spec.json');
const BASE = args.base || 'https://api.ailin.one';
const AUTH = args.auth || process.env.AILIN_API_KEY || null;
const OUT = args.out || './probe-results.json';
const TIMEOUT_MS = Number(args.timeout || 15000);
const CONCURRENCY = Number(args.concurrency || 6);

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const paths = spec.paths || {};

const operations = [];
for (const p of Object.keys(paths)) {
  for (const method of Object.keys(paths[p])) {
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
    operations.push({
      method: method.toUpperCase(),
      path: p,
      tags: (paths[p][method].tags || []).join(','),
      summary: paths[p][method].summary || '',
      requestBody: paths[p][method].requestBody,
    });
  }
}

console.log(`Loaded ${operations.length} operations from ${SPEC_PATH}`);
console.log(`Probing against ${BASE} ${AUTH ? '(authenticated)' : '(unauthenticated)'}`);

// Replace path params with placeholders the API can parse
function substituteParams(p) {
  // {id} → "probe-id"; {file_id} → "probe-file"; etc.
  return p.replace(/\{([^}]+)\}/g, (_, name) => {
    if (/file_id|fileId/i.test(name)) return 'file-probe';
    if (/thread_id|threadId/i.test(name)) return 'thread-probe';
    if (/run_id|runId/i.test(name)) return 'run-probe';
    if (/assistant_id|assistantId/i.test(name)) return 'asst-probe';
    if (/key_id|keyId/i.test(name)) return 'key-probe';
    if (/org/i.test(name)) return 'org-probe';
    if (/user/i.test(name)) return 'user-probe';
    if (/vector/i.test(name)) return 'vs-probe';
    if (/batch/i.test(name)) return 'batch-probe';
    if (/job/i.test(name)) return 'job-probe';
    if (/cache/i.test(name)) return 'cache-probe';
    if (/model/i.test(name)) return 'gpt-4o-mini';
    return 'probe';
  });
}

// Endpoints that MUTATE auth state (would invalidate the test JWT) — skip during probe sweep.
const SKIP_PATHS = new Set([
  '/v1/auth/logout',
  '/v1/auth/refresh', // rotates the refresh token; we don't have one
]);

async function probe(op) {
  if (SKIP_PATHS.has(op.path)) {
    return { ...op, status: -1, ms: 0, snippet: 'SKIPPED (mutates auth state)' };
  }
  const url = `${BASE}${substituteParams(op.path)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH) {
    // ak_* keys go in x-api-key, JWTs go in Authorization
    if (AUTH.startsWith('ak_')) {
      headers['x-api-key'] = AUTH;
    } else {
      headers['Authorization'] = `Bearer ${AUTH}`;
    }
    if (process.env.AILIN_JWT) {
      headers['Authorization'] = `Bearer ${process.env.AILIN_JWT}`;
    }
  }

  // For mutating methods, send minimal body so handler doesn't 400 on JSON parse
  let body;
  if (['POST', 'PUT', 'PATCH'].includes(op.method)) {
    body = '{}';
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: op.method, headers, body, signal: ctrl.signal });
    clearTimeout(t);
    const dt = Date.now() - t0;
    let snippet = '';
    try {
      const text = await r.text();
      snippet = text.slice(0, 200);
    } catch {}
    return {
      ...op,
      status: r.status,
      ms: dt,
      snippet,
    };
  } catch (e) {
    clearTimeout(t);
    return { ...op, status: 0, ms: Date.now() - t0, error: e.message };
  }
}

async function runAll() {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < operations.length) {
      const idx = i++;
      const op = operations[idx];
      const r = await probe(op);
      results[idx] = r;
      const tag = r.status === 0 ? 'ERR' : String(r.status);
      process.stdout.write(`[${idx + 1}/${operations.length}] ${tag.padEnd(4)} ${op.method.padEnd(6)} ${op.path}\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

const results = await runAll();

// Aggregate
const byBucket = { '2xx': [], '3xx': [], '400': [], '401': [], '403': [], '404': [], '405': [], '422': [], '429': [], '5xx': [], 'ERR': [], 'SKIP': [], 'OTHER': [] };
for (const r of results) {
  let b = 'OTHER';
  if (r.status === -1) b = 'SKIP';
  else if (r.status === 0) b = 'ERR';
  else if (r.status >= 200 && r.status < 300) b = '2xx';
  else if (r.status >= 300 && r.status < 400) b = '3xx';
  else if (r.status === 400) b = '400';
  else if (r.status === 401) b = '401';
  else if (r.status === 403) b = '403';
  else if (r.status === 404) b = '404';
  else if (r.status === 405) b = '405';
  else if (r.status === 422) b = '422';
  else if (r.status === 429) b = '429';
  else if (r.status >= 500) b = '5xx';
  byBucket[b].push(r);
}

console.log('\n=== Summary ===');
for (const [b, items] of Object.entries(byBucket)) {
  if (items.length) console.log(`  ${b}: ${items.length}`);
}

fs.writeFileSync(OUT, JSON.stringify({ base: BASE, authenticated: !!AUTH, total: results.length, buckets: byBucket }, null, 2));
console.log(`\nWrote results to ${OUT}`);
