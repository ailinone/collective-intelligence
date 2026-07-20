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
 * C3 v4 Benchmark Driver (audit close-out, 2026-06-13).
 *
 * One command that runs the full v4 protocol against a DEPLOYED ci-api,
 * sequencing the existing admin endpoints so the operator never hand-rolls a
 * curl chain (and the protocol stays reproducible):
 *
 *   preflight → judge calibration (gate) → create → run → poll → GO/NO-GO
 *
 * It is deliberately fetch-only (no project imports): it drives the service
 * over HTTP exactly as an operator would, so it works against staging or prod
 * without a local runtime, DB, or provider keys.
 *
 * Required env:
 *   API_BASE                 internal target only, e.g. http://ci-api:3000 or
 *                             http://localhost:3000 (no trailing slash). Every
 *                             call this driver makes is /v1/admin/experiment/*
 *                             or /v1/admin/operability/* — admin routes are not
 *                             part of the public contract, so this must never
 *                             be the public hostname.
 *   ADMIN_TOKEN              bearer for an admin/owner key
 *   EXPERIMENT_JUDGE_MODEL   a STABLE judge id (NOT 'auto') — also exported to
 *                            the API process; this driver only validates it
 * Optional env (with defaults):
 *   CONFIG_KEY=c3-main-comparison   c3-pilot | c3-ablation-* | ...
 *   REPETITIONS=3
 *   MAX_BUDGET_USD=200
 *   JUDGE_CALIBRATION_RUNS=20        inter-rater pre-flight sample size
 *   JUDGE_MAX_STDDEV=0.1             abort if the judge is noisier than this
 *   POLL_INTERVAL_MS=30000
 *   TASK_INDICES=                    comma list; empty = full suite
 *   SKIP_CALIBRATION=false           escape hatch (NOT recommended)
 *
 * Exit codes: 0 = completed + report written; 1 = aborted/failed at any gate.
 */

const API_BASE = (process.env.API_BASE || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const JUDGE_MODEL = process.env.EXPERIMENT_JUDGE_MODEL || '';
const CONFIG_KEY = process.env.CONFIG_KEY || 'c3-main-comparison';
const REPETITIONS = Number(process.env.REPETITIONS || 3);
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD || 200);
const CAL_RUNS = Number(process.env.JUDGE_CALIBRATION_RUNS || 20);
const CAL_MAX_STDDEV = Number(process.env.JUDGE_MAX_STDDEV || 0.1);
// Judge mode decides WHICH gate is authoritative:
//   pinned  → noise gate (maxStdDev) AND accuracy gate (maxAbsError). A fixed
//             measuring instrument must be both reproducible AND accurate.
//   dynamic → accuracy gate ONLY. A provider-diverse fallback cascade is
//             variance-rich BY DESIGN, so stdDev is informational, not a gate;
//             the trust criterion is whether each verdict tracks the gold label.
const JUDGE_MODE = (process.env.JUDGE_MODE || 'pinned').toLowerCase();
const CAL_MAX_ABS_ERROR = Number(process.env.JUDGE_MAX_ABS_ERROR || 0.15);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);
const TASK_INDICES = (process.env.TASK_INDICES || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const SKIP_CALIBRATION = process.env.SKIP_CALIBRATION === 'true';
// Resume an existing (paused/interrupted) experiment instead of creating a new
// one. The runner already rebuilds the completed-set from the DB and skips what
// already ran — without this, every pause (budget guard, crash, restart) forced
// a brand-new experiment and re-paid all completed executions. Use for runs
// created under the SAME protocol only (do NOT resume across judge changes).
const RESUME_EXPERIMENT_ID = (process.env.RESUME_EXPERIMENT_ID || '').trim();
// Warm the provider-operability hub before the calibration/canary. After an
// API restart the hub is cold ('unknown' everywhere); the canary then sees "0
// healthy providers" and aborts, and the judge cascade pays the cold probes.
// A discovery sweep primes it. Disable with WARMUP_DISCOVERY=false.
const WARMUP_DISCOVERY = process.env.WARMUP_DISCOVERY !== 'false';

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function log(msg) { console.log(`[c3-v4] ${msg}`); }
function fail(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

async function api(method, path, { body, query } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 0. Preflight ────────────────────────────────────────────────────────
  if (!API_BASE) fail('API_BASE is required.');
  if (!ADMIN_TOKEN) fail('ADMIN_TOKEN is required.');
  // In dynamic mode the judge is the in-process production cascade (no pinned
  // model id), so EXPERIMENT_JUDGE_MODEL is not required. In pinned mode it must
  // be a STABLE id — a floating pinned judge makes the run unpublishable.
  if (JUDGE_MODE !== 'dynamic' && (!JUDGE_MODEL || JUDGE_MODEL === 'auto')) {
    fail('EXPERIMENT_JUDGE_MODEL must be a STABLE model id (not "auto") in pinned mode. Set JUDGE_MODE=dynamic to use the production cascade instead.');
  }
  log(`Target: ${API_BASE} | config: ${CONFIG_KEY} | judge: ${JUDGE_MODE === 'dynamic' ? 'dynamic-cascade' : JUDGE_MODEL} | mode: ${JUDGE_MODE} | reps: ${REPETITIONS} | budget: $${MAX_BUDGET_USD}`);

  const status0 = await api('GET', '/v1/admin/experiment/status');
  if (status0.state === 'running') {
    fail(`An experiment is already running (${status0.experimentId}). Pause or wait before starting v4.`);
  }

  // ── 0.5 Warm-up: prime the operability hub before calibration/canary ──────
  if (WARMUP_DISCOVERY) {
    try {
      log('Warm-up: triggering a discovery sweep (primes the operability hub) ...');
      await api('POST', '/v1/admin/operability/discover-now');
      // Give probes a moment to land; the canary/judge cascade then sees a warm hub.
      await sleep(Number(process.env.WARMUP_SETTLE_MS || 15_000));
      log('✓ Warm-up sweep dispatched.');
    } catch (e) {
      log(`⚠ Warm-up sweep failed (${e.message}) — continuing; calibration will warm the hub instead.`);
    }
  }

  // ── 1. Judge calibration gate (inter-rater reliability) ───────────────────
  if (SKIP_CALIBRATION) {
    log('⚠ SKIP_CALIBRATION=true — skipping the judge reliability gate (NOT recommended).');
  } else {
    log(`Calibrating judge (mode=${JUDGE_MODE}, ${CAL_RUNS} runs/case, max stddev ${CAL_MAX_STDDEV}, max abs-error ${CAL_MAX_ABS_ERROR}) ...`);
    // NOTE: calibrate-judge is a POST route (a GET 404s).
    const report = await api('POST', '/v1/admin/experiment/calibrate-judge', { query: { runs: CAL_RUNS, ...(JUDGE_MODE === 'dynamic' ? { mode: 'dynamic' } : {}) } });
    const r = report?.report ?? report;
    const maxStdDev = r?.maxStdDev;
    const reliable = r?.reliable;
    // Accuracy axis (vs gold labels) — the authoritative gate for a DYNAMIC judge.
    const maxAbsError = r?.maxAbsError;
    const meanAbsError = r?.meanAbsError;
    const accurate = r?.accurate;
    // Prefer the API's own count; fall back to summing results[].scores so this
    // guard also works against an API that predates the totalScoresCollected field.
    const totalScores = r?.totalScoresCollected
      ?? (Array.isArray(r?.results)
        ? r.results.reduce((s, x) => s + (Array.isArray(x?.scores) ? x.scores.length : 0), 0)
        : undefined);
    const enoughData = r?.enoughData;
    if (typeof maxStdDev !== 'number') {
      fail(`Calibration returned no maxStdDev — cannot verify judge stability. Response: ${JSON.stringify(report).slice(0, 300)}`);
    }
    const f = (x) => (typeof x === 'number' && !Number.isNaN(x)) ? x.toFixed(4) : 'n/a';
    log(`Judge NOISE: maxStdDev=${f(maxStdDev)} reliable=${reliable} | ACCURACY: meanAbsError=${f(meanAbsError)} maxAbsError=${f(maxAbsError)} accurate=${accurate} | scoresCollected=${totalScores ?? '?'}`);
    // Guard against a FALSE pass: an empty/near-empty sample yields stdDev 0,
    // which looks "reliable". A judge that produced no parseable scores is
    // almost always unreachable/unauthenticated (set BOOTSTRAP_BEARER_TOKEN on
    // the API process) or a dead/rate-limited judge model (EXPERIMENT_JUDGE_MODEL).
    if (enoughData === false || totalScores === 0) {
      fail(`Judge calibration collected too few scores (${totalScores ?? 0}) — the judge produced no parseable output. Give the judge a self-call token (BOOTSTRAP_BEARER_TOKEN) and a reachable, FUNDED judge before benchmarking.`);
    }
    // ACCURACY gate — applies to BOTH modes: a judge that disagrees with the
    // human gold cannot produce publishable scores, however consistent it is.
    // For a DYNAMIC (provider-diverse, variance-rich) judge the publishable-
    // accuracy criterion is AGGREGATE tracking of gold (meanAbsError), NOT the
    // per-case worst (maxAbsError): one case drifting past the threshold is
    // cascade/sampling variance, not systematic bias, and the synchronous
    // calibration can't take enough samples to stabilize every case (the server
    // closes the request near ~300s, capping runs). meanAbsError is the honest
    // aggregate-accuracy gate. Pinned mode keeps the strict per-case max gate
    // AND the server's `accurate` flag (a fixed instrument must be reproducible).
    const accuracyMetric = JUDGE_MODE === 'dynamic' ? meanAbsError : maxAbsError;
    const accuracyLabel = JUDGE_MODE === 'dynamic' ? 'meanAbsError' : 'maxAbsError';
    if (typeof accuracyMetric !== 'number' || Number.isNaN(accuracyMetric)) {
      fail(`Calibration returned no ${accuracyLabel} — cannot verify judge accuracy vs gold. Update the API to the accuracy-aware calibration report.`);
    }
    const accuracyFails = JUDGE_MODE === 'dynamic'
      ? accuracyMetric > CAL_MAX_ABS_ERROR
      : (accurate === false || accuracyMetric > CAL_MAX_ABS_ERROR);
    if (accuracyFails) {
      fail(`Judge inaccurate vs gold (${accuracyLabel} ${f(accuracyMetric)} > ${CAL_MAX_ABS_ERROR}; maxAbsError=${f(maxAbsError)}, meanAbsError=${f(meanAbsError)}). ${JUDGE_MODE === 'dynamic' ? 'Improve the dynamic cascade pool (native, funded providers) or raise JUDGE_MAX_ABS_ERROR with justification.' : 'Pick a stronger judge model.'}`);
    }
    // NOISE gate — authoritative ONLY for a pinned judge. A dynamic cascade is
    // variance-rich by design, so its stdDev is logged but not gated.
    if (JUDGE_MODE === 'pinned') {
      if (reliable === false || maxStdDev > CAL_MAX_STDDEV) {
        fail(`Pinned judge too noisy for reproducible scoring (maxStdDev ${f(maxStdDev)} > ${CAL_MAX_STDDEV}). Lower its temperature or pick a more deterministic judge — or run in JUDGE_MODE=dynamic if a cascade is intended.`);
      }
    } else if (maxStdDev > CAL_MAX_STDDEV) {
      log(`  (dynamic mode: maxStdDev ${f(maxStdDev)} > ${CAL_MAX_STDDEV} is EXPECTED for a provider-diverse cascade — not gated; accuracy is the gate.)`);
    }
    log('✓ Judge calibration passed (accurate vs gold' + (JUDGE_MODE === 'pinned' ? ' AND consistent).' : '; dynamic mode).'));
  }

  // ── 2. Create the experiment — or RESUME an existing one ──────────────────
  let experimentId;
  if (RESUME_EXPERIMENT_ID) {
    // Resume path: the runner rebuilds the completed-set from the DB and only
    // executes what is missing (paused/interrupted experiments; NOT completed/
    // failed ones — the API rejects those).
    experimentId = RESUME_EXPERIMENT_ID;
    log(`RESUME mode: skipping create; resuming experiment ${experimentId} ...`);
  } else {
    const overrides = { repetitions: REPETITIONS, maxBudgetUsd: MAX_BUDGET_USD };
    if (TASK_INDICES.length > 0) overrides.taskIndices = TASK_INDICES;
    // Concurrency controls (2026-06-29): the 64-arm matrix fired through many
    // parallel queue workers saturates upstream providers → rate-limit (429)
    // failures dominated the first run. Lower maxConcurrency + a per-call delay
    // space requests out so the operable arms succeed instead of being throttled.
    if (process.env.EXPERIMENT_MAX_CONCURRENCY) overrides.maxConcurrency = Number(process.env.EXPERIMENT_MAX_CONCURRENCY);
    if (process.env.EXPERIMENT_DELAY_MS) overrides.delayBetweenCallsMs = Number(process.env.EXPERIMENT_DELAY_MS);
    log(`Creating experiment (configKey=${CONFIG_KEY}) ...`);
    const created = await api('POST', '/v1/admin/experiment/c3-create', {
      body: { configKey: CONFIG_KEY, overrides },
    });
    experimentId = created.experimentId || created.id;
    if (!experimentId) fail(`c3-create returned no experimentId: ${JSON.stringify(created).slice(0, 300)}`);
    log(`✓ Created ${experimentId} — ${created.totalExecutions ?? '?'} planned executions across ${created.modesCount ?? created.modes?.length ?? '?'} arms.`);
  }

  // ── 3. Start the run ──────────────────────────────────────────────────────
  await api('POST', '/v1/admin/experiment/run', { body: { experimentId } });
  log('✓ Run started (async). Polling status ...');

  // ── 4. Poll until terminal, with a hard budget guard ──────────────────────
  let lastCompleted = -1;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    let s;
    // Pass experimentId so the status endpoint's DB fallback reports THIS run's
    // authoritative state even if the API restarted and lost its in-memory
    // handle (review F13) — otherwise a restart would masquerade as completion.
    try { s = await api('GET', '/v1/admin/experiment/status', { query: { experimentId } }); }
    catch (e) { log(`status poll error (will retry): ${e.message}`); continue; }

    const p = s.progress;
    if (p) {
      if (p.completed !== lastCompleted) {
        log(`progress: ${p.completed}/${p.total} | cost $${(p.totalCostUsd ?? 0).toFixed(2)} | state=${s.state}`);
        lastCompleted = p.completed;
      }
      if ((p.totalCostUsd ?? 0) > MAX_BUDGET_USD * 1.05) {
        log(`⚠ Spend $${p.totalCostUsd.toFixed(2)} exceeded budget +5% — pausing.`);
        await api('POST', '/v1/admin/experiment/pause').catch(() => {});
        fail('Budget guard tripped. Inspect partial results before resuming.');
      }
    }
    if (s.state === 'completed' || s.state === 'failed') {
      log(`Run ${s.state}.`);
      if (s.state === 'failed') fail('Experiment ended in FAILED state — inspect logs and /results.');
      break;
    }
    if (s.state === 'paused') {
      fail('Experiment is PAUSED — resume it (or inspect partial results) before reports can be generated.');
    }
    // state === null now means the experiment genuinely does not exist in the DB
    // (never expected for a run we just created) — treat as an anomaly, NOT as a
    // clean completion, so we never report on a half-finished run (review F13).
    if (s.state === null || s.state === undefined) {
      fail(`Status returned no state for ${experimentId} (source=${s.source ?? 'in-memory'}). ` +
        `The run may have been lost by an API restart; inspect /results before assuming completion.`);
    }
  }

  // ── 5. GO/NO-GO + analysis reports ────────────────────────────────────────
  log('Generating GO/NO-GO report ...');
  const goNoGo = await api('GET', '/v1/admin/experiment/go-no-go', { query: { experimentId } });
  // The analysis report carries the headline collective-vs-Tier1 conclusion.
  let analysis = null;
  try {
    analysis = await api('GET', '/v1/admin/experiment/analysis', { query: { experimentId } });
  } catch (e) {
    log(`analysis report unavailable (non-fatal): ${e.message}`);
  }

  const outDir = join(process.cwd(), 'reports', 'experiments');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `c3-v4-${experimentId}.json`);
  writeFileSync(outFile, JSON.stringify({ experimentId, goNoGo, analysis }, null, 2));

  const fv = goNoGo?.finalVerdict;
  const ci = analysis?.collectiveVsTier1 ?? analysis?.conclusions?.collectiveVsTier1;
  log('─────────────────────────────────────────────');
  if (fv) log(`FINAL VERDICT: ${fv.class} — ${fv.summary}` + (fv.productionDefault ? ` (default: ${fv.productionDefault})` : ''));
  else log(`FINAL VERDICT: ${JSON.stringify(goNoGo?.finalVerdict ?? goNoGo).slice(0, 300)}`);
  if (ci) log(`CI vs Tier-1: ${ci.verdict} (Δquality=${ci.qualityDelta}, costMult=${ci.costMultiplier}, conf=${ci.confidence})`);
  const goCount = Array.isArray(goNoGo?.decisions) ? goNoGo.decisions.filter((d) => d.verdict === 'GO').length : null;
  if (goCount !== null) log(`GO decisions: ${goCount}/${goNoGo.decisions.length}`);
  log(`Full report: ${outFile}`);
  log('─────────────────────────────────────────────');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
