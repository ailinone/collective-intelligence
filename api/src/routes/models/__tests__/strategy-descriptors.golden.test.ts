// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * QA-001a + QA-001b — the golden descriptor corpus tests (ci side of the
 * ci↔chat handshake).
 *
 * The corpus file
 * (`__golden__/strategy-descriptors.v1.json`, committed) is the cross-repo
 * contract artifact chat's BFF validates its pydantic models against. It is
 * produced by `scripts/generate-strategy-descriptor-golden.ts` from FIXED
 * OfferedCell fixtures — never hand-edited. Any diff here is a descriptor
 * semantic change = a catalogVersion bump + chat-side sync.
 *
 *   - QA-001a: a fresh rebuild of the corpus from the same fixtures matches
 *     the committed file exactly (JSON.stringify equality — byte-for-byte
 *     after formatting).
 *   - QA-001b (contract consumption): every golden descriptor (a) validates
 *     against strategyTargetDescriptorSchema and (b) round-trips through
 *     JSON.parse — the shape chat consumes over HTTP — with NO field drift:
 *     the serialized key sets (top level and nested) exactly equal the schema
 *     key sets, so an accidental field addition/removal that would break the
 *     BFF's fail-closed parsing fails here, on the ci side, before it ships.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildStrategyCatalog,
  buildStrategyDescriptor,
  strategyTargetDescriptorSchema,
  STRATEGY_CATALOG_VERSION,
} from '../strategy-descriptors';
import { TIERS, type OfferedCell } from '@/services/pricing-tiers';

const GOLDEN_PATH = fileURLToPath(
  new URL('./__golden__/strategy-descriptors.v1.json', import.meta.url)
);
const GOLDEN_TEXT = readFileSync(GOLDEN_PATH, 'utf8');
const GOLDEN = JSON.parse(GOLDEN_TEXT) as {
  comment: string;
  catalogVersion: string;
  descriptors: Array<{ given: OfferedCell; descriptor: Record<string, unknown> }>;
  failClosed: Array<{ given: OfferedCell; descriptor: null; reason: string }>;
};

// The SAME fixed fixtures the generator uses (kept in deliberate duplication:
// the test must not depend on the generator script being runnable).
function cell(id: string, strategy: string, tier: OfferedCell['tier']): OfferedCell {
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

const POSITIVE_FIXTURES: OfferedCell[] = [
  cell('best:medium', 'best', 'medium'), // streaming: true
  cell('consensus:large', 'consensus', 'large'), // streaming: FALSE
  cell('economy:base', 'economy', 'base'),
];

const FAIL_CLOSED_FIXTURES: OfferedCell[] = [
  cell('war-room:large', 'war-room', 'large'),
  cell('no_viable_strategy:base', 'no_viable_strategy', 'base'),
];

function rebuildCorpus(): string {
  const corpus = {
    comment: GOLDEN.comment, // carried through — not itself under contract
    catalogVersion: STRATEGY_CATALOG_VERSION,
    descriptors: POSITIVE_FIXTURES.map((given) => {
      const descriptor = buildStrategyDescriptor(given);
      if (!descriptor) throw new Error(`fixture '${given.id}' unexpectedly failed closed`);
      return { given, descriptor };
    }),
    failClosed: FAIL_CLOSED_FIXTURES.map((given) => {
      const descriptor = buildStrategyDescriptor(given);
      if (descriptor !== null) {
        throw new Error(`fail-closed fixture '${given.id}' unexpectedly produced a descriptor`);
      }
      return { given, descriptor: null, reason: '' }; // reason is generator prose
    }),
  };
  return JSON.stringify(corpus, null, 2) + '\n';
}

// ── QA-001a: rebuild matches the committed corpus ───────────────────────────
describe('QA-001a — golden corpus matches a fresh rebuild (byte-for-byte)', () => {
  it('the committed file is current', () => {
    const rebuilt = rebuildCorpus();
    const committed = JSON.stringify(
      { ...GOLDEN, failClosed: GOLDEN.failClosed.map(({ given, descriptor }) => ({ given, descriptor, reason: '' })) },
      null,
      2
    ) + '\n';
    expect(rebuilt).toBe(committed);
  });

  it('covers the required fixture matrix (best/consensus/economy + fail-closed cases)', () => {
    expect(GOLDEN.descriptors.map((entry) => entry.given.id).sort()).toEqual(
      ['best:medium', 'consensus:large', 'economy:base'].sort()
    );
    expect(GOLDEN.failClosed.map((entry) => entry.given.id).sort()).toEqual(
      ['no_viable_strategy:base', 'war-room:large'].sort()
    );
    // The load-bearing capability difference is IN the corpus:
    const byId = new Map(GOLDEN.descriptors.map((e) => [e.given.id, e.descriptor]));
    expect(byId.get('best:medium')?.capabilities).toContain('streaming');
    expect(byId.get('consensus:large')?.capabilities).not.toContain('streaming');
    expect(byId.get('consensus:large')?.capabilities).toContain('chat');
  });

  it('documents its own regeneration procedure', () => {
    expect(GOLDEN.comment).toContain('generate-strategy-descriptor-golden.ts');
    expect(GOLDEN.comment).toContain('chat BFF validates its pydantic models against this corpus');
  });
});

// ── QA-001b: the contract chat consumes (schema-valid, no field drift) ──────
describe('QA-001b — golden corpus validates against the schema and JSON round-trips without field drift', () => {
  // The serialized keys must EXACTLY equal the schema keys: chat's BFF parses
  // fail-closed against this contract, so an added field is as breaking as a
  // removed one.
  const schemaShape = strategyTargetDescriptorSchema.shape;
  const EXPECTED_TOP_KEYS = Object.keys(schemaShape).sort();
  const EXPECTED_NESTED_KEYS: Record<string, string[]> = {
    strategy: Object.keys(schemaShape.strategy.shape).sort(),
    pricing: Object.keys(schemaShape.pricing.shape).sort(),
    entitlement: Object.keys(schemaShape.entitlement.shape).sort(),
  };

  function assertNoDrift(descriptor: Record<string, unknown>, label: string): void {
    // (b) round-trip: exactly what the BFF receives over HTTP
    const roundTripped = JSON.parse(JSON.stringify(descriptor)) as Record<string, unknown>;
    expect(Object.keys(roundTripped).sort(), `${label}: top-level keys`).toEqual(EXPECTED_TOP_KEYS);
    for (const [parent, expected] of Object.entries(EXPECTED_NESTED_KEYS)) {
      const nested = roundTripped[parent];
      expect(nested, `${label}: '${parent}' present`).toBeTypeOf('object');
      expect(Object.keys(nested as object).sort(), `${label}: ${parent} keys`).toEqual(expected);
    }
    // (a) the round-tripped value still satisfies the published schema
    const parsed = strategyTargetDescriptorSchema.safeParse(roundTripped);
    expect(parsed.success, `${label}: ${parsed.success ? '' : parsed.error?.message}`).toBe(true);
  }

  it('every golden descriptor is schema-valid and drift-free after a JSON round-trip', () => {
    expect(GOLDEN.descriptors.length).toBeGreaterThan(0);
    for (const { given, descriptor } of GOLDEN.descriptors) {
      assertNoDrift(descriptor, given.id);
    }
  });

  it('the full catalog output is drift-free too (no descriptor ships a field the schema lacks)', () => {
    // Covers the ~27 offered cells, not just the 3 corpus fixtures.
    for (const descriptor of buildStrategyCatalog().strategies) {
      assertNoDrift(descriptor, String(descriptor.id));
    }
  });
});
