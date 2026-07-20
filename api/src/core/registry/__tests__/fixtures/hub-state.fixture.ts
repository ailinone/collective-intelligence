// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hub state fixture (skeleton for MVP 2).
 *
 * The registry_cache equivalence tests do not need hub state — the
 * registry does NOT consult operability in this MVP. This fixture
 * exists so later MVPs (RouteHealthView, ModelScorer) can layer
 * health/quota data on top of the same canonical/offering/route
 * structure tested here.
 *
 * Shape mirrors the ProviderOperabilityHub `RouteOperabilityRecord`
 * minimal needed fields, declared LOCALLY so the registry tests
 * remain independent of the hub singleton.
 */

import type { OperabilityState, CreditStatus } from '../../types';

export interface FakeRouteHealth {
  readonly routeKey: string;
  readonly operabilityState: OperabilityState;
  readonly creditStatus: CreditStatus;
  readonly recentSuccessRate: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

/**
 * Pre-seeded health for tests that need it. Empty in MVP 2 — the
 * registry_cache tests work entirely off legacy snapshots without
 * touching this. Later MVPs populate.
 */
export const HUB_STATE_FIXTURE: ReadonlyArray<FakeRouteHealth> = Object.freeze([]);
