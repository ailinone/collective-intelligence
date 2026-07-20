// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.resolve('openapi-spec.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const EXCLUDED_PATHS = new Set([
  '/internal/jwks/status',
  '/health/startup',
  '/health/live',
  '/health/ready',
  '/metrics',
  '/v1/auth/test-db',
  '/v1/billing/webhooks/stripe',
]);

function isPublicPath(routePath) {
  if (EXCLUDED_PATHS.has(routePath)) return false;
  if (routePath.startsWith('/internal/')) return false;
  return true;
}

function isGenericSummary(summary) {
  if (!summary || typeof summary !== 'string') return true;
  const normalized = summary.trim();
  if (!normalized) return true;
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+\/.*/.test(normalized)) return true;
  if (/^auto[-\s]/i.test(normalized)) return true;
  if (/^(endpoint|operation)$/i.test(normalized)) return true;
  return false;
}

function isGenericDescription(description) {
  if (!description || typeof description !== 'string') return true;
  const normalized = description.trim();
  if (!normalized) return true;
  if (/^auto[-\s]/i.test(normalized)) return true;
  if (/^this endpoint/i.test(normalized)) return true;
  if (/^successful operation\.?$/i.test(normalized)) return true;
  return false;
}

function main() {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const findings = [];

  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    if (!isPublicPath(routePath)) continue;
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;

      if (isGenericSummary(operation.summary)) {
        findings.push(`${method.toUpperCase()} ${routePath}: generic or missing summary`);
      }
      if (isGenericDescription(operation.description)) {
        findings.push(`${method.toUpperCase()} ${routePath}: generic or missing description`);
      }
    }
  }

  if (findings.length > 0) {
    console.error('OpenAPI semantic quality check failed.');
    for (const finding of findings) {
      console.error(`- ${finding}`);
    }
    process.exit(1);
  }

  console.log('OpenAPI semantic quality check passed.');
}

main();
