// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vitest setup file
 * Runs before all tests
 * 
 * NOTE: Test environment variables are loaded in tests/test-env.ts which
 * is imported in vitest.config.ts BEFORE module resolution. This ensures
 * DATABASE_URL and other required vars are available when @/config is imported.
 */

import 'reflect-metadata';
import { afterEach, vi } from 'vitest';

// Import test environment setup to ensure all defaults are loaded
// (Already loaded in vitest.config.ts, but re-importing is safe and ensures
// all variables are set even if config loading order changes)
// NOTE: loadTestEnvDefaults() is idempotent and checks for existing values,
// so it won't override real API keys loaded by global-setup.ts
import './test-env';

// Now it's safe to import modules that depend on configuration
import { config as appConfig } from '@/config';
import { initializeCacheRuntime } from '@/cache/cache-runtime-state';
import { initializeQueueRuntime } from '@/queue/queue-runtime-state';

// Initialize runtime state using loaded configuration
initializeCacheRuntime(appConfig.cache.enabled);
initializeQueueRuntime(appConfig.queue);

afterEach(() => {
  vi.restoreAllMocks();
});

