// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#752 — consensus emits a `model_failed` observer event per failed voter.
 *
 * Until now a failed voter (HTTP 4xx/5xx, timeout, empty response) was only
 * visible in the debug log ("Model execution failed" / "Provider returned
 * empty assistant response") and in the aggregate succeeded/failed counts —
 * the observer never received a per-model failure event, so the narration
 * told an incomplete story ("3 models worked on your answer" while one had
 * failed with a 401).
 *
 * Runs under vitest.consensus-validation.config.ts (file matches the
 * `consensus-strategy.*` include glob), so the response-aggregator mocks
 * from consensus-validation.setup.ts apply — same harness as the other
 * `consensus-strategy.*` execute() suites.
 */
import { describe, it, expect } from 'vitest';
import type { ObserverEvent } from '@/types';
import {
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ci#752 — consensus model_failed observer event', () => {
  it('ObserverEvent union accepts a well-formed model_failed event (contract)', () => {
    // Compile-time: `type: 'model_failed'` must be assignable to the union,
    // and the ci#752-only fields (provider/role/errorCode/attempt) must exist.
    const event: ObserverEvent = {
      type: 'model_failed',
      timestamp: Date.now(),
      strategy: 'consensus',
      modelId: 'voter-b',
      modelName: 'Voter B',
      provider: 'prov-b',
      role: 'voter',
      errorCode: 'auth_failed',
      attempt: 1,
      summary: 'A participant failed: HTTP 401 Unauthorized.',
    };
    expect(event.type).toBe('model_failed');
  });

  it('emits model_failed for a failed voter with structured facts (and none for healthy voters)', async () => {
    const models = threeHealthyModels();
    const { strategy, emitObserverSpy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { success: false, error: 'HTTP 401 Unauthorized', content: '' },
        'voter-c': { content: 'C'.repeat(120) },
      },
      eligibleModels: models,
    });

    await strategy.execute(makeRequest(), makeContext(models));

    // emitObserverEvent(context, event) — event is the second argument.
    const failures = emitObserverSpy.mock.calls
      .map((call) => call[1] as ObserverEvent)
      .filter((event) => event.type === 'model_failed');
    expect(failures).toHaveLength(1);

    const failed = failures[0];
    expect(failed.modelId).toBe('voter-b');
    expect(failed.provider).toBe('prov-b');
    expect(failed.role).toBe('voter');
    // errorCode reuses the shared provider-failure taxonomy (failures/),
    // not an ad-hoc classification.
    expect(failed.errorCode).toBe('auth_failed');
    // Narration context: how many participants are still continuing (N-1).
    expect(failed.metadata?.remaining).toBe(2);
    // Healthy voters must not be narrated as failures.
    expect(failed.modelId).not.toBe('voter-a');
    expect(failed.modelId).not.toBe('voter-c');
  });
});
