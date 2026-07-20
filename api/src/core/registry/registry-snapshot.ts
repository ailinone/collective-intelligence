// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Registry build types — input/output contract for `buildRuntimeModelRegistry`.
 *
 * MVP 2 invariant: pure types + diagnostics shape. No I/O dependency.
 */

import type { LegacyModelSnapshot } from './legacy-model-snapshot';
import type { RuntimeModelRegistry } from './runtime-model-registry';
import type { RouteKind } from './types';

// ─── Build input ────────────────────────────────────────────────────────

/**
 * Plain-object input to the registry builder. Provided by fixtures in
 * tests, by a DB-snapshot loader in production (later MVP).
 *
 * `routeKindByProvider` lets fixtures and the future RegistryBuilder
 * caller declare which providers are aggregators/gateways/local
 * WITHOUT the builder having to hardcode classifications. Default
 * route kind is `'native'`.
 */
export interface RegistryBuildInput {
  readonly models: ReadonlyArray<LegacyModelSnapshot>;
  /**
   * Optional override of route classification per providerId. Used by
   * fixtures to declare e.g. `{ aihubmix: 'aggregator', ollama: 'local' }`
   * without the builder containing a hardcoded list. Production caller
   * (later MVP) will derive this from `PROVIDER_CATALOG`.
   */
  readonly routeKindByProvider?: Readonly<Record<string, RouteKind>>;
  /** ISO timestamp used for `firstSeenAt/lastSeenAt/lastNormalizedAt` defaults. */
  readonly now?: string;
  /** Free-form provenance label — surfaces in diagnostics. */
  readonly source?: 'fixture' | 'snapshot' | 'test';
}

// ─── Diagnostics ────────────────────────────────────────────────────────

/**
 * Per-build diagnostics — surfaced to caller, persisted in observability
 * by later MVPs.
 *
 * `skippedReasons` keys are short codes (e.g. `missing_id`,
 * `missing_provider_id`) so callers can alert on specific causes.
 */
export interface RegistryBuildDiagnostics {
  readonly inputModelCount: number;
  readonly canonicalModelCount: number;
  readonly offeringCount: number;
  readonly routeCount: number;
  readonly skippedCount: number;
  readonly skippedReasons: Readonly<Record<string, number>>;
  readonly source: 'fixture' | 'snapshot' | 'test' | 'unknown';
  readonly builtAtIso: string;
}

// ─── Build result ───────────────────────────────────────────────────────

export interface RegistryBuildResult {
  readonly registry: RuntimeModelRegistry;
  readonly diagnostics: RegistryBuildDiagnostics;
}
