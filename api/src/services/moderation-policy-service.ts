// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Moderation Policy Service (F3/F1 §P6)
 *
 * Per-tenant custom content-moderation policies. A policy layers org-specific
 * category thresholds (and optional org-defined custom categories) on top of the
 * base OpenAI-style /v1/moderations result. The base classifier is untouched —
 * a policy only RE-evaluates and annotates the result a request already got.
 *
 * Two concerns live here:
 *
 *   1. Persistence (CRUD) — `ModerationPolicy` rows scoped to an organization.
 *      Every read/write is org-scoped: a caller can never see or mutate another
 *      tenant's policy (cross-tenant get/delete resolves to not-found).
 *
 *   2. Application (pure) — `applyPolicy` takes a base moderation result + a
 *      loaded policy and returns the layered result. No DB, no I/O — trivially
 *      unit-testable and deterministic.
 *
 * Apply semantics:
 *   - For each base category, if the policy declares a threshold for it and the
 *     base `category_score` ≥ threshold, that category is forced `true` (re-flag)
 *     even if the base provider left it `false`.
 *   - Custom categories (declared in `customCategories`) are matched against the
 *     input text via case-insensitive keyword/substring; a match sets the
 *     category score to 1 and flags it. They surface under `category_scores` /
 *     `categories` with their org-defined key so callers see a unified taxonomy.
 *   - A result is `flagged` if the base flag OR any policy-driven re-flag trips.
 *   - `action`: 'flag' annotates only; 'block' additionally sets `blocked=true`
 *     on flagged results so the caller knows it MUST reject the content.
 *   - `enabled=false` → apply is a pass-through no-op (base result unchanged).
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';

const log = logger.child({ service: 'moderation-policy' });

// ─── Config shapes ──────────────────────────────────────────────────────────

export type ModerationAction = 'flag' | 'block';

/** Map of category key → threshold in [0,1]. Base score ≥ threshold re-flags. */
export type ModerationThresholds = Record<string, number>;

/**
 * Org-defined category not present in the base provider taxonomy. Matched at
 * apply time against the input text via case-insensitive keyword substring.
 */
export interface CustomCategory {
  /** Category key surfaced in the result (e.g. "company_secrets"). */
  name: string;
  /** Keywords that, if present in the text, trip this category. */
  keywords: string[];
  /** Optional human description (informational only). */
  description?: string;
}

export interface ModerationPolicyRecord {
  id: string;
  organizationId: string;
  name: string;
  thresholds: ModerationThresholds;
  customCategories: CustomCategory[];
  action: ModerationAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Base / layered result shapes ──────────────────────────────────────────────
//
// Mirrors the orchestration-service result item but with open-ended record types
// so custom categories can be merged in without fighting the closed base union.

export interface BaseModerationItem {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
}

export interface LayeredModerationItem extends BaseModerationItem {
  /**
   * Present only when a policy with action='block' flagged the item. Signals the
   * caller MUST reject the content. Absent (undefined) for action='flag'.
   */
  blocked?: boolean;
  /**
   * Diagnostics: which policy-driven category keys tripped (base re-flags +
   * custom matches). Empty array when the policy changed nothing.
   */
  policy_triggered?: string[];
}

// ─── (De)serialization ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerce a raw JSON blob into a clean thresholds map (drop non-finite / out-of-range). */
export function parseThresholds(value: unknown): ModerationThresholds {
  const root = asRecord(value);
  const out: ModerationThresholds = {};
  for (const [key, raw] of Object.entries(root)) {
    if (!key) continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n)) {
      // Clamp into [0,1] — thresholds are score fractions.
      out[key] = Math.min(1, Math.max(0, n));
    }
  }
  return out;
}

/** Coerce a raw JSON blob into a clean custom-category list (drop malformed entries). */
export function parseCustomCategories(value: unknown): CustomCategory[] {
  if (!Array.isArray(value)) return [];
  const out: CustomCategory[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const keywords = Array.isArray(rec.keywords)
      ? rec.keywords
          .filter((k): k is string => typeof k === 'string')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      : [];
    out.push({
      name,
      keywords,
      description: typeof rec.description === 'string' ? rec.description : undefined,
    });
  }
  return out;
}

function normalizeAction(value: unknown): ModerationAction {
  return value === 'block' ? 'block' : 'flag';
}

interface ModerationPolicyRow {
  id: string;
  organizationId: string;
  name: string;
  thresholds: unknown;
  customCategories: unknown;
  action: string;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Map a raw Prisma row into the clean, validated service record shape. */
export function toPolicyRecord(row: ModerationPolicyRow): ModerationPolicyRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    thresholds: parseThresholds(row.thresholds),
    customCategories: parseCustomCategories(row.customCategories),
    action: normalizeAction(row.action),
    enabled: Boolean(row.enabled),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

// ─── CRUD (tenant-scoped) ──────────────────────────────────────────────────────

export interface CreatePolicyInput {
  name: string;
  thresholds?: ModerationThresholds;
  customCategories?: CustomCategory[];
  action?: ModerationAction;
  enabled?: boolean;
}

export type CreatePolicyResult =
  | { ok: true; policy: ModerationPolicyRecord }
  | { ok: false; code: 'invalid_request' | 'name_conflict' | 'organization_not_found'; message: string };

/**
 * Create a policy for an org. Name must be unique per-org (409 name_conflict).
 * The org must exist (the FK is also enforced at the DB level).
 */
export async function createPolicy(
  organizationId: string,
  input: CreatePolicyInput
): Promise<CreatePolicyResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    return { ok: false, code: 'invalid_request', message: 'name is required.' };
  }

  const thresholds = parseThresholds(input.thresholds);
  const customCategories = parseCustomCategories(input.customCategories);
  const action = normalizeAction(input.action);
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);

  try {
    const row = await prisma.moderationPolicy.create({
      data: {
        organizationId,
        name,
        thresholds: thresholds as Prisma.InputJsonValue,
        customCategories: narrowAs<Prisma.InputJsonValue>(customCategories),
        action,
        enabled,
      },
    });
    return { ok: true, policy: toPolicyRecord(row as ModerationPolicyRow) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 = unique constraint (organization_id, name).
      if (error.code === 'P2002') {
        return {
          ok: false,
          code: 'name_conflict',
          message: `A moderation policy named "${name}" already exists for this organization.`,
        };
      }
      // P2003 = FK violation (org does not exist).
      if (error.code === 'P2003') {
        return { ok: false, code: 'organization_not_found', message: 'Organization not found.' };
      }
    }
    log.error(
      { error: error instanceof Error ? error.message : String(error), organizationId },
      'Failed to create moderation policy'
    );
    throw error;
  }
}

/** List all policies for an org, newest-first. ALWAYS org-scoped. */
export async function listPolicies(organizationId: string): Promise<ModerationPolicyRecord[]> {
  const rows = await prisma.moderationPolicy.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => toPolicyRecord(r as ModerationPolicyRow));
}

/**
 * Get one policy by id, scoped to the org. Returns `null` when the policy does
 * not exist OR belongs to another tenant (the org filter is part of the query,
 * so a cross-tenant id is indistinguishable from a missing one → 404).
 */
export async function getPolicy(
  organizationId: string,
  policyId: string
): Promise<ModerationPolicyRecord | null> {
  const row = await prisma.moderationPolicy.findFirst({
    where: { id: policyId, organizationId },
  });
  return row ? toPolicyRecord(row as ModerationPolicyRow) : null;
}

/**
 * Delete a policy by id, scoped to the org. Returns `true` if a row was deleted,
 * `false` if nothing matched (missing OR cross-tenant). Uses deleteMany so a
 * cross-tenant id can never delete another org's row (count=0).
 */
export async function deletePolicy(organizationId: string, policyId: string): Promise<boolean> {
  const result = await prisma.moderationPolicy.deleteMany({
    where: { id: policyId, organizationId },
  });
  return result.count > 0;
}

// ─── Application (pure) ──────────────────────────────────────────────────────

/**
 * Apply a policy to a single base moderation item against its source text.
 *
 * Pure + deterministic — no DB, no I/O. Returns a NEW item (does not mutate the
 * input). When the policy is disabled, returns the base item unchanged (only
 * widening the type to the layered shape).
 */
export function applyPolicyToItem(
  policy: ModerationPolicyRecord,
  base: BaseModerationItem,
  inputText: string
): LayeredModerationItem {
  if (!policy.enabled) {
    return { ...base, categories: { ...base.categories }, category_scores: { ...base.category_scores } };
  }

  const categories: Record<string, boolean> = { ...base.categories };
  const categoryScores: Record<string, number> = { ...base.category_scores };
  const triggered: string[] = [];

  // 1) Threshold re-flag over base categories.
  for (const [category, threshold] of Object.entries(policy.thresholds)) {
    const score = categoryScores[category];
    if (typeof score === 'number' && score >= threshold) {
      if (!categories[category]) triggered.push(category);
      categories[category] = true;
    }
  }

  // 2) Custom categories — keyword substring match (case-insensitive).
  const haystack = (inputText || '').toLowerCase();
  for (const custom of policy.customCategories) {
    const matched = custom.keywords.some((kw) => kw && haystack.includes(kw.toLowerCase()));
    // Surface every custom category in the taxonomy; score 1 on match else 0.
    categoryScores[custom.name] = matched ? 1 : categoryScores[custom.name] ?? 0;
    if (matched) {
      if (!categories[custom.name]) triggered.push(custom.name);
      categories[custom.name] = true;
    } else if (categories[custom.name] === undefined) {
      categories[custom.name] = false;
    }
  }

  const flagged = base.flagged || triggered.length > 0;

  const layered: LayeredModerationItem = {
    flagged,
    categories,
    category_scores: categoryScores,
    policy_triggered: triggered,
  };

  // action=block: when flagged, signal the caller MUST reject.
  if (policy.action === 'block') {
    layered.blocked = flagged;
  }

  return layered;
}

/**
 * Apply a policy across a batch of base items (parallel arrays with the source
 * inputs). `inputs` and `baseResults` MUST be the same length / order.
 */
export function applyPolicy(
  policy: ModerationPolicyRecord,
  baseResults: BaseModerationItem[],
  inputs: string[]
): LayeredModerationItem[] {
  return baseResults.map((item, i) => applyPolicyToItem(policy, item, inputs[i] ?? ''));
}
