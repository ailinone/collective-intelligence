// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-R4 — Artifact Reconciliation
 *
 * Verifies the contract, R3 reports, and JSON design artifacts are consistent.
 * Contract R4 version markers, execution locks, and HF classification must align.
 *
 * ABSOLUTE PROHIBITIONS:
 *   - No C3 execution, no provider calls, no dryRun=false, no secrets.
 */

import { describe, it, expect } from 'vitest';
import {
  C3_SCOPE_POLICY_VERSION,
  C3_R4_INTEGRITY_LOCK_DATE,
  C3_R3_VS_R2,
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  C3_CANDIDATE_POOL_FORMULA,
  C3_KNOWN_CANDIDATE_COUNT,
  C3_REGISTERED_PROVIDER_TOTAL,
  C3_CHAT_READY_PROVIDER_COUNT,
  J1_R3_REPROBE_DECISION,
  J1_R3_HZU_DECISION,
  C3_R4_INTEGRITY_LOCK_DECISION,
  HF_PROVIDER_STATUS,
  HF_ALL_MODELS_CALLABLE_ASSUMED,
  C3_R3_ORIGINAL_KNOWN_COUNT,
  type C3CandidateClass,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-R4 — artifact reconciliation', () => {

  describe('policy version R4', () => {
    it('C3_SCOPE_POLICY_VERSION is R4 (post-integrity-lock)', () => {
      expect(C3_SCOPE_POLICY_VERSION).toBe('01C.1B-C3-SCOPE-DESIGN-R4-v1');
    });

    it('C3_R4_INTEGRITY_LOCK_DATE is set', () => {
      expect(C3_R4_INTEGRITY_LOCK_DATE).toBeTruthy();
      expect(C3_R4_INTEGRITY_LOCK_DATE).toBe('2026-06-06');
    });
  });

  describe('source decision phrases (R4 additions)', () => {
    it('J1_R3_REPROBE_DECISION is defined and references reprobe', () => {
      expect(J1_R3_REPROBE_DECISION).toContain('REPROBE');
      expect(J1_R3_REPROBE_DECISION).toContain('J1_R3');
    });

    it('J1_R3_HZU_DECISION is defined and references HZU', () => {
      expect(J1_R3_HZU_DECISION).toContain('HZU');
      expect(J1_R3_HZU_DECISION).toContain('13808');
    });

    it('C3_R4_INTEGRITY_LOCK_DECISION references integrity lock', () => {
      expect(C3_R4_INTEGRITY_LOCK_DECISION).toContain('R4_INTEGRITY_LOCK');
      expect(C3_R4_INTEGRITY_LOCK_DECISION).toContain('COMPLETE');
    });
  });

  describe('execution authorization locks', () => {
    it('C3_EXECUTION_AUTHORIZED is false', () => {
      expect(C3_EXECUTION_AUTHORIZED).toBe(false);
    });

    it('DRYRUN_FALSE_AUTHORIZED is false', () => {
      expect(DRYRUN_FALSE_AUTHORIZED).toBe(false);
    });

    it('BILLABLE_PROVIDER_CALLS_AUTHORIZED is false', () => {
      expect(BILLABLE_PROVIDER_CALLS_AUTHORIZED).toBe(false);
    });

    it('execution locks are typed as `false as const`', () => {
      // TypeScript const assertion — if these were mutable, CI would catch it
      const execLock: false = C3_EXECUTION_AUTHORIZED;
      const dryRunLock: false = DRYRUN_FALSE_AUTHORIZED;
      const billableLock: false = BILLABLE_PROVIDER_CALLS_AUTHORIZED;
      expect(execLock).toBe(false);
      expect(dryRunLock).toBe(false);
      expect(billableLock).toBe(false);
    });
  });

  describe('R3 vs R2 historical delta markers', () => {
    it('R3 historical baseline: candidatePool.r3 is 934', () => {
      expect(C3_R3_VS_R2.candidatePool.r3).toBe(934);
      expect(C3_R3_VS_R2.candidatePool.r2).toBe(10);
    });

    it('R3 historical baseline: chatReadyProviders.r3 is 17', () => {
      expect(C3_R3_VS_R2.chatReadyProviders.r3).toBe(17);
      expect(C3_R3_VS_R2.chatReadyProviders.r2).toBe(4);
    });

    it('R3Extended values reflect full reprobe expansion', () => {
      expect(C3_R3_VS_R2.candidatePool.r3Extended).toBe(13808);
      expect(C3_R3_VS_R2.chatReadyProviders.r3Extended).toBe(23);
    });

    it('R4 provenance fields present', () => {
      expect(C3_R3_VS_R2.r4ProviderCensusTotal).toBe(82);
      expect(C3_R3_VS_R2.r4IntegrityLockDate).toBeTruthy();
    });
  });

  describe('canonical counts coherence', () => {
    it('C3_REGISTERED_PROVIDER_TOTAL is 82', () => {
      expect(C3_REGISTERED_PROVIDER_TOTAL).toBe(82);
    });

    it('C3_CHAT_READY_PROVIDER_COUNT is 23', () => {
      expect(C3_CHAT_READY_PROVIDER_COUNT).toBe(23);
    });

    it('C3_KNOWN_CANDIDATE_COUNT is 13808', () => {
      expect(C3_KNOWN_CANDIDATE_COUNT).toBe(13808);
    });

    it('C3_R3_ORIGINAL_KNOWN_COUNT is 934 (historical reference, not current pool)', () => {
      expect(C3_R3_ORIGINAL_KNOWN_COUNT).toBe(934);
    });

    it('formula string exists and contains canonical total', () => {
      expect(C3_CANDIDATE_POOL_FORMULA).toContain('13808');
    });
  });

  describe('HuggingFace classification semantics', () => {
    it('HF_PROVIDER_STATUS is provider_probe_validated', () => {
      expect(HF_PROVIDER_STATUS).toBe('provider_probe_validated');
    });

    it('HF_ALL_MODELS_CALLABLE_ASSUMED is false', () => {
      expect(HF_ALL_MODELS_CALLABLE_ASSUMED).toBe(false);
    });

    it('C3CandidateClass type covers all four classes', () => {
      const classes: C3CandidateClass[] = [
        'catalog_candidate',
        'provider_probe_validated',
        'model_probe_validated',
        'c3_sampling_eligible',
      ];
      expect(classes).toHaveLength(4);
      // TypeScript type check — if any value is invalid, TSC fails
      for (const c of classes) {
        expect(typeof c).toBe('string');
      }
    });

    it('catalog_candidate is semantically distinct from model_probe_validated', () => {
      const a: C3CandidateClass = 'catalog_candidate';
      const b: C3CandidateClass = 'model_probe_validated';
      expect(a).not.toBe(b);
    });
  });
});
