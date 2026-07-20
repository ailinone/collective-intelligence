// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Chat Completion Load Test
 * 
 * Tests chat completion performance at scale:
 * - Target: 1K concurrent requests
 * - Duration: 10 minutes
 * - Scenarios: Simple prompts, complex prompts, streaming
 * 
 * Run with: k6 run chat-completion-load.js
 * 
 * Thresholds:
 * - p95 latency < 5s
 * - p99 latency < 10s
 * - Error rate < 2%
 * 
 * NOTE: Uses 'auto' model selection to let the system dynamically choose
 * the best model. For load testing, this ensures we test with real,
 * available models rather than hardcoded ones.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const chatErrorRate = new Rate('chat_errors');
const chatLatency = new Trend('chat_latency');
const successfulChats = new Counter('successful_chats');
const totalTokens = new Counter('total_tokens');

export const options = {
  stages: [
    { duration: '1m', target: 100 },     // Warm-up
    { duration: '2m', target: 500 },     // Ramp-up
    { duration: '5m', target: 1000 },    // Sustained load
    { duration: '1m', target: 1500 },    // Peak
    { duration: '1m', target: 0 },       // Ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<5000', 'p(99)<10000'], // 5s/10s
    'chat_errors': ['rate<0.02'], // < 2% error rate
    'http_req_failed': ['rate<0.02'],
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const TEST_API_KEY = __ENV.TEST_API_KEY || 'ak_test_dummy';
// Allow override via environment variable, but default to 'auto' for dynamic selection
const TEST_MODEL = __ENV.TEST_MODEL || 'auto'; // Use 'auto' for dynamic model selection

// Test prompts (various complexity)
const PROMPTS = [
  'Hello, how are you?', // Simple
  'Explain quantum entanglement in simple terms', // Medium
  'Write a comprehensive guide to microservices architecture with code examples in TypeScript', // Complex
  'What is 2+2?', // Trivial
  'Translate this to French: The quick brown fox jumps over the lazy dog', // Translation
];

export default function () {
  const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  const useStreaming = Math.random() < 0.3; // 30% streaming

  const payload = JSON.stringify({
    model: TEST_MODEL, // Use 'auto' for dynamic model selection (no hardcoded models)
    messages: [
      { role: 'user', content: prompt },
    ],
    stream: useStreaming,
    max_tokens: 500,
  });

  const startTime = Date.now();

  const response = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: {
      'x-api-key': TEST_API_KEY,
      'Content-Type': 'application/json',
    },
    tags: { 
      name: 'chat_completion',
      streaming: useStreaming ? 'true' : 'false',
    },
  });

  const latency = Date.now() - startTime;
  chatLatency.add(latency);

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has response': (r) => r.body && r.body.length > 0,
    'latency acceptable': () => latency < 10000,
  });

  if (success) {
    successfulChats.add(1);
    
    // Track token usage
    try {
      const body = JSON.parse(response.body);
      if (body.usage && body.usage.total_tokens) {
        totalTokens.add(body.usage.total_tokens);
      }
    } catch (e) {
      // Ignore parse errors
    }
  } else {
    chatErrorRate.add(1);
  }

  sleep(Math.random() * 3 + 1); // 1-4 seconds think time
}

export function setup() {
  console.log('🚀 Starting chat completion load test');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Duration: 10 minutes`);
  console.log(`   Peak VUs: 1500`);
  console.log(`   Model: ${TEST_MODEL} (using dynamic selection)`);
  console.log('');

  // Verify API is accessible
  const healthCheck = http.get(`${BASE_URL}/health`);
  if (healthCheck.status !== 200) {
    throw new Error(`API not healthy: ${healthCheck.status}`);
  }
  console.log('✅ API health check passed');
  console.log('');
}

export function teardown(data) {
  console.log('');
  console.log('✅ Chat completion load test completed');
  console.log('   Review metrics above for performance analysis');
}

