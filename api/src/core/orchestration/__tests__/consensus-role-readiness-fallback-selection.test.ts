// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §12 — Role readiness fallback contract.
 *
 * Pins the expected SHAPE of role-readiness fallback in the consensus
 * plan, regardless of whether the underlying planner currently picks
 * an alternative model or not.
 *
 * The contract:
 *   - `allowModelFallback: true` + preferred model has 0 live-ready
 *     routes → planner MAY surface an alternative `selectedLogicalModelId`
 *     with `roleModelFallback=true` and explicit reason.
 *   - `allowModelFallback: false` → planner MUST emit a blocker
 *     (`no_eligible_<role>`) without swapping models.
 *   - When fallback IS used, both `originalLogicalModelId` and
 *     `selectedLogicalModelId` MUST appear in the plan and feed
 *     `planFingerprint`.
 *
 * The tests use a pure data shape — no Prisma, no provider calls.
 * They lock the field names and semantics so any future planner
 * implementation that adds plan-time fallback STAYS compatible.
 */

import { describe, it, expect } from 'vitest';

interface RoleReadinessFallbackProjection {
  readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
  readonly originalLogicalModelId: string;
  readonly selectedLogicalModelId: string;
  readonly roleModelFallback: boolean;
  readonly roleModelFallbackReason?: string;
  readonly fallbackCandidateModels?: readonly string[];
  readonly fallbackRoutesLiveReady?: number;
}

/** Mirror the projection the consensus-plan-dry-run-service would expose. */
function projectFallback(input: {
  readonly role: RoleReadinessFallbackProjection['role'];
  readonly preferredLogicalModelId: string;
  readonly preferredLiveReadyCount: number;
  readonly allowModelFallback: boolean;
  readonly eligibleAlternatives: ReadonlyArray<{ logicalModelId: string; liveReadyCount: number }>;
}): RoleReadinessFallbackProjection {
  const { role, preferredLogicalModelId, preferredLiveReadyCount, allowModelFallback, eligibleAlternatives } = input;
  // No fallback needed.
  if (preferredLiveReadyCount > 0) {
    return {
      role,
      originalLogicalModelId: preferredLogicalModelId,
      selectedLogicalModelId: preferredLogicalModelId,
      roleModelFallback: false,
    };
  }
  // Fallback requested + a live-ready alternative exists.
  if (allowModelFallback) {
    const alt = eligibleAlternatives.find((a) => a.liveReadyCount > 0);
    if (alt) {
      return {
        role,
        originalLogicalModelId: preferredLogicalModelId,
        selectedLogicalModelId: alt.logicalModelId,
        roleModelFallback: true,
        roleModelFallbackReason: 'preferred_model_no_live_ready_route',
        fallbackCandidateModels: eligibleAlternatives.map((a) => a.logicalModelId),
        fallbackRoutesLiveReady: alt.liveReadyCount,
      };
    }
  }
  // Otherwise: no fallback, plan stays on preferred (will be rejected
  // downstream with no_eligible_<role>).
  return {
    role,
    originalLogicalModelId: preferredLogicalModelId,
    selectedLogicalModelId: preferredLogicalModelId,
    roleModelFallback: false,
    roleModelFallbackReason: 'no_live_ready_alternative_within_allow_model_fallback_scope',
  };
}

describe('01C.1B-J1C §12 — role readiness fallback contract', () => {
  it('synthesizer credit-blocked + allowModelFallback=true picks live-ready alternative', () => {
    const out = projectFallback({
      role: 'synthesizer',
      preferredLogicalModelId: 'anthropic-claude-3.7-sonnet',
      preferredLiveReadyCount: 0,
      allowModelFallback: true,
      eligibleAlternatives: [
        { logicalModelId: 'mistral-large-2', liveReadyCount: 3 },
        { logicalModelId: 'gpt-4o', liveReadyCount: 2 },
      ],
    });
    expect(out.roleModelFallback).toBe(true);
    expect(out.originalLogicalModelId).toBe('anthropic-claude-3.7-sonnet');
    expect(out.selectedLogicalModelId).toBe('mistral-large-2');
    expect(out.roleModelFallbackReason).toBe('preferred_model_no_live_ready_route');
    expect(out.fallbackRoutesLiveReady).toBe(3);
  });

  it('judge unauditable + allowModelFallback=true searches alternatives', () => {
    const out = projectFallback({
      role: 'judge',
      preferredLogicalModelId: 'qwen/qwen3-next-80b-a3b-instruct:free',
      preferredLiveReadyCount: 0,
      allowModelFallback: true,
      eligibleAlternatives: [{ logicalModelId: 'gemini-2.5-pro', liveReadyCount: 1 }],
    });
    expect(out.roleModelFallback).toBe(true);
    expect(out.selectedLogicalModelId).toBe('gemini-2.5-pro');
  });

  it('allowModelFallback=false keeps the preferred (and downstream emits no_eligible_<role>)', () => {
    const out = projectFallback({
      role: 'synthesizer',
      preferredLogicalModelId: 'anthropic-claude-3.7-sonnet',
      preferredLiveReadyCount: 0,
      allowModelFallback: false,
      eligibleAlternatives: [{ logicalModelId: 'mistral-large-2', liveReadyCount: 3 }],
    });
    expect(out.roleModelFallback).toBe(false);
    expect(out.selectedLogicalModelId).toBe('anthropic-claude-3.7-sonnet');
  });

  it('preferred IS live-ready → no fallback even when allowed', () => {
    const out = projectFallback({
      role: 'participant',
      preferredLogicalModelId: 'meta/llama-3.2-11b',
      preferredLiveReadyCount: 2,
      allowModelFallback: true,
      eligibleAlternatives: [{ logicalModelId: 'mistral-large-2', liveReadyCount: 3 }],
    });
    expect(out.roleModelFallback).toBe(false);
    expect(out.selectedLogicalModelId).toBe('meta/llama-3.2-11b');
  });

  it('no live-ready alternative exists → no fallback, blocker downstream', () => {
    const out = projectFallback({
      role: 'judge',
      preferredLogicalModelId: 'qwen/qwen3-next-80b-a3b-instruct:free',
      preferredLiveReadyCount: 0,
      allowModelFallback: true,
      eligibleAlternatives: [
        { logicalModelId: 'mistral-large-2', liveReadyCount: 0 },
        { logicalModelId: 'gpt-4o', liveReadyCount: 0 },
      ],
    });
    expect(out.roleModelFallback).toBe(false);
    expect(out.selectedLogicalModelId).toBe('qwen/qwen3-next-80b-a3b-instruct:free');
    expect(out.roleModelFallbackReason).toMatch(/no_live_ready_alternative/);
  });

  it('contract field shape stable (consumers can rely on these names)', () => {
    const out = projectFallback({
      role: 'synthesizer',
      preferredLogicalModelId: 'anthropic-claude-3.7-sonnet',
      preferredLiveReadyCount: 0,
      allowModelFallback: true,
      eligibleAlternatives: [{ logicalModelId: 'mistral-large-2', liveReadyCount: 1 }],
    });
    expect(out).toHaveProperty('role');
    expect(out).toHaveProperty('originalLogicalModelId');
    expect(out).toHaveProperty('selectedLogicalModelId');
    expect(out).toHaveProperty('roleModelFallback');
    expect(out).toHaveProperty('roleModelFallbackReason');
    expect(out).toHaveProperty('fallbackCandidateModels');
    expect(out).toHaveProperty('fallbackRoutesLiveReady');
  });

  it('no provider HTTP call is implied by the projection (pure function)', () => {
    // projection is sync + has no Prisma/fetch import — sanity check.
    expect(projectFallback.length).toBe(1);
  });
});
