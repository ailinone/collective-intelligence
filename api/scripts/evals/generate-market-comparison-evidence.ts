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

interface OptionalMetrics {
  baseline?: BenchmarkMetrics;
  remediated?: BenchmarkMetrics;
}

interface DerivedRawStats {
  statusCounts: Record<string, number>;
  topErrors: Array<{ message: string; count: number }>;
}

async function tryLoadMetrics(stage: 'baseline' | 'remediated'): Promise<BenchmarkMetrics | undefined> {
  try {
    const content = await fs.readFile(
      path.resolve(OUTPUT_DIR, `eval-${stage}-metrics.json`),
      'utf8'
    );
    return JSON.parse(content) as BenchmarkMetrics;
  } catch {
    return undefined;
  }
}

async function tryLoadDerivedRawStats(
  stage: 'baseline' | 'remediated'
): Promise<DerivedRawStats | undefined> {
  try {
    const content = await fs.readFile(
      path.resolve(OUTPUT_DIR, `eval-${stage}-raw.jsonl`),
      'utf8'
    );
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

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function formatStatusCounts(
  value: Record<string, number> | undefined
): string {
  if (!value || Object.keys(value).length === 0) return 'n/a';
  return Object.entries(value)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([status, count]) => `${status}:${count}`)
    .join(', ');
}

async function main(): Promise<void> {
  const metrics: OptionalMetrics = {
    baseline: await tryLoadMetrics('baseline'),
    remediated: await tryLoadMetrics('remediated'),
  };
  const baselineDerived = await tryLoadDerivedRawStats('baseline');
  const remediatedDerived = await tryLoadDerivedRawStats('remediated');

  const lines: string[] = [];
  lines.push('# Market Comparison Evidence');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 1) Local Empirical Evidence (this system)');
  lines.push('');
  lines.push(`- Baseline success rate: ${formatPercent(metrics.baseline?.successRate)}`);
  lines.push(`- Remediated success rate: ${formatPercent(metrics.remediated?.successRate)}`);
  lines.push(`- Baseline target: ${metrics.baseline?.baseUrl || 'n/a'}`);
  lines.push(`- Remediated target: ${metrics.remediated?.baseUrl || 'n/a'}`);
  if (
    metrics.baseline?.baseUrl &&
    metrics.remediated?.baseUrl &&
    metrics.baseline.baseUrl !== metrics.remediated.baseUrl
  ) {
    lines.push(
      '- Methodology note: baseline and remediated targets differ; use deltas as directional evidence.'
    );
  }
  lines.push(`- Baseline provider 404 rate: ${formatPercent(metrics.baseline?.provider404Rate)}`);
  lines.push(`- Remediated provider 404 rate: ${formatPercent(metrics.remediated?.provider404Rate)}`);
  lines.push(
    `- Baseline explicit strategy conformance: ${formatPercent(
      metrics.baseline?.explicitStrategyConformanceRate
    )}`
  );
  lines.push(
    `- Remediated explicit strategy conformance: ${formatPercent(
      metrics.remediated?.explicitStrategyConformanceRate
    )}`
  );
  lines.push(
    `- Baseline status counts: ${formatStatusCounts(
      metrics.baseline?.statusCounts || baselineDerived?.statusCounts
    )}`
  );
  lines.push(
    `- Remediated status counts: ${formatStatusCounts(
      metrics.remediated?.statusCounts || remediatedDerived?.statusCounts
    )}`
  );
  lines.push(
    `- Baseline top errors: ${
      (metrics.baseline?.topErrors || baselineDerived?.topErrors)
        ?.slice(0, 3)
        .map((entry) => `"${entry.message}"(${entry.count})`)
        .join('; ') ||
      'n/a'
    }`
  );
  lines.push(
    `- Remediated top errors: ${
      (metrics.remediated?.topErrors || remediatedDerived?.topErrors)
        ?.slice(0, 3)
        .map((entry) => `"${entry.message}"(${entry.count})`)
        .join('; ') ||
      'n/a'
    }`
  );
  lines.push(
    '- Source files: `ci/api/eval-results/eval-baseline-metrics.json`, `ci/api/eval-results/eval-remediated-metrics.json`'
  );
  lines.push('');
  lines.push('## 2) Market References (documentary evidence)');
  lines.push('');
  lines.push('- AWS Bedrock Intelligent Prompt Routing: https://docs.aws.amazon.com/bedrock/latest/userguide/intelligent-prompt-routing.html');
  lines.push('- Azure OpenAI Model Router: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-router');
  lines.push('- OpenRouter model routing: https://openrouter.ai/docs/features/model-routing');
  lines.push('- FrugalGPT (cost-aware routing): https://arxiv.org/abs/2305.05176');
  lines.push('- RouteLLM (router learning): https://arxiv.org/abs/2406.18665');
  lines.push('- Mixture-of-Agents: https://arxiv.org/abs/2406.04692');
  lines.push('- Self-Consistency: https://arxiv.org/abs/2203.11171');
  lines.push('- LLMRouterBench: https://arxiv.org/abs/2601.07206');
  lines.push('');
  lines.push('## 3) Comparative Matrix');
  lines.push('');
  lines.push('| Criterion | This architecture | Commercial routers (AWS/Azure/OpenRouter) | Research patterns (FrugalGPT/RouteLLM/MoA) |');
  lines.push('|---|---|---|---|');
  lines.push('| Reliability controls | Multi-strategy + fallback chain + provider telemetry | Mature managed infra, policy controls, SLA-backed operations | Algorithmic focus, usually less production operations detail |');
  lines.push('| Cost control | Explicit `cost` strategy + dynamic model selection | Route optimization exposed as managed feature | Core contribution in FrugalGPT/RouteLLM |');
  lines.push('| Latency control | `speed` strategy + strategy-specific p95 tracking | Native regional infra and managed routing layers | Varies per paper; often benchmark-oriented |');
  lines.push('| Transparency | Resolved strategy/model + fallback chain metadata | Depends on vendor observability surface | Strong methodology transparency, weaker runtime explainability |');
  lines.push('| Lock-in risk | Lower (multi-provider abstraction) | Higher (vendor-centric control planes) | Low in theory, requires custom productionization |');
  lines.push('| Operational burden | Higher internal ownership | Lower due managed service | High (research-to-production gap) |');
  lines.push('');
  lines.push('## 4) Honest Conclusion');
  lines.push('');
  lines.push('- Inference from evidence: the architecture has a real differential in controllability and transparency when metadata + eval telemetry are consistent.');
  lines.push('- Inference from evidence: managed routers still lead in operational maturity and reduced maintenance burden.');
  lines.push('- Limitation: there is no direct side-by-side runtime benchmark against managed routers in the same workload and region, so cross-platform superiority claims remain partial.');
  lines.push('- Recommendation: keep this architecture when provider diversity and explicit routing controls are strategic; use managed routing when operational simplicity is the top priority.');

  const outputPath = path.resolve(OUTPUT_DIR, 'market-comparison-evidence.md');
  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  console.log(JSON.stringify({ output: outputPath }, null, 2));
}

main().catch((error) => {
  console.error('generate-market-comparison-evidence failed:', error);
  process.exit(1);
});
