// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Empirical smoke check: verify that local dev can load GCP secrets via ADC.
 *
 * Usage:
 *   pnpm tsx scripts/_check-gcp-secrets.ts
 *
 * Expected result:
 *   - secrets-manager initializes
 *   - at least one provider API key (e.g. openai-key) reads successfully
 *   - exit code 0
 *
 * If this fails with "ADC preflight failed", run:
 *   gcloud auth application-default login
 */
import { config } from '@/config';
import { initializeSecretsManager, getSecretsManager } from '@/config/secrets-manager';
import { logger } from '@/utils/logger';

const CANDIDATE_KEYS = ['openai-key', 'anthropic-key', 'mistral-key', 'database-url'];

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[smoke] Initializing secrets manager...');
  // eslint-disable-next-line no-console
  console.log('[smoke]   primary:', config.secrets.primaryProvider);
  // eslint-disable-next-line no-console
  console.log('[smoke]   fallback:', config.secrets.fallbackProvider);

  await initializeSecretsManager(config.secrets);
  const sm = getSecretsManager();
  // eslint-disable-next-line no-console
  console.log('[smoke] secrets-manager initialized');

  let successes = 0;
  for (const key of CANDIDATE_KEYS) {
    try {
      const value = await sm.getSecret(key);
      if (typeof value === 'string' && value.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[smoke] ✓ ${key} (length=${value.length})`);
        successes += 1;
      } else {
        // eslint-disable-next-line no-console
        console.log(`[smoke] ⚠ ${key} returned empty value`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.log(`[smoke] ✗ ${key}: ${message.split('\n')[0]}`);
    }
  }

  if (successes === 0) {
    logger.error('[smoke] No secrets resolved — check ADC and GCP project');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[smoke] PASS — ${successes}/${CANDIDATE_KEYS.length} secrets resolved`);
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[smoke] CRASH:', message);
  process.exit(1);
});
