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
  ensureOutputDir,
  getApiBaseUrl,
  getApiKey,
  getBearerToken,
  requestJsonWithTimeout,
  writeJsonFile,
} from './enterprise-eval-shared';

type ModelRecord = {
  id?: string;
  name?: string;
  provider?: string;
  originProvider?: string;
  executionProvider?: string;
  runnable?: boolean;
  capabilities?: string[];
  endpoints?: string[];
};

type InventoryResponse = {
  object?: string;
  scope?: string;
  data?: ModelRecord[];
};

const REQUIRED_ADVANCED_CAPABILITIES = [
  'computer_use',
  'vision',
  'listen',
  'audio_to_audio',
  'image_to_video',
  'video_to_video',
  'video_to_text',
  'video_transcription',
  'coding',
  'research',
  'deep_search',
  'deep_research',
  'health',
  'realtime',
  'realtime_audio',
  'speech_to_text',
  'text_to_speech',
  'image_generation',
  'video_generation',
  'embeddings',
] as const;

function buildAuthHeaders(token: string, apiKey: string): Record<string, string> {
  if (apiKey) {
    return { 'x-api-key': apiKey };
  }
  return { Authorization: `Bearer ${token}` };
}

async function fetchModels(
  baseUrl: string,
  token: string,
  apiKey: string,
  scope: 'all' | 'runnable'
): Promise<ModelRecord[]> {
  const headers = buildAuthHeaders(token, apiKey);
  const scopedUrl = `${baseUrl}/v1/models?scope=${scope}`;
  const scoped = await requestJsonWithTimeout(scopedUrl, { method: 'GET', headers }, 30_000);

  if (scoped.status >= 200 && scoped.status < 300) {
    const payload = scoped.json as InventoryResponse;
    return Array.isArray(payload.data) ? payload.data : [];
  }

  const fallback = await requestJsonWithTimeout(`${baseUrl}/v1/models`, { method: 'GET', headers }, 30_000);
  if (fallback.status < 200 || fallback.status >= 300) {
    const body = fallback.text || scoped.text;
    throw new Error(`Failed to fetch models inventory (${scope}). status=${fallback.status} body=${body}`);
  }

  const fallbackPayload = fallback.json as InventoryResponse;
  const data = Array.isArray(fallbackPayload.data) ? fallbackPayload.data : [];
  if (scope === 'runnable') {
    return data.filter((model) => model.runnable !== false);
  }
  return data;
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function toSortedEntries(counts: Record<string, number>): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

async function main(): Promise<void> {
  await ensureOutputDir();

  const baseUrl = getApiBaseUrl();
  const token = getBearerToken();
  const apiKey = getApiKey();
  if (!token && !apiKey) {
    throw new Error('Missing eval credentials. Set EVAL_API_KEY (recommended) or EVAL_BEARER_TOKEN.');
  }

  const [allModels, runnableModels] = await Promise.all([
    fetchModels(baseUrl, token, apiKey, 'all'),
    fetchModels(baseUrl, token, apiKey, 'runnable'),
  ]);

  const providersAll = countBy(
    allModels.map((model) => model.provider || 'unknown').filter((value) => value.length > 0)
  );
  const providersRunnable = countBy(
    runnableModels.map((model) => model.provider || 'unknown').filter((value) => value.length > 0)
  );

  const capabilitiesAll = countBy(
    allModels.flatMap((model) => normalizeStringArray(model.capabilities))
  );
  const capabilitiesRunnable = countBy(
    runnableModels.flatMap((model) => normalizeStringArray(model.capabilities))
  );

  const endpointsAll = countBy(
    allModels.flatMap((model) => normalizeStringArray(model.endpoints))
  );
  const endpointsRunnable = countBy(
    runnableModels.flatMap((model) => normalizeStringArray(model.endpoints))
  );

  const missingAdvancedInAll = REQUIRED_ADVANCED_CAPABILITIES.filter(
    (capability) => !capabilitiesAll[capability]
  );
  const missingAdvancedInRunnable = REQUIRED_ADVANCED_CAPABILITIES.filter(
    (capability) => !capabilitiesRunnable[capability]
  );

  const discoveredOnlyProviders = Object.keys(providersAll)
    .filter((provider) => !providersRunnable[provider])
    .sort();

  const advancedCoverage = REQUIRED_ADVANCED_CAPABILITIES.map((capability) => ({
    capability,
    discoveredModels: capabilitiesAll[capability] || 0,
    runnableModels: capabilitiesRunnable[capability] || 0,
    runnableCoverage:
      (capabilitiesAll[capability] || 0) > 0
        ? Number(((capabilitiesRunnable[capability] || 0) / capabilitiesAll[capability]).toFixed(4))
        : 0,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    authMode: apiKey ? 'api_key' : 'bearer',
    inventory: {
      totalDiscoveredModels: allModels.length,
      totalRunnableModels: runnableModels.length,
      discoveredProviders: Object.keys(providersAll).length,
      runnableProviders: Object.keys(providersRunnable).length,
    },
    providers: {
      discovered: toSortedEntries(providersAll),
      runnable: toSortedEntries(providersRunnable),
      discoveredOnly: discoveredOnlyProviders,
    },
    capabilities: {
      discovered: toSortedEntries(capabilitiesAll),
      runnable: toSortedEntries(capabilitiesRunnable),
      requiredAdvanced: REQUIRED_ADVANCED_CAPABILITIES,
      advancedCoverage,
      missingAdvancedInDiscovered: missingAdvancedInAll,
      missingAdvancedInRunnable: missingAdvancedInRunnable,
    },
    endpoints: {
      discovered: toSortedEntries(endpointsAll),
      runnable: toSortedEntries(endpointsRunnable),
    },
    risks: {
      hasDiscoveredOnlyProviders: discoveredOnlyProviders.length > 0,
      advancedCapabilitiesWithoutRunnableCoverage: advancedCoverage
        .filter((entry) => entry.discoveredModels > 0 && entry.runnableModels === 0)
        .map((entry) => entry.capability),
      advancedCapabilitiesMissingFromDiscovery: missingAdvancedInAll,
    },
  };

  const jsonPath = path.resolve(OUTPUT_DIR, 'model-inventory-audit.json');
  await writeJsonFile(jsonPath, report);

  const markdownLines: string[] = [
    '# Model Inventory Audit',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- baseUrl: ${report.baseUrl}`,
    `- authMode: ${report.authMode}`,
    `- discoveredModels: ${report.inventory.totalDiscoveredModels}`,
    `- runnableModels: ${report.inventory.totalRunnableModels}`,
    `- discoveredProviders: ${report.inventory.discoveredProviders}`,
    `- runnableProviders: ${report.inventory.runnableProviders}`,
    '',
    '## Advanced Capability Coverage',
    '',
    '| Capability | Discovered | Runnable | Runnable Coverage |',
    '|---|---:|---:|---:|',
    ...advancedCoverage.map(
      (entry) =>
        `| ${entry.capability} | ${entry.discoveredModels} | ${entry.runnableModels} | ${(entry.runnableCoverage * 100).toFixed(2)}% |`
    ),
    '',
    '## Risk Flags',
    '',
    `- discoveredOnlyProviders: ${report.risks.hasDiscoveredOnlyProviders ? 'yes' : 'no'}`,
    `- advancedCapabilitiesWithoutRunnableCoverage: ${
      report.risks.advancedCapabilitiesWithoutRunnableCoverage.length > 0
        ? report.risks.advancedCapabilitiesWithoutRunnableCoverage.join(', ')
        : 'none'
    }`,
    `- advancedCapabilitiesMissingFromDiscovery: ${
      report.risks.advancedCapabilitiesMissingFromDiscovery.length > 0
        ? report.risks.advancedCapabilitiesMissingFromDiscovery.join(', ')
        : 'none'
    }`,
    '',
  ];

  const mdPath = path.resolve(OUTPUT_DIR, 'model-inventory-audit.md');
  const fs = await import('node:fs/promises');
  await fs.writeFile(mdPath, `${markdownLines.join('\n')}\n`, 'utf8');

  console.log(
    JSON.stringify(
      {
        jsonReport: jsonPath,
        markdownReport: mdPath,
        discoveredModels: report.inventory.totalDiscoveredModels,
        runnableModels: report.inventory.totalRunnableModels,
        missingAdvancedInRunnable: report.capabilities.missingAdvancedInRunnable,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('run-model-inventory-audit failed:', error);
  process.exit(1);
});

