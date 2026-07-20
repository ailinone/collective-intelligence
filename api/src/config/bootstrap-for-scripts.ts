// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * One-call bootstrap for CLI scripts (Lote 5 — D1).
 *
 * The server's startup (`src/index.ts`) wires 4 phases that must run in
 * sequence: (1) secrets manager init, (2) secrets → env, (3) provider
 * registry init, (4) registry singleton store. CLI scripts need the same
 * sequence but none of the HTTP/worker/background-job setup.
 *
 * Prior to D1, every script copy-pasted the same ~15 lines and routinely
 * missed one phase (the local-run-2/3 failures were caused by the benchmark
 * CLI skipping `initializeSecretsManager`).
 *
 * This module exposes a single `bootstrapForScripts()` that runs the
 * minimal infra needed for any CLI that calls the orchestration engine,
 * provider adapters, or Prisma. It is intentionally NOT imported by the
 * server — the server's startup is more complex and this module should not
 * accumulate server-only concerns.
 *
 * Usage:
 * ```ts
 * import { bootstrapForScripts } from '@/config/bootstrap-for-scripts';
 * await bootstrapForScripts();
 * // now getProviderRegistry(), prisma, etc. are ready
 * ```
 *
 * Env overrides:
 *   - `GCP_PROJECT_ID=your-gcp-project` — required for GCP Secret Manager
 *   - `SECRETS_PROVIDER_PRIMARY=gcp` — forces GCP even if heuristic drifts
 *   - `DATABASE_URL=postgresql://...` — override if local .env is wrong
 *   - `REDIS_URL=redis://...` — override for local ci-redis
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'bootstrap-for-scripts' });

export interface BootstrapResult {
  secretsLoaded: number;
  secretsSkipped: number;
  providersEnabled: number;
}

/**
 * Bootstrap the minimal infrastructure for a CLI script that needs the
 * provider registry and/or Prisma. Phases mirror `src/index.ts` but skip
 * HTTP, workers, and background services.
 *
 * Idempotent: calling twice is a no-op on the second call.
 */
let _bootstrapped = false;
export async function bootstrapForScripts(): Promise<BootstrapResult> {
  if (_bootstrapped) {
    log.debug('bootstrapForScripts already ran — skipping');
    return { secretsLoaded: -1, secretsSkipped: -1, providersEnabled: -1 };
  }

  log.info('bootstrapForScripts: starting infra bootstrap...');

  // Phase 1: Secrets manager (must be before env-loading)
  const { config } = await import('@/config/index');
  const { initializeSecretsManager } = await import('@/config/secrets-manager');
  await initializeSecretsManager(config.secrets);

  // Phase 2: Secrets → process.env
  // loadSecretsIntoEnv returns void — secret counts are logged by the loader
  // itself. We pass -1 since the counts are not available as return values.
  const { loadSecretsIntoEnv } = await import('@/config/load-secrets-into-env');
  await loadSecretsIntoEnv();
  const secretsLoaded = -1;
  const secretsSkipped = -1;

  // Phase 3: Provider registry
  const { initializeProviderRegistry, setProviderRegistry } = await import(
    '@/providers/provider-registry'
  );
  const registry = await initializeProviderRegistry(config.providers);
  setProviderRegistry(registry);

  const providersEnabled = registry.getProviderNames?.()?.length ?? -1;

  _bootstrapped = true;

  log.info(
    { secretsLoaded, secretsSkipped, providersEnabled },
    'bootstrapForScripts: infra ready',
  );
  return { secretsLoaded, secretsSkipped, providersEnabled };
}

/**
 * Reset the bootstrap flag. **Tests only** — production scripts never need
 * to re-bootstrap.
 */
export function resetBootstrapFlag(): void {
  _bootstrapped = false;
}
