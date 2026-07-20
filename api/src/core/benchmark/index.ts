// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Benchmark Harness — Public API
 *
 * OI-01: Benchmark Harness (Fase 0)
 * OI-02: Reward Integrity Detection (built into evaluator)
 */

export { BenchmarkEvaluator, loadBenchmarkConfig } from './benchmark-evaluator';
export { BENCHMARK_SUITE, getTasksByCategory, getTasksByDifficulty, getBalancedSample, getSuiteStats } from './benchmark-suite';
export type {
  BenchmarkTask,
  BenchmarkExecutionResult,
  BenchmarkRun,
  BenchmarkConfig,
  BenchmarkCategory,
  BenchmarkDifficulty,
  BenchmarkTrend,
  CategoryScore,
  StrategyScore,
  RewardIntegrityResult,
  GamingSignal,
  BanditSnapshot,
} from './types';
