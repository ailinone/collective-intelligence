// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vitest Configuration for CI/CD
 *
 * Simplified config without globalSetup for Cloud Build compatibility
 * Uses in-memory database mocks instead of Testcontainers
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

// Set test env defaults (DATABASE_URL, JWT_SECRET, etc.) before any module
// is resolved. src/**/*.test.ts import @/config which validates DATABASE_URL
// at module load time. vitest.config.ts does the same via a top-level import.
import { loadTestEnvDefaults } from './tests/test-env';
loadTestEnvDefaults();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // No globalSetup - incompatible with Cloud Build
    testTimeout: 30_000,
    hookTimeout: 10_000,
    sequence: {
      concurrent: false,
    },
    // Only run unit tests (no integration tests requiring DB)
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/**', // Exclude top-level integration tests
      'src/tests/**', // Exclude integration tests co-located in src/tests/
      'src/**/*.integration.test.ts', // DB-backed integration tests (run via vitest.integration.config.ts)
      'src/routes/**/__tests__/**', // Exclude route integration tests
      'src/__tests__/security/**', // Exclude security integration tests
      'src/__tests__/database/**', // Exclude database tests
      'src/providers/__tests__/**', // Exclude provider integration tests (need real DB)
      'src/core/orchestration/__tests__/**', // Exclude orchestration tests (run separately by workflow)
      // Consensus-validation suite (all consensus-*): these REQUIRE the response-
      // aggregator + ensemble-shadow mocks from consensus-validation.setup.ts, which
      // this bare config does not load → e.g. consensus-strategy.artifacts' synthesis
      // test sees the real aggregator ("Provider registry not initialized") and fails.
      // They run under vitest.consensus-validation.config.ts instead.
      'src/core/orchestration/strategies/__tests__/**',
      // 01C.1B plan-gate suite — tests for applyDryRunFailClosedGate,
      // plan-fingerprint parity, and the real-branch plan gate inside
      // processChatRequest. IMPLEMENTED (see chat-request-processor.ts) but
      // excluded from THIS bare config: the gate builds a real consensus
      // plan via getModelRepository()/buildConsensusRoleSpecificCandidatePools,
      // which needs the real (Testcontainers-managed) Postgres this
      // simplified config does not provide. Run under vitest.config.ts (the
      // default, Testcontainers-backed config) via the dedicated
      // "Plan-gate tests" CI step — same pattern as strategy-contract.test.ts.
      'src/services/__tests__/chat-request-processor-dryrun-fail-closed.test.ts',
      'src/services/__tests__/chat-request-processor-plan-parity.test.ts',
      'src/services/__tests__/chat-request-processor-real-branch-plan-gate.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/**',
      ],
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

