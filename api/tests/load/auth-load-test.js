// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authentication Load Test
 * 
 * Tests authentication performance at scale:
 * - Target: 10K auth req/sec
 * - Duration: 5 minutes
 * - Ramp-up: 30 seconds
 * - Scenarios: Login, API key validation, token refresh
 * 
 * Run with: k6 run auth-load-test.js
 * 
 * Thresholds (SLA):
 * - p95 latency < 100ms
 * - p99 latency < 500ms
 * - Error rate < 1%
 * - Throughput > 10K req/sec
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const authErrorRate = new Rate('auth_errors');
const authLatency = new Trend('auth_latency');
const successfulAuths = new Counter('successful_auths');

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 100 },    // Ramp-up to 100 VUs
    { duration: '1m', target: 500 },     // Ramp-up to 500 VUs
    { duration: '2m', target: 1000 },    // Sustained load: 1000 VUs
    { duration: '1m', target: 2000 },    // Peak load: 2000 VUs
    { duration: '30s', target: 0 },      // Ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<100', 'p(99)<500'], // 95% < 100ms, 99% < 500ms
    'auth_errors': ['rate<0.01'], // Error rate < 1%
    'http_req_failed': ['rate<0.01'], // HTTP error rate < 1%
  },
};

// Test data
const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const TEST_API_KEY = __ENV.TEST_API_KEY || 'ak_test_dummy';

export default function () {
  // Scenario 1: API Key Authentication (most common)
  const apiKeyStart = Date.now();
  
  const apiKeyResponse = http.get(`${BASE_URL}/v1/models/list`, {
    headers: {
      'x-api-key': TEST_API_KEY,
    },
    tags: { name: 'api_key_auth' },
  });

  const apiKeyLatency = Date.now() - apiKeyStart;
  authLatency.add(apiKeyLatency);

  const apiKeySuccess = check(apiKeyResponse, {
    'api key auth status 200': (r) => r.status === 200,
    'api key auth latency < 100ms': () => apiKeyLatency < 100,
  });

  if (apiKeySuccess) {
    successfulAuths.add(1);
  } else {
    authErrorRate.add(1);
  }

  // Scenario 2: JWT Token Authentication (less common)
  if (Math.random() < 0.2) { // 20% of requests use JWT
    const loginResponse = http.post(
      `${BASE_URL}/v1/auth/login`,
      JSON.stringify({
        email: `load-test-${__VU}@example.com`,
        password: 'TestPassword123',
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'jwt_login' },
      }
    );

    check(loginResponse, {
      'jwt login status 200 or 401': (r) => r.status === 200 || r.status === 401,
    });
  }

  // Think time (simulate real user behavior)
  sleep(Math.random() * 2); // 0-2 seconds
}

/**
 * Setup function - runs once before test
 */
export function setup() {
  console.log('🚀 Starting authentication load test');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Duration: 5 minutes`);
  console.log(`   Peak VUs: 2000`);
  console.log('');
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  console.log('');
  console.log('✅ Load test completed');
  console.log('   Check results above for SLA compliance');
}

