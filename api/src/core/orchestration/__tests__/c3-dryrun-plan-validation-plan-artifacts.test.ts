// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PLAN-VALIDATION — Compiled plan artifact invariants.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_PLAN_ARTIFACT_COUNT,
  assertC3PlanExecutionLocks,
  isC3PlaceholderModel,
  isC3NonResolvableSentinel,
} from '@/core/experiment/c3-dryrun-plan-validation-contract';

const INDEX = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-plan-validation-plan-index.json');
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : null;
const plans: any[] = index
  ? index.plans
      .map((p: any) => resolve(process.cwd(), p.path))
      .filter((p: string) => existsSync(p))
      .map((p: string) => JSON.parse(readFileSync(p, 'utf8')))
  : [];

describe('01C.1B-C3-DRYRUN-PLAN-VALIDATION — plan artifacts', () => {
  describe('contract count', () => {
    it('case 6: expected plan artifact count is 49', () => {
      expect(C3_PLAN_ARTIFACT_COUNT).toBe(49);
    });
  });

  describe('placeholder guard (contract)', () => {
    it('identifies sentinel placeholder modelIds', () => {
      expect(isC3PlaceholderModel('__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_groq_1__')).toBe(true);
      expect(isC3PlaceholderModel('Qwen/Qwen2.5-7B-Instruct')).toBe(false);
    });

    it('isC3PlaceholderModel is precise (catalog placeholders only, not probe-validated sentinels)', () => {
      expect(isC3PlaceholderModel('__C3_DRYRUN_DESIGN_MODEL_PROBE_VALIDATED_inworld__')).toBe(false);
    });

    it('isC3NonResolvableSentinel covers BOTH sentinel forms (runtime-gate safety predicate)', () => {
      expect(isC3NonResolvableSentinel('__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_groq_1__')).toBe(true);
      expect(isC3NonResolvableSentinel('__C3_DRYRUN_DESIGN_MODEL_PROBE_VALIDATED_inworld__')).toBe(true);
      expect(isC3NonResolvableSentinel('__C3_DRYRUN_DESIGN_MODEL_PROBE_VALIDATED_infermatic__')).toBe(true);
      // The one genuinely resolvable model id must NOT be flagged
      expect(isC3NonResolvableSentinel('Qwen/Qwen2.5-7B-Instruct')).toBe(false);
    });
  });

  const maybe = index ? describe : describe.skip;
  maybe('generated plans (local verification)', () => {
    it('case 6: exactly 49 plan artifacts present', () => {
      expect(index.planArtifactCount).toBe(49);
      expect(plans.length).toBe(49);
    });

    it('cases 7-12: every plan is dry-run/plan-only, no execution, no cost', () => {
      for (const p of plans) {
        expect(assertC3PlanExecutionLocks(p)).toBe(true);
        expect(p.dryRun).toBe(true);
        expect(p.planOnly).toBe(true);
        expect(p.c3ExecutionAuthorized).toBe(false);
        expect(p.billableProviderCallsAuthorized).toBe(false);
        expect(p.providerCallExecuted).toBe(false);
        expect(p.cost_usd).toBe(0);
      }
    });

    it('cases 13-14: placeholders never become executable or routed', () => {
      for (const p of plans) {
        for (const c of p.selectedCandidates ?? []) {
          if (isC3PlaceholderModel(c.modelId)) {
            expect(c.selectedExecutableModel).toBe(false);
            expect(c.providerRouteCreated).toBe(false);
          }
        }
      }
    });

    it('case 15: catalog_candidate keeps requiresModelProbeBeforeBillableExecution=true', () => {
      for (const p of plans) {
        for (const c of p.selectedCandidates ?? []) {
          if (c.candidateClass === 'catalog_candidate') {
            expect(c.requiresModelProbeBeforeBillableExecution).toBe(true);
          }
        }
      }
    });
  });
});
