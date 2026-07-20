// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog ↔ Loader wiring completeness — invariant guard.
 *
 * ## Why this test exists
 *
 * `sublote-e1-runtime-wiring.test.ts` enforces the 3-gate closure
 * (PROVIDER_SECRETS → ENV_VAR_TO_PROVIDER → LLM_PROVIDER_ENV_VARS) for
 * the providers in `CONSOLIDATION_MATRIX['live-validation']` only.
 * That bucket is narrow on purpose — it pins providers with concrete
 * /chat/200 evidence — but a provider can sit in `credentials-missing`
 * or `disabled-by-default` for months while its operator still expects
 * to flip a switch on GCP and have everything light up at the next
 * container restart.
 *
 * On 2026-04-27 a catalog audit surfaced 22 catalog rows that:
 *   - declare an `apiKeyEnvVar` (not self-hosted, not optional);
 *   - have an adapter or use the generic OAI-compat hub bridge;
 *   - had **no** tuple in `PROVIDER_SECRETS`.
 *
 * Result: even after the operator provisioned the GCP secret with the
 * conventional name, `process.env.<X>_API_KEY` stayed empty at boot,
 * which meant the catalog-loader preflight skipped the row with
 * reason='disabled-by-default' OR the adapter constructed with no
 * credential and 401'd on every call. The matrix said "credentials-
 * missing"; in reality, the credentials were present but the loader
 * couldn't see them.
 *
 * This file pins the broader invariant: **every catalog row whose
 * apiKeyEnvVar is mandatory at runtime must have a PROVIDER_SECRETS
 * tuple, regardless of which CONSOLIDATION_MATRIX bucket it currently
 * sits in.** Wiring is cheap and reversible — leaving it out is the
 * actual risk.
 *
 * ## Invariants enforced
 *
 *   J6  — for every entry in PROVIDER_CATALOG with `apiKeyEnvVar` set
 *         AND `apiKeyOptional !== true`, an entry exists in
 *         `PROVIDER_SECRETS` whose `envVar` matches.
 *
 *   J7  — for every such entry, an attribution mapping exists in
 *         `ENV_VAR_TO_PROVIDER`. (Sublote E1 already enforces this for
 *         live-validation; J7 widens it.)
 *
 *   J8  — for every such entry whose catalog row is LLM-class
 *         (any of `chat`, `embeddings`, `streaming`, `tools`, or
 *         `audio*` capabilities, but NOT image-only or video-only
 *         providers), the env var appears in `LLM_PROVIDER_ENV_VARS`.
 *         Image/video-only providers are intentionally excluded — their
 *         keys do not satisfy the "at least one LLM key present" boot
 *         gate.
 *
 * ## Scope distinctions
 *
 *   - This test is broader than `sublote-e1-runtime-wiring.test.ts`:
 *     it asserts wiring for every catalog row with `apiKeyEnvVar`,
 *     not just live-validation entries.
 *   - It is orthogonal to `discovery-compliance-registry.test.ts`:
 *     compliance classifies HOW inventory is materialized; this test
 *     verifies that AUTH credentials reach the runtime regardless of
 *     inventory provenance.
 *   - It does NOT test that the GCP secret actually exists. That is
 *     operator-bound and lives in deployment runbooks. Here we only
 *     assert the loader knows where to LOOK if the operator provisions.
 *
 * ## Exemption policy
 *
 * Catalog rows in `WIRING_EXEMPTIONS` bypass this invariant. Each
 * exemption requires a code-comment rationale. The list is empty by
 * default — every legitimate provider should wire through.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { PROVIDER_SECRETS } from '@/config/load-secrets-into-env';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOAD_SECRETS_PATH = join(__dirname, '..', '..', '..', 'config', 'load-secrets-into-env.ts');
const LOAD_SECRETS_SRC = readFileSync(LOAD_SECRETS_PATH, 'utf8');

const WIRING_EXEMPTIONS: ReadonlySet<string> = new Set<string>([
  // Empty by design.
]);

/** Image-only / video-only providers do not count toward the LLM gate. */
function isLlmClass(entry: (typeof PROVIDER_CATALOG)[number]): boolean {
  const supports = entry.supports;
  if (!supports) return false;
  if (
    supports.chat === true ||
    supports.embeddings === true ||
    supports.streaming === true ||
    supports.tools === true ||
    supports.jsonMode === true ||
    supports.speechToText === true ||
    supports.textToSpeech === true ||
    supports.speechToSpeech === true
  ) {
    return true;
  }
  return false;
}

function extractEnvVarToProviderKeys(src: string): Set<string> {
  const blockMatch = src.match(
    /const\s+ENV_VAR_TO_PROVIDER\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\};/,
  );
  if (!blockMatch) {
    throw new Error(
      'Could not locate ENV_VAR_TO_PROVIDER declaration in load-secrets-into-env.ts',
    );
  }
  const body = blockMatch[1];
  const keys = new Set<string>();
  const keyRe = /(?:^|\n)\s*(?:'([A-Z_][A-Z0-9_]*)'|([A-Z_][A-Z0-9_]*))\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

function extractLlmProviderEnvVars(src: string): Set<string> {
  const blockMatch = src.match(
    /const\s+LLM_PROVIDER_ENV_VARS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
  );
  if (!blockMatch) {
    throw new Error(
      'Could not locate LLM_PROVIDER_ENV_VARS declaration in load-secrets-into-env.ts',
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

const envVarsInProviderSecrets = new Set(PROVIDER_SECRETS.map((tuple) => tuple.envVar));
const envVarToProviderKeys = extractEnvVarToProviderKeys(LOAD_SECRETS_SRC);
const llmProviderEnvVars = extractLlmProviderEnvVars(LOAD_SECRETS_SRC);

const candidates = PROVIDER_CATALOG.filter((entry) => {
  if (!entry.apiKeyEnvVar) return false;
  if (entry.apiKeyOptional === true) return false;
  if (WIRING_EXEMPTIONS.has(entry.providerId)) return false;
  return true;
});

describe('catalog ↔ loader wiring completeness', () => {
  describe('J6 — every catalog apiKeyEnvVar has a PROVIDER_SECRETS tuple', () => {
    const offenders: Array<{ providerId: string; envVar: string }> = [];
    for (const entry of candidates) {
      if (!envVarsInProviderSecrets.has(entry.apiKeyEnvVar!)) {
        offenders.push({ providerId: entry.providerId, envVar: entry.apiKeyEnvVar! });
      }
    }

    it('zero unwired catalog rows', () => {
      // If this fires: a catalog row declares an apiKeyEnvVar but no
      // tuple exists in PROVIDER_SECRETS to load it from GCP. Even if
      // the operator provisions the canonical GCP secret, process.env
      // will stay empty at boot. Fix: add a tuple
      // `{ envVar: '<APIKEY>', secretKeys: ['<provider-slug>-key', …] }`
      // in load-secrets-into-env.ts.
      expect(offenders).toEqual([]);
    });
  });

  describe('J7 — every catalog apiKeyEnvVar has an ENV_VAR_TO_PROVIDER mapping', () => {
    const offenders: Array<{ providerId: string; envVar: string }> = [];
    for (const entry of candidates) {
      if (!envVarToProviderKeys.has(entry.apiKeyEnvVar!)) {
        offenders.push({ providerId: entry.providerId, envVar: entry.apiKeyEnvVar! });
      }
    }

    it('zero attribution-gap rows', () => {
      // If this fires: the env var loads (J6 OK) but L1 Self-Healing
      // Discovery cannot map it back to a provider id, so boot
      // telemetry will report the provider as key-missing despite the
      // key being in process.env. Fix: add `<APIKEY>: '<providerId>'`
      // to ENV_VAR_TO_PROVIDER.
      expect(offenders).toEqual([]);
    });
  });

  describe('J8 — every LLM-class catalog apiKeyEnvVar is in LLM_PROVIDER_ENV_VARS', () => {
    const offenders: Array<{ providerId: string; envVar: string }> = [];
    for (const entry of candidates) {
      if (!isLlmClass(entry)) continue;
      if (!llmProviderEnvVars.has(entry.apiKeyEnvVar!)) {
        offenders.push({ providerId: entry.providerId, envVar: entry.apiKeyEnvVar! });
      }
    }

    it('zero boot-mode-gate gaps for LLM-class providers', () => {
      // If this fires: the provider is LLM-class (chat/embeddings/etc.)
      // and its key loads + attributes correctly, but the env var is
      // not counted toward the "at least one LLM key present" boot
      // gate. If it's the only key in the env at boot, the container
      // starts in DEGRADED_SELF_HOSTED mode and disables hub providers
      // silently. Fix: add '<APIKEY>' to LLM_PROVIDER_ENV_VARS.
      expect(offenders).toEqual([]);
    });
  });

  it('coverage sanity — at least 60 catalog rows are checked', () => {
    // Pin a floor so an accidental empty-filter mistake doesn't make
    // the test trivially pass. The current catalog has ~70 candidates
    // (81 apiKeyEnvVar entries minus self-hosted/optional ones).
    expect(candidates.length).toBeGreaterThanOrEqual(60);
  });
});
