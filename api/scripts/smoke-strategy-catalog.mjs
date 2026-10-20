// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Post-deploy synthetic smoke for the strategy catalog + target-policy
 * surface (ENT-001 Phase 1 / OPS-001, phase-1-plan.md D2).
 *
 * Exercises, against a running api (no SDK, plain fetch — usable from the
 * deploy pipeline or a laptop):
 *
 *   1. GET  /health                      → 200
 *   2. GET  /v1/models/strategies        → 200, catalogVersion present,
 *                                           ≥1 selectable descriptor with
 *                                           every required contract field
 *   3. GET  /v1/models/best:medium       → 200, descriptor merged into the
 *                                           model row (A4 additive resolve)
 *   4. (only if CHAT_SERVICE_MODELS_KEY is set)
 *      GET  /v1/models?all=true with the chat identity
 *                                        → 403 {"code":"catalog_bulk_forbidden"}
 *                                           (CAT-001/A2 bulk refusal)
 *
 * Configuration (env):
 *   BASE_URL (or argv[2])     — api base, e.g. https://api.prod.ailin.one
 *   CHAT_SERVICE_MODELS_KEY   — optional; enables check 4
 *
 * Run:
 *   node scripts/smoke-strategy-catalog.mjs https://api.<env>.ailin.one
 *   CHAT_SERVICE_MODELS_KEY=... node scripts/smoke-strategy-catalog.mjs ...
 *
 * Expected:
 *   - exit code 0 with every check printed as "ok"; non-zero (first failure)
 *     otherwise. Failures print status + body excerpt.
 */

const BASE_URL = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const CHAT_KEY = process.env.CHAT_SERVICE_MODELS_KEY || '';

/** Required descriptor contract (strategy-descriptors.ts — the cross-repo
 * shape chat's BFF fails closed on). Depth-2: top-level keys plus the keys
 * of the nested objects. */
const REQUIRED_DESCRIPTOR_KEYS = [
  'catalogVersion',
  'id',
  'kind',
  'displayName',
  'description',
  'strategy',
  'selectable',
  'capabilities',
  'operability',
  'pricing',
  'entitlement',
];
const REQUIRED_NESTED_KEYS = {
  strategy: ['family', 'tier'],
  pricing: ['currency', 'inputPer1MUsd', 'outputPer1MUsd'],
  entitlement: ['required'],
};

let failed = false;

function ok(label, detail = '') {
  console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail = '') {
  failed = true;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body — surfaced below via the excerpt
  }
  return { status: res.status, body, excerpt: text.slice(0, 300) };
}

function assertDescriptorShape(descriptor, label) {
  for (const key of REQUIRED_DESCRIPTOR_KEYS) {
    if (!(key in descriptor)) {
      fail(label, `missing required field '${key}'`);
      return false;
    }
  }
  for (const [parent, keys] of Object.entries(REQUIRED_NESTED_KEYS)) {
    for (const key of keys) {
      if (!descriptor[parent] || !(key in descriptor[parent])) {
        fail(label, `missing required field '${parent}.${key}'`);
        return false;
      }
    }
  }
  return true;
}

async function main() {
  if (!BASE_URL) {
    console.error('usage: node scripts/smoke-strategy-catalog.mjs <base-url>');
    process.exit(2);
  }
  console.log(`smoke-strategy-catalog against ${BASE_URL}`);

  // 1. Health.
  const health = await getJson('/health');
  if (health.status === 200) ok('GET /health', '200');
  else fail('GET /health', `status ${health.status} — ${health.excerpt}`);

  // 2. Strategy catalog: versioned, ≥1 selectable descriptor, contract fields.
  const catalog = await getJson('/v1/models/strategies');
  if (catalog.status !== 200) {
    fail('GET /v1/models/strategies', `status ${catalog.status} — ${catalog.excerpt}`);
  } else if (!catalog.body || typeof catalog.body.catalogVersion !== 'string') {
    fail('GET /v1/models/strategies', 'response missing catalogVersion');
  } else {
    const strategies = Array.isArray(catalog.body.strategies) ? catalog.body.strategies : [];
    const selectable = strategies.find((d) => d && d.selectable === true);
    if (strategies.length < 1) {
      fail('GET /v1/models/strategies', 'empty strategies array');
    } else if (!selectable) {
      fail('GET /v1/models/strategies', 'no selectable descriptor in the catalog');
    } else if (assertDescriptorShape(selectable, 'GET /v1/models/strategies')) {
      ok(
        'GET /v1/models/strategies',
        `catalogVersion=${catalog.body.catalogVersion}, ${strategies.length} descriptors, selectable sample=${selectable.id}`
      );
    }
  }

  // 3. Composite resolve (A4): best:medium merges the descriptor into the row.
  const composite = await getJson(`/v1/models/${encodeURIComponent('best:medium')}`);
  if (composite.status !== 200) {
    fail("GET /v1/models/best:medium", `status ${composite.status} — ${composite.excerpt}`);
  } else {
    const row = composite.body;
    const merged =
      row &&
      row.id === 'best:medium' &&
      row.kind === 'collective_strategy' &&
      row.strategy &&
      row.strategy.family === 'best';
    if (merged) ok('GET /v1/models/best:medium', 'descriptor merged (kind + strategy.family=best)');
    else fail('GET /v1/models/best:medium', `no descriptor merge in row: ${composite.excerpt}`);
  }

  // 4. Chat-identity bulk refusal — only when the key is available.
  if (CHAT_KEY) {
    const refusal = await getJson('/v1/models?all=true', { 'x-api-key': CHAT_KEY });
    const body = refusal.body || {};
    if (refusal.status === 403 && body.error?.code === 'catalog_bulk_forbidden') {
      ok('GET /v1/models?all=true (chat identity)', '403 catalog_bulk_forbidden');
    } else if (refusal.status === 403 && body.code === 'catalog_bulk_forbidden') {
      ok('GET /v1/models?all=true (chat identity)', '403 catalog_bulk_forbidden');
    } else {
      fail(
        'GET /v1/models?all=true (chat identity)',
        `expected 403 catalog_bulk_forbidden, got ${refusal.status} — ${refusal.excerpt}`
      );
    }
  } else {
    console.log('skip GET /v1/models?all=true (chat identity) — CHAT_SERVICE_MODELS_KEY not provided');
  }

  if (failed) {
    console.error('smoke-strategy-catalog: FAILED');
    process.exit(1);
  }
  console.log('smoke-strategy-catalog: all checks passed');
}

main().catch((error) => {
  console.error(`smoke-strategy-catalog: unrecoverable — ${error.message}`);
  process.exit(1);
});
