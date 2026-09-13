// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for GAP-AP-3.
 *
 * The NON_CHAT_CAPABILITIES exclusion sets in pool-builder.ts and
 * base-strategy.ts used the string 'image_upscaling' (with -ing), which is
 * NOT a member of the ModelCapability union in src/types/index.ts — the
 * real id is 'image_upscale' — and 'image_denoise' was absent from both
 * sets entirely. Because neither string matched a real capability, a model
 * tagged only with image_upscale/image_denoise (plus a — often mistagged,
 * see non-generative-filter.ts — 'chat'/'text_generation' baseline tag) was
 * never excluded from chat/collective candidate pools by these filters.
 *
 * Two things are pinned here, mirroring
 * triage-capabilities-no-phantom.test.ts's "guard against a capability
 * string silently matching nothing" pattern:
 *
 *  1. A static contract: every literal in BOTH NON_CHAT_CAPABILITIES set
 *     definitions is a real ModelCapability. A future typo (or a set member
 *     added before it exists in the ModelCapability union) fails this test
 *     instead of silently matching nothing.
 *  2. A functional regression: PoolBuilder.filterByModality('chat') now
 *     actually excludes a model whose only real skill is image_upscale /
 *     image_denoise, even when it carries a (mistagged) 'chat' or
 *     'text_generation' tag. This required BOTH the string fix and a
 *     companion fix to the "hasOnlyNonChat" check: that check ran
 *     caps.every() over the RAW capability array, including the gate tag
 *     ('chat'/'text_generation') itself — and neither of those two strings
 *     is ever a member of NON_CHAT_CAPABILITIES, so the check could never
 *     be true for any model that had already passed the preceding "has a
 *     chat capability" gate. That made the branch permanently unreachable
 *     regardless of what NON_CHAT_CAPABILITIES contained. Found while
 *     fixing this gap; fixed alongside it so the typo fix is actually
 *     observable instead of remaining silently inert.
 *
 * base-strategy.ts's `getEligibleModelsFallback` carries an identical
 * (deliberately duplicated, PoolBuilder-throws-defensive) copy of this
 * logic — it is covered by test 1 above (the static contract runs against
 * both files) but not re-proven functionally here, since it is a private
 * method only reachable when PoolBuilder itself throws.
 *
 * ─── Follow-up (2026-09-09): 'classification' phantom closed ─────────────
 * This test originally carried a `KNOWN_PRE_EXISTING_PHANTOM_MEMBERS`
 * exception for the literal 'classification', which the contract below
 * found in both sets but which GAP-AP-3 deliberately left unfixed pending
 * investigation into the original intent. That investigation found:
 *   - 'classification' is not a member of ModelCapability (types/index.ts).
 *   - It is not an id or alias in the unified capabilityOntology
 *     (capability-ontology.ts), which explicitly aliases
 *     'safety_classifier'/'safety-classifier' to 'moderation' — already a
 *     member of both NON_CHAT_CAPABILITIES sets.
 *   - No fetcher ever emits it as a capability tag: hf-hub-model-fetcher.ts
 *     maps HuggingFace's `text-classification`/`token-classification`/
 *     `zero-shot-classification` pipeline tags to 'analysis', never to
 *     'classification'.
 * It matched nothing, on any model, ever — dead weight, not a typo with a
 * recoverable intended target. Removed from both sets rather than renamed;
 * the exception set below is gone and the contract is now fully strict.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isModelCapability, type Model } from '@/types';
import { PoolBuilder } from '../pool-builder';

/**
 * Extracts the string literals inside `const <setName> = new Set([...])`
 * from a source file. Intentionally simple (no nested brackets expected in
 * these literal capability lists) — mirrors the pragmatic brace/regex
 * extraction approach in triage-capabilities-no-phantom.test.ts rather than
 * pulling in a full parser for a two-file guard test.
 */
function extractSetLiterals(filePath: string, setName: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const declPattern = new RegExp(`const ${setName}\\s*=\\s*new Set\\(\\[`);
  const declMatch = declPattern.exec(source);
  if (!declMatch) {
    throw new Error(`Could not find "const ${setName} = new Set([" in ${filePath}`);
  }
  const startIdx = declMatch.index + declMatch[0].length;
  const endIdx = source.indexOf(']', startIdx);
  if (endIdx === -1) {
    throw new Error(`Unterminated Set literal for ${setName} in ${filePath}`);
  }
  const body = source.slice(startIdx, endIdx);
  return Array.from(body.matchAll(/'([a-z_]+)'/g)).map((mm) => mm[1]);
}

const POOL_BUILDER_PATH = join(__dirname, '..', 'pool-builder.ts');
const BASE_STRATEGY_PATH = join(__dirname, '..', '..', 'orchestration', 'base-strategy.ts');

describe('NON_CHAT_CAPABILITIES sets — no phantom capability string', () => {
  it.each([
    ['pool-builder.ts', POOL_BUILDER_PATH],
    ['base-strategy.ts', BASE_STRATEGY_PATH],
  ])('%s: every NON_CHAT_CAPABILITIES member is a real ModelCapability', (_label, filePath) => {
    const members = extractSetLiterals(filePath, 'NON_CHAT_CAPABILITIES');
    // Sanity check on the extractor itself, same rationale as the phantom test.
    expect(members.length).toBeGreaterThan(0);
    // Strict: no exceptions. Both known phantom strings (the 'image_upscaling'
    // typo fixed by GAP-AP-3 and the dead 'classification' entry fixed
    // 2026-09-09) are gone from both sets — see the file-level doc comment.
    for (const member of members) {
      expect(
        isModelCapability(member),
        `"${member}" is not a real ModelCapability — a typo or a renamed/removed ` +
          'capability id in this set will silently exclude nothing.'
      ).toBe(true);
    }
  });

  it('both sets now contain image_upscale and image_denoise (not the old -ing typo)', () => {
    for (const filePath of [POOL_BUILDER_PATH, BASE_STRATEGY_PATH]) {
      const members = extractSetLiterals(filePath, 'NON_CHAT_CAPABILITIES');
      expect(members).toContain('image_upscale');
      expect(members).toContain('image_denoise');
      expect(members).not.toContain('image_upscaling');
    }
  });

  it('both sets no longer carry the dead "classification" phantom entry', () => {
    for (const filePath of [POOL_BUILDER_PATH, BASE_STRATEGY_PATH]) {
      const members = extractSetLiterals(filePath, 'NON_CHAT_CAPABILITIES');
      expect(members).not.toContain('classification');
    }
  });
});

const model = (capabilities: string[], id = 'test-model'): Model =>
  ({ id, capabilities } as unknown as Model);

describe('PoolBuilder.filterByModality — image_upscale/image_denoise-only models excluded from chat pool', () => {
  it('excludes a model mistagged chat whose only real skill is image_upscale', () => {
    const result = new PoolBuilder([model(['chat', 'image_upscale'])])
      .filterByModality('chat')
      .build();
    expect(result.poolSize).toBe(0);
    expect(result.stages[0]?.droppedReasons['only_non_chat_capabilities']).toBe(1);
  });

  it('excludes a model mistagged text_generation whose only real skill is image_denoise', () => {
    const result = new PoolBuilder([model(['text_generation', 'image_denoise'])])
      .filterByModality('chat')
      .build();
    expect(result.poolSize).toBe(0);
    expect(result.stages[0]?.droppedReasons['only_non_chat_capabilities']).toBe(1);
  });

  it('KEEPS a genuinely multi-skilled chat model that also declares image_upscale', () => {
    const result = new PoolBuilder([model(['chat', 'text_generation', 'vision', 'image_upscale'])])
      .filterByModality('chat')
      .build();
    expect(result.poolSize).toBe(1);
  });

  it('KEEPS an ordinary chat model untouched (no regression on the common case)', () => {
    const result = new PoolBuilder([model(['chat', 'text_generation', 'streaming'])])
      .filterByModality('chat')
      .build();
    expect(result.poolSize).toBe(1);
  });
});
