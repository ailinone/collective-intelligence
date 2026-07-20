// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R1 — Model Quality Benchmark Runner.
 *
 * Executes a controlled benchmark over a curated candidate set:
 *   - LOCKED routes (provider/model fixed by the candidate set; no fallback)
 *   - NO consensus strategy (each call targets ONE specific model)
 *   - NO eval.dryRun=false flag (this is the inverse — real single-model calls)
 *   - HARD budget guard checked before each call
 *   - LOCAL evaluator scores the output deterministically
 *   - Cost ledger updated atomically per attempt
 *
 * Why a runner and not in-process orchestration: the strategy machinery
 * adds plan/cascade/aggregation overhead that's irrelevant for measuring
 * a SINGLE model's quality on a task. We want raw `model → prompt → output`
 * cycles with minimal interference.
 *
 * Safety:
 *   - PROBE_API_KEY and PROBE_API_URL come from env (never logged)
 *   - Output sanitization: stored outputs are truncated to 2000 chars
 *   - Stops cleanly if budget would be exceeded by next call
 *   - Verifies response model matches request (catches hidden fallback)
 *
 * Run via probe-runner sidecar (NOT in API container):
 *   docker compose ... run --rm probe-runner sh -lc "pnpm tsx ... <args>"
 */
import fs from 'node:fs';
import {
  evaluateTaskOutput,
  type BenchmarkTask,
} from './model-quality-evaluator';
import {
  buildSnapshot,
  computeSnapshotHash,
  type ModelQualityCalibrationEntry,
} from '../role-selection/model-quality-calibration';

// ─── CLI ──────────────────────────────────────────────────────────────────

interface Cli {
  candidateSet: string;
  tasks: string;
  maxModels: number;
  maxTasks: number;
  maxTotalCostUsd: number;
  maxTokens: number;
  temperature: number;
  noConsensus: boolean;
  noDryrunFalse: boolean;
  noChainOfThought: boolean;
  sanitize: boolean;
  writeJson: string;
  writeMd: string;
  writeQualitySnapshot: string;
  ledger: string;
  apiBaseUrl: string;
}

export function parseArgs(argv: readonly string[]): Cli {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.substring(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags.add(key);
    else { args.set(key, next); i++; }
  }
  function req(key: string): string {
    const v = args.get(key);
    if (!v) throw new Error(`missing required flag --${key}`);
    return v;
  }
  function num(key: string, dflt: number): number {
    const v = args.get(key);
    return v !== undefined ? Number(v) : dflt;
  }
  return {
    candidateSet: req('candidate-set'),
    tasks: req('tasks'),
    maxModels: num('max-models', 16),
    maxTasks: num('max-tasks', 5),
    maxTotalCostUsd: num('max-total-cost-usd', 0.03),
    maxTokens: num('max-tokens', 220),
    temperature: num('temperature', 0),
    noConsensus: flags.has('no-consensus'),
    noDryrunFalse: flags.has('no-dryrun-false'),
    noChainOfThought: flags.has('no-chain-of-thought'),
    sanitize: flags.has('sanitize'),
    writeJson: req('write-json'),
    writeMd: req('write-md'),
    writeQualitySnapshot: req('write-quality-snapshot'),
    ledger: req('ledger'),
    apiBaseUrl: args.get('api-base-url') ?? process.env.CI_API_BASE_URL ?? 'http://localhost:3002',
  };
}

// ─── Types ───────────────────────────────────────────────────────────────

interface CandidateRow {
  readonly logicalModelId: string;
  readonly canonicalModelId: string;
  readonly family?: string;
  readonly providerId: string;
  readonly routeId: string;
  readonly apiModelId: string;
  readonly providersCount?: number;
  readonly inputCostPer1MUsd?: number;
  readonly outputCostPer1MUsd?: number;
  readonly qualityScoreCurrent?: number;
  readonly qualityScoreSourceCurrent?: string;
  readonly benchmarkable?: boolean;
  readonly blockedReason?: string;
}

interface Attempt {
  readonly attemptId: string;
  readonly modelId: string;
  readonly canonicalModelId: string;
  readonly providerId: string;
  readonly routeId: string;
  readonly apiModelId: string;
  readonly taskId: string;
  readonly status: 'ok' | 'failed' | 'budget_stop' | 'route_mismatch';
  readonly ok: boolean;
  readonly errorKind?: string;
  readonly errorMessage?: string;
  readonly outputPreview?: string;
  readonly outputLen?: number;
  readonly responseProviderId?: string;
  readonly responseModelId?: string;
  readonly hiddenFallbackUsed?: boolean;
  readonly outOfPlanRoute?: boolean;
  readonly tokens?: { prompt?: number; completion?: number; total?: number };
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly evaluationScore?: number;
  readonly evaluationDimensions?: Readonly<Record<string, number>>;
  readonly evaluationNotes?: readonly string[];
}

interface Ledger {
  stage: string;
  maxTotalBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  dryRunFalseExecuted: boolean;
  realConsensusExecuted: boolean;
  benchmarkProviderCalls: number;
  status: string;
  entries: Array<{ attemptId: string; modelId: string; taskId: string; costUsd: number; status: string }>;
  [k: string]: unknown;
}

// ─── Sanitization ────────────────────────────────────────────────────────

const SECRET_REDACTOR = /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|password=\S+|token=\S+|secret=\S+)/gi;
export function sanitize(s: string): string {
  return (s || '').replace(SECRET_REDACTOR, '[REDACTED]');
}

export function truncate(s: string, maxLen = 2000): string {
  if (!s) return '';
  return s.length > maxLen ? s.substring(0, maxLen) + '...[truncated]' : s;
}

// ─── Safety assertions (extracted for testability) ───────────────────────

/**
 * Validates the CLI configuration against ALL safety requirements.
 * Returns null on success or a list of violation strings.
 *
 * This is the central guard — any caller that bypasses it can cause
 * over-budget runs, accidental consensus calls, or unsanitized logs.
 * The runner's main() calls this before doing ANYTHING.
 */
export function validateCliSafety(cli: Cli): { ok: boolean; violations: readonly string[] } {
  const violations: string[] = [];
  if (!cli.noConsensus) violations.push('--no-consensus required');
  if (!cli.noDryrunFalse) violations.push('--no-dryrun-false required');
  if (!cli.sanitize) violations.push('--sanitize required');
  if (cli.maxTotalCostUsd > 0.03) violations.push(`--max-total-cost-usd ${cli.maxTotalCostUsd} exceeds 0.03 hard cap`);
  if (cli.maxTotalCostUsd <= 0) violations.push(`--max-total-cost-usd must be > 0`);
  if (cli.maxTokens <= 0 || cli.maxTokens > 4096) violations.push(`--max-tokens ${cli.maxTokens} out of [1, 4096]`);
  if (cli.maxModels <= 0) violations.push(`--max-models must be > 0`);
  if (cli.maxTasks <= 0) violations.push(`--max-tasks must be > 0`);
  return { ok: violations.length === 0, violations };
}

/**
 * Estimates worst-case cost for a candidate × task matrix.
 * Used by pre-billable validation AND by the per-call budget guard.
 *
 * Conservative: assumes output uses max tokens at the candidate's
 * stated output cost (per 1M), times a safety multiplier.
 */
export function estimateWorstCaseUsd(opts: {
  candidates: ReadonlyArray<{ outputCostPer1MUsd?: number }>;
  taskCount: number;
  maxTokens: number;
  safetyMultiplier?: number;
  fallbackCostPer1M?: number;
}): number {
  const safety = opts.safetyMultiplier ?? 1.5;
  const fallback = opts.fallbackCostPer1M ?? 5;
  let total = 0;
  for (const c of opts.candidates) {
    const costPer1M = c.outputCostPer1MUsd ?? fallback;
    total += (costPer1M * opts.maxTokens / 1_000_000) * safety * opts.taskCount;
  }
  return total;
}

/**
 * Detects hidden fallback by comparing requested route to response route.
 * If the API silently routed to a different provider/model, that
 * invalidates the benchmark — the wave should abort.
 */
export function detectHiddenFallback(opts: {
  requestedProviderId: string;
  requestedApiModelId: string;
  responseProviderId?: string;
  responseModelId?: string;
}): boolean {
  if (!opts.responseModelId && !opts.responseProviderId) return false; // no response signal
  const reqModelLc = opts.requestedApiModelId.toLowerCase();
  const resModelLc = (opts.responseModelId ?? '').toLowerCase();
  const reqProvLc = opts.requestedProviderId.toLowerCase();
  const resProvLc = (opts.responseProviderId ?? '').toLowerCase();
  // Model: shares first stem (loose match — providers sometimes return canonical version like "claude-3.5-sonnet-20240620" for "claude-3.5-sonnet")
  const reqStem = reqModelLc.split('-')[0];
  const modelMatches = !resModelLc || resModelLc.includes(reqStem);
  const providerMatches = !resProvLc || resProvLc === reqProvLc;
  return !(modelMatches && providerMatches);
}

// ─── Chat call ────────────────────────────────────────────────────────────

interface ChatCallResult {
  ok: boolean;
  status: number;
  output: string;
  responseProviderId?: string;
  responseModelId?: string;
  tokens?: { prompt?: number; completion?: number; total?: number };
  costUsd: number;
  latencyMs: number;
  errorKind?: string;
  errorMessage?: string;
}

async function callChatCompletion(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}): Promise<ChatCallResult> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'X-Ailin-Eval-Trace': 'true',
      },
      body: JSON.stringify({
        // 01C.1B-J2-C-R1: SINGLE-MODEL request. NO consensus. NO dryRun field.
        model: opts.model,
        messages: [{ role: 'user', content: opts.prompt }],
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const latency = Date.now() - t0;
    const status = res.status;
    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        status,
        output: '',
        costUsd: 0,
        latencyMs: latency,
        errorKind: `http_${status}`,
        errorMessage: sanitize(truncate(text, 400)),
      };
    }
    const data: unknown = await res.json();
    const obj = data as Record<string, unknown>;
    const choices = obj.choices as Array<{ message?: { content?: string } }> | undefined;
    const output = choices?.[0]?.message?.content ?? '';
    const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost_usd?: number } | undefined;
    const metadata = obj.ailin_metadata as { providerId?: string; modelId?: string; cost?: { totalUsd?: number } } | undefined;
    const costUsd = usage?.cost_usd ?? metadata?.cost?.totalUsd ?? 0;
    return {
      ok: true,
      status,
      output,
      responseProviderId: metadata?.providerId,
      responseModelId: typeof obj.model === 'string' ? obj.model : metadata?.modelId,
      tokens: { prompt: usage?.prompt_tokens, completion: usage?.completion_tokens, total: usage?.total_tokens },
      costUsd,
      latencyMs: latency,
    };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      status: 0,
      output: '',
      costUsd: 0,
      latencyMs: Date.now() - t0,
      errorKind: err.name === 'AbortError' ? 'timeout' : 'network_error',
      errorMessage: sanitize(truncate(String(err.message), 400)),
    };
  }
}

// ─── Snapshot builder ─────────────────────────────────────────────────────

function buildSnapshotFromAttempts(opts: {
  attempts: readonly Attempt[];
  candidates: readonly CandidateRow[];
  sourceArtifacts: readonly string[];
}): ReturnType<typeof buildSnapshot> {
  // Group attempts by canonical modelId
  const byModel = new Map<string, Attempt[]>();
  for (const a of opts.attempts) {
    const key = a.canonicalModelId;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(a);
  }

  const entries: ModelQualityCalibrationEntry[] = [];
  for (const [modelId, atts] of byModel.entries()) {
    const okAtts = atts.filter((a) => a.ok && a.evaluationScore !== undefined);
    if (okAtts.length === 0) {
      // All failed — produce a placeholder entry so the snapshot covers it
      const cand = opts.candidates.find((c) => c.canonicalModelId === modelId);
      entries.push({
        modelId,
        canonicalModelId: modelId,
        family: cand?.family,
        providerCoverageCount: cand?.providersCount,
        qualityScore: 0.5, // neutral default for failed-benchmark; below floor 0.6
        qualityScoreSource: 'unknown',
        qualityConfidence: 'placeholder',
        warnings: ['benchmark_failed_all_attempts'],
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    // Aggregate quality scores across tasks
    const aggregateScore = okAtts.reduce((s, a) => s + (a.evaluationScore ?? 0), 0) / okAtts.length;
    const totalCost = atts.reduce((s, a) => s + a.costUsd, 0);
    const latencies = okAtts.map((a) => a.latencyMs).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length / 2)];
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];

    // Aggregate dimension scores (average across tasks per dimension)
    const dimAccum: Record<string, { sum: number; count: number }> = {};
    for (const a of okAtts) {
      for (const [dim, score] of Object.entries(a.evaluationDimensions ?? {})) {
        if (!dimAccum[dim]) dimAccum[dim] = { sum: 0, count: 0 };
        dimAccum[dim].sum += score;
        dimAccum[dim].count += 1;
      }
    }
    const dimensionScores: Record<string, number> = {};
    for (const [dim, { sum, count }] of Object.entries(dimAccum)) {
      dimensionScores[dim] = +(sum / count).toFixed(4);
    }

    const cand = opts.candidates.find((c) => c.canonicalModelId === modelId);
    entries.push({
      modelId,
      canonicalModelId: modelId,
      family: cand?.family,
      providerCoverageCount: cand?.providersCount,
      qualityScore: +Math.max(0, Math.min(1, aggregateScore)).toFixed(4),
      qualityScoreSource: 'internal_benchmark',
      qualityConfidence: okAtts.length >= 4 ? 'high' : okAtts.length >= 2 ? 'medium' : 'low',
      dimensionScores: dimensionScores as ModelQualityCalibrationEntry['dimensionScores'],
      benchmarkTaskIds: Array.from(new Set(okAtts.map((a) => a.taskId))),
      sampleCount: okAtts.length,
      costUsd: +totalCost.toFixed(6),
      latencyMsP50: p50,
      latencyMsP95: p95,
      warnings: okAtts.length < 2 ? ['low_sample_count_use_with_caution'] : [],
      createdAt: new Date().toISOString(),
    });
  }

  return buildSnapshot({
    version: `1.0.0-real-${new Date().toISOString().substring(0, 10)}`,
    sourceArtifacts: opts.sourceArtifacts,
    entries,
  });
}

// ─── Main runner ──────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  // Safety: centralized assertions (see validateCliSafety for the contract).
  const safetyCheck = validateCliSafety(cli);
  if (!safetyCheck.ok) {
    throw new Error('SAFETY violations:\n  - ' + safetyCheck.violations.join('\n  - '));
  }

  // PROBE_API_KEY required
  const apiKey = process.env.PROBE_API_KEY;
  if (!apiKey) {
    console.error('PROBE_API_KEY missing — cannot execute benchmark.');
    process.exit(2);
  }

  // Load inputs
  const candidateSetRaw = JSON.parse(fs.readFileSync(cli.candidateSet, 'utf8')) as { candidates?: CandidateRow[] };
  const tasksRaw = JSON.parse(fs.readFileSync(cli.tasks, 'utf8')) as { tasks?: BenchmarkTask[] };
  const candidates: CandidateRow[] = (candidateSetRaw.candidates ?? []).slice(0, cli.maxModels);
  const tasks: BenchmarkTask[] = (tasksRaw.tasks ?? []).slice(0, cli.maxTasks);
  if (candidates.length < 2) throw new Error('not enough candidates');
  if (tasks.length < 1) throw new Error('no tasks');

  // Load/init ledger
  let ledger: Ledger;
  if (fs.existsSync(cli.ledger)) {
    ledger = JSON.parse(fs.readFileSync(cli.ledger, 'utf8')) as Ledger;
  } else {
    ledger = {
      stage: '01C.1B-J2-C-R1',
      maxTotalBudgetUsd: cli.maxTotalCostUsd,
      spentUsd: 0,
      remainingUsd: cli.maxTotalCostUsd,
      dryRunFalseExecuted: false,
      realConsensusExecuted: false,
      benchmarkProviderCalls: 0,
      status: 'running',
      entries: [],
    };
  }
  // The runner uses an effective budget = min(ledger.maxTotalBudgetUsd, cli.maxTotalCostUsd).
  // Wave 1 runs first with $0.01 cap even when the ledger allows $0.03 total — this lets
  // Wave 2 use the same ledger without re-init.
  const effectiveMaxCost = Math.min(ledger.maxTotalBudgetUsd, cli.maxTotalCostUsd);

  const attempts: Attempt[] = [];
  let attemptCounter = 0;

  // Iterate candidates × tasks
  outer: for (const cand of candidates) {
    if (cand.benchmarkable === false || cand.blockedReason) {
      console.error(`SKIP ${cand.canonicalModelId}: ${cand.blockedReason ?? 'not benchmarkable'}`);
      continue;
    }
    for (const task of tasks) {
      attemptCounter += 1;
      const attemptId = `j2c-r1-${attemptCounter}-${cand.canonicalModelId}-${task.taskId}`;

      // Conservative cost estimate: assume max tokens * max cost
      // (input cost is small; output cost dominates). We don't know exact
      // cost without making the call, so estimate at 2x input cost as a
      // safety margin and stop EARLY if we'd exceed budget.
      const estimatedNextCallUsd = (cand.outputCostPer1MUsd ?? 5) * cli.maxTokens / 1_000_000 * 1.5;
      if (ledger.spentUsd + estimatedNextCallUsd > effectiveMaxCost) {
        attempts.push({
          attemptId,
          modelId: cand.canonicalModelId,
          canonicalModelId: cand.canonicalModelId,
          providerId: cand.providerId,
          routeId: cand.routeId,
          apiModelId: cand.apiModelId,
          taskId: task.taskId,
          status: 'budget_stop',
          ok: false,
          errorKind: 'budget_would_exceed',
          errorMessage: `next call est=$${estimatedNextCallUsd.toFixed(6)} + spent=$${ledger.spentUsd.toFixed(6)} > cap=$${effectiveMaxCost}`,
          costUsd: 0,
          latencyMs: 0,
        });
        ledger.status = 'budget_exhausted';
        break outer;
      }

      // The actual call. Locked to the EXACT api_model_id from the candidate set.
      const call = await callChatCompletion({
        baseUrl: cli.apiBaseUrl,
        apiKey,
        model: cand.apiModelId, // ROUTE LOCK
        prompt: task.prompt,
        maxTokens: cli.maxTokens,
        temperature: cli.temperature,
        timeoutMs: (task as { timeoutMs?: number }).timeoutMs ?? 30000,
      });

      // Detect hidden fallback: did the response come back from a DIFFERENT
      // provider/model than what we requested? If so, the route lock failed.
      const hiddenFallback = call.ok && detectHiddenFallback({
        requestedProviderId: cand.providerId,
        requestedApiModelId: cand.apiModelId,
        responseProviderId: call.responseProviderId,
        responseModelId: call.responseModelId,
      });

      let evaluation: ReturnType<typeof evaluateTaskOutput> | undefined;
      if (call.ok && call.output) {
        evaluation = evaluateTaskOutput(task, call.output);
      }

      const attempt: Attempt = {
        attemptId,
        modelId: cand.canonicalModelId,
        canonicalModelId: cand.canonicalModelId,
        providerId: cand.providerId,
        routeId: cand.routeId,
        apiModelId: cand.apiModelId,
        taskId: task.taskId,
        status: hiddenFallback ? 'route_mismatch' : call.ok ? 'ok' : 'failed',
        ok: call.ok && !hiddenFallback,
        errorKind: call.errorKind,
        errorMessage: call.errorMessage,
        outputPreview: call.ok ? sanitize(truncate(call.output, 400)) : undefined,
        outputLen: call.output.length,
        responseProviderId: call.responseProviderId,
        responseModelId: call.responseModelId,
        hiddenFallbackUsed: hiddenFallback,
        outOfPlanRoute: hiddenFallback,
        tokens: call.tokens,
        costUsd: call.costUsd,
        latencyMs: call.latencyMs,
        evaluationScore: evaluation?.score,
        evaluationDimensions: evaluation?.dimensionScores,
        evaluationNotes: evaluation?.notes,
      };
      attempts.push(attempt);

      // Ledger update (atomic write per attempt)
      ledger.spentUsd = +(ledger.spentUsd + call.costUsd).toFixed(8);
      ledger.remainingUsd = +(effectiveMaxCost - ledger.spentUsd).toFixed(8);
      ledger.benchmarkProviderCalls += 1;
      ledger.entries.push({
        attemptId,
        modelId: cand.canonicalModelId,
        taskId: task.taskId,
        costUsd: call.costUsd,
        status: attempt.status,
      });
      fs.writeFileSync(cli.ledger, JSON.stringify(ledger, null, 2));

      // Stop on hidden fallback — failing closed protects against silent
      // route substitution that would invalidate the whole benchmark.
      if (hiddenFallback) {
        console.error(`HIDDEN FALLBACK detected for ${cand.canonicalModelId} → response from ${call.responseModelId}@${call.responseProviderId}; stopping wave`);
        ledger.status = 'route_mismatch_aborted';
        fs.writeFileSync(cli.ledger, JSON.stringify(ledger, null, 2));
        break outer;
      }
    }
  }

  // Build snapshot from attempts
  const snapshot = buildSnapshotFromAttempts({
    attempts,
    candidates,
    sourceArtifacts: [cli.candidateSet, cli.tasks],
  });
  const snapshotHash = computeSnapshotHash(snapshot);

  // Finalize ledger
  if (ledger.status === 'running') ledger.status = 'completed';
  fs.writeFileSync(cli.ledger, JSON.stringify(ledger, null, 2));

  // Write results JSON
  const results = {
    generatedAt: new Date().toISOString(),
    stage: '01C.1B-J2-C-R1',
    config: {
      maxModels: cli.maxModels,
      maxTasks: cli.maxTasks,
      maxTotalCostUsd: cli.maxTotalCostUsd,
      maxTokens: cli.maxTokens,
      temperature: cli.temperature,
    },
    totals: {
      modelsAttempted: new Set(attempts.map((a) => a.canonicalModelId)).size,
      tasksAttempted: new Set(attempts.map((a) => a.taskId)).size,
      attempts: attempts.length,
      succeeded: attempts.filter((a) => a.ok).length,
      failed: attempts.filter((a) => a.status === 'failed').length,
      routeMismatches: attempts.filter((a) => a.status === 'route_mismatch').length,
      budgetStops: attempts.filter((a) => a.status === 'budget_stop').length,
      totalCostUsd: ledger.spentUsd,
      totalCalls: ledger.benchmarkProviderCalls,
      dryRunFalseExecuted: ledger.dryRunFalseExecuted,
      realConsensusExecuted: ledger.realConsensusExecuted,
    },
    attempts,
    snapshotHash,
    snapshotVersion: snapshot.version,
    snapshotPath: cli.writeQualitySnapshot,
  };
  fs.writeFileSync(cli.writeJson, JSON.stringify(results, null, 2));

  // Write snapshot
  fs.writeFileSync(cli.writeQualitySnapshot, JSON.stringify(snapshot, null, 2));

  // Write markdown summary
  const md = [
    '# 01C.1B-J2-C-R1 — Quality Benchmark Results',
    '',
    `Generated: ${results.generatedAt}`,
    `Snapshot version: ${snapshot.version}`,
    `Snapshot hash: \`${snapshotHash}\``,
    '',
    '## Totals',
    `- Models attempted: ${results.totals.modelsAttempted}`,
    `- Tasks attempted: ${results.totals.tasksAttempted}`,
    `- Total attempts: ${results.totals.attempts}`,
    `- Succeeded: ${results.totals.succeeded}`,
    `- Failed: ${results.totals.failed}`,
    `- Route mismatches (HIDDEN FALLBACK): ${results.totals.routeMismatches}`,
    `- Budget stops: ${results.totals.budgetStops}`,
    `- Total cost USD: $${results.totals.totalCostUsd.toFixed(6)}`,
    `- Total provider calls: ${results.totals.totalCalls}`,
    '',
    '## Per-model summary (top 16 by quality)',
    '| Model | Family | Score | Source | Confidence | Samples | Cost USD |',
    '|-------|--------|------:|--------|------------|--------:|---------:|',
    ...snapshot.entries
      .slice()
      .sort((a, b) => b.qualityScore - a.qualityScore)
      .slice(0, 16)
      .map((e) =>
        `| \`${e.modelId}\` | ${e.family ?? '—'} | ${e.qualityScore.toFixed(3)} | ${e.qualityScoreSource} | ${e.qualityConfidence} | ${e.sampleCount ?? 0} | $${(e.costUsd ?? 0).toFixed(6)} |`),
  ];
  fs.writeFileSync(cli.writeMd, md.join('\n'));

  console.log(JSON.stringify({
    totals: results.totals,
    snapshotHash,
    snapshotVersion: snapshot.version,
  }, null, 2));
}

// Only run main() when invoked as a script, NOT when imported by a test.
// `require.main === module` is the CJS idiom; for tsx/ESM we can also
// check process.argv[1] but tsx compiles to CJS by default in this repo.
const isCjsMainModule =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isCjsMainModule) {
  main().catch((e) => {
    console.error('runner_fatal:', sanitize(String((e as Error).message)));
    process.exit(1);
  });
}
