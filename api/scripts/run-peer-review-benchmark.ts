// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operator-runnable CLI for the Zajonc peer-review A/B benchmark (Z-Real).
 *
 * Usage:
 *   pnpm ts-node scripts/run-peer-review-benchmark.ts --run-id=<id> [--suite=representative]
 *
 * Environment:
 *   - Requires the full provider registry (API keys, database, Redis) to be
 *     reachable — this script talks to REAL LLMs and costs real tokens.
 *   - `AILIN_PEER_REVIEW_MODE` is scoped per arm inside the runner; do not
 *     set it in the shell unless you want to constrain both arms to one
 *     mode (which would defeat the purpose of the benchmark).
 *
 * Output:
 *   Writes the benchmark report to `./benchmark-reports/<runId>.json`. The
 *   report includes every sample, per-arm and per-strategy aggregates, and a
 *   machine-readable recommendation (`keep-on` | `flip-off` | `per-strategy`
 *   | `inconclusive`). Operators read the recommendation and decide whether
 *   to change production configuration — the script itself never mutates
 *   production state.
 *
 * Why this lives in `scripts/` and not inside the normal test suite:
 *   - Real provider calls take minutes and cost money.
 *   - The benchmark needs stable production-like infrastructure, which
 *     unit test runners do not have.
 *   - Keeping it as a CLI matches the Lote 3 design contract: "the harness
 *     is a tool, not an automated toggle".
 *
 * To extend the task suite (recommended for a real run):
 *   1. Import additional tasks from your own module conforming to
 *      `BenchmarkTask` from `core/benchmark/peer-review-ab-benchmark`.
 *   2. Replace `REPRESENTATIVE_TASKS` below with the union.
 *   3. Rerun.
 *
 * Status note: the in-session audit run that produced Lote 3 built this
 * harness but could not execute it from the developer environment that had
 * no provider credentials. The file has been left as a committable runner
 * so any operator with staging credentials can execute it on demand with
 * zero code changes.
 */

import { promises as fs } from 'fs';
import path from 'path';

import {
  runPeerReviewABBenchmark,
  createEngineRunner,
  REPRESENTATIVE_TASKS,
  normalizeJudgeOutput,
  type EngineExecuteFn,
  type QualityJudge,
} from '@/core/benchmark/peer-review-ab-benchmark';
import { JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS } from '@/core/quality/judge-schema';

function parseArgs(argv: string[]): { runId: string } {
  const runIdArg = argv.find((a) => a.startsWith('--run-id='));
  const runId = runIdArg?.split('=')[1] || `peer-review-ab-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return { runId };
}

/**
 * Bootstrap the provider registry the same way `src/index.ts` does at API
 * startup. The ORDER matters and must mirror the server's phase sequence:
 *
 *   1. `initializeSecretsManager(config.secrets)` — wires the Secret Manager
 *      client. Without this, `loadSecret()` silently falls back to
 *      `process.env` for every key, which means a local run with one API
 *      key leaked in the shell ends up with 60/60 secrets "skipped".
 *      That was the root cause of `local-run-2` producing 0/10 successes.
 *   2. `loadSecretsIntoEnv()` — now has a real Secret Manager to pull from.
 *   3. `initializeProviderRegistry(config.providers)` — filters by API key
 *      presence at initialization time; every provider now has its key.
 *   4. `setProviderRegistry(registry)` — stores the singleton so
 *      `getProviderRegistry()` returns the real instance, not the empty
 *      fallback.
 */
async function bootstrapProviderRegistry(): Promise<void> {
  const { config } = await import('@/config/index');

  const { initializeSecretsManager } = await import('@/config/secrets-manager');
  await initializeSecretsManager(config.secrets);

  const { loadSecretsIntoEnv } = await import('@/config/load-secrets-into-env');
  await loadSecretsIntoEnv();

  const { initializeProviderRegistry, setProviderRegistry } = await import('@/providers/provider-registry');
  const registry = await initializeProviderRegistry(config.providers);
  setProviderRegistry(registry);
}

/**
 * Build an engine execute callback. We import the orchestration engine
 * lazily so missing infra dependencies fail loudly at invocation time, not
 * at module load time.
 */
async function buildExecuteCallback(): Promise<EngineExecuteFn> {
  const { OrchestrationEngine } = await import('@/core/orchestration/orchestration-engine');
  const { getProviderRegistry } = await import('@/providers/provider-registry');
  const registry = getProviderRegistry();
  const engine = new OrchestrationEngine({ providerRegistry: registry });

  return async (request) => {
    const result = await engine.execute(request, {
      requestId: `peer-review-ab-${Date.now()}`,
    } as Parameters<typeof engine.execute>[1]);
    return {
      finalResponse: result.finalResponse,
      totalCost: result.totalCost,
      modelsUsed: result.modelsUsed,
    };
  };
}

/**
 * Build a judge that scores candidate responses by asking another LLM to
 * emit a canonical JudgeVerdict and routing the result through
 * `normalizeJudgeOutput`. The judge runs on its own single-strategy call so
 * its own peer-review flag has no effect on the A/B.
 */
async function buildJudge(): Promise<QualityJudge> {
  const { OrchestrationEngine } = await import('@/core/orchestration/orchestration-engine');
  const { getProviderRegistry } = await import('@/providers/provider-registry');
  const registry = getProviderRegistry();
  const judgeEngine = new OrchestrationEngine({ providerRegistry: registry });

  return {
    async score({ task, response }) {
      if (!response) return undefined;
      const responseText =
        response.choices?.[0]?.message?.content && typeof response.choices[0].message.content === 'string'
          ? response.choices[0].message.content
          : JSON.stringify(response.choices?.[0]?.message?.content ?? '');

      // Force peer-review off on the judge so the judge itself is a stable baseline.
      const prev = process.env.AILIN_PEER_REVIEW_MODE;
      process.env.AILIN_PEER_REVIEW_MODE = 'off';
      try {
        const judgeRequest = {
          model: 'auto',
          strategy: 'single' as const,
          messages: [
            {
              role: 'system' as const,
              content: `You are an impartial evaluator. Score the candidate response against the task on clarity, correctness, and usefulness.\n\n${JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS}`,
            },
            {
              role: 'user' as const,
              content:
                `TASK (strategy=${task.strategy}, complexity=${task.complexity}):\n` +
                `${JSON.stringify(task.request.messages)}\n\n` +
                `CANDIDATE RESPONSE:\n${responseText}\n\n` +
                `Return the canonical JudgeVerdict JSON.`,
            },
          ],
        };
        const verdictResponse = await judgeEngine.execute(
          judgeRequest as unknown as Parameters<typeof judgeEngine.execute>[0],
          { requestId: `judge-${task.id}` } as unknown as Parameters<typeof judgeEngine.execute>[1],
        );
        const judgeContent =
          verdictResponse.finalResponse?.choices?.[0]?.message?.content;
        const judgeText =
          typeof judgeContent === 'string' ? judgeContent : JSON.stringify(judgeContent ?? '');
        return normalizeJudgeOutput(judgeText, { where: 'peer-review-ab.judge' });
      } catch {
        return undefined;
      } finally {
        if (prev === undefined) delete process.env.AILIN_PEER_REVIEW_MODE;
        else process.env.AILIN_PEER_REVIEW_MODE = prev;
      }
    },
  };
}

async function main(): Promise<void> {
  const { runId } = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(`[peer-review-ab] starting run ${runId}`);

  // eslint-disable-next-line no-console
  console.log('[peer-review-ab] bootstrapping provider registry (GCP secrets + config)...');
  await bootstrapProviderRegistry();
  // eslint-disable-next-line no-console
  console.log('[peer-review-ab] provider registry ready');

  const execute = await buildExecuteCallback();
  const runner = createEngineRunner(execute);
  const judge = await buildJudge();

  const report = await runPeerReviewABBenchmark({
    runId,
    tasks: REPRESENTATIVE_TASKS,
    runner,
    judge,
  });

  const outputDir = path.resolve(process.cwd(), 'benchmark-reports');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}.json`);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`[peer-review-ab] report written: ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(`[peer-review-ab] recommendation: ${report.recommendation.decision} — ${report.recommendation.reason}`);
}

// Only run when invoked directly, never on import (keeps the module test-importable).
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[peer-review-ab] run failed', err);
    process.exit(1);
  });
}

export { main as runPeerReviewBenchmarkCli };
