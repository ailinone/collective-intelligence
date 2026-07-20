// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import fs from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR, type BenchmarkMetrics } from './enterprise-eval-shared';

function delta(current: number, previous: number): string {
  const value = current - previous;
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)} pp`;
}

function toFiniteOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function formatPercentOrNA(value: number | null): string {
  if (value === null) return 'N/A';
  return `${(value * 100).toFixed(2)}%`;
}

function deltaPercentOrNA(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return 'N/A';
  return delta(current, previous);
}

function deltaMs(current: number, previous: number): string {
  const value = current - previous;
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} ms`;
}

function gateLabel(pass: boolean): string {
  return pass ? 'PASS' : 'FAIL';
}

async function loadMetrics(stage: 'baseline' | 'remediated'): Promise<BenchmarkMetrics> {
  const filePath = path.resolve(OUTPUT_DIR, `eval-${stage}-metrics.json`);
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as BenchmarkMetrics;
}

async function loadDerivedFromRaw(
  stage: 'baseline' | 'remediated'
): Promise<{ statusCounts: Record<string, number> }> {
  try {
    const rawPath = path.resolve(OUTPUT_DIR, `eval-${stage}-raw.jsonl`);
    const content = await fs.readFile(rawPath, 'utf8');
    const statusCounts: Record<string, number> = {};
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { statusCode?: number };
      const status = String(parsed.statusCode ?? 0);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    return { statusCounts };
  } catch {
    return { statusCounts: {} };
  }
}

async function main(): Promise<void> {
  const baseline = await loadMetrics('baseline');
  const remediated = await loadMetrics('remediated');
  const baselineDerived = await loadDerivedFromRaw('baseline');
  const remediatedDerived = await loadDerivedFromRaw('remediated');

  const lines: string[] = [];
  lines.push('# Benchmark Diff: Baseline vs Remediated');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Baseline target: \`${baseline.baseUrl || 'n/a'}\``);
  lines.push(`Remediated target: \`${remediated.baseUrl || 'n/a'}\``);
  if (baseline.baseUrl !== remediated.baseUrl) {
    lines.push(
      '> Methodology note: baseline/remediated were executed against different targets; treat deltas as directional, not absolute.'
    );
  }
  lines.push('');
  lines.push('## Global Metrics');
  lines.push('');
  lines.push('| Metric | Baseline | Remediated | Delta |');
  lines.push('|---|---:|---:|---:|');
  lines.push(
    `| success_rate | ${(baseline.successRate * 100).toFixed(2)}% | ${(remediated.successRate * 100).toFixed(2)}% | ${delta(remediated.successRate, baseline.successRate)} |`
  );
  lines.push(
    `| critical_success_rate | ${(baseline.criticalSuccessRate * 100).toFixed(2)}% | ${(remediated.criticalSuccessRate * 100).toFixed(2)}% | ${delta(remediated.criticalSuccessRate, baseline.criticalSuccessRate)} |`
  );
  lines.push(
    `| provider_404_rate | ${(baseline.provider404Rate * 100).toFixed(2)}% | ${(remediated.provider404Rate * 100).toFixed(2)}% | ${delta(remediated.provider404Rate, baseline.provider404Rate)} |`
  );
  lines.push(
    `| fallback_success_rate | ${(baseline.fallbackSuccessRate * 100).toFixed(2)}% | ${(remediated.fallbackSuccessRate * 100).toFixed(2)}% | ${delta(remediated.fallbackSuccessRate, baseline.fallbackSuccessRate)} |`
  );
  const baselineExplicitStrategyConformance = toFiniteOrNull(
    baseline.explicitStrategyConformanceRate
  );
  const remediatedExplicitStrategyConformance = toFiniteOrNull(
    remediated.explicitStrategyConformanceRate
  );
  lines.push(
    `| explicit_strategy_conformance_rate | ${formatPercentOrNA(baselineExplicitStrategyConformance)} | ${formatPercentOrNA(remediatedExplicitStrategyConformance)} | ${deltaPercentOrNA(remediatedExplicitStrategyConformance, baselineExplicitStrategyConformance)} |`
  );
  lines.push(
    `| avg_cost_per_request | ${baseline.avgCostPerRequest.toFixed(6)} | ${remediated.avgCostPerRequest.toFixed(6)} | ${(remediated.avgCostPerRequest - baseline.avgCostPerRequest).toFixed(6)} |`
  );
  lines.push('');

  lines.push('## Status Distribution');
  lines.push('');
  lines.push('| Status | Baseline | Remediated |');
  lines.push('|---:|---:|---:|');
  const baselineStatusCounts = baseline.statusCounts || baselineDerived.statusCounts;
  const remediatedStatusCounts = remediated.statusCounts || remediatedDerived.statusCounts;
  const allStatuses = new Set([
    ...Object.keys(baselineStatusCounts),
    ...Object.keys(remediatedStatusCounts),
  ]);
  for (const status of Array.from(allStatuses).sort((a, b) => Number(a) - Number(b))) {
    const before = baselineStatusCounts[status] ?? 0;
    const after = remediatedStatusCounts[status] ?? 0;
    lines.push(`| ${status} | ${before} | ${after} |`);
  }
  lines.push('');

  lines.push('## p95 by Strategy');
  lines.push('');
  lines.push('| Strategy | Baseline p95 | Remediated p95 | Delta |');
  lines.push('|---|---:|---:|---:|');
  const strategies = new Set([
    ...Object.keys(baseline.p95ByStrategy),
    ...Object.keys(remediated.p95ByStrategy),
  ]);
  for (const strategy of strategies) {
    const before = baseline.p95ByStrategy[strategy] ?? 0;
    const after = remediated.p95ByStrategy[strategy] ?? 0;
    lines.push(`| ${strategy} | ${before.toFixed(2)} ms | ${after.toFixed(2)} ms | ${deltaMs(after, before)} |`);
  }
  lines.push('');

  lines.push('## Gate Evaluation');
  lines.push('');
  lines.push('| Gate | Baseline | Remediated |');
  lines.push('|---|---|---|');
  lines.push(
    `| success_rate_global >= 97% | ${gateLabel(
      baseline.gate.successRateGlobalPass
    )} | ${gateLabel(remediated.gate.successRateGlobalPass)} |`
  );
  lines.push(
    `| critical_success_rate >= 95% | ${gateLabel(
      baseline.gate.successRateCriticalPass
    )} | ${gateLabel(remediated.gate.successRateCriticalPass)} |`
  );
  lines.push(
    `| provider_404_rate == 0 | ${gateLabel(
      baseline.gate.provider404RatePass
    )} | ${gateLabel(remediated.gate.provider404RatePass)} |`
  );
  lines.push(
    `| p95 thresholds | ${gateLabel(baseline.gate.p95Pass)} | ${gateLabel(remediated.gate.p95Pass)} |`
  );
  lines.push(
    `| fallback_success_rate >= 90% | ${gateLabel(
      baseline.gate.fallbackSuccessRatePass
    )} | ${gateLabel(remediated.gate.fallbackSuccessRatePass)} |`
  );
  lines.push(
    `| explicit_strategy_conformance_rate >= 95% | ${gateLabel(
      baseline.gate.explicitStrategyConformancePass
    )} | ${gateLabel(remediated.gate.explicitStrategyConformancePass)} |`
  );
  lines.push('');

  const targetPath = path.resolve(OUTPUT_DIR, 'eval-diff-baseline-vs-remediated.md');
  await fs.writeFile(targetPath, lines.join('\n'), 'utf8');
  console.log(JSON.stringify({ output: targetPath }, null, 2));
}

main().catch((error) => {
  console.error('compare-enterprise-benchmarks failed:', error);
  process.exit(1);
});
