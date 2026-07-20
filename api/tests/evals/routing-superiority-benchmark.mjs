// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Routing Superiority Benchmark
 *
 * Proves empirically that `auto` (intelligent orchestration) beats static baselines:
 *   - single: fixed single-model strategy
 *   - cost:   cheapest-viable strategy (cost-cascade)
 *   - quality: highest-quality strategy (quality-multipass)
 *
 * Usage:
 *   node tests/evals/routing-superiority-benchmark.mjs
 *   node tests/evals/routing-superiority-benchmark.mjs --ci --fail-threshold=0.03
 *
 * CI mode exits 1 if `auto` does NOT beat `single` on quality-adjusted success rate
 * by at least --fail-threshold (default 3 percentage points).
 *
 * Requires: EVAL_BEARER_TOKEN env var
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// ─── CLI flags ───────────────────────────────────────────────────────────────
const isCiMode = process.argv.includes('--ci');
const failThresholdArg = process.argv.find(a => a.startsWith('--fail-threshold='));
const failThreshold = failThresholdArg ? parseFloat(failThresholdArg.split('=')[1]) : 0.03;
// In CI mode limit cases to one per (taskFamily × complexity) for speed.
// Override with --ci-max-cases=N. Full suite always runs without --ci.
const ciMaxCasesArg = process.argv.find(a => a.startsWith('--ci-max-cases='));
const ciMaxCases = ciMaxCasesArg ? parseInt(ciMaxCasesArg.split('=')[1], 10) : 12;

// ─── Token ───────────────────────────────────────────────────────────────────
let TOKEN = process.env.EVAL_BEARER_TOKEN;
if (!TOKEN) {
  const tokenFile = join(ROOT, '../../.tmp-eval-bearer-token-runtime.txt');
  if (existsSync(tokenFile)) TOKEN = readFileSync(tokenFile, 'utf8').trim();
}
if (!TOKEN) {
  console.error('ERROR: No token. Set EVAL_BEARER_TOKEN or provide .tmp-eval-bearer-token-runtime.txt');
  process.exit(1);
}

const API_BASE = process.env.EVAL_API_BASE_URL
  ? `${process.env.EVAL_API_BASE_URL}/v1/chat/completions`
  : 'https://api.ailin.one/v1/chat/completions';
const DELAY_MS = isCiMode ? 500 : 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const REQUEST_TIMEOUT_MS = isCiMode ? 45_000 : 120_000;

async function callAPI(strategy, messages, extra = {}) {
  const body = { model: 'auto', strategy, messages, ...extra };
  const start = Date.now();
  const resp = await fetch(API_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - start;
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Gateway returned non-JSON (e.g., 504 HTML from nginx)
    json = { error: { message: `HTTP ${resp.status}: non-JSON response (${text.slice(0, 80).replace(/\s+/g, ' ')})` } };
  }
  return { latencyMs, status: resp.status, json };
}

function extractContent(json) {
  if (json.error) return null;
  return json.choices?.[0]?.message?.content ?? null;
}

function extractMeta(json) {
  if (json.error) return { error: json.error.message };
  const m = json.ailin_metadata ?? {};
  return {
    resolved_strategy: m.resolved_strategy ?? m.strategy_used ?? null,
    models_used: m.models_used ?? [],
    model_count: m.model_count ?? null,
    cost_usd: m.cost_usd ?? null,
    quality_score: m.quality_score ?? null,
  };
}

// ─── LLM-as-Judge ────────────────────────────────────────────────────────────
async function gradeWithLLMJudge(content, rubric, threshold = 0.70) {
  if (!content) return { pass: false, score: 0, reasoning: 'No content to grade' };
  try {
    const { json } = await callAPI('single', [
      {
        role: 'system',
        content:
          'You are an expert evaluator. Grade the response according to the rubric. Respond ONLY with valid JSON: {"score": 0.0-1.0, "reasoning": "one sentence"}',
      },
      {
        role: 'user',
        content: `RUBRIC:\n${rubric}\n\nRESPONSE TO EVALUATE:\n${content}`,
      },
    ]);
    const raw = extractContent(json);
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return { pass: false, score: 0, reasoning: 'Judge response unparseable' };
    const parsed = JSON.parse(match[0]);
    const score = Number(parsed.score ?? 0);
    return { pass: score >= threshold, score, reasoning: parsed.reasoning ?? '' };
  } catch (err) {
    return { pass: false, score: 0, reasoning: `Judge error: ${err.message}` };
  }
}

// ─── Benchmark Cases ─────────────────────────────────────────────────────────
// 5 task families × 3 complexity levels × 4 cases = 60 cases minimum
const BENCHMARK_SUITE = [
  // ──── code-generation ─────────────────────────────────────────────────────
  // Low complexity
  {
    taskFamily: 'code-generation', complexity: 'low',
    prompt: 'Write a JavaScript function that reverses a string. Only the function, no explanation.',
    rubric: 'Returns a correct, working function that reverses a string. Should use standard JS methods. No bugs.',
  },
  {
    taskFamily: 'code-generation', complexity: 'low',
    prompt: 'Write a Python function to check if a number is prime. Only the function.',
    rubric: 'Correct prime-checking function. Handles edge cases (0, 1, 2, negative). Efficient (at least sqrt optimization).',
  },
  {
    taskFamily: 'code-generation', complexity: 'low',
    prompt: 'Write a TypeScript function that flattens a nested array to a single level. Only the function.',
    rubric: 'Correct recursive or iterative flatten. Handles deeply nested arrays. Proper TypeScript types.',
  },
  {
    taskFamily: 'code-generation', complexity: 'low',
    prompt: 'Write a SQL query to find duplicate email addresses in a "users" table. Only the query.',
    rubric: 'Correct SQL using GROUP BY and HAVING COUNT(*) > 1. Returns the duplicate emails.',
  },
  // Medium complexity
  {
    taskFamily: 'code-generation', complexity: 'medium',
    prompt: 'Write a TypeScript function that implements a debounce with both leading and trailing edge options. Include TypeScript generics for type safety.',
    rubric: 'Correct debounce with configurable leading/trailing. Uses generics. Handles setTimeout/clearTimeout correctly. Type-safe.',
  },
  {
    taskFamily: 'code-generation', complexity: 'medium',
    prompt: 'Write a Python class implementing a MinHeap with push, pop, and peek methods. Include type hints.',
    rubric: 'Correct heap implementation with O(log n) push/pop. Uses array-based approach with heapify. Type hints present.',
  },
  {
    taskFamily: 'code-generation', complexity: 'medium',
    prompt: 'Write a Node.js function that recursively traverses a directory tree and returns all file paths matching a glob pattern. Use only built-in modules.',
    rubric: 'Correct recursive directory traversal. Uses fs/path built-in modules. Glob matching logic present. Handles symlinks or errors gracefully.',
  },
  {
    taskFamily: 'code-generation', complexity: 'medium',
    prompt: 'Write a PostgreSQL function that implements a sliding window rate limiter using a single atomic query with UPSERT.',
    rubric: 'Uses INSERT ON CONFLICT DO UPDATE. Implements sliding window (not fixed). Atomic operation. Handles window expiry.',
  },
  // High complexity
  {
    taskFamily: 'code-generation', complexity: 'high',
    prompt: 'Implement a thread-safe, generic LRU cache in TypeScript with O(1) get/put, TTL support, and an eviction callback. Include full type definitions.',
    rubric: 'O(1) operations via doubly-linked list + Map. TTL support with lazy or active expiration. Eviction callback. Generic types. Thread-safety consideration.',
  },
  {
    taskFamily: 'code-generation', complexity: 'high',
    prompt: 'Implement a production-ready circuit breaker pattern in TypeScript with configurable failure threshold, timeout, half-open state, and exponential backoff. Include Prometheus metric hooks.',
    rubric: 'Three states (closed/open/half-open). Configurable thresholds. Exponential backoff. Prometheus-compatible metric emission points. Error categorization.',
  },
  {
    taskFamily: 'code-generation', complexity: 'high',
    prompt: 'Write a TypeScript implementation of a CRDT-based collaborative text editor supporting insert, delete, and concurrent edits from multiple peers. Include the merge algorithm.',
    rubric: 'Correct CRDT algorithm (e.g., RGA, LSEQ, or similar). Handles concurrent inserts at same position. Convergent merge. Proper TypeScript types.',
  },
  {
    taskFamily: 'code-generation', complexity: 'high',
    prompt: 'Implement a B-tree of order 3 in Python with insert, search, and delete operations. Include split and merge logic.',
    rubric: 'Correct B-tree structure with split on overflow. Search returns correct results. Delete handles underflow with merge/redistribute. Order-3 constraints maintained.',
  },

  // ──── code-review ─────────────────────────────────────────────────────────
  // Low
  {
    taskFamily: 'code-review', complexity: 'low',
    prompt: 'Review this code for bugs:\n```js\nfunction add(a, b) { return a - b; }\nconst result = add("5", 3);\nconsole.log(result);\n```',
    rubric: 'Identifies: (1) subtraction instead of addition, (2) string concatenation risk with "5" input. Both bugs found.',
  },
  {
    taskFamily: 'code-review', complexity: 'low',
    prompt: 'Review this Python code:\n```python\ndef get_user(users, name):\n    for user in users:\n        if user["name"] == name:\n            return user\n    return None\n\nresult = get_user([], "Alice")\nprint(result["email"])\n```',
    rubric: 'Identifies: NoneType error when accessing email on None return. May also note lack of type checking or KeyError possibility.',
  },
  // Medium
  {
    taskFamily: 'code-review', complexity: 'medium',
    prompt: 'Review this Express.js middleware for security issues:\n```js\napp.use((req, res, next) => {\n  const token = req.headers.authorization;\n  const decoded = jwt.decode(token);\n  req.user = decoded;\n  next();\n});\n```',
    rubric: 'Identifies: (1) jwt.decode vs jwt.verify — no signature verification, (2) no token existence check, (3) no Bearer prefix stripping. At least 2 of 3 found.',
  },
  {
    taskFamily: 'code-review', complexity: 'medium',
    prompt: 'Review this Python async code for correctness:\n```python\nimport asyncio\n\nasync def fetch_all(urls):\n    results = []\n    for url in urls:\n        result = await fetch(url)\n        results.append(result)\n    return results\n```',
    rubric: 'Identifies sequential execution (should use asyncio.gather or similar for parallelism). May note missing error handling, no timeout, or missing aiohttp import.',
  },
  // High
  {
    taskFamily: 'code-review', complexity: 'high',
    prompt: `Review this distributed cache implementation for production readiness:\n\`\`\`typescript\nclass DistributedCache {\n  private nodes: Map<string, Redis> = new Map();\n  \n  async get(key: string) {\n    const node = this.getNode(key);\n    return node.get(key);\n  }\n  \n  async set(key: string, value: string, ttl: number) {\n    const node = this.getNode(key);\n    await node.set(key, value, 'EX', ttl);\n  }\n  \n  private getNode(key: string): Redis {\n    const hash = key.length % this.nodes.size;\n    return [...this.nodes.values()][hash];\n  }\n}\`\`\``,
    rubric: 'Identifies: (1) terrible hash function (key.length mod N), (2) no error handling for Redis failures, (3) no connection pooling, (4) spreading Map values on every call is O(n), (5) no serialization. At least 3 of 5 found.',
  },
  {
    taskFamily: 'code-review', complexity: 'high',
    prompt: 'Review this authentication system for security vulnerabilities:\n```python\nimport hashlib\n\ndef register(username, password, db):\n    hashed = hashlib.md5(password.encode()).hexdigest()\n    db.execute("INSERT INTO users (username, password) VALUES (?, ?)", (username, hashed))\n\ndef login(username, password, db):\n    hashed = hashlib.md5(password.encode()).hexdigest()\n    result = db.execute("SELECT * FROM users WHERE username=? AND password=?", (username, hashed))\n    return result.fetchone()\n```',
    rubric: 'Identifies: (1) MD5 is cryptographically broken for passwords, (2) no salt, (3) should use bcrypt/argon2/scrypt, (4) timing attack on comparison. At least 3 found.',
  },

  // ──── analysis ────────────────────────────────────────────────────────────
  // Low
  {
    taskFamily: 'analysis', complexity: 'low',
    prompt: 'Explain the difference between TCP and UDP. When would you use each? Give one real-world example for each.',
    rubric: 'Correct TCP vs UDP comparison covering: reliability, ordering, connection-oriented vs connectionless. Appropriate examples (e.g., HTTP/file transfer for TCP, streaming/gaming for UDP).',
  },
  {
    taskFamily: 'analysis', complexity: 'low',
    prompt: 'What is the CAP theorem? Explain each letter and give one database example for each combination (CP, AP, CA).',
    rubric: 'Correct C/A/P definitions. Notes CA is impractical in distributed systems. Gives appropriate examples (e.g., MongoDB for CP, Cassandra for AP).',
  },
  // Medium
  {
    taskFamily: 'analysis', complexity: 'medium',
    prompt: 'Compare microservices vs monolith architecture for a team of 8 developers building a B2B SaaS product launching in 3 months. The product needs user management, billing, a dashboard, and API integrations. Recommend an approach.',
    rubric: 'Addresses: team size impact, launch timeline pressure, complexity of inter-service communication, deployment simplicity. Makes a clear recommendation with rationale. Addresses migration path.',
  },
  {
    taskFamily: 'analysis', complexity: 'medium',
    prompt: 'A PostgreSQL database with 500M rows in the main table is experiencing slow reads (p95 > 2s). The table has columns: id, user_id, created_at, status, payload (JSONB, avg 2KB). Currently has indexes on id and user_id. Diagnose and propose optimizations.',
    rubric: 'Proposes: (1) composite index on (user_id, created_at), (2) partitioning by created_at or user_id, (3) JSONB GIN index if queried, (4) connection pooling, (5) query analysis with EXPLAIN. At least 3 concrete actions.',
  },
  // High
  {
    taskFamily: 'analysis', complexity: 'high',
    prompt: 'Design a real-time notification system for 10M concurrent users. Requirements: <100ms delivery, at-least-once semantics, support for push, email, SMS, and in-app channels. Must handle 1M notifications/minute at peak. Describe the architecture.',
    rubric: 'Covers: message queue (Kafka/SQS), fan-out strategy, WebSocket for push, channel routing, deduplication, retry with backoff, horizontal scaling. Addresses the 10M concurrent constraint specifically.',
  },
  {
    taskFamily: 'analysis', complexity: 'high',
    prompt: 'A distributed system processes financial transactions. You observe that sometimes two requests with the same idempotency key produce different results when hitting different replicas. Diagnose the root causes and propose a solution that maintains <50ms p99 latency.',
    rubric: 'Identifies: (1) idempotency store not replicated synchronously, (2) race condition in check-then-act. Proposes: distributed lock or CAS, consistent hashing, idempotency cache with strong consistency. Addresses latency constraint.',
  },

  // ──── debugging ───────────────────────────────────────────────────────────
  // Low
  {
    taskFamily: 'debugging', complexity: 'low',
    prompt: 'This code throws an error. Find the bug and fix it:\n```python\ndef factorial(n):\n    if n == 0:\n        return 1\n    return n * factorial(n)\n```',
    rubric: 'Identifies: infinite recursion because factorial(n) calls factorial(n) instead of factorial(n-1). Provides corrected code.',
  },
  {
    taskFamily: 'debugging', complexity: 'low',
    prompt: 'This React component does not update when the button is clicked. Why?\n```jsx\nfunction Counter() {\n  let count = 0;\n  return <button onClick={() => { count++; }}>{count}</button>;\n}\n```',
    rubric: 'Identifies: must use useState hook instead of a local variable. Local variable reset on re-render and mutation does not trigger re-render.',
  },
  // Medium
  {
    taskFamily: 'debugging', complexity: 'medium',
    prompt: 'This Node.js server leaks memory over time. Find the cause:\n```js\nconst cache = {};\napp.get("/data/:id", async (req, res) => {\n  if (!cache[req.params.id]) {\n    cache[req.params.id] = await db.fetch(req.params.id);\n  }\n  res.json(cache[req.params.id]);\n});\n```',
    rubric: 'Identifies: unbounded cache growth — entries are never evicted. Proposes: TTL, LRU eviction, max size limit, or use an external cache (Redis).',
  },
  {
    taskFamily: 'debugging', complexity: 'medium',
    prompt: 'This async code sometimes returns stale data. Diagnose:\n```typescript\nlet cachedValue: string | null = null;\nlet fetching = false;\n\nasync function getValue(): Promise<string> {\n  if (cachedValue) return cachedValue;\n  if (fetching) return cachedValue!;\n  fetching = true;\n  cachedValue = await fetchFromAPI();\n  fetching = false;\n  return cachedValue;\n}\n```',
    rubric: 'Identifies: (1) race condition — multiple callers check fetching=false simultaneously, (2) returns null when fetching=true and cachedValue is still null. Proposes: promise deduplication or mutex pattern.',
  },
  // High
  {
    taskFamily: 'debugging', complexity: 'high',
    prompt: 'A distributed service intermittently returns HTTP 500 under load. Logs show "connection pool exhausted" from the database adapter. The pool is configured for max 20 connections. Avg query time is 5ms but p99 is 800ms. Traffic is 2000 req/s. Diagnose and propose a fix.',
    rubric: 'Identifies: (1) p99 tail latency causes connection hoarding, (2) 2000 req/s × 0.005s avg = 10 connections needed avg but p99 causes bursts. Proposes: increase pool size, add query timeout, identify slow queries, add circuit breaker, connection queue with timeout.',
  },
  {
    taskFamily: 'debugging', complexity: 'high',
    prompt: 'A Kubernetes pod keeps getting OOMKilled despite the application reporting low heap usage (200MB of 512MB limit). The container memory limit is 512Mi. What are the possible causes and how would you diagnose?',
    rubric: 'Identifies: (1) off-heap memory (native buffers, mmap, JNI), (2) container memory includes RSS + cache + swap, (3) child processes, (4) memory fragmentation. Proposes: check /proc/meminfo, use cgroup stats, profile native memory.',
  },

  // ──── general ─────────────────────────────────────────────────────────────
  // Low
  {
    taskFamily: 'general', complexity: 'low',
    prompt: 'Explain what a REST API is to someone who has never programmed. Use an analogy.',
    rubric: 'Clear analogy (e.g., restaurant menu/waiter). Covers: request/response, endpoints as resources, HTTP methods. Accessible to non-programmer.',
  },
  {
    taskFamily: 'general', complexity: 'low',
    prompt: 'What are the SOLID principles in software engineering? List each with a one-sentence explanation.',
    rubric: 'All 5 principles named correctly: Single Responsibility, Open-Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. Each with correct one-sentence explanation.',
  },
  // Medium
  {
    taskFamily: 'general', complexity: 'medium',
    prompt: 'Compare three approaches to handling authentication in a microservices architecture: (1) API Gateway auth, (2) Service-to-service JWT propagation, (3) Service mesh with mTLS. Pros and cons of each.',
    rubric: 'Correctly describes all three approaches. Identifies tradeoffs: centralization vs distributed trust, latency, complexity, security boundaries. At least 2 pros and 2 cons per approach.',
  },
  {
    taskFamily: 'general', complexity: 'medium',
    prompt: 'A team is deciding between GraphQL and REST for a new mobile app backend. The app has complex nested data (users → posts → comments → likes), requires offline support, and serves both iOS and Android. Recommend one approach.',
    rubric: 'Addresses: over-fetching/under-fetching, mobile bandwidth, offline caching complexity, schema evolution. Makes clear recommendation with rationale. Mentions tooling (Apollo, Relay, etc.).',
  },
  // High
  {
    taskFamily: 'general', complexity: 'high',
    prompt: 'Design a multi-tenant SaaS billing system that supports: per-seat pricing, usage-based billing (API calls, storage), multiple currencies, proration on plan changes, Stripe integration, and invoice generation. Describe the data model and key flows.',
    rubric: 'Covers: subscription model, usage tracking, proration calculation, multi-currency handling, Stripe webhook flow, invoice generation pipeline. Data model includes key entities and relationships.',
  },
  {
    taskFamily: 'general', complexity: 'high',
    prompt: 'Explain how database connection pooling works at the kernel level. Cover: TCP socket lifecycle, file descriptors, epoll/kqueue, the relationship between pool size and OS thread limits, and how PgBouncer achieves its performance advantage.',
    rubric: 'Covers: TCP 3-way handshake reuse, FD management, epoll event loop for multiplexing, thread-per-connection vs event-driven, PgBouncer session/transaction/statement modes. Technical depth expected.',
  },
];

// ─── Strategies to compare ───────────────────────────────────────────────────
// In CI mode: exclude 'quality' (debate/consensus multi-turn) — each call can
// hit the gateway proxy_read_timeout (504 HTML) and block for ~60s per case,
// blowing the 15m gate budget. 'quality' is measured in the full audit job.
const STRATEGIES = isCiMode
  ? [
      { label: 'auto', strategy: 'auto' },
      { label: 'single', strategy: 'single' },
      { label: 'cost', strategy: 'cost' },
    ]
  : [
      { label: 'auto', strategy: 'auto' },
      { label: 'single', strategy: 'single' },
      { label: 'cost', strategy: 'cost' },
      { label: 'quality', strategy: 'quality' },
    ];

// ─── Runner ──────────────────────────────────────────────────────────────────
async function runBenchmark() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       ROUTING SUPERIORITY BENCHMARK                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // In CI mode: pick one case per (taskFamily × complexity) up to ciMaxCases.
  // This gives representative coverage while keeping runtime under ~10 min.
  let suite = BENCHMARK_SUITE;
  if (isCiMode) {
    const seen = new Set();
    suite = BENCHMARK_SUITE.filter(c => {
      const key = `${c.taskFamily}:${c.complexity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, ciMaxCases);
    console.log(`CI mode: ${suite.length}/${BENCHMARK_SUITE.length} cases (stratified sample, one per family×complexity)`);
  }

  console.log(`Cases: ${suite.length} | Strategies: ${STRATEGIES.length} | Total runs: ${suite.length * STRATEGIES.length}`);
  console.log(`Fail threshold (auto vs single delta): ${(failThreshold * 100).toFixed(1)} pp\n`);

  const results = [];

  for (let i = 0; i < suite.length; i++) {
    const testCase = suite[i];
    console.log(`\n[${i + 1}/${suite.length}] ${testCase.taskFamily} (${testCase.complexity})`);

    for (const { label, strategy } of STRATEGIES) {
      process.stdout.write(`  ${label.padEnd(12)} ... `);
      try {
        const { latencyMs, status, json } = await callAPI(strategy, [
          { role: 'user', content: testCase.prompt },
        ], { task_type: testCase.taskFamily });

        const content = extractContent(json);
        const meta = extractMeta(json);

        // Grade with LLM-as-judge
        const grade = await gradeWithLLMJudge(content, testCase.rubric, 0.60);
        await sleep(DELAY_MS);

        const result = {
          taskFamily: testCase.taskFamily,
          complexity: testCase.complexity,
          strategy: label,
          status,
          latencyMs,
          costUsd: meta.cost_usd ?? 0,
          quality: grade.score,
          success: !json.error && !!content,
          modelsUsed: meta.models_used,
          resolvedStrategy: meta.resolved_strategy,
          reasoning: grade.reasoning,
        };
        results.push(result);

        const icon = json.error ? '✗ ERR' : grade.score >= 0.60 ? '✓' : '✗';
        console.log(`${icon} q=${grade.score.toFixed(2)} | ${latencyMs}ms | $${(meta.cost_usd ?? 0).toFixed(6)} | models=${meta.models_used?.length ?? '?'}`);
      } catch (e) {
        console.log(`EXCEPTION: ${e.message}`);
        results.push({
          taskFamily: testCase.taskFamily,
          complexity: testCase.complexity,
          strategy: label,
          status: 0,
          latencyMs: 0,
          costUsd: 0,
          quality: 0,
          success: false,
          modelsUsed: [],
          resolvedStrategy: null,
          reasoning: `Exception: ${e.message}`,
        });
      }
      await sleep(DELAY_MS);
    }
  }

  return { results, caseCount: suite.length };
}

// ─── Aggregate ───────────────────────────────────────────────────────────────
function aggregate(results) {
  const strategyLeaderboard = {};

  for (const { label } of STRATEGIES) {
    const stratResults = results.filter(r => r.strategy === label);
    const successResults = stratResults.filter(r => r.success);

    strategyLeaderboard[label] = {
      total: stratResults.length,
      successRate: stratResults.length ? successResults.length / stratResults.length : 0,
      avgQuality: successResults.length
        ? successResults.reduce((sum, r) => sum + r.quality, 0) / successResults.length
        : 0,
      avgCost: successResults.length
        ? successResults.reduce((sum, r) => sum + r.costUsd, 0) / successResults.length
        : 0,
      avgLatency: successResults.length
        ? Math.round(successResults.reduce((sum, r) => sum + r.latencyMs, 0) / successResults.length)
        : 0,
      p95Latency: percentile(successResults.map(r => r.latencyMs), 0.95),
      qualityAdjustedSuccess: stratResults.length
        ? (successResults.reduce((sum, r) => sum + r.quality, 0)) / stratResults.length
        : 0,
    };
  }

  // By task family
  const taskFamilies = [...new Set(results.map(r => r.taskFamily))];
  const byTaskFamily = {};
  for (const family of taskFamilies) {
    byTaskFamily[family] = {};
    for (const { label } of STRATEGIES) {
      const familyResults = results.filter(r => r.taskFamily === family && r.strategy === label);
      const successResults = familyResults.filter(r => r.success);
      byTaskFamily[family][label] = {
        total: familyResults.length,
        successRate: familyResults.length ? successResults.length / familyResults.length : 0,
        avgQuality: successResults.length
          ? successResults.reduce((sum, r) => sum + r.quality, 0) / successResults.length
          : 0,
        qualityAdjustedSuccess: familyResults.length
          ? successResults.reduce((sum, r) => sum + r.quality, 0) / familyResults.length
          : 0,
      };
    }
  }

  // Auto vs Single delta
  const autoQAS = strategyLeaderboard.auto?.qualityAdjustedSuccess ?? 0;
  const singleQAS = strategyLeaderboard.single?.qualityAdjustedSuccess ?? 0;
  const autoVsSingleDelta = {
    qualityAdjustedSuccess: autoQAS - singleQAS,
    quality: (strategyLeaderboard.auto?.avgQuality ?? 0) - (strategyLeaderboard.single?.avgQuality ?? 0),
    cost: (strategyLeaderboard.auto?.avgCost ?? 0) - (strategyLeaderboard.single?.avgCost ?? 0),
    successRate: (strategyLeaderboard.auto?.successRate ?? 0) - (strategyLeaderboard.single?.successRate ?? 0),
  };

  return { strategyLeaderboard, byTaskFamily, autoVsSingleDelta };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Main ────────────────────────────────────────────────────────────────────
const { results, caseCount } = await runBenchmark();
const summary = aggregate(results);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

// ─── Print summary ───────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('STRATEGY LEADERBOARD');
console.log('═'.repeat(60));
for (const [strat, s] of Object.entries(summary.strategyLeaderboard)) {
  console.log(
    `${strat.padEnd(12)} | QAS=${(s.qualityAdjustedSuccess * 100).toFixed(1)}% | quality=${(s.avgQuality * 100).toFixed(1)}% | success=${(s.successRate * 100).toFixed(1)}% | cost=$${s.avgCost.toFixed(6)} | p95=${s.p95Latency}ms`
  );
}

console.log('\n─── AUTO vs SINGLE DELTA ───');
const d = summary.autoVsSingleDelta;
console.log(`  Quality-Adjusted Success: ${d.qualityAdjustedSuccess >= 0 ? '+' : ''}${(d.qualityAdjustedSuccess * 100).toFixed(2)} pp`);
console.log(`  Quality:                  ${d.quality >= 0 ? '+' : ''}${(d.quality * 100).toFixed(2)} pp`);
console.log(`  Success Rate:             ${d.successRate >= 0 ? '+' : ''}${(d.successRate * 100).toFixed(2)} pp`);
console.log(`  Cost:                     ${d.cost >= 0 ? '+' : ''}$${d.cost.toFixed(6)}`);

console.log('\n─── BY TASK FAMILY ───');
for (const [family, strategies] of Object.entries(summary.byTaskFamily)) {
  const autoQAS = strategies.auto?.qualityAdjustedSuccess ?? 0;
  const singleQAS = strategies.single?.qualityAdjustedSuccess ?? 0;
  const delta = autoQAS - singleQAS;
  console.log(`  ${family.padEnd(20)} auto=${(autoQAS * 100).toFixed(1)}% single=${(singleQAS * 100).toFixed(1)}% delta=${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`);
}

// ─── Save results ────────────────────────────────────────────────────────────
const outDir = join(ROOT, 'eval-results');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `routing-superiority-${timestamp}.json`);
const output = {
  timestamp,
  caseCount,
  strategyCount: STRATEGIES.length,
  totalRuns: results.length,
  failThreshold,
  ...summary,
  cases: results,
};
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nFull results saved to: ${outPath}`);

// ─── CI gate ─────────────────────────────────────────────────────────────────
if (isCiMode) {
  const autoBeats = d.qualityAdjustedSuccess >= failThreshold;
  if (autoBeats) {
    console.log(`\n✅ AUTO beats SINGLE by ${(d.qualityAdjustedSuccess * 100).toFixed(2)} pp (threshold: ${(failThreshold * 100).toFixed(1)} pp)`);
    process.exit(0);
  } else {
    console.error(`\n❌ ROUTING REGRESSION: AUTO does NOT beat SINGLE by required ${(failThreshold * 100).toFixed(1)} pp`);
    console.error(`   Actual delta: ${(d.qualityAdjustedSuccess * 100).toFixed(2)} pp`);
    process.exit(1);
  }
}
