// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Per-Tenant Feature Flag (F1.7)
 *
 * Resolves the effective `CoordinationConfig` for a given organization
 * by overlaying tenant-specific overrides from `Organization.settings`
 * on top of the env-driven defaults from
 * `getCoordinationConfigFromEnv()`.
 *
 * Why a separate module:
 *   - The strategy SHOULD NOT know about Prisma. The strategy receives
 *     a pure `CoordinationConfig`; the resolution path is hidden here.
 *   - Per-tenant flag reads happen on the orchestration hot path, so
 *     a small in-memory TTL cache prevents DB churn under load.
 *   - DB failures MUST NOT break orchestration — when the DB read
 *     fails or returns garbage, the env-default config is used and
 *     the failure is logged once per cache window.
 *
 * Schema convention:
 *   `Organization.settings.collectiveConfig` is the JSON object that
 *   stores overrides. Every field is optional; missing fields fall
 *   back to the env-driven default. Operators flip per-tenant flags
 *   by writing to this object via the org-settings admin route.
 *
 * Example settings.collectiveConfig payload:
 *   {
 *     "enabled": true,
 *     "aggregationMethod": "llm_synthesis",
 *     "entropySeedEnabled": true,
 *     "maxRounds": 4
 *   }
 *
 * Cache invalidation:
 *   The cache TTL is 60s. Operators changing per-tenant settings will
 *   see the new effective config propagate within one minute. Tighter
 *   coupling could plug into the orchestration cache invalidation
 *   bus, but the cost/latency math does not justify it for a flag that
 *   gates a feature with a 4× cost multiplier.
 */

import type { Organization } from '@/generated/prisma/index.js';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import {
  type CoordinationConfig,
  type AggregationMethod,
  AGGREGATION_METHODS,
  getCoordinationConfigFromEnv,
} from './coordination-types';

const log = logger.child({ component: 'collective-feature-flags' });

// ─── Cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
  value: CoordinationConfig;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1024;

const cache = new Map<string, CacheEntry>();

/**
 * Evict the oldest entries from ANY Map-shaped TTL cache once it exceeds
 * `maxEntries`. Map's insertion-order iteration gives a cheap
 * approximate-LRU without a dedicated LRU dependency. Generic so the
 * MediaPlanner canary cache (Section E) can reuse this loop instead of
 * duplicating it for a differently-shaped cache value.
 */
export function evictOldestIfOverCap<T>(map: Map<string, T>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const overflow = map.size - maxEntries;
  let evicted = 0;
  for (const key of map.keys()) {
    map.delete(key);
    evicted++;
    if (evicted >= overflow) break;
  }
}

function evictIfNeeded(): void {
  evictOldestIfOverCap(cache, CACHE_MAX_ENTRIES);
}

/**
 * Force-clear the cache. Exported so admin tooling (and tests) can
 * invalidate after a settings update without waiting for the TTL.
 */
export function clearCollectiveConfigCache(): void {
  cache.clear();
}

// ─── Override schema ────────────────────────────────────────────────────

/**
 * Per-tenant overrides. Every field is optional and validated at
 * extraction time; values that violate the contract are silently
 * dropped (with a warn log) so a corrupt settings blob cannot crash
 * the strategy.
 */
export interface OrganizationCollectiveSettings {
  enabled?: boolean;
  maxRounds?: number;
  minConvergenceScore?: number;
  maxDecisionFlipRate?: number;
  maxDissent?: number;
  maxCostUsd?: number;
  maxLatencyMs?: number;
  stopOnCriticalRisk?: boolean;
  minModelsPerRound?: number;
  maxModelsPerRound?: number;
  requireQualityTarget?: number;
  aggregationMethod?: AggregationMethod;
  persistAuditTrail?: boolean;
  enableForExperiments?: boolean;
  entropySeedEnabled?: boolean;
  perAgentStateEnabled?: boolean;
  topologyKind?: CoordinationConfig['topologyKind'];
}

const AGGREGATION_METHOD_SET = new Set<string>(AGGREGATION_METHODS);
const TOPOLOGY_KINDS = new Set<string>(['fully_connected', 'ring', 'small_world', 'sparse_random']);

// ─── Validation helpers ─────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInRange01(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isPositiveInt(value: unknown, max?: number): value is number {
  if (!isFiniteNumber(value)) return false;
  if (!Number.isInteger(value)) return false;
  if (value < 1) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function isAggregationMethod(value: unknown): value is AggregationMethod {
  return typeof value === 'string' && AGGREGATION_METHOD_SET.has(value);
}

/**
 * Extract a strict-typed `OrganizationCollectiveSettings` from an
 * arbitrary JSON value. Unknown / invalid fields are dropped silently
 * with a warning log so a corrupt settings blob cannot poison the
 * effective config.
 */
export function parseOrganizationCollectiveSettings(raw: unknown): OrganizationCollectiveSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: OrganizationCollectiveSettings = {};

  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.stopOnCriticalRisk === 'boolean') out.stopOnCriticalRisk = obj.stopOnCriticalRisk;
  if (typeof obj.persistAuditTrail === 'boolean') out.persistAuditTrail = obj.persistAuditTrail;
  if (typeof obj.enableForExperiments === 'boolean')
    out.enableForExperiments = obj.enableForExperiments;
  if (typeof obj.entropySeedEnabled === 'boolean') out.entropySeedEnabled = obj.entropySeedEnabled;
  if (typeof obj.perAgentStateEnabled === 'boolean')
    out.perAgentStateEnabled = obj.perAgentStateEnabled;

  if (typeof obj.topologyKind === 'string' && TOPOLOGY_KINDS.has(obj.topologyKind)) {
    out.topologyKind = obj.topologyKind as CoordinationConfig['topologyKind'];
  }

  if (isPositiveInt(obj.maxRounds, 5)) out.maxRounds = obj.maxRounds;
  if (isPositiveInt(obj.minModelsPerRound, 7)) out.minModelsPerRound = obj.minModelsPerRound;
  if (isPositiveInt(obj.maxModelsPerRound, 7)) out.maxModelsPerRound = obj.maxModelsPerRound;
  if (isPositiveInt(obj.maxLatencyMs)) out.maxLatencyMs = obj.maxLatencyMs;

  if (isInRange01(obj.minConvergenceScore)) out.minConvergenceScore = obj.minConvergenceScore;
  if (isInRange01(obj.maxDecisionFlipRate)) out.maxDecisionFlipRate = obj.maxDecisionFlipRate;
  if (isInRange01(obj.maxDissent)) out.maxDissent = obj.maxDissent;
  if (isInRange01(obj.requireQualityTarget)) out.requireQualityTarget = obj.requireQualityTarget;

  // maxCostUsd is finite-positive but not bounded to [0,1] — costs
  // can legitimately exceed $1.
  if (isFiniteNumber(obj.maxCostUsd) && obj.maxCostUsd > 0) out.maxCostUsd = obj.maxCostUsd;

  if (isAggregationMethod(obj.aggregationMethod)) out.aggregationMethod = obj.aggregationMethod;

  return out;
}

// ─── Merge logic ────────────────────────────────────────────────────────

/**
 * Merge tenant overrides on top of an env-default config. Tenant
 * fields take precedence when present; missing fields fall back to
 * the env baseline.
 *
 * Pure function — exported for testability.
 */
export function mergeOrgSettingsIntoConfig(
  envDefault: CoordinationConfig,
  override: OrganizationCollectiveSettings
): CoordinationConfig {
  return {
    enabled: override.enabled ?? envDefault.enabled,
    maxRounds: override.maxRounds ?? envDefault.maxRounds,
    minConvergenceScore: override.minConvergenceScore ?? envDefault.minConvergenceScore,
    maxDecisionFlipRate: override.maxDecisionFlipRate ?? envDefault.maxDecisionFlipRate,
    maxDissent: override.maxDissent ?? envDefault.maxDissent,
    maxCostUsd: override.maxCostUsd ?? envDefault.maxCostUsd,
    maxLatencyMs: override.maxLatencyMs ?? envDefault.maxLatencyMs,
    stopOnCriticalRisk: override.stopOnCriticalRisk ?? envDefault.stopOnCriticalRisk,
    minModelsPerRound: override.minModelsPerRound ?? envDefault.minModelsPerRound,
    maxModelsPerRound: override.maxModelsPerRound ?? envDefault.maxModelsPerRound,
    requireQualityTarget: override.requireQualityTarget ?? envDefault.requireQualityTarget,
    aggregationMethod: override.aggregationMethod ?? envDefault.aggregationMethod,
    persistAuditTrail: override.persistAuditTrail ?? envDefault.persistAuditTrail,
    enableForExperiments: override.enableForExperiments ?? envDefault.enableForExperiments,
    entropySeedEnabled: override.entropySeedEnabled ?? envDefault.entropySeedEnabled,
    perAgentStateEnabled: override.perAgentStateEnabled ?? envDefault.perAgentStateEnabled,
    topologyKind: override.topologyKind ?? envDefault.topologyKind,
  };
}

// ─── DB helpers ─────────────────────────────────────────────────────────

/**
 * Read `Organization.settings.collectiveConfig` and parse it into the
 * strict-typed override shape. Returns `{}` when the org has no
 * overrides, when the row does not exist, or when the DB read fails.
 */
async function readOrgCollectiveSettings(
  organizationId: string
): Promise<OrganizationCollectiveSettings> {
  try {
    const org: Pick<Organization, 'settings'> | null = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    if (!org) return {};

    const settings = org.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};

    const raw = (settings as Record<string, unknown>).collectiveConfig;
    return parseOrganizationCollectiveSettings(raw);
  } catch (err) {
    log.warn(
      {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      },
      'readOrgCollectiveSettings failed — falling back to env-default config'
    );
    return {};
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Resolve the effective `CoordinationConfig` for a given organization.
 *
 * Process:
 *   1. Read env-default config via `getCoordinationConfigFromEnv()`.
 *   2. Look up tenant overrides via `Organization.settings.collectiveConfig`
 *      (cached for 60s).
 *   3. Merge — overrides take precedence; missing fields fall back.
 *
 * NEVER throws; falls back to env-default on any DB error.
 */
export async function getCollectiveConfigForOrg(
  organizationId: string
): Promise<CoordinationConfig> {
  const envDefault = getCoordinationConfigFromEnv();
  if (!organizationId) return envDefault;

  const cached = cache.get(organizationId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const overrides = await readOrgCollectiveSettings(organizationId);
  const merged = mergeOrgSettingsIntoConfig(envDefault, overrides);

  cache.set(organizationId, {
    value: merged,
    expiresAt: now + CACHE_TTL_MS,
  });
  evictIfNeeded();

  return merged;
}

// ─── MediaPlanner canary (Section E: chat/triage pipeline integration) ────

/**
 * Per-tenant MediaPlanner canary allowlist. Lives in a SIBLING top-level
 * key of `Organization.settings` — `settings.mediaPlannerConfig` — and is
 * deliberately NOT merged into `CoordinationConfig`/`settings.collectiveConfig`
 * above: `CoordinationConfig` is specifically the collective-coordination
 * (multi-model consensus) feature's config; MediaPlanner is an unrelated
 * feature that only wants the same tenant-override plumbing (TTL cache,
 * DB-failure-safe fallback, `Organization.settings` JSON storage). See the
 * 2026-09-23 MediaPlanner completion design spec, section E, for the full
 * rationale, and `resolveEffectiveMediaPlannerEnabled` in
 * `media-planner-gate.ts` for where this is combined with the global
 * `MEDIA_PLANNER_ENABLED` env flag.
 *
 * Example settings.mediaPlannerConfig payload: `{ "enabled": true }`
 */
export interface OrgMediaPlannerSettings {
  enabled?: boolean;
}

interface MediaPlannerCacheEntry {
  value: boolean;
  expiresAt: number;
}

const MEDIA_PLANNER_CACHE_MAX_ENTRIES = 1024;
const mediaPlannerCache = new Map<string, MediaPlannerCacheEntry>();

/** Force-clear the MediaPlanner canary cache. Exported for admin tooling and tests. */
export function clearMediaPlannerConfigCache(): void {
  mediaPlannerCache.clear();
}

/**
 * Extract `{ enabled }` from an arbitrary JSON value. Anything else is
 * dropped silently — same tolerant-parsing posture as
 * `parseOrganizationCollectiveSettings` — so a corrupt settings blob can
 * never crash the orchestration hot path.
 */
export function parseOrgMediaPlannerSettings(raw: unknown): OrgMediaPlannerSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: OrgMediaPlannerSettings = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  return out;
}

/**
 * Read `Organization.settings.mediaPlannerConfig` and parse it. Returns
 * `{}` when the org has no override, doesn't exist, or the DB read fails —
 * NEVER throws (mirrors `readOrgCollectiveSettings`'s fail-safe posture).
 */
async function readOrgMediaPlannerSettings(
  organizationId: string
): Promise<OrgMediaPlannerSettings> {
  try {
    const org: Pick<Organization, 'settings'> | null = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    if (!org) return {};

    const settings = org.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};

    const raw = (settings as Record<string, unknown>).mediaPlannerConfig;
    return parseOrgMediaPlannerSettings(raw);
  } catch (err) {
    log.warn(
      {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      },
      'readOrgMediaPlannerSettings failed — falling back to disabled'
    );
    return {};
  }
}

/**
 * Resolve the MediaPlanner canary allowlist entry for one organization.
 * `enabled` defaults to `false` when unset, unparseable, or on DB failure —
 * the safe default for a feature that stays off everywhere until an org is
 * explicitly named (see the design spec's "Production rollout" steps).
 * Cached for 60s using the same TTL as `getCollectiveConfigForOrg`.
 *
 * NEVER throws; falls back to `{ enabled: false }` on any DB error.
 */
export async function getMediaPlannerConfigForOrg(
  organizationId: string
): Promise<{ enabled: boolean }> {
  if (!organizationId) return { enabled: false };

  const cached = mediaPlannerCache.get(organizationId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { enabled: cached.value };
  }

  const overrides = await readOrgMediaPlannerSettings(organizationId);
  const enabled = overrides.enabled === true;

  mediaPlannerCache.set(organizationId, { value: enabled, expiresAt: now + CACHE_TTL_MS });
  evictOldestIfOverCap(mediaPlannerCache, MEDIA_PLANNER_CACHE_MAX_ENTRIES);

  return { enabled };
}
