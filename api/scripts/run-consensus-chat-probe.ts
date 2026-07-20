// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C — Consensus Real Micro-Probe
 *
 * Runs the consensus strategy against a LIVE dev server by POSTing to
 * /v1/chat/completions with `strategy: 'consensus'`. Reads back
 * `ailin_metadata.consensusArtifacts` and prints a sanitized summary.
 *
 * Why HTTP and not in-process? OrchestrationEngine bootstraps providers
 * via the server's startup path (see `src/index.ts`). Running this
 * standalone would re-implement bootstrap. Hitting the live server is
 * smaller, lower-risk, and reproduces the real request path exactly.
 *
 * Safety contract (probe refuses to start if any fail):
 *   - ENABLE_STRATEGY_EVAL_PROBE=true must be set on this process
 *   - NODE_ENV must NOT be 'production' on this process (defense in depth)
 *   - STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED=true
 *   - STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID is set
 *   - STRATEGY_EVALUATOR_MAX_COST_USD > 0
 *   - PROBE_API_URL and PROBE_API_KEY are set (probe will NOT inject
 *     credentials from the server's env)
 *   - The SERVER must independently have ENABLE_STRATEGY_EVAL_PROBE=true
 *     for `consensusArtifacts` to appear in the response
 *
 * Output is sanitized — no prompt/response body text. Only structural
 * fields, scores, costs, latencies.
 *
 * Usage (local server already running on $PROBE_API_URL):
 *   ENABLE_STRATEGY_EVAL_PROBE=true \
 *   STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED=true \
 *   STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID=<judge-model> \
 *   STRATEGY_EVALUATOR_MAX_COST_USD=0.10 \
 *   PROBE_API_URL=http://localhost:3000 \
 *   PROBE_API_KEY=ak_xxx \
 *   tsx scripts/run-consensus-chat-probe.ts
 */
import type { ConsensusStrategyArtifacts } from '../src/core/orchestration/strategies/consensus/consensus-artifacts';

const DEFAULT_TASK = `Implemente em TypeScript uma função parseMoneyBR(input: string): number | null \
que converte valores brasileiros como "R$ 1.234,56", "1234,56", "1.234" e "0,99" para \
number. Retorne null para entradas inválidas. Inclua pelo menos 8 casos de teste \
simples.`;

interface ProbeSummary {
  effectiveStrategyId: string;
  scoringMode: string;
  validationStatus: string;
  participantCount: number;
  validParticipants: number;
  outlierCount: number;
  synthesisScore: number | undefined;
  synthesisVerdict: string | undefined;
  bestIndividualScore: number | undefined;
  bestIndividualModelId: string | undefined;
  delta: number | undefined;
  fallbackTriggered: boolean;
  fallbackReason: string | undefined;
  finalSource: 'synthesis' | 'best_individual';
  comparable: boolean;
  participantOutlierReasons: Array<{ modelId: string; outlier: boolean; reason: string | undefined; score: number | undefined; verdict: string | undefined }>;
  totalCostUsd: number;
  totalDurationMs: number;
  judgeRubricVersion: string;
  judgeModelId: string;
}

interface ProbeResult {
  ok: boolean;
  reason?: string;
  errors?: string[];
  summary?: ProbeSummary;
}

function assertGated(): string[] {
  const fails: string[] = [];
  if (process.env.ENABLE_STRATEGY_EVAL_PROBE !== 'true') {
    fails.push('ENABLE_STRATEGY_EVAL_PROBE must be "true"');
  }
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
    fails.push('NODE_ENV=production blocks this probe by design');
  }
  if (process.env.STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED !== 'true') {
    fails.push('STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED must be "true"');
  }
  if (!(process.env.STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID ?? '').trim()) {
    fails.push('STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID must be set');
  }
  const maxCost = Number(process.env.STRATEGY_EVALUATOR_MAX_COST_USD ?? 0);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    fails.push('STRATEGY_EVALUATOR_MAX_COST_USD must be > 0');
  }
  if (!(process.env.PROBE_API_URL ?? '').trim()) {
    fails.push('PROBE_API_URL must be set (e.g. http://localhost:3000)');
  }
  if (!(process.env.PROBE_API_KEY ?? '').trim()) {
    fails.push('PROBE_API_KEY must be set (do NOT inline secrets in commands)');
  }
  return fails;
}

function summarize(artifacts: ConsensusStrategyArtifacts, totalCostUsd: number, totalDurationMs: number): ProbeSummary {
  const validParticipants = artifacts.participantOutputs.filter((p) => p.success && !p.outlier).length;
  const outlierCount = artifacts.participantOutputs.filter((p) => p.outlier).length;
  return {
    effectiveStrategyId: artifacts.effectiveStrategyId,
    scoringMode: artifacts.scoringMode,
    validationStatus: artifacts.validationStatus,
    participantCount: artifacts.participantOutputs.length,
    validParticipants,
    outlierCount,
    synthesisScore: artifacts.synthesis.score,
    synthesisVerdict: artifacts.synthesis.verdict,
    bestIndividualScore: artifacts.bestIndividual?.score,
    bestIndividualModelId: artifacts.bestIndividual?.modelId,
    delta: artifacts.finalSelection.deltaVsBestIndividual,
    fallbackTriggered: artifacts.finalSelection.fallbackTriggered,
    fallbackReason: artifacts.finalSelection.fallbackReason,
    finalSource: artifacts.finalSelection.source,
    comparable: artifacts.finalSelection.comparable,
    participantOutlierReasons: artifacts.participantOutputs.map((p) => ({
      modelId: p.modelId,
      outlier: p.outlier === true,
      reason: p.outlierReason,
      score: p.individualScore,
      verdict: p.evaluatorVerdict,
    })),
    totalCostUsd,
    totalDurationMs,
    judgeRubricVersion: process.env.STRATEGY_EVALUATOR_RUBRIC_VERSION ?? 'strategy-output-v1',
    judgeModelId: process.env.STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID ?? '',
  };
}

async function main(): Promise<ProbeResult> {
  const gateFails = assertGated();
  if (gateFails.length > 0) {
    return { ok: false, reason: 'gate_failed', errors: gateFails };
  }

  const apiUrl = (process.env.PROBE_API_URL ?? '').replace(/\/+$/, '');
  const apiKey = process.env.PROBE_API_KEY ?? '';
  const maxBudget = Number(process.env.MAX_TOTAL_PROBE_COST_USD ?? '1.00');
  const taskPrompt = process.env.PROBE_TASK_PROMPT?.trim() || DEFAULT_TASK;

  const body = {
    model: 'auto',
    strategy: 'consensus',
    messages: [{ role: 'user', content: taskPrompt }],
    temperature: 0.7,
    max_tokens: 1500,
    max_cost: maxBudget,
    stream: false,
  };

  const t0 = Date.now();
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Ailin-Eval-Strategy': 'consensus',
        'X-Ailin-Eval-Trace': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, reason: 'network_error', errors: [String(err)] };
  }
  const durationMs = Date.now() - t0;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, reason: `http_${response.status}`, errors: [text.slice(0, 500)] };
  }

  const raw = (await response.json()) as {
    ailin_metadata?: {
      consensusArtifacts?: ConsensusStrategyArtifacts;
      cost_usd?: number;
      strategy_used?: string;
    };
  };

  const artifacts = raw.ailin_metadata?.consensusArtifacts;
  if (!artifacts) {
    return {
      ok: false,
      reason: 'no_artifacts',
      errors: [
        'ailin_metadata.consensusArtifacts is missing. Confirm the SERVER has ENABLE_STRATEGY_EVAL_PROBE=true. ' +
          'Also confirm that consensus actually executed (strategy_used=' +
          (raw.ailin_metadata?.strategy_used ?? '?') +
          ').',
      ],
    };
  }

  const totalCostUsd = raw.ailin_metadata?.cost_usd ?? 0;
  const summary = summarize(artifacts, totalCostUsd, durationMs);

  const overBudget = totalCostUsd > maxBudget;
  return { ok: !overBudget, summary, ...(overBudget ? { reason: 'over_budget' } : {}) };
}

main()
  .then((r) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('probe crashed:', err);
    process.exit(2);
  });
