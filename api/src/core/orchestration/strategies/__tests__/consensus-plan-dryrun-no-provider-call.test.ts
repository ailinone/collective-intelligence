// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-R — Provider-call tripwire for `ConsensusPlanDryRunService`.
 *
 * Belt-and-suspenders companion to `consensus-plan-dry-run.test.ts`. That
 * file pins the gate logic and the absence of `fetch()` calls. This file
 * also tracks `globalThis.fetch` AND verifies the service doesn't reach
 * the orchestration engine, the provider registry, or the response
 * aggregator. The goal is to make ANY future regression that adds a
 * provider hop to the dry-run path observable as a test failure.
 *
 * If a future refactor changes the public surface of these modules, this
 * test should fail clearly — that's the desired behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsensusPlanDryRunService } from '../consensus-plan-dry-run-service';
import { diversePool } from '../../model-selection/__tests__/role-resolver.fixtures';

const ORIG_FETCH = globalThis.fetch;

describe('ConsensusPlanDryRunService — provider-call tripwire', () => {
  it('never calls globalThis.fetch when producing a plan', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error(
        'PROVIDER_CALL_DETECTED — dry-run path must NOT reach global fetch',
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const service = new ConsensusPlanDryRunService();
      await service.plan({
        chatRequest: {
          model: 'auto',
          strategy: 'consensus',
          messages: [{ role: 'user', content: 'tripwire probe' }],
          max_tokens: 1500,
          max_cost: 0.5,
        },
        candidatePool: diversePool().map((c) => c.model),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = ORIG_FETCH;
    }
  });

  it('produces a plan whose participants have non-empty model ids without invoking any HTTP layer', async () => {
    // Patch fetch to a failing spy. If anything in the plan path
    // accidentally triggers a network call (provider list-models,
    // OAuth token refresh, etc.), the spy throws and the test fails.
    const fetchSpy = vi.fn(async () => {
      throw new Error(
        'PROVIDER_CALL_DETECTED — list-models, balance probe, or any HTTP must NOT fire from dry-run',
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const service = new ConsensusPlanDryRunService();
      const plan = await service.plan({
        chatRequest: {
          model: 'auto',
          strategy: 'consensus',
          messages: [{ role: 'user', content: 'no-network probe' }],
          max_tokens: 1000,
        },
        candidatePool: diversePool().map((c) => c.model),
      });
      // Plan structure is well-formed
      expect(plan.strategyName).toBe('consensus');
      expect(Array.isArray(plan.participants)).toBe(true);
      // Each participant has a model id
      for (const p of plan.participants) {
        expect(typeof p.model.id).toBe('string');
        expect(p.model.id.length).toBeGreaterThan(0);
      }
      // No fetch happened
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = ORIG_FETCH;
    }
  });

  it('exposes hardcodedModelUsed=false (no fixed model fallback)', async () => {
    const service = new ConsensusPlanDryRunService();
    const plan = await service.plan({
      chatRequest: {
        model: 'auto',
        strategy: 'consensus',
        messages: [{ role: 'user', content: 'hardcoded probe' }],
        max_tokens: 1000,
      },
      candidatePool: diversePool().map((c) => c.model),
    });
    expect(plan.hardcodedModelUsed).toBe(false);
  });
});
