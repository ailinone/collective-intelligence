// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: provider secrets that fail to resolve must always be
 * observable, never silent (2026-09-10 discovery audit — ANYSCALE_API_KEY).
 *
 * Reported symptom: the ANYSCALE_API_KEY secret exists in GCP Secret Manager
 * (confirmed live, version 3 enabled) and `ANYSCALE_API_KEY`'s mapping in
 * PROVIDER_SECRETS is correct, yet the env var was confirmed absent in the
 * running container with zero corroborating log output anywhere — not even
 * the standard "Secret not found" warn that other genuinely-absent secrets
 * produce.
 *
 * Root-cause investigation (see PR description for the full writeup):
 * re-running the real resolution path against the live GCP project (with
 * working credentials) showed `loadSecret('anyscale-api-key')` actually
 * succeeds and returns the real key, so the generic
 * resolution logic is not broken. What WAS confirmed structurally broken:
 * the final branch in the PROVIDER_SECRETS loop only escalated to `.warn()`
 * for a value that *looked like* a stale mock key; a secret that is
 * genuinely absent everywhere (no GCP value, no env fallback — exactly the
 * anyscale symptom) fell through with no log line at all, and the only way
 * to discover it was recorded was the pull-based admin endpoint backing
 * `getSecretsLoadSummary()`.
 *
 * The fix folds `getSecretsLoadSummary().notLoaded` into the single
 * "Secrets loading complete" boot log line, so every boot leaves a
 * permanent, greppable record of exactly which mapped provider secrets came
 * up empty. This test locks in the data contract that log line depends on:
 * a provider secret unresolved via both GCP and env must appear in
 * `notLoaded`, regardless of whether it happens to look like a mock value.
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
  'ANYSCALE_API_KEY',
  'ANYSCALE_BASE_URL',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'JWT_SECRET',
] as const;

function resetEnv() {
  for (const v of RESET_ENV_VARS) delete process.env[v];
}

describe('loadSecretsIntoEnv — provider-secret "not loaded" visibility', () => {
  beforeEach(() => {
    resetEnv();
    loadSecretMock.mockReset();
    loadSecretMock.mockResolvedValue(undefined);
    // Not testing degraded-boot/fail-fast semantics here.
    process.env.SECRETS_GCP_FAIL_FAST = 'false';
    process.env.JWT_SECRET = 'test-jwt';
    process.env.DATABASE_URL = 'postgresql://test/test';
    // Keep the "at least one LLM key" gate satisfied so the loader doesn't
    // throw for unrelated reasons.
    process.env.OPENAI_API_KEY = 'sk-present-for-this-test';
  });

  afterEach(() => {
    resetEnv();
  });

  it('records a genuinely-absent provider secret (no GCP value, no env fallback) as notLoaded — the exact anyscale symptom', async () => {
    // Simulate the real, empirically-verified anyscale-style failure: every
    // candidate GCP lookup cleanly resolves to undefined (no secret found,
    // no thrown error to log) and there is no existing env fallback.
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'anyscale-api-key' || key === 'anyscale-key') return undefined;
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.ANYSCALE_API_KEY).toBeUndefined();

    const summary = getSecretsLoadSummary();
    expect(summary.notLoaded).toContain('ANYSCALE_API_KEY');
    expect(summary.fromGCP).not.toContain('ANYSCALE_API_KEY');
    expect(summary.fromEnv).not.toContain('ANYSCALE_API_KEY');
  });

  it('does NOT record a provider secret as notLoaded once GCP successfully resolves it (sanity check against false positives)', async () => {
    loadSecretMock.mockImplementation(async (key: string) => {
      if (key === 'anyscale-api-key') return 'aph0_real-value-from-gcp';
      return undefined;
    });

    await loadSecretsIntoEnv();

    expect(process.env.ANYSCALE_API_KEY).toBe('aph0_real-value-from-gcp');
    const summary = getSecretsLoadSummary();
    expect(summary.notLoaded).not.toContain('ANYSCALE_API_KEY');
    expect(summary.fromGCP).toContain('ANYSCALE_API_KEY');
  });

  it('the "not loaded" list is exhaustive enough to catch ANY mapped provider secret that fails silently, not just anyscale', async () => {
    // Every candidate for every provider secret misses — the loader must
    // still boot (required: false) and must record every single one.
    loadSecretMock.mockResolvedValue(undefined);

    await loadSecretsIntoEnv();

    const summary = getSecretsLoadSummary();
    // OPENAI_API_KEY was pre-set in env (non-mock) so it's skipped from the
    // GCP attempt entirely and reported as loaded from env, not notLoaded.
    expect(summary.fromEnv).toContain('OPENAI_API_KEY');
    // A representative sample of other mapped-but-unresolved provider
    // secrets must all surface, proving this isn't special-cased to
    // anyscale alone.
    expect(summary.notLoaded).toContain('ANYSCALE_API_KEY');
    expect(summary.notLoaded).toContain('ANTHROPIC_API_KEY');
    expect(summary.notLoaded).toContain('COHERE_API_KEY');
  });
});
