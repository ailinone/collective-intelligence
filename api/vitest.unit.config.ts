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

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'src/core/**/__tests__/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/**', // Exclude integration tests that need DB
    ],
    // No global setup - pure unit tests
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
