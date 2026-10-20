// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-descriptors.test.ts — the CAT-001/A1 contract tests.
 *
 * The descriptor is the cross-repo deliverable chat's BFF + frontend consume
 * and fail closed on, so the assertions here are the PUBLISHED contract:
 *   - golden corpus: the EXACT descriptor shape for `best:medium` and
 *     `consensus:large` (asserted field-for-field — any semantic change is a
 *     catalogVersion bump, so the goldens must be updated deliberately);
 *   - outbound Zod validation: every descriptor in the catalog satisfies
 *     strategyTargetDescriptorSchema;
 *   - fail-closed: an unknown/unaligned family cannot leak into output;
 *   - derived selectable: executionReady && operability (never hand-set);
 *   - per-target streaming truth: consensus (whose execution blocks
 *     executeStream until evaluator parity — see STRATEGY_STREAMING_SUPPORT)
 *     never advertises "streaming"; the map itself is pinned against the
 *     strategy implementations' supportsStreaming() via source scan;
 *   - pricing allowlist: exactly {currency, inputPer1MUsd, outputPer1MUsd} —
 *     no provider-cost internals (marginTarget, cogs, paretoAnchor);
 *   - `controls` is absent (no declared source — CAT-001 v3 rule);
 *   - guardrail #2: shadow-wired families and planner-only kinds NEVER appear.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildStrategyCatalog,
  buildStrategyDescriptor,
  buildStrategyDescriptorById,
  strategyTargetDescriptorSchema,
  STRATEGY_CATALOG_VERSION,
  STRATEGY_STREAMING_SUPPORT,
} from '../strategy-descriptors';
import { listOfferedPricingCells, TIERS, TIER_ORDER, type OfferedCell } from '@/services/pricing-tiers';

function cellById(id: string): OfferedCell {
  const cell = listOfferedPricingCells().find((candidate) => candidate.id === id);
  if (!cell) throw new Error(`fixture missing: offered cell '${id}' does not exist`);
  return cell;
}

// ── Golden corpus ───────────────────────────────────────────────────────────
describe('golden corpus — exact descriptor shape (any change = catalogVersion bump)', () => {
  it('best:medium', () => {
    expect(buildStrategyDescriptor(cellById('best:medium'))).toEqual({
      catalogVersion: 'v1',
      id: 'best:medium',
      kind: 'collective_strategy',
      displayName: 'Best Strategy',
      description: expect.any(String),
      strategy: { family: 'best', tier: 'medium' },
      selectable: true,
      capabilities: ['chat', 'streaming', 'function_calling'],
      operability: 'operational',
      pricing: {
        currency: 'USD',
        inputPer1MUsd: TIERS.medium.inputPer1MUsd,
        outputPer1MUsd: TIERS.medium.outputPer1MUsd,
      },
      entitlement: { required: true },
    });
  });

  it('consensus:large — NO streaming capability (per-target truth)', () => {
    expect(buildStrategyDescriptor(cellById('consensus:large'))).toEqual({
      catalogVersion: 'v1',
      id: 'consensus:large',
      kind: 'collective_strategy',
      displayName: 'Consensus Strategy',
      description: expect.any(String),
      strategy: { family: 'consensus', tier: 'large' },
      selectable: true,
      // THE load-bearing difference: consensus's execution blocks streaming.
      capabilities: ['chat', 'function_calling'],
      operability: 'operational',
      pricing: {
        currency: 'USD',
        inputPer1MUsd: TIERS.large.inputPer1MUsd,
        outputPer1MUsd: TIERS.large.outputPer1MUsd,
      },
      entitlement: { required: true },
    });
  });
});

// ── Full catalog contract ───────────────────────────────────────────────────
describe('catalog contract', () => {
  const catalog = buildStrategyCatalog();

  it('carries catalogVersion v1 and validates EVERY descriptor against the published Zod schema', () => {
    expect(catalog.catalogVersion).toBe(STRATEGY_CATALOG_VERSION);
    expect(catalog.strategies.length).toBeGreaterThan(0);
    for (const descriptor of catalog.strategies) {
      const parsed = strategyTargetDescriptorSchema.safeParse(descriptor);
      expect(parsed.success, `${descriptor.id}: ${parsed.success ? '' : parsed.error?.message}`).toBe(
        true
      );
    }
  });

  it('covers ALL 9 executionReady families (CI returns truth; chat filters exposure)', () => {
    const families = new Set(catalog.strategies.map((descriptor) => descriptor.strategy.family));
    expect([...families].sort()).toEqual(
      [
        'auto',
        'best',
        'consensus',
        'economy',
        'expert-panel',
        'fast',
        'media-planner',
        'parallel',
        'single',
      ].sort()
    );
  });

  it('is exactly listOfferedPricingCells() ∩ executionReady (one descriptor per offered cell)', () => {
    expect(catalog.strategies.map((descriptor) => descriptor.id).sort()).toEqual(
      listOfferedPricingCells()
        .map((cell) => cell.id)
        .sort()
    );
  });

  it('tiers stay inside the canonical enum for every descriptor', () => {
    for (const descriptor of catalog.strategies) {
      expect(TIER_ORDER).toContain(descriptor.strategy.tier);
    }
  });

  it('pricing is the ALLOWLIST projection — exactly three declared fields, never provider internals', () => {
    for (const descriptor of catalog.strategies) {
      expect(Object.keys(descriptor.pricing).sort()).toEqual([
        'currency',
        'inputPer1MUsd',
        'outputPer1MUsd',
      ]);
      const serialized = JSON.stringify(descriptor);
      // Internals that exist on neighboring shapes must never leak.
      expect(serialized).not.toContain('marginTarget');
      expect(serialized).not.toContain('paretoAnchor');
      expect(serialized).not.toContain('cogs');
      expect(serialized).not.toContain('fanoutFactor');
      expect(serialized).not.toContain('b64');
    }
  });

  it('controls is ABSENT, not defaulted (no declared per-family source — CAT-001 v3)', () => {
    for (const descriptor of catalog.strategies) {
      expect('controls' in descriptor).toBe(false);
    }
  });

  it('selectable is DERIVED (executionReady && operability) — every offered cell here is selectable', () => {
    for (const descriptor of catalog.strategies) {
      expect(descriptor.selectable).toBe(true);
      expect(descriptor.operability).toBe('operational');
    }
  });

  it('consensus and media-planner cells never advertise streaming; every other family does', () => {
    const NO_STREAMING_FAMILIES = new Set(['consensus', 'media-planner']);
    for (const descriptor of catalog.strategies) {
      const advertisesStreaming = descriptor.capabilities.includes('streaming');
      if (NO_STREAMING_FAMILIES.has(descriptor.strategy.family)) {
        expect(advertisesStreaming, descriptor.id).toBe(false);
      } else {
        expect(advertisesStreaming, descriptor.id).toBe(true);
      }
    }
  });
});

// ── Fail-closed ─────────────────────────────────────────────────────────────
describe('fail-closed — unknown/unaligned families cannot leak into output', () => {
  it('drops a cell whose family is outside the canonical enum (and the catalog omits it)', () => {
    const forged: OfferedCell = {
      id: 'war-room:large',
      strategy: 'war-room',
      tier: 'large',
      qualityTarget: 0.9,
      inputPer1MUsd: 4,
      outputPer1MUsd: 20,
      inputCostPer1k: 0.004,
      outputCostPer1k: 0.02,
    };
    expect(buildStrategyDescriptor(forged)).toBeNull();
    const catalog = buildStrategyCatalog([forged]);
    expect(catalog.strategies).toEqual([]);
  });

  it('a wholly bogus family string is dropped too', () => {
    const forged: OfferedCell = {
      id: 'no_viable_strategy:base',
      strategy: 'no_viable_strategy',
      tier: 'base',
      qualityTarget: 0.7,
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.002,
    };
    expect(buildStrategyDescriptor(forged)).toBeNull();
  });

  it('guardrail #2 — shadow-wired families NEVER appear in catalog output', () => {
    const serialized = JSON.stringify(buildStrategyCatalog());
    for (const shadow of [
      'debate',
      'blind-debate',
      'devil-advocate-consensus',
      'safety-quorum',
      'war-room',
      'persona-exploration',
    ]) {
      expect(serialized).not.toContain(`"${shadow}"`);
      expect(serialized).not.toContain(`:${shadow}`);
    }
  });

  it('buildStrategyDescriptorById returns null for anything that is not an offered cell', () => {
    expect(buildStrategyDescriptorById('war-room:large')).toBeNull();
    expect(buildStrategyDescriptorById('gpt-4o-mini')).toBeNull();
    expect(buildStrategyDescriptorById('ailin-voice')).toBeNull();
    expect(buildStrategyDescriptorById('best:medium')).not.toBeNull();
  });
});

// ── Guardrail #1: the legacy ailin-* aliases still resolve exactly as before ─
describe('guardrail #1 — legacy ailin-* voice/stt/realtime aliases unaffected', () => {
  it('the three audio aliases still come from getAilinVirtualModelProfiles with their exact endpoints', async () => {
    const { getAilinVirtualModelProfiles } = await import('@/services/ailin-virtual-model-service');
    const profiles = getAilinVirtualModelProfiles().filter((profile) =>
      ['ailin-voice', 'ailin-stt', 'ailin-realtime'].includes(profile.id)
    );
    expect(profiles.map((profile) => profile.id).sort()).toEqual([
      'ailin-realtime',
      'ailin-stt',
      'ailin-voice',
    ]);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    expect(byId.get('ailin-voice')?.endpoints).toEqual([
      'audio_speech',
      'audio_transcriptions',
      'realtime',
    ]);
    expect(byId.get('ailin-stt')?.endpoints).toEqual(['audio_transcriptions']);
    expect(byId.get('ailin-realtime')?.endpoints).toEqual(['realtime']);
    // And none of them is a composite strategy target — the strategy catalog
    // never claims them.
    const strategyIds = new Set(buildStrategyCatalog().strategies.map((d) => d.id));
    for (const id of ['ailin-voice', 'ailin-stt', 'ailin-realtime']) {
      expect(strategyIds.has(id)).toBe(false);
    }
  });
});

// ── Streaming truth pinned against the strategy implementations themselves ──
describe('STRATEGY_STREAMING_SUPPORT is pinned to the real supportsStreaming() implementations', () => {
  const STRATEGY_DIR = fileURLToPath(new URL('../../../core/orchestration/strategies', import.meta.url));

  function sourceOf(file: string): string {
    return readFileSync(`${STRATEGY_DIR}/${file}`, 'utf8');
  }

  /** Execution class per family (ailin-virtual-model-service.ts PRESET map +
   * identity for mechanism names). */
  const FAMILY_TO_STRATEGY_FILE: Record<string, string | null> = {
    auto: null, // resolves through the engine's triage/bespoke chat path
    best: 'quality-multipass-strategy.ts',
    fast: 'single-model-strategy.ts',
    economy: 'cost-cascade-strategy.ts',
    single: 'single-model-strategy.ts',
    parallel: 'parallel-strategy.ts',
    consensus: 'consensus-strategy.ts',
    'expert-panel': 'expert-panel-strategy.ts',
    // media-planner is deliberately absent from this scan map: it declares NO
    // supportsStreaming() override, so it inherits BaseStrategy's literal
    // `return false` default (base-strategy.ts) — pinned explicitly below.
  };

  it.each(Object.entries(FAMILY_TO_STRATEGY_FILE))(
    'family %s agrees with its execution supportsStreaming()',
    (family, file) => {
      if (file === null) {
        // auto has no dedicated strategy file to scan; its streaming support
        // rides the engine's own chat streaming path. Pinned true in the map.
        expect(STRATEGY_STREAMING_SUPPORT[family as keyof typeof STRATEGY_STREAMING_SUPPORT]).toBe(
          true
        );
        return;
      }
      const code = sourceOf(file);
      // Tolerant of comments inside the body (consensus documents its block
      // inline before `return false`).
      const match = code.match(/supportsStreaming\(\)[^{]*\{[^}]*?return\s+(true|false)/);
      expect(match, `${file} must declare a literal supportsStreaming() return`).not.toBeNull();
      const implSupports = match?.[1] === 'true';
      expect(STRATEGY_STREAMING_SUPPORT[family as keyof typeof STRATEGY_STREAMING_SUPPORT]).toBe(
        implSupports
      );
    }
  );

  it('consensus really blocks streaming today (the premise of the whole rule)', () => {
    const code = sourceOf('consensus-strategy.ts');
    expect(code).toMatch(/supportsStreaming\(\)[^{]*\{\s*[^}]*return\s+false/);
  });

  it('media-planner declares no streaming support (no override → BaseStrategy default false)', () => {
    const plannerCode = sourceOf('media-planner-strategy.ts');
    expect(plannerCode).not.toMatch(/supportsStreaming\(\)/);
    const baseCode = readFileSync(
      fileURLToPath(new URL('../../../core/orchestration/base-strategy.ts', import.meta.url)),
      'utf8'
    );
    expect(baseCode).toMatch(/supportsStreaming\(\)[^{]*\{\s*return\s+false/);
    expect(
      STRATEGY_STREAMING_SUPPORT['media-planner' as keyof typeof STRATEGY_STREAMING_SUPPORT]
    ).toBe(false);
  });
});

// ── Route registration (source-level, house pattern) ────────────────────────
describe('A1 route + A4 resolve wiring', () => {
  it('GET /v1/models/strategies is registered in index.ts', async () => {
    const code = readFileSync(
      fileURLToPath(new URL('../../../index.ts', import.meta.url)),
      'utf8'
    );
    expect(code).toContain('registerStrategyCatalogRoutes');
  });

  it('the strategies route file registers exactly the /v1/models/strategies path', () => {
    const code = readFileSync(
      fileURLToPath(new URL('../models-strategies-routes.ts', import.meta.url)),
      'utf8'
    );
    expect(code).toContain("'/v1/models/strategies'");
    expect(code).toContain('buildStrategyCatalog()');
  });

  it('GET /v1/models/:id merges the descriptor additively (A4)', () => {
    const code = readFileSync(
      fileURLToPath(new URL('../models-routes.ts', import.meta.url)),
      'utf8'
    );
    expect(code).toContain('buildStrategyDescriptorById');
    expect(code).toContain('...(descriptor ?? {})');
  });
});
