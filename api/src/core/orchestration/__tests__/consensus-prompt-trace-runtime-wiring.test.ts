// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-I3A §8 — Tests for runtime wiring of promptTrace in consensus dry-run.
 *
 * Proves:
 *   - When `eval.tracePromptPayload=true`, the dry-run plan ships
 *     `promptTrace[]`, `promptFingerprints`, `promptIssues`, and
 *     `promptIncludedInPlanFingerprint=true`.
 *   - When `tracePromptPayload=false` or absent, the plan does NOT
 *     contain these fields (legacy bit-exact behavior).
 *   - The trace surfaces NO raw prompt body (sanitization invariant).
 *   - Issues are reported honestly when a role has no selection.
 */
import { describe, it, expect } from 'vitest';
import { ConsensusPlanDryRunService } from '../strategies/consensus-plan-dry-run-service';
import {
  diversePool,
  makeCandidate,
  makeModel,
} from '../model-selection/__tests__/role-resolver.fixtures';
import type { ChatRequest } from '@/types';

function basePool() {
  return [
    ...diversePool().filter((c) => c.hasCredits).map((c) => c.model),
    makeCandidate({
      id: 'judge-candidate',
      model: makeModel({
        id: 'judge-candidate',
        provider: 'judge-prov',
        capabilities: ['chat', 'text_generation', 'json_mode', 'function_calling'] as never[],
        contextWindow: 64000,
        performance: { latencyMs: 500, throughput: 200, quality: 0.85, reliability: 0.93 },
        inputCostPer1k: 0.0001,
        outputCostPer1k: 0.0004,
      }),
    }).model,
  ];
}

function reqWith(overrides?: Partial<ChatRequest & { eval?: unknown }>): ChatRequest {
  return {
    model: 'auto',
    strategy: 'consensus',
    messages: [{ role: 'user', content: 'Probe task' }],
    max_tokens: 1500,
    max_cost: 0.5,
    ...overrides,
  } as ChatRequest;
}

describe('runtime wiring — promptTrace in consensus dry-run', () => {
  it('attaches promptTrace + promptFingerprints when tracePromptPayload=true', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error eval is additive
        eval: { tracePromptPayload: true, sanitizePromptTrace: true },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      promptTrace?: ReadonlyArray<unknown>;
      promptFingerprints?: { aggregate: string; perRole: ReadonlyArray<unknown>; includedInPlanFingerprint: boolean };
      promptIssues?: ReadonlyArray<unknown>;
      promptIncludedInPlanFingerprint?: boolean;
    };
    expect(ext.promptIncludedInPlanFingerprint).toBe(true);
    expect(ext.promptTrace).toBeDefined();
    expect(Array.isArray(ext.promptTrace)).toBe(true);
    expect(ext.promptFingerprints).toBeDefined();
    expect(typeof ext.promptFingerprints!.aggregate).toBe('string');
    expect(ext.promptFingerprints!.aggregate.length).toBeGreaterThan(20);  // sha256 hex
    expect(ext.promptFingerprints!.includedInPlanFingerprint).toBe(true);
  });

  it('does NOT attach promptTrace fields when flag is absent (legacy preserved)', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith(),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      promptTrace?: unknown;
      promptFingerprints?: unknown;
      promptIncludedInPlanFingerprint?: unknown;
    };
    expect(ext.promptTrace).toBeUndefined();
    expect(ext.promptFingerprints).toBeUndefined();
    expect(ext.promptIncludedInPlanFingerprint).toBeUndefined();
  });

  it('promptTrace entries cover participant/synthesizer/judge/fallback OR emit issues', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { tracePromptPayload: true },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      promptTrace?: ReadonlyArray<{ role: string }>;
      promptIssues?: ReadonlyArray<{ role: string; reason: string }>;
    };
    const expected = new Set(['participant', 'synthesizer', 'judge', 'fallbackSingle']);
    for (const role of expected) {
      const inTrace = ext.promptTrace?.some((t) => t.role === role);
      const inIssues = ext.promptIssues?.some((i) => i.role === role);
      expect(
        inTrace || inIssues,
        `role ${role} must appear in promptTrace OR promptIssues`,
      ).toBe(true);
    }
  });

  it('promptTrace section does NOT leak raw prompt body (sanitization invariant)', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { tracePromptPayload: true, sanitizePromptTrace: true },
        messages: [{ role: 'user', content: 'SECRET_PROMPT_TRACE_SHOULD_NOT_LEAK_HERE_X9Z' }],
      }),
      candidatePool: basePool(),
    });
    // Narrow check: serialize ONLY the promptTrace section, not the
    // whole plan. The planner's `taskProfile.userMessageExcerpt` is a
    // pre-existing surface (and out of scope for I3A) — what we own is
    // the promptTrace + promptFingerprints projection.
    const ext = plan as typeof plan & {
      promptTrace?: ReadonlyArray<unknown>;
      promptFingerprints?: unknown;
    };
    const traceSerialized = JSON.stringify({
      promptTrace: ext.promptTrace,
      promptFingerprints: ext.promptFingerprints,
    });
    expect(traceSerialized).not.toContain('SECRET_PROMPT_TRACE_SHOULD_NOT_LEAK_HERE_X9Z');
    // Bearer / api key spot-check.
    expect(traceSerialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(traceSerialized).not.toMatch(/api[_-]?key=/i);
  });

  it('promptFingerprints.perRole entries have stable shape (templateId + version + fingerprint)', async () => {
    const svc = new ConsensusPlanDryRunService();
    const plan = await svc.plan({
      chatRequest: reqWith({
        // @ts-expect-error
        eval: { tracePromptPayload: true },
      }),
      candidatePool: basePool(),
    });
    const ext = plan as typeof plan & {
      promptFingerprints?: {
        perRole: ReadonlyArray<{
          role: string;
          promptTemplateId: string;
          promptVersion: string | null;
          promptFingerprint: string;
        }>;
      };
    };
    expect(ext.promptFingerprints).toBeDefined();
    for (const r of ext.promptFingerprints!.perRole) {
      expect(typeof r.role).toBe('string');
      expect(typeof r.promptTemplateId).toBe('string');
      expect(r.promptTemplateId.length).toBeGreaterThan(0);
      expect(typeof r.promptFingerprint).toBe('string');
      expect(r.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);  // sha256 hex
    }
  });
});
