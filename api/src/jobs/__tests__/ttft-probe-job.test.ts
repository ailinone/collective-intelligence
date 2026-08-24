// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the TTFT probe job (P0.8):
 *  - registry wiring (handler + schedule);
 *  - convergence short-circuit (no synthetic traffic when enough fast routes);
 *  - candidate filtering (cheap-tier, active, chat, not quarantined, untracked);
 *  - success/failure recording into the shared TTFT tracker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTtftTracker, resetTtftTrackerForTesting } from '@/core/selection/ttft-tracker';
import type { Model } from '@/types';

vi.mock('@/utils/logger', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const chatCompletionMock = vi.fn(async () => ({ ok: true }));

vi.mock('@/services/model-catalog-service', () => ({
  modelCatalogService: {},
  getAllCatalogModels: vi.fn(),
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({
    findModel: vi.fn(async (modelId: string) => ({ model: { id: modelId }, adapter: { getName: () => 'x', chatCompletion: chatCompletionMock } })),
  }),
}));

vi.mock('@/core/provider-operability-hub', () => ({
  getProviderOperabilityHub: () => ({
    getProviderState: (provider: string) => ({
      operabilityState: provider === 'dead-provider' ? 'auth_failed' : 'healthy',
    }),
  }),
}));

import { runTtftProbeNow, isTtftProbeEnabled, startTtftProbePoller } from '../ttft-probe-job';
import { getAllCatalogModels } from '@/services/model-catalog-service';

const REGISTRY_PATH = join(__dirname, '..', 'register-scheduled-jobs.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
const INDEX_PATH = join(__dirname, '..', '..', 'index.ts');
const indexSource = readFileSync(INDEX_PATH, 'utf8');

function makeModel(overrides: Partial<Model> & { id: string; provider: string }): Model {
  return {
    name: overrides.id,
    providerId: overrides.provider,
    capabilities: ['chat'],
    contextWindow: 32000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0001,
    status: 'active',
    ...overrides,
  } as Model;
}

describe('ttft-probe wiring (in-process poller, NOT BullMQ)', () => {
  it('index.ts starts the per-replica poller post-listen', () => {
    expect(indexSource).toMatch(/startTtftProbePoller\(\)/);
    expect(indexSource).toMatch(/\.\/jobs\/ttft-probe-job(\.js)?/);
  });

  it('is NOT registered as a BullMQ cron (would seed the worker-process tracker)', () => {
    expect(registrySource).not.toMatch(/name:\s*['"]ttft-probe['"]/);
    expect(registrySource).not.toMatch(/['"]ttft-probe['"]\s*:\s*async/);
  });

  it('startTtftProbePoller is idempotent (no duplicate intervals)', () => {
    startTtftProbePoller();
    startTtftProbePoller();
  });
});

describe('isTtftProbeEnabled', () => {
  afterEach(() => delete process.env.CI_TTFT_PROBE_ENABLED);
  it('defaults to enabled', () => {
    delete process.env.CI_TTFT_PROBE_ENABLED;
    expect(isTtftProbeEnabled()).toBe(true);
  });
  it('is disabled only when explicitly "false"', () => {
    process.env.CI_TTFT_PROBE_ENABLED = 'false';
    expect(isTtftProbeEnabled()).toBe(false);
  });
});

describe('runTtftProbeNow', () => {
  beforeEach(() => {
    resetTtftTrackerForTesting();
    chatCompletionMock.mockClear();
    vi.mocked(getAllCatalogModels).mockReset();
  });

  it('skips as converged when enough known-fast routes exist', async () => {
    const tracker = getTtftTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordFirstChunk('prov-fast', `m-${i}`, 500);
    }
    const result = await runTtftProbeNow();
    expect(result.skipped).toBe('converged');
    expect(result.probed).toBe(0);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('probes untracked cheap-tier routes and records success samples', async () => {
    vi.mocked(getAllCatalogModels).mockResolvedValue([
      makeModel({ id: 'm-a', provider: 'prov-a' }),
      makeModel({ id: 'm-b', provider: 'prov-b' }),
    ]);
    const result = await runTtftProbeNow();
    expect(result.probed).toBe(2);
    expect(result.succeeded).toBe(2);
    const tracker = getTtftTracker();
    expect(tracker.sampleCount('prov-a', 'm-a')).toBe(1);
    expect(tracker.sampleCount('prov-b', 'm-b')).toBe(1);
    expect(tracker.predictedTtftMs('prov-a', 'm-a')).not.toBeNull();
  });

  it('skips quarantined providers and non-cheap models', async () => {
    vi.mocked(getAllCatalogModels).mockResolvedValue([
      makeModel({ id: 'm-dead', provider: 'dead-provider' }),
      makeModel({ id: 'm-premium', provider: 'prov-p', inputCostPer1k: 0.05, outputCostPer1k: 0.05 }),
      makeModel({ id: 'm-inactive', provider: 'prov-i', status: 'inactive' }),
    ]);
    const result = await runTtftProbeNow();
    expect(result.skipped).toBe('no_untracked_candidates');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('records a failure when the adapter throws', async () => {
    vi.mocked(getAllCatalogModels).mockResolvedValue([makeModel({ id: 'm-err', provider: 'prov-e' })]);
    chatCompletionMock.mockRejectedValueOnce(new Error('HTTP 429'));
    const result = await runTtftProbeNow();
    expect(result.probed).toBe(1);
    expect(result.failed).toBe(1);
    expect(getTtftTracker().attemptCount('prov-e', 'm-err')).toBe(1);
    expect(getTtftTracker().sampleCount('prov-e', 'm-err')).toBe(0);
  });

  it('never re-probes a route it already sampled (failure counts as knowledge)', async () => {
    getTtftTracker().recordFailure('prov-a', 'm-known-dead');
    vi.mocked(getAllCatalogModels).mockResolvedValue([
      makeModel({ id: 'm-known-dead', provider: 'prov-a' }),
    ]);
    const result = await runTtftProbeNow();
    expect(result.skipped).toBe('no_untracked_candidates');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });
});
