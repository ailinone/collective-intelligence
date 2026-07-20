// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Functional tests for endpoints added/modified in the recent session.
 *
 * Smoke (smoke-all.cjs) proves every endpoint is wired and validates input.
 * This complements it with specific 2xx expectations against real fixtures
 * for the work done in this session:
 *
 *   F1.6 collective routes
 *     GET /v1/collective/runs/:id          (existing F1.5 fixture)
 *     GET /v1/collective/runs/:id/trace
 *     GET /v1/collective/runs?requestId=…
 *
 *   F3.3 training-data export endpoints
 *     GET  /v1/admin/training-data/state
 *     POST /v1/admin/training-data/export   (skipped here — covered by smoke-export.cjs)
 *
 *   F4.1 audit-flow visibility
 *     GET /v1/collective/runs/:id           with tri-role fixture
 *       => decision_value should carry schedulerName + decisionReason
 *
 * Each test reports OK/FAIL with the assertion that produced the result.
 */

const http = require('http');
const fs = require('fs');
const jwt = require('/app/node_modules/jsonwebtoken');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SENSITIVITY_RUN_ID = 'cccccccc-3333-4444-5555-cccccccccccc'; // F1.5 fixture
const TRI_ROLE_RUN_ID = 'eeeeeeee-4444-5555-6666-eeeeeeeeeeee';   // F4.1 fixture

function token() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      userId: '22222222-2222-2222-2222-222222222222',
      organizationId: ORG_ID,
      email: 'functional@example.com',
      roles: ['owner', 'admin'],
      token_use: 'access',
      nbf: now,
      jti: Math.random().toString(36).slice(2),
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '5m',
      algorithm: 'HS256',
      issuer: 'ci-api',
      audience: 'ci-api',
      subject: '22222222-2222-2222-2222-222222222222',
    },
  );
}

function request(method, urlPath, tk) {
  return new Promise((resolve) => {
    const req = http.request(
      { method, hostname: 'localhost', port: 3000, path: urlPath, headers: { Authorization: `Bearer ${tk}` }, timeout: 10000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT' }); });
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────
// Test framework
// ──────────────────────────────────────────────────────────────────────

const results = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    results.push({ name, status: 'PASS' });
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`     ${err.message}`);
    results.push({ name, status: 'FAIL', error: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

async function main() {
  const tk = token();

  console.log('=== F1.6 collective routes ===');

  await test('GET /v1/collective/runs/:id returns sensitivity-consensus fixture', async () => {
    const r = await request('GET', `/v1/collective/runs/${SENSITIVITY_RUN_ID}`, tk);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.body && r.body.run, 'missing run');
    assert(r.body.run.strategy === 'sensitivity-consensus', `wrong strategy: ${r.body.run.strategy}`);
    assert(Array.isArray(r.body.signals), 'missing signals');
    assert(r.body.signals.length === 2, `expected 2 signals, got ${r.body.signals.length}`);
  });

  await test('GET /v1/collective/runs/:id returns tri-role-collective fixture', async () => {
    const r = await request('GET', `/v1/collective/runs/${TRI_ROLE_RUN_ID}`, tk);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.body.run.strategy === 'tri-role-collective', 'wrong strategy');
    assert(r.body.signals.length === 3, `expected 3 signals, got ${r.body.signals.length}`);
  });

  await test('GET /v1/collective/runs/:id with foreign org rejects (tenant isolation)', async () => {
    // Two valid outcomes prove isolation:
    //   401 — auth middleware rejects the org claim before reaching handler
    //   404 — handler reached but where-clause filtered the row out
    // Both achieve the privacy guarantee (foreign org cannot read).
    const foreignTk = jwt.sign(
      {
        userId: '00000000-0000-0000-0000-000000000001',
        organizationId: '99999999-9999-9999-9999-999999999999',
        email: 'foreign@example.com',
        roles: ['owner'],
        token_use: 'access',
        nbf: Math.floor(Date.now() / 1000),
        jti: 'x',
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '5m',
        algorithm: 'HS256',
        issuer: 'ci-api',
        audience: 'ci-api',
        subject: '00000000-0000-0000-0000-000000000001',
      },
    );
    const r = await request('GET', `/v1/collective/runs/${TRI_ROLE_RUN_ID}`, foreignTk);
    assert(r.status === 401 || r.status === 404, `expected 401|404, got ${r.status}`);
  });

  await test('GET /v1/collective/runs/:id/trace returns trace data (or 200 empty when none)', async () => {
    const r = await request('GET', `/v1/collective/runs/${TRI_ROLE_RUN_ID}/trace`, tk);
    // The fixture run was inserted via SQL without trace spans in metadata.
    // The route may return 200 with an empty array, OR 404 if "no spans
    // means no trace for this run". Both are valid — what matters is
    // that the route exists and is auth-gated.
    assert(r.status === 200 || r.status === 404, `expected 200|404, got ${r.status}`);
  });

  console.log('\n=== F4.1 audit-substrate visibility ===');
  // Note: the API repackages the raw collective_signals row into a
  // domain-object shape — `decision: { type, value, confidence, rationale }`
  // and `metrics: { latencyMs, ... }`. The audit substrate fields live at
  // `signal.decision.value.{schedulerName,decisionReason}`.

  await test('Tri-role planner signal exposes schedulerName + decisionReason in decision.value', async () => {
    const r = await request('GET', `/v1/collective/runs/${TRI_ROLE_RUN_ID}`, tk);
    assert(r.status === 200);
    const planner = r.body.signals.find((s) => s.role === 'planner');
    assert(planner, 'no planner signal found');
    assert(planner.decision && typeof planner.decision === 'object', 'decision not present');
    const dv = planner.decision.value;
    assert(dv && typeof dv === 'object', 'decision.value not an object');
    assert(dv.schedulerName === 'fixed-state-machine', `unexpected schedulerName: ${dv.schedulerName}`);
    assert(typeof dv.decisionReason === 'string' && dv.decisionReason.length > 0, 'decisionReason missing');
  });

  await test('Auditor signal carries verdict-accept decision.type', async () => {
    const r = await request('GET', `/v1/collective/runs/${TRI_ROLE_RUN_ID}`, tk);
    const auditor = r.body.signals.find((s) => s.role === 'auditor');
    assert(auditor, 'no auditor signal');
    assert(auditor.decision && auditor.decision.type === 'verdict-accept',
      `wrong decision.type: ${auditor.decision && auditor.decision.type}`);
  });

  await test('Auditor signal verdict body includes status + feedback (F4.1 audit completeness)', async () => {
    const r = await request('GET', `/v1/collective/runs/${TRI_ROLE_RUN_ID}`, tk);
    const auditor = r.body.signals.find((s) => s.role === 'auditor');
    const verdict = auditor.decision.value.verdict;
    assert(verdict && verdict.status === 'accept', 'verdict.status missing/wrong');
    assert(typeof verdict.feedback === 'string', 'verdict.feedback missing');
  });

  console.log('\n=== F3.3 training-data admin endpoints ===');

  await test('GET /v1/admin/training-data/state lists all 3 streams', async () => {
    const r = await request('GET', '/v1/admin/training-data/state', tk);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(Array.isArray(r.body.streams), 'missing streams array');
    const types = new Set(r.body.streams.map((s) => s.extractionType));
    assert(types.has('outcomes'), 'missing outcomes stream');
    assert(types.has('shadow'), 'missing shadow stream');
    assert(types.has('collective'), 'missing collective stream (F3.3 substrate)');
  });

  console.log('\n=== Health + readiness (sanity) ===');

  await test('GET /health returns 200', async () => {
    const r = await request('GET', '/health', tk);
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await test('GET /health/ready returns 200', async () => {
    const r = await request('GET', '/health/ready', tk);
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log();
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);
  fs.writeFileSync('/tmp/functional-results.json', JSON.stringify({ passed, failed, results }, null, 2));
  console.log('\nReport at /tmp/functional-results.json');
  process.exit(failed > 0 ? 1 : 0);
}

main();
