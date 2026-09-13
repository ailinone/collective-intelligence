// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — LLAMA_API_KEY resolves from the `meta-key` GCP secret
 * candidate (LOTE AM, 2026-09-08).
 *
 * ## Why this test exists
 *
 * LOTE AK (2026-09-04) absorbed the duplicate `meta` catalog row into
 * `llama` (see `providers.catalog.ts` providerId 'llama': `aliases:
 * ['llama-api', 'meta', 'meta-ai']`) because both rows described the same
 * service and `meta` pointed at the wrong (docs, not API) host. That merge
 * was catalog-only — it never touched `load-secrets-into-env.ts`, whose
 * `LLAMA_API_KEY` tuple only listed `['llama-key', 'llama-api-key']` as GCP
 * secret candidates.
 *
 * The operator provisioned the real credential under `<prefix>-meta-key`
 * (confirmed live 2026-09-08 via `gcloud secrets describe
 * <prefix>-meta-key --project <gcp-project>` + `gcloud secrets versions list`
 * showing an ENABLED version), matching the catalog's own `meta` alias,
 * but NOT under `<prefix>-llama-key` (confirmed absent: `gcloud secrets
 * describe <prefix>-llama-key` fails with a not-found error). Without
 * `meta-key` in the secretKeys candidate list, that populated secret would
 * never reach `process.env.LLAMA_API_KEY`, and the `llama` catalog row
 * would stay stuck at `missing-api-key` forever despite the credential
 * genuinely existing in GCP.
 *
 * These tests pin the fix at the `loadSecret`-mock level (no live GCP call),
 * mirroring `load-secrets-authoritative.test.ts`'s harness.
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
  'LLAMA_API_KEY',
  'DATABASE_URL',
  'JWT_SECRET',
] as const;

function resetEnv() {
  for (const v of RESET_ENV_VARS) delete process.env[v];
}

describe('loadSecretsIntoEnv — LLAMA_API_KEY resolves from meta/llama alias candidates', () => {
  beforeEach(() => {
    resetEnv();
    loadSecretMock.mockReset();
    loadSecretMock.mockResolvedValue(undefined);
    // Not exercising the degraded-boot fail-fast tripwire here.
    process.env.SECRETS_GCP_FAIL_FAST = 'false';
    // Pre-populate critical secrets so the CRITICAL_SECRETS loop succeeds.
    process.env.JWT_SECRET = 'test-jwt';
    process.env.DATABASE_URL = 'postgresql://test/test';
  });

  afterEach(() => {
    resetEnv();
  });

  it('populates LLAMA_API_KEY from the meta-key secret when the llama-key secret does not exist (the real, confirmed GCP state)', async () => {
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'jwt-secret') return 'gcp-jwt';
      if (key === 'database-url') return 'postgresql://gcp/db';
      if (key === 'meta-key') return 'provisioned-under-meta-key';
      // llama-key / llama-api-key / meta-api-key intentionally resolve to
      // undefined here, confirmed absent from GCP for the llama-key secret via
      // `gcloud secrets describe` (2026-09-08).
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.LLAMA_API_KEY).toBe('provisioned-under-meta-key');
  });

  it('still resolves LLAMA_API_KEY from llama-key if that secret is ever provisioned under the canonical name instead', async () => {
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'jwt-secret') return 'gcp-jwt';
      if (key === 'database-url') return 'postgresql://gcp/db';
      if (key === 'llama-key') return 'provisioned-under-llama-key';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.LLAMA_API_KEY).toBe('provisioned-under-llama-key');
  });

  it('leaves LLAMA_API_KEY unset when none of the meta/llama alias candidates exist in GCP', async () => {
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'jwt-secret') return 'gcp-jwt';
      if (key === 'database-url') return 'postgresql://gcp/db';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.LLAMA_API_KEY).toBeUndefined();
  });
});
