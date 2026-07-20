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
const YAML = require('yaml');

const JSON_PATH = path.resolve('openapi-spec.json');
const YAML_PATH = path.resolve('openapi-spec.yaml');
const ROUTES_ROOT = path.resolve('api', 'src', 'routes');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const EXCLUDED_PUBLIC_PATHS = new Set([
  '/internal/jwks/status',
  '/health/startup',
  '/health/live',
  '/health/ready',
  '/metrics',
  '/v1/auth/test-db',
  '/v1/billing/webhooks/stripe',
]);

const PUBLIC_NO_AUTH_PATHS = new Set([
  '/.well-known/jwks.json',
  '/v1/auth/challenge',
  '/v1/auth/email-challenge',
  '/v1/auth/login',
  '/v1/auth/login-with-code',
  '/v1/auth/refresh',
  '/v1/auth/register',
  '/v1/models',
  '/v1/models/list',
  '/v1/models/{id}',
  '/v1/status',
  '/v1/status/health',
  '/v1/status/ready',
]);

function normalizeRoutePath(routePath) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// Privileged surfaces are never part of the public contract, regardless of
// the exact sub-path — enterprise default-deny: operator/admin tooling is
// reached over the internal network (see docs/hardening/*), not the public
// gateway. Matches the prefix itself (`/v1/admin`) and every nested path
// (`/v1/admin/...`), not just literal `/v1/admin/`.
const PRIVILEGED_PREFIX_RE = /^\/v1\/(internal|admin)(\/|$)/;

function shouldIncludePublicRoute(routePath) {
  if (EXCLUDED_PUBLIC_PATHS.has(routePath)) return false;
  if (routePath.startsWith('/internal/')) return false;
  if (PRIVILEGED_PREFIX_RE.test(routePath)) return false;
  return routePath === '/.well-known/jwks.json' || routePath.startsWith('/v1/');
}

function walkTsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (fullPath.includes('__tests__')) continue;
    files.push(fullPath);
  }
  return files;
}

// Whole-line `//` comments only (not a full JS/TS comment stripper — inline
// trailing comments and block comments are left alone since none of the
// route-registration regexes below match across them). Without this, a
// comment merely mentioning a route-call shape (e.g. documenting a pattern
// used "below") gets parsed as a real route registration.
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
    routes.push({ method: match[1].toLowerCase(), path: normalizeRoutePath(match[2]) });
  }

  const objectRouteRegex =
    /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)['"`][\s\S]{0,300}?url\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((match = objectRouteRegex.exec(source)) !== null) {
    routes.push({ method: match[1].toLowerCase(), path: normalizeRoutePath(match[2]) });
  }

  return routes;
}

function contributionTypeForMethod(method) {
  if (method === 'get' || method === 'head' || method === 'options') return 'signal-consumer';
  if (method === 'delete') return 'governance';
  return 'signal-producer';
}

function ciBlock(method) {
  return {
    contributionType: contributionTypeForMethod(method),
    artifactsProduced: ['traces'],
    artifactsConsumed: ['policies', 'org_settings', 'quotas', 'request_context'],
    aggregationOrSynthesis:
      'Combines request intent, policy constraints, and tenant context to produce deterministic outputs within the CI Fabric.',
    feedbackLoops:
      'Feeds telemetry, evaluation signals, and human feedback into quality gates and policy refinement cycles.',
    provenanceAndAttribution:
      'Associates user, organization, model, and tool provenance with requestId/correlationId for end-to-end attribution.',
    governanceAndPrivacyBoundaries:
      'Applies tenant isolation, retention controls, redaction rules, and auditable policy enforcement boundaries.',
    failureModesAndCiImpact:
      'Potential CI impact includes stale memory, missing attribution links, policy mismatches, and reduced synthesis quality.',
  };
}

function headersBlock() {
  return {
    'X-Request-Id': {
      description: 'Unique request identifier for end-to-end tracing.',
      schema: { type: 'string' },
    },
    'X-Correlation-Id': {
      description: 'Correlation identifier propagated across internal services.',
      schema: { type: 'string' },
    },
  };
}

function defaultSuccessResponse() {
  return {
    description: 'Successful operation.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
    headers: headersBlock(),
  };
}

function tagForPath(routePath) {
  const first = routePath.replace(/^\/v1\//, '').replace(/^\//, '').split('/')[0] || 'advanced';
  const map = {
    admin: 'Advanced',
    api: 'Advanced',
    auth: 'Authentication',
    assistants: 'Assistants',
    audio: 'Audio',
    batches: 'Batches',
    cache: 'Cache',
    caching: 'Caching',
    capabilities: 'Capabilities',
    chat: 'Chat',
    code: 'Advanced',
    codebase: 'Advanced',
    embeddings: 'Embeddings',
    enterprise: 'Advanced',
    files: 'Files',
    health: 'Status',
    images: 'Images',
    jobs: 'Advanced',
    memory: 'Advanced',
    models: 'Models',
    moderation: 'Moderations',
    moderations: 'Moderations',
    orchestration: 'Advanced',
    organization: 'Organizations',
    organizations: 'Organizations',
    providers: 'Models',
    queue: 'Queue',
    realtime: 'Realtime',
    responses: 'Responses',
    search: 'Advanced',
    status: 'Status',
    threads: 'Threads',
    tools: 'Advanced',
    usage: 'Usage',
    user: 'Users',
    users: 'Users',
    'vector_stores': 'Vector Stores',
    'vector-stores': 'Vector Stores',
    '.well-known': 'Authentication',
  };
  return map[first] || 'Advanced';
}

function summaryFor(method, routePath) {
  const actionMap = {
    get: 'Retrieve',
    post: 'Create or execute',
    put: 'Update',
    patch: 'Update',
    delete: 'Delete',
    options: 'Inspect',
    head: 'Inspect',
    trace: 'Trace',
  };
  const action = actionMap[method] || 'Execute';
  const tokens = routePath
    .replace(/^\/v1\//, '')
    .replace(/^\//, '')
    .split('/')
    .map((segment) => segment.replace(/[{}]/g, '').replace(/[-_]/g, ' '))
    .filter(Boolean);
  return `${action} ${tokens.join(' ') || 'resource'}`;
}

function descriptionFor(summary, routePath) {
  return [
    `${summary}.`,
    '',
    'Enterprise contract notes:',
    `- Purpose: exposes ${routePath} as a governed API capability inside the CI Fabric.`,
    '- Preconditions: requires valid authentication unless explicitly marked as public.',
    '- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.',
    '- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.',
    '- Observability: request and correlation identifiers are propagated for traceability.',
    '- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.',
  ].join('\n');
}

function operationIdFor(method, routePath, usedIds) {
  const segments = routePath
    .replace(/^\/v1\//, '')
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith('{') && segment.endsWith('}')) {
        return `By${segment.slice(1, -1).replace(/[^a-zA-Z0-9]/g, '')}`;
      }
      return segment.replace(/[^a-zA-Z0-9]/g, '');
    })
    .filter(Boolean)
    .map((token) => `${token[0].toUpperCase()}${token.slice(1)}`);

  const base = `${method}${segments.join('') || 'Root'}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let suffix = 2;
  while (usedIds.has(`${base}${suffix}`)) suffix += 1;
  const next = `${base}${suffix}`;
  usedIds.add(next);
  return next;
}

function pathParameters(routePath) {
  const parameters = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(routePath)) !== null) {
    parameters.push({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }
  return parameters;
}

function collectUsedOperationIds(spec) {
  const used = new Set();
  for (const pathItem of Object.values(spec.paths || {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      if (typeof operation.operationId === 'string' && operation.operationId.trim().length > 0) {
        used.add(operation.operationId);
      }
    }
  }
  return used;
}

function main() {
  const spec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  spec.paths = spec.paths || {};

  const usedIds = collectUsedOperationIds(spec);
  let addedOperations = 0;
  let normalizedPublicSecurity = 0;
  let normalizedMissingTags = 0;
  const seen = new Set();

  for (const filePath of walkTsFiles(ROUTES_ROOT)) {
    for (const route of collectRouteDefinitions(filePath)) {
      if (!METHODS.includes(route.method)) continue;
      if (!shouldIncludePublicRoute(route.path)) continue;
      const key = `${route.method.toUpperCase()} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!spec.paths[route.path]) spec.paths[route.path] = {};
      if (spec.paths[route.path][route.method]) continue;

      const summary = summaryFor(route.method, route.path);
      const operation = {
        tags: [tagForPath(route.path)],
        summary,
        description: descriptionFor(summary, route.path),
        operationId: operationIdFor(route.method, route.path, usedIds),
        security: PUBLIC_NO_AUTH_PATHS.has(route.path) ? [] : [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        responses: {
          200: defaultSuccessResponse(),
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          422: { $ref: '#/components/responses/UnprocessableEntity' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
        'x-collective-intelligence': ciBlock(route.method),
      };

      const params = pathParameters(route.path);
      if (params.length > 0) operation.parameters = params;

      spec.paths[route.path][route.method] = operation;
      addedOperations += 1;
    }
  }

  // Keep runtime and public contract aligned: known public endpoints must not require auth.
  for (const routePath of PUBLIC_NO_AUTH_PATHS) {
    const pathItem = spec.paths[routePath];
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      if (Array.isArray(operation.security) && operation.security.length === 0) continue;
      operation.security = [];
      normalizedPublicSecurity += 1;
    }
  }

  // Normalize missing tags for all operations to keep semantic lint warnings at zero.
  for (const [routePath, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      if (Array.isArray(operation.tags) && operation.tags.length > 0) continue;
      operation.tags = [tagForPath(routePath)];
      normalizedMissingTags += 1;
    }
  }

  fs.writeFileSync(JSON_PATH, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  fs.writeFileSync(YAML_PATH, YAML.stringify(spec), 'utf8');

  console.log(
    JSON.stringify(
      {
        synced: true,
        totalPaths: Object.keys(spec.paths).length,
        addedOperations,
        normalizedPublicSecurity,
        normalizedMissingTags,
      },
      null,
      2
    )
  );
}

main();
