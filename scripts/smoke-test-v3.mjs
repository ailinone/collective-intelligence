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
 * Smoke-test v2 — payload-perfect, ID-aware, multipart-aware.
 *
 * Strategy:
 *  - Pass 0: harvest IDs (file, thread, vector_store, assistant, memory) by
 *    creating real resources we'll re-use.
 *  - Pass 1: probe every operation. Build body from:
 *      1. BODY_OVERRIDES[METHOD path]            — hand-tuned, always wins
 *      2. route-schemas.json (scraped Fastify)   — ground truth from code
 *      3. OpenAPI spec body                       — fallback
 *      4. {} for missing schema                   — last resort
 *  - Multipart: handled inline for /v1/files (POST), /v1/audio/*, /v1/images/edits.
 *  - Per-endpoint timeouts: long-running model calls get 90s, others 30s.
 *  - Required querystring: synthesized from route-schemas and OpenAPI.
 *
 * Usage:
 *   AILIN_JWT=$(cat /tmp/fresh-jwt.txt) node scripts/smoke-test-v2.mjs
 *
 * No admin-key routing (see v4 for that) — any /v1/admin/* or /v1/users*
 * probe here runs with regular user credentials against AILIN_BASE and is
 * expected to fail auth regardless of host. Admin routes are also no longer
 * part of the public contract (2026-07-14); use smoke-test-v4.mjs with
 * AILIN_ADMIN_KEY + AILIN_ADMIN_BASE for real admin-path coverage.
 */
import fs from 'node:fs';

const SPEC_PATH = process.env.SPEC_PATH || './openapi-spec.json';
const ROUTE_SCHEMAS_PATH = './scripts/route-schemas.json';
const BASE = process.env.AILIN_BASE || 'https://api.ailin.one';
const JWT = process.env.AILIN_JWT || null;
const API_KEY = process.env.AILIN_API_KEY || null;
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const OUT = process.env.OUT || './smoke-test-v3-results.json';
// Pace request starts to respect server rate limits and honour Retry-After.
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 1200);
const MAX_RETRIES_429 = Number(process.env.MAX_RETRIES_429 || 4);
const MAX_RETRY_AFTER_MS = Number(process.env.MAX_RETRY_AFTER_MS || 8000);

if (!JWT && !API_KEY) {
  console.error('ERROR: set AILIN_JWT or AILIN_API_KEY');
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const routeSchemas = JSON.parse(fs.readFileSync(ROUTE_SCHEMAS_PATH, 'utf8'));

// Convert Fastify path syntax (`:foo`) to OpenAPI (`{foo}`)
function fastifyToOpenapiPath(p) {
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}
const routeSchemasNorm = {};
for (const [k, v] of Object.entries(routeSchemas)) {
  const [m, ...rest] = k.split(' ');
  const p = rest.join(' ');
  routeSchemasNorm[`${m} ${fastifyToOpenapiPath(p)}`] = v;
}

// ─────────────────────────────────────────────
// Skip lists
// ─────────────────────────────────────────────
const SKIP_PATHS = new Set([
  '/v1/auth/logout',
  '/v1/auth/refresh',
  '/v1/auth/register',
  '/v1/auth/login',
  '/v1/auth/login-with-code',
  '/v1/auth/challenge',
  '/v1/auth/email-challenge',
  '/v1/auth/api-keys',
]);

const SKIP_METHOD_PATHS = new Set([
  'DELETE /v1/admin/users/{id}',
  'DELETE /v1/organizations/{id}',
  'DELETE /v1/api-keys/{keyId}',
  'POST /v1/admin/api-keys/rotate/{keyId}',
  'POST /v1/api-keys/{keyId}/rotate',
  'POST /v1/enterprise/billing/invoices/{invoiceId}/pay',
  'POST /v1/enterprise/billing/subscriptions',
  'DELETE /v1/enterprise/billing/payment-methods/{paymentMethodId}',
  'POST /v1/admin/api-keys/auto-rotate/enable',
  'POST /v1/admin/api-keys/auto-rotate/disable',
  'POST /v1/users/{id}/change-password',
  'PUT /v1/users/{id}',
  'PATCH /v1/users/{id}',
  'DELETE /v1/users/{id}',
  'POST /v1/auth/api-keys',
  'DELETE /v1/auth/api-keys/{id}',
]);

// ─────────────────────────────────────────────
// Per-endpoint timeouts (ms)
// ─────────────────────────────────────────────
const DEFAULT_TIMEOUT = 30000;
const SLOW_TIMEOUTS = {
  'POST /v1/chat/completions': 90000,
  'POST /v1/chat/completions/intelligent': 90000,
  'POST /v1/chat/completions/extended-thinking': 120000,
  'POST /v1/chat/completions/ultra-thinking': 120000,
  'POST /v1/responses': 90000,
  'POST /v1/embeddings': 60000,
  'POST /v1/embeddings/create': 60000,
  'POST /v1/audio/speech': 60000,
  'POST /v1/audio/transcriptions': 60000,
  'POST /v1/audio/translations': 60000,
  'POST /v1/images/generations': 120000,
  'POST /v1/images/edits': 120000,
  'POST /v1/images/variations': 120000,
  'POST /v1/videos/generations': 180000,
  'POST /v1/moderations': 30000,
  'POST /v1/translation/translate': 60000,
  'POST /v1/pdf/analyze': 90000,
  'POST /v1/search': 60000,
  'POST /v1/grounding/extract': 60000,
};
function timeoutFor(key) { return SLOW_TIMEOUTS[key] || DEFAULT_TIMEOUT; }

// ─────────────────────────────────────────────
// Body overrides (hand-tuned, always win)
// ─────────────────────────────────────────────
const BODY_OVERRIDES = {
  // Chat / completions / embeddings — small, fast prompts
  'POST /v1/chat/completions': { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
  'POST /v1/chat/completions/intelligent': { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
  'POST /v1/chat/completions/extended-thinking': { model: 'auto', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, thinking_budget: 256 },
  'POST /v1/chat/completions/ultra-thinking': { model: 'auto', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, thinking_budget: 256 },
  'POST /v1/embeddings': { model: 'text-embedding-3-small', input: 'ping' },
  'POST /v1/embeddings/create': { model: 'text-embedding-3-small', input: 'ping' },
  'POST /v1/responses': { model: 'gpt-4o-mini', input: 'ping' },
  'POST /v1/moderations': { input: 'ping', model: 'text-moderation-latest' },
  'POST /v1/audio/speech': { model: 'tts-1', voice: 'alloy', input: 'hi' },
  'POST /v1/images/generations': { model: 'dall-e-3', prompt: 'a red square', n: 1, size: '1024x1024' },
  'POST /v1/videos/generations': { prompt: 'a sunrise over mountains', model: 'auto', duration: 1, n: 1 },
  'POST /v1/translation/translate': { text: 'hello', target_language: 'pt', source_language: 'en' },
  'POST /v1/pdf/analyze': { __multipart__: true, fields: { prompt: 'ping', model: 'auto' }, files: { file: { filename: 'smoke.pdf', mime: 'application/pdf', body: '%PDF-1.4\n%smoke\n' } } },
  // Audio/Images multipart
  'POST /v1/audio/transcriptions': { __multipart__: true, fields: { model: 'whisper-1' }, files: { file: { filename: 'smoke.wav', mime: 'audio/wav', body: 'RIFF\u0024\u0000\u0000\u0000WAVEfmt' } } },
  'POST /v1/audio/translations': { __multipart__: true, fields: { model: 'whisper-1' }, files: { file: { filename: 'smoke.wav', mime: 'audio/wav', body: 'RIFF\u0024\u0000\u0000\u0000WAVEfmt' } } },
  'POST /v1/images/edits': { __multipart__: true, fields: { prompt: 'edit', model: 'dall-e-2', n: '1', size: '512x512' }, files: { image: { filename: 'smoke.png', mime: 'image/png', body: '\x89PNG\r\n\x1a\n' } } },
  'POST /v1/images/variations': { __multipart__: true, fields: { model: 'dall-e-2', n: '1', size: '512x512' }, files: { image: { filename: 'smoke.png', mime: 'image/png', body: '\x89PNG\r\n\x1a\n' } } },
  // /v1/files needs multipart
  'POST /v1/files': { __multipart__: true, fields: { purpose: 'assistants' }, files: { file: { filename: 'smoke.txt', mime: 'text/plain', body: 'smoke test' } } },

  // Threads / vector stores / assistants
  'POST /v1/threads': { messages: [{ role: 'user', content: 'ping' }] },
  'POST /v1/vector_stores': { name: 'smoke-test-vs' },
  'POST /v1/assistants': { model: 'gpt-4o-mini', name: 'smoke-asst', instructions: 'You are a smoke test.' },

  // Tools (need real shapes)
  'POST /v1/tools/grep': { pattern: 'test', path: '/tmp' },
  'POST /v1/tools/codebase-search': { query: 'function' },
  'POST /v1/tools/web-search': { query: 'ailin.one', max_results: 1 },
  'POST /v1/tools/git/status': { path: '.' },
  'POST /v1/tools/git/pull': { path: '.', remote: 'origin', branch: 'main' },
  'POST /v1/tools/git/resolve-conflict': { path: 'README.md', strategy: 'ours' },
  'POST /v1/tools/analyze-codebase': { path: '.', includeMetrics: true },
  'POST /v1/tools/rename-symbol': { path: '.', oldName: 'foo', newName: 'bar' },
  'POST /v1/tools/validate-code': { code: 'console.log("hi");', language: 'javascript' },
  'POST /v1/tools/extract-code-from-screenshot': { imageUrl: 'https://example.com/x.png' },
  'POST /v1/tools/todos/list': { },
  // Google Maps
  'POST /v1/tools/google-maps/search': { query: 'pizza near São Paulo' },
  'POST /v1/tools/google-maps/geocode': { address: '1600 Amphitheatre Parkway, Mountain View, CA' },
  'POST /v1/tools/google-maps/reverse-geocode': { lat: -23.55, lng: -46.63 },
  'POST /v1/tools/google-maps/directions': { origin: 'São Paulo', destination: 'Rio de Janeiro' },
  'POST /v1/tools/google-maps/place-details': { placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' },
  'POST /v1/tools/google-maps': { query: 'pizza' },
  // Jina tools
  'POST /v1/tools/jina/reader': { url: 'https://example.com' },
  'POST /v1/tools/jina/search': { query: 'ailin.one' },
  'POST /v1/tools/jina/embeddings': { input: ['ping'], model: 'jina-embeddings-v2-base-en' },
  'POST /v1/tools/jina/rerank': { query: 'ping', documents: ['a','b'], model: 'jina-reranker-v2-base-multilingual' },
  'POST /v1/tools/jina/classify': { input: ['ping'], labels: ['x','y'] },
  'POST /v1/tools/jina/segment': { content: 'sentence one. sentence two.' },
  'POST /v1/tools/jina/deepsearch': { query: 'ailin.one' },

  // Cache
  'POST /v1/cache/value': { key: 'smoke-key', value: 'smoke-value', ttlSeconds: 60 },
  'DELETE /v1/cache/value': { key: 'smoke-key' },
  'POST /v1/cache/clear': { namespace: 'smoke' },
  'POST /v1/cache/invalidate': { keys: ['smoke-key'] },

  // Codebase
  'POST /v1/codebase/analysis': { projectId: 'smoke-proj', files: [], isIncremental: false },
  'POST /v1/codebase/sync': { projectId: 'smoke-proj', rootPath: '/', files: [], sequence: 0, totalSequences: 1, isFinalChunk: true },
  'POST /v1/codebase/analysis/sync': { projectId: 'smoke-proj', files: [], isIncremental: false },
  'POST /v1/search/semantic': { projectId: 'smoke-proj', query: 'function declaration' },
  'POST /v1/search/codebase': { projectId: 'smoke-proj', query: 'function declaration' },
  'POST /v1/codebase/search/semantic': { projectId: 'smoke-proj', query: 'function declaration' },
  'POST /v1/code/execute': { code: 'return 1+1', language: 'javascript' },
  'POST /v1/search': { query: 'ailin.one' },
  'POST /v1/grounding/extract': { query: 'what is ailin.one', sources: ['https://ailin.one'] },

  // Memory / workflows
  'POST /v1/memory': { content: 'smoke memory entry', type: 'semantic', importance: 0.5 },
  'POST /v1/memory/search': { query: 'smoke', limit: 5 },
  'POST /v1/workflows/create': { task: 'echo smoke', tools: [{ name: 'echo', description: 'echoes input' }] },
  'POST /v1/workflows/execute': { workflow: { id: 'smoke', name: 'smoke', steps: [], tools: [] }, input: {} },

  // Caching contexts
  'POST /v1/caching/contexts': { name: 'smoke-ctx', messages: [{ role: 'system', content: 'You are helpful.' }], ttl: '5min' },
  'POST /v1/caching/contexts/{context_id}/use': { additional_messages: [{ role: 'user', content: 'ping' }] },

  // Fine-tuning
  'POST /v1/fine_tuning/jobs': { training_file: 'file-smoke', model: 'gpt-3.5-turbo' },

  // Models config
  'POST /v1/models/configure': { modelId: 'gpt-4o-mini', enabled: true },

  // Organization settings
  'PATCH /v1/organization/settings': { name: 'smoke-org' },

  // Enterprise
  'POST /v1/enterprise/quotas': { limits: { period: 'day', maxRequests: 100 } },
  'POST /v1/enterprise/quotas/check': { period: 'day', operation: { requests: 1 } },
  'POST /v1/enterprise/quotas/usage': { period: 'day', operation: { requests: 1 } },
  'POST /v1/enterprise/quotas/reset': { period: 'day' },
  'POST /v1/enterprise/usage/events': { events: [{ eventType: 'smoke', timestamp: Date.now() }] },
  'POST /v1/enterprise/billing/payment-methods/attach': { paymentMethodId: 'pm_smoke' },

  // Batches — needs file_id (we'll harvest later if possible)
  'POST /v1/batches': { input_file_id: 'file-smoke', endpoint: '/v1/chat/completions', completion_window: '24h' },

  // Capabilities — use real capability "chat"
  'POST /v1/capabilities/{capability}/execute': { input: 'ping', model: 'gpt-4o-mini' },
  'POST /v1/capabilities/{capability}/stream': { input: 'ping', model: 'gpt-4o-mini' },
};

// ─────────────────────────────────────────────
// Path-param overrides (capability names, etc.)
// ─────────────────────────────────────────────
const PATH_PARAM_OVERRIDES = {
  capability: 'chat',
  providerName: 'openai',
  model: 'gpt-4o-mini',
  modelId: 'gpt-4o-mini',
};

// Mutable bag of harvested IDs (filled in pass 0)
const harvested = {
  file_id: 'file-smoke',
  thread_id: null,
  vector_store_id: null,
  assistant_id: null,
  run_id: 'run-smoke',
  step_id: 'step-smoke',
  message_id: 'msg-smoke',
  batch_id: 'batch-smoke',
  context_id: 'ctx-smoke',
  job_id: 'job-smoke',
  invoiceId: '123e4567-e89b-12d3-a456-426614174000',
  paymentMethodId: '123e4567-e89b-12d3-a456-426614174000',
  keyId: '123e4567-e89b-12d3-a456-426614174000',
  userId: '123e4567-e89b-12d3-a456-426614174000',
  id: '123e4567-e89b-12d3-a456-426614174000',
  memoryId: '123e4567-e89b-12d3-a456-426614174000',
  requestId: 'smoke',
  request: 'smoke',
  response_id: '123e4567-e89b-12d3-a456-426614174000',
};

function substituteParams(p) {
  return p.replace(/\{([^}]+)\}/g, (_, name) => {
    if (PATH_PARAM_OVERRIDES[name]) return PATH_PARAM_OVERRIDES[name];
    if (harvested[name]) return harvested[name];
    const lower = name.toLowerCase();
    if (lower.includes('file_id') || lower.includes('fileid')) return harvested.file_id;
    if (lower.includes('thread_id') || lower.includes('threadid')) return harvested.thread_id || 'thread-smoke';
    if (lower.includes('run_id') || lower.includes('runid')) return harvested.run_id;
    if (lower.includes('step_id')) return harvested.step_id;
    if (lower.includes('message_id')) return harvested.message_id;
    if (lower.includes('assistant_id') || lower.includes('assistantid')) return harvested.assistant_id || 'asst-smoke';
    if (lower.includes('batch_id')) return harvested.batch_id;
    if (lower.includes('vector_store_id') || lower.includes('vectorstoreid')) return harvested.vector_store_id || 'vs-smoke';
    if (lower.includes('context_id')) return harvested.context_id;
    if (lower.includes('memory') || lower.includes('request')) return 'smoke';
    if (lower.includes('model')) return 'gpt-4o-mini';
    if (lower.includes('job')) return harvested.job_id;
    return harvested.id;
  });
}

// ─────────────────────────────────────────────
// Schema-driven query/body synthesis
// ─────────────────────────────────────────────
function synthValueLocal(schema, key, spec) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  if (schema.$ref) {
    const ref = resolveRef(spec, schema.$ref);
    return synthValueLocal(ref, key, spec);
  }
  if (schema.oneOf?.length) return synthValueLocal(schema.oneOf[0], key, spec);
  if (schema.anyOf?.length) return synthValueLocal(schema.anyOf[0], key, spec);
  if (schema.allOf?.length) {
    const merged = Object.assign({}, ...schema.allOf.map(s => s.$ref ? resolveRef(spec, s.$ref) : s));
    return synthValueLocal(merged, key, spec);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const t = types.find(x => x && x !== 'null') || 'string';
  if (t === 'string') {
    if (schema.format === 'uuid') return '123e4567-e89b-12d3-a456-426614174000';
    if (schema.format === 'date-time') return new Date().toISOString();
    if (schema.format === 'email') return 'smoke-test@ailin.one';
    if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
    if (schema.format === 'binary') return 'smoke';
    const k = (key || '').toLowerCase();
    if (k.includes('model')) return 'gpt-4o-mini';
    if (k === 'role') return 'user';
    if (k === 'voice') return 'alloy';
    if (k === 'prompt') return 'ping';
    if (k === 'content' || k === 'input' || k === 'text' || k === 'query') return 'ping';
    if (k === 'name') return 'smoke-test';
    if (k === 'pattern') return 'test';
    if (k.includes('email')) return 'smoke-test@ailin.one';
    if (k.includes('id') && schema.minLength) return 'smoke';
    if (k.includes('id')) return 'smoke';
    return schema.minLength ? 'a'.repeat(schema.minLength) : 'smoke';
  }
  if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined) return schema.minimum;
    if (schema.maximum !== undefined) return Math.min(1, schema.maximum);
    return 1;
  }
  if (t === 'boolean') return false;
  if (t === 'array') {
    const item = synthValueLocal(schema.items || {}, key, spec);
    return [item];
  }
  if (t === 'object') {
    const out = {};
    const props = schema.properties || {};
    const required = schema.required || [];
    for (const k of required) out[k] = synthValueLocal(props[k] || {}, k, spec);
    return out;
  }
  return null;
}

function resolveRef(spec, ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const segs = ref.replace(/^#\//, '').split('/');
  let cur = spec;
  for (const s of segs) cur = cur?.[s];
  return cur;
}

function deepResolve(spec, obj, depth = 0) {
  if (depth > 8) return obj;
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.$ref) return deepResolve(spec, resolveRef(spec, obj.$ref), depth + 1);
  if (Array.isArray(obj)) return obj.map(o => deepResolve(spec, o, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepResolve(spec, v, depth + 1);
  return out;
}

function synthBodyForKey(key, op) {
  if (BODY_OVERRIDES[key]) return BODY_OVERRIDES[key];
  // Try scraped route schema first (most accurate)
  const scraped = routeSchemasNorm[key];
  if (scraped?.schema?.body) {
    return synthValueLocal(scraped.schema.body, '', spec);
  }
  // Fall back to OpenAPI spec
  const body = op?.requestBody;
  if (body) {
    const resolved = deepResolve(spec, body);
    const schema = resolved?.content?.['application/json']?.schema;
    if (schema) return synthValueLocal(schema, '', spec);
  }
  return undefined;
}

// Build query string from required querystring params (route-schemas + OpenAPI parameters)
function synthQueryStringForKey(key, op) {
  const out = {};
  // From scraped route-schemas (querystring)
  const scraped = routeSchemasNorm[key];
  if (scraped?.schema?.querystring) {
    const q = scraped.schema.querystring;
    const props = q.properties || {};
    const req = q.required || [];
    for (const name of req) {
      out[name] = synthValueLocal(props[name] || {}, name, spec);
    }
  }
  // From OpenAPI parameters where in=query and required
  for (const p of op?.parameters || []) {
    const param = deepResolve(spec, p);
    if (param.in === 'query' && param.required && out[param.name] === undefined) {
      out[param.name] = synthValueLocal(param.schema || {}, param.name, spec);
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Multipart encoder
// ─────────────────────────────────────────────
function encodeMultipart(payload) {
  const boundary = '----smokeBoundary' + Math.random().toString(36).slice(2);
  const parts = [];
  const enc = (s) => Buffer.from(s, 'utf8');
  for (const [k, v] of Object.entries(payload.fields || {})) {
    parts.push(enc(`--${boundary}\r\n`));
    parts.push(enc(`Content-Disposition: form-data; name="${k}"\r\n\r\n`));
    parts.push(enc(`${v}\r\n`));
  }
  for (const [k, f] of Object.entries(payload.files || {})) {
    parts.push(enc(`--${boundary}\r\n`));
    parts.push(enc(`Content-Disposition: form-data; name="${k}"; filename="${f.filename}"\r\n`));
    parts.push(enc(`Content-Type: ${f.mime}\r\n\r\n`));
    parts.push(enc(typeof f.body === 'string' ? f.body : ''));
    parts.push(enc('\r\n'));
  }
  parts.push(enc(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

// ─────────────────────────────────────────────
// Probe one operation
// ─────────────────────────────────────────────
async function probe(opEntry) {
  const { method, path: p, key, op, skip } = opEntry;
  if (skip) {
    return { method, path: p, status: -1, ms: 0, skipped: true, reason: 'skip-list' };
  }
  const baseHeaders = {};
  if (JWT) baseHeaders['Authorization'] = `Bearer ${JWT}`;
  if (API_KEY) baseHeaders['x-api-key'] = API_KEY;

  const subbedPath = substituteParams(p);
  const qs = synthQueryStringForKey(key, op);
  const qsString = Object.keys(qs).length
    ? '?' + new URLSearchParams(qs).toString()
    : '';
  const url = `${BASE}${subbedPath}${qsString}`;

  let body, headers = { ...baseHeaders };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const payload = synthBodyForKey(key, op);
    if (payload?.__multipart__) {
      const { boundary, body: mp } = encodeMultipart(payload);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      body = mp;
    } else if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }
  }

  const documentedStatuses = Object.keys(op?.responses || {}).map(s => Number(s)).filter(n => !isNaN(n));
  let attempts = 0;
  let lastResult = null;
  const tStart = Date.now();
  while (attempts <= MAX_RETRIES_429) {
    attempts++;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutFor(key));
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
      clearTimeout(t);
      const ms = Date.now() - t0;
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      lastResult = {
        method, path: p, status: r.status, ms, totalMs: Date.now() - tStart, attempts,
        contentType: r.headers.get('content-type') || '',
        hasJsonBody: !!json,
        documentedStatus: documentedStatuses.includes(r.status),
        documentedStatuses,
        sentMultipart: headers['Content-Type']?.startsWith('multipart/'),
        qs: qsString,
        bodyHead: typeof body === 'string' ? body.slice(0, 120) : (body ? `<binary ${body.length}b>` : null),
        snippet: text.slice(0, 240),
        _harvest: r.status >= 200 && r.status < 300 ? json : null,
      };
      // Retry on 429: honour Retry-After header (capped) up to MAX_RETRIES_429 times
      if (r.status === 429 && attempts <= MAX_RETRIES_429) {
        const retryAfterHeader = r.headers.get('retry-after');
        let waitMs = 1500;
        if (retryAfterHeader) {
          const n = parseFloat(retryAfterHeader);
          if (!isNaN(n)) waitMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(500, n * 1000 + 200));
        }
        // Also try parsing JSON `retryAfter` field
        if (json?.error?.retryAfter) {
          waitMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(waitMs, json.error.retryAfter * 1000 + 200));
        }
        await new Promise(res => setTimeout(res, waitMs));
        continue;
      }
      return lastResult;
    } catch (e) {
      clearTimeout(t);
      lastResult = { method, path: p, status: 0, ms: Date.now() - t0, totalMs: Date.now() - tStart, attempts, error: e.message };
      return lastResult;
    }
  }
  return lastResult;
}

// ─────────────────────────────────────────────
// Build operations + run
// ─────────────────────────────────────────────
const paths = spec.paths || {};
function buildOperations() {
  const ops = [];
  for (const [p, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const key = `${method.toUpperCase()} ${p}`;
      ops.push({
        method: method.toUpperCase(),
        path: p,
        key,
        op,
        skip: SKIP_PATHS.has(p) || SKIP_METHOD_PATHS.has(key),
      });
    }
  }
  return ops;
}

// Pass 0 — harvest IDs by creating real entities
async function harvestPass() {
  console.log('=== Pass 0: harvesting IDs ===');
  const creates = [
    { key: 'POST /v1/threads', save: (j) => harvested.thread_id = j?.id },
    { key: 'POST /v1/vector_stores', save: (j) => harvested.vector_store_id = j?.id },
    { key: 'POST /v1/assistants', save: (j) => harvested.assistant_id = j?.id },
  ];
  for (const c of creates) {
    const [m, ...rest] = c.key.split(' ');
    const p = rest.join(' ');
    const op = paths[p]?.[m.toLowerCase()];
    if (!op) continue;
    const r = await probe({ method: m, path: p, key: c.key, op, skip: false });
    if (r.status >= 200 && r.status < 300) {
      const j = r._harvest;
      if (j && j.id) {
        c.save(j);
        console.log(`  ✓ ${c.key} → harvested ${JSON.stringify(j.id)}`);
      } else {
        console.log(`  ✗ ${c.key} → 2xx but no id in response`);
      }
    } else {
      console.log(`  ✗ ${c.key} → ${r.status} (no harvest)`);
    }
  }
  console.log('  harvested:', JSON.stringify({
    thread_id: harvested.thread_id,
    vector_store_id: harvested.vector_store_id,
    assistant_id: harvested.assistant_id,
  }));
}

async function runAll(ops) {
  const results = new Array(ops.length);
  let i = 0;
  let lastStartAt = 0;
  async function worker() {
    while (i < ops.length) {
      const idx = i++;
      // Global pacing across workers — wait until enough time has passed since
      // the last request *start*, so we stay under the 1 RPS sustained refill.
      const now = Date.now();
      const wait = Math.max(0, lastStartAt + THROTTLE_MS - now);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastStartAt = Date.now();
      const r = await probe(ops[idx]);
      results[idx] = r;
      const tag = r.skipped ? 'SKIP' : (r.status === 0 ? 'ERR' : String(r.status));
      const docFlag = r.documentedStatus ? '✓' : (r.skipped ? ' ' : '!');
      const t = r.totalMs ? ` ${r.totalMs}ms` : (r.ms ? ` ${r.ms}ms` : '');
      const att = r.attempts && r.attempts > 1 ? ` x${r.attempts}` : '';
      process.stdout.write(`[${String(idx + 1).padStart(3)}/${ops.length}] ${docFlag} ${tag.padEnd(4)} ${ops[idx].method.padEnd(6)} ${ops[idx].path}${t}${att}\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

// ─────────────────────────────────────────────
const ops = buildOperations();
console.log(`Loaded ${ops.length} operations from ${SPEC_PATH}`);
console.log(`Auth: JWT=${!!JWT} API_KEY=${!!API_KEY}`);
console.log(`Concurrency: ${CONCURRENCY}, throttle: ${THROTTLE_MS}ms between starts, default timeout: ${DEFAULT_TIMEOUT}ms`);
console.log(`Retry: up to ${MAX_RETRIES_429}× on 429 (cap ${MAX_RETRY_AFTER_MS}ms per Retry-After)`);
console.log(`Will skip ${ops.filter(o => o.skip).length} mutating/dangerous operations\n`);

await harvestPass();
console.log();
console.log('=== Pass 1: full smoke ===');
const results = await runAll(ops);

// Aggregate
const buckets = {
  '2xx': [], '3xx': [], '400': [], '401': [], '403': [], '404': [], '405': [],
  '406': [], '413': [], '415': [], '422': [], '429': [], '5xx': [], 'ERR': [], 'SKIP': [], 'OTHER': [],
};
let undocumented = 0;
for (const r of results) {
  let b = 'OTHER';
  if (r.skipped) b = 'SKIP';
  else if (r.status === 0) b = 'ERR';
  else if (r.status >= 200 && r.status < 300) b = '2xx';
  else if (r.status >= 300 && r.status < 400) b = '3xx';
  else if (r.status === 400) b = '400';
  else if (r.status === 401) b = '401';
  else if (r.status === 403) b = '403';
  else if (r.status === 404) b = '404';
  else if (r.status === 405) b = '405';
  else if (r.status === 406) b = '406';
  else if (r.status === 413) b = '413';
  else if (r.status === 415) b = '415';
  else if (r.status === 422) b = '422';
  else if (r.status === 429) b = '429';
  else if (r.status >= 500) b = '5xx';
  buckets[b].push(r);
  if (!r.skipped && r.status > 0 && !r.documentedStatus) undocumented++;
}

console.log('\n=== Summary ===');
for (const [b, items] of Object.entries(buckets)) {
  if (items.length) console.log(`  ${b}: ${items.length}`);
}
console.log(`  undocumented status: ${undocumented}`);

console.log('\n=== Bugs (5xx) ===');
for (const r of buckets['5xx']) {
  console.log(`  ${r.method} ${r.path} → ${r.status} :: ${r.snippet.slice(0, 100)}`);
}

console.log('\n=== Errors / aborts ===');
for (const r of buckets['ERR']) {
  console.log(`  ${r.method} ${r.path} → ${r.error}`);
}

fs.writeFileSync(OUT, JSON.stringify({
  base: BASE,
  total: results.length,
  buckets,
  undocumentedStatusCount: undocumented,
  harvested,
}, null, 2));
console.log(`\nWrote ${OUT}`);
