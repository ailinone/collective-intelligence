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
      // CI-coverage audit (2026-09-05): this used to exclude ALL of
      // `src/tests/**`. Only the security subtree needs its own harness
      // (vitest.security.config.ts owns it, plus the DB-backed
      // auth-security-matrix step); the other 11 files under src/tests/ —
      // middleware, remediation, models-list routes, the anthropic adapter
      // converter — are plain hermetic unit tests that the blanket exclusion
      // dropped from EVERY pipeline. Narrowed so they run here.
      'src/tests/security/**',
      'src/**/*.integration.test.ts', // DB-backed integration tests (run via vitest.integration.config.ts)
      // Same audit: this used to exclude `src/routes/**/__tests__/**`
      // wholesale as "route integration tests", but only the auth suites
      // actually need a real DB + booted server (they register orgs/users and
      // exercise JWT/e-mail-challenge flows). Those two run under
      // vitest.config.ts in the "DB-backed route/security/provider tests"
      // workflow step; the other 12 route suites are pure unit/contract tests
      // (schema shape, source-wiring invariants, free-tier ceiling maths) and
      // now run here.
      'src/routes/auth/__tests__/**',
      'src/__tests__/security/**', // Exclude security integration tests
      'src/__tests__/database/**', // Exclude database tests
      'src/providers/__tests__/**', // Exclude provider integration tests (need real DB)
      // Orchestration suites run under vitest.orchestration.config.ts (which
      // covers the whole directory) and vitest.consensus-validation.config.ts.
      'src/core/orchestration/__tests__/**',
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

