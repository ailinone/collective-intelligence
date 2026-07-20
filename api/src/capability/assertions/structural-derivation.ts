// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Structural Capability Derivation (ADR-022, Sprint 3, Block 1)
 *
 * Emits `modality-derived` signals for capabilities that are *structurally*
 * implied by combinations of stronger base capabilities, rather than leaving
 * them to inherit at damped confidence from a single broader parent.
 *
 * Why this is distinct from hierarchy propagation (materialiser.ts):
 *   - Hierarchy propagation: `vision → image_captioning` at parent.conf × 0.5
 *     via a synthetic `hierarchy-inherited` marker. Always depth-1, always a
 *     single parent. No semantic content beyond "broader is strong".
 *   - Structural derivation (this module): `vision ∧ text_generation →
 *     image_captioning` at 0.85 as a `modality-derived` assertion. Represents
 *     a real claim backed by two supporting base capabilities. Persists to
 *     the assertion table so it fuses with future direct evidence.
 *
 * Why modality-derived (not provider-declared): we don't have the provider
 * telling us "this model does VQA". We INFER it from the fact that the model
 * has vision-input AND a text-output pathway — same epistemic category as
 * "the model has an `image_input` modality field, therefore vision". The
 * weight (0.75 in SOURCE_WEIGHT) matches that calibration.
 *
 * Rules are deliberately conservative:
 *   - Every rule requires ≥2 base capabilities.
 *   - Base capabilities must clear a minimum confidence (avoid building
 *     evidence on top of noise).
 *   - Each rule has a documented provider-reality justification.
 */

import type { CapabilityReadable } from '@/capability/reader';
import type { ModelCapability } from '@/types';
import type { CapabilitySignal } from '@/services/model-capability-merger';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

/**
 * Minimum fused confidence for a base capability to participate in a rule.
 * Set just above the noise floor (0.03): excludes caps that exist only as
 * a single name-regex assertion, but includes caps with any corroboration.
 */
export const BASE_CAP_MIN_CONFIDENCE = 0.05;

/**
 * Target confidence for derived assertions when bases are strong.
 * Matches `SOURCE_WEIGHT['modality-derived']` (0.75) inflated by the usual
 * 0.95 confidence literal fetchers emit — intentionally inside the band of
 * claims that a human reviewer would describe as "well-supported".
 */
const DERIVED_CONFIDENCE = 0.85;
const DERIVED_CONFIDENCE_CONSERVATIVE = 0.70;

/**
 * Damping factor for derived confidence when bases are weak.
 * `emitted = min(baseConfidences) × DERIVATION_FLOOR_DAMPING` when any base
 * is below 0.5, preventing a "vision@name-regex + text@name-regex → VQA@0.85"
 * inflation. Keeps the derived signal never stronger than its weakest input.
 */
const DERIVATION_FLOOR_DAMPING = 0.90;

interface StructuralRule {
  target: ModelCapability;
  /** All listed caps must be present and ≥ BASE_CAP_MIN_CONFIDENCE. */
  requiresAll?: ModelCapability[];
  /** At least one of these groups must be fully satisfied (OR of ANDs). */
  requiresAny?: ModelCapability[][];
  /** Per-rule confidence; defaults to DERIVED_CONFIDENCE. */
  confidence?: number;
  /** Human-readable justification — goes into source_detail for audit. */
  rationale: string;
}

/**
 * Provider-reality justifications for each rule (for audit trail).
 *
 * These are the rules. Order matters only for readability — all rules are
 * evaluated independently.
 */
const RULES: readonly StructuralRule[] = [
  // --- Vision compositions ---
  {
    target: 'image_captioning',
    requiresAll: ['vision', 'text_generation'],
    rationale: 'Vision input + text output is the canonical image-captioning pipeline. GPT-4o, Claude 3.x, Gemini 1.5+ all expose this as their default vision behavior.',
  },
  {
    target: 'visual_question_answering',
    requiresAll: ['vision', 'chat'],
    rationale: 'Vision + chat implies the model accepts an image alongside a question — the definitional VQA setup. Universally true for chat-capable multimodal models.',
  },
  {
    target: 'pdf_understanding',
    requiresAll: ['vision', 'multimodal'],
    rationale: 'Vision + multimodal models typically accept PDF as an image/document modality (Claude 3.5 Sonnet+, Gemini 1.5+). Weaker claim for "multimodal" alone, so require both.',
    confidence: DERIVED_CONFIDENCE_CONSERVATIVE,
  },

  // --- Coding umbrella (child → parent ANY-of) ---
  // `coding` is the ontology's umbrella for code-related tasks. If a model
  // has ANY code-specialised narrower capability, it has the umbrella.
  {
    target: 'coding',
    requiresAny: [
      ['code_generation'],
      ['code_completion'],
      ['code_review'],
      ['debugging'],
      ['refactoring'],
      ['code_interpreter'],
    ],
    rationale: 'Coding is the umbrella term for the code-narrower set. Possessing any specialised code capability implies the umbrella.',
    confidence: DERIVED_CONFIDENCE,
  },

  // --- Agentic composition ---
  {
    target: 'agents',
    requiresAll: ['tool_use', 'function_calling'],
    rationale: 'Tool-use + function-calling is the minimal substrate for agent behavior (loops, planning, sub-task dispatch). Models without tools cannot drive an agent.',
    confidence: DERIVED_CONFIDENCE_CONSERVATIVE,
  },

  // --- QA from chat + reasoning ---
  // chat alone would produce too much recall (every chat model supports QA in
  // principle). Requiring reasoning scopes the claim to models trained/tuned
  // for structured answering (o1/o3/Sonnet-thinking/Gemini-thinking).
  {
    target: 'qa',
    requiresAll: ['chat', 'reasoning'],
    rationale: 'Reasoning-capable chat models are the target for structured QA benchmarks (MMLU, ARC, MATH). Plain chat alone would inflate recall.',
    confidence: DERIVED_CONFIDENCE_CONSERVATIVE,
  },

  // --- TTS duplicate consolidation ---
  // The legacy enum has both `tts` and `text_to_speech`. They're the same
  // thing; the ontology seed should reconcile them, but in the interim we
  // treat text_to_speech as the source of truth and derive tts from it.
  {
    target: 'tts',
    requiresAll: ['text_to_speech'],
    rationale: 'Legacy alias — text_to_speech and tts denote the same capability. Consolidate in ontology later; derive here to close the coverage gap.',
    confidence: 0.90,
  },
];

/**
 * Apply structural derivation rules to a single model's already-materialised
 * capability projection. Returns signals that should be written via
 * writeAssertions() with origin='structural-derivation@v1'.
 *
 * Idempotent: if called twice for the same model with unchanged projection,
 * produces identical signals. The writer's supersede-by-origin keeps the
 * assertion table from growing.
 */
export function deriveStructuralSignals(model: CapabilityReadable): CapabilitySignal[] {
  const confidenceByUri = model.capabilityConfidence ?? {};
  const uriSet = new Set(model.capabilityUris ?? []);

  // Returns base confidence if cap present AND above the gate; 0 otherwise.
  const baseConf = (cap: ModelCapability): number => {
    const uri = LEGACY_CAPABILITY_TO_URI[cap];
    if (!uri || !uriSet.has(uri)) return 0;
    const conf = confidenceByUri[uri];
    if (typeof conf !== 'number') return 0.5;  // legacy rows without confidence map — treat as moderate
    return conf >= BASE_CAP_MIN_CONFIDENCE ? conf : 0;
  };

  const signals: CapabilitySignal[] = [];

  for (const rule of RULES) {
    // Skip if the target capability has no URI (ontology gap).
    if (!LEGACY_CAPABILITY_TO_URI[rule.target]) continue;

    // Determine matched base set and its minimum confidence.
    let matched = false;
    let matchedBases: ModelCapability[] = [];
    let minBaseConf = 1;

    if (rule.requiresAll) {
      const confs = rule.requiresAll.map((c) => baseConf(c));
      if (confs.every((c) => c > 0)) {
        matched = true;
        matchedBases = [...rule.requiresAll];
        minBaseConf = Math.min(...confs);
      }
    } else if (rule.requiresAny) {
      for (const group of rule.requiresAny) {
        const confs = group.map((c) => baseConf(c));
        if (confs.every((c) => c > 0)) {
          matched = true;
          matchedBases = [...group];
          minBaseConf = Math.min(...confs);
          break;
        }
      }
    }

    if (!matched) continue;

    // Calibrated emitted confidence: target if bases are strong, damped
    // by minBaseConf when weak. A rule's nominal `confidence` becomes a
    // ceiling rather than a fixed literal.
    const targetConf = rule.confidence ?? DERIVED_CONFIDENCE;
    const emitted =
      minBaseConf >= 0.5
        ? targetConf
        : Math.min(targetConf, minBaseConf * DERIVATION_FLOOR_DAMPING);

    // Skip if existing direct evidence already exceeds what we'd emit.
    const targetUri = LEGACY_CAPABILITY_TO_URI[rule.target]!;
    if (uriSet.has(targetUri)) {
      const existingConf = confidenceByUri[targetUri] ?? 0;
      if (existingConf >= emitted) continue;
    }

    signals.push({
      capability: rule.target,
      source: 'modality-derived',
      confidence: emitted,
      detail: {
        origin: 'structural-derivation@v1',
        rule: rule.target,
        bases: matchedBases,
        min_base_confidence: Number(minBaseConf.toFixed(4)),
        rationale: rule.rationale,
      },
    });
  }

  return signals;
}

/**
 * Exposed for ops/metrics: which target capabilities the rule set can emit.
 * Useful for dashboards ("how many caps has structural derivation populated
 * in this cycle?").
 */
export function structuralTargets(): ModelCapability[] {
  return [...new Set(RULES.map((r) => r.target))];
}
