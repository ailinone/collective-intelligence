// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Coverage extension for endpoints NOT in /v1/.
 *
 * Health probes, /metrics, /admin/* (without /v1/ prefix), /documentation —
 * all proven alive but not iterable from the OpenAPI spec, so smoke-all.cjs
 * misses them. Also exercises the multimedia /v1/ endpoints (images, audio,
 * video, files, embeddings, moderations) explicitly with bodies that exercise
 * the input-validation paths.
 */

const http = require('http');
const fs = require('fs');
const jwt = require('/app/node_modules/jsonwebtoken');

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function token() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { userId: USER_ID, organizationId: ORG_ID, email: 'smoke@x', roles: ['owner','admin'], token_use: 'access', nbf: now, jti: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '5m', algorithm: 'HS256', issuer: 'ci-api', audience: 'ci-api', subject: USER_ID },
  );
}

function request(method, path, body, tk) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        method,
        hostname: 'localhost',
        port: 3000,
        path,
        headers: {
          ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          Accept: 'application/json',
        },
        timeout: 8000,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c.toString('utf8').slice(0, 200)));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks.slice(0, 200) }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT' }); });
    if (data) req.write(data);
    req.end();
  });
}

function categorize(r) {
  if (r.error === 'TIMEOUT') return 'TIMEOUT';
  if (r.status === 0) return 'UNREACHABLE';
  if (r.status >= 500) return 'BROKEN_5XX';
  if (r.status >= 200 && r.status < 400) return 'ALIVE_OK';
  return 'ALIVE_4XX';
}

async function main() {
  const tk = token();

  // Layer 1: non-/v1/ infrastructure endpoints (no auth needed for most)
  const infraEndpoints = [
    ['GET', '/health', null, null],          // public
    ['GET', '/health/live', null, null],     // public
    ['GET', '/health/ready', null, null],    // public
    ['GET', '/health/startup', null, null],  // public
    ['GET', '/metrics', null, null],         // public (Prometheus scrape)
    ['GET', '/metrics/prompts', null, tk],   // may be auth-gated
    ['GET', '/documentation', null, null],   // Swagger UI HTML
    ['GET', '/admin/queues/dlq', null, tk],
    ['GET', '/admin/sharding/health', null, tk],
    ['GET', '/admin/sharding/statistics', null, tk],
    ['POST', '/admin/sharding/balance', {}, tk],
    ['GET', '/openapi.yaml', null, null],    // spec served as YAML
    ['GET', '/openapi.json', null, null],    // spec served as JSON
  ];

  // Layer 2: multimedia / specialty endpoints (in /v1/, in spec — but with realistic bodies)
  const multimediaEndpoints = [
    ['POST', '/v1/images/generations', { prompt: 'a sunset', model: 'fake-model', n: 1 }, tk],
    ['POST', '/v1/images/edits', { prompt: 'add a tree', model: 'fake-model' }, tk],
    ['POST', '/v1/images/variations', { model: 'fake-model' }, tk],
    ['POST', '/v1/videos/generations', { prompt: 'a dog running', model: 'fake-model' }, tk],
    ['POST', '/v1/audio/speech', { input: 'hello', model: 'fake-tts', voice: 'alloy' }, tk],
    ['POST', '/v1/audio/transcriptions', { model: 'fake-stt' }, tk],
    ['POST', '/v1/audio/translations', { model: 'fake-stt' }, tk],
    ['GET',  '/v1/files', null, tk],
    ['POST', '/v1/files', { purpose: 'assistants' }, tk],
    ['POST', '/v1/embeddings', { input: 'hello', model: 'fake-embedder' }, tk],
    ['POST', '/v1/embeddings/create', { input: 'hello', model: 'fake-embedder' }, tk],
    ['POST', '/v1/moderations', { input: 'hello' }, tk],
    ['POST', '/v1/translation/text', { text: 'hello', target: 'es' }, tk],
    ['GET',  '/v1/translation/languages', null, tk],
    ['POST', '/v1/grounding/extract', { url: 'https://example.com' }, tk],
    ['POST', '/v1/pdf/analyze', { url: 'https://example.com/x.pdf' }, tk],
    ['POST', '/v1/code/execute', { code: 'print(1)', language: 'python' }, tk],
    ['POST', '/v1/search', { query: 'hello' }, tk],
    ['POST', '/v1/responses', { model: 'fake', input: 'hi' }, tk],
    ['GET',  '/v1/responses', null, tk],
  ];

  // Layer 3: chat completions (the core endpoint)
  const chatEndpoints = [
    ['POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }, tk],
    ['GET', '/v1/models', null, tk],
    ['GET', '/v1/models/auto', null, tk],
  ];

  const all = [
    { name: 'Infrastructure (non-/v1/)', items: infraEndpoints },
    { name: 'Multimedia + specialty', items: multimediaEndpoints },
    { name: 'Chat + models', items: chatEndpoints },
  ];

  const results = { ALIVE_OK: [], ALIVE_4XX: [], BROKEN_5XX: [], TIMEOUT: [], UNREACHABLE: [] };

  for (const layer of all) {
    console.log(`\n=== ${layer.name} ===`);
    for (const [method, path, body, tkUsed] of layer.items) {
      const r = await request(method, path, body, tkUsed);
      const cat = categorize(r);
      results[cat].push({ method, path, status: r.status, ...(r.error ? { error: r.error } : {}) });
      const marker = cat === 'BROKEN_5XX' ? '✗' : cat === 'ALIVE_OK' || cat === 'ALIVE_4XX' ? '✓' : '⚠';
      console.log(`  ${marker} ${method.padEnd(6)} ${path.padEnd(45)} ${r.status || r.error}`);
    }
  }

  const total = Object.values(results).reduce((s, a) => s + a.length, 0);
  const alive = results.ALIVE_OK.length + results.ALIVE_4XX.length;
  const broken = results.BROKEN_5XX.length + results.TIMEOUT.length + results.UNREACHABLE.length;

  console.log('\n=== SUMMARY ===');
  for (const [cat, items] of Object.entries(results)) {
    console.log(`${cat.padEnd(14)} ${items.length}`);
  }
  console.log(`\nAlive:   ${alive}/${total}  (${((alive / total) * 100).toFixed(1)}%)`);
  console.log(`Broken:  ${broken}/${total}`);

  if (results.BROKEN_5XX.length > 0) {
    console.log('\n=== BROKEN (5xx) ===');
    for (const r of results.BROKEN_5XX) console.log(`  [${r.status}] ${r.method} ${r.path}`);
  }
  if (results.UNREACHABLE.length > 0) {
    console.log('\n=== UNREACHABLE ===');
    for (const r of results.UNREACHABLE) console.log(`  ${r.method} ${r.path}  (${r.error})`);
  }

  fs.writeFileSync('/tmp/extra-smoke-results.json', JSON.stringify(results, null, 2));
  process.exit(broken > 0 ? 1 : 0);
}

main();
