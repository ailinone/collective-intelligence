// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import path from 'node:path';
import {
  OUTPUT_DIR,
  SCENARIO_FAMILIES,
  STRATEGIES,
  type BenchmarkMetrics,
  type EvalRequestRecord,
  type EvalStage,
  average,
  ensureOutputDir,
  getApiKey,
  getApiBaseUrl,
  getBearerToken,
  getJwtExpirationEpoch,
  getRefreshToken,
  getCriticalScenarios,
  inferProvider404,
  inferRetryableFailure,
  p95,
  requestJsonWithTimeout,
  toFixedNumber,
  writeJsonFile,
  writeJsonlFile,
} from './enterprise-eval-shared';

interface BenchmarkTask {
  id: string;
  family: string;
  scenario: string;
  strategy: string;
  critical: boolean;
}

interface EvalAuthState {
  bearerToken?: string;
  refreshToken?: string;
  apiKey?: string;
}

function parsePositiveIntEnv(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

const REQUEST_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.EVAL_REQUEST_TIMEOUT_MS,
  45_000
);
const CONCURRENCY_OVERRIDE = (() => {
  const raw = process.env.EVAL_CONCURRENCY;
  if (!raw) return null;
  return parsePositiveIntEnv(raw, 0) || null;
})();
const API_KEY_DEFAULT_CONCURRENCY = parsePositiveIntEnv(
  process.env.EVAL_API_KEY_DEFAULT_CONCURRENCY,
  4
);
const BEARER_DEFAULT_CONCURRENCY = parsePositiveIntEnv(
  process.env.EVAL_BEARER_DEFAULT_CONCURRENCY,
  1
);
const BEARER_INTER_REQUEST_DELAY_MS = parsePositiveIntEnv(
  process.env.EVAL_BEARER_INTER_REQUEST_DELAY_MS,
  150
);
const API_KEY_INTER_REQUEST_DELAY_MS = parsePositiveIntEnv(
  process.env.EVAL_API_KEY_INTER_REQUEST_DELAY_MS,
  0
);
const FULL_ROUNDS = 1;
const CRITICAL_REPEATS = 3;
const MAX_ATTEMPTS = parsePositiveIntEnv(process.env.EVAL_MAX_ATTEMPTS, 3);
const RETRY_BASE_DELAY_MS = Math.max(
  100,
  parsePositiveIntEnv(process.env.EVAL_RETRY_BASE_DELAY_MS, 1000)
);
const REQUEST_JITTER_MS = Math.max(
  0,
  parsePositiveIntEnv(process.env.EVAL_REQUEST_JITTER_MS, 0)
);
const CLEAR_CACHE_BEFORE_RUN = process.env.EVAL_CLEAR_CACHE_BEFORE_RUN !== 'false';
const EXPLICIT_STRATEGY_SET = new Set(['single', 'cost', 'quality', 'parallel', 'debate']);

function expectedResolvedCanonicalStrategy(
  strategy: string
): string | undefined {
  switch (strategy) {
    case 'single':
      return 'single';
    case 'cost':
      return 'cost';
    case 'quality':
      return 'quality_multipass';
    case 'parallel':
      return 'parallel';
    case 'debate':
      return 'debate';
    default:
      return undefined;
  }
}

function parseStage(): EvalStage {
  const stageArgIndex = process.argv.findIndex((arg) => arg === '--stage');
  const value = stageArgIndex >= 0 ? process.argv[stageArgIndex + 1] : undefined;
  if (value === 'baseline' || value === 'remediated') {
    return value;
  }
  return 'baseline';
}

function buildTasks(): BenchmarkTask[] {
  const criticalSet = new Set(
    getCriticalScenarios().map((scenario) => `${scenario.family}::${scenario.scenario}`)
  );

  const tasks: BenchmarkTask[] = [];
  let counter = 0;

  for (let round = 0; round < FULL_ROUNDS; round++) {
    for (const family of SCENARIO_FAMILIES) {
      for (const scenario of family.prompts) {
        for (const strategy of STRATEGIES) {
          counter += 1;
          tasks.push({
            id: `full-${round + 1}-${counter}`,
            family: family.family,
            scenario,
            strategy,
            critical: criticalSet.has(`${family.family}::${scenario}`),
          });
        }
      }
    }
  }

  for (let repeat = 0; repeat < CRITICAL_REPEATS; repeat++) {
    for (const criticalScenario of getCriticalScenarios()) {
      for (const strategy of STRATEGIES) {
        counter += 1;
        tasks.push({
          id: `critical-${repeat + 1}-${counter}`,
          family: criticalScenario.family,
          scenario: criticalScenario.scenario,
          strategy,
          critical: true,
        });
      }
    }
  }

  return tasks;
}

function buildAuthState(): EvalAuthState {
  const apiKey = getApiKey();
  const bearerToken = getBearerToken();
  const refreshToken = getRefreshToken();

  return {
    apiKey: apiKey || undefined,
    bearerToken: bearerToken || undefined,
    refreshToken: refreshToken || undefined,
  };
}

function buildAuthHeaders(authState: EvalAuthState): Record<string, string> {
  if (authState.apiKey) {
    return { 'x-api-key': authState.apiKey };
  }
  if (authState.bearerToken) {
    return { Authorization: `Bearer ${authState.bearerToken}` };
  }
  return {};
}

function resolveConcurrency(authState: EvalAuthState): number {
  if (CONCURRENCY_OVERRIDE !== null) {
    return CONCURRENCY_OVERRIDE;
  }

  return authState.apiKey ? API_KEY_DEFAULT_CONCURRENCY : BEARER_DEFAULT_CONCURRENCY;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 0 || statusCode === 408 || statusCode === 429 || statusCode === 503 || statusCode === 504;
}

function computeRetryDelayMs(attempt: number): number {
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(10_000, exponential + jitter);
}

function parseRetryAfterMs(rawValue: string | undefined): number {
  if (!rawValue) {
    return 0;
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return 0;
  }

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.min(60_000, Math.ceil(asSeconds * 1000));
  }

  const retryAt = Date.parse(trimmed);
  if (Number.isFinite(retryAt)) {
    const delta = retryAt - Date.now();
    if (delta > 0) {
      return Math.min(60_000, delta);
    }
  }

  return 0;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryRefreshBearerToken(
  baseUrl: string,
  authState: EvalAuthState
): Promise<boolean> {
  if (!authState.refreshToken) {
    return false;
  }

  try {
    const response = await requestJsonWithTimeout(
      `${baseUrl}/v1/auth/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: authState.refreshToken }),
      },
      15_000
    );

    if (response.status < 200 || response.status >= 300) {
      return false;
    }

    const payload = response.json as {
      tokens?: { accessToken?: string; refreshToken?: string };
    };
    const newAccessToken = payload?.tokens?.accessToken;
    if (typeof newAccessToken !== 'string' || newAccessToken.length === 0) {
      return false;
    }

    authState.bearerToken = newAccessToken;
    const maybeNewRefresh = payload?.tokens?.refreshToken;
    if (typeof maybeNewRefresh === 'string' && maybeNewRefresh.length > 0) {
      authState.refreshToken = maybeNewRefresh;
    }

    console.log('[benchmark] bearer token refreshed successfully');
    return true;
  } catch {
    return false;
  }
}

async function clearBenchmarkCache(
  stage: EvalStage,
  baseUrl: string,
  authState: EvalAuthState
): Promise<void> {
  if (!CLEAR_CACHE_BEFORE_RUN) {
    return;
  }

  try {
    const response = await requestJsonWithTimeout(
      `${baseUrl}/v1/cache/clear`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(authState),
        },
        body: JSON.stringify({}),
      },
      15_000
    );

    if (response.status >= 200 && response.status < 300) {
      console.log(`[benchmark:${stage}] cache cleared before run`);
      return;
    }

    console.warn(
      `[benchmark:${stage}] warning: failed to clear cache before run (status=${response.status})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[benchmark:${stage}] warning: cache clear request failed (${message})`);
  }
}

async function executeTask(
  stage: EvalStage,
  baseUrl: string,
  authState: EvalAuthState,
  task: BenchmarkTask
): Promise<EvalRequestRecord> {
  const singleModel = process.env.EVAL_SINGLE_MODEL || 'gpt-4o-mini';
  const model = task.strategy === 'single' ? singleModel : 'auto';
  const payload = {
    model,
    strategy: task.strategy,
    temperature: 0.1,
    max_tokens: 300,
    messages: [{ role: 'user', content: task.scenario }],
  };

  const startedAt = Date.now();
  let statusCode = 0;
  let parsedBody: unknown = null;
  let rawText = '';
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;

    if (REQUEST_JITTER_MS > 0) {
      await sleep(Math.floor(Math.random() * REQUEST_JITTER_MS));
    }

    try {
      const response = await requestJsonWithTimeout(
        `${baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAuthHeaders(authState),
          },
          body: JSON.stringify(payload),
        },
        REQUEST_TIMEOUT_MS
      );

      statusCode = response.status;
      parsedBody = response.json;
      rawText = response.text;
      const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']);

      if (
        statusCode === 401 &&
        !authState.apiKey &&
        attempt < MAX_ATTEMPTS &&
        (await tryRefreshBearerToken(baseUrl, authState))
      ) {
        continue;
      }

      if (isRetryableStatus(statusCode) && attempt < MAX_ATTEMPTS) {
        const computedDelay = computeRetryDelayMs(attempt);
        const delayMs = statusCode === 429 ? Math.max(computedDelay, retryAfterMs) : computedDelay;
        await sleep(delayMs);
        continue;
      }

      break;
    } catch (error) {
      statusCode = 0;
      parsedBody = null;
      rawText = error instanceof Error ? error.message : String(error);

      if (attempt < MAX_ATTEMPTS) {
        await sleep(computeRetryDelayMs(attempt));
        continue;
      }
      break;
    }
  }

  const latencyMs = Date.now() - startedAt;
  const body = parsedBody as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    ailin_metadata?: {
      resolved_model?: string;
      resolved_strategy?: string;
      fallback_chain?: string[];
      cost_usd?: number;
    };
    error?: { code?: string; message?: string };
  };

  const content = body?.choices?.[0]?.message?.content || '';
  const errorCode = body?.error?.code;
  const errorMessage = body?.error?.message || rawText;
  const resolvedStrategy = body?.ailin_metadata?.resolved_strategy;
  const requestedCanonicalStrategy = expectedResolvedCanonicalStrategy(task.strategy);
  const strategyConformant =
    requestedCanonicalStrategy !== undefined
      ? resolvedStrategy === requestedCanonicalStrategy
      : undefined;

  return {
    id: task.id,
    stage,
    family: task.family,
    scenario: task.scenario,
    strategy: task.strategy,
    model,
    critical: task.critical,
    statusCode,
    ok: statusCode >= 200 && statusCode < 300 && content.length > 0,
    latencyMs,
    timestamp: new Date().toISOString(),
    responseChars: content.length,
    resolvedModel:
      body?.ailin_metadata?.resolved_model ||
      (typeof body?.model === 'string' ? body.model : undefined),
    resolvedStrategy,
    requestedCanonicalStrategy,
    strategyConformant,
    fallbackChain: Array.isArray(body?.ailin_metadata?.fallback_chain)
      ? body.ailin_metadata.fallback_chain
      : undefined,
    costUsd:
      typeof body?.ailin_metadata?.cost_usd === 'number'
        ? body.ailin_metadata.cost_usd
        : undefined,
    errorCode,
    errorMessage:
      statusCode >= 200 && statusCode < 300
        ? undefined
        : `${errorMessage}${attempt > 1 ? ` (attempts=${attempt})` : ''}`,
  };
}

async function executeWithConcurrency(
  stage: EvalStage,
  baseUrl: string,
  authState: EvalAuthState,
  tasks: BenchmarkTask[],
  concurrency: number
): Promise<EvalRequestRecord[]> {
  const queue = [...tasks];
  const results: EvalRequestRecord[] = [];

  const workers = Array.from({ length: concurrency }).map(async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const result = await executeTask(stage, baseUrl, authState, next);
      results.push(result);
      const progress = `${results.length}/${tasks.length}`;
      if (results.length % 25 === 0 || !result.ok) {
        console.log(
          `[benchmark:${stage}] progress=${progress} strategy=${result.strategy} status=${result.statusCode} ok=${result.ok}`
        );
      }

      if (!authState.apiKey && BEARER_INTER_REQUEST_DELAY_MS > 0) {
        await sleep(BEARER_INTER_REQUEST_DELAY_MS);
      } else if (authState.apiKey && API_KEY_INTER_REQUEST_DELAY_MS > 0) {
        await sleep(API_KEY_INTER_REQUEST_DELAY_MS);
      }
    }
  });

  await Promise.all(workers);
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

function buildMetrics(
  stage: EvalStage,
  baseUrl: string,
  records: EvalRequestRecord[],
  concurrency: number
): BenchmarkMetrics {
  const totalRequests = records.length;
  const successes = records.filter((record) => record.ok);
  const critical = records.filter((record) => record.critical);
  const criticalSuccess = critical.filter((record) => record.ok);

  const provider404Rate =
    totalRequests === 0
      ? 0
      : records.filter((record) => inferProvider404(record)).length / totalRequests;

  const retryableFailures = records.filter((record) => inferRetryableFailure(record));
  const fallbackSuccesses = successes.filter(
    (record) => Array.isArray(record.fallbackChain) && record.fallbackChain.length > 1
  );
  const fallbackOpportunityDenominator =
    retryableFailures.length + fallbackSuccesses.length > 0
      ? retryableFailures.length + fallbackSuccesses.length
      : 1;
  const fallbackSuccessRate = fallbackSuccesses.length / fallbackOpportunityDenominator;

  const avgCostPerRequest = average(
    successes
      .map((record) => record.costUsd)
      .filter((value): value is number => typeof value === 'number')
  );
  const explicitRecords = records.filter(
    (record) => EXPLICIT_STRATEGY_SET.has(record.strategy) && typeof record.strategyConformant === 'boolean'
  );
  const explicitConformant = explicitRecords.filter(
    (record) => record.strategyConformant === true
  );
  const explicitStrategyConformanceRate =
    explicitRecords.length > 0 ? explicitConformant.length / explicitRecords.length : 1;

  const statusCounts = records.reduce<Record<string, number>>((acc, record) => {
    const key = String(record.statusCode);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const topErrors = Array.from(
    records
      .filter((record) => !record.ok && record.errorMessage)
      .reduce<Map<string, number>>((acc, record) => {
        const message = record.errorMessage || 'unknown_error';
        acc.set(message, (acc.get(message) || 0) + 1);
        return acc;
      }, new Map())
      .entries()
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([message, count]) => ({ message, count }));

  const strategyMetrics = STRATEGIES.map((strategy) => {
    const scoped = records.filter((record) => record.strategy === strategy);
    const scopedSuccess = scoped.filter((record) => record.ok);
    const scopedCosts = scopedSuccess
      .map((record) => record.costUsd)
      .filter((value): value is number => typeof value === 'number');
    return {
      strategy,
      totalRequests: scoped.length,
      successRate: scoped.length > 0 ? scopedSuccess.length / scoped.length : 0,
      p95LatencyMs: p95(scopedSuccess.map((record) => record.latencyMs)),
      avgCostPerRequest: average(scopedCosts),
    };
  });

  const p95ByStrategy = strategyMetrics.reduce<Record<string, number>>((acc, metric) => {
    acc[metric.strategy] = toFixedNumber(metric.p95LatencyMs, 3);
    return acc;
  }, {});
  const explicitStrategyConformanceByStrategy = STRATEGIES.filter((strategy) =>
    EXPLICIT_STRATEGY_SET.has(strategy)
  ).map((strategy) => {
    const scoped = records.filter(
      (record) =>
        record.strategy === strategy &&
        typeof record.strategyConformant === 'boolean'
    );
    const conformant = scoped.filter((record) => record.strategyConformant === true).length;
    return {
      strategy,
      requests: scoped.length,
      conformant,
      rate: toFixedNumber(scoped.length > 0 ? conformant / scoped.length : 1),
    };
  });

  const successRate = totalRequests > 0 ? successes.length / totalRequests : 0;
  const criticalSuccessRate =
    critical.length > 0 ? criticalSuccess.length / critical.length : 0;

  const latencySlaPass = strategyMetrics.every((metric) => {
    const highLatencyStrategies = new Set(['parallel', 'debate', 'quality_multipass']);
    const threshold = highLatencyStrategies.has(metric.strategy) ? 20_000 : 12_000;
    return metric.p95LatencyMs <= threshold;
  });

  return {
    stage,
    generatedAt: new Date().toISOString(),
    baseUrl,
    concurrency,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    totalRequests,
    totalSuccess: successes.length,
    successRate: toFixedNumber(successRate),
    criticalRequests: critical.length,
    criticalSuccessRate: toFixedNumber(criticalSuccessRate),
    provider404Rate: toFixedNumber(provider404Rate),
    fallbackSuccessRate: toFixedNumber(fallbackSuccessRate),
    explicitStrategyConformanceRate: toFixedNumber(explicitStrategyConformanceRate),
    avgCostPerRequest: toFixedNumber(avgCostPerRequest),
    statusCounts,
    topErrors,
    p95ByStrategy,
    explicitStrategyConformanceByStrategy,
    strategyMetrics: strategyMetrics.map((metric) => ({
      ...metric,
      successRate: toFixedNumber(metric.successRate),
      p95LatencyMs: toFixedNumber(metric.p95LatencyMs, 3),
      avgCostPerRequest: toFixedNumber(metric.avgCostPerRequest),
    })),
    gate: {
      successRateGlobalPass: successRate >= 0.97,
      successRateCriticalPass: criticalSuccessRate >= 0.95,
      provider404RatePass: provider404Rate === 0,
      p95Pass: latencySlaPass,
      fallbackSuccessRatePass: fallbackSuccessRate >= 0.9,
      explicitStrategyConformancePass: explicitStrategyConformanceRate >= 0.95,
    },
  };
}

async function writeFailureReport(
  stage: EvalStage,
  records: EvalRequestRecord[],
  metrics: BenchmarkMetrics
): Promise<void> {
  const failures = records.filter((record) => !record.ok);
  const lines: string[] = [];

  lines.push(`# Benchmark Failures (${stage})`);
  lines.push('');
  lines.push(`Generated at: ${metrics.generatedAt}`);
  lines.push(`Total failures: ${failures.length}`);
  lines.push('');

  const grouped = new Map<string, EvalRequestRecord[]>();
  for (const failure of failures) {
    const key = `${failure.strategy}::${failure.family}`;
    const bucket = grouped.get(key) || [];
    bucket.push(failure);
    grouped.set(key, bucket);
  }

  for (const [key, bucket] of grouped.entries()) {
    lines.push(`## ${key}`);
    for (const entry of bucket.slice(0, 8)) {
      lines.push(
        `- id=${entry.id} status=${entry.statusCode} latencyMs=${entry.latencyMs} error=${entry.errorCode || 'unknown'} message=${entry.errorMessage || 'n/a'}`
      );
    }
    if (bucket.length > 8) {
      lines.push(`- ... and ${bucket.length - 8} more`);
    }
    lines.push('');
  }

  const targetPath = path.resolve(OUTPUT_DIR, `eval-${stage}-failures.md`);
  await fsWriteFile(targetPath, lines.join('\n'));
}

async function fsWriteFile(targetPath: string, content: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(targetPath, content, 'utf8');
}

async function main(): Promise<void> {
  await ensureOutputDir();
  const stage = parseStage();
  const baseUrl = getApiBaseUrl();
  const authState = buildAuthState();
  const concurrency = resolveConcurrency(authState);

  if (!authState.apiKey && !authState.bearerToken) {
    throw new Error(
      'Provide auth for eval benchmark via EVAL_API_KEY (recommended) or EVAL_BEARER_TOKEN.'
    );
  }

  if (authState.bearerToken) {
    const expEpoch = getJwtExpirationEpoch(authState.bearerToken);
    if (expEpoch) {
      const remainingMs = expEpoch * 1000 - Date.now();
      const remainingMin = Math.floor(remainingMs / 60_000);
      if (remainingMs < 15 * 60_000) {
        console.warn(
          `[benchmark:${stage}] warning: bearer token expires in ${remainingMin}m. Consider EVAL_API_KEY or EVAL_REFRESH_TOKEN to avoid 401 mid-run.`
        );
      }
    }
  }

  const tasks = buildTasks();
  await clearBenchmarkCache(stage, baseUrl, authState);
  console.log(
    `[benchmark:${stage}] starting with ${tasks.length} requests (strategies=${STRATEGIES.join(', ')}, concurrency=${concurrency}, maxAttempts=${MAX_ATTEMPTS}, interRequestDelayMs=${authState.apiKey ? API_KEY_INTER_REQUEST_DELAY_MS : BEARER_INTER_REQUEST_DELAY_MS})`
  );

  const records = await executeWithConcurrency(stage, baseUrl, authState, tasks, concurrency);
  const metrics = buildMetrics(stage, baseUrl, records, concurrency);

  const rawPath = path.resolve(OUTPUT_DIR, `eval-${stage}-raw.jsonl`);
  const metricsPath = path.resolve(OUTPUT_DIR, `eval-${stage}-metrics.json`);
  await writeJsonlFile(rawPath, records);
  await writeJsonFile(metricsPath, metrics);
  await writeFailureReport(stage, records, metrics);

  console.log(
    JSON.stringify(
      {
        stage,
        totalRequests: metrics.totalRequests,
        successRate: metrics.successRate,
        criticalSuccessRate: metrics.criticalSuccessRate,
        provider404Rate: metrics.provider404Rate,
        fallbackSuccessRate: metrics.fallbackSuccessRate,
        explicitStrategyConformanceRate: metrics.explicitStrategyConformanceRate,
        gate: metrics.gate,
        outputs: {
          raw: rawPath,
          metrics: metricsPath,
          failures: path.resolve(OUTPUT_DIR, `eval-${stage}-failures.md`),
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('run-enterprise-benchmark failed:', error);
  process.exit(1);
});
