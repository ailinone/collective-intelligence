// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Governance Service
 *
 * Enterprise governance primitives persisted WITHOUT a schema migration:
 * budget caps and access policy live inside the existing `Organization.settings`
 * JSON column under a dedicated `governance` namespace. This keeps tenant config
 * additive — `organization-settings-routes.ts` merges siblings, and nothing here
 * touches the Prisma schema.
 *
 * Responsibilities
 * ────────────────
 *  - Read/write the budget + policy config (`Organization.settings.governance`).
 *  - Derive month-to-date spend from the authoritative billing ledger
 *    (`RequestLog.costUsd`, the same column the billing dashboard sums).
 *  - Evaluate a request against budget + policy (`evaluateGovernance`) and
 *    return a clean allow/deny decision the chat path enforces.
 *  - Query the persisted audit trail (`SecurityAuditLog`), paginated + filtered.
 *
 * Enforcement is fail-OPEN by design: if no budget/policy is configured (the
 * common case), every request passes through untouched. A configured cap or
 * allow/block list is the only thing that can deny.
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'org-governance-service' });

export const GOVERNANCE_SETTINGS_KEY = 'governance' as const;

// ─── Config shapes ──────────────────────────────────────────────────────────

export interface OrgBudgetConfig {
  /** Hard monthly spend cap in USD. Requests are denied once MTD spend ≥ this. */
  maxMonthlyCostUsd: number;
  /**
   * Fractions of the cap (0–1) at which the cost-status endpoint flips a
   * threshold to `breached`. Purely informational — does NOT block. Sorted asc.
   */
  alertThresholds: number[];
  updatedAt: string;
  updatedBy?: string;
}

export interface OrgPolicyConfig {
  /** If non-empty, ONLY these execution strategies are permitted. */
  allowedStrategies: string[];
  /** If non-empty, ONLY these models are permitted (exact match). */
  allowedModels: string[];
  /** These models are always denied (takes precedence over allowedModels). */
  blockedModels: string[];
  updatedAt: string;
  updatedBy?: string;
}

export interface OrgGovernanceConfig {
  budget?: OrgBudgetConfig;
  policy?: OrgPolicyConfig;
}

// ─── Decision shapes ──────────────────────────────────────────────────────────

export type GovernanceDenyCode = 'organization_budget_exceeded' | 'policy_violation';

export interface GovernanceDecision {
  allowed: boolean;
  /** Stable error code surfaced to the client when `allowed` is false. */
  code?: GovernanceDenyCode;
  /** Human-readable explanation. */
  message?: string;
  /** Structured context for logging / audit (never leaks secrets). */
  details?: Record<string, unknown>;
}

export interface GovernanceRequestShape {
  /** Canonical strategy the engine will execute (post-normalization). */
  strategy?: string | null;
  /** Resolved model id (post-alias-resolution). */
  model?: string | null;
}

export interface CostStatus {
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  currentMonthlyCostUsd: number;
  maxMonthlyCostUsd: number | null;
  remainingUsd: number | null;
  utilization: number | null;
  budgetConfigured: boolean;
  exceeded: boolean;
  alerts: { threshold: number; breached: boolean }[];
}

// ─── Settings (de)serialization ───────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function coerceNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Parse the `governance` namespace out of a raw `Organization.settings` JSON
 * blob. Tolerant of partial / legacy shapes — anything unparseable is dropped.
 */
export function parseGovernanceFromSettings(settings: unknown): OrgGovernanceConfig {
  const root = asRecord(settings);
  const gov = asRecord(root[GOVERNANCE_SETTINGS_KEY]);

  const result: OrgGovernanceConfig = {};

  const budgetRaw = asRecord(gov.budget);
  if (typeof budgetRaw.maxMonthlyCostUsd === 'number' && Number.isFinite(budgetRaw.maxMonthlyCostUsd)) {
    result.budget = {
      maxMonthlyCostUsd: budgetRaw.maxMonthlyCostUsd,
      alertThresholds: coerceNumberArray(budgetRaw.alertThresholds),
      updatedAt: typeof budgetRaw.updatedAt === 'string' ? budgetRaw.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof budgetRaw.updatedBy === 'string' ? budgetRaw.updatedBy : undefined,
    };
  }

  const policyRaw = asRecord(gov.policy);
  const allowedStrategies = coerceStringArray(policyRaw.allowedStrategies);
  const allowedModels = coerceStringArray(policyRaw.allowedModels);
  const blockedModels = coerceStringArray(policyRaw.blockedModels);
  if (allowedStrategies.length || allowedModels.length || blockedModels.length || policyRaw.updatedAt) {
    result.policy = {
      allowedStrategies,
      allowedModels,
      blockedModels,
      updatedAt: typeof policyRaw.updatedAt === 'string' ? policyRaw.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof policyRaw.updatedBy === 'string' ? policyRaw.updatedBy : undefined,
    };
  }

  return result;
}

/**
 * Load governance config for an org. Returns `null` when the org does not exist
 * (callers map this to 404), or an empty config when nothing is configured yet.
 */
export async function getGovernanceConfig(
  organizationId: string
): Promise<OrgGovernanceConfig | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, settings: true },
  });
  if (!org) return null;
  return parseGovernanceFromSettings(org.settings);
}

/**
 * Merge a governance sub-config into the org's existing settings JSON WITHOUT
 * clobbering unrelated settings keys or the other governance sub-key. Returns
 * `null` if the org does not exist.
 */
async function mergeGovernance(
  organizationId: string,
  patch: OrgGovernanceConfig
): Promise<OrgGovernanceConfig | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, settings: true },
  });
  if (!org) return null;

  const existingSettings = asRecord(org.settings);
  const existingGov = asRecord(existingSettings[GOVERNANCE_SETTINGS_KEY]);

  const mergedGov: Record<string, unknown> = { ...existingGov };
  if (patch.budget !== undefined) mergedGov.budget = patch.budget;
  if (patch.policy !== undefined) mergedGov.policy = patch.policy;

  const mergedSettings: Record<string, unknown> = {
    ...existingSettings,
    [GOVERNANCE_SETTINGS_KEY]: mergedGov,
  };

  await prisma.organization.update({
    where: { id: organizationId },
    data: { settings: mergedSettings as Prisma.InputJsonValue },
  });

  return parseGovernanceFromSettings(mergedSettings);
}

export interface SetBudgetInput {
  maxMonthlyCostUsd: number;
  alertThresholds?: number[];
  updatedBy?: string;
}

/**
 * Persist a budget cap. Returns the stored config, or `null` if org missing.
 * Validation (positive cap, threshold range) is the caller's responsibility;
 * this normalizes thresholds (clamped to 0–1, sorted, de-duped).
 */
export async function setBudget(
  organizationId: string,
  input: SetBudgetInput
): Promise<OrgBudgetConfig | null> {
  const thresholds = Array.from(
    new Set((input.alertThresholds ?? [0.5, 0.8, 0.95]).filter((t) => t > 0 && t <= 1))
  ).sort((a, b) => a - b);

  const budget: OrgBudgetConfig = {
    maxMonthlyCostUsd: input.maxMonthlyCostUsd,
    alertThresholds: thresholds,
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };

  const merged = await mergeGovernance(organizationId, { budget });
  if (!merged) return null;
  return merged.budget ?? budget;
}

export interface SetPolicyInput {
  allowedStrategies?: string[];
  allowedModels?: string[];
  blockedModels?: string[];
  updatedBy?: string;
}

export async function setPolicy(
  organizationId: string,
  input: SetPolicyInput
): Promise<OrgPolicyConfig | null> {
  const policy: OrgPolicyConfig = {
    allowedStrategies: coerceStringArray(input.allowedStrategies),
    allowedModels: coerceStringArray(input.allowedModels),
    blockedModels: coerceStringArray(input.blockedModels),
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };

  const merged = await mergeGovernance(organizationId, { policy });
  if (!merged) return null;
  return merged.policy ?? policy;
}

// ─── Monthly spend ────────────────────────────────────────────────────────────

export function getCurrentBillingPeriod(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Month-to-date spend (UTC) summed from the authoritative `RequestLog` ledger —
 * the same `costUsd` column the billing dashboard aggregates. Returns 0 on any
 * DB hiccup so a transient failure can never wedge the request path closed
 * (fail-open). Decimal is coerced to a JS number.
 */
export async function getCurrentMonthlyCost(
  organizationId: string,
  now: Date = new Date()
): Promise<number> {
  const { start, end } = getCurrentBillingPeriod(now);
  try {
    const agg = await prisma.requestLog.aggregate({
      where: { organizationId, createdAt: { gte: start, lt: end } },
      _sum: { costUsd: true },
    });
    const raw = agg._sum.costUsd;
    if (raw === null || raw === undefined) return 0;
    const num = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(num) ? num : 0;
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error), organizationId },
      'Failed to aggregate monthly cost — treating as 0 (fail-open)'
    );
    return 0;
  }
}

export async function getCostStatus(
  organizationId: string,
  now: Date = new Date()
): Promise<CostStatus | null> {
  const config = await getGovernanceConfig(organizationId);
  if (config === null) return null;

  const { start, end } = getCurrentBillingPeriod(now);
  const currentMonthlyCostUsd = await getCurrentMonthlyCost(organizationId, now);

  const budget = config.budget;
  const cap = budget?.maxMonthlyCostUsd ?? null;
  const remainingUsd = cap !== null ? Math.max(0, cap - currentMonthlyCostUsd) : null;
  const utilization = cap !== null && cap > 0 ? currentMonthlyCostUsd / cap : null;
  const exceeded = cap !== null && currentMonthlyCostUsd >= cap;

  const alerts = (budget?.alertThresholds ?? []).map((threshold) => ({
    threshold,
    breached: cap !== null && cap > 0 ? currentMonthlyCostUsd >= cap * threshold : false,
  }));

  return {
    organizationId,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    currentMonthlyCostUsd,
    maxMonthlyCostUsd: cap,
    remainingUsd,
    utilization,
    budgetConfigured: Boolean(budget),
    exceeded,
    alerts,
  };
}

// ─── Enforcement ──────────────────────────────────────────────────────────────

const ALLOW: GovernanceDecision = { allowed: true };

/**
 * Pure policy check (no DB). Evaluates the requested strategy/model against the
 * org's allow/block lists. Used by `evaluateGovernance` and independently
 * unit-testable.
 */
export function evaluatePolicy(
  policy: OrgPolicyConfig | undefined,
  request: GovernanceRequestShape
): GovernanceDecision {
  if (!policy) return ALLOW;

  const model = typeof request.model === 'string' ? request.model.trim() : '';
  const strategy = typeof request.strategy === 'string' ? request.strategy.trim() : '';

  // Blocklist takes precedence over everything.
  if (model && policy.blockedModels.length && policy.blockedModels.includes(model)) {
    return {
      allowed: false,
      code: 'policy_violation',
      message: `Model "${model}" is blocked by organization policy.`,
      details: { reason: 'model_blocked', model },
    };
  }

  if (model && policy.allowedModels.length && !policy.allowedModels.includes(model)) {
    return {
      allowed: false,
      code: 'policy_violation',
      message: `Model "${model}" is not in the organization's allowed-model list.`,
      details: { reason: 'model_not_allowed', model, allowedModels: policy.allowedModels },
    };
  }

  if (strategy && policy.allowedStrategies.length && !policy.allowedStrategies.includes(strategy)) {
    return {
      allowed: false,
      code: 'policy_violation',
      message: `Strategy "${strategy}" is not in the organization's allowed-strategy list.`,
      details: {
        reason: 'strategy_not_allowed',
        strategy,
        allowedStrategies: policy.allowedStrategies,
      },
    };
  }

  return ALLOW;
}

/**
 * Pure budget check (no DB). Denies once month-to-date spend has reached the cap.
 */
export function evaluateBudget(
  budget: OrgBudgetConfig | undefined,
  currentMonthlyCostUsd: number
): GovernanceDecision {
  if (!budget) return ALLOW;
  if (currentMonthlyCostUsd >= budget.maxMonthlyCostUsd) {
    return {
      allowed: false,
      code: 'organization_budget_exceeded',
      message:
        `Organization monthly budget exceeded: ` +
        `$${currentMonthlyCostUsd.toFixed(4)} spent of $${budget.maxMonthlyCostUsd.toFixed(2)} cap.`,
      details: {
        currentMonthlyCostUsd,
        maxMonthlyCostUsd: budget.maxMonthlyCostUsd,
      },
    };
  }
  return ALLOW;
}

/**
 * Top-level enforcement entrypoint for the request path. Loads governance
 * config, evaluates policy first (cheap, no spend query), then budget (queries
 * MTD spend only when a cap is configured). Fail-OPEN end-to-end: an org with no
 * governance, or any internal error, resolves to `{ allowed: true }`.
 */
export async function evaluateGovernance(
  organizationId: string,
  request: GovernanceRequestShape,
  now: Date = new Date()
): Promise<GovernanceDecision> {
  try {
    const config = await getGovernanceConfig(organizationId);
    if (!config || (!config.budget && !config.policy)) {
      return ALLOW;
    }

    // Policy first — no spend query needed.
    const policyDecision = evaluatePolicy(config.policy, request);
    if (!policyDecision.allowed) return policyDecision;

    // Budget — only query spend when a cap is actually configured.
    if (config.budget) {
      const currentMonthlyCostUsd = await getCurrentMonthlyCost(organizationId, now);
      const budgetDecision = evaluateBudget(config.budget, currentMonthlyCostUsd);
      if (!budgetDecision.allowed) return budgetDecision;
    }

    return ALLOW;
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error), organizationId },
      'Governance evaluation failed — failing open (allow)'
    );
    return ALLOW;
  }
}

// ─── Audit query ──────────────────────────────────────────────────────────────

export interface AuditQueryFilters {
  organizationId: string;
  eventType?: string;
  severity?: string;
  /** ISO date string — inclusive lower bound on createdAt. */
  since?: string;
  /** ISO date string — exclusive upper bound on createdAt. */
  until?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  severity: string;
  message: string;
  userId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AuditQueryResult {
  total: number;
  limit: number;
  offset: number;
  events: AuditEvent[];
}

/**
 * Paginated, filtered query over the persisted `SecurityAuditLog` — the real
 * audit trail that `recordSecurityEvent` (auth, security, AND governance
 * decisions) writes to. ALWAYS scoped to the caller's org (tenant isolation).
 */
export async function queryAuditEvents(filters: AuditQueryFilters): Promise<AuditQueryResult> {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const where: Prisma.SecurityAuditLogWhereInput = {
    organizationId: filters.organizationId,
  };
  if (filters.eventType) where.eventType = filters.eventType;
  if (filters.severity) where.severity = filters.severity;

  const createdAt: Prisma.DateTimeFilter = {};
  if (filters.since) {
    const d = new Date(filters.since);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  if (filters.until) {
    const d = new Date(filters.until);
    if (!Number.isNaN(d.getTime())) createdAt.lt = d;
  }
  if (createdAt.gte || createdAt.lt) where.createdAt = createdAt;

  const [total, rows] = await Promise.all([
    prisma.securityAuditLog.count({ where }),
    prisma.securityAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        eventType: true,
        severity: true,
        message: true,
        userId: true,
        metadata: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    total,
    limit,
    offset,
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      severity: r.severity,
      message: r.message,
      userId: r.userId,
      metadata: r.metadata,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    })),
  };
}
