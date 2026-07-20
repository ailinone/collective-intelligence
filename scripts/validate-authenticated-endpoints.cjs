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
const SPEC_PATH = path.resolve(ROOT, 'openapi-spec.json');
const REPORTS_DIR = path.resolve(ROOT, 'reports');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const DEFAULT_TIMEOUT_MS = Number(process.env.ENDPOINT_VALIDATION_TIMEOUT_MS || 15000);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.ENDPOINT_VALIDATION_CONCURRENCY || 6));
const DEFAULT_BASE_URL = process.env.API_BASE_URL || 'https://api.ailin.one';
const SWEEP_MODE = process.env.ENDPOINT_SWEEP_AUTH_MODE || 'staging_full_prod_readonly';

const AUTH_BEARER_TOKEN =
  process.env.ENDPOINT_SWEEP_BEARER_TOKEN ||
  process.env.AILIN_EVAL_BEARER_TOKEN ||
  process.env.AILIN_TOKEN ||
  '';
const AUTH_API_KEY =
  process.env.ENDPOINT_SWEEP_API_KEY || process.env.AILIN_EVAL_API_KEY || process.env.AILIN_API_KEY || '';

const PRODUCTION_HOST_PATTERNS = [/^api\.ailin\.one$/i];
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeSampleForSchema(schema) {
  if (!schema || typeof schema !== 'object') return 'sample';
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = schema.type;
  if (type === 'string') {
    if (schema.format === 'uuid') return '123e4567-e89b-12d3-a456-426614174000';
    if (schema.format === 'email') return 'user@example.com';
    if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
    if (schema.format === 'date') return '2026-01-01';
    return 'sample';
  }
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') {
    const item = makeSampleForSchema(schema.items);
    return item === undefined ? [] : [item];
  }
  if (type === 'object') {
    const result = {};
    const required = new Set(toArray(schema.required));
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (required.has(key)) {
        result[key] = makeSampleForSchema(propSchema);
      }
    }
    return result;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return makeSampleForSchema(schema.oneOf[0]);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return makeSampleForSchema(schema.anyOf[0]);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return makeSampleForSchema(schema.allOf[0]);
  }

  return 'sample';
}

function resolveSchemaMaybeRef(spec, schemaOrRef) {
  if (!schemaOrRef || typeof schemaOrRef !== 'object') return null;
  if (schemaOrRef.$ref && typeof schemaOrRef.$ref === 'string') {
    const match = schemaOrRef.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (!match) return null;
    return spec.components?.schemas?.[match[1]] || null;
  }
  return schemaOrRef;
}

function resolveRequestBody(operation, spec) {
  const requestBody = operation.requestBody && typeof operation.requestBody === 'object' ? operation.requestBody : null;
  if (!requestBody) return { body: undefined, contentType: null };

  const content = requestBody.content && typeof requestBody.content === 'object' ? requestBody.content : {};
  const jsonContent = content['application/json'];
  if (jsonContent && typeof jsonContent === 'object') {
    const schema = resolveSchemaMaybeRef(spec, jsonContent.schema);
    if (!schema) return { body: '{}', contentType: 'application/json' };
    const sample = makeSampleForSchema(schema);
    return { body: JSON.stringify(sample ?? {}), contentType: 'application/json' };
  }

  const formContent = content['multipart/form-data'];
  if (formContent && typeof formContent === 'object') {
    return { body: undefined, contentType: null };
  }

  return { body: undefined, contentType: null };
}

function resolveSecurity(spec, pathItem, operation) {
  if (Array.isArray(operation.security)) return operation.security;
  if (Array.isArray(pathItem.security)) return pathItem.security;
  if (Array.isArray(spec.security)) return spec.security;
  return [];
}

function normalizeSecurityRequirements(security) {
  if (!Array.isArray(security)) return [];
  return security.filter((item) => item && typeof item === 'object');
}

function canSatisfySecurityRequirement(requirement, credentials) {
  const schemes = Object.keys(requirement || {});
  if (schemes.length === 0) return true;
  return schemes.every((scheme) => {
    if (scheme === 'bearerAuth') return Boolean(credentials.bearerToken);
    if (scheme === 'apiKeyAuth') return Boolean(credentials.apiKey);
    return false;
  });
}

function scoreSecurityRequirement(requirement, credentials) {
  const schemes = Object.keys(requirement || {});
  const usesApiKey = schemes.includes('apiKeyAuth') && Boolean(credentials.apiKey);
  const usesBearer = schemes.includes('bearerAuth') && Boolean(credentials.bearerToken);
  if (usesApiKey && !usesBearer) return 0;
  if (usesApiKey && usesBearer) return 1;
  if (usesBearer) return 2;
  return 3;
}

function selectAuthForOperation(record, context) {
  if (record.isPublic || !context.authEnabled) {
    return { headers: {}, usedAuth: false, missingRequiredAuth: false };
  }

  const availableRequirements = record.securityRequirements.filter((entry) =>
    canSatisfySecurityRequirement(entry, { bearerToken: context.bearerToken, apiKey: context.apiKey })
  );
  const requirement =
    availableRequirements.length > 0
      ? availableRequirements.sort(
          (a, b) =>
            scoreSecurityRequirement(a, { bearerToken: context.bearerToken, apiKey: context.apiKey }) -
            scoreSecurityRequirement(b, { bearerToken: context.bearerToken, apiKey: context.apiKey })
        )[0]
      : null;

  if (!requirement) {
    return { headers: {}, usedAuth: false, missingRequiredAuth: true };
  }

  const headers = {};
  if (Object.prototype.hasOwnProperty.call(requirement, 'bearerAuth') && context.bearerToken) {
    headers.Authorization = `Bearer ${context.bearerToken}`;
  }
  if (Object.prototype.hasOwnProperty.call(requirement, 'apiKeyAuth') && context.apiKey) {
    headers['X-API-Key'] = context.apiKey;
  }

  return {
    headers,
    usedAuth: Object.keys(headers).length > 0,
    missingRequiredAuth: false,
  };
}

function resolvePathWithParams(openApiPath, params) {
  return openApiPath.replace(/\{([^}]+)\}/g, (_all, name) => {
    const param = params.find((item) => item.in === 'path' && item.name === name);
    if (!param) return 'sample';
    if (param.example !== undefined) return String(param.example);

    const schema = param.schema && typeof param.schema === 'object' ? param.schema : null;
    if (schema && schema.example !== undefined) return String(schema.example);
    if (name === 'capability') return 'chat';
    if (schema?.format === 'uuid') return '123e4567-e89b-12d3-a456-426614174000';
    if (schema?.type === 'integer' || schema?.type === 'number') return '1';
    if (Array.isArray(schema?.enum) && schema.enum.length > 0) return String(schema.enum[0]);
    if (name.toLowerCase().includes('id')) return '123e4567-e89b-12d3-a456-426614174000';
    return 'sample';
  });
}

function getExpectedStatusSet(operation) {
  const responses = operation.responses && typeof operation.responses === 'object' ? operation.responses : {};
  const direct = new Set();
  const ranges = [];
  let hasDefault = false;
  for (const key of Object.keys(responses)) {
    if (/^\d{3}$/.test(key)) {
      direct.add(Number(key));
    } else if (/^\dXX$/i.test(key)) {
      ranges.push(key.toUpperCase());
    } else if (key.toLowerCase() === 'default') {
      hasDefault = true;
    }
  }
  return { direct, ranges, hasDefault };
}

function isStatusDocumented(expected, status) {
  if (expected.direct.has(status)) return true;
  for (const range of expected.ranges) {
    const prefix = Number(range[0]);
    if (Math.floor(status / 100) === prefix) return true;
  }
  return expected.hasDefault;
}

function isProductionTarget(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

function buildOperationRecords(spec, baseUrl) {
  const records = [];

  for (const [openApiPath, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const pathParams = toArray(pathItem.parameters).filter(Boolean);

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      const operationParams = toArray(operation.parameters).filter(Boolean);
      const allParams = [...pathParams, ...operationParams];
      const resolvedPath = resolvePathWithParams(openApiPath, allParams);
      const url = `${baseUrl}${resolvedPath}`;
      const security = normalizeSecurityRequirements(resolveSecurity(spec, pathItem, operation));
      const isPublic = security.length === 0;

      records.push({
        method: method.toUpperCase(),
        path: openApiPath,
        resolvedPath,
        operationId: operation.operationId || null,
        isPublic,
        securityRequirements: security,
        url,
        expectedStatus: getExpectedStatusSet(operation),
        operation,
      });
    }
  }

  return records;
}

function compactBodyPreview(text, limit = 280) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function classifyOutcome(record, responseText, statusCode, usedAuth) {
  const lowerBody = String(responseText || '').toLowerCase();
  const issues = [];

  if (record.path === '/.well-known/jwks.json' && statusCode === 503 && lowerBody.includes('jwks not enabled')) {
    return { outcome: 'validation_expected', issues, statusDocumented: true };
  }

  if (
    statusCode === 404 &&
    ((lowerBody.includes('route ') && lowerBody.includes(' not found')) ||
      (lowerBody.includes('<title>404 not found</title>') && lowerBody.includes('nginx')))
  ) {
    return { outcome: 'issue', issues: ['route_unavailable'], statusDocumented: false };
  }

  const statusDocumented = isStatusDocumented(record.expectedStatus, statusCode);
  if (!statusDocumented) {
    issues.push('undocumented_status');
  }

  if (statusCode >= 200 && statusCode < 300) {
    return { outcome: 'ok', issues, statusDocumented };
  }

  if (statusCode === 401 || statusCode === 403) {
    if (record.isPublic) {
      issues.push('public_requires_auth');
      return { outcome: 'issue', issues, statusDocumented };
    }
    if (
      statusCode === 403 &&
      usedAuth &&
      (lowerBody.includes('insufficient permissions') ||
        lowerBody.includes('do not have permission') ||
        lowerBody.includes('not a member of this organization') ||
        lowerBody.includes('forbidden'))
    ) {
      return { outcome: 'auth_expected', issues, statusDocumented };
    }
    if (usedAuth) {
      issues.push('auth_failed');
      return { outcome: 'issue', issues, statusDocumented };
    }
    return { outcome: 'auth_expected', issues, statusDocumented };
  }

  if (statusCode >= 500) {
    issues.push('server_error');
    return { outcome: 'issue', issues, statusDocumented };
  }

  if (statusCode === 429) {
    return { outcome: 'validation_expected', issues, statusDocumented };
  }

  if (statusCode >= 400 && statusCode < 500) {
    return { outcome: 'validation_expected', issues, statusDocumented };
  }

  return { outcome: 'issue', issues: ['unexpected_status', ...issues], statusDocumented };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function runOperation(record, spec, context) {
  const headers = {
    Accept: 'application/json',
  };
  const authSelection = selectAuthForOperation(record, context);
  Object.assign(headers, authSelection.headers);
  const usedAuth = authSelection.usedAuth;

  if (
    context.mode === 'staging_full_prod_readonly' &&
    context.isProduction &&
    !READ_ONLY_METHODS.has(record.method)
  ) {
    return {
      method: record.method,
      path: record.path,
      resolvedPath: record.resolvedPath,
      operationId: record.operationId,
      isPublic: record.isPublic,
      outcome: 'skipped_prod_readonly',
      issues: [],
      final: {
        ok: true,
        status: 0,
        statusText: 'skipped',
        elapsedMs: 0,
        requestId: null,
        gatewayId: null,
        contentType: null,
        bodyPreview: 'Skipped by production read-only policy',
        url: record.url,
        testPath: record.resolvedPath,
      },
    };
  }

  if (!record.isPublic && context.authEnabled && authSelection.missingRequiredAuth) {
    return {
      method: record.method,
      path: record.path,
      resolvedPath: record.resolvedPath,
      operationId: record.operationId,
      isPublic: record.isPublic,
      outcome: 'skipped_auth_missing',
      issues: ['auth_missing'],
      final: {
        ok: true,
        status: 0,
        statusText: 'skipped',
        elapsedMs: 0,
        requestId: null,
        gatewayId: null,
        contentType: null,
        bodyPreview: 'Skipped protected endpoint (no matching credentials for declared security requirements)',
        url: record.url,
        testPath: record.resolvedPath,
      },
    };
  }

  const hasBodyMethod = ['POST', 'PUT', 'PATCH'].includes(record.method);
  let body;
  if (hasBodyMethod) {
    const resolved = resolveRequestBody(record.operation, spec);
    body = resolved.body;
    if (resolved.contentType) headers['Content-Type'] = resolved.contentType;
  }

  const start = Date.now();
  try {
    const response = await fetchWithTimeout(
      record.url,
      {
        method: record.method,
        headers,
        body,
      },
      DEFAULT_TIMEOUT_MS
    );
    const elapsedMs = Date.now() - start;
    const responseText = await response.text();
    const contentType = response.headers.get('content-type') || null;
    const requestId = response.headers.get('x-request-id') || null;
    const gatewayId = response.headers.get('x-gateway-id') || null;

    const classified = classifyOutcome(record, responseText, response.status, usedAuth);

    return {
      method: record.method,
      path: record.path,
      resolvedPath: record.resolvedPath,
      operationId: record.operationId,
      isPublic: record.isPublic,
      outcome: classified.outcome,
      issues: classified.issues,
      statusDocumented: classified.statusDocumented,
      final: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        elapsedMs,
        requestId,
        gatewayId,
        contentType,
        bodyPreview: compactBodyPreview(responseText),
        url: record.url,
        testPath: record.resolvedPath,
      },
    };
  } catch (error) {
    const elapsedMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      method: record.method,
      path: record.path,
      resolvedPath: record.resolvedPath,
      operationId: record.operationId,
      isPublic: record.isPublic,
      outcome: 'issue',
      issues: ['network_error'],
      statusDocumented: false,
      final: {
        ok: false,
        status: 0,
        statusText: 'network_error',
        elapsedMs,
        requestId: null,
        gatewayId: null,
        contentType: null,
        bodyPreview: errorMessage,
        url: record.url,
        testPath: record.resolvedPath,
      },
    };
  }
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = [];
  let index = 0;
  async function runner() {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

function summarize(results, context) {
  const summary = {
    timestamp: new Date().toISOString(),
    serverUrl: context.baseUrl,
    sweepMode: context.mode,
    authEnabled: context.authEnabled,
    isProductionTarget: context.isProduction,
    totalOperations: results.length,
    byOutcome: {},
    issueCounts: {},
    statusCounts: {},
    publicOps: 0,
    protectedOps: 0,
  };

  for (const item of results) {
    if (item.isPublic) summary.publicOps += 1;
    else summary.protectedOps += 1;
    summary.byOutcome[item.outcome] = (summary.byOutcome[item.outcome] || 0) + 1;
    summary.statusCounts[item.final.status] = (summary.statusCounts[item.final.status] || 0) + 1;
    for (const issue of item.issues || []) {
      summary.issueCounts[issue] = (summary.issueCounts[issue] || 0) + 1;
    }
  }
  return summary;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  if (!fs.existsSync(SPEC_PATH)) {
    throw new Error(`Missing OpenAPI spec at ${SPEC_PATH}`);
  }
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const records = buildOperationRecords(spec, DEFAULT_BASE_URL);
  const context = {
    baseUrl: DEFAULT_BASE_URL,
    mode: SWEEP_MODE,
    authEnabled: SWEEP_MODE !== 'unauthenticated',
    isProduction: isProductionTarget(DEFAULT_BASE_URL),
    bearerToken: AUTH_BEARER_TOKEN,
    apiKey: AUTH_API_KEY,
  };

  const results = await runWithConcurrency(records, (record) => runOperation(record, spec, context), MAX_CONCURRENCY);
  const summary = summarize(results, context);
  const report = { summary, results };

  ensureDir(REPORTS_DIR);
  const timestamp = summary.timestamp.replace(/[:.]/g, '-');
  const datedPath = path.join(REPORTS_DIR, `authenticated-endpoint-validation-${timestamp}.json`);
  const latestPath = path.join(REPORTS_DIR, 'authenticated-endpoint-validation-latest.json');
  writeJson(datedPath, report);
  writeJson(latestPath, report);

  console.log(
    JSON.stringify(
      {
        generated: true,
        datedReport: path.relative(ROOT, datedPath),
        latestReport: path.relative(ROOT, latestPath),
        summary,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
