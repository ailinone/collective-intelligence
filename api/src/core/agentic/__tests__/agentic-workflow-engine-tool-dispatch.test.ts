// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for the single-decision-point tool-execution refactor
 * in agentic-workflow-engine.ts's `executeToolStep()`.
 *
 * BEFORE this change, `executeToolStep` dynamically imported
 * advanced-tool-execution-service.ts's executors directly and switched on
 * `tool.name` by hand — a call-site PARALLEL to chat-request-processor.ts's
 * `executeRealTool`, base-strategy.ts's `executeModelWithTools` and
 * strategy-tool-executor.ts's `executeToolForStrategy`, none of which it went
 * through, and with no `safeForStrategies` check of its own. It was only
 * ever safe in practice because `POST /v1/workflows/execute` gates the whole
 * request behind `workflowRequiresPlatformAdmin()` (this same file) whenever
 * a `tool_call` step names a tool outside the tenant-safe set — a route-level
 * gate the engine itself has no visibility into.
 *
 * AFTER this change, `executeToolStep` dispatches through
 * `toolRegistry.executeForStrategy()` — the SAME shared gate
 * strategy-tool-executor.ts already uses — so the safety check now lives
 * inside the registry itself, not in whichever caller remembered to ask
 * first.
 *
 * These tests exercise the REAL `AgenticWorkflowEngine.execute()` end to
 * end, with fake tool registrations (mirroring the real names and
 * `safeForStrategies` values chat-request-processor.ts's
 * registerToolsInRegistry() uses in production) so the assertions don't
 * depend on the real filesystem-mutating executors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticWorkflowEngine, type WorkflowDefinition } from '../agentic-workflow-engine';
import { toolRegistry } from '@/core/tools/tool-registry';
import { logger } from '@/utils/logger';

vi.mock('@/database/client', () => ({
  prisma: { $executeRaw: vi.fn().mockResolvedValue(undefined) },
}));

// Every tool name executeToolStep's OLD hardcoded switch dispatched
// directly, one case per entry — see the removed switch in
// agentic-workflow-engine.ts's git history. All nine are registered
// `safeForStrategies: true` in production (chat-request-processor.ts);
// `delete_file`, the tenth case, is covered separately below because it is
// registered `safeForStrategies: false`.
const FORMERLY_SWITCHED_SAFE_TOOLS = [
  'extract_function',
  'rename_symbol',
  'extract_variable',
  'heal_file',
  'generate_tests',
  'detect_errors',
  'validate_code',
  'file_search',
  'explore_codebase',
] as const;

function makeWorkflow(
  toolName: string,
  parameters: Record<string, unknown> = { filePath: 'a.ts' }
): WorkflowDefinition {
  return {
    id: `wf_${toolName}`,
    name: 'Test workflow',
    description: 'test workflow',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        name: 'call_tool',
        type: 'tool_call',
        config: {
          tools: [{ name: toolName, description: 'test tool', parameters }],
          maxRetries: 1, // avoid the exponential-backoff wait on the failure-path tests
        },
      },
    ],
  };
}

describe('agentic-workflow-engine executeToolStep — single decision point', () => {
  let engine: AgenticWorkflowEngine;

  beforeEach(() => {
    engine = new AgenticWorkflowEngine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('(a) every tool the old switch dispatched directly still works via the workflow (platform-admin path)', () => {
    it.each(FORMERLY_SWITCHED_SAFE_TOOLS)(
      '%s dispatches through the shared tool registry and succeeds',
      async (toolName) => {
        const handler = vi.fn(async (args: Record<string, unknown>, toolCallId: string) => ({
          tool_call_id: toolCallId,
          success: true,
          output: `${toolName}-ok`,
          metadata: { received: args },
        }));

        toolRegistry.register({
          name: toolName,
          description: 'test',
          category: 'code',
          safeForStrategies: true, // matches the real registration in chat-request-processor.ts
          handler,
        });

        const result = await engine.execute({
          workflow: makeWorkflow(toolName, { filePath: 'a.ts' }),
          organizationId: 'org-1',
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0]).toEqual({ filePath: 'a.ts' });
        expect(handler.mock.calls[0][2]).toMatchObject({ organizationId: 'org-1' });

        expect(result.status).toBe('completed');
        expect(result.steps[0].status).toBe('success');
        expect(result.steps[0].output).toMatchObject({
          toolName,
          success: true,
          output: `${toolName}-ok`,
        });
      }
    );
  });

  describe('(b) a tool the central registry marks unsafe for strategies is refused, even reached via the admin-gated workflow route', () => {
    it('delete_file (safeForStrategies:false in production) is refused and its handler never runs', async () => {
      const handler = vi.fn(async (_args: Record<string, unknown>, toolCallId: string) => ({
        tool_call_id: toolCallId,
        success: true,
        output: 'deleted',
      }));

      toolRegistry.register({
        name: 'delete_file',
        description: 'Delete a file',
        category: 'file',
        safeForStrategies: false, // mirrors chat-request-processor.ts's real registration
        handler,
      });

      const result = await engine.execute({
        workflow: makeWorkflow('delete_file'),
        organizationId: 'org-1',
      });

      expect(handler).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[0].error).toMatch(/not permitted within strategy execution/i);
    });
  });

  describe('(c) fail-closed for a tool name with no registry entry at all', () => {
    it('an unregistered/unknown tool name is refused, not silently executed', async () => {
      const result = await engine.execute({
        workflow: makeWorkflow('totally_unregistered_dangerous_tool'),
        organizationId: 'org-1',
      });

      expect(result.status).toBe('failed');
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[0].error).toMatch(/not found in registry/i);
    });
  });

  describe('(d) structural protection: a hypothetical future call site with NO manual safety check of its own', () => {
    it('is still refused by toolRegistry.executeForStrategy() itself — the check lives there, not in the caller', async () => {
      const dangerousHandler = vi.fn(async (_args: Record<string, unknown>, toolCallId: string) => ({
        tool_call_id: toolCallId,
        success: true,
        output: 'should never run',
      }));

      toolRegistry.register({
        name: 'hypothetical_future_dangerous_tool',
        description: 'a tool a future call site forgets to gate',
        category: 'file',
        safeForStrategies: false,
        handler: dangerousHandler,
      });

      // Deliberately mimics the OLD executeToolStep: no
      // isBlockedFromStrategyAutoExecution check, no CHAT_AUTO_EXECUTE_BLOCKED_TOOLS
      // lookup, nothing — a caller that just trusts the tool name and calls the
      // shared entry point directly, the way any future call site reasonably might.
      const result = await toolRegistry.executeForStrategy(
        'hypothetical_future_dangerous_tool',
        {},
        'tool-call-1',
        { workingDirectory: process.cwd(), log: logger.child({ component: 'test' }) }
      );

      expect(dangerousHandler).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not permitted within strategy execution/i);
    });
  });
});
