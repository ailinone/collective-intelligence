// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 1 Scoring Hot-Path Load Test — scale-to-100k acceptance criterion
 *
 * Measures the specific claim from PR #135 (merged): moving model-catalog
 * scoring off the per-request hot path should raise the achievable
 * concurrent-request ceiling from ~40-200 req/s/replica to >=1000 req/s/replica.
 *
 * WHY THIS IS A DIFFERENT TEST FROM chat-completion-load.js / stress-test.js:
 *   Those tests use realistic think-time (1-4s sleep per VU) and large
 *   max_tokens (500) — good for "does the system feel responsive under
 *   realistic traffic", bad for isolating a CPU-bound event-loop ceiling.
 *   The bug this PR fixed was synchronous scoring of ~76k models blocking
 *   the Node.js event loop on EVERY request, capping concurrent throughput
 *   independent of how fast providers respond. To see that ceiling move,
 *   this test removes think-time and uses a trivial payload, so VUs apply
 *   sustained concurrent pressure instead of trickling requests in.
 *
 * IMPORTANT — isolating Phase 1 from Phase 2 (provider fan-out):
 *   Run against the real API + real providers, this test's ceiling reflects
 *   BOTH the scoring fix (Phase 1) AND the still-unfixed in-memory
 *   per-replica provider bulkhead (Phase 2, tracked in issue #147) — the
 *   audit's #1 ranked bottleneck. Expect the ceiling to land somewhere
 *   above the pre-fix ~40-200 req/s but likely still well below 1000,
 *   *and that's expected* until #147 lands too — it isolates which
 *   bottleneck binds next, per the audit's own ranking.
 *
 *   To isolate JUST the Phase 1 scoring change (no provider latency in the
 *   critical path), stand up ./stub-provider-server.js and point every
 *   provider's `*_BASE_URL` env var (see api/.env.example) at it for the
 *   duration of the run, e.g.:
 *     node stub-provider-server.js &            # listens on :9009
 *     export OPENAI_BASE_URL=http://localhost:9009/v1
 *     export DEEPSEEK_BASE_URL=http://localhost:9009/v1
 *     export MISTRAL_BASE_URL=http://localhost:9009/v1
 *     # ...any other OpenAI-compatible provider you have configured live
 *   restart the API against that env, then run this script against it.
 *   In that mode, the measured ceiling reflects server-side routing +
 *   scoring overhead only, matching what "req/s/replica" means in the PR.
 *
 * Run:
 *   k6 run phase1-scoring-load-test.js \
 *     -e API_URL=https://staging.example.com \
 *     -e TEST_API_KEY=ak_test_xxx
 *
 * Comparison methodology:
 *   1. Run this script against a deployment of `main` BEFORE #135 (or with
 *      MODEL_SCORING_CACHE_TTL_MS=0 to effectively disable the cache) —
 *      record the sustained-load stage's req/s.
 *   2. Run it again against current `main` (cache enabled, default TTL).
 *   3. Compare the two sustained-load req/s figures.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const scoringErrorRate = new Rate('scoring_path_errors');
const scoringLatency = new Trend('scoring_path_latency');
const completedRequests = new Counter('scoring_path_completed');

export const options = {
  scenarios: {
    ceiling_probe: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },    // warm-up
        { duration: '1m', target: 200 },    // pre-fix ceiling was ~40-200 req/s
        { duration: '2m', target: 1000 },   // acceptance target: >=1000 req/s/replica
        { duration: '1m', target: 1000 },   // hold at target to confirm it's sustained, not a spike
        { duration: '30s', target: 0 },     // ramp-down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Intentionally NOT asserting req/s >= 1000 as a hard threshold: whether
    // that's reachable depends on which bottleneck binds next (see header
    // comment re: Phase 2). Assert latency/error-rate sanity; read the
    // achieved `http_reqs` rate from the summary for the actual comparison.
    'http_req_duration': ['p(95)<2000'],
    'scoring_path_errors': ['rate<0.02'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const TEST_API_KEY = __ENV.TEST_API_KEY || 'ak_test_dummy';

// Trivial, fixed payload on purpose — this test isolates routing/scoring
// overhead, not generation cost or prompt-complexity variance. Every VU
// sends the exact same tiny request so throughput differences are
// attributable to server-side concurrency handling, not payload variance.
const PAYLOAD = JSON.stringify({
  model: 'auto', // forces the intelligent-selection path (collectModelCandidates / scoreAllProviders)
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 1,
  stream: false,
});

const PARAMS = {
  headers: {
    'x-api-key': TEST_API_KEY,
    'Content-Type': 'application/json',
  },
  tags: { name: 'phase1_scoring_hot_path' },
  timeout: '15s',
};

export default function () {
  const start = Date.now();
  const res = http.post(`${BASE_URL}/v1/chat/completions`, PAYLOAD, PARAMS);
  const latency = Date.now() - start;
  scoringLatency.add(latency);

  const ok = check(res, {
    'status is 200 or 202': (r) => r.status === 200 || r.status === 202,
  });

  if (ok) {
    completedRequests.add(1);
  } else {
    scoringErrorRate.add(1);
  }
  // No sleep() — sustained concurrent pressure is the point of this test.
}

export function setup() {
  console.log('Phase 1 scoring hot-path load test');
  console.log(`  Target: ${BASE_URL}`);
  console.log('  Acceptance criterion (PR #135): ~40-200 -> >=1000 req/s/replica');
  console.log('  See file header for isolated-mode (stub provider) instructions.');

  const health = http.get(`${BASE_URL}/health`);
  if (health.status !== 200) {
    throw new Error(`API not healthy: ${health.status}`);
  }
}

export function teardown() {
  console.log('Phase 1 scoring hot-path load test complete.');
  console.log('Compare this run\'s sustained-stage http_reqs rate against a pre-#135 baseline run.');
}
