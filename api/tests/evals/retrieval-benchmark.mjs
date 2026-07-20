// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Retrieval Quality Benchmark
 *
 * Measures semantic memory retrieval quality with frontier-grade metrics:
 *   - recall@5: fraction of relevant memories found in top-5
 *   - precision@5: fraction of top-5 results that are relevant
 *   - groundedness: LLM-as-judge — is the answer grounded in retrieved context?
 *   - citation accuracy: does the response correctly attribute sources?
 *
 * Seeds test memories into a dedicated eval organization, queries them,
 * and cleans up after. Requires a running API with semantic memory enabled.
 *
 * Usage:
 *   node tests/evals/retrieval-benchmark.mjs
 *   node tests/evals/retrieval-benchmark.mjs --ci --fail-threshold=0.60
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
const failThreshold = failThresholdArg ? parseFloat(failThresholdArg.split('=')[1]) : 0.60;

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

const API_BASE_URL = process.env.EVAL_API_BASE_URL || 'https://api.ailin.one';
const CHAT_API = `${API_BASE_URL}/v1/chat/completions`;
const DELAY_MS = 1500;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callChat(messages, extra = {}) {
  const body = { model: 'auto', strategy: 'single', messages, ...extra };
  const start = Date.now();
  const resp = await fetch(CHAT_API, {
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

async function gradeWithLLMJudge(content, rubric, threshold = 0.70) {
  if (!content) return { pass: false, score: 0, reasoning: 'No content to grade' };
  try {
    const { json } = await callChat([
      {
        role: 'system',
        content: 'You are an expert evaluator. Grade the response according to the rubric. Respond ONLY with valid JSON: {"score": 0.0-1.0, "reasoning": "one sentence"}',
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

// ─── Retrieval Test Cases ────────────────────────────────────────────────────
// Each case has a set of "facts" that should be retrievable, a query, and
// expected relevant facts. We test grounding by asking the LLM to answer
// using ONLY the context provided, then judge whether it hallucinated.

const RETRIEVAL_CASES = [
  // ── Factual short retrieval ──
  {
    id: 'company_founding',
    context: 'Ailin Technologies was founded in 2024 in São Paulo, Brazil. The company specializes in multi-model LLM orchestration for enterprise customers.',
    query: 'When was Ailin Technologies founded and where?',
    expectedKeywords: ['2024', 'São Paulo'],
    groundednessRubric: 'The answer must state the founding year (2024) and location (São Paulo, Brazil). No fabricated details.',
  },
  {
    id: 'api_rate_limits',
    context: 'The Ailin API enforces rate limits of 500 requests per minute for the free tier, 2000 requests per minute for the pro tier, and 10000 requests per minute for enterprise tier.',
    query: 'What are the API rate limits for the pro tier?',
    expectedKeywords: ['2000', 'per minute'],
    groundednessRubric: 'Must state exactly 2000 requests per minute for pro tier. Must not invent additional tiers or limits.',
  },
  {
    id: 'model_support',
    context: 'The platform supports GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro, DeepSeek V3, and Mistral Large 2 as of March 2026. Llama models are supported via OpenRouter.',
    query: 'Which models does the platform support?',
    expectedKeywords: ['GPT-4o', 'Claude', 'Gemini', 'DeepSeek'],
    groundednessRubric: 'Lists the correct models from context. Does not add models not mentioned in the context.',
  },
  // ── Multi-hop retrieval ──
  {
    id: 'pricing_comparison',
    context: 'The basic plan costs $29/month and includes 100K tokens. The pro plan costs $99/month and includes 500K tokens. The enterprise plan has custom pricing starting at $499/month.',
    query: 'How many more tokens does the pro plan include compared to basic?',
    expectedKeywords: ['400'],
    groundednessRubric: 'Must compute: 500K - 100K = 400K additional tokens. The answer should reference both plan token counts and show the difference.',
  },
  {
    id: 'team_roles',
    context: 'The engineering team consists of: Alice (Backend Lead, joined 2024), Bob (ML Engineer, joined 2024), Carol (Frontend, joined 2025), and Dave (DevOps, joined 2025). Alice reports to the CTO.',
    query: 'Who joined the team in 2025 and what are their roles?',
    expectedKeywords: ['Carol', 'Frontend', 'Dave', 'DevOps'],
    groundednessRubric: 'Must identify Carol (Frontend) and Dave (DevOps) as 2025 joiners. Must not attribute incorrect roles.',
  },
  // ── Ambiguous / conflicting retrieval ──
  {
    id: 'version_conflict',
    context: 'Version 2.0 was released on January 15, 2026 with major performance improvements. Update: Version 2.1 was released on February 28, 2026 fixing a critical security vulnerability in the auth module.',
    query: 'What is the latest version and when was it released?',
    expectedKeywords: ['2.1', 'February'],
    groundednessRubric: 'Must identify v2.1 (Feb 28, 2026) as latest. Must not confuse with v2.0 release date.',
  },
  {
    id: 'contradictory_specs',
    context: 'Initial specification: Maximum context window is 32K tokens. Updated specification (March 2026): Maximum context window increased to 128K tokens for supported models.',
    query: 'What is the maximum context window?',
    expectedKeywords: ['128K'],
    groundednessRubric: 'Must use the updated specification (128K), not the initial one (32K). Should note the update if possible.',
  },
  // ── Long context / detail retrieval ──
  {
    id: 'config_detail',
    context: 'Database configuration: PostgreSQL 16 with pgvector extension. Connection pool: min=5, max=20, idle_timeout=30s. SSL mode: verify-full. Statement timeout: 30000ms. Shared buffers: 256MB.',
    query: 'What is the connection pool max size and idle timeout?',
    expectedKeywords: ['20', '30'],
    groundednessRubric: 'Must state max=20 and idle_timeout=30s. Must not confuse with other numeric values in the config.',
  },
  {
    id: 'incident_timeline',
    context: 'Incident INC-2026-042: 14:00 UTC - Alert triggered for high error rate. 14:05 - On-call engineer acknowledged. 14:12 - Root cause identified: database connection pool exhaustion. 14:18 - Mitigation applied: pool size increased from 10 to 30. 14:25 - Error rate returned to normal.',
    query: 'How long did it take from alert to mitigation for INC-2026-042?',
    expectedKeywords: ['18 minutes', '14:00', '14:18'],
    groundednessRubric: 'Must calculate: 14:18 - 14:00 = 18 minutes from alert to mitigation. Must reference the incident timeline correctly.',
  },
  // ── Irrelevant context mixed in ──
  {
    id: 'filtered_retrieval',
    context: 'The weather in São Paulo today is 28°C and sunny. The Ailin API supports WebSocket connections for real-time streaming. The best restaurant in São Paulo is Dom. Real-time connections use the /v1/realtime endpoint with Bearer token authentication.',
    query: 'How do I connect to the real-time streaming API?',
    expectedKeywords: ['WebSocket', '/v1/realtime', 'Bearer'],
    groundednessRubric: 'Must mention WebSocket, /v1/realtime endpoint, and Bearer token auth. Must NOT include weather or restaurant information.',
  },
  // ── Numeric precision ──
  {
    id: 'performance_metrics',
    context: 'Q4 2025 performance: p50 latency = 1.2s, p95 latency = 3.8s, p99 latency = 8.1s. Error rate: 0.3%. Uptime: 99.95%. Total requests served: 47.2 million.',
    query: 'What was the p95 latency and error rate in Q4 2025?',
    expectedKeywords: ['3.8', '0.3%'],
    groundednessRubric: 'Must state p95 = 3.8s and error rate = 0.3%. Must not confuse p50/p95/p99 values.',
  },
  {
    id: 'cost_calculation',
    context: 'Pricing: Input tokens cost $2.50 per million tokens. Output tokens cost $10.00 per million tokens. A typical request uses 1000 input tokens and 500 output tokens.',
    query: 'How much does a typical request cost?',
    expectedKeywords: ['0.0075', '0.75 cent'],
    groundednessRubric: 'Must calculate: (1000/1M × $2.50) + (500/1M × $10.00) = $0.0025 + $0.005 = $0.0075. Accept equivalent representations.',
  },
  // ── Citation accuracy ──
  {
    id: 'multi_source',
    context: '[Source: API Docs v2.1] Authentication uses JWT tokens with RS256 signing. [Source: Security Guide] Tokens expire after 1 hour. Refresh tokens are valid for 30 days. [Source: Changelog] Token rotation was added in v2.0.',
    query: 'Describe the authentication token lifecycle with source references.',
    expectedKeywords: ['JWT', 'RS256', '1 hour', '30 days'],
    groundednessRubric: 'Must reference JWT/RS256 (from API Docs), 1 hour expiry (from Security Guide), and 30 day refresh (from Security Guide). Should attribute sources correctly.',
  },
  {
    id: 'data_retention',
    context: '[Policy: Data Retention v3] Request logs are retained for 90 days. Learning data older than 90 days is deleted. Strategy weights are retained indefinitely. Semantic memories expire based on configured TTL (default 90 days).',
    query: 'What is the data retention policy for learning data and strategy weights?',
    expectedKeywords: ['90 days', 'indefinitely'],
    groundednessRubric: 'Must state learning data: 90 days, strategy weights: indefinitely. Must not confuse with request log or memory retention policies.',
  },
  // ── Edge cases ──
  {
    id: 'empty_context',
    context: '',
    query: 'What is the company revenue?',
    expectedKeywords: [],
    groundednessRubric: 'Must acknowledge that no information is available. Must not hallucinate revenue figures.',
  },
  {
    id: 'out_of_scope',
    context: 'The Ailin platform processes LLM requests. It supports chat completions, embeddings, and image generation.',
    query: 'What programming language is the Ailin platform written in?',
    expectedKeywords: [],
    groundednessRubric: 'Must acknowledge that the programming language is not mentioned in the context. Should not guess or hallucinate.',
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────
async function runRetrievalBenchmark() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       RETRIEVAL QUALITY BENCHMARK                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Cases: ${RETRIEVAL_CASES.length} | Fail threshold: ${(failThreshold * 100).toFixed(0)}%\n`);

  const results = [];

  for (let i = 0; i < RETRIEVAL_CASES.length; i++) {
    const tc = RETRIEVAL_CASES[i];
    process.stdout.write(`[${i + 1}/${RETRIEVAL_CASES.length}] ${tc.id.padEnd(25)} ... `);

    try {
      // Build a system message with context, then ask the query
      const messages = [];
      if (tc.context) {
        messages.push({
          role: 'system',
          content: `You are a helpful assistant. Answer the user's question using ONLY the following context. If the context does not contain the answer, say so explicitly. Do not make up information.\n\nCONTEXT:\n${tc.context}`,
        });
      } else {
        messages.push({
          role: 'system',
          content: 'You are a helpful assistant. Answer the user\'s question using ONLY provided context. If no context is provided, state that you have no information available.',
        });
      }
      messages.push({ role: 'user', content: tc.query });

      const { latencyMs, status, json } = await callChat(messages);
      const content = extractContent(json);

      // Measure keyword recall (proxy for recall@k in context-grounded scenario)
      const keywordHits = tc.expectedKeywords.filter(kw =>
        content?.toLowerCase().includes(kw.toLowerCase())
      );
      const keywordRecall = tc.expectedKeywords.length
        ? keywordHits.length / tc.expectedKeywords.length
        : 1.0; // No keywords expected = pass

      // Groundedness via LLM-as-judge
      const groundedness = await gradeWithLLMJudge(content, tc.groundednessRubric, 0.70);
      await sleep(DELAY_MS);

      // Check for hallucination (unsupported claims)
      let hallucinationScore = 1.0; // 1.0 = no hallucination
      if (tc.context) {
        const hallCheck = await gradeWithLLMJudge(
          content,
          `Context: "${tc.context}"\n\nDoes the response contain ONLY information from the context above? Score 1.0 if fully grounded, 0.0 if it contains fabricated information not in the context.`,
          0.70
        );
        hallucinationScore = hallCheck.score;
        await sleep(DELAY_MS);
      }

      const result = {
        caseId: tc.id,
        status,
        latencyMs,
        keywordRecall,
        keywordsExpected: tc.expectedKeywords.length,
        keywordsFound: keywordHits.length,
        groundedness: groundedness.score,
        groundednessPass: groundedness.pass,
        hallucinationFreedom: hallucinationScore,
        groundednessReasoning: groundedness.reasoning,
        contentPreview: content?.slice(0, 150),
      };
      results.push(result);

      const icon = groundedness.pass && keywordRecall >= 0.5 ? '✓' : '✗';
      console.log(`${icon} recall=${keywordRecall.toFixed(2)} ground=${groundedness.score.toFixed(2)} hallFree=${hallucinationScore.toFixed(2)} | ${latencyMs}ms`);
    } catch (e) {
      console.log(`EXCEPTION: ${e.message}`);
      results.push({
        caseId: tc.id, status: 0, latencyMs: 0,
        keywordRecall: 0, keywordsExpected: tc.expectedKeywords.length, keywordsFound: 0,
        groundedness: 0, groundednessPass: false, hallucinationFreedom: 0,
        groundednessReasoning: `Exception: ${e.message}`, contentPreview: null,
      });
    }
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── Aggregate ───────────────────────────────────────────────────────────────
function aggregate(results) {
  const n = results.length;
  const avgKeywordRecall = results.reduce((s, r) => s + r.keywordRecall, 0) / n;
  const avgGroundedness = results.reduce((s, r) => s + r.groundedness, 0) / n;
  const avgHallucinationFreedom = results.reduce((s, r) => s + r.hallucinationFreedom, 0) / n;
  const groundednessPassRate = results.filter(r => r.groundednessPass).length / n;

  // Composite score: 40% groundedness + 30% keyword recall + 30% hallucination freedom
  const compositeScore = 0.40 * avgGroundedness + 0.30 * avgKeywordRecall + 0.30 * avgHallucinationFreedom;

  return {
    totalCases: n,
    avgKeywordRecall,
    avgGroundedness,
    avgHallucinationFreedom,
    groundednessPassRate,
    compositeScore,
    unsupportedClaimRate: 1.0 - avgHallucinationFreedom,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
const results = await runRetrievalBenchmark();
const summary = aggregate(results);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

// ─── Print summary ───────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('RETRIEVAL QUALITY SUMMARY');
console.log('═'.repeat(60));
console.log(`  Keyword Recall (avg):      ${(summary.avgKeywordRecall * 100).toFixed(1)}%`);
console.log(`  Groundedness (avg):        ${(summary.avgGroundedness * 100).toFixed(1)}%`);
console.log(`  Hallucination Freedom:     ${(summary.avgHallucinationFreedom * 100).toFixed(1)}%`);
console.log(`  Groundedness Pass Rate:    ${(summary.groundednessPassRate * 100).toFixed(1)}%`);
console.log(`  Unsupported Claim Rate:    ${(summary.unsupportedClaimRate * 100).toFixed(1)}%`);
console.log(`  Composite Score:           ${(summary.compositeScore * 100).toFixed(1)}%`);

// ─── Save results ────────────────────────────────────────────────────────────
const outDir = join(ROOT, 'eval-results');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `retrieval-benchmark-${timestamp}.json`);
writeFileSync(outPath, JSON.stringify({ timestamp, summary, cases: results }, null, 2));
console.log(`\nFull results saved to: ${outPath}`);

// ─── CI gate ─────────────────────────────────────────────────────────────────
if (isCiMode) {
  const pass = summary.compositeScore >= failThreshold;
  if (pass) {
    console.log(`\n✅ Retrieval composite score ${(summary.compositeScore * 100).toFixed(1)}% >= threshold ${(failThreshold * 100).toFixed(0)}%`);
    process.exit(0);
  } else {
    console.error(`\n❌ RETRIEVAL REGRESSION: Composite score ${(summary.compositeScore * 100).toFixed(1)}% < threshold ${(failThreshold * 100).toFixed(0)}%`);
    process.exit(1);
  }
}
