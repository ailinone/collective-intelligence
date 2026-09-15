// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dedicated harness for the selection candidate-cap benchmark
 * (tests/benchmarks/selection-cap-benchmark.test.ts).
 *
 * Deliberately NOT part of any existing suite:
 *  - `vitest.ci.config.ts` only includes `src/**` and excludes top-level `tests/**`.
 *  - `vitest.integration.config.ts` only includes integration-suffixed tests
 *    under tests/integration — this file matches neither include pattern.
 * Nothing in CI picks this up; it is a manually-run measurement tool:
 *
 *   BENCH_N=50000 pnpm exec vitest run --config vitest.selection-cap-bench.config.ts
 *
 * One invocation per catalog size (BENCH_N): each invocation boots exactly ONE
 * Postgres testcontainer, seeds it, runs the benchmark, and tears it down —
 * module-level caches (curated-bucket snapshot, popularity seed, catalog cache)
 * are per-process, so different N must not share a process.
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

// Same env loading as the other DB-backed configs so @/config validates at import.
import './tests/test-env';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/benchmarks/**/*.test.ts'],
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 3_600_000,
    hookTimeout: 1_800_000,
    teardownTimeout: 120_000,
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
