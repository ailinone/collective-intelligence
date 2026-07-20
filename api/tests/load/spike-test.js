// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * K6 Spike Test - Sudden Traffic Surge
 * Tests queue system and resilience under sudden load
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Normal load
    { duration: '10s', target: 500 },  // SPIKE! (0-500 in 10s)
    { duration: '3m', target: 500 },   // Hold spike
    { duration: '30s', target: 10 },   // Back to normal
    { duration: '1m', target: 0 },     // Ramp down
  ],
  
  thresholds: {
    'http_req_failed': ['rate<0.15'], // Allow 15% errors on spike
    'http_req_duration': ['p(95)<15000'], // 95% < 15s (queue processing)
  },
};

export default function () {
  const baseUrl = __ENV.API_URL || 'http://localhost:3000';
  const apiKey = __ENV.API_KEY || 'test-api-key';
  
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Spike test' }],
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
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'response received': (r) => r.body.length > 0,
  });

  errorRate.add(!success ? 1 : 0);
}

export function setup() {
  console.log('⚡ SPIKE TEST - Sudden Traffic Surge');
  console.log('Will spike from 10 to 500 users in 10 seconds');
  console.log('Tests queue system resilience');
}

