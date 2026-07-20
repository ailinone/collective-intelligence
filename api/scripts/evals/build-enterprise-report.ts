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

interface PreflightReport {
  generatedAt: string;
  baseUrl: string;
  overallPass: boolean;
  checks: Array<{ name: string; pass: boolean; details: Record<string, unknown> }>;
}

interface DerivedRawStats {
  statusCounts: Record<string, number>;
  topErrors: Array<{ message: string; count: number }>;
}

async function readJson<T>(fileName: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(path.resolve(OUTPUT_DIR, fileName), 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

async function readRawDerived(stage: 'baseline' | 'remediated'): Promise<DerivedRawStats | undefined> {
  try {
    const content = await fs.readFile(path.resolve(OUTPUT_DIR, `eval-${stage}-raw.jsonl`), 'utf8');
    const statusCounts: Record<string, number> = {};
    const errorCounts = new Map<string, number>();

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as {
        statusCode?: number;
        ok?: boolean;
        errorMessage?: string;
      };
      const status = String(parsed.statusCode ?? 0);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (!parsed.ok && parsed.errorMessage) {
        errorCounts.set(parsed.errorMessage, (errorCounts.get(parsed.errorMessage) || 0) + 1);
      }
    }

    const topErrors = Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([message, count]) => ({ message, count }));

    return { statusCounts, topErrors };
  } catch {
    return undefined;
  }
}

function gateStatus(metrics?: BenchmarkMetrics): string {
  if (!metrics) return 'N/A';
  const gates = metrics.gate;
  const allPass =
    gates.successRateGlobalPass &&
    gates.successRateCriticalPass &&
    gates.provider404RatePass &&
    gates.p95Pass &&
    gates.fallbackSuccessRatePass &&
    gates.explicitStrategyConformancePass;
  return allPass ? 'PASS' : 'FAIL';
}

function formatPercentOrNA(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }
  return `${(value * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const preflight = await readJson<PreflightReport>('preflight-report.json');
  const baseline = await readJson<BenchmarkMetrics>('eval-baseline-metrics.json');
  const remediated = await readJson<BenchmarkMetrics>('eval-remediated-metrics.json');
  const baselineRaw = await readRawDerived('baseline');
  const remediatedRaw = await readRawDerived('remediated');

  const lines: string[] = [];
  lines.push('# Enterprise Eval Consolidated Report');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- Preflight: ${preflight ? (preflight.overallPass ? 'PASS' : 'FAIL') : 'N/A'}`);
  lines.push(`- Baseline benchmark gate: ${gateStatus(baseline)}`);
  lines.push(`- Remediated benchmark gate: ${gateStatus(remediated)}`);
  lines.push(`- Baseline target: ${baseline?.baseUrl || 'N/A'}`);
  lines.push(`- Remediated target: ${remediated?.baseUrl || 'N/A'}`);
  if (
    baseline?.baseUrl &&
    remediated?.baseUrl &&
    baseline.baseUrl !== remediated.baseUrl
  ) {
    lines.push(
      '- Methodology note: baseline and remediated were executed against different targets, so deltas are directional.'
    );
  }
  lines.push('');
  lines.push('## Key Metrics');
  lines.push('');
  lines.push('| Metric | Baseline | Remediated |');
  lines.push('|---|---:|---:|');
  lines.push(
    `| success_rate | ${baseline ? formatPercentOrNA(baseline.successRate) : 'N/A'} | ${remediated ? formatPercentOrNA(remediated.successRate) : 'N/A'} |`
  );
  lines.push(
    `| critical_success_rate | ${baseline ? formatPercentOrNA(baseline.criticalSuccessRate) : 'N/A'} | ${remediated ? formatPercentOrNA(remediated.criticalSuccessRate) : 'N/A'} |`
  );
  lines.push(
    `| provider_404_rate | ${baseline ? formatPercentOrNA(baseline.provider404Rate) : 'N/A'} | ${remediated ? formatPercentOrNA(remediated.provider404Rate) : 'N/A'} |`
  );
  lines.push(
    `| fallback_success_rate | ${baseline ? formatPercentOrNA(baseline.fallbackSuccessRate) : 'N/A'} | ${remediated ? formatPercentOrNA(remediated.fallbackSuccessRate) : 'N/A'} |`
  );
  lines.push(
    `| explicit_strategy_conformance_rate | ${baseline ? formatPercentOrNA(baseline.explicitStrategyConformanceRate) : 'N/A'} | ${remediated ? formatPercentOrNA(remediated.explicitStrategyConformanceRate) : 'N/A'} |`
  );
  lines.push(
    `| status_counts | ${
      baseline
        ? Object.entries(baseline.statusCounts || baselineRaw?.statusCounts || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([status, count]) => `${status}:${count}`)
            .join(', ')
        : 'N/A'
    } | ${
      remediated
        ? Object.entries(remediated.statusCounts || remediatedRaw?.statusCounts || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([status, count]) => `${status}:${count}`)
            .join(', ')
        : 'N/A'
    } |`
  );
  lines.push('');
  lines.push('## Top Errors');
  lines.push('');
  lines.push(
    `- Baseline: ${
      (baseline?.topErrors || baselineRaw?.topErrors)
        ?.slice(0, 5)
        .map((entry) => `"${entry.message}" (${entry.count})`)
        .join('; ') ||
      'N/A'
    }`
  );
  lines.push(
    `- Remediated: ${
      (remediated?.topErrors || remediatedRaw?.topErrors)
        ?.slice(0, 5)
        .map((entry) => `"${entry.message}" (${entry.count})`)
        .join('; ') ||
      'N/A'
    }`
  );
  lines.push('');
  lines.push('## Strategy Conformance');
  lines.push('');
  if (!baseline && !remediated) {
    lines.push('- N/A');
  } else {
    lines.push('| Strategy | Baseline | Remediated |');
    lines.push('|---|---:|---:|');
    const byStrategy = new Set([
      ...(baseline?.explicitStrategyConformanceByStrategy?.map((entry) => entry.strategy) || []),
      ...(remediated?.explicitStrategyConformanceByStrategy?.map((entry) => entry.strategy) || []),
    ]);
    for (const strategy of byStrategy) {
      const baselineEntry = baseline?.explicitStrategyConformanceByStrategy?.find(
        (entry) => entry.strategy === strategy
      );
      const remediatedEntry = remediated?.explicitStrategyConformanceByStrategy?.find(
        (entry) => entry.strategy === strategy
      );
      const baselineValue = baselineEntry
        ? `${(baselineEntry.rate * 100).toFixed(2)}% (${baselineEntry.conformant}/${baselineEntry.requests})`
        : 'N/A';
      const remediatedValue = remediatedEntry
        ? `${(remediatedEntry.rate * 100).toFixed(2)}% (${remediatedEntry.conformant}/${remediatedEntry.requests})`
        : 'N/A';
      lines.push(`| ${strategy} | ${baselineValue} | ${remediatedValue} |`);
    }
  }
  lines.push('');
  lines.push('## Preflight Checks');
  lines.push('');
  if (!preflight) {
    lines.push('- preflight-report.json not found');
  } else {
    for (const check of preflight.checks) {
      lines.push(`- ${check.name}: ${check.pass ? 'PASS' : 'FAIL'}`);
    }
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- `ci/api/eval-results/preflight-report.json`');
  lines.push('- `ci/api/eval-results/eval-baseline-raw.jsonl`');
  lines.push('- `ci/api/eval-results/eval-baseline-metrics.json`');
  lines.push('- `ci/api/eval-results/eval-baseline-failures.md`');
  lines.push('- `ci/api/eval-results/eval-remediated-raw.jsonl`');
  lines.push('- `ci/api/eval-results/eval-remediated-metrics.json`');
  lines.push('- `ci/api/eval-results/eval-remediated-failures.md`');
  lines.push('- `ci/api/eval-results/eval-diff-baseline-vs-remediated.md`');
  lines.push('- `ci/api/eval-results/market-comparison-evidence.md`');

  const outputPath = path.resolve(OUTPUT_DIR, 'enterprise-eval-report.md');
  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  console.log(JSON.stringify({ output: outputPath }, null, 2));
}

main().catch((error) => {
  console.error('build-enterprise-report failed:', error);
  process.exit(1);
});
