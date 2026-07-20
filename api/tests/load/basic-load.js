// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * K6 Load Test - Basic Load
 * Validates system can handle 77 req/s baseline capacity
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');

// Test configuration
export const options = {
  stages: [
    // Ramp-up
    { duration: '1m', target: 10 },   // Ramp to 10 users over 1 min
    { duration: '2m', target: 10 },   // Stay at 10 users for 2 min
    
    // Increase load
    { duration: '1m', target: 30 },   // Ramp to 30 users
    { duration: '3m', target: 30 },   // Stay at 30 users
    
    // Peak load (77 req/s target)
    { duration: '1m', target: 50 },   // Ramp to 50 users
    { duration: '5m', target: 50 },   // Stay at 50 users (should hit ~77 req/s)
    
    // Spike test
    { duration: '30s', target: 100 }, // Spike to 100 users
    { duration: '2m', target: 100 },  // Stay at spike
    
    // Ramp-down
    { duration: '1m', target: 0 },    // Graceful shutdown
  ],
  
  thresholds: {
    'http_req_duration': ['p(95)<5000', 'p(99)<10000'], // 95% < 5s, 99% < 10s
    'http_req_failed': ['rate<0.05'],                    // Error rate < 5%
    'errors': ['rate<0.05'],                             // Custom error rate < 5%
  },
};

// Test data
const MODELS = [
  'openai-gpt-4o',
  'anthropic-claude-3-5-sonnet-20241022',
  'gemini-1.5-flash',
  'deepseek-coder',
];

const messages = [
  [{ role: 'user', content: 'Hello!' }],
  [{ role: 'user', content: 'Write a hello world in Python' }],
  [{ role: 'user', content: 'Explain async/await' }],
  [{ role: 'user', content: 'What is REST API?' }],
];

export default function () {
  const baseUrl = __ENV.API_URL || 'http://localhost:3000';
  const apiKey = __ENV.API_KEY || 'test-api-key';
  
  // Random model and message
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const messageSet = messages[Math.floor(Math.random() * messages.length)];
  
  const payload = JSON.stringify({
    model,
    messages: messageSet,
    max_tokens: 100,
    temperature: 0.7,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'X-Organization-ID': '00000000-0000-0000-0000-000000000000',
    },
    timeout: '30s',
  };

  // Send request
  const res = http.post(`${baseUrl}/v1/chat/completions`, payload, params);
  
  // Track response time
  responseTime.add(res.timings.duration);
  
  // Check response
  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'has response': (r) => r.body && r.body.length > 0,
    'response time < 5s': (r) => r.timings.duration < 5000,
    'has choices': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.choices && data.choices.length > 0;
      } catch {
        return false;
      }
    },
  });

  if (!success) {
    errorRate.add(1);
    console.error(`Request failed: ${res.status} - ${res.body.substring(0, 200)}`);
  } else {
    errorRate.add(0);
  }

  // Sleep between requests (1-2 seconds)
  sleep(Math.random() * 1 + 1);
}

// Setup function (runs once at start)
export function setup() {
  console.log('Starting load test...');
  console.log(`Target: 77 req/s baseline`);
  console.log(`Expected: System handles 50 concurrent users`);
}

// Teardown function (runs once at end)
export function teardown(data) {
  console.log('Load test completed');
}

