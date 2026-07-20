// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * dry-run.fixture.ts — minimal registry fixture for handler tests.
 *
 * Reuses the larger legacy-models fixture from MVP 2 but exposes a
 * lighter wrapper so the dry-run/explain tests stay readable.
 */

import { buildRuntimeModelRegistry } from '../../../registry/registry-builder';
import type { RuntimeModelRegistry } from '../../../registry/runtime-model-registry';
import {
  LEGACY_MODELS_FIXTURE,
  FIXTURE_ROUTE_KIND_BY_PROVIDER,
} from '../../../registry/__tests__/fixtures/legacy-models.fixture';

/** Builds a fresh registry from the MVP 2 fixture — no I/O. */
export function buildFixtureRegistry(): RuntimeModelRegistry {
  return buildRuntimeModelRegistry({
    models: LEGACY_MODELS_FIXTURE,
    routeKindByProvider: FIXTURE_ROUTE_KIND_BY_PROVIDER,
    source: 'fixture',
    now: '2026-05-12T12:00:00.000Z',
  }).registry;
}

/** Deterministic `now` provider for handler tests. */
export const FIXTURE_NOW = (): string => '2026-05-12T12:00:00.000Z';

/** Deterministic traceId provider for handler tests. */
let _seq = 0;
export const FIXTURE_TRACE_ID_PROVIDER = (): string => {
  _seq += 1;
  return `trace-fixture-${_seq.toString().padStart(4, '0')}`;
};

export function resetFixtureTraceSeq(): void {
  _seq = 0;
}
