// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Provider-boundary sentry.
 * Patches global fetch and proves the REAL entrypoint triggers zero outbound calls.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';

let fetchAttempts = 0;
const origFetch = globalThis.fetch;

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — provider boundary', () => {
  beforeAll(() => {
    fetchAttempts = 0;
    // @ts-expect-error sentry override
    globalThis.fetch = (...args: unknown[]) => {
      fetchAttempts += 1;
      throw new Error('SENTRY_BLOCKED_FETCH');
    };
  });
  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  it('cases 10-13: invoking the real entrypoint triggers ZERO outbound fetch', () => {
    const req = { model: 'auto', messages: [{ role: 'user' as const, content: '[boundary]' }], dryRun: true as const };
    const ctx = {
      requestId: 'smoke-boundary-1',
      taskType: 'general',
      qualityTarget: 0.8,
      preferSpeed: false,
      models: [{ id: 'Qwen/Qwen2.5-7B-Instruct', provider: 'huggingface' }],
    } as any;
    // Drive the real production dry-run entrypoint under the fetch sentry.
    const result = buildPlanOnlyResult('consensus', 'explicit', 'request.dryRun', req as any, ctx, null, 0.8, { registered: true });
    expect((result as any).totalCost).toBe(0);
    expect((result as any).metadata.provider_call_executed).toBe(false);
    // The critical assertion: the real entrypoint made no network call.
    expect(fetchAttempts).toBe(0);
  });

  const ART = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-controlled-runtime-smoke-provider-boundary-sentry.json');
  const sentry = existsSync(ART) ? JSON.parse(readFileSync(ART, 'utf8')) : null;
  const maybe = sentry ? describe : describe.skip;
  maybe('generated provider-boundary sentry artifact (local verification)', () => {
    it('sentry active with zero provider-adapter and external-network attempts', () => {
      expect(sentry.providerBoundarySentryActive).toBe(true);
      expect(sentry.externalNetworkSentryActive).toBe(true);
      expect(sentry.providerAdapterCallAttempts).toBe(0);
      expect(sentry.externalNetworkCallAttempts).toBe(0);
    });
  });
});
