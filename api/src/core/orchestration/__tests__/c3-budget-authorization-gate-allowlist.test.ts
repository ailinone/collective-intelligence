// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Allowlist invariants.
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false, no billable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isC3PlaceholderForBudget, isC3HfWildcard,
  C3_ALLOWLIST_MIN_PROVIDERS, C3_ALLOWLIST_MAX_PROVIDERS, C3_ALLOWLIST_MIN_MODELS, C3_ALLOWLIST_MAX_MODELS,
} from '@/core/experiment/c3-budget-authorization-gate-contract';

const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-budget-authorization-gate-allowlist.json');
const allowlist = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;

describe('01C.1B-C3-BUDGET-AUTHORIZATION-GATE — allowlist', () => {
  it('placeholder + HF wildcard helpers behave correctly', () => {
    expect(isC3PlaceholderForBudget('__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_x__')).toBe(true);
    expect(isC3PlaceholderForBudget('Qwen/Qwen2.5-7B-Instruct')).toBe(false);
    expect(isC3HfWildcard('huggingface/*')).toBe(true);
    expect(isC3HfWildcard('huggingface')).toBe(true);
    expect(isC3HfWildcard('Qwen/Qwen2.5-7B-Instruct')).toBe(false);
  });
  it('allowlist bounds are 1..2 providers and 1..2 models', () => {
    expect(C3_ALLOWLIST_MIN_PROVIDERS).toBe(1);
    expect(C3_ALLOWLIST_MAX_PROVIDERS).toBe(2);
    expect(C3_ALLOWLIST_MIN_MODELS).toBe(1);
    expect(C3_ALLOWLIST_MAX_MODELS).toBe(2);
  });

  const maybe = allowlist ? describe : describe.skip;
  maybe('generated allowlist (local verification)', () => {
    it('case 8: only model_probe_validated entries', () => {
      expect(allowlist.onlyModelProbeValidated).toBe(true);
      expect(allowlist.entries.every((e: any) => e.candidateClass === 'model_probe_validated')).toBe(true);
    });
    it('case 9: excludes placeholders', () => {
      expect(allowlist.excludesPlaceholders).toBe(true);
      expect(allowlist.entries.every((e: any) => !isC3PlaceholderForBudget(e.modelId))).toBe(true);
    });
    it('case 10: excludes catalog candidates + HF wildcard + unknown status', () => {
      expect(allowlist.excludesCatalogCandidates).toBe(true);
      expect(allowlist.excludesHfWildcard).toBe(true);
      expect(allowlist.excludesUnknownProviderStatus).toBe(true);
      expect(allowlist.entries.every((e: any) => !isC3HfWildcard(e.modelId))).toBe(true);
    });
    it('1..2 providers and models, requiresModelProbe=false', () => {
      expect(allowlist.providers.length).toBeGreaterThanOrEqual(1);
      expect(allowlist.providers.length).toBeLessThanOrEqual(2);
      expect(allowlist.models.length).toBeGreaterThanOrEqual(1);
      expect(allowlist.models.length).toBeLessThanOrEqual(2);
      expect(allowlist.entries.every((e: any) => e.requiresModelProbeBeforeBillableExecution === false)).toBe(true);
    });
  });
});
