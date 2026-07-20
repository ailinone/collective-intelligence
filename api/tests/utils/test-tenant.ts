// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test Tenant Configuration
 * 
 * Constants for the default test tenant used in integration tests.
 * 
 * @module tests/utils/test-tenant
 */

import type { OrganizationTier } from '@/config/multi-tenancy-config';

// Test Organization Configuration
export const TEST_TENANT_ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
export const TEST_TENANT_ORGANIZATION_NAME = 'Test Organization';
export const TEST_TENANT_TIER: OrganizationTier = 'enterprise';

// Test User Configuration
export const TEST_TENANT_USER_ID = '22222222-2222-2222-2222-222222222222';
export const TEST_TENANT_USER_EMAIL = 'test@example.com';
export const TEST_TENANT_USER_NAME = 'Test User';
export const TEST_TENANT_USER_PASSWORD = 'TestPassword123!';

// Test Quotas Configuration
export const TEST_TENANT_QUOTAS = {
  requestsPerMinute: 100,
  requestsPerHour: 1000,
  requestsPerDay: 10000,
  tokensPerMinute: 100000,
  tokensPerHour: 1000000,
  tokensPerDay: 10000000,
  maxConcurrentRequests: 50,
  maxModelsPerRequest: 10,
  maxTokensPerRequest: 128000,
};

// Test Features Configuration
export const TEST_TENANT_FEATURES = {
  multiModel: true,
  streaming: true,
  toolExecution: true,
  codebaseIndexing: true,
  semanticSearch: true,
  advancedAnalytics: true,
  customModels: true,
  priorityQueue: true,
  dedicatedWorkers: false,
  sso: true,
  auditLogs: true,
  customRateLimits: true,
};

// API Key for testing
export const TEST_API_KEY = 'ak_test_enterprise_key_001';
export const TEST_API_KEY_HASH = 'test-api-key-hash';

// Helper function to get test tenant context
export function getTestTenantContext() {
  return {
    organizationId: TEST_TENANT_ORGANIZATION_ID,
    userId: TEST_TENANT_USER_ID,
    tier: TEST_TENANT_TIER,
    roles: ['owner', 'admin', 'developer'],
    features: TEST_TENANT_FEATURES,
    quotas: TEST_TENANT_QUOTAS,
  };
}

// Helper function to get test auth headers
export function getTestAuthHeaders() {
  return {
    'authorization': `Bearer ${TEST_API_KEY}`,
    'x-organization-id': TEST_TENANT_ORGANIZATION_ID,
    'x-user-id': TEST_TENANT_USER_ID,
  };
}

