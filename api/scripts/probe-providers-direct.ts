// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Direct provider credential probe (R7 — 2026-05-10).
 *
 * Bypasses the orchestrator's auth-protected /v1/chat/completions
 * (which is broken by the Prisma client deadlock in dev) and tests
 * each provider's API directly using the env var credentials.
 *
 * Tests:
 *   1. credential validity (auth works against provider's API)
 *   2. credit balance where billing endpoint exposes it
 *   3. listModels where provider supports /v1/models
 *
 * Run inside the container:
 *   docker exec ci-api node //app/dist/scripts/probe-providers-direct.js
 *
 * The output JSON is the canonical inventory of which of the 71
 * providers can actually be called RIGHT NOW.
 */

import { PROVIDER_CATALOG } from '../src/providers/catalog/providers.catalog';
import { buildProbeCallbacks } from '../src/core/operability/adapter-probe-callbacks';

interface ProbeResult {
  providerId: string;
  envVar: string;
  envPresent: boolean;
  credentialValid: boolean | 'unknown';
  modelsListed: number;
  creditStatus: 'has_credits' | 'exhausted' | 'unknown';
  balanceUsd?: number;
  durationMs: number;
  error?: string;
}

async function probeProvider(
  providerId: string,
  integrationClass: string,
  baseUrl: string,
  envVar: string,
  modelListPath: string | undefined,
  timeoutMs = 15_000,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const apiKey = process.env[envVar];
  const result: ProbeResult = {
    providerId,
    envVar,
    envPresent: !!apiKey,
    credentialValid: 'unknown',
    modelsListed: 0,
    creditStatus: 'unknown',
    durationMs: 0,
  };

  if (!apiKey) {
    result.durationMs = Date.now() - t0;
    result.error = 'env_var_missing';
    return result;
  }

  const callbacks = buildProbeCallbacks({
    providerId,
    integrationClass,
    baseUrl,
    modelListPath,
  });

  // 1. Try listModels (most providers expose /v1/models)
  if (callbacks.listModels) {
    try {
      const models = await callbacks.listModels({ providerId, apiKey, timeoutMs });
      result.modelsListed = models.length;
      result.credentialValid = true;
    } catch (err) {
      const msg = String(err);
      if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('unauthorized')) {
        result.credentialValid = false;
        result.error = 'auth_failed';
      } else if (msg.includes('402') || msg.toLowerCase().includes('credit')) {
        result.credentialValid = true;
        result.creditStatus = 'exhausted';
      } else {
        result.error = msg.slice(0, 100);
      }
    }
  }

  // 2. Try credit probe (only providers in BALANCE_ENDPOINTS)
  if (callbacks.probeCredit) {
    try {
      const credit = await callbacks.probeCredit({ providerId, apiKey, timeoutMs });
      result.creditStatus = credit.status;
      result.balanceUsd = credit.balanceUsd;
      if (credit.status === 'has_credits' || credit.status === 'exhausted') {
        result.credentialValid = true;
      }
    } catch (err) {
      // Non-fatal; we already have listModels signal
    }
  }

  result.durationMs = Date.now() - t0;
  return result;
}

async function main(): Promise<void> {
  // Eligible providers (chat-capable integration classes)
  const ELIGIBLE = new Set([
    'oai-compat-pure',
    'oai-compat-quirks',
    'first-party-native',
    'gateway',
    'self-hosted-oai-compat',
    'self-hosted-native',
  ]);

  const eligible = PROVIDER_CATALOG.filter((e) => ELIGIBLE.has(e.integrationClass));
  console.error(`Probing ${eligible.length} of ${PROVIDER_CATALOG.length} providers...`);

  const results: ProbeResult[] = [];
  for (const entry of eligible) {
    const r = await probeProvider(
      entry.providerId,
      entry.integrationClass,
      entry.baseUrl,
      entry.apiKeyEnvVar,
      entry.paths?.models,
    );
    results.push(r);
    process.stderr.write(
      `[${results.length}/${eligible.length}] ${r.providerId.padEnd(22)} ` +
      `env=${r.envPresent ? 'Y' : 'N'} ` +
      `auth=${r.credentialValid} ` +
      `models=${r.modelsListed} ` +
      `credit=${r.creditStatus} ` +
      `dur=${r.durationMs}ms ` +
      `${r.error ?? ''}\n`,
    );
  }

  // Summary
  const summary = {
    total: results.length,
    envPresent: results.filter((r) => r.envPresent).length,
    credentialValid: results.filter((r) => r.credentialValid === true).length,
    credentialInvalid: results.filter((r) => r.credentialValid === false).length,
    creditOk: results.filter((r) => r.creditStatus === 'has_credits').length,
    creditExhausted: results.filter((r) => r.creditStatus === 'exhausted').length,
    listedModelsTotal: results.reduce((s, r) => s + r.modelsListed, 0),
    workingProviders: results.filter(
      (r) => r.envPresent && r.credentialValid === true && r.creditStatus !== 'exhausted',
    ).map((r) => r.providerId),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
