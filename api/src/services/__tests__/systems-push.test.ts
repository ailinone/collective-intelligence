// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Systems push mapping pins (request-logger -> ailin.systems /ingest/batch):
 *   - provider/model split for "provider:model" database IDs, "unknown"
 *     attribution for plain names, and {} for missing model ids;
 *   - user_subject prefers the API key (stable, resolvable), falling back to
 *     the end-user id, never both nor neither;
 *   - endpoint -> operation derivation;
 *   - the privacy contract: request/response/metadata blobs and raw message
 *     fields never appear in the wire payload, and no key name normalizes
 *     into systems' FORBIDDEN_KEYS (apikey, token, content, messages, ...);
 *   - env gating (no URL/key -> no fetch) and never-throws behavior.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chunkItems, pushAnonymousChatOperational, pushOperationalRequestBatch, pushOperationalTrace } from '../systems-push';
import type { RequestLogData } from '../request-logger';

const hashIp = (ip: string) => createHash('sha256').update(ip).digest('hex');

const baseLog: RequestLogData = {
  organizationId: 'org-1',
  userId: 'user-1',
  requestId: 'req-1',
  endpoint: '/v1/chat/completions',
  method: 'POST',
  durationMs: 1200,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  costUsd: 0.002,
  status: 'success',
  primaryModelId: 'openrouter:deepseek/deepseek-chat',
  strategyName: 'single',
};

const FORBIDDEN_KEYS = new Set([
  'prompt', 'response', 'requestbody', 'responsebody', 'authorization', 'cookie',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'clientsecret',
  'password', 'messages', 'content',
]);

function normalizeKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(normalizeKeys);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      k.toLowerCase().replace(/[^a-z0-9]/g, ''),
      ...normalizeKeys(v),
    ]);
  }
  return [];
}

describe('systems-push', () => {
  const fetchMock = vi.fn();
  const env: NodeJS.ProcessEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202 } as Response);
    process.env.SYSTEMS_OPERATIONS_URL = 'http://systems_api:5100/api/operations/';
    process.env.SYSTEMS_INGEST_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = env;
    vi.unstubAllGlobals();
  });

  it('maps explicit fields only and never trips FORBIDDEN_KEYS', async () => {
    await pushOperationalRequestBatch([
      { ...baseLog, request: { model: 'x' }, response: { id: 'y' }, metadata: { secret: 'z' } } as RequestLogData,
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source_service).toBe('ci');
    const [item] = body.requests;
    expect(item).toEqual({
      source_request_id: 'req-1',
      operation: 'chat.completions',
      status: 'success',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      strategy: 'single',
      user_subject: 'user-1',
      tenant_id: 'org-1',
      input_tokens: 10,
      output_tokens: 5,
      duration_ms: 1200,
      estimated_cost_usd: 0.002,
      error_type: undefined,
      ip_address: undefined,
      completed_at: undefined,
      environment: process.env.NODE_ENV,
    });
    // No key of the payload (recursively) normalizes into a forbidden name.
    const keys = normalizeKeys(body);
    expect(keys.filter((k) => FORBIDDEN_KEYS.has(k))).toEqual([]);
  });

  it('prefers api-key attribution and never ships a raw IP', async () => {
    await pushOperationalRequestBatch([
      { ...baseLog, apiKeyId: 'key-9', ipAddress: '203.0.113.7' },
    ]);
    const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
    expect(item.user_subject).toBe('apikey:key-9');
    expect(item.ip_address).toBe(hashIp('203.0.113.7'));
    expect(JSON.stringify(item)).not.toContain('203.0.113.7');
  });

  it('attributes plain model names to provider "unknown"', async () => {
    await pushOperationalRequestBatch([{ ...baseLog, primaryModelId: 'gpt-4o-mini' }]);
    const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
    expect(item.provider).toBe('unknown');
    expect(item.model).toBe('gpt-4o-mini');
  });

  it('prefers metadata.selectedProvider (orchestrator) over metadata.provider and parsing', async () => {
    await pushOperationalRequestBatch([
      {
        ...baseLog,
        primaryModelId: 'openai/gpt-5.4-nano',
        metadata: { selectedProvider: 'cometapi', provider: 'openai' },
      },
      { ...baseLog, requestId: 'req-2', metadata: { provider: 'openai' } },
      {
        ...baseLog,
        requestId: 'req-3',
        primaryModelId: 'gpt-4o-mini',
        metadata: { selectedProvider: '' },
      },
    ]);
    const items = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
    expect(items[0].provider).toBe('cometapi');
    expect(items[1].provider).toBe('openai');
    // Empty selectedProvider falls through to model-id parsing; a plain
    // model name (no "provider:" prefix) stays unknown.
    expect(items[2].provider).toBe('unknown');
  });

  it('prefers the serving adapter from metadata over model-id parsing', async () => {
    await pushOperationalRequestBatch([
      { ...baseLog, primaryModelId: 'gpt-4o-mini', metadata: { provider: 'openai' } },
    ]);
    const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
    expect(item.provider).toBe('openai');
    expect(item.model).toBe('gpt-4o-mini');
  });

  it('ignores non-string or empty metadata.provider and falls back to parsing', async () => {
    await pushOperationalRequestBatch([
      { ...baseLog, metadata: { provider: 42 } },
      { ...baseLog, requestId: 'req-2', metadata: { provider: '' } },
    ]);
    const items = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
    expect(items[0].provider).toBe('openrouter');
    expect(items[1].provider).toBe('openrouter');
  });

  it('is a no-op without env wiring and never throws on fetch failure', async () => {
    delete process.env.SYSTEMS_OPERATIONS_URL;
    await pushOperationalRequestBatch([baseLog]);
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.SYSTEMS_OPERATIONS_URL = 'http://systems_api:5100/api/operations';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(pushOperationalRequestBatch([baseLog])).resolves.toBeUndefined();
  });

  it('chunks above the systems batch cap margin and drops keyless rows silently', async () => {
    const batch = Array.from({ length: 600 }, (_, i) => ({
      ...baseLog,
      requestId: `req-${i}`,
    }));
    batch[0].requestId = '' as unknown as string;
    await pushOperationalRequestBatch(batch);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 599 valid items / 250 per chunk
    const sizes = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).requests.length);
    expect(sizes).toEqual([250, 250, 99]);
  });

  it('anonymous push is metadata-only with pseudonymous visitor identity', async () => {
    pushAnonymousChatOperational({
      requestId: 'anon-req-1',
      apiKeyId: 'guest-key',
      visitorFingerprint: 'a'.repeat(64),
      visitorIp: '198.51.100.9',
      modelRequested: 'openrouter:some/free-model',
      modelsServed: ['openrouter:some/free-model'],
      inputTokens: 7,
      outputTokens: 3,
      status: 'blocked',
      errorCode: 'quota_exceeded',
    });
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const [item] = body.requests;
    expect(item).toMatchObject({
      source_request_id: 'anon:anon-req-1',
      operation: 'anonymous.chat',
      status: 'error', // unknown statuses collapse to error, code preserved
      error_type: 'quota_exceeded',
      provider: 'openrouter',
      model: 'some/free-model',
      user_subject: `anon:${'a'.repeat(12)}`,
      ip_address: hashIp('198.51.100.9'),
      fingerprint_source: 'a'.repeat(64),
      input_tokens: 7,
      output_tokens: 3,
    });
    // Privacy: nothing message-shaped crosses the wire.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['message', 'response', 'prompt', 'content']) {
      expect(serialized).not.toContain(`"${forbidden}`);
    }
  });

  describe('processing trace (stages / correlation / sealed content)', () => {
    const trace = {
      correlationId: 'chat:abc-123:msg-9',
      stages: [
        { sequence: 0, name: 'Triage', stage_type: 'triage', status: 'success', attributes: { intent: 'analysis', confidence: 0.9 } },
        { sequence: 1, name: 'Voter A', stage_type: 'participant', status: 'success', duration_ms: 1200, attributes: { verdict: 'pass', outlier: false } },
      ],
    };

    it('adds correlation_id and stages when the entry carries a trace, and nothing else changes', async () => {
      await pushOperationalRequestBatch([{ ...baseLog, systemsTrace: trace }]);
      const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
      expect(item.correlation_id).toBe('chat:abc-123:msg-9');
      expect(item.stages).toHaveLength(2);
      expect(item.trace_payloads).toBeUndefined(); // content plane absent unless captured
      expect(item.source_request_id).toBe('req-1');
    });

    it('keeps the legacy wire shape for entries without a trace', async () => {
      await pushOperationalRequestBatch([baseLog]);
      const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
      expect(item).not.toHaveProperty('stages');
      expect(item).not.toHaveProperty('correlation_id');
      expect(item).not.toHaveProperty('trace_payloads');
    });

    it('structure plane passes the systems forbidden-key firewall (keys only; payloads are validated separately)', async () => {
      await pushOperationalRequestBatch([{ ...baseLog, systemsTrace: trace }]);
      const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
      const { trace_payloads: _payloads, ...structure } = item;
      for (const key of normalizeKeys(structure)) expect(FORBIDDEN_KEYS.has(key)).toBe(false);
    });

    it('sends content only through trace_payloads, with the strict key set systems validates', async () => {
      const payloads = [{ kind: 'input', text: 'hello' }, { kind: 'stage_output', stage_sequence: 1, text: 'answer' }];
      await pushOperationalRequestBatch([{ ...baseLog, systemsTrace: { ...trace, payloads } as never }]);
      const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
      expect(item.trace_payloads).toEqual(payloads);
      for (const p of item.trace_payloads) expect(Object.keys(p).every((k) => ['kind', 'stage_sequence', 'text'].includes(k))).toBe(true);
    });

    it('pushOperationalTrace posts one item for the streaming path and is a no-op without env', async () => {
      pushOperationalTrace({
        requestId: 'eng-1',
        endpoint: '/v1/chat/completions',
        status: 'success',
        strategy: 'consensus',
        modelId: 'anthropic:claude-a',
        userId: 'user-1',
        organizationId: 'org-1',
        inputTokens: 300,
        outputTokens: 60,
        durationMs: 6645,
        costUsd: 0.0071,
        trace,
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [item] = JSON.parse(fetchMock.mock.calls[0][1].body).requests;
      expect(item).toMatchObject({
        source_request_id: 'eng-1',
        operation: 'chat.completions',
        strategy: 'consensus',
        provider: 'anthropic',
        model: 'claude-a',
        user_subject: 'user-1',
        tenant_id: 'org-1',
        correlation_id: 'chat:abc-123:msg-9',
      });
      expect(item.stages).toHaveLength(2);

      fetchMock.mockClear();
      delete process.env.SYSTEMS_INGEST_API_KEY;
      pushOperationalTrace({ requestId: 'eng-2', endpoint: '/v1/chat/completions', status: 'success', trace });
      await new Promise((r) => setTimeout(r, 10));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('chunks by size as well as count, dropping content (not metadata) from a single oversized item', () => {
      const big = 'x'.repeat(1_200_000);
      const item = (id: string, text?: string) => ({
        source_request_id: id,
        operation: 'chat.completions',
        status: 'success',
        ...(text ? { trace_payloads: [{ kind: 'output' as const, text }] } : {}),
      });
      // 1.2 MB each: two do not fit one 2 MB chunk.
      const chunks = chunkItems([item('a', big), item('b', big), item('c')]);
      expect(chunks.map((c) => c.map((i) => i.source_request_id))).toEqual([['a'], ['b', 'c']]);
      // Over the cap on its own: content dropped, the item still ships.
      const [[huge]] = chunkItems([item('huge', 'y'.repeat(2_500_000))]);
      expect(huge.source_request_id).toBe('huge');
      expect(huge).not.toHaveProperty('trace_payloads');
    });

    it('never throws when the push fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      await expect(pushOperationalRequestBatch([{ ...baseLog, systemsTrace: trace }])).resolves.toBeUndefined();
    });
  });
});
