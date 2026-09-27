// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for the agentic-workflow tool sandbox fix and its
 * scoped-admin-gate follow-up.
 *
 * `POST /v1/workflows/execute` dispatches `tool_call` steps (delete_file,
 * file_search, heal_file, ...) through agentic-workflow-engine.ts's
 * executeToolStep(). Before the original fix (ci#652):
 *   1. the route only required "authenticated, non-free-tier", so any tenant
 *      API key could run those filesystem tools; and
 *   2. executeToolStep() handed the tools `process.cwd()` as their sandbox
 *      instead of the operator-configured TOOLS_BASE_DIR root.
 *
 * ci#652 fixed both, but gated by requiring platform admin for the ENTIRE
 * route. That broke the documented public contract
 * (docs/reference/endpoints/*.md, openapi-spec.json): ordinary tenants are
 * documented to call this route with `llm_call`-only workflows. The follow-up
 * fix replaces the unconditional gate with `workflowRequiresPlatformAdmin()`
 * (agentic-workflow-engine.ts), applied to the RESOLVED workflow in the
 * route handler: only a workflow that reaches a `tool_call` naming a tool
 * outside the triage auto-recommendable set, or inside
 * `CHAT_AUTO_EXECUTE_BLOCKED_TOOLS`, requires a platform admin — at any
 * nesting depth (parallel/loop/sub_workflow included).
 *
 * The route tests use the REAL registerCollectiveIntelligenceRoutes(), the
 * REAL isPlatformAdminRequest()/workflowRequiresPlatformAdmin(), and the REAL
 * tool-registry.ts; only `authenticate` (needs JWT/DB) and the workflow
 * engine singleton's `execute()` (so we assert admission without needing a
 * real workflow run) are stubbed. A regression that drops the gate, or that
 * widens/narrows which tools count as "tenant-safe", fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import path from 'node:path';

const { mockSecurityConfig, fakeEngine, capturedToolContexts } = vi.hoisted(() => ({
  mockSecurityConfig: { platformOrganizationId: null as string | null },
  fakeEngine: {
    execute: vi.fn(async () => ({
      workflowId: 'wf_test',
      status: 'completed',
      finalOutput: null,
      totalDuration: 0,
      totalCost: 0,
      steps: [],
    })),
    getWorkflow: vi.fn(),
    registerWorkflow: vi.fn(),
    createWorkflowFromTask: vi.fn(),
  },
  capturedToolContexts: [] as Array<{ workingDirectory: string }>,
}));

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      security: {
        ...actual.config.security,
        get platformOrganizationId() {
          return mockSecurityConfig.platformOrganizationId;
        },
      },
    },
  };
});

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn(async () => {}),
}));

vi.mock('@/core/agentic/agentic-workflow-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/agentic/agentic-workflow-engine')>();
  return { ...actual, getAgenticWorkflowEngine: () => fakeEngine };
});

vi.mock('@/services/advanced-tool-execution-service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/advanced-tool-execution-service')>();
  return {
    ...actual,
    executeDeleteFileTool: vi.fn(
      async (_args: unknown, toolCallId: string, ctx: { workingDirectory: string }) => {
        capturedToolContexts.push(ctx);
        return { tool_call_id: toolCallId, success: true, output: 'stubbed' };
      }
    ),
  };
});

import { registerCollectiveIntelligenceRoutes } from '../ci-routes';
import { AgenticWorkflowEngine } from '@/core/agentic/agentic-workflow-engine';
import { toolRegistry } from '@/core/tools/tool-registry';

const PLATFORM_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ORG_ID = '22222222-2222-2222-2222-222222222222';

// Real (unmocked) tool-registry.ts registration for a tool that IS
// auto-recommendable and NOT blocklisted, so `workflowRequiresPlatformAdmin`
// admits it via rule (a). Category `web` is one of
// AUTO_RECOMMENDABLE_CATEGORIES; registered directly (bypassing
// registerToolsInRegistry()) so this test doesn't depend on which real
// production tool ends up in that category.
toolRegistry.register({
  name: 'test_safe_web_tool',
  description: 'Test-only tool used to exercise the auto-recommendable path',
  category: 'web',
  safeForStrategies: true,
  handler: async (_args, toolCallId) => ({
    tool_call_id: toolCallId,
    success: true,
    output: 'stubbed',
  }),
});

const TOOL_WORKFLOW = {
  id: 'wf-delete',
  name: 'delete a file',
  description: 'tool_call step reaching delete_file',
  version: '1.0.0',
  steps: [
    {
      id: 'step-1',
      name: 'delete',
      type: 'tool_call',
      config: {
        tools: [
          { name: 'delete_file', description: 'Delete a file', parameters: { filePath: 'x.txt' } },
        ],
      },
    },
  ],
};

const LLM_ONLY_WORKFLOW = {
  id: 'wf-llm-only',
  name: 'summarize',
  description: 'llm_call-only workflow — the documented public contract',
  version: '1.0.0',
  steps: [
    {
      id: 'step-1',
      name: 'summarize',
      type: 'llm_call',
      config: { model: 'auto', prompt: 'Summarize: {{input}}' },
    },
    {
      id: 'step-2',
      name: 'branch',
      type: 'condition',
      config: { condition: 'true' },
    },
  ],
};

const SAFE_TOOL_WORKFLOW = {
  id: 'wf-safe-tool',
  name: 'safe tool workflow',
  description: 'tool_call step reaching an auto-recommendable, non-blocklisted tool',
  version: '1.0.0',
  steps: [
    {
      id: 'step-1',
      name: 'search-the-web',
      type: 'tool_call',
      config: {
        tools: [{ name: 'test_safe_web_tool', description: 'safe', parameters: {} }],
      },
    },
  ],
};

function nestedDangerousToolWorkflow(compositeType: 'parallel' | 'loop' | 'sub_workflow') {
  return {
    id: `wf-nested-${compositeType}`,
    name: `nested ${compositeType}`,
    description: `delete_file tool_call nested inside a ${compositeType} step`,
    version: '1.0.0',
    steps: [
      {
        id: 'outer',
        name: 'outer',
        type: compositeType,
        config: {
          items: compositeType === 'loop' ? 'someItems' : undefined,
          steps: [
            {
              id: 'inner',
              name: 'delete',
              type: 'tool_call',
              config: {
                tools: [
                  {
                    name: 'delete_file',
                    description: 'Delete a file',
                    parameters: { filePath: 'x.txt' },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

async function buildServer(user: { userId: string; organizationId: string; roles: string[] }) {
  const server = Fastify({ logger: false });
  server.decorate('authenticate', async (request: FastifyRequest) => {
    const req = request as unknown as Record<string, unknown>;
    req.user = user;
    req.organizationId = user.organizationId;
    req.userId = user.userId;
  });
  await registerCollectiveIntelligenceRoutes(server);
  await server.ready();
  return server;
}

describe('POST /v1/workflows/execute — platform-admin gate', () => {
  let server: FastifyInstance | undefined;

  beforeEach(() => {
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    fakeEngine.execute.mockClear();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('refuses a tenant admin/owner with 403 and never runs the workflow', async () => {
    server = await buildServer({
      userId: 'tenant-owner',
      organizationId: TENANT_ORG_ID,
      roles: ['owner', 'admin'],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/workflows/execute',
      payload: { workflow: TOOL_WORKFLOW },
    });

    expect(res.statusCode).toBe(403);
    expect(fakeEngine.execute).not.toHaveBeenCalled();
  });

  it('fails closed (403) when PLATFORM_ORGANIZATION_ID is not configured', async () => {
    mockSecurityConfig.platformOrganizationId = null;
    server = await buildServer({
      userId: 'someone',
      organizationId: TENANT_ORG_ID,
      roles: ['owner'],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/workflows/execute',
      payload: { workflow: TOOL_WORKFLOW },
    });

    expect(res.statusCode).toBe(403);
    expect(fakeEngine.execute).not.toHaveBeenCalled();
  });

  it('lets a platform admin through to the engine', async () => {
    server = await buildServer({
      userId: 'platform-admin',
      organizationId: PLATFORM_ORG_ID,
      roles: ['admin'],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/workflows/execute',
      payload: { workflow: TOOL_WORKFLOW },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('lets an ordinary tenant run an llm_call-only workflow (documented public contract)', async () => {
    server = await buildServer({
      userId: 'tenant-owner',
      organizationId: TENANT_ORG_ID,
      roles: ['owner'],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/workflows/execute',
      payload: { workflow: LLM_ONLY_WORKFLOW },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('lets an ordinary tenant run a tool_call workflow naming an auto-recommendable, non-blocklisted tool', async () => {
    server = await buildServer({
      userId: 'tenant-owner',
      organizationId: TENANT_ORG_ID,
      roles: ['owner'],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/workflows/execute',
      payload: { workflow: SAFE_TOOL_WORKFLOW },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeEngine.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['parallel', 'loop', 'sub_workflow'] as const)(
    'refuses an ordinary tenant (403) when a dangerous tool_call is nested inside a %s step',
    async (compositeType) => {
      server = await buildServer({
        userId: 'tenant-owner',
        organizationId: TENANT_ORG_ID,
        roles: ['owner', 'admin'],
      });

      const res = await server.inject({
        method: 'POST',
        url: '/v1/workflows/execute',
        payload: { workflow: nestedDangerousToolWorkflow(compositeType) },
      });

      expect(res.statusCode).toBe(403);
      expect(fakeEngine.execute).not.toHaveBeenCalled();
    }
  );

  it('lets a platform admin run the same nested dangerous tool_call workflow', async () => {
    server = await buildServer({
      userId: 'platform-admin',
      organizationId: PLATFORM_ORG_ID,
      roles: ['admin'],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/workflows/execute',
      payload: { workflow: nestedDangerousToolWorkflow('sub_workflow') },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeEngine.execute).toHaveBeenCalledTimes(1);
  });
});

describe('AgenticWorkflowEngine tool_call steps — sandbox root', () => {
  const originalBaseDir = process.env.TOOLS_BASE_DIR;

  afterEach(() => {
    if (originalBaseDir === undefined) delete process.env.TOOLS_BASE_DIR;
    else process.env.TOOLS_BASE_DIR = originalBaseDir;
    capturedToolContexts.length = 0;
  });

  it('runs tools under TOOLS_BASE_DIR, not process.cwd()', async () => {
    const sandbox = path.resolve(process.cwd(), '..', 'tools-sandbox-under-test');
    process.env.TOOLS_BASE_DIR = sandbox;

    const engine = new AgenticWorkflowEngine() as unknown as {
      executeToolStep: (step: unknown, context: unknown) => Promise<unknown>;
    };
    await engine.executeToolStep(TOOL_WORKFLOW.steps[0], {
      workflowId: 'wf_test',
      variables: {},
      stepResults: new Map(),
      startTime: Date.now(),
      stepsExecuted: 0,
      maxSteps: 10,
      maxDuration: 60_000,
      organizationId: TENANT_ORG_ID,
    });

    expect(capturedToolContexts).toHaveLength(1);
    expect(capturedToolContexts[0]!.workingDirectory).toBe(sandbox);
    expect(capturedToolContexts[0]!.workingDirectory).not.toBe(process.cwd());
  });
});
