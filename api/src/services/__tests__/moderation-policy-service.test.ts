// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the Moderation Policy Service — the per-tenant custom-policy core
 * behind F3/F1 §P6.
 *
 * Coverage:
 *   - CRUD round-trips (create / list / get / delete) through an in-memory DB
 *     fake that mirrors the Prisma surface the service touches;
 *   - tenant scoping: get/delete with another org's id resolves to not-found
 *     (404), and list never leaks another tenant's rows;
 *   - name-conflict (P2002) → name_conflict; missing org (P2003) → org_not_found;
 *   - PURE apply logic: custom thresholds re-flag a category the base left false;
 *     a disabled policy is a pass-through no-op; custom-category keyword match
 *     flags an org-defined category; action 'block' vs 'flag' sets `blocked`.
 *   - parser robustness (thresholds clamp/drop, custom-category coercion).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@/generated/prisma/index.js';

// ─── In-memory DB fake ────────────────────────────────────────────────────────
// A single moderation_policies table keyed by id, plus a (orgId|name) unique
// index to reproduce the P2002 conflict and a known-org set for the P2003 FK.

interface PolicyRow {
  id: string;
  organizationId: string;
  name: string;
  thresholds: unknown;
  customCategories: unknown;
  action: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const db = {
  policies: new Map<string, PolicyRow>(),
  knownOrgs: new Set<string>(),
  seq: 0,
};

function resetDb(): void {
  db.policies.clear();
  db.knownOrgs.clear();
  db.seq = 0;
}

vi.mock('@/utils/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child } };
});

vi.mock('@/database/client', () => {
  const prisma = {
    moderationPolicy: {
      create: vi.fn(async ({ data }: { data: Omit<PolicyRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
        // FK check (P2003) — org must be known.
        if (!db.knownOrgs.has(data.organizationId)) {
          throw new Prisma.PrismaClientKnownRequestError('FK violation', {
            code: 'P2003',
            clientVersion: 'test',
          });
        }
        // Unique (organizationId, name) — P2002.
        for (const row of db.policies.values()) {
          if (row.organizationId === data.organizationId && row.name === data.name) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['organization_id', 'name'] },
            });
          }
        }
        const id = `pol-${++db.seq}`;
        const now = new Date(Date.UTC(2026, 5, 13, 0, 0, db.seq));
        const row: PolicyRow = {
          id,
          organizationId: data.organizationId,
          name: data.name,
          thresholds: data.thresholds,
          customCategories: data.customCategories,
          action: data.action,
          enabled: data.enabled,
          createdAt: now,
          updatedAt: now,
        };
        db.policies.set(id, row);
        return row;
      }),
      findMany: vi.fn(
        async ({ where }: { where: { organizationId: string }; orderBy?: unknown }) => {
          return [...db.policies.values()]
            .filter((r) => r.organizationId === where.organizationId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; organizationId: string } }) => {
          const row = db.policies.get(where.id);
          if (!row || row.organizationId !== where.organizationId) return null;
          return row;
        }
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { id: string; organizationId: string } }) => {
          const row = db.policies.get(where.id);
          if (!row || row.organizationId !== where.organizationId) return { count: 0 };
          db.policies.delete(where.id);
          return { count: 1 };
        }
      ),
    },
  };
  return { prisma, Prisma };
});

// Import AFTER mocks are registered.
import {
  createPolicy,
  listPolicies,
  getPolicy,
  deletePolicy,
  applyPolicy,
  applyPolicyToItem,
  parseThresholds,
  parseCustomCategories,
  type ModerationPolicyRecord,
  type BaseModerationItem,
} from '../moderation-policy-service';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  resetDb();
  db.knownOrgs.add(ORG);
  db.knownOrgs.add(OTHER_ORG);
  vi.clearAllMocks();
});

// ─── CRUD ──────────────────────────────────────────────────────────────────────

describe('createPolicy', () => {
  it('creates a policy with defaults (action=flag, enabled=true)', async () => {
    const result = await createPolicy(ORG, { name: 'baseline' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.name).toBe('baseline');
    expect(result.policy.action).toBe('flag');
    expect(result.policy.enabled).toBe(true);
    expect(result.policy.thresholds).toEqual({});
    expect(result.policy.customCategories).toEqual([]);
    expect(result.policy.organizationId).toBe(ORG);
  });

  it('persists thresholds, customCategories, action, enabled', async () => {
    const result = await createPolicy(ORG, {
      name: 'strict',
      thresholds: { hate: 0.2, violence: 0.1 },
      customCategories: [{ name: 'pii', keywords: ['ssn', 'passport'] }],
      action: 'block',
      enabled: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.thresholds).toEqual({ hate: 0.2, violence: 0.1 });
    expect(result.policy.customCategories[0]?.name).toBe('pii');
    expect(result.policy.action).toBe('block');
    expect(result.policy.enabled).toBe(false);
  });

  it('rejects an empty name (invalid_request)', async () => {
    const result = await createPolicy(ORG, { name: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_request');
  });

  it('returns name_conflict on a duplicate name within the same org (P2002)', async () => {
    await createPolicy(ORG, { name: 'dup' });
    const result = await createPolicy(ORG, { name: 'dup' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('name_conflict');
  });

  it('allows the SAME name across different orgs (per-tenant uniqueness)', async () => {
    const a = await createPolicy(ORG, { name: 'shared' });
    const b = await createPolicy(OTHER_ORG, { name: 'shared' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('returns organization_not_found when the org FK is missing (P2003)', async () => {
    const result = await createPolicy('00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('organization_not_found');
  });
});

describe('listPolicies', () => {
  it('lists only the calling org policies, newest-first', async () => {
    await createPolicy(ORG, { name: 'a' });
    await createPolicy(ORG, { name: 'b' });
    await createPolicy(OTHER_ORG, { name: 'c' });

    const list = await listPolicies(ORG);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name)).toEqual(['b', 'a']); // newest-first
    expect(list.every((p) => p.organizationId === ORG)).toBe(true);
  });

  it('returns an empty list for an org with no policies', async () => {
    expect(await listPolicies(ORG)).toEqual([]);
  });
});

describe('getPolicy (tenant-scoped)', () => {
  it('fetches a policy owned by the caller org', async () => {
    const created = await createPolicy(ORG, { name: 'mine' });
    if (!created.ok) throw new Error('setup');
    const got = await getPolicy(ORG, created.policy.id);
    expect(got?.id).toBe(created.policy.id);
  });

  it('returns null (404) for another tenant policy id', async () => {
    const created = await createPolicy(OTHER_ORG, { name: 'theirs' });
    if (!created.ok) throw new Error('setup');
    // ORG asks for OTHER_ORG's policy → must be invisible.
    const got = await getPolicy(ORG, created.policy.id);
    expect(got).toBeNull();
  });

  it('returns null for a non-existent id', async () => {
    expect(await getPolicy(ORG, 'does-not-exist')).toBeNull();
  });
});

describe('deletePolicy (tenant-scoped)', () => {
  it('deletes a policy owned by the caller org', async () => {
    const created = await createPolicy(ORG, { name: 'todelete' });
    if (!created.ok) throw new Error('setup');
    expect(await deletePolicy(ORG, created.policy.id)).toBe(true);
    expect(await getPolicy(ORG, created.policy.id)).toBeNull();
  });

  it('does NOT delete another tenant policy (returns false, row survives)', async () => {
    const created = await createPolicy(OTHER_ORG, { name: 'survivor' });
    if (!created.ok) throw new Error('setup');
    expect(await deletePolicy(ORG, created.policy.id)).toBe(false);
    // The row still exists for its real owner.
    expect(await getPolicy(OTHER_ORG, created.policy.id)).not.toBeNull();
  });

  it('returns false for a non-existent id', async () => {
    expect(await deletePolicy(ORG, 'nope')).toBe(false);
  });
});

// ─── Pure apply logic ──────────────────────────────────────────────────────────

function baseItem(over: Partial<BaseModerationItem> = {}): BaseModerationItem {
  return {
    flagged: false,
    categories: { hate: false, violence: false, harassment: false },
    category_scores: { hate: 0, violence: 0, harassment: 0 },
    ...over,
  };
}

function policy(over: Partial<ModerationPolicyRecord> = {}): ModerationPolicyRecord {
  return {
    id: 'pol-x',
    organizationId: ORG,
    name: 'p',
    thresholds: {},
    customCategories: [],
    action: 'flag',
    enabled: true,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...over,
  };
}

describe('applyPolicyToItem — custom thresholds change flagged', () => {
  it('re-flags a category the base left false when its score meets the org threshold', () => {
    const base = baseItem({
      flagged: false,
      categories: { hate: false, violence: false },
      category_scores: { hate: 0.35, violence: 0.05 },
    });
    const p = policy({ thresholds: { hate: 0.3 } });

    const out = applyPolicyToItem(p, base, 'some text');
    expect(out.categories.hate).toBe(true);
    expect(out.flagged).toBe(true);
    expect(out.policy_triggered).toContain('hate');
  });

  it('does NOT re-flag when the score is below the org threshold', () => {
    const base = baseItem({ category_scores: { hate: 0.1, violence: 0, harassment: 0 } });
    const p = policy({ thresholds: { hate: 0.3 } });

    const out = applyPolicyToItem(p, base, 'text');
    expect(out.categories.hate).toBe(false);
    expect(out.flagged).toBe(false);
    expect(out.policy_triggered).toEqual([]);
  });

  it('keeps the base flag when the base already flagged (no threshold change)', () => {
    const base = baseItem({ flagged: true, categories: { hate: true, violence: false, harassment: false } });
    const p = policy({ thresholds: {} });

    const out = applyPolicyToItem(p, base, 'text');
    expect(out.flagged).toBe(true);
  });
});

describe('applyPolicyToItem — disabled policy is a no-op', () => {
  it('returns the base result unchanged when the policy is disabled', () => {
    const base = baseItem({ category_scores: { hate: 0.9, violence: 0, harassment: 0 } });
    const p = policy({ enabled: false, thresholds: { hate: 0.1 }, action: 'block' });

    const out = applyPolicyToItem(p, base, 'text');
    expect(out.flagged).toBe(false); // not re-flagged
    expect(out.categories.hate).toBe(false);
    expect(out.blocked).toBeUndefined();
  });
});

describe('applyPolicyToItem — custom categories (keyword match)', () => {
  it('flags an org-defined custom category when a keyword is present', () => {
    const base = baseItem();
    const p = policy({ customCategories: [{ name: 'company_secrets', keywords: ['roadmap', 'internal'] }] });

    const out = applyPolicyToItem(p, base, 'Here is our internal roadmap for Q3');
    expect(out.categories.company_secrets).toBe(true);
    expect(out.category_scores.company_secrets).toBe(1);
    expect(out.flagged).toBe(true);
    expect(out.policy_triggered).toContain('company_secrets');
  });

  it('does NOT flag a custom category when no keyword is present', () => {
    const base = baseItem();
    const p = policy({ customCategories: [{ name: 'company_secrets', keywords: ['roadmap'] }] });

    const out = applyPolicyToItem(p, base, 'totally benign text');
    expect(out.categories.company_secrets).toBe(false);
    expect(out.category_scores.company_secrets).toBe(0);
    expect(out.flagged).toBe(false);
  });

  it('matches keywords case-insensitively', () => {
    const base = baseItem();
    const p = policy({ customCategories: [{ name: 'secret', keywords: ['CONFIDENTIAL'] }] });
    const out = applyPolicyToItem(p, base, 'this is confidential');
    expect(out.categories.secret).toBe(true);
  });
});

describe('applyPolicyToItem — action block vs flag', () => {
  it("action 'block' sets blocked=true on a flagged result", () => {
    const base = baseItem({ category_scores: { hate: 0.5, violence: 0, harassment: 0 } });
    const p = policy({ thresholds: { hate: 0.3 }, action: 'block' });

    const out = applyPolicyToItem(p, base, 'text');
    expect(out.flagged).toBe(true);
    expect(out.blocked).toBe(true);
  });

  it("action 'block' sets blocked=false when nothing trips", () => {
    const base = baseItem({ category_scores: { hate: 0.1, violence: 0, harassment: 0 } });
    const p = policy({ thresholds: { hate: 0.3 }, action: 'block' });

    const out = applyPolicyToItem(p, base, 'text');
    expect(out.flagged).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it("action 'flag' never sets the blocked field", () => {
    const base = baseItem({ category_scores: { hate: 0.9, violence: 0, harassment: 0 } });
    const p = policy({ thresholds: { hate: 0.3 }, action: 'flag' });

    const out = applyPolicyToItem(p, base, 'text');
    expect(out.flagged).toBe(true);
    expect(out.blocked).toBeUndefined();
  });
});

describe('applyPolicy — batch', () => {
  it('applies across a parallel batch of items + inputs', () => {
    const items = [
      baseItem({ category_scores: { hate: 0.5, violence: 0, harassment: 0 } }),
      baseItem({ category_scores: { hate: 0.0, violence: 0, harassment: 0 } }),
    ];
    const inputs = ['hateful', 'benign'];
    const p = policy({ thresholds: { hate: 0.3 } });

    const out = applyPolicy(p, items, inputs);
    expect(out[0]?.flagged).toBe(true);
    expect(out[1]?.flagged).toBe(false);
  });
});

// ─── Parser robustness ──────────────────────────────────────────────────────────

describe('parseThresholds', () => {
  it('clamps to [0,1], drops non-finite, ignores non-objects', () => {
    expect(parseThresholds({ hate: 1.5, violence: -0.2, x: 'nope', y: 0.4 })).toEqual({
      hate: 1,
      violence: 0,
      y: 0.4,
    });
    expect(parseThresholds(null)).toEqual({});
    expect(parseThresholds([1, 2, 3])).toEqual({});
  });
});

describe('parseCustomCategories', () => {
  it('drops malformed entries and coerces keywords', () => {
    const out = parseCustomCategories([
      { name: 'ok', keywords: ['a', '', 'b', 5] },
      { name: '', keywords: ['x'] }, // dropped (no name)
      'not-an-object',
      { keywords: ['y'] }, // dropped (no name)
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('ok');
    expect(out[0]?.keywords).toEqual(['a', 'b']);
  });

  it('returns [] for non-arrays', () => {
    expect(parseCustomCategories(undefined)).toEqual([]);
    expect(parseCustomCategories({})).toEqual([]);
  });
});
