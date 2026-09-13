// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { defineConfig } from 'vitest/config';
import path from 'path';

// Import test environment setup - this MUST be imported before any modules
// that depend on configuration are resolved. This ensures DATABASE_URL and
// other required env vars are available when @/config is imported during
// test file analysis.
import './tests/test-env';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    isolate: true,
    globalSetup: ['./tests/global-setup.ts'],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 300_000,  // 5 min for long integration (e.g. all-140-operations)
    // CI-COVERAGE AUDIT (2026-09-05) parity: vitest.ci.config.ts already excludes
    // this directory with the note below; this bare/default config (what
    // `pnpm test` runs with zero args) never got the matching exclude, so a
    // plain `pnpm test` silently regresses to the REAL response-aggregator +
    // ensemble-shadow modules for every consensus-strategy test that calls
    // ConsensusStrategy.execute(). Those tests only pass under the mocks
    // registered by consensus-validation.setup.ts (see consensus-module-mocks.ts's
    // header) or by a file-local vi.mock — this config provides neither, so the
    // strategy hits the unmocked aggregator, which has no provider registry in
    // the test environment ("Provider registry not initialized") and falls back
    // unpredictably, producing selection/validationStatus results the tests
    // never asserted on. That is a test-invocation mismatch, not a product bug:
    // ConsensusStrategy's fallback/validationStatus logic and the two
    // consensus-strategy.fallback/validation-status test files are both correct
    // (verified 100% green under the configs that actually own them). This
    // directory is exhaustively covered elsewhere — vitest.consensus-validation.config.ts
    // (the consensus-strategy.* subset, DB-free, aggregator mocked) and
    // vitest.orchestration.config.ts (everything else here, DB-free) — and run
    // by the "Consensus strategy validation" / "Orchestration suites" CI steps.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/core/orchestration/strategies/__tests__/**',
    ],
    // CRITICAL: Ensure complete isolation between test files
    // This prevents race conditions and data interference when tests share a database
    sequence: {
      concurrent: false,
    },
    // Disable all parallelism to ensure test files run sequentially
    // Required for database integration tests that share the same database instance
    pool: 'forks',  // Use forks pool instead of threads for better isolation
    poolOptions: {
      forks: {
        singleFork: true,  // Run all tests in a single fork (sequential)
        isolate: true,     // Isolate each test file
      },
    },
    fileParallelism: false,  // Ensure test files run one at a time
    // Teardown configuration to prevent hanging
    teardownTimeout: 60_000,  // 60 seconds for teardown
    // Hook timeout for beforeAll/afterAll
    hookTimeout: 120_000,  // 2 min for hooks (all-140-operations beforeAll is heavy)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/**',
      ],
    },
    setupFiles: ['./tests/setup.ts'],
    // Ensure clean process exit
    passWithNoTests: true,
    dangerouslyIgnoreUnhandledErrors: false,
    // Force exit after tests complete to prevent hanging due to open handles
    forceRerunTriggers: [],
    // Reporters configuration
    reporters: process.env.CI ? ['default'] : ['default'],
    // onConsoleLog: () => false, // Uncomment to suppress console logs during tests
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

