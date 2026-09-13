// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for structural capability derivation rules (ADR-022, Sprint 3).
 *
 * No test file existed for this module before — it was only ever exercised
 * manually via `scripts/hcra-close-coverage.ts`. These pin the rule set
 * against a synthetic `CapabilityReadable` so a future edit to RULES gets a
 * real regression signal instead of silent drift, and specifically lock in
 * the `analysis` rule added to close the phantom-capability gap (SOTA audit,
 * 2026-09-07): a hard-required capability with zero real assignments that
 * permanently emptied the triage-model selection pool once the selector's
 * hard-capability filter started failing closed (2026-09-03).
 */
import { describe, it, expect } from 'vitest';
import { deriveStructuralSignals, structuralTargets } from '../structural-derivation';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

const uri = (slug: string): string => LEGACY_CAPABILITY_TO_URI[slug];

function readable(caps: Record<string, number>) {
  return {
    capabilityUris: Object.keys(caps).map(uri),
    capabilityConfidence: Object.fromEntries(Object.entries(caps).map(([k, v]) => [uri(k), v])),
  };
}

describe('deriveStructuralSignals — analysis (phantom-capability fix)', () => {
  it('derives `analysis` from a model that has `reasoning`', () => {
    const signals = deriveStructuralSignals(readable({ reasoning: 0.9 }));
    const analysis = signals.find((s) => s.capability === 'analysis');
    expect(analysis).toBeDefined();
    expect(analysis!.source).toBe('modality-derived');
    expect(analysis!.confidence).toBeGreaterThan(0);
  });

  it('derives `analysis` from `thinking_mode` alone (no `reasoning` required)', () => {
    const signals = deriveStructuralSignals(readable({ thinking_mode: 0.8 }));
    expect(signals.some((s) => s.capability === 'analysis')).toBe(true);
  });

  it('does NOT derive `analysis` for a plain chat model with neither base capability', () => {
    const signals = deriveStructuralSignals(readable({ chat: 0.9, text_generation: 0.9 }));
    expect(signals.some((s) => s.capability === 'analysis')).toBe(false);
  });

  it('damps the derived confidence when the base signal is weak (name-regex only)', () => {
    const strong = deriveStructuralSignals(readable({ reasoning: 0.9 })).find(
      (s) => s.capability === 'analysis'
    )!;
    const weak = deriveStructuralSignals(readable({ reasoning: 0.1 })).find(
      (s) => s.capability === 'analysis'
    )!;
    expect(weak.confidence).toBeLessThan(strong.confidence);
  });

  it('is listed in structuralTargets() so ops tooling can report on it', () => {
    expect(structuralTargets()).toContain('analysis');
  });
});

describe('deriveStructuralSignals — pre-existing rules (regression baseline)', () => {
  it('derives `visual_question_answering` from vision + chat', () => {
    const signals = deriveStructuralSignals(readable({ vision: 0.9, chat: 0.9 }));
    expect(signals.some((s) => s.capability === 'visual_question_answering')).toBe(true);
  });

  it('derives `qa` from chat + reasoning', () => {
    const signals = deriveStructuralSignals(readable({ chat: 0.9, reasoning: 0.9 }));
    expect(signals.some((s) => s.capability === 'qa')).toBe(true);
  });

  it('derives the `coding` umbrella from any single code-family capability', () => {
    const signals = deriveStructuralSignals(readable({ code_generation: 0.7 }));
    expect(signals.some((s) => s.capability === 'coding')).toBe(true);
  });

  it('produces no signals for a model with zero populated capabilities', () => {
    const signals = deriveStructuralSignals({ capabilityUris: [], capabilityConfidence: {} });
    expect(signals).toEqual([]);
  });
});

describe('deriveStructuralSignals — documentation/testing/refactoring (orphan-capability fix)', () => {
  it('derives `documentation` from text_generation + code_generation', () => {
    const signals = deriveStructuralSignals(
      readable({ text_generation: 0.9, code_generation: 0.9 })
    );
    expect(signals.some((s) => s.capability === 'documentation')).toBe(true);
  });

  it('does NOT derive `documentation` from text_generation alone', () => {
    const signals = deriveStructuralSignals(readable({ text_generation: 0.9 }));
    expect(signals.some((s) => s.capability === 'documentation')).toBe(false);
  });

  it('derives `testing` from code_generation + code_interpreter', () => {
    const signals = deriveStructuralSignals(
      readable({ code_generation: 0.9, code_interpreter: 0.9 })
    );
    expect(signals.some((s) => s.capability === 'testing')).toBe(true);
  });

  it('does NOT derive `testing` from code_generation alone (no execution evidence)', () => {
    const signals = deriveStructuralSignals(readable({ code_generation: 0.9 }));
    expect(signals.some((s) => s.capability === 'testing')).toBe(false);
  });

  it('derives `refactoring` from code_generation + reasoning', () => {
    const signals = deriveStructuralSignals(readable({ code_generation: 0.9, reasoning: 0.9 }));
    expect(signals.some((s) => s.capability === 'refactoring')).toBe(true);
  });

  it('does NOT derive `refactoring` from reasoning alone', () => {
    const signals = deriveStructuralSignals(readable({ reasoning: 0.9 }));
    // `reasoning` alone derives `analysis`, but not `refactoring` (needs code_generation too).
    expect(signals.some((s) => s.capability === 'refactoring')).toBe(false);
  });

  it('is listed in structuralTargets()', () => {
    const targets = structuralTargets();
    expect(targets).toContain('documentation');
    expect(targets).toContain('testing');
    expect(targets).toContain('refactoring');
  });
});

describe('deriveStructuralSignals — translation (live fail-closed gap fix)', () => {
  it('derives `translation` from chat + reasoning', () => {
    const signals = deriveStructuralSignals(readable({ chat: 0.9, reasoning: 0.9 }));
    expect(signals.some((s) => s.capability === 'translation')).toBe(true);
  });

  it('does NOT derive `translation` from plain chat alone (avoids inflating recall)', () => {
    const signals = deriveStructuralSignals(readable({ chat: 0.9, text_generation: 0.9 }));
    expect(signals.some((s) => s.capability === 'translation')).toBe(false);
  });

  it('is listed in structuralTargets()', () => {
    expect(structuralTargets()).toContain('translation');
  });
});
