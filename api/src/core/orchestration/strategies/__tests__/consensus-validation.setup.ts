// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Setup file for the isolated consensus-validation vitest config.
 *
 * Globally mocks the response aggregator and ensemble-coordinator shadow
 * modules so consensus-strategy unit tests never touch real synthesis
 * paths or external HTTP. Tests adjust synthesis output via
 * setAggregatorOverride() from the fixtures module.
 *
 * The mock implementations live in `consensus-module-mocks.ts` so test
 * files that also run outside this config can register the exact same
 * factories file-locally (see that module's header).
 */
import { vi, beforeEach } from 'vitest';
import { defaultAggOverride } from './consensus-module-mocks';

globalThis.__consensusAggOverride = defaultAggOverride();

vi.mock('@/core/aggregation/response-aggregator', async () =>
  (await import('./consensus-module-mocks')).responseAggregatorModuleMock());

vi.mock('@/core/coordination/ensemble-coordinator-shadow', async () =>
  (await import('./consensus-module-mocks')).ensembleShadowModuleMock());

vi.mock('@/core/coordination/ensemble-coordinator-client', async () =>
  (await import('./consensus-module-mocks')).ensembleClientModuleMock());

// Reset to the default healthy synthesis between each test so one test's
// override does not leak into another.
beforeEach(() => {
  globalThis.__consensusAggOverride = defaultAggOverride();
});
