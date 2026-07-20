// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Positive cases via the REAL entrypoint.
 * Imports and invokes the production buildPlanOnlyResult + detectDryRun in-process (CI-safe).
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import { detectDryRun } from '@/core/orchestration/dry-run/dry-run-execution-guard';
import {
  c3SmokeEnvelopeFromOrchestrationResult,
  isC3ControlledSmokeExecutionLocked,
} from '@/core/experiment/c3-dryrun-controlled-runtime-smoke-contract';

const req = { model: 'auto', messages: [{ role: 'user' as const, content: '[smoke]' }], dryRun: true as const };
const ctx = {
  requestId: 'smoke-positive-1',
  taskType: 'code-generation',
  qualityTarget: 0.8,
  preferSpeed: false,
  models: [{ id: 'Qwen/Qwen2.5-7B-Instruct', provider: 'huggingface' }],
} as any;

describe('01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — positive cases (real entrypoint)', () => {
  // Real production dry-run path: detect → build plan-only result.
  const detected = detectDryRun(req as any);
  const realResult = buildPlanOnlyResult('single', 'explicit', 'request.dryRun', req as any, ctx, null, 0.8, { registered: true });
  const env = c3SmokeEnvelopeFromOrchestrationResult(realResult as any);

  it('case 14: a dryRun=true request is admitted by the real guard', () => {
    expect(detected.detected).toBe(true);
  });

  it('the real entrypoint produced an execution-locked envelope', () => {
    expect(isC3ControlledSmokeExecutionLocked(env)).toBe(true);
  });

  it('case 15: providerCallExecuted=false (real metadata)', () => {
    expect(env.providerCallExecuted).toBe(false);
    expect((realResult as any).metadata.provider_call_executed).toBe(false);
  });
  it('case 16: providerCallsExecuted=0', () => {
    expect(env.providerCallsExecuted).toBe(0);
  });
  it('case 17: modelProbesExecuted=0', () => {
    expect(env.modelProbesExecuted).toBe(0);
  });
  it('case 18: providerProbesExecuted=0', () => {
    expect(env.providerProbesExecuted).toBe(0);
  });
  it('case 19: cost_usd=0 (real totalCost)', () => {
    expect(env.cost_usd).toBe(0);
    expect((realResult as any).totalCost).toBe(0);
  });
  it('case 20: usage.total_tokens=0 (real usage)', () => {
    expect(env.usage.total_tokens).toBe(0);
    expect((realResult as any).finalResponse.usage.total_tokens).toBe(0);
  });
  it('real plan carries a non-empty planFingerprint', () => {
    expect(typeof env.planFingerprint).toBe('string');
    expect((env.planFingerprint as string).length).toBeGreaterThan(0);
    expect(env.provenanceComplete).toBe(true);
  });

  const RT = resolve(process.cwd(), 'tmp', '01c1b-c3-dryrun-controlled-runtime-smoke-runtime-responses.json');
  const rt = existsSync(RT) ? JSON.parse(readFileSync(RT, 'utf8')) : null;
  const maybe = rt ? describe : describe.skip;
  maybe('generated runtime responses (local verification)', () => {
    it('all positive responses real-entrypoint-invoked + execution-locked', () => {
      expect(rt.allExecutionLocked).toBe(true);
      expect(rt.realEntrypointInvocations).toBe(rt.responseCount);
      expect(rt.responses.every((r: any) => r.response.realEntrypointInvoked === true)).toBe(true);
    });
  });
});
