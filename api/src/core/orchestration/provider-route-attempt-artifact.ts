// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-I — Shared Provider Route Attempt Artifact.
 *
 * BEFORE this file: `ProviderRouteAttemptArtifact` was declared INLINE in
 * `consensus-plan-dry-run-service.ts` (since 01C.1B-F2), and the H-stage
 * `ProviderRouteAttempt` type in `route-cascade-executor.ts` independently
 * re-declared the same conceptual record with extra runtime fields.
 *
 * AFTER (01C.1B-I §6 reuse audit decision `extend_existing`):
 *
 *   - `ProviderRouteAttemptArtifact` lives here as the SHARED minimal
 *     surface (the 11-field shape the dry-run service emits).
 *   - `ProviderRouteAttempt` (in `route-cascade-executor.ts`) extends
 *     this with runtime-only fields (`logicalModelId`, `routerId`,
 *     `upstreamProviderId`, `apiModelId`, `completedAt`, `latencyMs`,
 *     `httpStatus`, `errorKind`, `retryable`, `costUsd`).
 *   - The dry-run service imports this type instead of re-declaring it.
 *
 * Why a separate file: this is the contract surface BOTH the planner
 * dry-run AND the runtime executor produce. Co-locating it with either
 * one creates a circular import OR forces the other to depend on the
 * full module. A leaf shared type module keeps the dependency direction
 * clean.
 */

export type ProviderRouteAttemptRole = 'participant' | 'synthesizer' | 'judge' | 'fallback';

/**
 * Minimal artifact shape the planner emits for dry-run + parity. Runtime
 * executor (RouteCascadeExecutor) produces a superset (`ProviderRouteAttempt`)
 * that includes timing, error kind, cost, and route provenance.
 */
export interface ProviderRouteAttemptArtifact {
  readonly role: ProviderRouteAttemptRole;
  readonly providerId: string;
  readonly routeId: string;
  readonly modelId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly wasRetried: boolean;
  readonly wasRouteFallback: boolean;
  readonly wasModelFallback: boolean;
}
