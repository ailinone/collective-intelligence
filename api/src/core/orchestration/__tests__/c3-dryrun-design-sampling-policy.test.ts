// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — Sampling policy invariants.
 *
 * The 13808-candidate universe must be contained into a small, diverse, guarded subset.
 * Catalog candidates must be flagged as requiring model probe before any billable call.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_SOURCE_CANDIDATE_POOL_TOTAL,
  C3_TARGET_SELECTED_MODELS,
  C3_MINIMUM_PROVIDERS,
  C3_MAX_MODELS_PER_PROVIDER,
  C3_MAX_HUGGINGFACE_MODELS,
  C3_MINIMUM_MODEL_PROBE_VALIDATED,
  C3_MINIMUM_CATALOG_GUARDED_CANDIDATES,
  C3_STRATIFICATION_KEYS,
  HF_ALL_MODELS_CALLABLE_ASSUMED,
} from '@/core/experiment/c3-dryrun-experiment-design-contract';

const MANIFEST_PATH = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-design-sampling-manifest.json');
const manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : null;

describe('01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — sampling policy', () => {
  describe('policy constants', () => {
    it('case 5: target selection never selects the whole pool', () => {
      expect(C3_TARGET_SELECTED_MODELS).toBeGreaterThan(0);
      expect(C3_TARGET_SELECTED_MODELS).toBeLessThan(C3_SOURCE_CANDIDATE_POOL_TOTAL);
    });

    it('case 6: minimum provider diversity is at least 8', () => {
      expect(C3_MINIMUM_PROVIDERS).toBeGreaterThanOrEqual(8);
    });

    it('case 7: max models per provider is bounded', () => {
      expect(C3_MAX_MODELS_PER_PROVIDER).toBeGreaterThan(0);
      expect(C3_MAX_MODELS_PER_PROVIDER).toBeLessThanOrEqual(4);
      expect(C3_MAX_HUGGINGFACE_MODELS).toBeLessThanOrEqual(4);
    });

    it('case 8+9: policy requires model-probe-validated and guarded catalog candidates', () => {
      expect(C3_MINIMUM_MODEL_PROBE_VALIDATED).toBeGreaterThanOrEqual(3);
      expect(C3_MINIMUM_CATALOG_GUARDED_CANDIDATES).toBeGreaterThanOrEqual(12);
    });

    it('stratification spans at least provider, class and tiers', () => {
      expect(C3_STRATIFICATION_KEYS).toContain('providerId');
      expect(C3_STRATIFICATION_KEYS).toContain('candidateClass');
      expect(C3_STRATIFICATION_KEYS).toContain('costTier');
      expect(C3_STRATIFICATION_KEYS).toContain('qualityPriorTier');
      expect(C3_STRATIFICATION_KEYS.length).toBeGreaterThanOrEqual(10);
    });

    it('HF all-models-callable is not assumed', () => {
      expect(HF_ALL_MODELS_CALLABLE_ASSUMED).toBe(false);
    });
  });

  const maybe = manifest ? describe : describe.skip;
  maybe('generated sampling manifest (local verification)', () => {
    it('case 5: selected count is positive and far below the source pool', () => {
      expect(manifest.selectedCandidateCount).toBeGreaterThan(0);
      expect(manifest.selectedCandidateCount).toBeLessThan(manifest.sourceCandidatePoolTotal);
    });

    it('case 6: provider diversity meets minimum', () => {
      expect(manifest.providerDiversity).toBeGreaterThanOrEqual(C3_MINIMUM_PROVIDERS);
    });

    it('case 7: max models per provider respected (incl. HuggingFace)', () => {
      for (const n of Object.values<number>(manifest.providerCounts)) {
        expect(n).toBeLessThanOrEqual(C3_MAX_MODELS_PER_PROVIDER);
      }
      expect(manifest.providerCounts.huggingface ?? 0).toBeLessThanOrEqual(C3_MAX_HUGGINGFACE_MODELS);
    });

    it('case 8: includes at least one model_probe_validated candidate', () => {
      expect(
        manifest.selectedCandidates.some((c: any) => c.candidateClass === 'model_probe_validated'),
      ).toBe(true);
    });

    it('case 9+10: catalog candidates are guarded (require model probe before billable execution)', () => {
      const catalog = manifest.selectedCandidates.filter(
        (c: any) => c.candidateClass === 'catalog_candidate',
      );
      expect(catalog.length).toBeGreaterThan(0);
      expect(
        catalog.every((c: any) => c.requiresModelProbeBeforeBillableExecution === true),
      ).toBe(true);
    });

    it('manifest authorizes no execution', () => {
      expect(manifest.c3ExecutionAuthorized).toBe(false);
      expect(manifest.validations.hfAllModelsCallableAssumed).toBe(false);
    });
  });
});
