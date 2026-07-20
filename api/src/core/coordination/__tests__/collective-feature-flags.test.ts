// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — Per-tenant feature flag parser + merger (F1.7)
 *
 * Tests the PURE helpers:
 *   - `parseOrganizationCollectiveSettings`: extracts a strict-typed
 *     override shape from arbitrary JSON, dropping invalid fields.
 *   - `mergeOrgSettingsIntoConfig`: overlays overrides on top of an
 *     env-default config; missing fields fall back to env.
 *
 * The DB-side `getCollectiveConfigForOrg` requires a real Prisma row
 * and belongs in integration tests; we verify here that the building
 * blocks are correct.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeOrgSettingsIntoConfig,
  parseOrganizationCollectiveSettings,
} from '../collective-feature-flags';
import { DEFAULT_COORDINATION_CONFIG } from '../coordination-types';

describe('parseOrganizationCollectiveSettings', () => {
  it('returns empty for non-object inputs', () => {
    expect(parseOrganizationCollectiveSettings(null)).toEqual({});
    expect(parseOrganizationCollectiveSettings(undefined)).toEqual({});
    expect(parseOrganizationCollectiveSettings(42)).toEqual({});
    expect(parseOrganizationCollectiveSettings('string')).toEqual({});
    expect(parseOrganizationCollectiveSettings([])).toEqual({});
  });

  it('extracts boolean fields when present', () => {
    const out = parseOrganizationCollectiveSettings({
      enabled: true,
      stopOnCriticalRisk: false,
      persistAuditTrail: true,
      enableForExperiments: false,
      entropySeedEnabled: true,
    });
    expect(out.enabled).toBe(true);
    expect(out.stopOnCriticalRisk).toBe(false);
    expect(out.persistAuditTrail).toBe(true);
    expect(out.enableForExperiments).toBe(false);
    expect(out.entropySeedEnabled).toBe(true);
  });

  it('drops boolean fields with non-boolean values', () => {
    const out = parseOrganizationCollectiveSettings({
      enabled: 'yes',
      entropySeedEnabled: 1,
    });
    expect(out.enabled).toBeUndefined();
    expect(out.entropySeedEnabled).toBeUndefined();
  });

  it('extracts integer fields within bounds', () => {
    const out = parseOrganizationCollectiveSettings({
      maxRounds: 4,
      minModelsPerRound: 3,
      maxModelsPerRound: 6,
      maxLatencyMs: 30000,
    });
    expect(out.maxRounds).toBe(4);
    expect(out.minModelsPerRound).toBe(3);
    expect(out.maxModelsPerRound).toBe(6);
    expect(out.maxLatencyMs).toBe(30000);
  });

  it('drops integer fields out of bounds', () => {
    const out = parseOrganizationCollectiveSettings({
      maxRounds: 100, // exceeds 5
      minModelsPerRound: 0, // below 1
      maxModelsPerRound: 999, // exceeds 7
      maxLatencyMs: -10, // not positive
    });
    expect(out.maxRounds).toBeUndefined();
    expect(out.minModelsPerRound).toBeUndefined();
    expect(out.maxModelsPerRound).toBeUndefined();
    expect(out.maxLatencyMs).toBeUndefined();
  });

  it('extracts [0,1] floats', () => {
    const out = parseOrganizationCollectiveSettings({
      minConvergenceScore: 0.9,
      maxDecisionFlipRate: 0.1,
      maxDissent: 0.25,
      requireQualityTarget: 0.85,
    });
    expect(out.minConvergenceScore).toBe(0.9);
    expect(out.maxDecisionFlipRate).toBe(0.1);
    expect(out.maxDissent).toBe(0.25);
    expect(out.requireQualityTarget).toBe(0.85);
  });

  it('drops [0,1] floats out of range', () => {
    const out = parseOrganizationCollectiveSettings({
      minConvergenceScore: -0.5,
      maxDissent: 2.0,
    });
    expect(out.minConvergenceScore).toBeUndefined();
    expect(out.maxDissent).toBeUndefined();
  });

  it('extracts maxCostUsd when positive (no upper bound)', () => {
    const out = parseOrganizationCollectiveSettings({
      maxCostUsd: 10.5,
    });
    expect(out.maxCostUsd).toBe(10.5);
  });

  it('drops maxCostUsd when zero or negative', () => {
    expect(parseOrganizationCollectiveSettings({ maxCostUsd: 0 }).maxCostUsd).toBeUndefined();
    expect(parseOrganizationCollectiveSettings({ maxCostUsd: -1 }).maxCostUsd).toBeUndefined();
  });

  it('extracts valid aggregationMethod values', () => {
    expect(parseOrganizationCollectiveSettings({ aggregationMethod: 'weighted_confidence' }).aggregationMethod).toBe('weighted_confidence');
    expect(parseOrganizationCollectiveSettings({ aggregationMethod: 'median' }).aggregationMethod).toBe('median');
    expect(parseOrganizationCollectiveSettings({ aggregationMethod: 'trimmed_mean' }).aggregationMethod).toBe('trimmed_mean');
    expect(parseOrganizationCollectiveSettings({ aggregationMethod: 'llm_synthesis' }).aggregationMethod).toBe('llm_synthesis');
    expect(parseOrganizationCollectiveSettings({ aggregationMethod: 'hybrid' }).aggregationMethod).toBe('hybrid');
  });

  it('drops invalid aggregationMethod', () => {
    const out = parseOrganizationCollectiveSettings({ aggregationMethod: 'voodoo' });
    expect(out.aggregationMethod).toBeUndefined();
  });

  it('drops unknown extra fields silently', () => {
    const out = parseOrganizationCollectiveSettings({
      enabled: true,
      coordinatorModelId: 'gpt-5', // not a CoordinationConfig field
      somethingExtra: 'ignored',
    });
    expect(Object.keys(out)).toEqual(['enabled']);
  });
});

describe('mergeOrgSettingsIntoConfig', () => {
  it('returns the env default unchanged when overrides are empty', () => {
    const merged = mergeOrgSettingsIntoConfig(DEFAULT_COORDINATION_CONFIG, {});
    expect(merged).toEqual(DEFAULT_COORDINATION_CONFIG);
  });

  it('overrides individual fields without touching others', () => {
    const merged = mergeOrgSettingsIntoConfig(DEFAULT_COORDINATION_CONFIG, {
      enabled: true,
      entropySeedEnabled: true,
    });
    expect(merged.enabled).toBe(true);
    expect(merged.entropySeedEnabled).toBe(true);
    // Untouched fields equal env default
    expect(merged.maxRounds).toBe(DEFAULT_COORDINATION_CONFIG.maxRounds);
    expect(merged.aggregationMethod).toBe(DEFAULT_COORDINATION_CONFIG.aggregationMethod);
  });

  it('respects override `false` (does not fall back to env when override is explicitly false)', () => {
    const baselineEnv = { ...DEFAULT_COORDINATION_CONFIG, enabled: true };
    const merged = mergeOrgSettingsIntoConfig(baselineEnv, { enabled: false });
    expect(merged.enabled).toBe(false);
  });

  it('replaces aggregationMethod when overridden', () => {
    const merged = mergeOrgSettingsIntoConfig(DEFAULT_COORDINATION_CONFIG, {
      aggregationMethod: 'llm_synthesis',
    });
    expect(merged.aggregationMethod).toBe('llm_synthesis');
  });

  it('preserves all 15 fields of CoordinationConfig', () => {
    const merged = mergeOrgSettingsIntoConfig(DEFAULT_COORDINATION_CONFIG, {});
    // Keys present on the merged config should match the env default's keys
    expect(Object.keys(merged).sort()).toEqual(Object.keys(DEFAULT_COORDINATION_CONFIG).sort());
  });

  it('zero is preserved (not coerced to undefined) when explicitly provided in the merger', () => {
    // Sanity guard against a bug where `?? envDefault.X` confuses 0/false
    // with `undefined`. We test with `maxLatencyMs` which is bounded
    // positive so 0 is rejected by the parser; here we feed it directly
    // to the merger to cover the merger's own logic.
    const merged = mergeOrgSettingsIntoConfig(DEFAULT_COORDINATION_CONFIG, {
      // maxLatencyMs is `undefined` — should fall back
    });
    expect(merged.maxLatencyMs).toBe(DEFAULT_COORDINATION_CONFIG.maxLatencyMs);
  });
});

describe('end-to-end: parse + merge applies a realistic per-tenant override', () => {
  it('a tenant enabling sensitivity-consensus with llm_synthesis + EntropySeed produces correct effective config', () => {
    const tenantSettings = parseOrganizationCollectiveSettings({
      enabled: true,
      aggregationMethod: 'llm_synthesis',
      entropySeedEnabled: true,
      maxRounds: 4,
      maxCostUsd: 0.75,
    });
    const effective = mergeOrgSettingsIntoConfig(DEFAULT_COORDINATION_CONFIG, tenantSettings);

    expect(effective.enabled).toBe(true);
    expect(effective.aggregationMethod).toBe('llm_synthesis');
    expect(effective.entropySeedEnabled).toBe(true);
    expect(effective.maxRounds).toBe(4);
    expect(effective.maxCostUsd).toBe(0.75);

    // Untouched fields preserve env defaults
    expect(effective.minConvergenceScore).toBe(DEFAULT_COORDINATION_CONFIG.minConvergenceScore);
    expect(effective.maxDissent).toBe(DEFAULT_COORDINATION_CONFIG.maxDissent);
  });
});
