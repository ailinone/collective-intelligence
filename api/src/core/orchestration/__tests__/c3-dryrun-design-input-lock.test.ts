// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — Input lock invariants.
 *
 * Binds the dry-run design entry state to the locked R4 integrity outputs.
 * Contract constants are the CI-safe source of truth; the tmp artifact is verified
 * additionally when present (it is gitignored, so it may be absent in CI).
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_REGISTERED_PROVIDER_TOTAL,
  C3_CHAT_READY_PROVIDER_COUNT,
  C3_SOURCE_CANDIDATE_POOL_TOTAL,
  HF_ALL_MODELS_CALLABLE_ASSUMED,
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
  PROVIDER_PROBES_AUTHORIZED,
  MODEL_PROBES_AUTHORIZED,
  K_AUTHORIZED,
} from '@/core/experiment/c3-dryrun-experiment-design-contract';

const ARTIFACT_PATH = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-design-r4-integrity-input-lock.json');
const artifact = existsSync(ARTIFACT_PATH)
  ? JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'))
  : null;

describe('01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — input lock', () => {
  describe('locked R4 entry-state constants', () => {
    it('case 1: provider total is 82', () => {
      expect(C3_REGISTERED_PROVIDER_TOTAL).toBe(82);
    });

    it('case 2: chat-ready providers is 23', () => {
      expect(C3_CHAT_READY_PROVIDER_COUNT).toBe(23);
    });

    it('case 3: candidate pool total canonical is 13808', () => {
      expect(C3_SOURCE_CANDIDATE_POOL_TOTAL).toBe(13808);
    });

    it('case 4: HF all-models-callable is NOT assumed (false)', () => {
      expect(HF_ALL_MODELS_CALLABLE_ASSUMED).toBe(false);
    });
  });

  describe('execution locks are withheld (false as const)', () => {
    it('all six locks are false', () => {
      const locks: false[] = [
        C3_EXECUTION_AUTHORIZED,
        DRYRUN_FALSE_AUTHORIZED,
        BILLABLE_PROVIDER_CALLS_AUTHORIZED,
        PROVIDER_PROBES_AUTHORIZED,
        MODEL_PROBES_AUTHORIZED,
        K_AUTHORIZED,
      ];
      for (const lock of locks) expect(lock).toBe(false);
    });
  });

  const maybe = artifact ? describe : describe.skip;
  maybe('generated input-lock artifact (local verification)', () => {
    it('artifact pass is true', () => {
      expect(artifact.pass).toBe(true);
    });
    it('artifact agrees with contract on canonical counts', () => {
      expect(artifact.providerTotal).toBe(C3_REGISTERED_PROVIDER_TOTAL);
      expect(artifact.chatReadyProviders).toBe(C3_CHAT_READY_PROVIDER_COUNT);
      expect(artifact.candidatePoolTotalCanonical).toBe(C3_SOURCE_CANDIDATE_POOL_TOTAL);
    });
    it('artifact carries hf provider validation and no-callable assumption', () => {
      expect(artifact.hfProviderValidated).toBe(true);
      expect(artifact.hfAllModelsCallableAssumed).toBe(false);
    });
    it('artifact authorizes no execution', () => {
      expect(artifact.c3ExecutionAuthorized).toBe(false);
      expect(artifact.dryRunFalseAuthorized).toBe(false);
      expect(artifact.billableProviderCallsAuthorized).toBe(false);
    });
  });
});
