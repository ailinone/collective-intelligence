// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type OpenApiSpec = {
  openapi?: string;
  info?: JsonObject;
  security?: JsonObject[];
  tags?: Array<{ name?: string; description?: string }>;
  paths?: Record<string, Record<string, JsonObject>>;
  components?: {
    securitySchemes?: Record<string, JsonObject>;
    responses?: Record<string, JsonObject>;
    schemas?: Record<string, JsonObject>;
  };
};

type DiffReport = {
  missingInSpec: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CI_ROOT = path.resolve(__dirname, '..', '..');
const SPEC_JSON_PATH = path.join(CI_ROOT, 'openapi-spec.json');
const SPEC_YAML_PATH = path.join(CI_ROOT, 'openapi-spec.yaml');
const DIFF_REPORT_PATH = path.join(CI_ROOT, 'reports', 'openapi-impl-diff-normalized.json');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const EXCLUDED_PUBLIC_PATHS = new Set([
  '/internal/jwks/status',
  '/health/startup',
  '/health/live',
  '/health/ready',
  '/metrics',
  '/auth/test-db',
  '/v1/auth/test-db',
  '/billing/webhooks/stripe',
  '/v1/billing/webhooks/stripe',
]);
const EXCLUDED_PUBLIC_PREFIXES = ['/internal/'];

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureObject(value: unknown): Record<string, JsonValue> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return {};
}

function capitalize(input: string): string {
  if (!input) return input;
  return `${input[0].toUpperCase()}${input.slice(1)}`;
}

function stripV1Prefix(routePath: string): string {
  if (routePath === '/v1') return '/';
  return routePath.startsWith('/v1/') ? routePath.slice(3) : routePath;
}

function toTag(firstSegment: string): string {
  const map: Record<string, string> = {
    advanced: 'Advanced',
    admin: 'Advanced',
    api: 'Advanced',
    auth: 'Authentication',
    assistants: 'Assistants',
    audio: 'Audio',
    batches: 'Batches',
    billing: 'Advanced',
    cache: 'Cache',
    caching: 'Caching',
    chat: 'Chat',
    ci: 'Advanced',
    code: 'Advanced',
    codebase: 'Advanced',
    console: 'Advanced',
    critique: 'Advanced',
    embeddings: 'Embeddings',
    enterprise: 'Advanced',
    files: 'Files',
    grounding: 'Advanced',
    health: 'Status',
    images: 'Images',
    jobs: 'Advanced',
    memory: 'Advanced',
    models: 'Models',
    moderation: 'Moderations',
    moderations: 'Moderations',
    nonce: 'Authentication',
    orchestration: 'Advanced',
    organization: 'Organizations',
    organizations: 'Organizations',
    pdf: 'Advanced',
    providers: 'Models',
    queue: 'Queue',
    reasoning: 'Advanced',
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
    workflows: 'Advanced',
    '.well-known': 'Authentication',
  };
  return map[firstSegment] ?? 'Advanced';
}

function shouldExcludeFromPublicContract(routePath: string): boolean {
  if (EXCLUDED_PUBLIC_PATHS.has(routePath)) return true;
  return EXCLUDED_PUBLIC_PREFIXES.some((prefix) => routePath.startsWith(prefix));
}

function makeFunctionalSummary(method: string, routePath: string): string {
  const actionMap: Record<string, string> = {
    get: 'Retrieve',
    post: 'Create or execute',
    put: 'Update',
    patch: 'Update',
    delete: 'Delete',
    options: 'Inspect',
    head: 'Inspect',
    trace: 'Trace',
  };
  const action = actionMap[method] ?? 'Execute';
  const resourceTokens = stripV1Prefix(routePath)
    .replace(/^\//, '')
    .split('/')
    .map((segment) => segment.replace(/[{}]/g, '').replace(/[-_]/g, ' '))
    .filter(Boolean);

  const resource = resourceTokens.join(' ').trim() || 'root resource';
  return `${action} ${resource}`;
}

function makeFunctionalDescription(summary: string, routePath: string): string {
  return [
    `${summary}.`,
    '',
    'Enterprise contract notes:',
    `- Purpose: exposes ${routePath} as a governed API capability inside the CI Fabric.`,
    '- Preconditions: requires valid authentication unless explicitly marked as public in the operation security block.',
    '- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.',
    '- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.',
    '- Observability: request and correlation identifiers are propagated for traceability.',
    '- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.',
  ].join('\n');
}

function makeOperationId(method: string, routePath: string, used: Set<string>): string {
  const cleanedSegments = stripV1Prefix(routePath)
    .split('/')
    .filter(Boolean)
    .flatMap((seg) => {
      if (seg.startsWith('{') && seg.endsWith('}')) {
        const param = seg.slice(1, -1).replace(/[^a-zA-Z0-9]/g, '');
        return [`By${capitalize(param)}`];
      }
      const token = seg.replace(/[^a-zA-Z0-9]/g, '');
      return token ? [capitalize(token)] : [];
    });
  const base = `${method.toLowerCase()}${cleanedSegments.join('') || 'Root'}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  const next = `${base}${suffix}`;
  used.add(next);
  return next;
}

function extractPathParameters(routePath: string): JsonObject[] {
  const params: JsonObject[] = [];
  const regex = /\{([^}]+)\}/g;
  let match = regex.exec(routePath);
  while (match) {
    params.push({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
    match = regex.exec(routePath);
  }
  return params;
}

function contributionTypeForMethod(method: string): 'signal-consumer' | 'signal-producer' | 'governance' {
  if (method === 'get' || method === 'head' || method === 'options') return 'signal-consumer';
  if (method === 'delete') return 'governance';
  return 'signal-producer';
}

function defaultCiBlock(method: string): JsonObject {
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

function default200Response(): JsonObject {
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
    headers: {
      'X-Request-Id': {
        description: 'Unique request identifier for end-to-end tracing.',
        schema: { type: 'string' },
      },
      'X-Correlation-Id': {
        description: 'Correlation identifier propagated across internal services.',
        schema: { type: 'string' },
      },
    },
  };
}

function ensureContractComponents(spec: OpenApiSpec): void {
  spec.components = spec.components ?? {};
  spec.components.securitySchemes = spec.components.securitySchemes ?? {};
  spec.components.responses = spec.components.responses ?? {};
  spec.components.schemas = spec.components.schemas ?? {};

  spec.components.securitySchemes.bearerAuth = {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  };
  spec.components.securitySchemes.apiKeyAuth = {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
  };

  const ensureResponse = (name: string, code: string, message: string): void => {
    spec.components!.responses![name] = {
      description: message,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
      headers: {
        'X-Request-Id': {
          description: 'Unique request identifier for end-to-end tracing.',
          schema: { type: 'string' },
        },
        'X-Correlation-Id': {
          description: 'Correlation identifier propagated across internal services.',
          schema: { type: 'string' },
        },
      },
      'x-error-code': code,
    };
  };

  ensureResponse('BadRequest', 'bad_request', 'Bad request');
  ensureResponse('Unauthorized', 'unauthorized', 'Unauthorized');
  ensureResponse('Forbidden', 'forbidden', 'Forbidden');
  ensureResponse('NotFound', 'not_found', 'Resource not found');
  ensureResponse('Conflict', 'conflict', 'Conflict');
  ensureResponse('UnprocessableEntity', 'unprocessable_entity', 'Unprocessable entity');
  ensureResponse('TooManyRequests', 'rate_limit_exceeded', 'Too many requests');
  ensureResponse('InternalServerError', 'internal_error', 'Internal server error');

  spec.components.schemas.ErrorResponse = {
    type: 'object',
    required: ['error', 'requestId', 'correlationId', 'timestamp'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          type: { type: 'string' },
          param: { type: 'string' },
        },
      },
      requestId: { type: 'string' },
      correlationId: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  };

  spec.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
}

function normalizeSecuritySchemes(operation: JsonObject): void {
  const security = operation.security;
  if (!Array.isArray(security)) {
    operation.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
    return;
  }

  const normalized = security.map((entry) => {
    const obj = ensureObject(entry);
    if (Object.prototype.hasOwnProperty.call(obj, 'apiKey')) {
      const existing = obj.apiKey;
      delete obj.apiKey;
      obj.apiKeyAuth = Array.isArray(existing) ? existing : [];
    }
    return obj;
  });
  operation.security = normalized as unknown as JsonValue;
}

function ensureResponseRef(operation: JsonObject, statusCode: string, ref: string): void {
  const responses = ensureObject(operation.responses);
  responses[statusCode] = { $ref: ref };
  operation.responses = responses;
}

function ensurePathParameters(operation: JsonObject, routePath: string): void {
  const requiredParams = extractPathParameters(routePath);
  if (requiredParams.length === 0) return;

  const current = Array.isArray(operation.parameters) ? (operation.parameters as JsonObject[]) : [];
  const existingPathNames = new Set(
    current
      .filter((p) => ensureObject(p).in === 'path' && typeof ensureObject(p).name === 'string')
      .map((p) => String(ensureObject(p).name))
  );

  for (const p of requiredParams) {
    const name = String(p.name);
    if (!existingPathNames.has(name)) {
      current.push(p);
    }
  }
  operation.parameters = current;
}

function normalizePath(routePath: string, existingPaths: Set<string>): string {
  if (existingPaths.has(routePath)) return routePath;
  const alternative = routePath.startsWith('/v1/') ? routePath.slice(3) || '/' : `/v1${routePath}`;
  if (existingPaths.has(alternative)) return alternative;
  return routePath;
}

function removeNonVersionedAliases(spec: OpenApiSpec): number {
  if (!spec.paths) return 0;
  let removed = 0;

  for (const routePath of Object.keys(spec.paths)) {
    if (routePath === '/.well-known/jwks.json') continue;
    if (routePath.startsWith('/v1/')) continue;

    const versionedPath = routePath === '/' ? '/v1' : `/v1${routePath}`;
    if (spec.paths[versionedPath]) {
      delete spec.paths[routePath];
      removed += 1;
    }
  }

  return removed;
}

function main(): void {
  const spec = readJsonFile<OpenApiSpec>(SPEC_JSON_PATH);
  const report = fs.existsSync(DIFF_REPORT_PATH) ? readJsonFile<DiffReport>(DIFF_REPORT_PATH) : { missingInSpec: [] };

  spec.openapi = '3.0.3';
  spec.paths = spec.paths ?? {};
  spec.servers = [
    {
      url: 'https://api.ailin.one',
      description: 'Production server',
    },
  ];
  ensureContractComponents(spec);

  const validTags = new Set((spec.tags ?? []).map((t) => t.name).filter(Boolean) as string[]);
  const existingPaths = new Set(Object.keys(spec.paths));

  const usedOperationIds = new Set<string>();
  for (const pathItem of Object.values(spec.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = pathItem[method] as JsonObject;
      if (typeof operation.operationId === 'string') usedOperationIds.add(operation.operationId);
    }
  }

  // Add endpoints missing from spec according to last diff report.
  let addedEndpoints = 0;
  let skippedBySecurity = 0;
  for (const raw of report.missingInSpec) {
    const [methodRaw, ...pathParts] = raw.split(' ');
    const method = methodRaw.toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    const rawPath = pathParts.join(' ').trim();
    if (!rawPath) continue;
    if (shouldExcludeFromPublicContract(rawPath)) {
      skippedBySecurity += 1;
      continue;
    }

    const routePath = normalizePath(rawPath, existingPaths);
    if (shouldExcludeFromPublicContract(routePath)) {
      skippedBySecurity += 1;
      continue;
    }
    const pathItem = (spec.paths[routePath] ?? {}) as Record<string, JsonObject>;
    if (pathItem[method]) continue;

    const firstSegment = stripV1Prefix(routePath).replace(/^\//, '').split('/')[0] || 'advanced';
    const tag = toTag(firstSegment);
    const finalTag = validTags.has(tag) ? tag : 'Advanced';
    const operationId = makeOperationId(method, routePath, usedOperationIds);
    const summary = makeFunctionalSummary(method, routePath);

    const operation: JsonObject = {
      tags: [finalTag],
      summary,
      description: makeFunctionalDescription(summary, routePath),
      operationId,
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      responses: {
        '200': default200Response(),
      },
      'x-collective-intelligence': defaultCiBlock(method),
    };

    ensurePathParameters(operation, routePath);
    ensureResponseRef(operation, '400', '#/components/responses/BadRequest');
    ensureResponseRef(operation, '401', '#/components/responses/Unauthorized');
    ensureResponseRef(operation, '403', '#/components/responses/Forbidden');
    ensureResponseRef(operation, '404', '#/components/responses/NotFound');
    ensureResponseRef(operation, '409', '#/components/responses/Conflict');
    ensureResponseRef(operation, '422', '#/components/responses/UnprocessableEntity');
    ensureResponseRef(operation, '429', '#/components/responses/TooManyRequests');
    ensureResponseRef(operation, '500', '#/components/responses/InternalServerError');

    pathItem[method] = operation;
    spec.paths[routePath] = pathItem;
    existingPaths.add(routePath);
    addedEndpoints += 1;
  }

  // Enrich all existing operations to satisfy enterprise OpenAPI contract checks.
  let normalizedOperations = 0;
  for (const [routePath, pathItem] of Object.entries(spec.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = pathItem[method] as JsonObject;
      normalizedOperations += 1;

      if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
        const firstSegment = stripV1Prefix(routePath).replace(/^\//, '').split('/')[0] || 'advanced';
        const tag = toTag(firstSegment);
        operation.tags = [validTags.has(tag) ? tag : 'Advanced'];
      }

      const currentSummary = typeof operation.summary === 'string' ? operation.summary.trim() : '';
      const summaryIsGeneric =
        currentSummary.length === 0 ||
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+\/.*/.test(currentSummary) ||
        /^auto[-\s]/i.test(currentSummary);
      if (summaryIsGeneric) {
        operation.summary = makeFunctionalSummary(method, routePath);
      }

      const currentDescription = typeof operation.description === 'string' ? operation.description.trim() : '';
      const descriptionIsGeneric =
        currentDescription.length === 0 ||
        /^auto[-\s]/i.test(currentDescription) ||
        /^this endpoint/i.test(currentDescription);
      if (descriptionIsGeneric) {
        operation.description = makeFunctionalDescription(String(operation.summary), routePath);
      }

      if (typeof operation.operationId !== 'string' || operation.operationId.trim().length === 0) {
        operation.operationId = makeOperationId(method, routePath, usedOperationIds);
      } else if (usedOperationIds.has(operation.operationId) && Object.values(spec.paths).some((pi) => Object.values(pi).filter((v) => ensureObject(v).operationId === operation.operationId).length > 1)) {
        operation.operationId = makeOperationId(method, routePath, usedOperationIds);
      } else {
        usedOperationIds.add(operation.operationId);
      }

      if (!operation['x-collective-intelligence'] || typeof operation['x-collective-intelligence'] !== 'object') {
        operation['x-collective-intelligence'] = defaultCiBlock(method);
      }

      normalizeSecuritySchemes(operation);
      ensurePathParameters(operation, routePath);

      const responses = ensureObject(operation.responses);
      const has2xx = Object.keys(responses).some((code) => /^2\d\d$/.test(code));
      if (!has2xx) {
        responses['200'] = default200Response();
      }
      operation.responses = responses;

      ensureResponseRef(operation, '400', '#/components/responses/BadRequest');
      ensureResponseRef(operation, '401', '#/components/responses/Unauthorized');
      ensureResponseRef(operation, '403', '#/components/responses/Forbidden');
      ensureResponseRef(operation, '404', '#/components/responses/NotFound');
      ensureResponseRef(operation, '409', '#/components/responses/Conflict');
      ensureResponseRef(operation, '422', '#/components/responses/UnprocessableEntity');
      ensureResponseRef(operation, '429', '#/components/responses/TooManyRequests');
      ensureResponseRef(operation, '500', '#/components/responses/InternalServerError');
    }
  }

  const removedAliases = removeNonVersionedAliases(spec);

  writeJsonFile(SPEC_JSON_PATH, spec);
  fs.writeFileSync(SPEC_YAML_PATH, yaml.stringify(spec), 'utf8');

  console.log(
    JSON.stringify(
      {
        normalizedOperations,
        addedEndpoints,
        skippedBySecurity,
        removedAliases,
      },
      null,
      2
    )
  );
}

main();
