// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * dry-run-execution-guard.test.ts — SM-R2-CORRECTIVE §15
 *
 * Tests for the global dry-run guardrail module.
 * Covers: detection paths, edge cases, false negatives.
 */

import { describe, it, expect } from 'vitest';
import {
  detectDryRun,
  isDryRunRequested,
  buildDryRunIntercepted,
} from '../dry-run-execution-guard';
import type { ChatRequest } from '@/types';

type DryRunRequest = ChatRequest & {
  dryRun?: boolean;
  ailin_metadata?: Record<string, unknown>;
  eval?: { dryRun?: boolean; planOnly?: boolean };
};

const BASE_REQUEST: DryRunRequest = {
  messages: [{ role: 'user', content: 'test' }],
};

describe('detectDryRun', () => {
  it('returns { detected: false } when no dryRun signal is present', () => {
    const result = detectDryRun(BASE_REQUEST);
    expect(result.detected).toBe(false);
  });

  it('detects top-level dryRun=true (path: request.dryRun)', () => {
    const req: DryRunRequest = { ...BASE_REQUEST, dryRun: true };
    const result = detectDryRun(req);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.path).toBe('request.dryRun');
    }
  });

  it('does NOT detect top-level dryRun=false', () => {
    const req: DryRunRequest = { ...BASE_REQUEST, dryRun: false };
    const result = detectDryRun(req);
    expect(result.detected).toBe(false);
  });

  it('detects ailin_metadata.dryRun=true (path: ailin_metadata.dryRun)', () => {
    const req: DryRunRequest = { ...BASE_REQUEST, ailin_metadata: { dryRun: true } };
    const result = detectDryRun(req);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.path).toBe('ailin_metadata.dryRun');
    }
  });

  it('detects eval.dryRun=true (legacy consensus path)', () => {
    const req: DryRunRequest = { ...BASE_REQUEST, eval: { dryRun: true } };
    const result = detectDryRun(req);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.path).toBe('eval.dryRun');
    }
  });

  it('detects eval.planOnly=true (alias)', () => {
    const req: DryRunRequest = { ...BASE_REQUEST, eval: { planOnly: true } };
    const result = detectDryRun(req);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.path).toBe('eval.planOnly');
    }
  });

  it('top-level dryRun has priority over ailin_metadata.dryRun', () => {
    const req: DryRunRequest = {
      ...BASE_REQUEST,
      dryRun: true,
      ailin_metadata: { dryRun: true },
    };
    const result = detectDryRun(req);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.path).toBe('request.dryRun');
    }
  });

  it('does NOT detect when ailin_metadata.dryRun is a non-boolean truthy value', () => {
    // Only strict true is accepted
    const req: DryRunRequest = {
      ...BASE_REQUEST,
      ailin_metadata: { dryRun: 'true' },
    };
    const result = detectDryRun(req);
    // 'true' !== true
    expect(result.detected).toBe(false);
  });
});

describe('isDryRunRequested', () => {
  it('returns false for plain request', () => {
    expect(isDryRunRequested(BASE_REQUEST)).toBe(false);
  });

  it('returns true for top-level dryRun=true', () => {
    expect(isDryRunRequested({ ...BASE_REQUEST, dryRun: true })).toBe(true);
  });

  it('returns true for eval.dryRun=true', () => {
    expect(isDryRunRequested({ ...BASE_REQUEST, eval: { dryRun: true } })).toBe(true);
  });
});

describe('buildDryRunIntercepted', () => {
  it('builds a DryRunGuardResult with correct fields', () => {
    const result = buildDryRunIntercepted('consensus', 'cold-start-policy', 'request.dryRun');
    expect(result.intercepted).toBe(true);
    expect(result.strategyName).toBe('consensus');
    expect(result.selectionSource).toBe('cold-start-policy');
    expect(result.providerCallExecuted).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.detectionPath).toBe('request.dryRun');
  });

  it('always has costUsd=0 and providerCallExecuted=false', () => {
    const result = buildDryRunIntercepted('single', 'heuristic', 'eval.dryRun');
    // Immutable invariants
    expect(result.costUsd).toBe(0);
    expect(result.providerCallExecuted).toBe(false);
  });

  it('supports all strategy names', () => {
    const strategies = ['single', 'consensus', 'cost-cascade', 'debate', 'quality-multipass'];
    for (const s of strategies) {
      const r = buildDryRunIntercepted(s, 'cold-start-policy', 'request.dryRun');
      expect(r.strategyName).toBe(s);
    }
  });
});
