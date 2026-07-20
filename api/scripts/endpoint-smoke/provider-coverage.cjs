// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Coverage Test
 *
 * Picks one chat-capable model per operational execution provider and hits
 * /v1/chat/completions. Goal: prove that the fallback chain reaches multiple
 * backends (not just OpenAI), and quantify which providers actually respond
 * with content under the current key set.
 *
 * Categorizes:
 *   200 + content                → SUCCESS (provider key + cota OK)
 *   200 + empty content          → DEGRADED (responded but no output)
 *   500 with provider error msg  → KEY/QUOTA (real upstream rejection)
 *   500 generic                  → ROUTING (unclear path)
 *   timeout                      → SLOW (provider overloaded or queueing)
 *   400                          → CONFIG (model id rejected by upstream)
 *
 * Output is a per-provider table so operator can see at a glance:
 *   "which providers do I have working credentials for?"
 */

const http = require('http');
const fs = require('fs');
const jwt = require('/app/node_modules/jsonwebtoken');

function token() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { userId: '22222222-2222-2222-2222-222222222222', organizationId: '11111111-1111-1111-1111-111111111111', email: 's@x', roles: ['owner','admin'], token_use: 'access', nbf: now, jti: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '5m', algorithm: 'HS256', issuer: 'ci-api', audience: 'ci-api', subject: '22222222-2222-2222-2222-222222222222' },
  );
}

function request(method, path, body, tk, timeout = 45000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : undefined;
    const t0 = Date.now();
    const req = http.request(
      { method, hostname: 'localhost', port: 3000, path, timeout, headers: { Authorization: `Bearer ${tk}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(b), durMs: Date.now() - t0 }); }
          catch { resolve({ status: res.statusCode, body: b, durMs: Date.now() - t0 }); }
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, durMs: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT', durMs: Date.now() - t0 }); });
    if (data) req.write(data);
    req.end();
  });
}

function classify(r) {
  if (r.error === 'TIMEOUT') return 'TIMEOUT';
  if (r.status === 0) return 'NETWORK_ERR';
  if (r.status === 200) {
    const text = r.body?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.length > 0) return 'SUCCESS';
    return 'DEGRADED_EMPTY';
  }
  if (r.status === 400) return 'BAD_REQUEST';
  if (r.status === 401 || r.status === 403) return 'AUTH';
  if (r.status === 429) return 'RATE_LIMITED';
  if (r.status >= 500) {
    const msg = r.body?.error?.message ?? '';
    if (/quota|rate|insufficient|credit|balance/i.test(msg)) return 'QUOTA_EXHAUSTED';
    if (/key|auth|unauthorized/i.test(msg)) return 'KEY_INVALID';
    if (/not supported|model_not_supported|not found/i.test(msg)) return 'MODEL_UNAVAILABLE';
    return 'PROVIDER_5XX';
  }
  return 'OTHER_4XX';
}

function shortMessage(r) {
  if (r.error) return r.error;
  if (r.status === 200) {
    const c = r.body?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? `"${c.slice(0,40).replace(/\n/g,' ')}"` : '<no content>';
  }
  return (r.body?.error?.message ?? JSON.stringify(r.body)).slice(0, 100);
}

async function main() {
  const tk = token();

  // 1. Get the catalog and pick one chat-capable model per provider.
  console.log('Fetching catalog...');
  const cat = await request('GET', '/v1/models?scope=runnable', null, tk, 90000);
  if (cat.status !== 200) {
    console.error('Failed to fetch catalog:', cat.status, cat.body);
    process.exit(1);
  }
  const models = cat.body.data || [];
  console.log(`Catalog: ${models.length} runnable models, sampling per execution provider...\n`);

  // Group by provider, pick the FIRST chat-capable model. We bias toward
  // small/cheap models when name hints suggest one (haiku, mini, small,
  // turbo, flash, 8b, 3b, 1.5b) so we don't burn cota on the big ones.
  const provToModel = new Map();
  const SMALL_HINTS = /haiku|mini|small|turbo|flash|nano|8b|7b|3b|1\.5b|0\.5b|tiny|micro/i;
  for (const m of models) {
    const provider = m.provider;
    if (!provider) continue;
    const caps = m.capabilities ?? [];
    const isChat = caps.includes('chat') || caps.includes('text_generation') || caps.includes('completion');
    if (!isChat) continue;
    const cur = provToModel.get(provider);
    if (!cur) { provToModel.set(provider, m); continue; }
    // Prefer smaller models if available
    if (!SMALL_HINTS.test(cur.id) && SMALL_HINTS.test(m.id)) {
      provToModel.set(provider, m);
    }
  }

  console.log(`Probing ${provToModel.size} providers (one chat call each)...\n`);

  // 2. Probe each provider. Use a tiny prompt + max_tokens=8.
  const results = [];
  const concurrency = 3;
  const queue = [...provToModel.entries()];
  async function worker() {
    while (queue.length > 0) {
      const [provider, model] = queue.shift();
      const r = await request('POST', '/v1/chat/completions', {
        model: model.id,
        messages: [{ role: 'user', content: 'Reply ONLY: pong' }],
        max_tokens: 8,
        temperature: 0,
      }, tk, 45000);
      const cat = classify(r);
      results.push({ provider, modelId: model.id, status: r.status, durMs: r.durMs, category: cat, summary: shortMessage(r) });
      const marker = cat === 'SUCCESS' ? '✓' : cat === 'TIMEOUT' ? '⏱' : '✗';
      console.log(`  ${marker} ${provider.padEnd(22)} ${model.id.padEnd(50).slice(0,50)} [${r.status}] ${cat.padEnd(20)} ${(r.durMs+'ms').padStart(7)} ${shortMessage(r).slice(0,80)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 3. Summary
  const buckets = {};
  for (const r of results) buckets[r.category] = (buckets[r.category] || 0) + 1;

  console.log('\n=== SUMMARY ===');
  console.log('Total providers probed:', results.length);
  for (const [c, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + c.padEnd(22) + n);
  }

  const success = results.filter((r) => r.category === 'SUCCESS');
  console.log('\n=== PROVIDERS THAT RESPONDED 200 + CONTENT ===');
  success.forEach((r) => console.log(`  ✓ ${r.provider.padEnd(22)} ${r.modelId.padEnd(50).slice(0,50)} ${r.summary}`));

  const broken = results.filter((r) => r.category === 'PROVIDER_5XX');
  if (broken.length > 0) {
    console.log('\n=== INTERNAL 5XX (NOT QUOTA) ===');
    broken.forEach((r) => console.log(`  ✗ ${r.provider}: ${r.summary}`));
  }

  fs.writeFileSync('/tmp/provider-coverage.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    totalProbed: results.length,
    buckets,
    successList: success.map((r) => ({ provider: r.provider, modelId: r.modelId })),
    results,
  }, null, 2));
  console.log('\nFull report at /tmp/provider-coverage.json');
}

main();
