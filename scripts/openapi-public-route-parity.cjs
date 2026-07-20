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

const ROOT = process.cwd();
const ROUTES_ROOT = path.resolve('api', 'src', 'routes');
const SPEC_PATH = path.resolve('openapi-spec.json');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
const EXCLUDED_PUBLIC_PATHS = new Set([
  '/v1/auth/test-db',
  '/v1/billing/webhooks/stripe',
  '/health/startup',
  '/health/live',
  '/health/ready',
  '/metrics',
  '/internal/jwks/status',
]);

function toPosix(filePath) {
  return filePath.replaceAll('\\', '/');
}

function normalizeRoutePath(routePath) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// Keep in lockstep with scripts/openapi-sync-public-routes.cjs — this is
// the parity check, so its notion of "public" must match the generator's
// exactly or every admin/internal route will report as a false mismatch.
const PRIVILEGED_PREFIX_RE = /^\/v1\/(internal|admin)(\/|$)/;

function shouldTrackAsPublic(routePath) {
  if (EXCLUDED_PUBLIC_PATHS.has(routePath)) return false;
  if (routePath.startsWith('/internal/')) return false;
  if (PRIVILEGED_PREFIX_RE.test(routePath)) return false;
  return routePath === '/.well-known/jwks.json' || routePath.startsWith('/v1/');
}

function walkTsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (full.includes('__tests__')) continue;
    files.push(full);
  }
  return files;
}

// Kept in lockstep with scripts/openapi-sync-public-routes.cjs — see that
// file's comment for why whole-line `//` comments must be stripped before
// route extraction.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
}

function collectRouteDefinitions(filePath) {
  const source = stripLineComments(fs.readFileSync(filePath, 'utf8'));
  const routes = [];

  const directCallRegex =
    /\.(get|post|put|patch|delete|options|head|trace)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = directCallRegex.exec(source)) !== null) {
    routes.push({
      method: match[1].toLowerCase(),
      path: normalizeRoutePath(match[2]),
      file: filePath,
    });
  }

  const objectRouteRegex =
    /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)['"`][\s\S]{0,300}?url\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((match = objectRouteRegex.exec(source)) !== null) {
    routes.push({
      method: match[1].toLowerCase(),
      path: normalizeRoutePath(match[2]),
      file: filePath,
    });
  }

  return routes;
}

function main() {
  if (!fs.existsSync(ROUTES_ROOT)) {
    throw new Error(`Routes directory not found: ${ROUTES_ROOT}`);
  }
  if (!fs.existsSync(SPEC_PATH)) {
    throw new Error(`OpenAPI spec not found: ${SPEC_PATH}`);
  }

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const openapiPaths = spec.paths || {};
  const routeFiles = walkTsFiles(ROUTES_ROOT);
  const discovered = new Map();

  for (const file of routeFiles) {
    for (const route of collectRouteDefinitions(file)) {
      if (!METHODS.includes(route.method)) continue;
      if (!shouldTrackAsPublic(route.path)) continue;
      const key = `${route.method.toUpperCase()} ${route.path}`;
      if (!discovered.has(key)) {
        discovered.set(key, route);
      }
    }
  }

  const missing = [];
  for (const route of discovered.values()) {
    if (!openapiPaths[route.path] || !openapiPaths[route.path][route.method]) {
      missing.push(route);
    }
  }

  if (missing.length > 0) {
    console.error('OpenAPI public parity check failed. Implemented public routes missing from contract:');
    for (const route of missing) {
      console.error(
        `- ${route.method.toUpperCase()} ${route.path} (${toPosix(path.relative(ROOT, route.file))})`
      );
    }
    process.exit(1);
  }

  console.log(
    `OpenAPI public parity check passed (${discovered.size} public route operations matched the contract).`
  );
}

main();
