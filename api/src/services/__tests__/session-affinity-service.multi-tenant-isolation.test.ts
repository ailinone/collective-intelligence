// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Session affinity — MULTI-TENANT ISOLATION PROOF (LOTE AW, 2026-09).
 *
 * This is the single most important test in the session-affinity change.
 * The hard requirement (CLAUDE.md, this session): a session-affinity cache
 * entry must be scoped within organizationId/apiKey, mirroring
 * `token-bucket-limiter.ts`'s `scope:identifier` pattern — never letting one
 * tenant's cached routing decision leak to or affect another.
 *
 * The test below is deliberately adversarial: it uses the SAME Redis
 * keyspace (one shared fake client — exactly like production, where every
 * organization shares the ONE process-wide `getSessionAffinityService()`
 * singleton and the ONE local Redis instance), the SAME resolved identifier
 * string, and the SAME sessionKey string across two different
 * organizations. If organizationId were dropped anywhere in the key
 * composition, this is the scenario that would silently leak Org A's routing
 * decision into Org B's request. It doesn't.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionAffinityService,
  buildAffinityRedisKey,
  deriveSessionKey,
  resolveAffinityIdentifier,
} from '../session-affinity-service';
import type { ChatRequest } from '@/types';

/** Minimal in-memory Redis-hash fake, shared across all "tenants" in a
 *  test — exactly like a real Redis instance is shared across all
 *  organizations in production. Mirrors the house pattern used by
 *  free-tier-quota-gate.test.ts / distributed-bulkhead.test.ts. */
function makeFakeRedis() {
  const store = new Map<string, Record<string, string>>();
  return {
    store,
    async hgetall(key: string): Promise<Record<string, string>> {
      return { ...(store.get(key) ?? {}) };
    },
    async hset(key: string, fields: Record<string, string>): Promise<number> {
      const existing = store.get(key) ?? {};
      store.set(key, { ...existing, ...fields });
      return Object.keys(fields).length;
    },
    async hincrby(key: string, field: string, amount: number): Promise<number> {
      const existing = store.get(key) ?? {};
      const next = (Number(existing[field]) || 0) + amount;
      store.set(key, { ...existing, [field]: String(next) });
      return next;
    },
    async expire(): Promise<number> {
      return 1;
    },
  };
}

describe('Session affinity — multi-tenant isolation (hard requirement)', () => {
  let redis: ReturnType<typeof makeFakeRedis>;
  let service: SessionAffinityService;

  beforeEach(() => {
    redis = makeFakeRedis();
    // ONE service instance for the whole test, sharing ONE Redis client —
    // this is the real production topology (one singleton, one Redis,
    // every organization). If isolation depended on separate service
    // instances rather than the KEY, this test would catch it.
    service = new SessionAffinityService(() => redis);
  });

  it('a write under Org A is invisible to a lookup under Org B, even with an IDENTICAL identifier and sessionKey', async () => {
    const identicalIdentifier = 'user:u1'; // deliberately the SAME for both orgs
    const identicalSessionKey = 'prefix:deadbeef'; // deliberately the SAME for both orgs

    await service.recordOutcome({
      organizationId: 'org-A',
      identifier: identicalIdentifier,
      sessionKey: identicalSessionKey,
      modelId: 'org-a-secret-model',
      provider: 'anthropic',
    });

    const orgBLookup = await service.lookup({
      organizationId: 'org-B',
      identifier: identicalIdentifier,
      sessionKey: identicalSessionKey,
    });
    expect(orgBLookup).toBeNull();

    // Sanity: the mechanism actually works — Org A sees its own write.
    const orgALookup = await service.lookup({
      organizationId: 'org-A',
      identifier: identicalIdentifier,
      sessionKey: identicalSessionKey,
    });
    expect(orgALookup?.modelId).toBe('org-a-secret-model');
  });

  it('two different API keys under the SAME organization also never collide', async () => {
    // A single org can hold multiple API keys/callers whose conversations
    // must not cross-pollinate either (design §1.2).
    const sameOrg = 'org-shared';
    const sameSessionKey = 'prefix:samehistory';

    await service.recordOutcome({
      organizationId: sameOrg,
      identifier: resolveAffinityIdentifier({ apiKeyId: 'key-1' }),
      sessionKey: sameSessionKey,
      modelId: 'key-1-model',
      provider: 'openai',
    });
    await service.recordOutcome({
      organizationId: sameOrg,
      identifier: resolveAffinityIdentifier({ apiKeyId: 'key-2' }),
      sessionKey: sameSessionKey,
      modelId: 'key-2-model',
      provider: 'openai',
    });

    const key1Result = await service.lookup({
      organizationId: sameOrg,
      identifier: resolveAffinityIdentifier({ apiKeyId: 'key-1' }),
      sessionKey: sameSessionKey,
    });
    const key2Result = await service.lookup({
      organizationId: sameOrg,
      identifier: resolveAffinityIdentifier({ apiKeyId: 'key-2' }),
      sessionKey: sameSessionKey,
    });

    expect(key1Result?.modelId).toBe('key-1-model');
    expect(key2Result?.modelId).toBe('key-2-model');
  });

  it('end-to-end: two organizations with a BYTE-IDENTICAL conversation prefix never collide', async () => {
    // The realistic attack surface: two completely unrelated tenants happen
    // to send the exact same system prompt + first user message (a common
    // template, e.g. a shared support-bot prompt). The stable-prefix hash
    // (deriveSessionKey) would then be IDENTICAL for both — isolation must
    // come entirely from organizationId in the Redis key, not from the hash
    // happening to differ.
    const identicalRequest: Pick<ChatRequest, 'messages' | 'ailin_session_scope'> = {
      messages: [
        { role: 'system', content: 'You are a helpful support assistant.' },
        { role: 'user', content: 'How do I reset my password?' },
      ],
    };
    const sessionKey = deriveSessionKey(identicalRequest);
    const identifier = resolveAffinityIdentifier({ userId: 'shared-anonymous-caller' });

    await service.recordOutcome({
      organizationId: 'tenant-1',
      identifier,
      sessionKey,
      modelId: 'tenant-1-pinned-model',
      provider: 'anthropic',
    });
    await service.recordOutcome({
      organizationId: 'tenant-2',
      identifier,
      sessionKey,
      modelId: 'tenant-2-pinned-model',
      provider: 'openai',
    });

    const tenant1 = await service.lookup({ organizationId: 'tenant-1', identifier, sessionKey });
    const tenant2 = await service.lookup({ organizationId: 'tenant-2', identifier, sessionKey });

    expect(tenant1?.modelId).toBe('tenant-1-pinned-model');
    expect(tenant2?.modelId).toBe('tenant-2-pinned-model');
    expect(tenant1?.modelId).not.toBe(tenant2?.modelId);
  });

  it('lookup() refuses to run at all without an organizationId (never a tenant-less read)', async () => {
    await service.recordOutcome({
      organizationId: 'org-A',
      identifier: 'user:u1',
      sessionKey: 'prefix:x',
      modelId: 'leaked-model',
      provider: 'anthropic',
    });
    // @ts-expect-error — deliberately passing an empty organizationId to
    // prove the guard, not to exercise a real caller path.
    const result = await service.lookup({ organizationId: '', identifier: 'user:u1', sessionKey: 'prefix:x' });
    expect(result).toBeNull();
  });
});

describe('buildAffinityRedisKey — structural collision-impossibility', () => {
  it('produces a different key for every organizationId, identifier, or sessionKey change', () => {
    const base = buildAffinityRedisKey('org-A', 'user:u1', 'prefix:x');
    expect(buildAffinityRedisKey('org-B', 'user:u1', 'prefix:x')).not.toBe(base);
    expect(buildAffinityRedisKey('org-A', 'user:u2', 'prefix:x')).not.toBe(base);
    expect(buildAffinityRedisKey('org-A', 'user:u1', 'prefix:y')).not.toBe(base);
  });

  it('organizationId is not string-concatenation-ambiguous with identifier/sessionKey', () => {
    // A naive `${org}${identifier}` (no separator) could let 'org-A' + 'B:x'
    // collide with 'org-AB' + ':x'. The ':' delimiter plus each segment
    // being an opaque, non-':'-containing value in practice makes this a
    // non-issue, but pin two adjacent-looking compositions explicitly.
    const a = buildAffinityRedisKey('org-A', 'B', 'x');
    const b = buildAffinityRedisKey('org-AB', '', 'x');
    expect(a).not.toBe(b);
  });
});
