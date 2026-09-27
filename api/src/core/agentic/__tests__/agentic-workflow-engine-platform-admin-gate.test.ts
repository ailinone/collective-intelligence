// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit coverage for `workflowRequiresPlatformAdmin()` — the scoped-gate
 * traversal that replaced the unconditional `requirePlatformAdmin()` on
 * `POST /v1/workflows/execute` (see ci-routes.ts and the doc comment on the
 * function itself). These tests exercise the pure traversal function
 * directly against the REAL tool-registry.ts (isAutoRecommendable,
 * CHAT_AUTO_EXECUTE_BLOCKED_TOOLS, toolRegistry) — no Fastify, no mocks —
 * focused on the fail-closed edge cases and the whitelist/blocklist
 * precedence that the route-level test
 * (routes/collective-intelligence/__tests__/workflow-execute-admin-gate.test.ts)
 * doesn't drill into.
 */
import { describe, expect, it } from 'vitest';
import { workflowRequiresPlatformAdmin } from '../agentic-workflow-engine';
import { toolRegistry } from '@/core/tools/tool-registry';

// A genuinely auto-recommendable, non-blocklisted tool (category `web`).
toolRegistry.register({
  name: 'unit_test_safe_web_tool',
  description: 'safe',
  category: 'web',
  safeForStrategies: true,
  handler: async (_args, toolCallId) => ({ tool_call_id: toolCallId, success: true, output: '' }),
});

// `analyze_image` is registered (in production, chat-request-processor.ts)
// with category `image`, which IS one of AUTO_RECOMMENDABLE_CATEGORIES — yet
// it is also a real entry in CHAT_AUTO_EXECUTE_BLOCKED_TOOLS. Re-register it
// the same way here (this test file's toolRegistry is isolated from
// production's) so the test proves rule (b) overrides rule (a) even when
// `isAutoRecommendable(reg)` alone would admit the tool, exactly as
// `isBlockedFromStrategyAutoExecution` documents for the vision tools.
toolRegistry.register({
  name: 'analyze_image',
  description: 'Analyze image',
  category: 'image',
  safeForStrategies: true,
  handler: async (_args, toolCallId) => ({ tool_call_id: toolCallId, success: true, output: '' }),
});

function toolCallStep(id: string, toolName: string) {
  return {
    id,
    name: id,
    type: 'tool_call',
    config: { tools: [{ name: toolName, description: 't', parameters: {} }] },
  };
}

describe('workflowRequiresPlatformAdmin', () => {
  it('does not require admin for an llm_call-only workflow', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [{ id: 's1', name: 's1', type: 'llm_call', config: { prompt: 'hi' } }],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(false);
  });

  it('does not require admin for a workflow with no steps', () => {
    expect(
      workflowRequiresPlatformAdmin({ id: 'wf', name: 'wf', description: '', version: '1', steps: [] })
    ).toBe(false);
  });

  it('does not require admin for a tool_call naming an auto-recommendable, non-blocklisted tool', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [toolCallStep('s1', 'unit_test_safe_web_tool')],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(false);
  });

  it('requires admin for a tool_call naming a blocklisted tool (CHAT_AUTO_EXECUTE_BLOCKED_TOOLS)', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [toolCallStep('s1', 'delete_file')],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it('requires admin when the blocklist wins even though the category would be auto-recommendable', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [toolCallStep('s1', 'analyze_image')],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it('requires admin for a tool_call naming an unregistered/unknown tool (fail closed)', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [toolCallStep('s1', 'some_tool_nobody_registered')],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it.each([
    ['parallel' as const],
    ['loop' as const],
    ['sub_workflow' as const],
  ])('requires admin for a dangerous tool_call nested inside a %s step', (compositeType) => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [
        {
          id: 'outer',
          name: 'outer',
          type: compositeType,
          config: { steps: [toolCallStep('inner', 'delete_file')] },
        },
      ],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it('requires admin for a dangerous tool_call nested several composite levels deep', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [
        {
          id: 'l1',
          name: 'l1',
          type: 'parallel',
          config: {
            steps: [
              {
                id: 'l2',
                name: 'l2',
                type: 'loop',
                config: {
                  steps: [
                    {
                      id: 'l3',
                      name: 'l3',
                      type: 'sub_workflow',
                      config: { steps: [toolCallStep('inner', 'delete_file')] },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it('does not require admin for safe steps nested inside composite steps', () => {
    const workflow = {
      id: 'wf',
      name: 'wf',
      description: '',
      version: '1.0.0',
      steps: [
        {
          id: 'outer',
          name: 'outer',
          type: 'parallel',
          config: {
            steps: [
              { id: 'a', name: 'a', type: 'llm_call', config: { prompt: 'x' } },
              toolCallStep('b', 'unit_test_safe_web_tool'),
            ],
          },
        },
      ],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(false);
  });

  // ── Fail-closed on malformed/unparseable input ──────────────────────────

  it('requires admin for a null workflow', () => {
    expect(workflowRequiresPlatformAdmin(null)).toBe(true);
  });

  it('requires admin for a non-object workflow', () => {
    expect(workflowRequiresPlatformAdmin('not a workflow')).toBe(true);
  });

  it('requires admin when `steps` is missing', () => {
    expect(workflowRequiresPlatformAdmin({ id: 'wf' })).toBe(true);
  });

  it('requires admin when `steps` is not an array', () => {
    expect(workflowRequiresPlatformAdmin({ id: 'wf', steps: 'nope' })).toBe(true);
  });

  it('requires admin for a non-object step', () => {
    expect(workflowRequiresPlatformAdmin({ id: 'wf', steps: [null] })).toBe(true);
  });

  it('requires admin when a step has no string `type`', () => {
    expect(workflowRequiresPlatformAdmin({ id: 'wf', steps: [{ id: 's1', config: {} }] })).toBe(
      true
    );
  });

  it('requires admin for a tool_call step with an empty tools array', () => {
    const workflow = {
      id: 'wf',
      steps: [{ id: 's1', type: 'tool_call', config: { tools: [] } }],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it('requires admin for a tool_call step with no config', () => {
    expect(
      workflowRequiresPlatformAdmin({ id: 'wf', steps: [{ id: 's1', type: 'tool_call' }] })
    ).toBe(true);
  });

  it('requires admin for a tool entry with a non-string/missing name', () => {
    const workflow = {
      id: 'wf',
      steps: [{ id: 's1', type: 'tool_call', config: { tools: [{ description: 'no name' }] } }],
    };
    expect(workflowRequiresPlatformAdmin(workflow)).toBe(true);
  });

  it('requires admin for pathologically deep nesting', () => {
    let innermost: Record<string, unknown> = toolCallStep('inner', 'unit_test_safe_web_tool');
    for (let i = 0; i < 100; i++) {
      innermost = { id: `l${i}`, name: `l${i}`, type: 'parallel', config: { steps: [innermost] } };
    }
    expect(workflowRequiresPlatformAdmin({ id: 'wf', steps: [innermost] })).toBe(true);
  });
});
