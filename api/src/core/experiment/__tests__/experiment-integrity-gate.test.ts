// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Integrity Gate — Tests
 *
 * Covers two production bugs found via DB forensics on completed C3
 * experiments (see PR description):
 *
 *  1. `applyPolicyGate` — experiment-integrity-guard's own contract says
 *     the caller must decide success=false when a trajectory violates its
 *     arm's policy (e.g. fallback depth exceeded). That was previously
 *     never implemented: a policy-invalid row was persisted as
 *     success=true with the violation only logged. Reproduced in
 *     production by `collective/dynamic` rows whose fallback chain
 *     resolved to video-generation model IDs (kling, sora, veo) — 195+
 *     rows with success=true, quality_score≈0, and
 *     policyValidation.valid=false all silently counted into aggregate
 *     quality stats.
 *
 *  2. `buildCanarySkipKey` — the canary-skip path built its skip-reason
 *     key by concatenating `canary_skip:${errorClass}:` (single colon)
 *     directly with an armId that uses deriveArmId()'s `mode::strategy`
 *     double-colon scheme, producing keys like
 *     "canary_skip:timeout:collective::collaborative" that read as having
 *     an empty segment. Every other skip-reason producer in this file
 *     uses getModeKey()'s single-colon scheme.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { applyPolicyGate, buildCanarySkipKey, getModeKey } from '../experiment-runner';
import type { ModeConfig } from '../experiment-types';

describe('applyPolicyGate', () => {
  it('passes through the original success/failureMode when there is no policy violation', () => {
    const result = applyPolicyGate(true, undefined, false);
    expect(result).toEqual({ success: true, failureMode: null });
  });

  it('passes through an existing failureMode when there is no policy violation', () => {
    const result = applyPolicyGate(false, 'timeout', false);
    expect(result).toEqual({ success: false, failureMode: 'timeout' });
  });

  it('forces success=false and failureMode=policy-violation when a violation is detected, even if the orchestrator reported success=true', () => {
    // This is the exact shape of the production bug: the orchestrator's own
    // result said success=true (it got an HTTP 200 and a response), but the
    // integrity guard found the trajectory violated its arm's policy
    // (e.g. fallback_depth_exceeded from a video-model leak).
    const result = applyPolicyGate(true, undefined, true);
    expect(result).toEqual({ success: false, failureMode: 'policy-violation' });
  });

  it('policy-violation failureMode overrides any failureMode the orchestrator itself set', () => {
    const result = applyPolicyGate(false, 'api-error', true);
    expect(result.success).toBe(false);
    expect(result.failureMode).toBe('policy-violation');
  });
});

describe('policy gating is DISABLED in persistExecution (synthetic-attempt guardrail)', () => {
  // The ExecutionRecord persistExecution feeds the integrity guard is
  // synthetic: providerId:'unknown' + index-based roles. That made the
  // guard fire false positives (degraded_answer_mode on every single-model
  // row; index-labelled experts as "fallbacks") and, once applyPolicyGate
  // was wired in, VOID every execution (an entire 6396-arm HumanEval run
  // was lost this way). The root leak is fixed by the modality filter
  // (PR #172), so gating on this low-fidelity signal must stay OFF until the
  // guard gets real attempt records. This pins that: re-enabling gating
  // (reintroducing `policyViolationDetected = true`) fails here on purpose.
  it('persistExecution never sets policyViolationDetected = true', async () => {
    const src = await fs.readFile(path.resolve(__dirname, '../experiment-runner.ts'), 'utf8');
    expect(src).toContain('const policyViolationDetected = false;');
    expect(src).not.toMatch(/policyViolationDetected\s*=\s*true/);
  });
});

describe('getModeKey', () => {
  it('uses a single colon for collective mode', () => {
    const mode: ModeConfig = { mode: 'collective', strategy: 'collaborative', displayName: 'x' } as ModeConfig;
    expect(getModeKey(mode)).toBe('collective:collaborative');
  });

  it('uses a single colon for single-model mode', () => {
    const mode: ModeConfig = { mode: 'single-model', modelId: 'groq/compound', displayName: 'x' } as ModeConfig;
    expect(getModeKey(mode)).toBe('single-model:groq/compound');
  });
});

describe('buildCanarySkipKey', () => {
  it('uses getModeKey single-colon scheme instead of the armId double-colon scheme', () => {
    const mode: ModeConfig = { mode: 'collective', strategy: 'collaborative', displayName: 'x' } as ModeConfig;
    // deriveArmId() would produce 'collective::collaborative' for this mode
    // (double colon by design — see policy-arm-resolver.ts). Simulating
    // that here without importing the real resolver, since the point of
    // this test is the key-building logic, not arm resolution itself.
    const armIdToMode = new Map([['collective::collaborative', mode]]);

    const key = buildCanarySkipKey('timeout', 'collective::collaborative', armIdToMode);

    // Regression guard: this must NOT be
    // "canary_skip:timeout:collective::collaborative" (the double-colon bug).
    expect(key).toBe('canary_skip:timeout:collective:collaborative');
    expect(key).not.toContain('::');
  });

  it('falls back to the raw armId when no matching mode is found', () => {
    const key = buildCanarySkipKey('timeout', 'some-unresolved-arm', new Map());
    expect(key).toBe('canary_skip:timeout:some-unresolved-arm');
  });

  it('produces a key consistent with arm_budget_exceeded style keys for the same mode', () => {
    const mode: ModeConfig = { mode: 'single-model', modelId: 'xai/grok-4-1-fast-reasoning', displayName: 'x' } as ModeConfig;
    const armIdToMode = new Map([['single-model::xai/grok-4-1-fast-reasoning', mode]]);

    const canaryKey = buildCanarySkipKey('timeout', 'single-model::xai/grok-4-1-fast-reasoning', armIdToMode);
    const budgetExceededStyleKey = `arm_budget_exceeded:${getModeKey(mode)}`;

    // Both should share the same "single-model:<modelId>" suffix scheme.
    expect(canaryKey).toBe('canary_skip:timeout:single-model:xai/grok-4-1-fast-reasoning');
    expect(budgetExceededStyleKey).toBe('arm_budget_exceeded:single-model:xai/grok-4-1-fast-reasoning');
  });
});
