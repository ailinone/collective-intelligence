// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Judge calibration CLI (audit P1-2 enabling, 2026-06-11).
 *
 * Runs the inter-rater reliability protocol from
 * core/experiment/judge-calibration.ts: the same (response, rubric) pairs are
 * scored N times by the pinned judge; if max stddev > 0.1 the judge is too
 * noisy for benchmark scoring and the run must NOT proceed.
 *
 * Intended as a MANDATORY pre-flight before any benchmark/v4 run:
 *
 *   EXPERIMENT_JUDGE_MODEL=<model> API_BASE=<url> API_TOKEN=<bearer> \
 *     pnpm calibrate:judge [runs]
 *
 * Exit code 0 = reliable; 1 = too noisy (or misconfigured).
 */

import { calibrateJudge } from '../src/core/experiment/judge-calibration';

async function main(): Promise<void> {
  const judgeModel = process.env.EXPERIMENT_JUDGE_MODEL;
  const apiBase = process.env.API_BASE ?? 'http://localhost:3000';
  const bearerToken = process.env.API_TOKEN ?? '';
  const runs = Number(process.argv[2]) || 20;

  if (!judgeModel || judgeModel === 'auto') {
    console.error(
      'EXPERIMENT_JUDGE_MODEL must be set to a stable model id (not "auto") — ' +
      'calibration of a floating judge is meaningless.'
    );
    process.exit(1);
  }
  if (!bearerToken) {
    console.error('API_TOKEN (bearer) is required to call the judge endpoint.');
    process.exit(1);
  }

  console.log(`Calibrating judge "${judgeModel}" with ${runs} runs per case via ${apiBase} ...`);
  const report = await calibrateJudge({ runs, apiBase, bearerToken, judgeModel });

  console.log(JSON.stringify(report, null, 2));
  if (!report.reliable) {
    console.error(
      `\n✖ Judge is too noisy: maxStdDev=${report.maxStdDev.toFixed(4)} > threshold=${report.threshold}. ` +
      'Pick a more deterministic judge model (or lower its temperature) before running the benchmark.'
    );
    process.exit(1);
  }
  console.log(`\n✓ Judge reliable (maxStdDev=${report.maxStdDev.toFixed(4)} ≤ ${report.threshold}).`);
}

main().catch((err) => {
  console.error('Judge calibration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
