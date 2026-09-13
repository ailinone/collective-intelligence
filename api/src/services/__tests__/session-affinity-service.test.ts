// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Session affinity — core behavior (LOTE AW, 2026-09).
 * See session-affinity-service.multi-tenant-isolation.test.ts for the
 * (separate, most important) cross-tenant isolation proof.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionAffinityService,
  deriveSessionKey,
  deriveStablePrefixHash,
  resolveAffinityIdentifier,
  isSessionAffinityEnabled,
} from '../session-affinity-service';
import type { ChatRequest } from '@/types';

function makeFakeRedis(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  const store = new Map<string, Record<string, string>>();
  return {
    store,
    hgetall: vi.fn(async (key: string) => ({ ...(store.get(key) ?? {}) })),
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      store.set(key, { ...(store.get(key) ?? {}), ...fields });
      return 1;
    }),
    hincrby: vi.fn(async (key: string, field: string, amount: number) => {
      const existing = store.get(key) ?? {};
      const next = (Number(existing[field]) || 0) + amount;
      store.set(key, { ...existing, [field]: String(next) });
      return next;
    }),
    expire: vi.fn(async () => 1),
    ...overrides,
  };
}

describe('deriveStablePrefixHash', () => {
  it('is stable for the same system+first-user-message pair', () => {
    const messages: ChatRequest['messages'] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    expect(deriveStablePrefixHash(messages)).toBe(deriveStablePrefixHash(messages));
  });

  it('does NOT change when later turns are appended (the whole point)', () => {
    const base: ChatRequest['messages'] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
    ];
    const grown: ChatRequest['messages'] = [
      ...base,
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'turn 3' },
    ];
    expect(deriveStablePrefixHash(grown)).toBe(deriveStablePrefixHash(base));
  });

  it('changes when the system message or first user message changes', () => {
    const a: ChatRequest['messages'] = [
      { role: 'system', content: 'sys A' },
      { role: 'user', content: 'first' },
    ];
    const b: ChatRequest['messages'] = [
      { role: 'system', content: 'sys B' },
      { role: 'user', content: 'first' },
    ];
    expect(deriveStablePrefixHash(a)).not.toBe(deriveStablePrefixHash(b));
  });

  it('handles structured (array) content the same way session-key-relevant text is compared', () => {
    const stringContent: ChatRequest['messages'] = [
      { role: 'user', content: 'hello there' },
    ];
    const structuredContent: ChatRequest['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    ];
    expect(deriveStablePrefixHash(structuredContent)).toBe(deriveStablePrefixHash(stringContent));
  });
});

describe('deriveSessionKey', () => {
  it('prefers the client-supplied conversation id when present', () => {
    const withConvo: Pick<ChatRequest, 'messages' | 'ailin_session_scope'> = {
      messages: [{ role: 'user', content: 'anything' }],
      ailin_session_scope: { conversationId: 'conv-123' },
    };
    const key = deriveSessionKey(withConvo);
    expect(key).toMatch(/^conv:/);

    // Same conversationId, DIFFERENT messages -> same key (conversation id wins).
    const sameConvoDifferentMessages: Pick<ChatRequest, 'messages' | 'ailin_session_scope'> = {
      messages: [{ role: 'user', content: 'totally different text' }],
      ailin_session_scope: { conversationId: 'conv-123' },
    };
    expect(deriveSessionKey(sameConvoDifferentMessages)).toBe(key);
  });

  it('falls back to the stable-prefix hash when no conversation id is given', () => {
    const request: Pick<ChatRequest, 'messages' | 'ailin_session_scope'> = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
      ],
    };
    expect(deriveSessionKey(request)).toBe(`prefix:${deriveStablePrefixHash(request.messages)}`);
  });

  it('the conv: and prefix: tags can never collide with each other', () => {
    const convoKey = deriveSessionKey({
      messages: [],
      ailin_session_scope: { conversationId: 'x' },
    });
    const prefixKey = deriveSessionKey({ messages: [] });
    expect(convoKey.startsWith('conv:')).toBe(true);
    expect(prefixKey.startsWith('prefix:')).toBe(true);
  });
});

describe('resolveAffinityIdentifier', () => {
  it('prefers apiKeyId over userId', () => {
    expect(resolveAffinityIdentifier({ apiKeyId: 'k1', userId: 'u1' })).toBe('key:k1');
  });
  it('falls back to userId when no apiKeyId', () => {
    expect(resolveAffinityIdentifier({ userId: 'u1' })).toBe('user:u1');
  });
  it('falls back to a fixed literal when neither is present', () => {
    expect(resolveAffinityIdentifier({})).toBe('anon');
  });
});

describe('SessionAffinityService — read/write roundtrip', () => {
  it('lookup() returns null on a genuine miss', async () => {
    const service = new SessionAffinityService(() => makeFakeRedis());
    const result = await service.lookup({ organizationId: 'org', identifier: 'id', sessionKey: 'sk' });
    expect(result).toBeNull();
  });

  it('recordOutcome() then lookup() round-trips modelId/provider/turnCount', async () => {
    const redis = makeFakeRedis();
    const service = new SessionAffinityService(() => redis);
    const params = { organizationId: 'org', identifier: 'id', sessionKey: 'sk' };

    await service.recordOutcome({ ...params, modelId: 'm1', provider: 'anthropic' });
    const first = await service.lookup(params);
    expect(first?.modelId).toBe('m1');
    expect(first?.provider).toBe('anthropic');
    expect(first?.turnCount).toBe(1);

    await service.recordOutcome({
      ...params,
      modelId: 'm2',
      provider: 'openai',
      triage: { intent: 'chat', complexity: 'low', recommendedStrategy: 'single' },
    });
    const second = await service.lookup(params);
    expect(second?.modelId).toBe('m2'); // self-heals to whatever actually ran
    expect(second?.turnCount).toBe(2); // incremented, not reset
    expect(second?.triageIntent).toBe('chat');
    expect(second?.recommendedStrategy).toBe('single');
  });

  it('refreshes the TTL on every write', async () => {
    const redis = makeFakeRedis();
    const service = new SessionAffinityService(() => redis);
    await service.recordOutcome({
      organizationId: 'org',
      identifier: 'id',
      sessionKey: 'sk',
      modelId: 'm1',
      provider: 'anthropic',
    });
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });
});

describe('SessionAffinityService — fail-open behavior', () => {
  it('lookup() swallows a Redis error and returns null (never throws)', async () => {
    const redis = makeFakeRedis({
      hgetall: vi.fn(async () => {
        throw new Error('simulated Redis outage');
      }),
    });
    const service = new SessionAffinityService(() => redis as never);
    const result = await service.lookup({ organizationId: 'org', identifier: 'id', sessionKey: 'sk' });
    expect(result).toBeNull();
  });

  it('recordOutcome() swallows a Redis error and never rejects', async () => {
    const redis = makeFakeRedis({
      hset: vi.fn(async () => {
        throw new Error('simulated Redis outage');
      }),
    });
    const service = new SessionAffinityService(() => redis as never);
    await expect(
      service.recordOutcome({
        organizationId: 'org',
        identifier: 'id',
        sessionKey: 'sk',
        modelId: 'm1',
        provider: 'anthropic',
      })
    ).resolves.toBeUndefined();
  });
});

describe('SESSION_AFFINITY_ENABLED kill-switch', () => {
  afterEach(() => {
    delete process.env.SESSION_AFFINITY_ENABLED;
  });

  it('is enabled by default', () => {
    expect(isSessionAffinityEnabled()).toBe(true);
  });

  it('lookup() and recordOutcome() are no-ops when disabled', async () => {
    process.env.SESSION_AFFINITY_ENABLED = 'false';
    const redis = makeFakeRedis();
    const service = new SessionAffinityService(() => redis);

    await service.recordOutcome({
      organizationId: 'org',
      identifier: 'id',
      sessionKey: 'sk',
      modelId: 'm1',
      provider: 'anthropic',
    });
    expect(redis.hset).not.toHaveBeenCalled();

    const result = await service.lookup({ organizationId: 'org', identifier: 'id', sessionKey: 'sk' });
    expect(result).toBeNull();
    expect(redis.hgetall).not.toHaveBeenCalled();
  });
});
