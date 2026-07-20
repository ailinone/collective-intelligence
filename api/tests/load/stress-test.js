// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * K6 Stress Test - Find Breaking Point
 * Gradually increases load until system breaks
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  stages: [
    // Gradual ramp to find breaking point
    { duration: '2m', target: 50 },    // 50 users (~77 req/s)
    { duration: '3m', target: 50 },    // Hold
    
    { duration: '2m', target: 100 },   // 100 users (~150 req/s)
    { duration: '3m', target: 100 },   // Hold
    
    { duration: '2m', target: 200 },   // 200 users (~300 req/s)
    { duration: '3m', target: 200 },   // Hold - Queue should activate
    
    { duration: '2m', target: 500 },   // 500 users (~750 req/s)
    { duration: '2m', target: 500 },   // Stress test
    
    { duration: '2m', target: 0 },     // Ramp down
  ],
  
  thresholds: {
    'http_req_failed': ['rate<0.10'], // Allow up to 10% errors under stress
    'errors': ['rate<0.10'],
  },
};

export default function () {
  const baseUrl = __ENV.API_URL || 'http://localhost:3000';
  const apiKey = __ENV.API_KEY || 'test-api-key';
  
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Stress test' }],
    max_tokens: 50,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    timeout: '60s',
  };

  const res = http.post(`${baseUrl}/v1/chat/completions`, payload, params);
  
  const success = check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429, // 429 = rate limit OK
    'response time < 30s': (r) => r.timings.duration < 30000,
  });

  errorRate.add(!success ? 1 : 0);

  sleep(0.5); // 0.5s between requests
}

export function setup() {
  console.log('🔥 STRESS TEST - Finding Breaking Point');
  console.log('Will ramp to 500 concurrent users');
}

export function teardown(data) {
  console.log('✅ Stress test completed');
  console.log('Check results for breaking point');
}

