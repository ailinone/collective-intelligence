// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — LOTE AU (2026-09-08): 13 previously-pending provider secrets
 * + the new aivideoapi.com integration.
 *
 * ## Why this test exists
 *
 * `resolveSecretId` is a naive `${prefix}-${key}` concatenation with no
 * spelling normalization. Two of the operator's 13 GCP secrets used a
 * spelling this codebase never guessed:
 *   - `<prefix>-nearai-key` (no hyphen) vs the catalog's own hyphenated
 *     providerId `near-ai`, which produced the guessed candidates
 *     `near-ai-key`/`near-ai-api-key`.
 *   - `<prefix>-sxcai-key` (a transposed spelling of scx.ai) vs the catalog's
 *     `scx` providerId, which produced the guessed candidates
 *     `scx-key`/`scx-api-key`.
 * Both were confirmed live via `gcloud secrets describe/versions list`
 * (exactly one ENABLED version each), while the originally-guessed names
 * were confirmed absent. This test pins the fix at the `loadSecret`-mock
 * level, mirroring `load-secrets-meta-llama-alias.test.ts`'s harness.
 *
 * It also covers the 11 other secrets from the same batch (tinfoil, thegrid,
 * tensorx, sxcai, runinfra, routingrun, poolside, pioneer, orcarouter, ofox,
 * neuralwatt, modeloracle) whose GCP secret names already matched the naive
 * convention — confirming they resolve correctly end to end, not just that
 * the two mismatches were fixed — plus the brand-new `aivideoapi` binding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/secrets-loader', () => ({
  loadSecret: vi.fn(),
}));

import { loadSecret } from '@/config/secrets-loader';
import { loadSecretsIntoEnv } from '@/config/load-secrets-into-env';

const loadSecretMock = vi.mocked(loadSecret);

const RESET_ENV_VARS = [
  'SECRETS_PROVIDER_PRIMARY',
  'SECRETS_GCP_AUTHORITATIVE',
  'SECRETS_GCP_FAIL_FAST',
  'TEST_USE_REAL_API_KEYS',
  'NEAR_AI_API_KEY',
  'SCX_API_KEY',
  'AIVIDEOAPI_API_KEY',
  'DATABASE_URL',
  'JWT_SECRET',
] as const;

function resetEnv() {
  for (const v of RESET_ENV_VARS) delete process.env[v];
}

describe('loadSecretsIntoEnv — LOTE AU pending provider secrets', () => {
  beforeEach(() => {
    resetEnv();
    loadSecretMock.mockReset();
    loadSecretMock.mockResolvedValue(undefined);
    process.env.SECRETS_GCP_FAIL_FAST = 'false';
    process.env.JWT_SECRET = 'test-jwt';
    process.env.DATABASE_URL = 'postgresql://test/test';
  });

  afterEach(() => {
    resetEnv();
  });

  function mockCriticalPlus(extra: Record<string, string>) {
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'jwt-secret') return 'gcp-jwt';
      if (key === 'database-url') return 'postgresql://gcp/db';
      return extra[key];
    });
  }

  it('resolves NEAR_AI_API_KEY from the real nearai-key spelling (no hyphen), not the guessed near-ai-key', async () => {
    mockCriticalPlus({ 'nearai-key': 'real-nearai-secret' });
    await loadSecretsIntoEnv();
    expect(process.env.NEAR_AI_API_KEY).toBe('real-nearai-secret');
  });

  it('still resolves NEAR_AI_API_KEY from near-ai-key if it is ever provisioned under the providerId-matching name', async () => {
    mockCriticalPlus({ 'near-ai-key': 'renamed-secret' });
    await loadSecretsIntoEnv();
    expect(process.env.NEAR_AI_API_KEY).toBe('renamed-secret');
  });

  it('resolves SCX_API_KEY from the real sxcai-key spelling (transposed), not the guessed scx-key', async () => {
    mockCriticalPlus({ 'sxcai-key': 'real-sxcai-secret' });
    await loadSecretsIntoEnv();
    expect(process.env.SCX_API_KEY).toBe('real-sxcai-secret');
  });

  it('still resolves SCX_API_KEY from scx-key if it is ever provisioned under the providerId-matching name', async () => {
    mockCriticalPlus({ 'scx-key': 'renamed-secret' });
    await loadSecretsIntoEnv();
    expect(process.env.SCX_API_KEY).toBe('renamed-secret');
  });

  it('resolves AIVIDEOAPI_API_KEY from aivideoapi-key (new LOTE AU binding)', async () => {
    mockCriticalPlus({ 'aivideoapi-key': 'real-aivideoapi-secret' });
    await loadSecretsIntoEnv();
    expect(process.env.AIVIDEOAPI_API_KEY).toBe('real-aivideoapi-secret');
  });

  it.each([
    ['TINFOIL_API_KEY', 'tinfoil-key'],
    ['THEGRID_API_KEY', 'thegrid-key'],
    ['TENSORX_API_KEY', 'tensorx-key'],
    ['RUNINFRA_API_KEY', 'runinfra-key'],
    ['ROUTINGRUN_API_KEY', 'routingrun-key'],
    ['POOLSIDE_API_KEY', 'poolside-key'],
    ['PIONEER_API_KEY', 'pioneer-key'],
    ['ORCAROUTER_API_KEY', 'orcarouter-key'],
    ['OFOX_API_KEY', 'ofox-key'],
    ['NEURALWATT_API_KEY', 'neuralwatt-key'],
    ['MODELORACLE_API_KEY', 'modeloracle-key'],
  ])('resolves %s from the already-correct %s candidate', async (envVar, secretKey) => {
    mockCriticalPlus({ [secretKey]: `real-${secretKey}-secret` });
    await loadSecretsIntoEnv();
    expect(process.env[envVar]).toBe(`real-${secretKey}-secret`);
  });

  it('leaves AIVIDEOAPI_API_KEY unset when no candidate exists in GCP', async () => {
    mockCriticalPlus({});
    await loadSecretsIntoEnv();
    expect(process.env.AIVIDEOAPI_API_KEY).toBeUndefined();
  });
});

describe('PROVIDER_CATALOG — aivideoapi row (LOTE AU)', () => {
  it('registers aivideoapi as a distinct, video-only, execution-only row from runwayml', async () => {
    const { PROVIDER_CATALOG } = await import('../providers.catalog');
    const row = PROVIDER_CATALOG.find((r) => r.providerId === 'aivideoapi');
    expect(row).toBeDefined();
    expect(row?.integrationClass).toBe('video-only');
    expect(row?.integrationMode).toBe('execution-only');
    expect(row?.apiKeyEnvVar).toBe('AIVIDEOAPI_API_KEY');
    expect(row?.adapterClass).toBe('AivideoapiAdapter');
    expect(row?.baseUrl).toBe('https://api.aivideoapi.com');

    const runwayml = PROVIDER_CATALOG.find((r) => r.providerId === 'runwayml');
    expect(runwayml?.apiKeyEnvVar).not.toBe(row?.apiKeyEnvVar);
    expect(runwayml?.baseUrl).not.toBe(row?.baseUrl);
  });

  it('marks aivideoapi as a discovery-compliance-exempt row (no /models route documented)', async () => {
    const { DISCOVERY_COMPLIANCE_REGISTRY } = await import('../consolidation-matrix');
    const structuralByDesign = Object.values(DISCOVERY_COMPLIANCE_REGISTRY).flat();
    expect(structuralByDesign).toContain('aivideoapi');
  });
});
