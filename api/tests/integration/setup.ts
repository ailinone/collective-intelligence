// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests setup
 * Sets up test environment for end-to-end testing
 */

import { config } from 'dotenv';

// Load test environment
config({ path: '.env.test' });

// Set test environment
process.env.NODE_ENV = 'test';

// Integration test configuration
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://ailin_dev:ailin_dev_password@localhost:5433/ailin_dev';
process.env.JWT_SECRET = 'integration-test-jwt-secret-for-testing-must-be-32-chars';
// Respect Redis endpoint provisioned by global test environment (Testcontainers/local).
process.env.REDIS_HOST = process.env.REDIS_HOST || 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';

// For integration tests, we need real API keys or mocks
// If no real keys available, skip tests that require them
if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  No provider API keys configured. Some integration tests will be skipped.');
  console.warn('   Set OPENAI_API_KEY or ANTHROPIC_API_KEY to run all tests.');
}

// Global test timeout
process.env.TEST_TIMEOUT = '30000';
