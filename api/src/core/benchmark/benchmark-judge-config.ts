// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Benchmark judge configuration (Lote 5 — J1).
 *
 * The Lote 4 real run (`local-run-4`) produced 5/10 samples with
 * `"judge failed to score"`. Root cause: the CLI used `model: 'auto'` for
 * the judge, and the selector's native-vs-hub bias ended up routing the
 * judge through a hub proxy that did not respect `response_format:
 * {type: 'json_object'}`. The judge LLM returned prose, the canonical
 * `JudgeVerdictSchema` rejected it, the benchmark recorded a failure —
 * none of which tells you anything about the peer-review hypothesis.
 *
 * This module centralizes judge selection so operators can pin a stable,
 * JSON-capable model and provider via env vars. The CLI and harness import
 * this helper instead of building the judge request inline.
 *
 * Env contract:
 *   - `EXPERIMENT_JUDGE_MODEL`    — stable model id (e.g. `gpt-4o-2024-11`)
 *   - `EXPERIMENT_JUDGE_PROVIDER` — optional provider pin (e.g. `openai`)
 *
 * When neither is set, the helper defaults to `'auto'` — same as the pre-
 * Lote-5 behavior — but logs a warning so operators running benchmarks
 * know their judge is unconstrained.
 */

import { logger } from '@/utils/logger';
import { incrementPromptMetric } from '@/core/orchestration/prompts/prompt-metrics';

const log = logger.child({ component: 'benchmark-judge-config' });

export interface BenchmarkJudgeConfig {
  /** Model id to pin for judge calls, or `'auto'` for default routing. */
  model: string;
  /** Provider constraint, or undefined to let the registry pick. */
  provider?: string;
  /** Whether the config was provided by operator env (true) or defaulted (false). */
  operatorPinned: boolean;
  /** Human-readable source of the config for logging. */
  source: string;
}

/**
 * Resolve the benchmark judge configuration from environment. This is a
 * pure function of `process.env` so tests can pass a fake env object.
 */
export function resolveBenchmarkJudgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BenchmarkJudgeConfig {
  const model = env.EXPERIMENT_JUDGE_MODEL?.trim();
  const provider = env.EXPERIMENT_JUDGE_PROVIDER?.trim() || undefined;

  if (model && model !== 'auto') {
    return {
      model,
      provider,
      operatorPinned: true,
      source: `env:EXPERIMENT_JUDGE_MODEL${provider ? `+EXPERIMENT_JUDGE_PROVIDER` : ''}`,
    };
  }

  return {
    model: 'auto',
    provider: undefined,
    operatorPinned: false,
    source: 'default:auto',
  };
}

/**
 * Warn (once per process) if the judge is unpinned. Keeps benchmark runs
 * observable without spamming the log. The warning surfaces in operator
 * dashboards via the `JUDGE_NORMALIZATION_FAILURES` metric baseline — if a
 * spike correlates with auto-judge, this is the flag to read.
 */
let _warnedOnce = false;
export function warnIfJudgeUnpinned(config: BenchmarkJudgeConfig): void {
  if (config.operatorPinned) return;
  if (_warnedOnce) return;
  _warnedOnce = true;
  log.warn(
    {
      remediation:
        'Set EXPERIMENT_JUDGE_MODEL=<a JSON-mode-capable model id> to stabilize judge path.',
    },
    'Benchmark judge is running with model=auto. Results may be contaminated by selector bias.',
  );
}

/**
 * Classify a judge-path failure into a typed cause. Used by the benchmark
 * harness (B1) when populating its failure taxonomy. Returning a closed
 * enum keeps downstream aggregation queries stable.
 */
export type JudgePathFailureCause =
  | 'judge-no-response'        // engine returned nothing
  | 'judge-empty-content'      // response with empty content string
  | 'judge-parse-error'        // JSON parse crash
  | 'judge-schema-error'       // JSON parsed but failed JudgeVerdictSchema
  | 'judge-normalize-error'    // JSON valid but no legacy adapter recognized it
  | 'judge-transport-error'    // network/provider exception
  | 'judge-timeout'            // exceeded configured deadline
  | 'judge-unknown';

export function recordJudgePathFailure(
  cause: JudgePathFailureCause,
  attributes: Record<string, string | number>,
): void {
  incrementPromptMetric('ailin_benchmark_judge_path_failure_total', {
    cause,
    ...attributes,
  });
}
