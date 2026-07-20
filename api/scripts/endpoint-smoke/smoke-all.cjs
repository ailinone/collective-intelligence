// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Endpoint smoke-test harness.
 *
 * Consumes openapi-spec.json (the contract source of truth) and exercises
 * every operation. Categorizes by status code:
 *   - 2xx/3xx       => ALIVE_OK    (handler returned success)
 *   - 4xx           => ALIVE_4XX   (handler validated input + rejected — endpoint exists)
 *   - 5xx           => BROKEN      (server error — needs triage)
 *   - timeout       => TIMEOUT     (handler hangs)
 *   - network err   => UNREACHABLE (container down or route missing from gateway)
 *
 * "Alive" means the endpoint exists, is wired into the router, parses the
 * request, and produced a deterministic outcome. That's what smoke-tests
 * prove. Functional correctness (specific 2xx behavior) is a separate
 * test layer covered by the targeted suite for new endpoints.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const jwt = require('/app/node_modules/jsonwebtoken'); // run via: docker exec ci-api node /tmp/smoke-all.cjs

// ───────────────────────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 8000);
const CONCURRENCY = Number(process.env.SMOKE_CONCURRENCY || 4);
const SPEC_PATH = process.env.OPENAPI_SPEC || '/tmp/openapi-spec.json';

// Path-parameter fixtures (substitute placeholders in {paramName} slots).
// Where a real fixture is known we use it (so the handler returns data);
// where it's not, we use a deterministic fake UUID so the handler 404s
// — that's still proof the route exists and parses input correctly.
const FAKE_UUID = '00000000-0000-0000-0000-000000000404';
const FAKE_NUMBER = '404';

const FIXTURES = {
  // Real fixtures from F1.5 / F4.1 smoke runs
  organizationId: '11111111-1111-1111-1111-111111111111',
  runId: 'eeeeeeee-4444-5555-6666-eeeeeeeeeeee',
  // User identity comes from the JWT we'll generate below
  userId: '22222222-2222-2222-2222-222222222222',
  // Common fakes — endpoints will 404 but route validation is exercised
  id: FAKE_UUID,
  thread_id: FAKE_UUID,
  run_id: FAKE_UUID, // collective route uses {id} not {run_id}, but tools may
  message_id: FAKE_UUID,
  file_id: FAKE_UUID,
  vector_store_id: FAKE_UUID,
  assistant_id: FAKE_UUID,
  job_id: FAKE_UUID,
  response_id: FAKE_UUID,
  context_id: FAKE_UUID,
  paymentMethodId: FAKE_UUID,
  memoryId: FAKE_UUID,
  userId_path: FAKE_UUID,
  // Fallback for anything else
  __default__: FAKE_UUID,
};

// Endpoints we should NOT hit (because they cause real side effects we
// can't roll back, or because they hang on external dependencies).
const SKIP_PATHS = [
  // Streaming endpoints — would hang the harness without proper teardown
  /\/v1\/realtime\b/, // websocket upgrade
  /\/v1\/threads\/.*\/runs\/.*\/stream/,
  // Background jobs that take seconds — out of scope for smoke
  /\/v1\/admin\/training-data\/export$/, // we test this in targeted suite
  // Anything that mutates billing
  /\/v1\/enterprise\/billing\/payment-methods/,
  /\/v1\/enterprise\/billing\/subscriptions/,
];

// ───────────────────────────────────────────────────────────────────────
// JWT generation (mirrors the test JWT used in earlier smoke runs)
// ───────────────────────────────────────────────────────────────────────

function generateToken() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var required');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      userId: FIXTURES.userId,
      organizationId: FIXTURES.organizationId,
      email: 'smoke@example.com',
      roles: ['owner', 'admin'],
      token_use: 'access',
      nbf: now,
      jti: Math.random().toString(36).slice(2),
    },
    secret,
    {
      expiresIn: '1h',
      algorithm: 'HS256',
      issuer: 'ci-api',
      audience: 'ci-api',
      subject: FIXTURES.userId,
    },
  );
}

// ───────────────────────────────────────────────────────────────────────
// Body builder — extract a minimal valid body from requestBody schema
// ───────────────────────────────────────────────────────────────────────

function buildMinimalBody(operation) {
  const rb = operation.requestBody;
  if (!rb || !rb.content) return undefined;
  const json = rb.content['application/json'];
  if (!json) return undefined;
  const schema = json.schema;
  if (!schema) return {};
  return buildFromSchema(schema, 0);
}

function buildFromSchema(schema, depth) {
  if (depth > 4) return null;
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  const type = schema.type || (schema.properties ? 'object' : null) || (schema.items ? 'array' : null);
  switch (type) {
    case 'string': {
      if (schema.format === 'uuid') return FAKE_UUID;
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'email') return 'test@example.com';
      return schema.minLength ? 'a'.repeat(schema.minLength) : 'test';
    }
    case 'integer':
    case 'number': {
      if (schema.minimum !== undefined) return schema.minimum;
      return 1;
    }
    case 'boolean':
      return false;
    case 'array': {
      if (schema.minItems > 0) return [buildFromSchema(schema.items, depth + 1)];
      return [];
    }
    case 'object': {
      const out = {};
      const required = new Set(schema.required || []);
      const props = schema.properties || {};
      for (const [k, sub] of Object.entries(props)) {
        if (required.has(k)) out[k] = buildFromSchema(sub, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Path parameter substitution
// ───────────────────────────────────────────────────────────────────────

function substitutePath(pathTemplate, parameters) {
  let out = pathTemplate;
  const params = parameters || [];
  // Two passes: first by name (uses FIXTURES), then by raw placeholder
  for (const param of params) {
    if (param.in !== 'path') continue;
    const name = param.name;
    const fixture = FIXTURES[name] !== undefined ? FIXTURES[name] : FIXTURES.__default__;
    out = out.replace(`{${name}}`, encodeURIComponent(String(fixture)));
  }
  // Catch any remaining {placeholder} the spec didn't declare a parameter for
  out = out.replace(/\{([^}]+)\}/g, (_match, name) => {
    return encodeURIComponent(FIXTURES[name] || FIXTURES.__default__);
  });
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// HTTP client
// ───────────────────────────────────────────────────────────────────────

function request(method, urlStr, body, token) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const opts = {
      method: method.toUpperCase(),
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: TIMEOUT_MS,
    };
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => {
        chunks += c.toString('utf8').slice(0, 200); // cap to 200 chars per request
      });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks.slice(0, 200) }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'TIMEOUT' });
    });
    if (data) req.write(data);
    req.end();
  });
}

// ───────────────────────────────────────────────────────────────────────
// Operation iteration
// ───────────────────────────────────────────────────────────────────────

function* iterOperations(spec) {
  for (const [pathTemplate, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      yield { pathTemplate, method, op };
    }
  }
}

function shouldSkip(pathTemplate) {
  return SKIP_PATHS.some((re) => re.test(pathTemplate));
}

function categorize(result) {
  if (result.error === 'TIMEOUT') return 'TIMEOUT';
  if (result.status === 0) return 'UNREACHABLE';
  if (result.status >= 500) return 'BROKEN_5XX';
  if (result.status >= 200 && result.status < 400) return 'ALIVE_OK';
  return 'ALIVE_4XX';
}

// ───────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────

async function main() {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const token = generateToken();

  const ops = [];
  for (const op of iterOperations(spec)) ops.push(op);

  const results = {
    ALIVE_OK: [],
    ALIVE_4XX: [],
    BROKEN_5XX: [],
    TIMEOUT: [],
    UNREACHABLE: [],
    SKIPPED: [],
  };

  console.log(`[smoke] Total operations to test: ${ops.length}`);
  console.log(`[smoke] Concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT_MS}ms`);
  console.log();

  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= ops.length) return;
      const { pathTemplate, method, op } = ops[idx];

      if (shouldSkip(pathTemplate)) {
        results.SKIPPED.push({ method, path: pathTemplate, reason: 'allowlist-skip' });
        continue;
      }

      const realPath = substitutePath(pathTemplate, op.parameters);
      const url = BASE_URL + realPath;
      const body = buildMinimalBody(op);

      const result = await request(method, url, body, token);
      const cat = categorize(result);
      results[cat].push({
        method: method.toUpperCase(),
        path: pathTemplate,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
        ...(cat === 'BROKEN_5XX' ? { body: result.body } : {}),
      });

      if (idx > 0 && idx % 30 === 0) {
        process.stdout.write(`  ${idx}/${ops.length}\r`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ─── Report ──────────────────────────────────────────────────────────
  console.log('\n=== ENDPOINT SMOKE RESULTS ===\n');
  for (const [cat, items] of Object.entries(results)) {
    console.log(`${cat.padEnd(14)} ${String(items.length).padStart(4)}`);
  }
  const total = ops.length;
  const alive = results.ALIVE_OK.length + results.ALIVE_4XX.length;
  const broken = results.BROKEN_5XX.length + results.TIMEOUT.length + results.UNREACHABLE.length;
  console.log();
  console.log(`Alive:   ${alive}/${total}  (${((alive / total) * 100).toFixed(1)}%)`);
  console.log(`Broken:  ${broken}/${total}  (${((broken / total) * 100).toFixed(1)}%)`);
  console.log(`Skipped: ${results.SKIPPED.length}/${total}`);

  if (results.BROKEN_5XX.length > 0) {
    console.log('\n=== BROKEN (5XX) ===');
    for (const r of results.BROKEN_5XX) {
      console.log(`  [${r.status}] ${r.method.padEnd(7)} ${r.path}`);
      if (r.body) console.log(`     ${r.body.slice(0, 120)}`);
    }
  }
  if (results.TIMEOUT.length > 0) {
    console.log('\n=== TIMEOUT ===');
    for (const r of results.TIMEOUT) console.log(`  ${r.method.padEnd(7)} ${r.path}`);
  }
  if (results.UNREACHABLE.length > 0) {
    console.log('\n=== UNREACHABLE ===');
    for (const r of results.UNREACHABLE.slice(0, 20)) {
      console.log(`  ${r.method.padEnd(7)} ${r.path} (${r.error})`);
    }
    if (results.UNREACHABLE.length > 20) console.log(`  ... and ${results.UNREACHABLE.length - 20} more`);
  }

  // Persist machine-readable report
  fs.writeFileSync(
    '/tmp/smoke-results.json',
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total: ops.length,
        counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])),
        broken_5xx: results.BROKEN_5XX,
        timeout: results.TIMEOUT,
        unreachable: results.UNREACHABLE.slice(0, 50),
      },
      null,
      2,
    ),
  );
  console.log('\nMachine-readable report at /tmp/smoke-results.json');

  process.exit(broken > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err.message || err);
  process.exit(2);
});
