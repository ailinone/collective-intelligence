// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — non-billable probe adapter contract.
 *
 * Each probe must:
 *   - declare endpointType + billableRisk='none'
 *   - call a non-generation endpoint (we inject a fake fetch and
 *     assert no chat/completions URL is hit)
 *   - map 200 / 401 / 402 / 429 / 5xx into the right liveOperabilityState
 *   - sanitize errors (no API keys / no prompt body)
 *   - honor `timeoutMs`
 */
import { describe, it, expect, vi } from 'vitest';
import { createOllamaProbe } from '../provider-probes/ollama-probe';
import { createOpenRouterProbe } from '../provider-probes/openrouter-probe';
import { createGenericListModelsProbe } from '../provider-probes/generic-list-models-probe';
import { ProviderProbeRegistry } from '../provider-probe-registry';
import { registerDefaultProbes } from '../provider-probes/register-default-probes';

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return Promise.resolve(handler(u, init));
  }) as typeof fetch;
}

describe('OllamaProbe', () => {
  it('declares endpointType=models + billableRisk=none', () => {
    const probe = createOllamaProbe();
    expect(probe.endpointType).toBe('models');
    expect(probe.billableRisk).toBe('none');
  });

  it('maps 200 + models to healthy + has_credits', async () => {
    const probe = createOllamaProbe({
      baseUrl: 'http://localhost:11434',
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ models: [{ name: 'qwen' }] }), { status: 200 })),
    });
    const r = await probe.probe({ providerId: 'ollama', timeoutMs: 1000 });
    expect(r.liveOperabilityState).toBe('healthy');
    expect(r.liveBalanceStatus).toBe('has_credits');
  });

  it('connection error → auth_failed (treat as unreachable)', async () => {
    const probe = createOllamaProbe({
      baseUrl: 'http://localhost:11434',
      fetchImpl: fakeFetch(() => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    const r = await probe.probe({ providerId: 'ollama', timeoutMs: 1000 });
    expect(r.liveOperabilityState).toBe('auth_failed');
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('hits /api/tags, NEVER /api/generate or /chat', async () => {
    const seen: string[] = [];
    const probe = createOllamaProbe({
      baseUrl: 'http://localhost:11434',
      fetchImpl: fakeFetch((url) => {
        seen.push(url);
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }),
    });
    await probe.probe({ providerId: 'ollama', timeoutMs: 1000 });
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('/api/tags');
    expect(seen[0]).not.toContain('/api/generate');
    expect(seen[0]).not.toContain('/chat');
  });
});

describe('OpenRouterProbe', () => {
  it('200 + credits > usage → has_credits', async () => {
    const probe = createOpenRouterProbe({
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(() => new Response(
        JSON.stringify({ data: { total_credits: 10, total_usage: 3 } }),
        { status: 200 },
      )),
    });
    const r = await probe.probe({ providerId: 'openrouter', timeoutMs: 1000 });
    expect(r.liveBalanceStatus).toBe('has_credits');
    expect(r.liveOperabilityState).toBe('healthy');
  });

  it('200 + usage >= credits → no_credits', async () => {
    const probe = createOpenRouterProbe({
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(() => new Response(
        JSON.stringify({ data: { total_credits: 10, total_usage: 10 } }),
        { status: 200 },
      )),
    });
    const r = await probe.probe({ providerId: 'openrouter', timeoutMs: 1000 });
    expect(r.liveBalanceStatus).toBe('no_credits');
  });

  it('401 → auth_failed', async () => {
    const probe = createOpenRouterProbe({
      apiKey: 'sk-bad',
      fetchImpl: fakeFetch(() => new Response('Unauthorized', { status: 401 })),
    });
    const r = await probe.probe({ providerId: 'openrouter', timeoutMs: 1000 });
    expect(r.liveOperabilityState).toBe('auth_failed');
  });

  it('429 → rate_limited', async () => {
    const probe = createOpenRouterProbe({
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(() => new Response('Too Many Requests', { status: 429 })),
    });
    const r = await probe.probe({ providerId: 'openrouter', timeoutMs: 1000 });
    expect(r.liveOperabilityState).toBe('rate_limited');
  });

  it('no API key → auth_failed without making the call', async () => {
    const spy = vi.fn(() => new Response('{}', { status: 200 }));
    const probe = createOpenRouterProbe({
      apiKey: '',
      fetchImpl: fakeFetch(spy as never) as never,
    });
    const r = await probe.probe({ providerId: 'openrouter', timeoutMs: 1000 });
    expect(r.liveOperabilityState).toBe('auth_failed');
    expect(spy).not.toHaveBeenCalled();
  });

  it('hits /api/v1/credits, NEVER /api/v1/chat/completions', async () => {
    const seen: string[] = [];
    const probe = createOpenRouterProbe({
      apiKey: 'sk-test',
      fetchImpl: fakeFetch((url) => {
        seen.push(url);
        return new Response(JSON.stringify({ data: { total_credits: 1, total_usage: 0 } }), { status: 200 });
      }),
    });
    await probe.probe({ providerId: 'openrouter', timeoutMs: 1000 });
    expect(seen[0]).toContain('/api/v1/credits');
    expect(seen[0]).not.toContain('completions');
  });
});

describe('GenericListModelsProbe', () => {
  it('200 + non-empty data → auth_ok + has_credits', async () => {
    const probe = createGenericListModelsProbe({
      providerId: 'someprov',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 })),
    });
    const r = await probe.probe({ providerId: 'someprov', timeoutMs: 1000 });
    expect(r.liveBalanceStatus).toBe('has_credits');
  });

  it('402 → no_credits', async () => {
    const probe = createGenericListModelsProbe({
      providerId: 'someprov',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(() => new Response('Payment Required', { status: 402 })),
    });
    const r = await probe.probe({ providerId: 'someprov', timeoutMs: 1000 });
    expect(r.liveOperabilityState).toBe('no_credits');
    expect(r.liveBalanceStatus).toBe('no_credits');
  });

  it('hits /v1/models, NEVER /v1/chat/completions', async () => {
    const seen: string[] = [];
    const probe = createGenericListModelsProbe({
      providerId: 'someprov',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      fetchImpl: fakeFetch((url) => {
        seen.push(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    });
    await probe.probe({ providerId: 'someprov', timeoutMs: 1000 });
    expect(seen[0]).toContain('/v1/models');
    expect(seen[0]).not.toContain('chat');
  });

  it('Registry refuses to register a probe whose billableRisk !== "none" (defense in depth)', () => {
    const reg = new ProviderProbeRegistry();
    expect(() =>
      reg.register({
        providerId: 'risky',
        endpointType: 'models',
        billableRisk: 'unknown' as 'none',
        probe: async () => ({ liveOperabilityState: 'unknown', observedAt: 0, latencyMs: 0 }),
      }),
    ).toThrow(/Refusing to register/);
  });
});

describe('registerDefaultProbes', () => {
  it('always registers Ollama (local, no auth)', () => {
    const reg = new ProviderProbeRegistry();
    const out = registerDefaultProbes(reg, { skipAutoEnv: true });
    expect(out).toContain('ollama');
    expect(reg.getMetadata('ollama').probeSupported).toBe(true);
  });

  it('does NOT register cloud providers when their env keys are missing', () => {
    const original = { ...process.env };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AIHUBMIX_API_KEY;
    delete process.env.COMETAPI_API_KEY;
    delete process.env.EDENAI_API_KEY;
    try {
      const reg = new ProviderProbeRegistry();
      const out = registerDefaultProbes(reg);
      expect(out).not.toContain('openrouter');
      expect(out).not.toContain('aihubmix');
    } finally {
      Object.assign(process.env, original);
    }
  });
});
