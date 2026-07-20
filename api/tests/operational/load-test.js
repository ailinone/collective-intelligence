// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Load Test — ci/api
 * Board Requirement: 500 req/s × 15 min
 *
 * Usage with k6:
 *   k6 run tests/operational/load-test.js --env API_URL=https://api.ailin.one --env API_KEY=sk-xxx
 *
 * Usage with Node.js (basic):
 *   API_URL=http://localhost:3000 API_KEY=sk-xxx node tests/operational/load-test.js
 *
 * Thresholds (board requirements):
 *   - p95 < 5s
 *   - p99 < 10s
 *   - error rate < 2%
 *   - throughput >= 500 req/s sustained
 */

// Detect k6 runtime
const isK6 = typeof __VU !== 'undefined';

if (isK6) {
  // ── k6 mode ──
  // eslint-disable-next-line
  const http = require('k6/http');
  // eslint-disable-next-line
  const { check, sleep } = require('k6');
  // eslint-disable-next-line
  const { Rate, Trend } = require('k6/metrics');

  const errorRate = new Rate('errors');
  const chatLatency = new Trend('chat_latency_ms');

  module.exports.options = {
    stages: [
      { duration: '1m', target: 100 },   // Ramp up
      { duration: '13m', target: 500 },   // Sustained 500 req/s
      { duration: '1m', target: 0 },      // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<5000', 'p(99)<10000'],
      errors: ['rate<0.02'],
    },
  };

  module.exports.default = function () {
    const url = `${__ENV.API_URL}/v1/chat/completions`;
    const payload = JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello, how are you?' }],
      max_tokens: 50,
      stream: false,
    });

    const params = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.API_KEY}`,
      },
      timeout: '15s',
    };

    const start = Date.now();
    const res = http.post(url, payload, params);
    chatLatency.add(Date.now() - start);

    const success = check(res, {
      'status is 200': (r) => r.status === 200,
      'response has choices': (r) => {
        try { return JSON.parse(r.body).choices.length > 0; }
        catch { return false; }
      },
    });

    errorRate.add(!success);
    sleep(0.1); // Small pause between requests per VU
  };
} else {
  // ── Node.js mode (basic load test) ──
  const API_URL = process.env.API_URL || 'http://localhost:3000';
  const API_KEY = process.env.API_KEY || 'test-key';
  const DURATION_MS = 15 * 60 * 1000; // 15 minutes
  const TARGET_RPS = 500;
  const CONCURRENCY = 50;

  let totalRequests = 0;
  let totalErrors = 0;
  const latencies = [];

  async function sendRequest() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'Load test ping' }],
          max_tokens: 50,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const latency = Date.now() - start;
      latencies.push(latency);
      totalRequests++;
      if (!res.ok) totalErrors++;
    } catch {
      totalRequests++;
      totalErrors++;
      latencies.push(Date.now() - start);
    }
  }

  async function runBatch() {
    const promises = Array.from({ length: CONCURRENCY }, () => sendRequest());
    await Promise.allSettled(promises);
  }

  async function main() {
    console.log(`Load test: ${API_URL}, target ${TARGET_RPS} req/s, ${DURATION_MS / 60000} min`);
    const startTime = Date.now();
    const intervalMs = (CONCURRENCY / TARGET_RPS) * 1000;

    while (Date.now() - startTime < DURATION_MS) {
      await runBatch();
      const elapsed = Date.now() - startTime;
      const rps = (totalRequests / (elapsed / 1000)).toFixed(1);
      if (totalRequests % 1000 === 0) {
        console.log(`${(elapsed/1000).toFixed(0)}s: ${totalRequests} req, ${rps} rps, ${totalErrors} errors`);
      }
      await new Promise(r => setTimeout(r, Math.max(0, intervalMs - 10)));
    }

    // Results
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const errorRate = ((totalErrors / totalRequests) * 100).toFixed(2);
    const avgRps = (totalRequests / (DURATION_MS / 1000)).toFixed(1);

    console.log('\n=== LOAD TEST RESULTS ===');
    console.log(`Total requests: ${totalRequests}`);
    console.log(`Total errors: ${totalErrors} (${errorRate}%)`);
    console.log(`Average RPS: ${avgRps}`);
    console.log(`Latency p50: ${p50}ms`);
    console.log(`Latency p95: ${p95}ms`);
    console.log(`Latency p99: ${p99}ms`);
    console.log('\n=== BOARD THRESHOLDS ===');
    console.log(`p95 < 5000ms: ${p95 < 5000 ? 'PASS' : 'FAIL'} (${p95}ms)`);
    console.log(`p99 < 10000ms: ${p99 < 10000 ? 'PASS' : 'FAIL'} (${p99}ms)`);
    console.log(`Error rate < 2%: ${parseFloat(errorRate) < 2 ? 'PASS' : 'FAIL'} (${errorRate}%)`);
    console.log(`Sustained RPS >= 500: ${parseFloat(avgRps) >= 500 ? 'PASS' : 'NEEDS SCALING'} (${avgRps})`);
  }

  main().catch(console.error);
}
