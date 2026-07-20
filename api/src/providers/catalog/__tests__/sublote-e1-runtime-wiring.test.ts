// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Sublote E1 regression guard — 2026-04-24 runtime-wiring closure.
 *
 * ## Why this test exists
 *
 * Sublote D1 (2026-04-24) classified 10 new providers as `live-validation`
 * — each one verified with a real /chat/completions 200 response. But
 * classification is metadata-only; it does NOT by itself make the
 * provider reachable at runtime.
 *
 * Runtime reachability requires closure of three independent data
 * structures in `src/config/load-secrets-into-env.ts`:
 *
 *   1. `PROVIDER_SECRETS`         — GCP secret key → process.env env var
 *                                    tuple. Without this, the key stays
 *                                    in GCP Secret Manager and never
 *                                    reaches the container env. Gate for
 *                                    `loadSecretsIntoEnv()`.
 *   2. `ENV_VAR_TO_PROVIDER`      — env var → canonical providerId map.
 *                                    Without this, the Self-Healing
 *                                    Discovery Service (L1) cannot
 *                                    attribute a key-loaded event to the
 *                                    right provider at boot time.
 *   3. `LLM_PROVIDER_ENV_VARS`    — env-var allow-list for the
 *                                    "at-least-one-LLM-key-present"
 *                                    gate. Missing entries cause the
 *                                    loader to flag the provider's key
 *                                    as absent, which can trip the
 *                                    DEGRADED_SELF_HOSTED boot mode if
 *                                    it's the only key available.
 *
 * During D1's post-mortem we discovered that 7 of the 10 live-validated
 * providers were missing from ALL THREE structures — they were promoted
 * to `live-validation` on paper but remained unreachable at runtime. The
 * promotions happened silently because nothing in the test suite
 * enforced the closure invariant: bucket membership does NOT imply
 * wiring.
 *
 * This file encodes the closure invariant as a CI gate. If a future
 * maintainer promotes a provider to `live-validation` without wiring
 * the env var through all three structures, these tests fire BEFORE
 * the regression reaches production, with a specific failure message
 * naming the missing structure.
 *
 * ## What this test does NOT do
 *
 *   - No HTTP probes. The live-validation bucket encodes the probe
 *     evidence; this test only verifies that said evidence is backed
 *     by runtime wiring.
 *   - No assertion about `enabledByDefault`. That flag is orthogonal
 *     to wiring — a provider can be `false` and still reachable once
 *     its env var is set.
 *   - No adapter-factory registration check. Most live-validation
 *     providers use the generic `OpenAICompatibleHubAdapter` via the
 *     catalog bridge, so factory registration is not universally
 *     required. Adapter coverage is owned by
 *     `provider-kind-canonical-coverage.test.ts`.
 *
 * ## Exemption policy
 *
 * Providers in `RUNTIME_WIRING_EXEMPTIONS` are expected to bypass this
 * invariant. Adding an id here requires a comment citing the
 * architectural reason — NOT a convenience excuse. The current list
 * is EMPTY by design: all 47 live-validation entries (24 catalog + 13
 * switch + 10 D1 promotions) either wire through the 3 structures or
 * are switch-only providers (handled by the catalog-entry guard below).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { CONSOLIDATION_MATRIX } from '../consolidation-matrix';
import { PROVIDER_SECRETS } from '@/config/load-secrets-into-env';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOAD_SECRETS_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'config',
  'load-secrets-into-env.ts',
);

const LOAD_SECRETS_SRC = readFileSync(LOAD_SECRETS_PATH, 'utf8');

/**
 * Providers exempted from the closure invariant. MUST be empty by
 * default; each addition requires a code-comment rationale citing the
 * architectural reason (NOT "we'll fix it later" — that's a debt-
 * accumulating tombstone, not an exemption).
 *
 * If a new provider legitimately needs an exemption (e.g. a provider
 * that authenticates via a non-env mechanism like GCP ADC or AWS SigV4
 * at runtime, and whose `apiKeyEnvVar` is a placeholder), add it here
 * with a dated comment AND update consolidation-matrix.ts to note the
 * exemption.
 */
const RUNTIME_WIRING_EXEMPTIONS: ReadonlySet<string> = new Set<string>([
  // Empty by design.
]);

/**
 * The 10 providers promoted to live-validation in Sublote D1 (2026-04-24).
 * Hard-coded here so the test FAILS LOUDLY if a maintainer removes a
 * D1 promotion without also retracting the matrix entry. Each id is
 * backed by /chat/200 evidence in /tmp/subd1/bodies/<provider>.chat.body.
 *
 * The subset {groq, deepinfra, huggingface, cloudflare-workers-ai,
 * perplexity, fireworks-ai, sambanova} are the 7 that required NEW
 * tuples in load-secrets-into-env.ts during Sublote E1 execution.
 * The remaining 3 {github-models, infermatic, heliconeai} were already
 * wired pre-D1; they are still included here because the invariant
 * applies to ALL live-validation entries, not just the newly-added
 * tuples.
 */
const SUBLOTE_D1_LIVE_PROMOTIONS = [
  'groq',
  'deepinfra',
  'huggingface',
  'cloudflare-workers-ai',
  'github-models',
  'perplexity',
  'fireworks-ai',
  'sambanova',
  'infermatic',
  'heliconeai',
] as const;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** index PROVIDER_CATALOG by providerId for O(1) lookup. */
const catalogByProviderId = new Map(
  PROVIDER_CATALOG.map((entry) => [entry.providerId, entry]),
);

/** Set of env vars that have a GCP→ENV tuple (gate #1). */
const envVarsInProviderSecrets: ReadonlySet<string> = new Set(
  PROVIDER_SECRETS.map((tuple) => tuple.envVar),
);

/**
 * Extract the set of keys inside the ENV_VAR_TO_PROVIDER object literal
 * from load-secrets-into-env.ts source text. Uses a narrow regex
 * against "const ENV_VAR_TO_PROVIDER: …= { … };" block and extracts
 * bare identifier keys at line starts (no nested objects in this map,
 * so the simple match suffices).
 */
function extractEnvVarToProviderKeys(src: string): Set<string> {
  const blockMatch = src.match(
    /const\s+ENV_VAR_TO_PROVIDER\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\};/,
  );
  if (!blockMatch) {
    throw new Error(
      'Could not locate ENV_VAR_TO_PROVIDER declaration in ' +
        'load-secrets-into-env.ts — regex needs maintenance.',
    );
  }
  const body = blockMatch[1];
  const keys = new Set<string>();
  // Match either identifier keys (FOO_API_KEY:) or quoted keys ('FOO_KEY':).
  const keyRe = /(?:^|\n)\s*(?:'([A-Z_][A-Z0-9_]*)'|([A-Z_][A-Z0-9_]*))\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

/**
 * Extract the array of env-var strings declared in
 * `const LLM_PROVIDER_ENV_VARS = [ ... ] as const;`.
 */
function extractLlmProviderEnvVars(src: string): Set<string> {
  const blockMatch = src.match(
    /const\s+LLM_PROVIDER_ENV_VARS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
  );
  if (!blockMatch) {
    throw new Error(
      'Could not locate LLM_PROVIDER_ENV_VARS declaration in ' +
        'load-secrets-into-env.ts — regex needs maintenance.',
    );
  }
  const body = blockMatch[1];
  const vars = new Set<string>();
  const re = /'([A-Z_][A-Z0-9_]*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    vars.add(m[1]);
  }
  return vars;
}

const envVarToProviderKeys = extractEnvVarToProviderKeys(LOAD_SECRETS_SRC);
const llmProviderEnvVars = extractLlmProviderEnvVars(LOAD_SECRETS_SRC);

// ──────────────────────────────────────────────────────────────────────────
// (A) Self-consistency: D1 promotion list must match the matrix bucket
// ──────────────────────────────────────────────────────────────────────────

describe('Sublote E1 — D1 promotion list is self-consistent', () => {
  // Pins the D1 promotion list: every id in SUBLOTE_D1_LIVE_PROMOTIONS
  // must actually appear in live-validation. Fires if a future revert
  // removes a D1 entry from the matrix without updating this test.
  for (const id of SUBLOTE_D1_LIVE_PROMOTIONS) {
    it(`D1-promoted '${id}' is in live-validation bucket`, () => {
      expect(CONSOLIDATION_MATRIX['live-validation']).toContain(id);
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// (B) Gate 1: every catalog-managed live-validation provider has a
//     PROVIDER_SECRETS tuple for its apiKeyEnvVar
// ──────────────────────────────────────────────────────────────────────────

describe('Sublote E1 — Gate 1: PROVIDER_SECRETS tuple closure', () => {
  const liveValidated = CONSOLIDATION_MATRIX['live-validation'];
  const offenders: string[] = [];

  for (const providerId of liveValidated) {
    if (RUNTIME_WIRING_EXEMPTIONS.has(providerId)) continue;
    const entry = catalogByProviderId.get(providerId);
    // Switch-only providers (openai, anthropic, aws-bedrock, cartesia, …)
    // are not in PROVIDER_CATALOG — they're registered directly in
    // provider-registry.ts. Their credential wiring is hard-coded in
    // the CRITICAL_SECRETS block above, which is already covered by
    // load-secrets-into-env.ts's own top-level invariants. Skip.
    if (!entry) continue;
    // apiKeyOptional providers (self-hosted: vllm, lm-studio, ollama,
    // local-*) have no required env key; their `apiKeyEnvVar` is a
    // convention-only placeholder. Skip.
    if (entry.apiKeyOptional === true) continue;

    it(`${providerId}: apiKeyEnvVar '${entry.apiKeyEnvVar}' has GCP→ENV tuple in PROVIDER_SECRETS`, () => {
      // If this fires: the provider is live-validated in the matrix
      // (real /chat/200 evidence) but its credential never reaches
      // process.env. Boot will skip model discovery for this provider
      // and /v1/models will return 0 models from it. Fix: add a tuple
      // `{ envVar: '<APIKEY>', secretKeys: ['<gcp-key-suffix>', …] }`
      // to PROVIDER_SECRETS in load-secrets-into-env.ts.
      const present = envVarsInProviderSecrets.has(entry.apiKeyEnvVar);
      if (!present) offenders.push(`${providerId}→${entry.apiKeyEnvVar}`);
      expect(present).toBe(true);
    });
  }

  it('zero offenders across all catalog-managed live-validation providers', () => {
    // Aggregate sanity: the per-provider `it` blocks above fail
    // individually, but this aggregate test ensures the full count
    // lands in a single actionable report line for PR reviewers.
    expect(offenders).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (C) Gate 2: Self-Healing Discovery attribution
//     every env var wired in PROVIDER_SECRETS that belongs to a
//     live-validation provider also has an ENV_VAR_TO_PROVIDER entry
// ──────────────────────────────────────────────────────────────────────────

describe('Sublote E1 — Gate 2: ENV_VAR_TO_PROVIDER attribution closure', () => {
  const liveValidated = CONSOLIDATION_MATRIX['live-validation'];
  const offenders: string[] = [];

  for (const providerId of liveValidated) {
    if (RUNTIME_WIRING_EXEMPTIONS.has(providerId)) continue;
    const entry = catalogByProviderId.get(providerId);
    if (!entry) continue;
    if (entry.apiKeyOptional === true) continue;

    it(`${providerId}: env var '${entry.apiKeyEnvVar}' has ENV_VAR_TO_PROVIDER entry`, () => {
      // If this fires: the env var loads into process.env (gate 1 OK)
      // but the L1 Self-Healing Discovery Service cannot attribute
      // the key-present event to the right canonical providerId. The
      // provider will appear "key-missing" in boot telemetry even
      // though the key is present. Fix: add `<APIKEY>: '<providerId>'`
      // to ENV_VAR_TO_PROVIDER in load-secrets-into-env.ts.
      const present = envVarToProviderKeys.has(entry.apiKeyEnvVar);
      if (!present) offenders.push(`${providerId}→${entry.apiKeyEnvVar}`);
      expect(present).toBe(true);
    });
  }

  it('zero attribution-gap offenders', () => {
    expect(offenders).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (D) Gate 3: DEGRADED_SELF_HOSTED avoidance
//     every live-validation env var counts toward the "at least one
//     LLM key present" boot-mode decision
// ──────────────────────────────────────────────────────────────────────────

describe('Sublote E1 — Gate 3: LLM_PROVIDER_ENV_VARS inclusion closure', () => {
  const liveValidated = CONSOLIDATION_MATRIX['live-validation'];
  const offenders: string[] = [];

  for (const providerId of liveValidated) {
    if (RUNTIME_WIRING_EXEMPTIONS.has(providerId)) continue;
    const entry = catalogByProviderId.get(providerId);
    if (!entry) continue;
    if (entry.apiKeyOptional === true) continue;

    it(`${providerId}: env var '${entry.apiKeyEnvVar}' is in LLM_PROVIDER_ENV_VARS`, () => {
      // If this fires: the provider's key is recognized and attributed
      // (gates 1+2 OK) but does not count toward the "at least one
      // LLM provider key present" check. If it's the ONLY key in the
      // env at boot, the container starts in DEGRADED_SELF_HOSTED mode
      // and disables hub providers silently. Fix: add '<APIKEY>' to
      // LLM_PROVIDER_ENV_VARS in load-secrets-into-env.ts.
      const present = llmProviderEnvVars.has(entry.apiKeyEnvVar);
      if (!present) offenders.push(`${providerId}→${entry.apiKeyEnvVar}`);
      expect(present).toBe(true);
    });
  }

  it('zero boot-mode-gate offenders', () => {
    expect(offenders).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (E) Cloudflare side-car: the URL template requires an extra env var
//     that is NOT an auth credential but IS runtime-required
// ──────────────────────────────────────────────────────────────────────────

describe('Sublote E1 — Cloudflare Workers AI side-car env var', () => {
  // cloudflare-workers-ai has a templated baseUrl
  // (`/accounts/{account_id}/ai/v1`). The adapter factory at
  // default-adapter-factories.ts reads CLOUDFLARE_ACCOUNT_ID from
  // process.env and substitutes it at construction time. If the
  // account id never lands in the env, the adapter constructs a URL
  // with the literal placeholder `{account_id}` and every request
  // returns 404. This is a non-auth runtime requirement that must be
  // wired via PROVIDER_SECRETS even though no catalog entry's
  // apiKeyEnvVar references it.

  it('CLOUDFLARE_ACCOUNT_ID has a GCP→ENV tuple in PROVIDER_SECRETS', () => {
    expect(envVarsInProviderSecrets.has('CLOUDFLARE_ACCOUNT_ID')).toBe(true);
  });

  it('cloudflare-workers-ai catalog entry declares CLOUDFLARE_ACCOUNT_ID via extraEnvVars', () => {
    // Cross-check: the catalog entry must document the requirement
    // via its `extraEnvVars` field. If this fires, either the catalog
    // entry lost the documentation (runtime still works but operators
    // lose the hint) or the sidecar requirement changed (the test
    // and the catalog must move together).
    const cf = catalogByProviderId.get('cloudflare-workers-ai');
    expect(cf).toBeTruthy();
    expect(cf?.extraEnvVars).toBeTruthy();
    expect(Object.keys(cf?.extraEnvVars ?? {})).toContain('CLOUDFLARE_ACCOUNT_ID');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (F) D1-specific regression: the 7 newly-wired env vars are present
// ──────────────────────────────────────────────────────────────────────────

describe('Sublote E1 — D1 env vars landed in all 3 wiring structures', () => {
  // Pin the exact 7 env vars that were net-new in Sublote E1.
  // Ordering matches the source-file comment block for traceability.
  const D1_NEW_ENV_VARS = [
    'GROQ_API_KEY',
    'DEEPINFRA_API_KEY',
    'HF_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'PERPLEXITY_API_KEY',
    'FIREWORKS_AI_API_KEY',
    'SAMBANOVA_API_KEY',
  ] as const;

  for (const envVar of D1_NEW_ENV_VARS) {
    it(`'${envVar}' is in PROVIDER_SECRETS (gate 1)`, () => {
      expect(envVarsInProviderSecrets.has(envVar)).toBe(true);
    });
    it(`'${envVar}' is in ENV_VAR_TO_PROVIDER (gate 2)`, () => {
      expect(envVarToProviderKeys.has(envVar)).toBe(true);
    });
    it(`'${envVar}' is in LLM_PROVIDER_ENV_VARS (gate 3)`, () => {
      expect(llmProviderEnvVars.has(envVar)).toBe(true);
    });
  }
});
