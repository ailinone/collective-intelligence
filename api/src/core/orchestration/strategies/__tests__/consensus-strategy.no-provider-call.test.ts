// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 6/9: No real provider / network calls.
 *
 * Covers spec invariant #12 — the strategy under test must never touch
 * fetch / http / https for its scoring + fallback decision path. The
 * adapter and aggregator are mocked; this test pins that contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  healthyResponses,
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — no provider call', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let httpRequestSpy: ReturnType<typeof vi.spyOn>;
  let httpsRequestSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(async () => {
      throw new Error('fetch must NOT be called from ConsensusStrategy under test');
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    httpRequestSpy = vi.spyOn(http, 'request');
    httpsRequestSpy = vi.spyOn(https, 'request');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch!;
    httpRequestSpy.mockRestore();
    httpsRequestSpy.mockRestore();
  });

  it('happy path: fetch / http / https are never invoked', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
    expect(r.metadata?.consensusArtifacts).toBeDefined();
    const a = r.metadata!.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.participantOutputs.length).toBe(3);
  });

  it('degraded path: still no network even when synthesis is skipped', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: '' },
        'voter-c': { content: '' },
      },
      eligibleModels: models,
    });
    await strategy.execute(makeRequest(), makeContext(models));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });

  it('failed-voter path: no network even when one execution errors', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: '', success: false, error: 'mock_error' },
      },
      eligibleModels: models,
    });
    await strategy.execute(makeRequest(), makeContext(models));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });
});
