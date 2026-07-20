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
 * Layer-1 parity check: every path in `ci/openapi-spec.json` must appear
 * (exact or via templated regex with a comment marker) in the generated
 * gateway allowlist, and vice versa.
 *
 * The allowlist file is produced by ci/scripts/sync-gateway-allowlist.cjs and
 * lives in the canonical `gateway/` super-monorepo directory at:
 *   gateway/nginx/conf.d/hosts/generated/ci-api-public-paths.map.conf
 * In ci-only lanes the generator emits a fallback under `dist/`. Both
 * locations are tried in order; the first existing wins.
 */

const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.resolve('openapi-spec.json');
const CANDIDATE_MAP_PATHS = [
  path.resolve(
    '..',
    'gateway',
    'nginx',
    'conf.d',
    'hosts',
    'generated',
    'ci-api-public-paths.map.conf'
  ),
  path.resolve('dist', 'ci-api-public-paths.map.conf'),
];

const FORBIDDEN_PATHS = new Set([
  '/metrics',
  '/health/startup',
  '/health/live',
  '/health/ready',
  '/internal/jwks/status',
  '/v1/auth/test-db',
  '/v1/billing/webhooks/stripe',
]);

const REQUIRED_CRITICAL_PATHS = [
  '/v1/models',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/embeddings',
  '/v1/provider-capabilities',
  '/v1/realtime',
  '/.well-known/jwks.json',
];
const MIN_PUBLIC_PATHS = 120;

function parseMapPaths(raw) {
  const collected = new Set();
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const exact = trimmed.match(/^(?:=)?(\/[^\s]+)\s+1;$/);
    if (exact) {
      collected.add(exact[1]);
      continue;
    }

    const templated = trimmed.match(/^~[^\s]+\s+1;\s+#\s+(\S+)$/);
    if (templated) {
      collected.add(templated[1]);
    }
  }

  return collected;
}

function main() {
  if (!fs.existsSync(SPEC_PATH)) {
    throw new Error(`OpenAPI spec not found: ${SPEC_PATH}`);
  }
  const mapPath = CANDIDATE_MAP_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!mapPath) {
    throw new Error(`Gateway allowlist map not found in candidates: ${CANDIDATE_MAP_PATHS.join(', ')}`);
  }

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const specPaths = Object.keys(spec.paths || {});
  const specPathSet = new Set(specPaths);
  const mapRaw = fs.readFileSync(mapPath, 'utf8');
  const mapPathSet = parseMapPaths(mapRaw);

  if (!/map \$(?:ci_api_request_path|uri) \$ci_api_public_allowed \{/.test(mapRaw)) {
    throw new Error('Invalid allowlist file: missing map declaration.');
  }
  if (!/\bdefault 0;/.test(mapRaw)) {
    throw new Error('Invalid allowlist file: missing deny-by-default rule.');
  }
  if (specPaths.length < MIN_PUBLIC_PATHS) {
    throw new Error(
      `Unexpected OpenAPI public path count: ${specPaths.length} (< ${MIN_PUBLIC_PATHS}).`
    );
  }

  const missingCriticalInSpec = REQUIRED_CRITICAL_PATHS.filter((routePath) => !specPathSet.has(routePath));
  if (missingCriticalInSpec.length > 0) {
    throw new Error(
      `OpenAPI spec missing critical public paths: ${missingCriticalInSpec.join(', ')}`
    );
  }

  const missingInMap = specPaths.filter((routePath) => !mapPathSet.has(routePath));
  const extraInMap = [...mapPathSet].filter((routePath) => !specPathSet.has(routePath));
  const forbiddenPresent = [...FORBIDDEN_PATHS].filter((routePath) => mapPathSet.has(routePath));

  const missingCriticalInMap = REQUIRED_CRITICAL_PATHS.filter((routePath) => !mapPathSet.has(routePath));

  if (
    missingInMap.length > 0 ||
    extraInMap.length > 0 ||
    forbiddenPresent.length > 0 ||
    missingCriticalInMap.length > 0
  ) {
    console.error('Gateway allowlist parity check failed.');
    if (missingInMap.length > 0) {
      console.error(`Missing in gateway allowlist (${missingInMap.length}):`);
      for (const item of missingInMap) console.error(`- ${item}`);
    }
    if (extraInMap.length > 0) {
      console.error(`Extra in gateway allowlist (${extraInMap.length}):`);
      for (const item of extraInMap) console.error(`- ${item}`);
    }
    if (forbiddenPresent.length > 0) {
      console.error(`Forbidden paths present in allowlist (${forbiddenPresent.length}):`);
      for (const item of forbiddenPresent) console.error(`- ${item}`);
    }
    if (missingCriticalInMap.length > 0) {
      console.error(`Critical paths missing in allowlist (${missingCriticalInMap.length}):`);
      for (const item of missingCriticalInMap) console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        valid: true,
        mapPath: path.relative(process.cwd(), mapPath),
        openapiPathCount: specPaths.length,
        allowlistPathCount: mapPathSet.size,
        missingInMap: 0,
        extraInMap: 0,
        forbiddenPresent: 0,
        criticalPathsChecked: REQUIRED_CRITICAL_PATHS.length,
      },
      null,
      2
    )
  );
}

main();
