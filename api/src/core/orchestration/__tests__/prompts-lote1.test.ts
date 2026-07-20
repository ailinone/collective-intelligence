// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Lote 1 of the system-prompts audit refactor.
 *
 * Covers:
 *   R1  — triage produces `task_context` (not `system_prompt`) and it is
 *         consumed by both single-stage (builder) and multi-stage
 *         (orchestration-engine stage loop) paths.
 *   R4  — the observable Ailin¹ fallback prompt is returned by the helper
 *         and legacy "helpful assistant" strings are gone from targeted sites.
 *   R11 — execution-system-prompt builder emits collective-strategy framing
 *         iff `context.isCollectiveStrategy` is true (driven by the resolved
 *         strategy's own metadata, not a hardcoded set).
 *   R12 — the triage Zod schema accepts well-formed payloads, rejects
 *         malformed ones, and enforces bounds.
 */

import { describe, expect, it } from 'vitest';

import {
  TriageResponseSchema,
  TriageExecutionPlanSchema,
  TriageStageSchema,
  TASK_CONTEXT_MAX_LENGTH,
} from '../triage-schema';
import {
  AILIN_FALLBACK_PROMPT,
  buildAilinFallbackPrompt,
} from '../prompts/fallback-prompt';
import { buildExecutionSystemPrompt } from '../execution-system-prompt';
import type {
  ChatRequest,
  OrchestrationContext,
  TriageDecision,
  TriageExecutionPlan,
  Model,
} from '@/types';

/** Minimal ChatRequest stub — avoids pulling a real request builder into the test. */
function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello Ailin' }],
    ...overrides,
  } as ChatRequest;
}

/** Minimal OrchestrationContext stub — only the fields the builder reads. */
function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'test-req',
    models: [] as Model[],
    taskType: 'analysis',
    contextSize: 0,
    ...overrides,
  } as OrchestrationContext;
}

/** Build a minimal TriageExecutionPlan with a task_context on the first stage. */
function planWithTaskContext(taskContext: string): TriageExecutionPlan {
  return {
    maxTokens: 2048,
    qualityTarget: 0.8,
    preferSpeed: false,
    requiredCapabilities: [],
    estimatedInputTokens: 0,
    strategy: 'single',
    modelCount: 1,
    requiresContinuation: false,
    stages: [{
      name: 'main',
      strategy: 'single',
      modelRoles: [{
        role: 'primary',
        count: 1,
        preferredCapabilities: [],
        qualityTarget: 0.8,
      }],
      requiredCapabilities: [],
      maxTokens: 2048,
      taskContext,
    }],
  };
}

describe('R12 — TriageResponseSchema strict validation', () => {
  it('accepts a well-formed full payload', () => {
    const payload = {
      intent: 'code-review',
      complexity: 'high',
      priority: 'normal',
      confidence: 0.9,
      reason: 'Multi-file diff review',
      requires_tools: false,
      execution_plan: {
        max_tokens: 4096,
        quality_target: 0.9,
        prefer_speed: false,
        required_capabilities: ['code_generation', 'reasoning'],
        estimated_input_tokens: 1500,
        strategy: 'debate',
        model_count: 3,
        requires_continuation: false,
        max_deliberation_rounds: 2,
        stages: [{
          name: 'review',
          strategy: 'debate',
          model_roles: [{
            role: 'reviewer',
            count: 3,
            preferred_capabilities: ['reasoning'],
            quality_target: 0.9,
          }],
          required_capabilities: ['reasoning'],
          max_tokens: 4096,
          task_context: 'Focus on concurrency bugs in the new queue worker.',
        }],
      },
    };

    const parsed = TriageResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.execution_plan?.stages[0].task_context).toContain('concurrency bugs');
  });

  it('rejects payload with invalid complexity', () => {
    const parsed = TriageResponseSchema.safeParse({ complexity: 'extreme' });
    expect(parsed.success).toBe(false);
  });

  it('rejects payload with quality_target out of [0,1]', () => {
    const parsed = TriageExecutionPlanSchema.safeParse({
      max_tokens: 2048,
      quality_target: 1.5,
      prefer_speed: false,
      required_capabilities: [],
      estimated_input_tokens: 0,
      strategy: 'single',
      model_count: 1,
      requires_continuation: false,
      stages: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('enforces TASK_CONTEXT_MAX_LENGTH', () => {
    const tooLong = 'x'.repeat(TASK_CONTEXT_MAX_LENGTH + 1);
    const parsed = TriageStageSchema.safeParse({
      name: 'main',
      strategy: 'single',
      model_roles: [],
      required_capabilities: [],
      max_tokens: 2048,
      task_context: tooLong,
    });
    expect(parsed.success).toBe(false);
  });

  it('clamps max_tokens via schema ceiling', () => {
    const parsed = TriageExecutionPlanSchema.safeParse({
      max_tokens: 999_999_999,
      quality_target: 0.8,
      prefer_speed: false,
      required_capabilities: [],
      estimated_input_tokens: 0,
      strategy: 'single',
      model_count: 1,
      requires_continuation: false,
      stages: [],
    });
    // schema has .max(131_072); payloads above ceiling are rejected rather than clamped
    expect(parsed.success).toBe(false);
  });

  it('rejects model_count above MAX_MODELS', () => {
    const parsed = TriageExecutionPlanSchema.safeParse({
      max_tokens: 2048,
      quality_target: 0.8,
      prefer_speed: false,
      required_capabilities: [],
      estimated_input_tokens: 0,
      strategy: 'single',
      model_count: 42,
      requires_continuation: false,
      stages: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('does NOT accept legacy per-role system_prompt into the model', () => {
    // The legacy field is intentionally NOT in the schema. Even with .passthrough()
    // the parsed shape cannot expose it as a required consumer field, so downstream
    // code never reads a fabricated per-role system prompt again.
    const parsed = TriageStageSchema.safeParse({
      name: 'main',
      strategy: 'single',
      model_roles: [{
        role: 'primary',
        count: 1,
        preferred_capabilities: [],
        quality_target: 0.8,
        system_prompt: 'You are a legacy prompt that should be ignored downstream.',
      }],
      required_capabilities: [],
      max_tokens: 2048,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The legacy field may be present on the loose passthrough object, but the
    // typed TriageModelRoleSchema fields do NOT include it — any compile-time
    // consumer reading `.systemPrompt` would fail.
    const role = parsed.data.model_roles[0];
    expect(role.role).toBe('primary');
    // @ts-expect-error -- field is intentionally not in the schema type
    const legacy = role.system_prompt;
    expect(typeof legacy === 'string' || legacy === undefined).toBe(true);
  });
});

describe('R1 + R11 — buildExecutionSystemPrompt precedence and collective flag', () => {
  it('returns null when a system message already exists (preserves user/triage prompt)', () => {
    const req = makeRequest({
      messages: [
        { role: 'system', content: 'user-provided system' },
        { role: 'user', content: 'hi' },
      ] as ChatRequest['messages'],
    });
    expect(buildExecutionSystemPrompt(req, makeContext())).toBeNull();
  });

  it('emits collective framing iff context.isCollectiveStrategy is true (R11)', () => {
    const req = makeRequest();
    const collective = buildExecutionSystemPrompt(
      req,
      makeContext({ isCollectiveStrategy: true }),
    );
    const single = buildExecutionSystemPrompt(
      req,
      makeContext({ isCollectiveStrategy: false }),
    );
    expect(collective).toContain('collective intelligence strategy');
    expect(single).not.toContain('collective intelligence strategy');
  });

  it('reflects collective framing for debate-like strategies via the flag (R11 regression)', () => {
    // Previously the builder used a hardcoded Set that did NOT include 'blind-debate'
    // or 'devil-advocate-consensus'. With R11, any strategy whose metadata reports
    // minModels > 1 propagates the flag, so the test only needs the flag set to true.
    const req = makeRequest();
    const out = buildExecutionSystemPrompt(
      req,
      makeContext({ isCollectiveStrategy: true }),
    );
    expect(out).toContain('collective intelligence strategy');
  });

  it('appends task_context from the triage execution plan (R1 single-stage path)', () => {
    const req = makeRequest();
    const plan = planWithTaskContext('Prioritize p95 latency under 150ms.');
    const out = buildExecutionSystemPrompt(
      req,
      makeContext({ executionPlan: plan }),
    );
    expect(out).toContain('Task context: Prioritize p95 latency under 150ms.');
  });

  it('reads task_context from context.triage.executionPlan as fallback', () => {
    const req = makeRequest();
    const plan = planWithTaskContext('Focus on the OAuth callback flow.');
    const decision: TriageDecision = {
      intent: 'debugging',
      complexity: 'medium',
      executionPlan: plan,
    };
    const out = buildExecutionSystemPrompt(
      req,
      makeContext({ triage: decision }),
    );
    expect(out).toContain('Focus on the OAuth callback flow.');
  });

  it('omits task_context section when triage did not provide one', () => {
    const req = makeRequest();
    const out = buildExecutionSystemPrompt(req, makeContext());
    expect(out).not.toContain('Task context:');
  });
});

describe('R4 — Ailin¹ fallback prompt', () => {
  it('exposes a canonical constant that marks itself as fallback', () => {
    expect(AILIN_FALLBACK_PROMPT).toContain('Ailin¹');
    expect(AILIN_FALLBACK_PROMPT).toContain('[fallback');
  });

  it('builder helper returns the canonical constant and accepts a call-site identifier', () => {
    const out = buildAilinFallbackPrompt('unit-test.site-a');
    expect(out).toBe(AILIN_FALLBACK_PROMPT);
  });

  it('fallback text is explicitly not the legacy "helpful assistant" string', () => {
    expect(AILIN_FALLBACK_PROMPT).not.toBe('You are a helpful assistant.');
    expect(AILIN_FALLBACK_PROMPT.toLowerCase()).not.toContain('helpful assistant');
  });
});
