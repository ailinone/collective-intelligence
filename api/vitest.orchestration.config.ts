// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vitest config for the orchestration test suites.
 *
 * WHY THIS EXISTS (CI coverage audit, 2026-09-05)
 * -----------------------------------------------
 * `vitest.ci.config.ts` excludes `src/core/orchestration/__tests__/**` and
 * `src/core/orchestration/strategies/__tests__/**` wholesale, with the note
 * "run separately by workflow". In practice the workflow only ever ran four
 * named files (strategy-contract, prior-p0-regression, new-components,
 * champion-challenger) plus the `consensus-strategy.*` subset — so ~130
 * orchestration test files were excluded from the unit config AND never
 * named by any step: they existed, were maintained, and executed nowhere.
 *
 * This config closes that hole. It runs EVERY orchestration test that is not
 * already owned by another step, so a new file dropped into either
 * `__tests__` directory is covered by CI automatically instead of needing a
 * workflow edit that nobody remembers to make.
 *
 * Ownership is derived, not hand-maintained: the consensus-validation
 * include list is imported from that config, so a file moved into it
 * automatically drops out here (and vice versa) — no second list to keep in
 * sync.
 *
 * No globalSetup: these are hermetic unit/contract tests (no Postgres, no
 * Redis, no Testcontainers). The handful of orchestration tests that DO need
 * a real database are listed in DB_BACKED below and run under
 * vitest.config.ts in their own workflow step.
 *
 * Run from `api/`:
 *   pnpm exec vitest run --config vitest.orchestration.config.ts
 */
import { defineConfig, type UserConfig } from 'vitest/config';
import path from 'path';

import { loadTestEnvDefaults } from './tests/test-env';
import consensusValidationConfig from './vitest.consensus-validation.config';

loadTestEnvDefaults();

/**
 * Files already executed by the consensus-validation step. Imported rather
 * than copied so the two configs can never drift into double-running (or,
 * worse, both dropping) a file.
 */
const consensusOwned: string[] = ((consensusValidationConfig as UserConfig).test?.include ??
  []) as string[];

/**
 * Orchestration suites that need the REAL (Testcontainers) Postgres and are
 * therefore run under vitest.config.ts by a dedicated workflow step.
 *
 * - strategy-contract / prior-p0-regression / new-components /
 *   champion-challenger: pre-existing dedicated steps, unchanged.
 * - collaborative-strategy: builds its context from the model catalog in the
 *   database.
 */
const DB_BACKED = [
  'src/core/orchestration/__tests__/strategy-contract.test.ts',
  'src/core/orchestration/__tests__/prior-p0-regression.test.ts',
  'src/core/orchestration/__tests__/new-components.test.ts',
  'src/core/orchestration/__tests__/champion-challenger.test.ts',
  'src/core/orchestration/__tests__/collaborative-strategy.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // No globalSetup — hermetic suites only.
    testTimeout: 30_000,
    hookTimeout: 15_000,
    sequence: {
      concurrent: false,
    },
    include: [
      'src/core/orchestration/__tests__/**/*.test.ts',
      'src/core/orchestration/strategies/__tests__/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', ...consensusOwned, ...DB_BACKED],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/config': path.resolve(__dirname, './src/config'),
      '@/core': path.resolve(__dirname, './src/core'),
      '@/providers': path.resolve(__dirname, './src/providers'),
      '@/database': path.resolve(__dirname, './src/database'),
      '@/types': path.resolve(__dirname, './src/types'),
      '@/utils': path.resolve(__dirname, './src/utils'),
    },
  },
});
