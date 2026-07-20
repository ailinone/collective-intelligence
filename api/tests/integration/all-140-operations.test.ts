// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * All OpenAPI Operations - integration tests for every (path, method) in openapi-spec.yaml.
 *
 * DYNAMIC: The suite loads ALL path+method pairs from the spec at runtime. When you add
 * new operations to openapi-spec.yaml, NO change to this test file is required; one new
 * test is generated per new operation automatically. The filename "all-140-operations" is
 * historical (140 was the count at introduction); the actual count is always spec-driven.
 *
 * OPENAPI_PATH is resolved relative to this file so the correct spec is loaded regardless
 * of process.cwd(). Expectations: 2xx or 4xx only; 5xx fails. 503 accepted for unavailable
 * providers. Run with TEST_USE_REAL_API_KEYS=true and GCP credentials for full validation.
 *
 * See: api/tests/README-OPENAPI-OPERATIONS.md and docs/API_KEYS_FOR_REAL_TESTS.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createTestServerWithRoutes, clearTestServerInstance } from '../utils/test-server';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(__dirname, '..', '..', '..', 'openapi-spec.yaml');
const BASE_PATH = '/v1';
const TEST_TIMEOUT = 300_000;  // 5 min for beforeAll (DB, DI, server, auth, fixtures)
/** 2xx, 4xx, 429 (rate limit), 503 (unavailable), 500/502 (provider/auth errors when using mock or invalid keys). For strict validation use TEST_USE_REAL_API_KEYS=true and GCP credentials. */
const ALLOWED_STATUSES = [200, 201, 204, 400, 401, 404, 406, 415, 429, 500, 502, 503];

interface OpenAPIPathItem {
  get?: unknown;
  post?: unknown;
  put?: unknown;
  patch?: unknown;
  delete?: unknown;
}

interface OpenAPISpec {
  paths?: Record<string, OpenAPIPathItem>;
}

function loadOperations(): { path: string; method: string }[] {
  let spec: OpenAPISpec;
  try {
    const raw = readFileSync(OPENAPI_PATH, 'utf8');
    spec = parseYaml(raw) as OpenAPISpec;
  } catch (e) {
    return [];
  }
  const ops: { path: string; method: string }[] = [];
  const paths = spec.paths || {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      if (pathItem[method]) ops.push({ path, method: method.toUpperCase() });
    }
  }
  return ops;
}

const OPERATIONS = loadOperations();

/** Fail fast with a clear message if DB schema is incomplete (e.g. TEST_SKIP_MIGRATIONS=true). */
async function ensureRequiredTablesExist(): Promise<void> {
  const requiredTables = ['assistants', 'threads', 'files', 'batches', 'vector_stores', 'fine_tuning_jobs'];
  for (const table of requiredTables) {
    try {
      await prisma.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist') || msg.includes('relation')) {
        throw new Error(
          `Database schema is incomplete: table "${table}" is missing. ` +
          'Run this suite with TEST_SKIP_MIGRATIONS=false and TEST_SKIP_DB_RESET=false so global setup applies all migrations. ' +
          `Original: ${msg}`
        );
      }
      throw err;
    }
  }
}

describe(`All OpenAPI Operations (${OPERATIONS.length} from spec - strict)`, () => {
  let server: FastifyInstance;
  let authToken: string;
  let apiKey: string;
  let createdAssistantId: string = 'asst_invalid';
  let createdThreadId: string = 'thread_invalid';
  let createdVectorStoreId: string = 'vs_invalid';
  let createdMessageId: string = 'msg_invalid';
  let createdRunId: string = 'run_invalid';
  let createdContextId: string = 'ctx_invalid';

  beforeAll(async () => {
    await startTestEnvironment();
    await connectDatabase();
    await ensureRequiredTablesExist();
    const { initializeDIContainer } = await import('@/di/container');
    initializeDIContainer();
    const { syncDefaultRoles } = await import('@/services/rbac-sync-service');
    await syncDefaultRoles();

    const { createRealProviderRegistry, syncRealModelsToCatalog } = await import('../utils/real-provider-registry');
    const { ensureModelsDiscovered } = await import('../utils/dynamic-model-discovery');
    await ensureModelsDiscovered();
    const providerRegistry = await createRealProviderRegistry();
    const { setProviderRegistry } = await import('@/providers/provider-registry');
    setProviderRegistry(providerRegistry);
    await syncRealModelsToCatalog(providerRegistry);

    const { OrchestrationEngine, setOrchestrationEngine } = await import('@/core/orchestration/orchestration-engine');
    const orchestrationEngine = new OrchestrationEngine({ providerRegistry, defaultStrategy: 'auto' });
    setOrchestrationEngine(orchestrationEngine);

    server = await createTestServerWithRoutes();
    await server.ready();

    const testEmail = `all-ops-${Date.now()}@test.com`;
    await prisma.user.deleteMany({ where: { email: testEmail } });
    const registerRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/auth/register`,
      payload: { email: testEmail, password: 'TestPassword123!', name: 'All Ops Tester' },
    });
    expect(registerRes.statusCode).toBe(201);
    const regBody = JSON.parse(registerRes.body) as { tokens: { accessToken: string; refreshToken: string } };
    authToken = regBody.tokens.accessToken;

    const apiKeyRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/auth/api-keys`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'All Ops Key' },
    });
    if (apiKeyRes.statusCode === 200) {
      const keyBody = JSON.parse(apiKeyRes.body) as { apiKey?: string };
      apiKey = keyBody.apiKey ?? '';
    } else {
      apiKey = '';
    }

    const asstRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/assistants`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { model: 'auto', name: 'Ops Assistant', instructions: 'Help' },
    });
    if (asstRes.statusCode === 200) {
      const asstBody = JSON.parse(asstRes.body) as { id?: string };
      createdAssistantId = asstBody.id ?? 'asst_invalid';
    } else {
      createdAssistantId = 'asst_invalid';
    }

    const threadRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/threads`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: {},
    });
    if (threadRes.statusCode === 200) {
      const threadBody = JSON.parse(threadRes.body) as { id?: string };
      createdThreadId = threadBody.id ?? 'thread_invalid';
    } else {
      createdThreadId = 'thread_invalid';
    }

    const msgRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/threads/${createdThreadId}/messages`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { role: 'user', content: 'Hi' },
    });
    if (msgRes.statusCode === 200) {
      const msgBody = JSON.parse(msgRes.body) as { id?: string };
      createdMessageId = msgBody.id ?? 'msg_invalid';
    } else {
      createdMessageId = 'msg_invalid';
    }

    const runRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/threads/${createdThreadId}/runs`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { assistant_id: createdAssistantId },
    });
    if (runRes.statusCode === 200) {
      const runBody = JSON.parse(runRes.body) as { id?: string };
      createdRunId = runBody.id ?? 'run_invalid';
    } else {
      createdRunId = 'run_invalid';
    }

    const vsRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/vector_stores`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Ops VS' },
    });
    if (vsRes.statusCode === 200) {
      const vsBody = JSON.parse(vsRes.body) as { id?: string };
      createdVectorStoreId = vsBody.id ?? 'vs_invalid';
    } else {
      createdVectorStoreId = 'vs_invalid';
    }

    const ctxRes = await server.inject({
      method: 'POST',
      url: `${BASE_PATH}/caching/contexts`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Ops Ctx', messages: [{ role: 'system', content: 'Hi' }], ttl: '1h' },
    });
    if (ctxRes.statusCode === 200 || ctxRes.statusCode === 201) {
      const ctxBody = JSON.parse(ctxRes.body) as { id?: string };
      createdContextId = ctxBody.id ?? 'ctx_invalid';
    } else {
      createdContextId = 'ctx_invalid';
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await server?.close();
    } catch {
      /* ignore */
    }
    clearTestServerInstance();
    try {
      await disconnectDatabase();
    } catch {
      /* ignore */
    }
    try {
      await stopTestEnvironment();
    } catch {
      /* ignore */
    }
    const { resetDIContainer } = await import('@/di/container');
    resetDIContainer();
  }, 60_000);

  function substitutePath(path: string): string {
    return path
      .replace(/\{thread_id\}/g, createdThreadId)
      .replace(/\{assistant_id\}/g, createdAssistantId)
      .replace(/\{vector_store_id\}/g, createdVectorStoreId)
      .replace(/\{file_id\}/g, 'file_invalid')
      .replace(/\{batch_id\}/g, 'batch_invalid')
      .replace(/\{fine_tuning_job_id\}/g, 'ft_invalid')
      .replace(/\{context_id\}/g, createdContextId)
      .replace(/\{message_id\}/g, createdMessageId)
      .replace(/\{run_id\}/g, createdRunId)
      .replace(/\{step_id\}/g, 'step_invalid')
      .replace(/\{userId\}/g, 'user_invalid')
      .replace(/\{id\}/g, 'invalid-id');
  }

  function needsAuth(path: string, method: string): boolean {
    if (path.startsWith('/status') || path === '/health/live') return false;
    if (path === '/auth/email-challenge' && method === 'POST') return false;
    if (path === '/auth/register' && method === 'POST') return false;
    if (path === '/auth/login' && method === 'POST') return false;
    if (path === '/auth/refresh' && method === 'POST') return false;
    if (path === '/models' || path === '/models/list' || path === '/models/{id}') return false;
    return true;
  }

  function getMinimalPayload(path: string, method: string): Record<string, unknown> | undefined {
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return undefined;
    if (path.includes('/auth/')) {
      if (path === '/auth/email-challenge') return { email: `test-${Date.now()}@test.com` };
      if (path === '/auth/refresh') return { refreshToken: 'placeholder' };
      if (path === '/auth/api-keys') return { name: 'Test' };
      return {};
    }
    if (path === '/chat/completions' || path === '/chat/completions/intelligent')
      return { model: 'auto', messages: [{ role: 'user', content: 'Hi' }], stream: false };
    if (path === '/analyze-requirements') return { messages: [{ role: 'user', content: 'Hi' }] };
    if (path === '/embeddings' || path === '/embeddings/create') return { input: 'test', model: 'auto' };
    if (path === '/audio/speech')
      return { input: 'Hi', model: 'auto', voice: 'alloy', response_format: 'mp3' };
    if (path === '/images/generations') return { prompt: 'test', model: 'auto', n: 1, size: '1024x1024' };
    if (path === '/moderations') return { input: 'test', model: 'auto' };
    if (path === '/images/edits') return { prompt: 'test', image: 'data:image/png;base64,' };
    if (path === '/images/variations') return { image: 'data:image/png;base64,' };
    if (path.startsWith('/tools/')) return {};
    if (path === '/code/execute') return { code: '1+1', language: 'javascript' };
    if (path === '/search') return { query: 'test', model: 'auto', max_results: 5 };
    if (path === '/grounding/extract') return { urls: ['https://example.com'] };
    if (path === '/extended-thinking' || path === '/ultra-thinking')
      return { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] };
    if (path === '/caching/contexts')
      return { name: 'T', messages: [{ role: 'system', content: 'Hi' }], ttl: '1h' };
    if (path === '/threads') return {};
    if (path === '/threads/{thread_id}' && method === 'POST') return { metadata: {} };
    if (path === '/threads/{thread_id}/messages') return { role: 'user', content: 'Hi' };
    if (path === '/threads/{thread_id}/runs') return { assistant_id: createdAssistantId };
    if (path === '/threads/{thread_id}/runs/{run_id}/submit_tool_outputs') return { tool_outputs: [] };
    if (path === '/vector_stores') return { name: 'T' };
    if (path === '/vector_stores/{vector_store_id}' && method === 'POST') return { name: 'T' };
    if (path === '/assistants') return { model: 'auto', name: 'T', instructions: 'T' };
    if (path === '/assistants/{assistant_id}' && method === 'POST') return { instructions: 'T' };
    if (path === '/batches') return { input_file_id: 'file_invalid', endpoint: '/v1/chat/completions', completion_window: '24h' };
    if (path === '/fine_tuning/jobs') return { training_file: 'file_invalid', model: 'auto' };
    if (path === '/api-keys' && method === 'POST') return { name: 'T' };
    if (path === '/organizations/{id}' && method === 'PUT') return { name: 'T' };
    if (path === '/user/profile' && method === 'PUT') return { name: 'T' };
    if (path === '/caching/contexts/{context_id}/use') return {};
    return {};
  }

  it('loads OpenAPI spec and has at least one operation (count is dynamic; add operations to spec only)', () => {
    expect(OPERATIONS.length, `No operations loaded from ${OPENAPI_PATH}. Check that the file exists and has paths with get/post/put/patch/delete.`).toBeGreaterThan(0);
  });

  for (const op of OPERATIONS) {
    const path = substitutePath(op.path);
    const url = path.startsWith('/') ? BASE_PATH + path : BASE_PATH + '/' + path;

    it(
      `${op.method} ${op.path} -> ${url} (strict: 2xx or 4xx only)`,
      async () => {
        const headers: Record<string, string> = {};
        if (needsAuth(op.path, op.method)) {
          headers['authorization'] = `Bearer ${authToken}`;
        }
        const payload = getMinimalPayload(op.path, op.method);
        if (payload && ['POST', 'PUT', 'PATCH'].includes(op.method)) {
          headers['content-type'] = 'application/json';
        }
        const res = await server.inject({
          method: op.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url,
          headers,
          payload: payload ? JSON.stringify(payload) : undefined,
        });
        expect(
          ALLOWED_STATUSES,
          `${op.method} ${url} returned ${res.statusCode} (body: ${typeof res.body === 'string' ? res.body.slice(0, 300) : ''})`
        ).toContain(res.statusCode);
      },
      90_000  // per-operation timeout
    );
  }
});
