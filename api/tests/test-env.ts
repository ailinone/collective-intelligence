// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test environment variables configuration
 * Centralized place for test environment defaults
 * 
 * This file is imported early in both vitest.config.ts (before module resolution)
 * and tests/setup.ts (before importing @/config) to ensure env vars are available
 * when modules that validate them are imported.
 */

import { config } from 'dotenv';

// Load .env.test file if it exists
config({ path: '.env.test' });

/**
 * Load default test environment variables
 * Only sets values if they're not already set (allows override via .env.test)
 */
export function loadTestEnvDefaults() {
  // Essential variables needed before module resolution
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://ailin_dev:ailin_dev_password@localhost:5433/ailin_dev';
  }
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';
  }
  if (!process.env.REDIS_HOST) {
    process.env.REDIS_HOST = 'localhost';
  }
  if (!process.env.REDIS_PORT) {
    process.env.REDIS_PORT = '6379';
  }
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'test';
  }

  // Disable secret audit persistence in tests (database may not be ready yet)
  // This prevents errors when loading secrets before database is initialized
  if (!process.env.SECRETS_AUDIT_PERSIST) {
    process.env.SECRETS_AUDIT_PERSIST = 'false';
  }
  // Also disable audit enabled if not explicitly set (optional, but reduces overhead)
  if (!process.env.SECRETS_AUDIT_ENABLED) {
    process.env.SECRETS_AUDIT_ENABLED = 'false';
  }

  // Skip per-plugin discovery in tests by default. Boot-time path: every
  // catalog plugin registration would otherwise fan out into a full
  // `discoverNewModels()` cycle (HF Hub aggregator, OpenRouter, AIML, etc.),
  // which can take 30-60s per plugin and overwhelm the worker pool when
  // catalog-loader integration tests register synthetic plugins. Tests that
  // specifically validate the discovery path can override this locally.
  if (!process.env.SKIP_PER_PLUGIN_DISCOVERY) {
    process.env.SKIP_PER_PLUGIN_DISCOVERY = 'true';
  }

  // Additional test environment variables
  process.env.AUTH_DEFAULT_MODE = process.env.AUTH_DEFAULT_MODE || 'password';
  process.env.AUTH_ALLOW_PASSWORD_FALLBACK = process.env.AUTH_ALLOW_PASSWORD_FALLBACK || 'true';
  // Use 'console' provider in tests to avoid actual email sending
  process.env.AUTH_EMAIL_PROVIDER = process.env.AUTH_EMAIL_PROVIDER || 'console';
  // Keep SendGrid key for tests that explicitly need it
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || 'sg.test-key';

  // IMPORTANT: For REAL integration tests, we need REAL API keys from GCP Secrets
  // Mock keys are only used as fallback if real keys are not available
  // Set TEST_USE_REAL_API_KEYS=true to use real keys from GCP (requires GCP auth)
  const useRealKeys = process.env.TEST_USE_REAL_API_KEYS === 'true';
  
  // Flag to skip external API calls in tests (only used if real keys are not available)
  // When real keys are loaded, tests will make real API calls to validate the system
  if (!useRealKeys) {
    process.env.TEST_SKIP_EXTERNAL_APIS = process.env.TEST_SKIP_EXTERNAL_APIS || 'true';
  } else {
    // Allow real API calls when real keys are being used
    process.env.TEST_SKIP_EXTERNAL_APIS = 'false';
  }

  // CRITICAL: When using real API keys, NEVER override them with mock values
  // This file can be imported multiple times (vitest.config.ts and setup.ts)
  // So we need to be extra careful to never override real keys once they're loaded
  // global-setup.ts loads real keys from GCP Secrets BEFORE setupFiles runs
  if (!useRealKeys) {
    // Set mock keys only when NOT using real keys
    // Also check if key already exists and looks like a real key (doesn't contain 'mock' or 'test-')
    const setMockIfNotExists = (keyName: string, mockValue: string): void => {
      const existingValue = process.env[keyName];
      // Never override if key exists and doesn't look like a mock/test key
      // Real keys typically start with 'sk-' (OpenAI), 'sk-ant-' (Anthropic), etc.
      if (existingValue) {
        const isMockKey = existingValue.includes('mock') || existingValue.includes('test-');
        const looksLikeRealKey = existingValue.startsWith('sk-') || 
                                  existingValue.startsWith('AIza') || // Google
                                  existingValue.length > 20; // Real keys are usually longer
        if (!isMockKey && looksLikeRealKey) {
          // Key looks real, don't override
          return;
        }
      }
      // Set mock only if key doesn't exist or is already a mock
      if (!existingValue || existingValue.includes('mock') || existingValue.includes('test-')) {
        process.env[keyName] = mockValue;
      }
    };
    
    setMockIfNotExists('OPENAI_API_KEY', 'sk-test-mock-key-do-not-use');
    setMockIfNotExists('ANTHROPIC_API_KEY', 'sk-ant-test-mock-key-do-not-use');
    setMockIfNotExists('GOOGLE_API_KEY', 'test-google-mock-key-do-not-use');
    setMockIfNotExists('DEEPSEEK_API_KEY', 'test-deepseek-mock-key-do-not-use');
    setMockIfNotExists('XAI_API_KEY', 'test-xai-mock-key-do-not-use');
    setMockIfNotExists('MISTRAL_API_KEY', 'test-mistral-mock-key-do-not-use');
    setMockIfNotExists('COHERE_API_KEY', 'test-cohere-mock-key-do-not-use');
    setMockIfNotExists('OPENROUTER_API_KEY', 'test-openrouter-mock-key-do-not-use');
    setMockIfNotExists('VERTEX_AI_API_KEY', 'test-vertex-mock-key-do-not-use');
    if (!process.env.VERTEX_AI_PROJECT_ID) {
      process.env.VERTEX_AI_PROJECT_ID = 'test-project-id';
    }
    
    // AWS Bedrock (optional)
    if (!process.env.AWS_ACCESS_KEY_ID) {
      process.env.AWS_ACCESS_KEY_ID = 'test-aws-key-id';
    }
    if (!process.env.AWS_SECRET_ACCESS_KEY) {
      process.env.AWS_SECRET_ACCESS_KEY = 'test-aws-secret';
    }
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
      process.env.AWS_BEARER_TOKEN_BEDROCK = 'test-aws-token';
    }
    
    // Azure OpenAI (optional)
    if (!process.env.AZURE_OPENAI_API_KEY) {
      process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
    }
    
    // Alibaba/Baidu (optional)
    if (!process.env.ALIBABA_KEY_ID) {
      process.env.ALIBABA_KEY_ID = 'test-alibaba-id';
    }
    if (!process.env.ALIBABA_KEY_SECRET) {
      process.env.ALIBABA_KEY_SECRET = 'test-alibaba-secret';
    }
    if (!process.env.ERNIE_API_KEY) {
      process.env.ERNIE_API_KEY = 'test-baidu-key';
    }
  }
  // When useRealKeys=true, we don't set any keys here - let GCP Secrets load them in global-setup.ts
  
  // Stripe
  // IMPORTANT: Stripe integration tests require real keys when TEST_USE_REAL_API_KEYS=true.
  // Never force mock Stripe keys in that mode, otherwise we'll hit Stripe with invalid credentials.
  process.env.STRIPE_ENABLED = process.env.STRIPE_ENABLED || (useRealKeys ? 'true' : 'false');
  if (!useRealKeys) {
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
    process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_mock';
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_mock';
  }
}

// Auto-load defaults when this module is imported
loadTestEnvDefaults();

