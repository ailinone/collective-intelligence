// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * QA-001a: regenerate the golden strategy-descriptor corpus.
 *
 * Serializes N deterministic descriptors built by buildStrategyDescriptor from
 * FIXED OfferedCell fixtures (covering: best — streaming true; consensus —
 * streaming false; economy; plus the fail-closed cases war-room / bogus
 * family) into src/routes/models/__tests__/__golden__/strategy-descriptors.v1.json.
 * That committed file IS the cross-repo contract artifact: chat's BFF
 * validates its pydantic models against it, and
 * strategy-descriptors.golden.test.ts fails when a rebuild drifts from it.
 *
 * Run (from api/):
 *   npx tsx scripts/generate-strategy-descriptor-golden.ts
 *
 * Any diff it produces = a descriptor semantic change = a catalogVersion bump
 * + chat-side sync. Never hand-edit the JSON.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildStrategyDescriptor,
  STRATEGY_CATALOG_VERSION,
} from '../src/routes/models/strategy-descriptors';
import { TIERS, type OfferedCell } from '../src/services/pricing-tiers';

function cell(
  id: string,
  strategy: string,
  tier: OfferedCell['tier']
): OfferedCell {
  return {
    id,
    strategy,
    tier,
    qualityTarget: TIERS[tier].qualityTarget,
    inputPer1MUsd: TIERS[tier].inputPer1MUsd,
    outputPer1MUsd: TIERS[tier].outputPer1MUsd,
    inputCostPer1k: TIERS[tier].inputPer1MUsd / 1000,
    outputCostPer1k: TIERS[tier].inputPer1MUsd / 1000,
  };
}

/** Fixed fixtures — deliberately NOT listOfferedPricingCells() output, so the
 * corpus is stable even if the offered-cell enumeration changes shape. */
const POSITIVE_FIXTURES: OfferedCell[] = [
  cell('best:medium', 'best', 'medium'), // streaming: true
  cell('consensus:large', 'consensus', 'large'), // streaming: FALSE (per-target truth)
  cell('economy:base', 'economy', 'base'), // cost-cascade family
];

const FAIL_CLOSED_FIXTURES: Array<{ cell: OfferedCell; reason: string }> = [
  {
    cell: cell('war-room:large', 'war-room', 'large'),
    reason: "family 'war-room' is outside the canonical 8-family enum (shadow-wired) — must never leak",
  },
  {
    cell: cell('no_viable_strategy:base', 'no_viable_strategy', 'base'),
    reason: 'wholly bogus family string — buildStrategyDescriptor fails closed with null',
  },
];

const corpus = {
  comment:
    'Golden strategy-descriptor corpus v1 — the cross-repo contract artifact (ci → chat BFF). ' +
    'chat BFF validates its pydantic models against this corpus; ' +
    'strategy-descriptors.golden.test.ts asserts a rebuild matches byte-for-byte. ' +
    'Regenerate via: cd api && npx tsx scripts/generate-strategy-descriptor-golden.ts — never hand-edit.',
  catalogVersion: STRATEGY_CATALOG_VERSION,
  descriptors: POSITIVE_FIXTURES.map((given) => {
    const descriptor = buildStrategyDescriptor(given);
    if (!descriptor) throw new Error(`fixture '${given.id}' unexpectedly failed closed`);
    return { given, descriptor };
  }),
  failClosed: FAIL_CLOSED_FIXTURES.map(({ cell: given, reason }) => {
    const descriptor = buildStrategyDescriptor(given);
    if (descriptor !== null) {
      throw new Error(`fail-closed fixture '${given.id}' unexpectedly produced a descriptor`);
    }
    return { given, descriptor: null, reason };
  }),
};

const OUT = fileURLToPath(
  new URL('../src/routes/models/__tests__/__golden__/strategy-descriptors.v1.json', import.meta.url)
);
mkdirSync(new URL('../src/routes/models/__tests__/__golden__/', import.meta.url), {
  recursive: true,
});
writeFileSync(OUT, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
console.log(`golden corpus written: ${OUT}`);
