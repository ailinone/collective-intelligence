// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Verbatim port (TS -> JS, same constants, same algorithm, same output) of
// the fixture builder in
// api/src/core/selection/__tests__/full-cache-index-benchmark.test.ts
// (branch feat/selection-full-cache-index, not yet on main as of this
// investigation). NOT a new/invented fixture — reused so this investigation's
// numbers are comparable to that benchmark's own.
//
// Real production shape it mirrors (2026-09-08 live pull, cited in that
// test's module doc):
//   - 111,666 total non-disabled models
//   - 37,629 curated/native rows across 95 distinct providers
//   - 73,782 aggregated/HF-index rows (serverless_callable=true)
//   - 255 rows tagged aggregated_index but NOT serverless_callable (orphan,
//     invisible to both buckets by construction — a real, pre-existing
//     catalog-composition quirk, not a bug introduced by this port)

const NAMED_CURATED_PROVIDERS = [
  ['featherless-ai', 22_144],
  ['orqai', 1_464],
  ['aiml', 1_292],
  ['nanogpt', 1_013],
  ['requesty', 879],
  ['openai', 136],
  ['cohere', 35],
  ['xai', 21],
  ['anthropic', 15],
  ['google', 12],
  ['deepseek', 3],
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function curatedRecord(id, providerName) {
  const h = hashStr(id);
  const capabilities = ['chat'];
  if (h % 100 < 4) capabilities.push('reasoning');
  if (h % 100 < 3) capabilities.push('vision');
  if (h % 100 < 2) capabilities.push('function_calling');
  return {
    id,
    providerId: `${providerName}-provider-id`,
    provider: providerName,
    name: id,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities,
    performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
    status: 'active',
    metadata: {},
  };
}

function aggregatedRecord(id) {
  const h = hashStr(id);
  const capabilities = ['chat'];
  if (h % 100 < 4) capabilities.push('reasoning');
  return {
    id,
    providerId: 'huggingface-provider-id',
    provider: 'huggingface',
    name: id,
    displayName: id,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities,
    performance: { latencyMs: 800, throughput: 50, quality: 0.6, reliability: 0.9 },
    status: 'active',
    metadata: { serverless_callable: true, hubInventoryClass: 'aggregated_index' },
  };
}

export function buildRealisticCatalogRecords() {
  const records = [];
  let namedTotal = 0;
  for (const [provider, count] of NAMED_CURATED_PROVIDERS) {
    namedTotal += count;
    for (let i = 0; i < count; i++) {
      records.push(curatedRecord(`${provider}-${i}`, provider));
    }
  }
  const remainingProviders = 95 - NAMED_CURATED_PROVIDERS.length;
  const remainingRows = 37_629 - namedTotal;
  const perTailProvider = Math.floor(remainingRows / remainingProviders);
  for (let p = 0; p < remainingProviders; p++) {
    const providerName = `long-tail-provider-${p}`;
    const rows =
      p === remainingProviders - 1 ? remainingRows - perTailProvider * (remainingProviders - 1) : perTailProvider;
    for (let i = 0; i < rows; i++) {
      records.push(curatedRecord(`${providerName}-${i}`, providerName));
    }
  }
  for (let i = 0; i < 73_782; i++) {
    records.push(aggregatedRecord(`hf-${i}`));
  }
  for (let i = 0; i < 255; i++) {
    const rec = curatedRecord(`orphan-${i}`, 'orphan-provider');
    rec.metadata = { hubInventoryClass: 'aggregated_index' };
    records.push(rec);
  }
  return records;
}
