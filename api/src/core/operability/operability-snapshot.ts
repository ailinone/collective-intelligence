// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operability Snapshot — serializable, versionable, auditable
 *
 * Captures the state of all provider/route operability at a point in time.
 * Used by CreditGovernor, PoolBuilder, PreDispatchValidator, and experiment analytics.
 *
 * Key design: route-level granularity. A "route" is:
 *   - For native providers: just the provider key (e.g., "openai")
 *   - For hubs/aggregators: "hub:modelFamily" (e.g., "aihubmix:openai", "cometapi:anthropic")
 *
 * This ensures that aihubmix failing on openai models does NOT affect:
 *   1. Native openai (different route key)
 *   2. aihubmix serving anthropic models (different route key)
 */

import type { OperabilityState, ProviderOperabilityRecord } from '../provider-operability-hub';

// ─── Types ──────────────────────────────────────────────────────────────

export type ProviderKind = 'native' | 'hub' | 'aggregator' | 'router' | 'self_hosted';

export interface RouteOperabilityRecord extends ProviderOperabilityRecord {
  /** Composite route key: "openai" for native, "aihubmix:openai" for hub routes */
  routeKey: string;
  /** The execution provider (adapter name) */
  executionProvider: string;
  /** The model family being served (for hubs: "openai", "anthropic", etc.) */
  modelFamily: string | null;
  /** Classification of the provider */
  providerKind: ProviderKind;
  /** Parent hub name (null for native/self-hosted) */
  parentHub: string | null;
}

export interface OperabilitySnapshot {
  /** Monotonically increasing version for cache invalidation */
  version: number;
  /** ISO timestamp */
  createdAt: string;
  /** All route records, keyed by routeKey */
  routes: Record<string, RouteOperabilityRecord>;
  /** Summary counts by state */
  summary: Record<OperabilityState, number>;
  /** Count of external (non-self-hosted) routes in each state */
  externalSummary: Record<OperabilityState, number>;
  /** Total external routes eligible for execution */
  externalEligibleCount: number;
  /** Whether ALL external routes are exhausted (structural failure) */
  allExternalExhausted: boolean;
}

// ─── Route Key Builders ─────────────────────────────────────────────────

/**
 * Build a composite route key.
 *
 * Native providers: "openai" → "openai"
 * Hub routes: ("aihubmix", "openai") → "aihubmix:openai"
 * Hub without family: ("aihubmix", null) → "aihubmix"
 */
export function buildRouteKey(executionProvider: string, modelFamily: string | null): string {
  const ep = executionProvider.toLowerCase();
  if (!modelFamily) return ep;
  const mf = modelFamily.toLowerCase();
  if (ep === mf) return ep; // native provider serving own models
  return `${ep}:${mf}`;
}

/**
 * Parse a route key back into its components.
 */
export function parseRouteKey(routeKey: string): { executionProvider: string; modelFamily: string | null } {
  const parts = routeKey.split(':');
  if (parts.length === 1) {
    return { executionProvider: parts[0], modelFamily: null };
  }
  return { executionProvider: parts[0], modelFamily: parts[1] };
}

/**
 * Extract the model family from a model ID.
 * Examples:
 *   "openai/gpt-4o" → "openai"
 *   "anthropic/claude-3.5-sonnet" → "anthropic"
 *   "gpt-4o" → null (no family prefix)
 *   "meta-llama/llama-3.1-70b" → "meta"
 */
export function extractModelFamily(modelId: string): string | null {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx <= 0) return null;
  const prefix = modelId.substring(0, slashIdx).toLowerCase();
  // Normalize common prefixes
  const FAMILY_ALIASES: Record<string, string> = {
    'meta-llama': 'meta',
    'mistralai': 'mistral',
    'cohere': 'cohere',
    'qwen': 'qwen',
    'google': 'google',
    'deepseek-ai': 'deepseek',
    'microsoft': 'microsoft',
    'nvidia': 'nvidia',
  };
  return FAMILY_ALIASES[prefix] ?? prefix;
}

// ─── Snapshot Serialization ─────────────────────────────────────────────

const SNAPSHOT_VERSION = 1;

export function serializeSnapshot(snapshot: OperabilitySnapshot): string {
  return JSON.stringify(snapshot);
}

export function deserializeSnapshot(json: string): OperabilitySnapshot | null {
  try {
    // Narrow to a structural shape we can validate before claiming it's
    // a full OperabilitySnapshot. This keeps the type-system honest about
    // the upstream JSON.parse returning `unknown`.
    const parsed: unknown = JSON.parse(json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('routes' in parsed)
    ) {
      return null;
    }
    return parsed as OperabilitySnapshot;
  } catch {
    return null;
  }
}

/**
 * Create an empty snapshot (used at startup before any events).
 */
export function createEmptySnapshot(): OperabilitySnapshot {
  const emptyStates: Record<OperabilityState, number> = {
    healthy: 0, degraded: 0, recovering: 0, no_credits: 0,
    rate_limited: 0, auth_failed: 0, temporarily_unavailable: 0, dead: 0, unknown: 0,
  };
  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    routes: {},
    summary: { ...emptyStates },
    externalSummary: { ...emptyStates },
    externalEligibleCount: 0,
    allExternalExhausted: true, // no routes = all exhausted
  };
}

// ─── Snapshot Analysis Helpers ──────────────────────────────────────────

/** Check if a route is usable for execution (healthy, recovering, degraded, or unknown) */
export function isRouteUsable(record: RouteOperabilityRecord): boolean {
  const s = record.operabilityState;
  return s === 'healthy' || s === 'recovering' || s === 'degraded' || s === 'unknown';
}

/** Check if a route is an external (non-self-hosted) provider */
export function isExternalRoute(record: RouteOperabilityRecord): boolean {
  return record.providerKind !== 'self_hosted';
}

/** Get all usable external routes from a snapshot */
export function getUsableExternalRoutes(snapshot: OperabilitySnapshot): RouteOperabilityRecord[] {
  return Object.values(snapshot.routes).filter(r => isExternalRoute(r) && isRouteUsable(r));
}

/** Get all routes for a specific execution provider */
export function getRoutesForProvider(snapshot: OperabilitySnapshot, executionProvider: string): RouteOperabilityRecord[] {
  const ep = executionProvider.toLowerCase();
  return Object.values(snapshot.routes).filter(r => r.executionProvider === ep);
}

/** Get all routes serving a specific model family */
export function getRoutesForModelFamily(snapshot: OperabilitySnapshot, modelFamily: string): RouteOperabilityRecord[] {
  const mf = modelFamily.toLowerCase();
  return Object.values(snapshot.routes).filter(r => r.modelFamily === mf || r.executionProvider === mf);
}
