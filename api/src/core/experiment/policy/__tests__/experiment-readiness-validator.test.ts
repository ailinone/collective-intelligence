// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Readiness Validator tests — verifies per-arm decision logic + goal-aware
 * experiment-level decision.
 *
 * The validator depends on the provider registry and credit monitor as
 * services. We mock those services at module level so tests run without
 * a live registry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the service singletons BEFORE importing the validator ────────────

const providerHealthMap = new Map<string, boolean>(); // providerId → hasCredits

vi.mock('@/services/credit-monitor-service', () => ({
  getCreditMonitorService: () => ({
    hasCredits: (providerId: string) => providerHealthMap.get(providerId) ?? true,
  }),
}));

let registeredProviders: string[] = [];

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({
    getProviderNames: () => registeredProviders,
    get: (id: string) => (registeredProviders.includes(id) ? { id } : undefined),
  }),
}));

// Mock the catalog index so resolveProviderFamily returns predictable values
vi.mock('@/providers/catalog/providers.catalog', () => ({
  PROVIDER_CATALOG: [
    { providerId: 'openai-native', providerFamily: 'openai', aliases: [] },
    { providerId: 'cometapi', providerFamily: 'openai', aliases: [] },
    { providerId: 'aihubmix', providerFamily: 'openai', aliases: [] },
    { providerId: 'anthropic-native', providerFamily: 'anthropic', aliases: [] },
    { providerId: 'groq', providerFamily: 'meta', aliases: [] },
  ],
}));

// We don't need DB for readiness — but the validator can lazy-import classifyModelById
// for strict baseline arms without declared providerId. Mock prisma client too.
vi.mock('@/database/client', () => ({
  prisma: {
    model: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import {
  DefaultExperimentReadinessValidator,
  _resetReadinessValidatorForTests,
  type ExperimentGoal,
} from '../experiment-readiness-validator';
import { resolveExperimentArm } from '../policy-arm-resolver';
import {
  _resetCatalogIndexForTests,
  _resetClassificationCacheForTests,
} from '../model-classification';

beforeEach(() => {
  vi.clearAllMocks();
  providerHealthMap.clear();
  registeredProviders = [];
  _resetReadinessValidatorForTests();
  _resetCatalogIndexForTests();
  _resetClassificationCacheForTests();
});

describe('readiness — strict_baseline arm', () => {
  it('decision=ready when declared provider is healthy', async () => {
    registeredProviders = ['openai-native', 'cometapi'];
    providerHealthMap.set('openai-native', true);
    providerHealthMap.set('cometapi', true);

    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      preferredProviders: ['openai-native'],
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'top_tier_comparison',
      arms: [arm],
    });

    expect(matrix.armReadiness[0].decision).toBe('ready');
  });

  it('decision=skip_unavailable when declared provider is exhausted', async () => {
    registeredProviders = ['openai-native', 'cometapi'];
    providerHealthMap.set('openai-native', false); // out of credits
    providerHealthMap.set('cometapi', true);

    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      preferredProviders: ['openai-native'],
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'top_tier_comparison',
      arms: [arm],
    });

    expect(matrix.armReadiness[0].decision).toBe('skip_unavailable');
    expect(matrix.armReadiness[0].reason).toContain('insufficient_credit');
  });
});

describe('readiness — family_baseline arm', () => {
  it('decision=reroute_within_family when at least one silo is healthy', async () => {
    registeredProviders = ['openai-native', 'cometapi', 'aihubmix'];
    providerHealthMap.set('openai-native', false);
    providerHealthMap.set('cometapi', true); // silo with credits
    providerHealthMap.set('aihubmix', false);

    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o family',
      policyHints: {
        role: 'family_baseline',
        identityLevel: 'model_family',
        declaredModelFamily: 'openai',
      },
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'family_comparison',
      arms: [arm],
    });

    expect(matrix.armReadiness[0].decision).toBe('reroute_within_family');
    expect(matrix.armReadiness[0].candidatePoolAfter).toBe(1);
  });

  it('decision=skip_unavailable when ALL silos in family are exhausted', async () => {
    registeredProviders = ['openai-native', 'cometapi', 'aihubmix'];
    providerHealthMap.set('openai-native', false);
    providerHealthMap.set('cometapi', false);
    providerHealthMap.set('aihubmix', false);

    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o family',
      policyHints: {
        role: 'family_baseline',
        identityLevel: 'model_family',
        declaredModelFamily: 'openai',
      },
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'family_comparison',
      arms: [arm],
    });

    expect(matrix.armReadiness[0].decision).toBe('skip_unavailable');
  });
});

describe('readiness — dynamic_router arm', () => {
  it('decision=proceed_with_health_filtered_pool when ANY provider is healthy', async () => {
    registeredProviders = ['openai-native', 'cometapi', 'groq'];
    providerHealthMap.set('openai-native', false);
    providerHealthMap.set('cometapi', true);
    providerHealthMap.set('groq', true);

    const arm = resolveExperimentArm({
      mode: 'adaptive',
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'dynamic_routing_eval',
      arms: [arm],
    });

    expect(matrix.armReadiness[0].decision).toBe('proceed_with_health_filtered_pool');
    expect(matrix.armReadiness[0].candidatePoolAfter).toBe(2);
  });
});

describe('readiness — resilience_strategy arm', () => {
  it('proceeds even with most providers dead — degraded environment is the scenario', async () => {
    registeredProviders = ['openai-native', 'cometapi'];
    providerHealthMap.set('openai-native', false);
    providerHealthMap.set('cometapi', false);

    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'cost-cascade',
      policyHints: {
        role: 'resilience_strategy',
      },
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'resilience_eval',
      arms: [arm],
    });

    expect(matrix.armReadiness[0].decision).toBe('proceed_with_observed_degradation');
    expect(matrix.decision).toBe('proceed');
  });
});

describe('readiness — goal-aware experiment decision', () => {
  it('top_tier_comparison aborts when zero strict baselines healthy', async () => {
    registeredProviders = ['openai-native', 'cometapi'];
    providerHealthMap.set('openai-native', false);
    providerHealthMap.set('cometapi', false);

    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      preferredProviders: ['openai-native'],
    });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'top_tier_comparison',
      arms: [arm],
    });

    expect(matrix.decision).toBe('abort');
  });

  it('dynamic_routing_eval proceeds even with strict baselines down', async () => {
    registeredProviders = ['openai-native', 'cometapi', 'groq'];
    providerHealthMap.set('openai-native', false);
    providerHealthMap.set('cometapi', false);
    providerHealthMap.set('groq', true);

    const dynamicArm = resolveExperimentArm({ mode: 'adaptive' });

    const validator = new DefaultExperimentReadinessValidator();
    const matrix = await validator.validate({
      experimentId: 'test',
      experimentGoal: 'dynamic_routing_eval',
      arms: [dynamicArm],
    });

    expect(matrix.decision).toBe('proceed');
  });
});
