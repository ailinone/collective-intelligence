// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * freshness-readiness-gate.test.ts — MVP 4
 *
 * The critical invariant: a "newer" model that is NOT routable (no
 * credits / auth failed / minimal chat failed) MUST score zero with
 * the appropriate status. Freshness NEVER overrides readiness.
 *
 * This is the most important test of the MVP — without it, the scorer
 * could pick the latest Kimi K2.6 even when its credit is exhausted,
 * silently masking the failure as "newer model wins".
 */

import { describe, expect, it } from 'vitest';
import { scoreFreshness, isRoutable } from '../freshness-scorer';

describe('freshness — no_credits gate', () => {
  it('current model with no_credits → score=0, status=current_but_no_credit', () => {
    const out = scoreFreshness({
      family: 'kimi',
      generationRank: 10, // very fresh
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'no_credits',
        minimalChatStatus: 'verified',
      },
    });
    expect(out.score).toBe(0);
    expect(out.status).toBe('current_but_no_credit');
    expect(out.reason).toBe('route_no_credits');
    expect(isRoutable(out.status)).toBe(false);
  });

  it('high-generation model with no_credits cannot beat a low-generation healthy one', () => {
    const fresh_but_broke = scoreFreshness({
      family: 'kimi',
      generationRank: 26,
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'no_credits',
        minimalChatStatus: 'verified',
      },
    });
    const old_but_routable = scoreFreshness({
      family: 'kimi',
      generationRank: 2,
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'has_credits',
        minimalChatStatus: 'verified',
      },
    });
    expect(old_but_routable.score).toBeGreaterThan(fresh_but_broke.score);
  });
});

describe('freshness — auth_failed gate', () => {
  it('current model with auth_failed → score=0, status=current_but_auth_failed', () => {
    const out = scoreFreshness({
      family: 'gpt',
      generationRank: 5,
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'auth_failed',
        creditStatus: 'has_credits', // has credits but auth broke
        minimalChatStatus: 'verified',
      },
    });
    expect(out.score).toBe(0);
    expect(out.status).toBe('current_but_auth_failed');
    expect(out.reason).toBe('route_auth_failed');
  });
});

describe('freshness — minimal_chat_failed gate', () => {
  it('current model with minimalChatStatus=failed → score=0', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'has_credits',
        minimalChatStatus: 'failed',
      },
    });
    expect(out.score).toBe(0);
    expect(out.status).toBe('current_but_minimal_chat_failed');
  });
});

describe('freshness — ordering of gate evaluation', () => {
  it('no_credits is reported BEFORE auth_failed when both present', () => {
    // Belt + suspenders: no_credits takes priority because it is a hard
    // business signal (account exhausted) that supersedes auth failure
    // (which could be transient).
    const out = scoreFreshness({
      family: 'kimi',
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'auth_failed',
        creditStatus: 'no_credits',
        minimalChatStatus: 'verified',
      },
    });
    expect(out.status).toBe('current_but_no_credit');
  });

  it('auth_failed is reported BEFORE minimal_chat_failed', () => {
    const out = scoreFreshness({
      family: 'kimi',
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'auth_failed',
        creditStatus: 'has_credits',
        minimalChatStatus: 'failed',
      },
    });
    expect(out.status).toBe('current_but_auth_failed');
  });
});

describe('freshness — preview/deprecated PRECEDE readiness gate', () => {
  // When the lifecycle is preview/deprecated, the LIFECYCLE check fires
  // first — there's no point in reporting readiness if the model is
  // disallowed by policy anyway.
  it('deprecated + healthy → deprecated_blocked, NOT routable', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'deprecated',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'has_credits',
        minimalChatStatus: 'verified',
      },
    });
    expect(out.status).toBe('deprecated_blocked');
  });

  it('preview without policy + no_credits → preview_blocked (lifecycle wins)', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'preview',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'no_credits',
        minimalChatStatus: 'verified',
      },
    });
    expect(out.status).toBe('preview_blocked');
  });

  it('preview WITH policy + no_credits → current_but_no_credit (readiness wins)', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'preview',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'no_credits',
        minimalChatStatus: 'verified',
      },
      policy: { allowPreview: true },
    });
    expect(out.status).toBe('current_but_no_credit');
  });
});

describe('freshness — the "Kimi K2.6 vs K2.0" scenario from the v1.1 plan', () => {
  it('K2.6 with no_credits + K2.0 healthy → K2.0 wins (the invariant)', () => {
    const k26_broke = scoreFreshness({
      family: 'kimi',
      version: '2.6',
      generationRank: 26,
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'no_credits',
        minimalChatStatus: 'verified',
      },
    });
    const k20_healthy = scoreFreshness({
      family: 'kimi',
      version: '2.0',
      generationRank: 20,
      lifecycle: 'current',
      routeReadiness: {
        healthState: 'healthy',
        creditStatus: 'has_credits',
        minimalChatStatus: 'verified',
      },
    });

    expect(k26_broke.score).toBe(0);
    expect(k20_healthy.score).toBeGreaterThan(0);
    // K2.6's failure reason is mandatory — must be 'newer_model_no_credit'-shaped
    expect(k26_broke.reason).toBe('route_no_credits');
    expect(k26_broke.status).toBe('current_but_no_credit');
  });
});
