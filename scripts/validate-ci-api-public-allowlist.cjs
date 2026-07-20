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
 * 3-layer validator for the public-paths contract that gates api.ailin.one
 * traffic at the gateway. Single canonical home: `gateway/`.
 *
 * Layer 1 — Quantity parity:
 *   The OpenAPI spec and the generated nginx allowlist must agree on path
 *   counts (exact + templated). Drift means the generator failed or the
 *   spec was updated without regenerating the allowlist.
 *
 * Layer 2 — Operational coverage:
 *   The 6 OPERATIONAL routes (mirror of `api/src/config/operational-routes.ts`)
 *   MUST be reachable independently — either via the generated map OR via
 *   the fallback block in production.conf. This is the cross-repo Caminho-C
 *   invariant: the api guarantees these routes bypass auth/rate-limit/quota
 *   internally; the gateway must guarantee they pass the public-paths gate.
 *
 * Layer 3 — Nginx variable contract:
 *   The map directive in the generated file MUST key on `$ci_api_request_path`
 *   (the URL-decode-aware request path) and emit `$ci_api_public_allowed`.
 *   The production.conf MUST then OR-combine that with `$ci_api_public_fallback_allowed`
 *   into `$ci_api_public_effective_allowed`. This is the contract that lets
 *   the runtime gate know what's allowed.
 *
 * Usage:
 *   node scripts/validate-ci-api-public-allowlist.cjs <spec> <generated-map> <production-conf>
 *
 * Exit codes:
 *   0 — all 3 layers pass
 *   1 — at least one layer failed (details in stderr)
 *
 * Graceful skip: if the production.conf path does not exist (e.g. ci-only CI
 * lane without `gateway/` checked out), Layers 2 and 3 are skipped with a
 * clear notice and only Layer 1 runs. Set `ALLOWLIST_VALIDATOR_STRICT=1` to
 * force a failure instead.
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error(
    'Usage: validate-ci-api-public-allowlist.cjs <spec.json> <generated-map.conf> <production.conf>'
  );
  process.exit(1);
}

const [specArg, mapArg, prodArg] = args;
const specPath = path.resolve(specArg);
const mapPath = path.resolve(mapArg);
const prodPath = path.resolve(prodArg);
const STRICT = process.env.ALLOWLIST_VALIDATOR_STRICT === '1';

// Mirror of api/src/config/operational-routes.ts — these routes MUST be
// reachable from outside the gateway without any auth/rate-limit/quota.
const OPERATIONAL_ROUTES = [
  '/v1/hcra/health',
  '/v1/status',
  '/v1/status/health',
  '/v1/status/ready',
  '/.well-known/jwks.json',
  '/console/api/v1/jwks',
];

function parseMapExactPaths(raw) {
  const collected = new Set();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const exact = trimmed.match(/^(?:=)?(\/[^\s]+)\s+1;$/);
    if (exact) collected.add(exact[1]);
    const templated = trimmed.match(/^~[^\s]+\s+1;\s+#\s+(\S+)$/);
    if (templated) collected.add(templated[1]);
  }
  return collected;
}

const failures = [];

// ───── pre-flight ─────
if (!fs.existsSync(specPath)) {
  console.error(`FAIL: OpenAPI spec not found at ${specPath}`);
  process.exit(1);
}
if (!fs.existsSync(mapPath)) {
  console.error(`FAIL: generated allowlist not found at ${mapPath}`);
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const specPaths = Object.keys(spec.paths || {});
const mapRaw = fs.readFileSync(mapPath, 'utf8');
const mapPathSet = parseMapExactPaths(mapRaw);

// ───── Layer 1: quantity parity ─────
const layer1 = {
  name: 'Layer 1 — Quantity parity',
  specCount: specPaths.length,
  mapCount: mapPathSet.size,
  pass: false,
  detail: '',
};

const missingFromMap = specPaths.filter((p) => !mapPathSet.has(p));
const extraInMap = [...mapPathSet].filter((p) => !specPaths.includes(p));
if (missingFromMap.length === 0 && extraInMap.length === 0) {
  layer1.pass = true;
  layer1.detail = `OK: ${specPaths.length} paths in both spec and map.`;
} else {
  layer1.pass = false;
  layer1.detail = `FAIL: ${missingFromMap.length} missing from map, ${extraInMap.length} extra in map.`;
  if (missingFromMap.length > 0)
    layer1.missingFromMap = missingFromMap.slice(0, 20);
  if (extraInMap.length > 0) layer1.extraInMap = extraInMap.slice(0, 20);
  failures.push(layer1.name);
}

// ───── Layer 2 + 3: require production.conf ─────
let layer2 = { name: 'Layer 2 — Operational coverage', skipped: true, pass: true };
let layer3 = { name: 'Layer 3 — Nginx variable contract', skipped: true, pass: true };

if (!fs.existsSync(prodPath)) {
  if (STRICT) {
    console.error(`FAIL (strict): production.conf not found at ${prodPath}`);
    layer2 = { name: 'Layer 2 — Operational coverage', skipped: false, pass: false, detail: 'production.conf missing' };
    layer3 = { name: 'Layer 3 — Nginx variable contract', skipped: false, pass: false, detail: 'production.conf missing' };
    failures.push(layer2.name, layer3.name);
  } else {
    console.warn(`SKIP: production.conf not found at ${prodPath} — Layers 2 and 3 skipped.`);
    console.warn('       Set ALLOWLIST_VALIDATOR_STRICT=1 to force failure.');
  }
} else {
  const prodRaw = fs.readFileSync(prodPath, 'utf8');

  // ───── Layer 2: operational coverage ─────
  // An operational route passes if it appears in the generated map OR in any
  // fallback `=> 1;` line in production.conf (regardless of which $-named
  // map block it lives in).
  const fallbackPaths = new Set();
  for (const line of prodRaw.split(/\r?\n/)) {
    const m = line.trim().match(/^(\/[^\s]+)\s+1;$/);
    if (m) fallbackPaths.add(m[1]);
  }

  const missingOperational = [];
  for (const route of OPERATIONAL_ROUTES) {
    const inMap = mapPathSet.has(route);
    const inFallback = fallbackPaths.has(route);
    if (!inMap && !inFallback) missingOperational.push(route);
  }

  layer2 = {
    name: 'Layer 2 — Operational coverage',
    skipped: false,
    pass: missingOperational.length === 0,
    operationalRoutesChecked: OPERATIONAL_ROUTES.length,
    detail:
      missingOperational.length === 0
        ? `OK: all ${OPERATIONAL_ROUTES.length} operational routes covered (map ∪ fallback).`
        : `FAIL: ${missingOperational.length} operational routes missing from BOTH map and fallback: ${missingOperational.join(', ')}`,
  };
  if (!layer2.pass) failures.push(layer2.name);

  // ───── Layer 3: nginx variable contract ─────
  const checks = [
    {
      name: 'generated map keys on $ci_api_request_path',
      regex: /map\s+\$ci_api_request_path\s+\$ci_api_public_allowed\s*\{/,
      target: mapRaw,
    },
    {
      name: 'production.conf defines $ci_api_request_path from $request_uri',
      regex: /map\s+\$request_uri\s+\$ci_api_request_path\s*\{/,
      target: prodRaw,
    },
    {
      name: 'production.conf includes generated map',
      regex: /include\s+[^;]*generated\/ci-api-public-paths\.map\.conf\s*;/,
      target: prodRaw,
    },
    {
      name: 'production.conf defines $ci_api_public_fallback_allowed',
      regex: /map\s+\$ci_api_request_path\s+\$ci_api_public_fallback_allowed\s*\{/,
      target: prodRaw,
    },
    {
      name: 'production.conf OR-combines into $ci_api_public_effective_allowed',
      regex: /map\s+"\$ci_api_public_allowed:\$ci_api_public_fallback_allowed"\s+\$ci_api_public_effective_allowed/,
      target: prodRaw,
    },
    {
      name: 'production.conf gates api.ailin.one location with $ci_api_public_effective_allowed',
      regex: /\$ci_api_public_effective_allowed\s*=\s*0/,
      target: prodRaw,
    },
  ];

  const variableFailures = [];
  for (const c of checks) {
    if (!c.regex.test(c.target)) variableFailures.push(c.name);
  }

  layer3 = {
    name: 'Layer 3 — Nginx variable contract',
    skipped: false,
    pass: variableFailures.length === 0,
    checksRun: checks.length,
    detail:
      variableFailures.length === 0
        ? `OK: all ${checks.length} variable-contract assertions hold.`
        : `FAIL: ${variableFailures.length} contract assertions broken: ${variableFailures.join('; ')}`,
  };
  if (!layer3.pass) failures.push(layer3.name);
}

// ───── report ─────
console.log(
  JSON.stringify(
    {
      summary: failures.length === 0 ? 'PASS' : 'FAIL',
      failedLayers: failures,
      layer1,
      layer2,
      layer3,
    },
    null,
    2
  )
);

if (failures.length > 0) process.exit(1);
