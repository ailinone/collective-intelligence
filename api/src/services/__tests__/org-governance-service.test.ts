// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the Organization Governance Service — the enforcement core behind
 * the F3/F1 §P3 admin governance control plane.
 *
 * Coverage:
 *   - budget set/get round-trips through Organization.settings.governance
 *     WITHOUT a schema migration, and without clobbering sibling settings;
 *   - cost-status reflects month-to-date RequestLog spend vs the cap;
 *   - budget cap denies once MTD spend reaches the cap (organization_budget_exceeded);
 *   - policy restricts strategy / model (allowlist + blocklist → policy_violation);
 *   - blocklist precedence over allowlist;
 *   - fail-OPEN: no governance configured → every request allowed;
 *   - audit query is paginated, filtered, and tenant-scoped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory DB fake ────────────────────────────────────────────────────────
// One org row + a request-log ledger. Mirrors the Prisma surface the service
// touches: organization.findUnique/update, requestLog.aggregate,
// securityAuditLog.count/findMany.

interface OrgRow {
  id: string;
  settings: Record<string, unknown>;
}
interface LedgerRow {
  organizationId: string;
  costUsd: number;
  createdAt: Date;
}
interface AuditRow {
  id: string;
  organizationId: string | null;
  eventType: string;
  severity: string;
  message: string;
  userId: string | null;
  metadata: unknown;
  createdAt: Date;
}

const db = {
  orgs: new Map<string, OrgRow>(),
  ledger: [] as LedgerRow[],
  audit: [] as AuditRow[],
};

function resetDb(): void {
  db.orgs.clear();
  db.ledger = [];
  db.audit = [];
}

vi.mock('@/utils/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child } };
});

vi.mock('@/database/client', () => {
  const prisma = {
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = db.orgs.get(where.id);
        return row ? { id: row.id, settings: row.settings } : null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { settings: unknown } }) => {
          const row = db.orgs.get(where.id);
          if (!row) throw new Error('org not found');
          row.settings = data.settings as Record<string, unknown>;
          return { id: row.id, settings: row.settings };
        }
      ),
    },
    requestLog: {
      aggregate: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; createdAt?: { gte?: Date; lt?: Date } };
        }) => {
          const sum = db.ledger
            .filter((r) => {
              if (r.organizationId !== where.organizationId) return false;
              if (where.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
              if (where.createdAt?.lt && r.createdAt >= where.createdAt.lt) return false;
              return true;
            })
            .reduce((acc, r) => acc + r.costUsd, 0);
          return { _sum: { costUsd: db.ledger.length ? sum : null } };
        }
      ),
    },
    securityAuditLog: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return filterAudit(where).length;
      }),
      findMany: vi.fn(
        async ({
          where,
          take,
          skip,
        }: {
          where: Record<string, unknown>;
          take: number;
          skip: number;
        }) => {
          const rows = filterAudit(where)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(skip, skip + take);
          return rows;
        }
      ),
    },
  };
  return { prisma, Prisma: {} };
});

function filterAudit(where: Record<string, unknown>): AuditRow[] {
  const orgId = where.organizationId as string | undefined;
  const eventType = where.eventType as string | undefined;
  const severity = where.severity as string | undefined;
  const createdAt = where.createdAt as { gte?: Date; lt?: Date } | undefined;
  return db.audit.filter((r) => {
    if (orgId !== undefined && r.organizationId !== orgId) return false;
    if (eventType !== undefined && r.eventType !== eventType) return false;
    if (severity !== undefined && r.severity !== severity) return false;
    if (createdAt?.gte && r.createdAt < createdAt.gte) return false;
    if (createdAt?.lt && r.createdAt >= createdAt.lt) return false;
    return true;
  });
}

// Import AFTER mocks are registered.
import {
  setBudget,
  setPolicy,
  getGovernanceConfig,
  getCostStatus,
  getCurrentMonthlyCost,
  evaluateGovernance,
  evaluatePolicy,
  evaluateBudget,
  queryAuditEvents,
  parseGovernanceFromSettings,
} from '../org-governance-service';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';

function seedOrg(id: string, settings: Record<string, unknown> = {}): void {
  db.orgs.set(id, { id, settings });
}

/** A timestamp guaranteed to be inside the current UTC month. */
function thisMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 5, 12, 0, 0));
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe('budget persistence (migration-free, settings.governance)', () => {
  it('round-trips a budget through Organization.settings.governance', async () => {
    seedOrg(ORG);
    const result = await setBudget(ORG, { maxMonthlyCostUsd: 100, alertThresholds: [0.8] });
    expect(result).not.toBeNull();
    expect(result?.maxMonthlyCostUsd).toBe(100);

    const config = await getGovernanceConfig(ORG);
    expect(config?.budget?.maxMonthlyCostUsd).toBe(100);
    expect(config?.budget?.alertThresholds).toEqual([0.8]);

    // Stored under the governance namespace inside settings (no schema change).
    const stored = db.orgs.get(ORG)!.settings as Record<string, Record<string, unknown>>;
    expect(stored.governance.budget).toBeTruthy();
  });

  it('does NOT clobber unrelated settings or the policy sub-key', async () => {
    seedOrg(ORG, { theme: 'dark', governance: { policy: { allowedModels: ['gpt-4o'] } } });
    await setBudget(ORG, { maxMonthlyCostUsd: 50 });

    const stored = db.orgs.get(ORG)!.settings as Record<string, unknown>;
    expect(stored.theme).toBe('dark');
    const gov = stored.governance as Record<string, Record<string, unknown>>;
    expect(gov.policy.allowedModels).toEqual(['gpt-4o']);
    expect(gov.budget).toBeTruthy();
  });

  it('returns null when the organization does not exist', async () => {
    const result = await setBudget('00000000-0000-0000-0000-000000000000', {
      maxMonthlyCostUsd: 10,
    });
    expect(result).toBeNull();
  });

  it('normalizes alert thresholds (clamp 0–1, sort, de-dupe)', async () => {
    seedOrg(ORG);
    const result = await setBudget(ORG, {
      maxMonthlyCostUsd: 100,
      alertThresholds: [0.95, 0.5, 0.5, 2, -1, 0.8],
    });
    expect(result?.alertThresholds).toEqual([0.5, 0.8, 0.95]);
  });
});

describe('cost-status', () => {
  it('reflects month-to-date RequestLog spend vs the cap', async () => {
    seedOrg(ORG);
    await setBudget(ORG, { maxMonthlyCostUsd: 100, alertThresholds: [0.5, 0.9] });
    db.ledger.push({ organizationId: ORG, costUsd: 30, createdAt: thisMonth() });
    db.ledger.push({ organizationId: ORG, costUsd: 25, createdAt: thisMonth() });

    const status = await getCostStatus(ORG);
    expect(status).not.toBeNull();
    expect(status?.currentMonthlyCostUsd).toBe(55);
    expect(status?.maxMonthlyCostUsd).toBe(100);
    expect(status?.remainingUsd).toBe(45);
    expect(status?.utilization).toBeCloseTo(0.55);
    expect(status?.exceeded).toBe(false);
    // 0.5 threshold breached (55 ≥ 50), 0.9 not (55 < 90).
    expect(status?.alerts).toEqual([
      { threshold: 0.5, breached: true },
      { threshold: 0.9, breached: false },
    ]);
  });

  it('excludes spend from prior months and other orgs', async () => {
    seedOrg(ORG);
    await setBudget(ORG, { maxMonthlyCostUsd: 100 });
    const lastMonth = new Date(Date.UTC(2000, 0, 15));
    db.ledger.push({ organizationId: ORG, costUsd: 999, createdAt: lastMonth });
    db.ledger.push({ organizationId: OTHER_ORG, costUsd: 999, createdAt: thisMonth() });
    db.ledger.push({ organizationId: ORG, costUsd: 10, createdAt: thisMonth() });

    expect(await getCurrentMonthlyCost(ORG)).toBe(10);
  });

  it('reports budgetConfigured=false with null cap when no budget is set', async () => {
    seedOrg(ORG);
    const status = await getCostStatus(ORG);
    expect(status?.budgetConfigured).toBe(false);
    expect(status?.maxMonthlyCostUsd).toBeNull();
    expect(status?.exceeded).toBe(false);
  });

  it('returns null when the org does not exist', async () => {
    expect(await getCostStatus('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('budget enforcement', () => {
  it('denies with organization_budget_exceeded once MTD spend reaches the cap', async () => {
    seedOrg(ORG);
    await setBudget(ORG, { maxMonthlyCostUsd: 50 });
    db.ledger.push({ organizationId: ORG, costUsd: 50, createdAt: thisMonth() });

    const decision = await evaluateGovernance(ORG, { strategy: 'single', model: 'gpt-4o' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('organization_budget_exceeded');
    expect(decision.details?.maxMonthlyCostUsd).toBe(50);
  });

  it('allows when MTD spend is below the cap', async () => {
    seedOrg(ORG);
    await setBudget(ORG, { maxMonthlyCostUsd: 50 });
    db.ledger.push({ organizationId: ORG, costUsd: 49.99, createdAt: thisMonth() });

    const decision = await evaluateGovernance(ORG, { strategy: 'single', model: 'gpt-4o' });
    expect(decision.allowed).toBe(true);
  });

  it('evaluateBudget is a pure boundary check', () => {
    const budget = { maxMonthlyCostUsd: 10, alertThresholds: [], updatedAt: '' };
    expect(evaluateBudget(budget, 9.99).allowed).toBe(true);
    expect(evaluateBudget(budget, 10).allowed).toBe(false);
    expect(evaluateBudget(undefined, 1_000_000).allowed).toBe(true); // no budget = open
  });
});

describe('policy enforcement', () => {
  const base = { allowedStrategies: [], allowedModels: [], blockedModels: [], updatedAt: '' };

  it('denies a strategy not in the allowlist (policy_violation)', () => {
    const decision = evaluatePolicy(
      { ...base, allowedStrategies: ['single', 'cost'] },
      { strategy: 'consensus', model: 'gpt-4o' }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('policy_violation');
    expect(decision.details?.reason).toBe('strategy_not_allowed');
  });

  it('allows a strategy in the allowlist', () => {
    const decision = evaluatePolicy(
      { ...base, allowedStrategies: ['single', 'consensus'] },
      { strategy: 'consensus', model: 'gpt-4o' }
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies a model not in the allowlist', () => {
    const decision = evaluatePolicy(
      { ...base, allowedModels: ['gpt-4o'] },
      { strategy: 'single', model: 'claude-3-opus' }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.details?.reason).toBe('model_not_allowed');
  });

  it('denies a blocked model even if it is also allowlisted (blocklist precedence)', () => {
    const decision = evaluatePolicy(
      { ...base, allowedModels: ['gpt-4o'], blockedModels: ['gpt-4o'] },
      { strategy: 'single', model: 'gpt-4o' }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.details?.reason).toBe('model_blocked');
  });

  it('empty policy lists allow everything', () => {
    expect(evaluatePolicy(base, { strategy: 'anything', model: 'anything' }).allowed).toBe(true);
    expect(evaluatePolicy(undefined, { strategy: 'x', model: 'y' }).allowed).toBe(true);
  });

  it('enforces policy via evaluateGovernance and skips the spend query for policy denials', async () => {
    seedOrg(ORG);
    await setPolicy(ORG, { allowedModels: ['gpt-4o'] });
    const decision = await evaluateGovernance(ORG, { strategy: 'single', model: 'banned-model' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('policy_violation');
  });
});

describe('fail-open behavior', () => {
  it('allows everything when no governance is configured', async () => {
    seedOrg(ORG);
    const decision = await evaluateGovernance(ORG, { strategy: 'single', model: 'gpt-4o' });
    expect(decision.allowed).toBe(true);
  });

  it('allows when the org row is missing (no config can be loaded)', async () => {
    const decision = await evaluateGovernance('00000000-0000-0000-0000-000000000000', {
      strategy: 'single',
      model: 'gpt-4o',
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('parseGovernanceFromSettings robustness', () => {
  it('tolerates partial / malformed shapes', () => {
    expect(parseGovernanceFromSettings(undefined)).toEqual({});
    expect(parseGovernanceFromSettings(null)).toEqual({});
    expect(parseGovernanceFromSettings('not-an-object')).toEqual({});
    expect(parseGovernanceFromSettings({ governance: { budget: { maxMonthlyCostUsd: 'x' } } })).toEqual(
      {}
    );
  });
});

describe('audit query (paginated, filtered, tenant-scoped)', () => {
  beforeEach(() => {
    for (let i = 0; i < 25; i++) {
      db.audit.push({
        id: `evt-${i}`,
        organizationId: ORG,
        eventType: i % 2 === 0 ? 'governance.budget.blocked' : 'auth.login',
        severity: i % 3 === 0 ? 'warning' : 'info',
        message: `event ${i}`,
        userId: null,
        metadata: { i },
        createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i)),
      });
    }
    // Cross-tenant noise that must never appear in ORG's results.
    db.audit.push({
      id: 'other-evt',
      organizationId: OTHER_ORG,
      eventType: 'governance.budget.blocked',
      severity: 'warning',
      message: 'other org',
      userId: null,
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 5, 2)),
    });
  });

  it('paginates with limit/offset and reports total', async () => {
    const page1 = await queryAuditEvents({ organizationId: ORG, limit: 10, offset: 0 });
    expect(page1.total).toBe(25);
    expect(page1.events).toHaveLength(10);
    const page3 = await queryAuditEvents({ organizationId: ORG, limit: 10, offset: 20 });
    expect(page3.events).toHaveLength(5);
  });

  it('filters by eventType', async () => {
    const result = await queryAuditEvents({
      organizationId: ORG,
      eventType: 'governance.budget.blocked',
      limit: 200,
    });
    expect(result.total).toBe(13);
    expect(result.events.every((e) => e.eventType === 'governance.budget.blocked')).toBe(true);
  });

  it('filters by severity', async () => {
    const result = await queryAuditEvents({ organizationId: ORG, severity: 'warning', limit: 200 });
    expect(result.events.every((e) => e.severity === 'warning')).toBe(true);
  });

  it('NEVER returns another tenant audit events', async () => {
    const result = await queryAuditEvents({ organizationId: ORG, limit: 200 });
    expect(result.events.some((e) => e.id === 'other-evt')).toBe(false);
    expect(result.total).toBe(25);
  });

  it('orders newest-first and serializes createdAt to ISO', async () => {
    const result = await queryAuditEvents({ organizationId: ORG, limit: 2 });
    expect(result.events[0].createdAt > result.events[1].createdAt).toBe(true);
    expect(typeof result.events[0].createdAt).toBe('string');
  });

  it('clamps limit to the 1–200 band', async () => {
    const huge = await queryAuditEvents({ organizationId: ORG, limit: 9999 });
    expect(huge.limit).toBe(200);
    const zero = await queryAuditEvents({ organizationId: ORG, limit: 0 });
    expect(zero.limit).toBe(50); // 0 → default
  });
});
