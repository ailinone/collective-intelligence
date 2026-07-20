// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Matrix promotion regression guard — 2026-04-23 SOTA audit.
 *
 * ## Why this test exists
 *
 * The 2026-04-23 SOTA audit moved three providers from non-functional buckets
 * to `live-validation` after discovering the prior verdicts were probe-target
 * bugs or incomplete credential fallback chains, not real integration failures:
 *
 *   (1) **moonshot** — `defunct-unreachable` → `live-validation`.
 *       Prior probes hit `api.moonshot.cn` (PRC endpoint), but the adapter
 *       targets `api.moonshot.ai` (international). Re-probe with the correct
 *       target returned HTTP 200 with 14 models.
 *
 *   (2) **aws-bedrock** — `credentials-missing` → `live-validation`.
 *       Discovered AWS added Bearer-token auth for Bedrock READ endpoints in
 *       2025 (in addition to the SigV4-for-invoke path). With both
 *       `aws-key-id`/`aws-secret` (SigV4) AND `aws-bearer-token` (read-only)
 *       present, `/foundation-models` returned HTTP 200, 163KB inventory.
 *
 *   (3) **gemini-openai** — unlocked from 401 by extending the
 *       `GEMINI_API_KEY` fallback chain to include `vertex-key`. Any GCP
 *       project-level API key works against `generativelanguage.googleapis.com`,
 *       so the dedicated gemini keys being absent/placeholder is no longer a
 *       blocker as long as a vertex-key exists.
 *
 * Each of these promotions depends on a specific invariant in source code.
 * If any of those invariants silently regress — e.g. someone reverts the
 * moonshot base URL to `.cn`, or drops `aws-bearer-token` from the secret
 * map, or truncates the gemini fallback chain — the matrix classification
 * becomes a lie. This file catches those regressions at CI time.
 *
 * ## What this test does NOT do
 *
 *   - It does NOT perform HTTP probes. Probes require network + credentials
 *     and live in `tmp-probes/` as operator-initiated tooling.
 *   - It does NOT pin the full SHAPE of `load-secrets-into-env.ts`. It only
 *     pins the specific entries that back the three promotions.
 *   - It does NOT duplicate the adapter-level tests in
 *     `aws-bedrock/__tests__/aws-bedrock-adapter.test.ts` — those mock the
 *     SDK and test request shaping. This file tests the *configuration*
 *     layer that feeds those adapters.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MoonshotAdapter } from '../../moonshot/moonshot-adapter';

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

// ──────────────────────────────────────────────────────────────────────────
// (1) Moonshot — defend the .ai base URL against .cn regression
// ──────────────────────────────────────────────────────────────────────────

describe('matrix promotion regression — moonshot (.ai target pin)', () => {
  it('MoonshotAdapter.DEFAULT_BASE_URL points to api.moonshot.ai', () => {
    // If this fails: someone reverted the adapter to target api.moonshot.cn
    // (the PRC endpoint). That silently invalidates the 2026-04-23 move
    // from defunct-unreachable → live-validation, because the .cn endpoint
    // rejects international traffic / returns 4xx. The two endpoints are
    // NOT interchangeable — they require different account provisioning.
    //
    // Resolution: revert the adapter change, OR if the intent is to split
    // the adapter into regional variants, update the consolidation matrix
    // to reflect two separate providerIds (moonshot-cn, moonshot-ai).
    expect(MoonshotAdapter.DEFAULT_BASE_URL).toBe('https://api.moonshot.ai/v1');
    expect(MoonshotAdapter.DEFAULT_BASE_URL).not.toContain('.cn');
  });

  it('MoonshotAdapter.PROVIDER_NAME stays canonical "moonshot"', () => {
    // The consolidation matrix lists `moonshot` as canonical. Any rename
    // here requires a coordinated catalog + matrix update.
    expect(MoonshotAdapter.PROVIDER_NAME).toBe('moonshot');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (2) AWS Bedrock — defend the dual-auth secret mapping
// ──────────────────────────────────────────────────────────────────────────

describe('matrix promotion regression — aws-bedrock dual-auth secrets', () => {
  const source = readFileSync(LOAD_SECRETS_PATH, 'utf8');

  it('maps AWS_ACCESS_KEY_ID to aws-key-id (SigV4 invoke path)', () => {
    // The @aws-sdk/client-bedrock-runtime SDK reads this env var for SigV4
    // signing of InvokeModel / Converse commands. Dropping the mapping
    // silently breaks invoke while `/foundation-models` would still work
    // via Bearer — the worst failure mode because it passes inventory
    // probes but fails at runtime.
    expect(source).toMatch(
      /envVar:\s*['"]AWS_ACCESS_KEY_ID['"][\s\S]*?secretKeys:\s*\[[^\]]*['"]aws-key-id['"]/,
    );
  });

  it('maps AWS_SECRET_ACCESS_KEY to aws-secret (SigV4 invoke path)', () => {
    expect(source).toMatch(
      /envVar:\s*['"]AWS_SECRET_ACCESS_KEY['"][\s\S]*?secretKeys:\s*\[[^\]]*['"]aws-secret['"]/,
    );
  });

  it('maps AWS_BEARER_TOKEN_BEDROCK to aws-bearer-token (read-only path)', () => {
    // New in 2025: Bedrock accepts Bearer-token auth on READ endpoints
    // (ListFoundationModels, GetFoundationModel). The probe in the
    // 2026-04-23 audit used this path — without it, the audit could not
    // have verified the 163KB inventory response that promoted aws-bedrock
    // to live-validation.
    expect(source).toMatch(
      /envVar:\s*['"]AWS_BEARER_TOKEN_BEDROCK['"][\s\S]*?secretKeys:\s*\[[^\]]*['"]aws-bearer-token['"]/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (3) Gemini fallback chain — defend the vertex-key last-resort entry
// ──────────────────────────────────────────────────────────────────────────

describe('matrix promotion regression — gemini-openai vertex-key fallback', () => {
  const source = readFileSync(LOAD_SECRETS_PATH, 'utf8');

  /**
   * Helper: extract the GEMINI_API_KEY entry's secretKeys array as a list
   * of string literals, in declaration order.
   *
   * Returns [] if the entry is missing or malformed — the test asserts
   * non-emptiness so a malformed entry fails loudly.
   */
  function extractGeminiSecretKeys(src: string): string[] {
    const match = src.match(
      /envVar:\s*['"]GEMINI_API_KEY['"][\s\S]*?secretKeys:\s*\[([^\]]*)\]/,
    );
    if (!match) return [];
    const inner = match[1];
    const keys: string[] = [];
    const keyRegex = /['"]([a-z0-9-]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = keyRegex.exec(inner)) !== null) {
      if (m[1]) keys.push(m[1]);
    }
    return keys;
  }

  it('GEMINI_API_KEY entry exists with a non-empty secretKeys array', () => {
    const keys = extractGeminiSecretKeys(source);
    // If this fails: the entire GEMINI_API_KEY entry was deleted or its
    // secretKeys array was emptied. Any Gemini integration (both native
    // `google` adapter and the `gemini-openai` compat surface) becomes
    // unreachable on container boot.
    expect(keys.length).toBeGreaterThan(0);
  });

  it('GEMINI_API_KEY fallback chain includes vertex-key', () => {
    const keys = extractGeminiSecretKeys(source);
    // If this fails: the vertex-key fallback was removed. This was the
    // 2026-04-23 fix that unlocked gemini-openai when the dedicated
    // gemini-key / google-ai-studio-key secrets are absent/placeholder.
    // Dropping it re-introduces the 401 that blocked gemini-openai
    // promotion for multiple sessions.
    expect(keys).toContain('vertex-key');
  });

  // TODO (user contribution) — write the ordering invariant for this chain.
  //
  // CONTEXT: The chain today is declared as:
  //
  //   ['gemini-key', 'google-ai-studio-key', 'google-key', 'vertex-key']
  //
  // The order matters because `loadSecret` resolves the first non-empty,
  // non-placeholder value. There are three plausible invariants to enforce,
  // each with different operational trade-offs:
  //
  //   (A) PIN EXACT ORDER:
  //       expect(keys).toEqual(['gemini-key', 'google-ai-studio-key', 'google-key', 'vertex-key']);
  //       → Strongest guarantee. Any reorder (even legitimate) breaks CI.
  //       → Cost: every future addition requires a test update.
  //
  //   (B) PIN RELATIVE ORDER (primary-before-fallback):
  //       const geminiIdx = keys.indexOf('gemini-key');
  //       const vertexIdx = keys.indexOf('vertex-key');
  //       expect(geminiIdx).toBeLessThan(vertexIdx);
  //       → Catches the specific regression where someone promotes
  //         vertex-key to primary (which would silently prefer a generic
  //         GCP key over a dedicated Gemini key even when both exist).
  //       → Cost: allows reordering of the two middle entries freely.
  //
  //   (C) PIN JUST THE LAST POSITION:
  //       expect(keys[keys.length - 1]).toBe('vertex-key');
  //       → Documents that vertex-key is the LAST-RESORT fallback, not a
  //         co-equal primary. Operationally matches intent.
  //       → Cost: blind to reordering among primary entries.
  //
  // QUESTION FOR THE IMPLEMENTER: which invariant reflects your actual
  // operational concern?
  //
  //   - If you rotate secrets frequently and add new ones often → (B).
  //   - If the chain is stable and you want maximum rigidity → (A).
  //   - If you care specifically about "vertex-key is a fallback, never
  //     a primary" → (C).
  //
  // Replace the `it.skip` below with your chosen invariant:
  it.skip('GEMINI_API_KEY fallback chain has correct ordering (TODO: implement)', () => {
    const keys = extractGeminiSecretKeys(source);
    // TODO: implement one of (A), (B), or (C) above.
    expect(keys).toBeTruthy();
  });
});
