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

// Same env loading as main config so DB/Redis are available
import './tests/test-env';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    // NOTE: vitest uses `include` (not Jest's `testMatch`). Using `testMatch`
    // here is silently ignored, which made this config fall back to the default
    // include (**/*.test.ts) and run the ENTIRE 746-file suite under the
    // integration harness — pulling in unit/consensus suites without their
    // per-file setup (e.g. consensus-validation mocks) and failing them.
    include: ['**/*.integration.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts', './tests/integration/setup.ts'],
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 300_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
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
