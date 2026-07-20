// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR, type BenchmarkMetrics } from './enterprise-eval-shared';

interface PreflightReport {
  generatedAt: string;
  baseUrl: string;
  overallPass: boolean;
}

interface PackagedFile {
  name: string;
  source: string;
  sizeBytes: number;
  sha256: string;
}

interface DeployManifest {
  generatedAt: string;
  packageId: string;
  sourceBaseUrl: string;
  gates: {
    preflightPass: boolean;
    remediatedBenchmarkGatePass: boolean;
    successRateGlobalPass: boolean;
    successRateCriticalPass: boolean;
    provider404RatePass: boolean;
    p95Pass: boolean;
    fallbackSuccessRatePass: boolean;
    explicitStrategyConformancePass: boolean;
  };
  remediatedSummary: {
    successRate: number;
    criticalSuccessRate: number;
    provider404Rate: number;
    fallbackSuccessRate: number;
    explicitStrategyConformanceRate: number;
    totalRequests: number;
    totalSuccess: number;
  };
  files: PackagedFile[];
}

async function readJson<T>(fileName: string): Promise<T> {
  const fullPath = path.resolve(OUTPUT_DIR, fileName);
  const content = await fs.readFile(fullPath, 'utf8');
  return JSON.parse(content) as T;
}

async function fileSha256(fullPath: string): Promise<string> {
  const content = await fs.readFile(fullPath);
  return createHash('sha256').update(content).digest('hex');
}

function timestampId(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

async function main(): Promise<void> {
  const requiredFiles = [
    'preflight-report.json',
    'eval-baseline-metrics.json',
    'eval-baseline-raw.jsonl',
    'eval-baseline-failures.md',
    'eval-remediated-metrics.json',
    'eval-remediated-raw.jsonl',
    'eval-remediated-failures.md',
    'eval-diff-baseline-vs-remediated.md',
    'market-comparison-evidence.md',
    'enterprise-eval-report.md',
  ] as const;

  const preflight = await readJson<PreflightReport>('preflight-report.json');
  const remediated = await readJson<BenchmarkMetrics>('eval-remediated-metrics.json');

  const packageId = `deploy-evidence-${timestampId()}`;
  const packageDir = path.resolve(OUTPUT_DIR, 'deploy-packages', packageId);
  await fs.mkdir(packageDir, { recursive: true });

  const packaged: PackagedFile[] = [];

  for (const fileName of requiredFiles) {
    const source = path.resolve(OUTPUT_DIR, fileName);
    const target = path.resolve(packageDir, fileName);
    await fs.copyFile(source, target);
    const stat = await fs.stat(target);
    packaged.push({
      name: fileName,
      source,
      sizeBytes: stat.size,
      sha256: await fileSha256(target),
    });
  }

  const allBenchmarkGatesPass =
    remediated.gate.successRateGlobalPass &&
    remediated.gate.successRateCriticalPass &&
    remediated.gate.provider404RatePass &&
    remediated.gate.p95Pass &&
    remediated.gate.fallbackSuccessRatePass &&
    remediated.gate.explicitStrategyConformancePass;

  const manifest: DeployManifest = {
    generatedAt: new Date().toISOString(),
    packageId,
    sourceBaseUrl: remediated.baseUrl,
    gates: {
      preflightPass: preflight.overallPass,
      remediatedBenchmarkGatePass: allBenchmarkGatesPass,
      successRateGlobalPass: remediated.gate.successRateGlobalPass,
      successRateCriticalPass: remediated.gate.successRateCriticalPass,
      provider404RatePass: remediated.gate.provider404RatePass,
      p95Pass: remediated.gate.p95Pass,
      fallbackSuccessRatePass: remediated.gate.fallbackSuccessRatePass,
      explicitStrategyConformancePass: remediated.gate.explicitStrategyConformancePass,
    },
    remediatedSummary: {
      successRate: remediated.successRate,
      criticalSuccessRate: remediated.criticalSuccessRate,
      provider404Rate: remediated.provider404Rate,
      fallbackSuccessRate: remediated.fallbackSuccessRate,
      explicitStrategyConformanceRate: remediated.explicitStrategyConformanceRate,
      totalRequests: remediated.totalRequests,
      totalSuccess: remediated.totalSuccess,
    },
    files: packaged,
  };

  await fs.writeFile(
    path.resolve(packageDir, 'deploy-evidence-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  const gateMarkdown = [
    '# Deploy Evidence Gate',
    '',
    `Generated at: ${manifest.generatedAt}`,
    `Package: ${manifest.packageId}`,
    `Base URL: ${manifest.sourceBaseUrl}`,
    '',
    '## Gate Status',
    '',
    `- Preflight: ${manifest.gates.preflightPass ? 'PASS' : 'FAIL'}`,
    `- Remediated benchmark gate: ${
      manifest.gates.remediatedBenchmarkGatePass ? 'PASS' : 'FAIL'
    }`,
    `- success_rate_global >= 97%: ${
      manifest.gates.successRateGlobalPass ? 'PASS' : 'FAIL'
    }`,
    `- critical_success_rate >= 95%: ${
      manifest.gates.successRateCriticalPass ? 'PASS' : 'FAIL'
    }`,
    `- provider_404_rate == 0: ${manifest.gates.provider404RatePass ? 'PASS' : 'FAIL'}`,
    `- p95 thresholds: ${manifest.gates.p95Pass ? 'PASS' : 'FAIL'}`,
    `- fallback_success_rate >= 90%: ${
      manifest.gates.fallbackSuccessRatePass ? 'PASS' : 'FAIL'
    }`,
    `- explicit_strategy_conformance_rate >= 95%: ${
      manifest.gates.explicitStrategyConformancePass ? 'PASS' : 'FAIL'
    }`,
    '',
    '## Summary',
    '',
    `- successRate: ${(manifest.remediatedSummary.successRate * 100).toFixed(2)}%`,
    `- criticalSuccessRate: ${(manifest.remediatedSummary.criticalSuccessRate * 100).toFixed(2)}%`,
    `- provider404Rate: ${(manifest.remediatedSummary.provider404Rate * 100).toFixed(2)}%`,
    `- fallbackSuccessRate: ${(manifest.remediatedSummary.fallbackSuccessRate * 100).toFixed(2)}%`,
    `- explicitStrategyConformanceRate: ${(
      manifest.remediatedSummary.explicitStrategyConformanceRate * 100
    ).toFixed(2)}%`,
    `- totalRequests: ${manifest.remediatedSummary.totalRequests}`,
    `- totalSuccess: ${manifest.remediatedSummary.totalSuccess}`,
    '',
    '## Files',
    '',
    ...manifest.files.map(
      (file) => `- ${file.name} (${file.sizeBytes} bytes, sha256: ${file.sha256})`
    ),
    '',
  ];

  await fs.writeFile(path.resolve(packageDir, 'deploy-evidence-gate.md'), gateMarkdown.join('\n'), 'utf8');

  console.log(
    JSON.stringify(
      {
        packageDir,
        manifest: path.resolve(packageDir, 'deploy-evidence-manifest.json'),
        gate: path.resolve(packageDir, 'deploy-evidence-gate.md'),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('package-deploy-evidence failed:', error);
  process.exit(1);
});
