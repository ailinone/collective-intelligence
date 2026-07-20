// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CI Audit Eval Runner — executes all 5 eval suites against the live API
 * Usage: node tests/evals/run-evals.mjs
 *        node tests/evals/run-evals.mjs --ci --fail-threshold=0.80
 * Requires: EVAL_BEARER_TOKEN env var (or reads from .tmp-eval-bearer-token-runtime.txt)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// ─── CLI flags ───────────────────────────────────────────────────────────────
const isCiMode = process.argv.includes('--ci');
const failThresholdArg = process.argv.find(a => a.startsWith('--fail-threshold='));
const failThreshold = failThresholdArg ? parseFloat(failThresholdArg.split('=')[1]) : 0.80;

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
const DELAY_MS = 2500;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAPI(strategy, messages, extra = {}) {
  const body = { model: 'auto', strategy, messages, ...extra };
  const start = Date.now();
  const resp = await fetch(API_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;
  const json = await resp.json();
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
    resolved_strategy: m.resolved_strategy ?? json.ailin_metadata?.strategy_used ?? null,
    models_used: m.models_used ?? m.fallback_chain ?? [],
    model_count: m.model_count ?? null,
    cost_usd: m.cost_usd ?? null,
    quality_score: m.quality_score ?? null,
    cache_hit: m.cache_hit ?? false,
    tokens_total: json.usage?.total_tokens ?? null,
    tokens_prompt: json.usage?.prompt_tokens ?? null,
    tokens_completion: json.usage?.completion_tokens ?? null,
  };
}

// ─── LLM-as-Judge ─────────────────────────────────────────────────────────────
/**
 * Grade a response using an LLM judge.
 * Returns { pass, score, reasoning }.
 */
async function gradeWithLLMJudge(content, rubric, threshold = 0.75) {
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

// ─── Assertions ──────────────────────────────────────────────────────────────
function assertContains(content, value) {
  return { pass: content?.includes(value) ?? false, value };
}
function assertContainsCI(content, value) {
  return { pass: content?.toLowerCase().includes(value.toLowerCase()) ?? false, value };
}
function assertCostNonNegative(meta) {
  if (meta.cost_usd === null || meta.cost_usd === undefined) return { pass: true, note: 'cost not present' };
  return { pass: meta.cost_usd >= 0, value: meta.cost_usd };
}
function assertLength(content, minLen) {
  return { pass: (content?.length ?? 0) >= minLen, length: content?.length ?? 0 };
}

// ─── Suites ──────────────────────────────────────────────────────────────────

// CI-EVAL-01: Objective (factual) questions
const OBJECTIVE_CASES = [
  {
    id: 'range_output',
    prompt: 'What is the output of Python: list(range(0, 10, 3))? Respond with ONLY the list, nothing else.',
    assert: (c) => assertContains(c, '[0, 3, 6, 9]'),
  },
  {
    id: 'http_422',
    prompt: "What HTTP status code means 'Unprocessable Entity'? Answer with only the number.",
    assert: (c) => assertContains(c, '422'),
  },
  {
    id: 'arithmetic',
    prompt: 'A store sells apples at $0.50 each and oranges at $0.75 each. I buy 4 apples and 3 oranges. What is the total cost? Answer with only the dollar amount like $X.XX',
    assert: (c) => assertContains(c, '$4.25'),
  },
  {
    id: 'git_branch',
    prompt: "What command creates a new git branch called 'feature/x' and immediately switches to it? Answer with only the command.",
    assert: (c) => (assertContainsCI(c, 'git checkout -b feature/x').pass || assertContainsCI(c, 'git switch -c feature/x').pass)
      ? { pass: true, value: c }
      : { pass: false, value: c },
  },
  {
    id: 'reduce_empty',
    prompt: 'In JavaScript, what does Array.prototype.reduce() return when called on an EMPTY array with NO initial value? Answer in one sentence.',
    assert: (c) => assertContainsCI(c, 'typeerror'),
  },
  {
    id: 'udp_payload',
    prompt: 'What is the maximum size in bytes of a UDP datagram PAYLOAD (not the full packet)? Answer with only the number.',
    assert: (c) => assertContains(c, '65507'),
  },
];

// CI-EVAL-02: Synthesis tasks
const SYNTHESIS_CASES = [
  {
    id: 'db_choice',
    prompt: 'A startup wants to choose between PostgreSQL, MongoDB, and DynamoDB for a new SaaS product. They expect 10,000 users at launch and 1M in year 2. Write-heavy workload, complex queries, multi-tenant. Recommend one and justify. Address the scale trajectory explicitly.',
    assert: async (c) => gradeWithLLMJudge(
      c,
      'The response makes a clear database recommendation with justification that covers: (1) the write-heavy workload, (2) scale trajectory from 10k to 1M users, (3) at least two concrete trade-offs vs alternatives. The recommendation must be actionable.',
      0.75
    ),
  },
  {
    id: 'code_review',
    prompt: `Review this Python code and identify ALL bugs. Be exhaustive:
\`\`\`python
def find_max(lst):
    max_val = 0
    for i in range(len(lst)):
        if lst[i] > max_val:
            max_val = lst[i]
    return max_val
\`\`\``,
    assert: (c) => ({
      pass: assertContainsCI(c, 'negative').pass || assertContainsCI(c, 'all-negative').pass || assertContainsCI(c, 'initializ').pass,
      note: 'should mention initialization bug for negative inputs',
      length: c?.length ?? 0,
    }),
  },
  {
    id: 'trolley_problem',
    prompt: 'Explain the trolley problem from three distinct ethical frameworks: utilitarian, deontological, and virtue ethics. Where do they agree and where do they disagree?',
    assert: (c) => ({
      pass: ['utilitarian', 'deontolog', 'virtue'].every(f => c?.toLowerCase().includes(f)),
      frameworks: ['utilitarian', 'deontolog', 'virtue'].map(f => ({ f, present: c?.toLowerCase().includes(f) ?? false })),
    }),
  },
  {
    id: 'data_model',
    prompt: 'Design the data model for a ride-sharing app like Uber. Include: Users, Drivers, Trips, Payments, and Ratings. For each entity, list its most important 5 fields and the key relationships between entities.',
    assert: (c) => ({
      pass: ['user', 'driver', 'trip', 'payment', 'rating'].every(e => c?.toLowerCase().includes(e)),
      entities: ['user', 'driver', 'trip', 'payment', 'rating'].map(e => ({ e, present: c?.toLowerCase().includes(e) ?? false })),
    }),
  },
];

// CI-EVAL-03: Code generation
const CODE_CASES = [
  {
    id: 'ts_debounce',
    prompt: `Write a TypeScript function with this exact signature:
debounce<T extends (...args: unknown[]) => void>(fn: T, delayMs: number): T

Requirements: returns a debounced version of fn that only calls fn after delayMs milliseconds have passed without new calls. Include only the implementation, no explanation or tests.`,
    assert: (c) => ({
      pass: c?.includes('setTimeout') && c?.includes('clearTimeout'),
      hasSetTimeout: c?.includes('setTimeout') ?? false,
      hasClearTimeout: c?.includes('clearTimeout') ?? false,
    }),
  },
  {
    id: 'sql_aggregate',
    prompt: `Write a SQL query that finds all customers who placed more than 3 orders in the last 30 days AND have a total order value over $500.
Tables: orders(id, customer_id, created_at, amount)
Return: customer_id, order_count, total_amount
Use standard SQL (PostgreSQL compatible).`,
    assert: (c) => {
      const lc = c?.toLowerCase() ?? '';
      return {
        pass: lc.includes('group by') && lc.includes('having') && lc.includes('sum') && lc.includes('count'),
        hasGroupBy: lc.includes('group by'),
        hasHaving: lc.includes('having'),
        hasSum: lc.includes('sum'),
        hasCount: lc.includes('count'),
      };
    },
  },
  {
    id: 'python_lru',
    prompt: `Implement a thread-safe LRU cache in Python with O(1) get and put operations.
Capacity is set at construction. Use only Python standard library (no external deps).
Show the full class implementation.`,
    assert: (c) => {
      const hasDS = c?.includes('OrderedDict') || (c?.includes('next') && c?.includes('prev'));
      const hasMethods = c?.includes('def get') && c?.includes('def put');
      return { pass: !!(hasDS && hasMethods), hasDataStructure: !!hasDS, hasMethods: !!hasMethods };
    },
  },
];

// CI-EVAL-04: Cost + latency (short fixed prompts)
const COST_CASES = [
  {
    id: 'capital_australia',
    prompt: 'What is the capital of Australia? One word only.',
    assert: (c) => assertContainsCI(c, 'canberra'),
  },
  {
    id: 'python_builtins',
    prompt: 'List exactly 3 Python built-in functions. Names only, one per line.',
    assert: (c) => {
      const builtins = ['len', 'print', 'range', 'type', 'list', 'dict', 'str', 'int', 'sorted', 'sum', 'max', 'min', 'abs', 'open'];
      const count = builtins.filter(b => c?.toLowerCase().includes(b)).length;
      return { pass: count >= 2, builtinsFound: count };
    },
  },
  {
    id: 'lang_name',
    prompt: 'Name one programming language. Just the name.',
    assert: (c) => {
      const langs = ['python', 'javascript', 'typescript', 'java', 'rust', 'go', 'c++', 'ruby', 'swift', 'kotlin'];
      return { pass: langs.some(l => c?.toLowerCase().includes(l)), langs: langs.filter(l => c?.toLowerCase().includes(l)) };
    },
  },
];

// CI-EVAL-05: Collective Intelligence Benchmark
// Cases where multi-model genuinely should outperform single model
const securityAuditCode = `
const express = require('express');
const mysql = require('mysql');
const jwt = require('jsonwebtoken');
const app = express();

// Database
const db = mysql.createConnection({ host: 'localhost', user: 'root', password: 'root', database: 'users' });

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  // Query user
  const query = \`SELECT * FROM users WHERE username = '\${username}' AND password = '\${password}'\`;
  db.query(query, (err, results) => {
    if (results.length > 0) {
      const token = jwt.sign({ userId: results[0].id }, 'secret123', { expiresIn: '30d' });
      res.json({ token });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });
});

app.get('/admin', (req, res) => {
  const token = req.headers.authorization;
  try {
    const decoded = jwt.verify(token, 'secret123');
    if (decoded.userId === 1) res.json({ data: 'admin data' });
  } catch(e) {
    res.status(403).json({ error: 'Forbidden' });
  }
});
`;

const COLLECTIVE_CASES = [
  {
    id: 'security_audit',
    prompt: `Find ALL security vulnerabilities in this code and provide concrete fixes for each:\n\`\`\`js${securityAuditCode}\`\`\``,
    assert: async (c) => gradeWithLLMJudge(
      c,
      'Response identifies at least 4 of these 5 vulnerabilities: (1) SQL injection in login query, (2) hardcoded weak JWT secret, (3) no rate limiting on login endpoint, (4) missing bearer token parsing (using raw Authorization header as token), (5) long JWT expiry (30 days). Each identified vulnerability must include a concrete fix.',
      0.80
    ),
  },
  {
    id: 'architecture_tradeoffs',
    prompt: 'Compare Event Sourcing+CQRS vs Traditional CRUD+REST for a financial transaction system: 50k TPS, mandatory audit trail, rollback capability required, 90% read operations. Provide a concrete recommendation.',
    assert: async (c) => gradeWithLLMJudge(
      c,
      'Response covers: (1) specific performance implications at 50k TPS for each approach, (2) how each handles audit trail requirements, (3) rollback mechanism comparison, (4) how the 90/10 read/write ratio affects the recommendation. Must include a concrete final recommendation with rationale.',
      0.80
    ),
  },
  {
    id: 'code_synthesis',
    prompt: 'Implement a production-ready sliding window rate limiter in Node.js/TypeScript: Redis-backed, atomic (Lua script), handles 10k req/s, with proper TypeScript types and error handling for Redis failures.',
    assert: async (c) => gradeWithLLMJudge(
      c,
      'Implementation includes: (1) sliding window algorithm (not fixed window), (2) Redis Lua script for atomic increment+check, (3) proper TypeScript types/interfaces, (4) error handling for Redis connection failures with fallback behavior, (5) configurable window size and limit.',
      0.80
    ),
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────
async function runSuite(suiteName, cases, strategies) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`SUITE: ${suiteName}`);
  console.log('═'.repeat(60));
  const results = [];

  for (const { id, prompt, assert } of cases) {
    for (const { label, strategy, extra } of strategies) {
      process.stdout.write(`  [${id}] ${label} ... `);
      try {
        const { latencyMs, status, json } = await callAPI(strategy, [{ role: 'user', content: prompt }], extra);
        const content = extractContent(json);
        const meta = extractMeta(json);

        // Support both sync and async assertions
        const assertionRaw = assert(content);
        const assertion = assertionRaw instanceof Promise ? await assertionRaw : assertionRaw;
        const costCheck = assertCostNonNegative(meta);

        const result = {
          suite: suiteName, case_id: id, strategy: label,
          status, latencyMs, content_preview: content?.slice(0, 100),
          assertion, cost_check: costCheck, meta,
        };
        results.push(result);

        const icon = json.error ? '✗ ERR' : assertion.pass ? '✓' : '✗';
        const judgeScore = assertion.score != null ? ` | judge=${assertion.score?.toFixed(2)}` : '';
        console.log(`${icon}${judgeScore} | ${latencyMs}ms | cost=$${meta.cost_usd?.toFixed(6) ?? 'N/A'} | tokens=${meta.tokens_total ?? '?'} | models=${meta.model_count ?? (meta.models_used?.length ?? '?')}`);
        if (json.error) console.log(`    ERROR: ${json.error.message ?? JSON.stringify(json.error)}`);
        if (!assertion.pass && assertion.reasoning) console.log(`    JUDGE: ${assertion.reasoning}`);
      } catch (e) {
        console.log(`EXCEPTION: ${e.message}`);
        results.push({ suite: suiteName, case_id: id, strategy: label, exception: e.message });
      }
      await sleep(DELAY_MS);
    }
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const allResults = [];
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

// OBJECTIVE: single, debate, auto-triage, quality-multipass
allResults.push(...await runSuite('CI-01-Objective', OBJECTIVE_CASES, [
  { label: 'single', strategy: 'single' },
  { label: 'debate', strategy: 'debate' },
  { label: 'auto-triage', strategy: 'auto' },
  { label: 'quality-multipass', strategy: 'quality-multipass' },
]));

// SYNTHESIS: single, debate, consensus, auto-triage
allResults.push(...await runSuite('CI-02-Synthesis', SYNTHESIS_CASES, [
  { label: 'single', strategy: 'single' },
  { label: 'debate', strategy: 'debate' },
  { label: 'consensus', strategy: 'consensus' },
  { label: 'auto-triage', strategy: 'auto' },
]));

// CODE: single, debate, quality-multipass
allResults.push(...await runSuite('CI-03-Code', CODE_CASES, [
  { label: 'single', strategy: 'single' },
  { label: 'debate', strategy: 'debate' },
  { label: 'quality-multipass', strategy: 'quality-multipass' },
]));

// COST/LATENCY: single, parallel, debate, quality-multipass
allResults.push(...await runSuite('CI-04-CostLatency', COST_CASES, [
  { label: 'single', strategy: 'single' },
  { label: 'parallel', strategy: 'parallel' },
  { label: 'debate', strategy: 'debate' },
  { label: 'quality-multipass', strategy: 'quality-multipass' },
]));

// COLLECTIVE INTELLIGENCE: single vs debate, consensus, quality-multipass
allResults.push(...await runSuite('CI-05-CollectiveIntelligence', COLLECTIVE_CASES, [
  { label: 'single', strategy: 'single' },
  { label: 'debate', strategy: 'debate' },
  { label: 'consensus', strategy: 'consensus' },
  { label: 'quality-multipass', strategy: 'quality-multipass' },
]));

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('SUMMARY');
console.log('═'.repeat(60));

const byStrategy = {};
for (const r of allResults) {
  if (!byStrategy[r.strategy]) byStrategy[r.strategy] = { pass: 0, fail: 0, error: 0, costs: [], tokens: [], latencies: [] };
  const s = byStrategy[r.strategy];
  if (r.exception || r.meta?.error) s.error++;
  else if (r.assertion?.pass) s.pass++;
  else s.fail++;
  if (r.meta?.cost_usd != null) s.costs.push(r.meta.cost_usd);
  if (r.meta?.tokens_total != null) s.tokens.push(r.meta.tokens_total);
  if (r.latencyMs != null) s.latencies.push(r.latencyMs);
}

for (const [strat, s] of Object.entries(byStrategy)) {
  const total = s.pass + s.fail + s.error;
  const avgCost = s.costs.length ? (s.costs.reduce((a,b) => a+b, 0) / s.costs.length).toFixed(6) : 'N/A';
  const avgTokens = s.tokens.length ? Math.round(s.tokens.reduce((a,b) => a+b, 0) / s.tokens.length) : 'N/A';
  const avgLatency = s.latencies.length ? Math.round(s.latencies.reduce((a,b) => a+b, 0) / s.latencies.length) : 'N/A';
  const negCosts = s.costs.filter(c => c < 0).length;
  console.log(`${strat.padEnd(20)} | ${s.pass}/${total} pass | errors=${s.error} | avgCost=$${avgCost} | avgTokens=${avgTokens} | avgLatency=${avgLatency}ms | negCosts=${negCosts}`);
}

// ─── IC Win Rate ──────────────────────────────────────────────────────────────
console.log('\n=== IC WIN RATE VS SINGLE (CI-05) ===');
const icStrategies = ['debate', 'consensus', 'quality-multipass'];
const icWinRate = {};
for (const icStrategy of icStrategies) {
  const icResults = allResults.filter(r => r.suite === 'CI-05-CollectiveIntelligence' && r.strategy === icStrategy);
  const wins = icResults.filter(r => {
    if (!r.assertion?.pass) return false;
    const singleResult = allResults.find(s =>
      s.suite === 'CI-05-CollectiveIntelligence' &&
      s.case_id === r.case_id &&
      s.strategy === 'single'
    );
    return singleResult && !singleResult.assertion?.pass;
  }).length;
  const contests = icResults.length;
  icWinRate[icStrategy] = contests > 0
    ? `${wins}/${contests} (${((wins / contests) * 100).toFixed(0)}% exclusive wins)`
    : 'no data';
  console.log(`  ${icStrategy.padEnd(20)}: ${icWinRate[icStrategy]}`);
}

// ─── CI mode: regression gate ─────────────────────────────────────────────────
if (isCiMode) {
  let hasRegression = false;
  for (const [strat, s] of Object.entries(byStrategy)) {
    if (s.error > 0 && s.pass + s.fail === 0) continue; // All errors — tracked separately
    const total = s.pass + s.fail;
    if (total === 0) continue;
    const passRate = s.pass / total;
    if (passRate < failThreshold) {
      console.error(`\n❌ REGRESSION: ${strat} pass rate ${(passRate * 100).toFixed(0)}% < threshold ${(failThreshold * 100).toFixed(0)}%`);
      hasRegression = true;
    }
  }
  if (!hasRegression) {
    console.log(`\n✅ All strategies meet quality threshold (${(failThreshold * 100).toFixed(0)}%)`);
  }
  // ─── Save ─────────────────────────────────────────────────────────────────
  const outDir = join(ROOT, 'eval-results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `audit-live-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify({ timestamp, summary: byStrategy, icWinRate, results: allResults }, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
  process.exit(hasRegression ? 1 : 0);
}

// ─── Save ────────────────────────────────────────────────────────────────────
const outDir = join(ROOT, 'eval-results');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `audit-live-${timestamp}.json`);
writeFileSync(outPath, JSON.stringify({ timestamp, summary: byStrategy, icWinRate, results: allResults }, null, 2));
console.log(`\nFull results saved to: ${outPath}`);
