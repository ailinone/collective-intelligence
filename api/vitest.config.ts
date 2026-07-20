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

