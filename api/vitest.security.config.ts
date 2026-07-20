// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vitest Configuration for the security gate.
 *
 * No globalSetup (no Testcontainers / DB) so the mocked security suites run
 * fast and hermetically in CI and locally. These suites live under
 * src/tests/security/** which the CI unit config (vitest.ci.config.ts)
 * deliberately excludes (`src/tests/**`), so they need their own include here.
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

// Set test env defaults (DATABASE_URL, JWT_SECRET, etc.) before any module is
// resolved — src/**/*.test.ts import @/config which validates env at load time.
import { loadTestEnvDefaults } from './tests/test-env';
loadTestEnvDefaults();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // No globalSetup — these suites mock auth/JWT and do not touch a real DB.
    testTimeout: 30_000,
    hookTimeout: 10_000,
    sequence: {
      concurrent: false,
    },
    threads: false,
    include: [
      // Mocked, hermetic security suites: negative-auth matrix, auth-claims
      // regression, and RBAC require-permission middleware enforcement.
      'src/tests/security/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
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
