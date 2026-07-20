// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Anti-hardcode guard.
 *
 * Purpose: ensure the catalog continues to be the primary growth vector for
 * OpenAI-compatible providers, NOT `provider-registry.ts` switch cases.
 *
 * This test enforces two invariants:
 *
 *   (1) **Count baseline** — the number of `case 'provider-id':` statements
 *       in `provider-registry.ts` must NOT increase above the recorded
 *       baseline. Decreases are fine (they mean a provider got migrated).
 *       Increases mean someone added a per-provider switch case that SHOULD
 *       have been a catalog entry. Update the baseline intentionally when
 *       genuinely adding a first-party native adapter.
 *
 *   (2) **Catalog/switch disjointness** — no entry in `PROVIDER_CATALOG`
 *       whose integrationClass is OAI-compatible (pure/quirks/self-hosted/
 *       gateway) may also appear as a switch case. The two paths registering
 *       the same provider would cause double-registration + non-deterministic
 *       dispatch.
 *
 * Baseline must be updated DELIBERATELY with a commit message explaining why
 * (e.g. "adding Tencent Cloud native adapter — not OAI-compatible").
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { isOpenAICompatibleEntry } from '../provider-catalog.types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve provider-registry.ts relative to this test file. Robust against
// different working directories (vitest changes cwd in some configs).
const REGISTRY_PATH = join(
  __dirname,
  '..',
  '..',
  'provider-registry.ts',
);

// ─── Baseline — the "do-not-regress" threshold ───────────────────────────
//
// HISTORY:
//   2026-04-21 (initial)   — 41: measured after removing
//                                 `model-client-factory.ts`, before any
//                                 switch-case migration.
//   2026-04-21 (LOTE E)    — 21: ASPIRATIONAL: assumed LOTE E migrated 20
//                                 OAI-compat providers fully. In reality,
//                                 the catalog rows were added but the
//                                 switch cases were NEVER removed, so the
//                                 true runtime count stayed at ~43 and
//                                 this test was silently failing.
//   2026-04-22 (Batch 7.1) — 22: added `aws-bedrock` native adapter.
//                                 Bedrock's Converse API is NOT OpenAI-
//                                 compatible (separate top-level `system[]`,
//                                 distinct tool/stream shapes, SigV4 auth
//                                 via AWS SDK) — catalog entry is therefore
//                                 the wrong path; switch case is correct.
//   2026-04-22 (Batch 8.1) — 23: added `aws-sagemaker` native adapter.
//                                 SageMaker endpoints are *customer-deployed*
//                                 — each endpoint has its own request/
//                                 response schema (openai / jumpstart /
//                                 hf-tgi). No universal normalized surface
//                                 exists; SigV4 auth via AWS SDK. Catalog
//                                 can't express the per-endpoint schema
//                                 dispatch; switch case is correct.
//   2026-04-22 (Lot B)     — 26: LOTE E honestly completed. Lot B removed
//                                 17 switch cases that duplicated catalog
//                                 entries (16 OAI-compat hubs — nvidia,
//                                 moonshot, minimax, friendli, aihubmix,
//                                 novita, aiml, imagerouter, orqai,
//                                 edenai, heliconeai, cometapi, nanogpt,
//                                 requesty, poe, routeway — plus the
//                                 `nvidia-hub` alias absorbed into the
//                                 `nvidia` catalog row's aliases[]).
//                                 The baseline rose to 26 (not down to
//                                 the aspirational 21) because four
//                                 self-hosted catalog-duplicates were
//                                 temporarily preserved in the switch:
//                                 `ollama`, `local-llama`, `local-kobold`,
//                                 `local-embeddings`.
//   2026-04-22 (residue-B) — 22: residue-closure pass B removed those
//                                 four self-hosted duplicates from both
//                                 the switch AND `config/index.ts`. The
//                                 catalog owns them now via the
//                                 `baseUrlEnvVar` opt-in path — identical
//                                 runtime semantics, zero double-
//                                 registration warnings. The same pass
//                                 also closed the `302ai` residue (see
//                                 below). Baseline drops by 4.
//
// The 22 cases remaining are:
//   - 13 first-party-native  (openai, anthropic, google, deepseek,
//                              mistral, xai, cohere, openrouter,
//                              vertex-ai, aws-bedrock, aws-sagemaker,
//                              jina, self-hosted)
//   - 4  specialty audio     (deepgram, cartesia, elevenlabs, palabraai)
//   - 5  self-hosted non-OAI (local-ocr, local-docling, local-nllb,
//                              local-cosyvoice, local-piper) — these
//                              are NOT OpenAI-compatible on their
//                              normalized surface (OCR, PDF→JSON,
//                              translation, TTS). The catalog's
//                              `integrationClass` enum does not cover
//                              these shapes today, so they remain a
//                              documented structural exception.
//
//   (`302ai` used to live here as a regex-excluded switch case. The
//   2026-04-22 residue-closure pass migrated it to the catalog under
//   canonical id `ai302` with `['302ai','302-ai','302']` as aliases.
//   The switch case has been removed; its regex-excluded state meant
//   removing it doesn't change this count either way.)
//
// To raise this baseline legitimately (e.g. new first-party native adapter),
// update the constant in the same commit that adds the case. PR reviewers
// should ask: "could this be a catalog entry instead?" If yes, reject.
const SWITCH_CASE_BASELINE = 22;

/**
 * Extract the lowercase-kebab provider ids that appear as `case 'x':`
 * statements inside `provider-registry.ts`. We count every case occurrence,
 * including the fall-through cases in the hub consolidation block — those
 * are the primary migration target for the catalog.
 */
function extractSwitchCaseProviderIds(source: string): string[] {
  // Matches `case 'xyz':` or `case 'xyz-123':` at the start of a line
  // (allowing leading whitespace). Captures the inner token.
  const regex = /^\s*case\s+'([a-z][a-z0-9-]*)'\s*:/gm;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

describe('anti-hardcode guard: provider-registry.ts switch cases', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf8');
  const caseIds = extractSwitchCaseProviderIds(source);

  it('count does not exceed the committed baseline', () => {
    // If this fails with count > baseline: DO NOT just bump the baseline.
    // Ask yourself: should the new provider be a catalog entry instead?
    //   - Speaks OpenAI /v1 chat surface → catalog (integrationClass: 'oai-compat-pure')
    //   - Has quirks (custom headers, citations, non-standard /models) → catalog 'oai-compat-quirks'
    //   - Fundamentally different API (Anthropic Messages, Bedrock Converse) → bump baseline + adapterClass
    //
    // If this fails with count < baseline: YOU CAN lower the baseline
    // (providers migrated out — desirable).
    expect(caseIds.length).toBeLessThanOrEqual(SWITCH_CASE_BASELINE);
  });

  it('reports when providers migrate out of the switch (count dropped)', () => {
    // Informational: this prints when the baseline becomes stale.
    if (caseIds.length < SWITCH_CASE_BASELINE) {
      // eslint-disable-next-line no-console
      console.warn(
        `anti-hardcode-guard: switch-case count is ${caseIds.length}, baseline is ${SWITCH_CASE_BASELINE}. ` +
          `Consider lowering SWITCH_CASE_BASELINE in this file to lock in the improvement.`,
      );
    }
    expect(caseIds.length).toBeGreaterThan(0); // sanity: file isn't empty
  });
});

describe('anti-hardcode guard: catalog/switch disjointness', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf8');
  const caseIds = new Set(extractSwitchCaseProviderIds(source));

  it('no OAI-compatible catalog entry is ALSO a switch case', () => {
    const duplicates: string[] = [];
    for (const entry of PROVIDER_CATALOG) {
      if (!isOpenAICompatibleEntry(entry)) continue;
      // Only runtime-active entries count — catalog-only / disabled / denied
      // entries don't reach the registry, so they can coexist with legacy
      // switch cases during migration.
      if (
        entry.integrationMode === 'catalog-only' ||
        entry.enabledByDefault === false ||
        entry.denyByDefault === true
      ) {
        continue;
      }
      if (caseIds.has(entry.providerId)) {
        duplicates.push(entry.providerId);
      }
      // Also check aliases — registry may match on alias.
      for (const alias of entry.aliases ?? []) {
        if (caseIds.has(alias)) {
          duplicates.push(`${entry.providerId} (via alias '${alias}')`);
        }
      }
    }

    if (duplicates.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `anti-hardcode-guard: the following catalog entries ALSO exist as switch cases — ` +
          `remove them from provider-registry.ts or mark them catalog-only during migration:\n  - ${duplicates.join('\n  - ')}`,
      );
    }
    expect(duplicates).toEqual([]);
  });

  it('extractSwitchCaseProviderIds returns a stable set (regex smoke test)', () => {
    // Sanity test for the extraction itself — if the regex gets broken by
    // a refactor, the other tests become useless.
    const mini = `
      switch (x) {
        case 'first':
          break;
        case 'second-name':
          break;
        case  'third':
          break;
      }
    `;
    const got = extractSwitchCaseProviderIds(mini);
    expect(got).toEqual(['first', 'second-name', 'third']);
  });
});
