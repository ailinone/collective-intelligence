#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Production latency probe — decomposes collective-strategy latency per stage.
 *
 * Measures, against a LIVE deployment:
 *   0. /health round-trips        → network + server floor (no LLM cost)
 *   1. strategy matrix            → client wall-time + server execution_time_ms
 *                                   + per-subcall stage decomposition from
 *                                   ailin_metadata.subcalls (voters vs
 *                                   synthesizer/coordinator vs judge)
 *
 * The stage decomposition is what turns "consensus is slow" into "the N
 * sequential judge calls cost X ms and synthesis Y ms" — the actionable form
 * (see consensus-strategy.ts:304 sequential evaluator loop).
 *
 * Usage:
 *   AILIN_API_KEY=sk-... node scripts/prod-latency-probe.mjs
 *
 * Env:
 *   AILIN_BASE_URL    default https://api.ailin.one
 *   AILIN_API_KEY     required for the chat matrix (health runs without it)
 *   STRATEGIES        default "single,consensus,debate" (comma-separated)
 *   REPS              default 3 per strategy
 *   MAX_TOKENS        default 96 (keep member outputs short — latency probe,
 *                     not a quality benchmark)
 *   MAX_BUDGET_USD    default 0.50 — probe aborts when cumulative cost exceeds it
 *   TIMEOUT_MS        default 180000 per request
 *
 * Cost guard: tiny prompt + low max_tokens + hard budget cap. Requests run
 * SEQUENTIALLY so the probe never competes with itself for providers.
 */

const BASE = process.env.AILIN_BASE_URL ?? 'https://api.ailin.one';
const KEY = process.env.AILIN_API_KEY;
const STRATEGIES = (process.env.STRATEGIES ?? 'single,consensus,debate').split(',').map((s) => s.trim()).filter(Boolean);
const REPS = Number(process.env.REPS ?? 3);
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 96);
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD ?? 0.5);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000);

const PROMPT =
  process.env.PROMPT ??
  'In one short sentence: what is the time complexity of binary search? End with "FINAL: O(log n)" if you agree.';

const fmtMs = (ms) => (ms == null || Number.isNaN(ms) ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const median = (a) => {
  const s = [...a].filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, wallMs: performance.now() - t0, text };
  } catch (err) {
    return { status: 0, wallMs: performance.now() - t0, text: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Phase 0: health floor ──────────────────────────────────────────────
console.log(`# Production latency probe — ${BASE}`);
console.log(`\n## Phase 0 — /health floor (network + server, no LLM)`);
await timedFetch(`${BASE}/health`); // warm-up, discarded
const healthTimes = [];
for (let i = 0; i < 5; i++) {
  const r = await timedFetch(`${BASE}/health`);
  healthTimes.push(r.wallMs);
  console.log(`  health #${i + 1}: HTTP ${r.status} in ${fmtMs(r.wallMs)}`);
}
const healthFloor = median(healthTimes);
console.log(`  → floor (median): ${fmtMs(healthFloor)}`);

if (!KEY) {
  console.log('\nAILIN_API_KEY not set — stopping after the health floor. Set it to run the strategy matrix.');
  process.exit(0);
}

// ── Phase 1: strategy matrix ───────────────────────────────────────────
console.log(`\n## Phase 1 — strategy matrix (${STRATEGIES.join(', ')} × ${REPS}, max_tokens=${MAX_TOKENS}, budget $${MAX_BUDGET_USD})`);
let spentUsd = 0;
const rows = [];

for (const strategy of STRATEGIES) {
  for (let rep = 1; rep <= REPS; rep++) {
    if (spentUsd >= MAX_BUDGET_USD) {
      console.log(`\n!! budget cap $${MAX_BUDGET_USD} reached (spent ~$${spentUsd.toFixed(4)}) — aborting remaining cells`);
      break;
    }
    const body = {
      model: 'auto',
      strategy,
      stream: false,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: PROMPT }],
    };
    const r = await timedFetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });

    let meta = null;
    try { meta = JSON.parse(r.text)?.ailin_metadata ?? null; } catch { /* non-JSON error body */ }

    const subcalls = Array.isArray(meta?.subcalls) ? meta.subcalls : [];
    const isSynth = (s) => /coordinator|synthesi/i.test(s.role);
    const isJudge = (s) => /judge|evaluat/i.test(s.role);
    const memberCalls = subcalls.filter((s) => !isSynth(s) && !isJudge(s));
    const row = {
      strategy,
      rep,
      http: r.status,
      wallMs: r.wallMs,
      serverMs: meta?.execution_time_ms ?? null,
      overheadMs: meta?.execution_time_ms != null ? r.wallMs - meta.execution_time_ms : null,
      resolvedStrategy: meta?.resolved_strategy ?? meta?.strategy_used ?? null,
      models: meta?.model_count ?? null,
      membersMaxMs: memberCalls.length ? Math.max(...memberCalls.map((s) => s.latency_ms ?? 0)) : null,
      synthMs: subcalls.filter(isSynth).reduce((a, s) => a + (s.latency_ms ?? 0), 0) || null,
      judgeMs: subcalls.filter(isJudge).reduce((a, s) => a + (s.latency_ms ?? 0), 0) || null,
      costUsd: meta?.cost_usd ?? null,
      cacheHit: meta?.cache_hit === true,
      error: r.status >= 200 && r.status < 300 ? null : r.text.slice(0, 160),
    };
    rows.push(row);
    spentUsd += row.costUsd ?? 0;
    console.log(
      `  ${strategy}#${rep}: HTTP ${row.http} wall=${fmtMs(row.wallMs)} server=${fmtMs(row.serverMs)} ` +
      `members_max=${fmtMs(row.membersMaxMs)} synth=${fmtMs(row.synthMs)} judge=${fmtMs(row.judgeMs)} ` +
      `models=${row.models ?? '—'} cost=$${(row.costUsd ?? 0).toFixed(4)}` +
      (row.cacheHit ? ' [CACHE]' : '') +
      (row.resolvedStrategy && row.resolvedStrategy !== strategy ? ` [resolved:${row.resolvedStrategy}]` : '') +
      (row.error ? `\n    !! ${row.error}` : ''),
    );
  }
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n## Summary (medians over successful, non-cache runs; health floor ${fmtMs(healthFloor)})`);
console.log('| strategy | n | wall | server | net+queue | members(max) | synthesis | judge | cost |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const strategy of STRATEGIES) {
  const ok = rows.filter((r) => r.strategy === strategy && r.http >= 200 && r.http < 300 && !r.cacheHit);
  const m = (f) => median(ok.map(f));
  console.log(
    `| ${strategy} | ${ok.length} | ${fmtMs(m((r) => r.wallMs))} | ${fmtMs(m((r) => r.serverMs))} | ` +
    `${fmtMs(m((r) => r.overheadMs))} | ${fmtMs(m((r) => r.membersMaxMs))} | ${fmtMs(m((r) => r.synthMs))} | ` +
    `${fmtMs(m((r) => r.judgeMs))} | $${(m((r) => r.costUsd) || 0).toFixed(4)} |`,
  );
}
console.log(`\nTotal spent: ~$${spentUsd.toFixed(4)}`);
console.log(
  '\nReading: `server` ≈ strategy pipeline; `members(max)` ≈ parallel fan-out critical path; ' +
  'a large `server − members(max) − synthesis` gap = sequential evaluator/judge overhead ' +
  '(consensus-strategy.ts:304). `judge` may be absent when deferred off the response path (LAT-1).',
);
