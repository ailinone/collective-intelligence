// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog Loader — Boot-Time Provider Registration
 *
 * Reads the static `PROVIDER_CATALOG`, validates it with Zod, filters out
 * entries that should not be live-registered (disabled, denied, catalog-only,
 * unsupported integration class), and hands each remaining entry to the
 * existing `providerPluginManager` for standard init → healthCheck → register
 * lifecycle.
 *
 * This is the ONLY place the static catalog becomes runtime state. The rest of
 * the system reads providers from:
 *   - `ProviderPluginManager` (lifecycle + health)
 *   - `ProviderRegistry` (dispatch — populated transitively via registerPlugin)
 *   - `CentralModelDiscoveryService` (discovery — separate concern)
 *
 * Idempotency: the loader records a module-level "loaded" flag so repeated
 * calls (e.g. from tests importing index.ts multiple times) are no-ops after
 * the first success. Call `resetCatalogLoaderForTests()` to reset in tests.
 *
 * Failure philosophy: individual entry failures are ISOLATED. One bad env var
 * must not abort the batch — we collect errors into a diagnostic summary so
 * the boot logs show the full picture.
 */

import { logger } from '@/utils/logger';
import { providerPluginManager } from '../provider-plugin-system';
import {
  CatalogProviderPlugin,
  CatalogPluginUnsupportedError,
  createCatalogProviderPlugin,
} from './catalog-provider-plugin';
import { PROVIDER_CATALOG } from './providers.catalog';
import type { ProviderCatalogEntry } from './provider-catalog.types';
import { ProviderCatalogSchema } from './provider-catalog.schema';
import { registerDefaultAdapterFactories } from './default-adapter-factories';

/**
 * Reason codes for skipped/failed entries — stable strings suitable for
 * dashboards, alerting rules, and structural test assertions.
 */
export type CatalogLoadSkipReason =
  | 'disabled-by-default'
  | 'denied-by-default'
  | 'catalog-only-mode'
  | 'unsupported-integration-class'
  | 'missing-api-key'
  | 'health-check-failed'
  | 'init-error'
  | 'registration-error';

export interface CatalogLoadEntryResult {
  readonly providerId: string;
  readonly displayName: string;
  readonly integrationClass: string;
  readonly status: 'registered' | 'skipped' | 'failed';
  readonly reason?: CatalogLoadSkipReason;
  readonly detail?: string;
  readonly modelsDiscovered?: number;
}

export interface CatalogLoadSummary {
  readonly attempted: number;
  readonly registered: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly CatalogLoadEntryResult[];
  /** Breakdown of skip/failure reasons. Useful for quick boot triage. */
  readonly reasonCounts: Readonly<Record<CatalogLoadSkipReason, number>>;
}

const EMPTY_REASON_COUNTS: Record<CatalogLoadSkipReason, number> = {
  'disabled-by-default': 0,
  'denied-by-default': 0,
  'catalog-only-mode': 0,
  'unsupported-integration-class': 0,
  'missing-api-key': 0,
  'health-check-failed': 0,
  'init-error': 0,
  'registration-error': 0,
};

let loaded = false;
let lastSummary: CatalogLoadSummary | null = null;

export interface CatalogLoaderOptions {
  /**
   * Override the static catalog. Primarily for tests — production paths
   * should always call with no argument to use the built-in `PROVIDER_CATALOG`.
   */
  readonly catalog?: readonly ProviderCatalogEntry[];
  /**
   * If true, re-run even when already loaded. Production must leave this
   * false — idempotency prevents double registration on module re-import.
   */
  readonly force?: boolean;
  /**
   * If true, skip Zod validation. DO NOT use in production — this exists
   * only to let tests feed intentionally-malformed entries through the
   * validation path.
   */
  readonly skipValidation?: boolean;
}

/**
 * Run the full boot-time load. Returns a structured summary — never throws,
 * even if the whole catalog is empty or invalid. Callers inspect the summary.
 *
 * Safe to await early in boot (before HTTP server starts listening), as long
 * as env vars and DB connections are already initialized.
 */
export async function loadProviderCatalog(
  options: CatalogLoaderOptions = {},
): Promise<CatalogLoadSummary> {
  const log = logger.child({ component: 'catalog-loader' });

  if (loaded && !options.force) {
    log.debug('Catalog loader already ran — returning cached summary');
    return lastSummary ?? buildEmptySummary();
  }

  const source = options.catalog ?? PROVIDER_CATALOG;

  // ── Dedicated adapter factories (idempotent) ──────────────────────────
  // Must run before the plugin bridge consults `resolveAdapterFactory` during
  // iteration. `registerAdapterFactory` itself short-circuits duplicate
  // registrations, so calling this on every `loadProviderCatalog` (including
  // forced reloads in tests) is safe.
  registerDefaultAdapterFactories();

  // ── Validation ────────────────────────────────────────────────────────
  let validated: readonly ProviderCatalogEntry[];
  if (options.skipValidation) {
    validated = source;
  } else {
    const parsed = ProviderCatalogSchema.safeParse(source);
    if (!parsed.success) {
      log.error(
        { issues: parsed.error.issues },
        'Provider catalog failed Zod validation — registering ZERO catalog providers. Check catalog entries.',
      );
      const summary = buildEmptySummary();
      lastSummary = summary;
      loaded = true;
      return summary;
    }
    validated = parsed.data as readonly ProviderCatalogEntry[];
  }

  log.info(
    { total: validated.length },
    'Provider catalog loaded & validated — beginning plugin registration',
  );

  // ── Iteration (isolated per entry) ────────────────────────────────────
  const results: CatalogLoadEntryResult[] = [];
  const reasonCounts: Record<CatalogLoadSkipReason, number> = {
    ...EMPTY_REASON_COUNTS,
  };

  for (const entry of validated) {
    const result = await loadSingleEntry(entry);
    results.push(result);
    if (result.reason) {
      reasonCounts[result.reason] += 1;
    }
  }

  const registered = results.filter((r) => r.status === 'registered').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const summary: CatalogLoadSummary = {
    attempted: validated.length,
    registered,
    skipped,
    failed,
    results,
    reasonCounts,
  };

  log.info(
    {
      attempted: summary.attempted,
      registered: summary.registered,
      skipped: summary.skipped,
      failed: summary.failed,
      reasonCounts: summary.reasonCounts,
    },
    'Catalog loader complete',
  );

  lastSummary = summary;
  loaded = true;
  return summary;
}

/**
 * Load one catalog entry. Always returns a result — never throws.
 */
async function loadSingleEntry(
  entry: ProviderCatalogEntry,
): Promise<CatalogLoadEntryResult> {
  const base = {
    providerId: entry.providerId,
    displayName: entry.displayName,
    integrationClass: entry.integrationClass,
  };

  // ── Pre-flight filters (cheap, no side effects) ─────────────────────
  if (entry.denyByDefault === true) {
    return {
      ...base,
      status: 'skipped',
      reason: 'denied-by-default',
      detail: 'denyByDefault=true in catalog',
    };
  }

  if (entry.enabledByDefault === false) {
    // Opt-in providers (typically self-hosted) can still register when the
    // user has clearly signaled intent by setting the catalog-declared env
    // vars. This preserves the legacy switch behavior where
    // `config.providers` toggled `enabled: !!process.env.OLLAMA_URL` — if
    // the URL or API key is actually present in env, we proceed to
    // registration instead of skipping.
    const apiKeyPresent =
      typeof process.env[entry.apiKeyEnvVar] === 'string' &&
      (process.env[entry.apiKeyEnvVar] ?? '').length > 0;
    const baseUrlPresent =
      entry.baseUrlEnvVar !== undefined &&
      typeof process.env[entry.baseUrlEnvVar] === 'string' &&
      (process.env[entry.baseUrlEnvVar] ?? '').length > 0;
    const userOptedIn = apiKeyPresent || baseUrlPresent;
    if (!userOptedIn) {
      return {
        ...base,
        status: 'skipped',
        reason: 'disabled-by-default',
        detail:
          'enabledByDefault=false in catalog; no env override detected ' +
          `(neither ${entry.apiKeyEnvVar} nor ${entry.baseUrlEnvVar ?? '<no baseUrlEnvVar>'} is set)`,
      };
    }
    // User opted in via env — fall through and attempt registration.
  }

  if (entry.integrationMode === 'catalog-only') {
    return {
      ...base,
      status: 'skipped',
      reason: 'catalog-only-mode',
      detail: 'integrationMode=catalog-only — inventory only, no runtime wiring',
    };
  }

  // ── Construct plugin (can throw CatalogPluginUnsupportedError) ──────
  let plugin: CatalogProviderPlugin;
  try {
    plugin = createCatalogProviderPlugin(entry);
  } catch (err) {
    if (err instanceof CatalogPluginUnsupportedError) {
      return {
        ...base,
        status: 'skipped',
        reason: 'unsupported-integration-class',
        detail: err.message,
      };
    }
    return {
      ...base,
      status: 'failed',
      reason: 'init-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Register via plugin manager (drives init → health → register) ───
  let registrationResult: Awaited<
    ReturnType<typeof providerPluginManager.registerPlugin>
  >;
  try {
    registrationResult = await providerPluginManager.registerPlugin(plugin);
  } catch (err) {
    // `registerPlugin` internally catches most errors and returns a result,
    // but truly unexpected throws (e.g. import failures) land here.
    return {
      ...base,
      status: 'failed',
      reason: 'registration-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (registrationResult.success) {
    return {
      ...base,
      status: 'registered',
      modelsDiscovered: registrationResult.modelsDiscovered,
    };
  }

  // ── Map registerPlugin failure → taxonomy ───────────────────────────
  const errMsg = registrationResult.error ?? 'unknown';
  const reason = classifyRegistrationError(errMsg);

  return {
    ...base,
    status: 'failed',
    reason,
    detail: errMsg,
  };
}

/**
 * Inspect the plugin-manager's error string to assign a stable taxonomy
 * reason. Strings are generated by `provider-plugin-system.ts` — we look
 * for stable substrings rather than exact matches to stay resilient to
 * log-message tweaks.
 */
function classifyRegistrationError(
  msg: string,
): CatalogLoadSkipReason {
  const lower = msg.toLowerCase();
  if (
    lower.includes('missing api key') ||
    lower.includes('set ') && lower.includes('_api_key')
  ) {
    return 'missing-api-key';
  }
  if (lower.includes('health check')) {
    return 'health-check-failed';
  }
  return 'init-error';
}

function buildEmptySummary(): CatalogLoadSummary {
  return {
    attempted: 0,
    registered: 0,
    skipped: 0,
    failed: 0,
    results: [],
    reasonCounts: { ...EMPTY_REASON_COUNTS },
  };
}

/**
 * Read the summary from the most recent load. Returns null if the loader
 * has not yet run in this process. Useful for /health endpoints and tests.
 */
export function getLastCatalogLoadSummary(): CatalogLoadSummary | null {
  return lastSummary;
}

/**
 * Reset loader state. Tests only — production must never call this.
 */
export function resetCatalogLoaderForTests(): void {
  loaded = false;
  lastSummary = null;
}
