// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vitest config for the DB-backed suites that no pipeline used to run.
 *
 * WHY THIS EXISTS (CI coverage audit, 2026-09-05)
 * -----------------------------------------------
 * `vitest.ci.config.ts` excludes several directories with the note "need real
 * DB" — `src/__tests__/database/**`, `src/__tests__/security/**`,
 * `src/providers/__tests__/**`, and (historically) all of
 * `src/routes/**\/__tests__/**`. The exclusion was correct; the problem is that
 * nothing ever ran them anywhere else, so the suites that assert migration
 * safety, RBAC endpoint authorization, input-validation hardening and the auth
 * JWT/e-mail-challenge flows sat dormant for months.
 *
 * This config runs exactly those files under the SAME harness the existing
 * "Integration tests" and "Security integration gate" steps already use:
 * `tests/global-setup.ts` self-provisions Postgres (pgvector/pgvector:pg16)
 * and Redis (redis:7-alpine) through Testcontainers and applies
 * prisma/migrations. No GitHub Actions `services:` block is needed — the
 * self-hosted runner's Docker daemon is the only requirement, and the
 * pipeline already depends on it for three other steps.
 *
 * Every entry is here because it genuinely needs a database (verified by
 * running each one against a real Postgres); anything that turned out to be
 * hermetic was moved into vitest.ci.config.ts / vitest.orchestration.config.ts
 * instead of being parked here.
 *
 * Run from `api/`:
 *   pnpm exec vitest run --config vitest.db-backed.config.ts
 */
import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        // Asserts the applied migration set against the live schema.
        'src/__tests__/database/migration-safety.test.ts',
        // Boot a real server + seeded org/users; assert endpoint-level RBAC
        // and the input-validation hardening (SQLi/XSS/traversal/body limit).
        'src/__tests__/security/input-validation.test.ts',
        'src/__tests__/security/rbac-authorization.test.ts',
        // Provider registry/operability read the model catalog from the DB.
        'src/providers/__tests__/provider-integration.test.ts',
        'src/providers/__tests__/provider-operability.test.ts',
        // Register/login/refresh and the e-mail challenge flow, end to end.
        'src/routes/auth/__tests__/auth-email-challenge.test.ts',
        'src/routes/auth/__tests__/auth-jwt-flow.test.ts',
        // Builds its model context from the catalog via model-repository.
        'src/core/orchestration/__tests__/collaborative-strategy.test.ts',
      ],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  })
);
