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

function resolveResponseCodeKey(operation) {
  const responses = operation.responses && typeof operation.responses === 'object' ? operation.responses : {};
  if (responses['200']) return '200';
  if (responses['201']) return '201';
  if (responses['202']) return '202';
  if (responses.default) return 'default';
  const keys = Object.keys(responses);
  return keys.length > 0 ? keys[0] : null;
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

function resolvePathWithParams(openApiPath, params) {
  return openApiPath.replace(/\{([^}]+)\}/g, (_all, name) => {
    const param = params.find((item) => item.in === 'path' && item.name === name);
    if (!param) return 'sample';
    if (param.example !== undefined) return String(param.example);

    const schema = param.schema && typeof param.schema === 'object' ? param.schema : null;
    if (schema && schema.example !== undefined) return String(schema.example);

    if (schema?.format === 'uuid') return '123e4567-e89b-12d3-a456-426614174000';
    if (schema?.type === 'integer' || schema?.type === 'number') return '1';
    if (Array.isArray(schema?.enum) && schema.enum.length > 0) return String(schema.enum[0]);
    if (name.toLowerCase().includes('id')) return 'sample';
    return 'sample';
  });
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
      const security = resolveSecurity(spec, pathItem, operation);
      const isPublic = Array.isArray(security) && security.length === 0;

      records.push({
        method: method.toUpperCase(),
        path: openApiPath,
        resolvedPath,
        operationId: operation.operationId || null,
        isPublic,
        url,
        expectedResponseCode: resolveResponseCodeKey(operation),
        operation,
      });
    }
  }

  return records;
}

function classifyOutcome(record, responseText, statusCode) {
  const lowerBody = String(responseText || '').toLowerCase();
  const issues = [];
  let outcome = 'issue';

  if (statusCode >= 200 && statusCode < 300) {
    if (record.isPublic) {
      outcome = 'ok';
    } else {
      issues.push('protected_without_auth');
      outcome = 'issue';
    }
    return { outcome, issues };
  }

  if (statusCode === 401 || statusCode === 403) {
    if (record.isPublic) {
      issues.push('public_requires_auth');
      outcome = 'issue';
    } else {
      outcome = 'auth_expected';
    }
    return { outcome, issues };
  }

  if (statusCode === 400 || statusCode === 422) {
    outcome = 'validation_expected';
    return { outcome, issues };
  }

  if (statusCode === 429) {
    outcome = record.isPublic ? 'validation_expected' : 'auth_expected';
    return { outcome, issues };
  }

  if (statusCode === 404) {
    if (lowerBody.includes('route ') && lowerBody.includes(' not found')) {
      issues.push('route_unavailable');
      outcome = 'issue';
      return { outcome, issues };
    }
    if (lowerBody.includes('<title>404 not found</title>') && lowerBody.includes('nginx')) {
      issues.push('route_unavailable');
      outcome = 'issue';
      return { outcome, issues };
    }
    if (lowerBody.includes('"code":"model_not_found"')) {
      outcome = 'validation_expected';
      return { outcome, issues };
    }
    outcome = 'validation_expected';
    return { outcome, issues };
  }

  if (statusCode >= 500) {
    if (
      statusCode === 503 &&
      record.path === '/.well-known/jwks.json' &&
      lowerBody.includes('jwks not enabled')
    ) {
      outcome = 'validation_expected';
      return { outcome, issues };
    }
    issues.push('server_error');
    outcome = 'issue';
    return { outcome, issues };
  }

  issues.push('unexpected_status');
  outcome = 'issue';
  return { outcome, issues };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function compactBodyPreview(text, limit = 280) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

async function runOperation(record, spec) {
  const headers = {
    Accept: 'application/json',
  };

  const hasBodyMethod = ['POST', 'PUT', 'PATCH'].includes(record.method);
  let body;
  if (hasBodyMethod) {
    const resolved = resolveRequestBody(record.operation, spec);
    body = resolved.body;
    if (resolved.contentType) {
      headers['Content-Type'] = resolved.contentType;
    }
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

    const { outcome, issues } = classifyOutcome(record, responseText, response.status);

    return {
      method: record.method,
      path: record.path,
      resolvedPath: record.resolvedPath,
      operationId: record.operationId,
      isPublic: record.isPublic,
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
      outcome,
      issues,
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
      outcome: 'issue',
      issues: ['network_error'],
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
      const result = await worker(items[current], current);
      results[current] = result;
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

function summarize(results, baseUrl) {
  const summary = {
    timestamp: new Date().toISOString(),
    serverUrl: baseUrl,
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

  const rawSpec = fs.readFileSync(SPEC_PATH, 'utf8');
  const spec = JSON.parse(rawSpec);

  const records = buildOperationRecords(spec, DEFAULT_BASE_URL);
  const results = await runWithConcurrency(records, (record) => runOperation(record, spec), MAX_CONCURRENCY);
  const summary = summarize(results, DEFAULT_BASE_URL);

  const report = { summary, results };
  ensureDir(REPORTS_DIR);

  const timestamp = summary.timestamp.replace(/[:.]/g, '-');
  const datedPath = path.join(REPORTS_DIR, `production-endpoint-validation-${timestamp}.json`);
  const latestPath = path.join(REPORTS_DIR, 'production-endpoint-validation-latest.json');
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
