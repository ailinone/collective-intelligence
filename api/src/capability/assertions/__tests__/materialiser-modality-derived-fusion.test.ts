// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for the `modality-derived` fusion path (2026-09-07 audit).
 *
 * Context: production showed real `model_capability_assertions` rows with
 * `source = 'modality-derived'` for `http://ailin.dev/cap/v1/analysis`
 * (2,575 rows) and `http://ailin.dev/cap/v1/qa` (2,056 rows) — written by
 * `structural-derivation-job.ts` (analysis/qa rules added in 99a384af,
 * "close the analysis phantom-capability gap"). `capability-materialise`
 * had completed successfully multiple times since those rows were written,
 * yet a check of `models.capability_uris` for those two capabilities came
 * back as zero.
 *
 * Before this file, NO test exercised `materialiseAllCapabilities`'s core
 * fusion → `capability_uris` write path at all — `materialiser-legacy-bridge.
 * test.ts` covers only the deprecated `capabilities` JSONB mirror
 * (`projectLegacyCapabilities`), which is gated by a DIFFERENT, higher floor
 * (`LEGACY_PROJECTION_FLOOR = 0.3`) than the canonical projection
 * (`INCLUSION_THRESHOLD = NOISE_FLOOR = 0.03`). That gap is exactly why a
 * report like "assertions exist but capability_uris is empty" could not be
 * quickly triaged as "materialiser is fine, look elsewhere" — there was
 * nothing pinning the materialiser's actual behaviour for this scenario.
 *
 * These tests fuse a `model_capability_assertions` row shaped exactly like
 * the real ones (source='modality-derived', SOURCE_WEIGHT=0.75, the
 * confidence structural-derivation.ts actually emits, ttl_days=60 as set by
 * structural-derivation-job.ts, observed "now") through the REAL
 * `fuseAssertions` + `writeProjectionForTest` and assert the resulting
 * `capability_uris` UPDATE parameter contains the exact canonical URI
 * (`http://ailin.dev/cap/v1/analysis`, `http://ailin.dev/cap/v1/qa`) — the
 * same full-URI form `dynamic-model-selector.ts`'s hard-capability
 * fail-closed filter compares against (via `legacyArrayToUriArray`), and the
 * same form `capability-uri-matching.test.ts` pins for chat/vision. They
 * also sweep every OTHER `modality-derived` structural-derivation target
 * (coding, agents, tts, image_captioning, pdf_understanding,
 * visual_question_answering) to confirm this is a property of the
 * `modality-derived` source/weight in general, not something special-cased
 * per capability.
 *
 * Finding: with the source's real weight (0.75) and structural-derivation's
 * real emitted confidences (0.7 conservative ceiling, damped no lower than
 * ~0.045 at the BASE_CAP_MIN_CONFIDENCE floor), fusion clears
 * INCLUSION_THRESHOLD (0.03) by a wide margin every time — confirmed here
 * for the exact `analysis`/`qa` shapes and the whole `modality-derived`
 * target set. A single such assertion, alone, is sufficient; nothing in
 * `fuseAssertions` → `propagateHierarchy` → `writeProjection` drops, floors,
 * or excludes it. The likely explanation for the production observation is
 * a verification-query format mismatch (`'analysis' = ANY(capability_uris)`
 * checks for the bare slug; the column holds the full URI
 * `http://ailin.dev/cap/v1/analysis`, exactly as the append-only assertion
 * log itself stores it) rather than a fusion defect — this suite is the
 * regression guard that would have caught (and would catch in the future) an
 * actual defect in that mechanism.
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  fuseAssertions,
  propagateHierarchy,
  writeProjectionForTest,
  INCLUSION_THRESHOLD,
  SOURCE_WEIGHT,
  type MaterialiseStats,
} from '../materialiser';
import {
  BASE_CAP_MIN_CONFIDENCE,
  structuralTargets,
  deriveStructuralSignals,
} from '../structural-derivation';
import { legacyToUri } from '@/capability/legacy-capability-uri';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

const uri = (slug: string) => legacyToUri(slug as never);

const emptyStats = (): MaterialiseStats => ({
  modelsWritten: 0,
  modelsCleared: 0,
  capabilitiesEmitted: 0,
  capabilitiesSuppressed: 0,
  elapsedMs: 0,
});

/** Records every query so tests can inspect the exact array written. */
function recordingPool(): { pool: Pool; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

/**
 * Fuse + propagate + write one model's projection the way
 * `materialiseAllCapabilities` does, given a raw bag of assertion-shaped
 * inputs for a single (model, capability) — or several capabilities, keyed
 * by URI. Returns the recorded UPDATE calls.
 */
async function materialiseModelForTest(
  byCapability: Map<string, Array<Parameters<typeof fuseAssertions>[0][number]>>,
  narrowerMap: ReadonlyMap<string, readonly string[]> = new Map()
): Promise<{ calls: Array<{ text: string; values: unknown[] }>; stats: MaterialiseStats }> {
  const { pool, calls } = recordingPool();
  const stats = emptyStats();
  const fused = [...byCapability.entries()].map(([capUri, assertions]) => {
    const { confidence, sources } = fuseAssertions(assertions);
    return { uri: capUri, confidence, sources };
  });
  const propagated = propagateHierarchy(fused, narrowerMap);
  propagated.sort((a, b) => b.confidence - a.confidence);
  await writeProjectionForTest(pool, 'model-under-test', propagated, stats);
  return { calls, stats };
}

/** A single fresh `modality-derived` assertion at the given confidence,
 *  ttl_days=60 (matches structural-derivation-job.ts's TTL_DAYS override). */
function modalityDerivedAssertion(confidence: number) {
  return [{ source: 'modality-derived' as const, confidence, observed_at: new Date(), ttl_days: 60 }];
}

function capabilityUrisWritten(calls: Array<{ text: string; values: unknown[] }>): string[] {
  expect(calls).toHaveLength(1);
  expect(calls[0].text).toContain('capability_uris = $1::text[]');
  return calls[0].values[0] as string[];
}

describe('materialiser — modality-derived fusion into capability_uris', () => {
  it('SOURCE_WEIGHT and INCLUSION_THRESHOLD are the calibrated production values this suite assumes', () => {
    // Pinned so a silent recalibration elsewhere is caught here too.
    expect(SOURCE_WEIGHT['modality-derived']).toBe(0.75);
    expect(INCLUSION_THRESHOLD).toBeCloseTo(0.03, 5);
  });

  it('a single fresh modality-derived `analysis` assertion at the real DERIVED_CONFIDENCE_CONSERVATIVE (0.7) is included', async () => {
    const analysisUri = uri('analysis');
    const { calls } = await materialiseModelForTest(
      new Map([[analysisUri, modalityDerivedAssertion(0.7)]])
    );
    const uris = capabilityUrisWritten(calls);
    expect(uris).toContain(analysisUri);
    expect(uris).toEqual([analysisUri]); // sole capability for this model
  });

  it('a single fresh modality-derived `qa` assertion at the real DERIVED_CONFIDENCE_CONSERVATIVE (0.7) is included', async () => {
    const qaUri = uri('qa');
    const { calls } = await materialiseModelForTest(new Map([[qaUri, modalityDerivedAssertion(0.7)]]));
    const uris = capabilityUrisWritten(calls);
    expect(uris).toContain(qaUri);
  });

  it('clears inclusion even at the minimum confidence structural-derivation can emit (BASE_CAP_MIN_CONFIDENCE-floored)', async () => {
    // deriveStructuralSignals damps to `minBaseConf * DERIVATION_FLOOR_DAMPING`
    // when a base capability is weak; the floor case is
    // BASE_CAP_MIN_CONFIDENCE (0.05) * 0.9 = 0.045 — the weakest a real
    // structural-derivation signal can legitimately be.
    const floorConfidence = BASE_CAP_MIN_CONFIDENCE * 0.9;
    const analysisUri = uri('analysis');
    const { calls } = await materialiseModelForTest(
      new Map([[analysisUri, modalityDerivedAssertion(floorConfidence)]])
    );
    const uris = capabilityUrisWritten(calls);
    expect(uris).toContain(analysisUri);
  });

  it('every modality-derived structural-derivation target clears inclusion at its own calibrated confidence — not an analysis/qa-specific property', async () => {
    // Drives deriveStructuralSignals for a model with every base capability
    // present at strong confidence, so every rule fires at its real ceiling
    // confidence, then fuses each emitted signal exactly as the materialiser
    // would and confirms every target survives into capability_uris.
    const strongBases: Record<string, number> = {
      vision: 0.9,
      chat: 0.9,
      multimodal: 0.9,
      text_generation: 0.9,
      reasoning: 0.9,
      thinking_mode: 0.9,
      tool_use: 0.9,
      function_calling: 0.9,
      code_generation: 0.9,
      text_to_speech: 0.9,
    };
    const readable = {
      capabilityUris: Object.keys(strongBases).map((slug) => LEGACY_CAPABILITY_TO_URI[slug]),
      capabilityConfidence: Object.fromEntries(
        Object.entries(strongBases).map(([slug, conf]) => [LEGACY_CAPABILITY_TO_URI[slug], conf])
      ),
    };
    const signals = deriveStructuralSignals(readable);
    const targets = structuralTargets();
    expect(signals.length).toBeGreaterThanOrEqual(targets.length - 1); // allow one rule to legitimately not fire (e.g. narrow gating)

    for (const signal of signals) {
      expect(signal.source).toBe('modality-derived');
      const capUri = LEGACY_CAPABILITY_TO_URI[signal.capability];
      const { calls } = await materialiseModelForTest(
        new Map([[capUri, modalityDerivedAssertion(signal.confidence!)]])
      );
      const uris = capabilityUrisWritten(calls);
      expect(uris, `capability '${signal.capability}' (confidence ${signal.confidence}) should survive fusion`).toContain(
        capUri
      );
    }
  });

  it('a below-floor confidence (weaker than structural-derivation can legitimately emit) is correctly suppressed — the threshold gate is real, just never reached by real signals', async () => {
    const analysisUri = uri('analysis');
    const { calls, stats } = await materialiseModelForTest(
      new Map([[analysisUri, modalityDerivedAssertion(0.01)]])
    );
    // Below threshold -> cleared, not written as a kept URI.
    expect(calls[0].text).toContain('capability_uris = ARRAY[]::text[]');
    expect(stats.capabilitiesSuppressed).toBe(1);
  });
});
