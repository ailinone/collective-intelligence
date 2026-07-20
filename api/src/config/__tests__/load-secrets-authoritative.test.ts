// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — GCP authoritative mode for loadSecretsIntoEnv()
 *
 * Asserts the architectural contract: when SECRETS_PROVIDER_PRIMARY=gcp
 * (or SECRETS_GCP_AUTHORITATIVE=true) the loader treats GCP as the source
 * of truth and overwrites any pre-existing env value. Without this, env_file
 * / docker-compose / shell-exported defaults silently shadowed populated
 * GCP secrets — the failure mode that hid HF_TOKEN (and ~58k models) from
 * /v1/models in production.
 *
 * The opposite behavior (legacy skip-if-exists) is also asserted, so the
 * opt-out (SECRETS_GCP_AUTHORITATIVE=false) remains a real escape hatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/secrets-loader', () => ({
  loadSecret: vi.fn(),
}));

import { loadSecret } from '@/config/secrets-loader';
import { loadSecretsIntoEnv, getSecretsLoadSummary } from '@/config/load-secrets-into-env';

const loadSecretMock = vi.mocked(loadSecret);

const RESET_ENV_VARS = [
  'SECRETS_PROVIDER_PRIMARY',
  'SECRETS_GCP_AUTHORITATIVE',
  'SECRETS_GCP_FAIL_FAST',
  'TEST_USE_REAL_API_KEYS',
  'NODE_ENV',
  'HF_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'JWT_SECRET',
] as const;

function resetEnv() {
  for (const v of RESET_ENV_VARS) delete process.env[v];
}

describe('loadSecretsIntoEnv — GCP authoritative mode', () => {
  beforeEach(() => {
    resetEnv();
    loadSecretMock.mockReset();
    // Default: GCP returns nothing for everything (overridden per test).
    loadSecretMock.mockResolvedValue(undefined);
    // Disable the gcpFailFast tripwire — we're not testing degraded-boot
    // semantics here. The loader would otherwise throw when zero LLM
    // provider keys are loaded under SECRETS_PROVIDER_PRIMARY=gcp.
    process.env.SECRETS_GCP_FAIL_FAST = 'false';
    // Pre-populate critical secrets so the CRITICAL_SECRETS loop succeeds
    // without hitting "required secret not found" errors.
    process.env.JWT_SECRET = 'test-jwt';
    process.env.DATABASE_URL = 'postgresql://test/test';
  });

  afterEach(() => {
    resetEnv();
  });

  it('overwrites a pre-existing env value when GCP returns a different one in authoritative mode', async () => {
    process.env.SECRETS_PROVIDER_PRIMARY = 'gcp';
    process.env.HF_TOKEN = 'stale-env-value';

    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'huggingface-api-key') return 'gcp-fresh-token';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.HF_TOKEN).toBe('gcp-fresh-token');

    const summary = getSecretsLoadSummary();
    expect(summary.fromGCP).toContain('HF_TOKEN');
    expect(summary.fromEnv).not.toContain('HF_TOKEN');
  });

  it('preserves the pre-existing env value when GCP miss in authoritative mode', async () => {
    process.env.SECRETS_PROVIDER_PRIMARY = 'gcp';
    process.env.HF_TOKEN = 'env-only-value';

    // Every loadSecret call returns undefined (GCP has nothing for any candidate).
    loadSecretMock.mockResolvedValue(undefined);

    await loadSecretsIntoEnv();

    // Authoritative mode tried GCP, GCP miss, env value preserved.
    expect(process.env.HF_TOKEN).toBe('env-only-value');

    const summary = getSecretsLoadSummary();
    expect(summary.fromEnv).toContain('HF_TOKEN');
    expect(summary.fromGCP).not.toContain('HF_TOKEN');
  });

  it('legacy skip-if-exists when SECRETS_PROVIDER_PRIMARY=env (no authoritative)', async () => {
    process.env.SECRETS_PROVIDER_PRIMARY = 'env';
    process.env.HF_TOKEN = 'env-set-value';

    // GCP would return a different value, but in env-primary mode we should
    // never even ask GCP for HF_TOKEN.
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key.startsWith('huggingface-')) return 'gcp-value-must-not-win';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.HF_TOKEN).toBe('env-set-value');

    const summary = getSecretsLoadSummary();
    expect(summary.fromEnv).toContain('HF_TOKEN');
    expect(summary.fromGCP).not.toContain('HF_TOKEN');
  });

  it('explicit SECRETS_GCP_AUTHORITATIVE=true forces overwrite even when SECRETS_PROVIDER_PRIMARY=env', async () => {
    process.env.SECRETS_PROVIDER_PRIMARY = 'env';
    process.env.SECRETS_GCP_AUTHORITATIVE = 'true';
    process.env.HF_TOKEN = 'env-stale';

    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'huggingface-api-key') return 'gcp-wins';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.HF_TOKEN).toBe('gcp-wins');
  });

  it('explicit SECRETS_GCP_AUTHORITATIVE=false preserves legacy skip even when SECRETS_PROVIDER_PRIMARY=gcp', async () => {
    process.env.SECRETS_PROVIDER_PRIMARY = 'gcp';
    process.env.SECRETS_GCP_AUTHORITATIVE = 'false';
    process.env.HF_TOKEN = 'env-must-win';

    loadSecretMock.mockImplementation(async (key: string) => {
      if (key.startsWith('huggingface-')) return 'gcp-value-must-not-win';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.HF_TOKEN).toBe('env-must-win');
  });

  it('CRITICAL_SECRETS also honors authoritative mode (overwrites JWT_SECRET)', async () => {
    process.env.SECRETS_PROVIDER_PRIMARY = 'gcp';
    process.env.JWT_SECRET = 'env-stale-jwt';

    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'jwt-secret') return 'gcp-fresh-jwt';
      if (key === 'database-url') return 'postgresql://gcp/db';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.JWT_SECRET).toBe('gcp-fresh-jwt');
    expect(process.env.DATABASE_URL).toBe('postgresql://gcp/db');
  });
});
