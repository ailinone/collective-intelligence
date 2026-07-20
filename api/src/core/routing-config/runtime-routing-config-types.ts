// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * runtime-routing-config-types.ts — MVP 7A
 *
 * Pure types for the RuntimeRoutingConfigProvider. No I/O. No runtime
 * imports. Re-exports `RoutingMode` from MVP 1 (registry/types) so the
 * trace and the config share a single source of truth.
 *
 * MVP 7A invariant: `shadow_semantic_full` and `semantic_primary` are
 * BLOCKED while the C3 experiment runs and the semantic index is
 * unavailable.
 */

import type { RoutingMode } from '../registry/types';

export type { RoutingMode };

// ─── Config shape ───────────────────────────────────────────────────────

/**
 * Provenance of a config. Distinguishes a hand-coded static stub from
 * one assembled by a test fixture so logs / traces can disambiguate.
 */
export type RoutingConfigSource = 'static_stub' | 'test_fixture';

/**
 * Immutable config record returned by the provider.
 *
 * `enabled = false` means the provider exists but no routing-mode work
 * should be performed downstream. Default is `enabled = true` with
 * `mode = 'legacy'` so the engine remains dormant.
 *
 * `reason` is set when the configured mode is BLOCKED (e.g. semantic
 * modes during C3). Callers should respect blocked modes by skipping
 * the pipeline run.
 */
export interface RuntimeRoutingConfig {
  readonly mode: RoutingMode;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly updatedAt?: string;
  readonly source: RoutingConfigSource;
}

// ─── Provider contract ──────────────────────────────────────────────────

export interface ModeExplanation {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Provider contract — read-only, deterministic, no I/O.
 *
 * The MVP 7A implementation is a pure in-memory stub. Future MVPs
 * may add hot-reload, Redis subscription, or admin-routes coupling,
 * but the contract surface stays narrow.
 */
export interface RuntimeRoutingConfigProvider {
  /** Returns the full config. The returned object is frozen. */
  getConfig(): RuntimeRoutingConfig;

  /** Convenience accessor — same value as `getConfig().mode`. */
  getMode(): RoutingMode;

  /**
   * Returns true when the mode is permitted in this MVP. BLOCKED modes
   * (semantic_*) return false until the C3 experiment ends and the
   * semantic index is wired.
   */
  isModeAllowed(mode: RoutingMode): boolean;

  /**
   * Returns a structured explanation of whether the mode is allowed
   * and why. Used by admin endpoints (future MVP) and by the composer
   * to surface the blocked reason in the result.
   */
  explainMode(mode: RoutingMode): ModeExplanation;
}

// ─── Mode allowlist + block reason (data, not logic) ────────────────────

/**
 * The set of modes the MVP 7A stub permits. Anything outside this set
 * is rejected with `BLOCKED_REASON`.
 */
export const ALLOWED_MODES: ReadonlySet<RoutingMode> = new Set<RoutingMode>([
  'legacy',
  'registry_cache',
  'shadow_trace_only',
  'shadow_registry_only',
  'shadow_structural_full',
]);

/**
 * The set of modes BLOCKED in MVP 7A. Kept explicit for documentation
 * AND for the lint test that asserts both lists are mutually exclusive.
 */
export const BLOCKED_MODES: ReadonlySet<RoutingMode> = new Set<RoutingMode>([
  'shadow_semantic_full',
  'semantic_primary',
]);

export const BLOCKED_REASON =
  'blocked_until_c3_completed_and_semantic_index_available';

export const ALLOWED_REASON = 'mode_allowed';
