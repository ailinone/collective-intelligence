// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SECURITY regression (2026-09-24): `POST /v1/capabilities/mcp/execute`
 * (public in the gateway allowlist via `/v1/capabilities/{capability}/execute`,
 * guarded only by tenant auth) used to hand `body.tool` to
 * `toolRegistry.executeForStrategy()` after a bare `toolRegistry.has()` check.
 * `has()` is true for EVERY registered tool, not just MCP ones, so any tenant
 * API key could run the native `write_file` / `read_file` / `search_replace`
 * (all `safeForStrategies: true`) against `process.cwd()` of the API
 * container, and `MCP_CLIENT_ENABLED` was never consulted on this path.
 *
 * The invariant this file pins:
 *  - the route runs ONLY tools the MCP client itself registered
 *    (`mcpClientService.getConnectedServers()`), never a native tool, not even
 *    for a platform admin (they have `/v1/tools/*`);
 *  - with `MCP_CLIENT_ENABLED` off nothing executes, whatever is registered;
 *  - an MCP tool whose category may touch the API host (anything outside the
 *    registry's external-effect categories) needs a platform admin.
 *
 * Uses the REAL tool registry populated by the REAL
 * `registerToolsInRegistry()` (the same boot path production runs), with
 * `process.cwd()` pointed at a throwaway temp dir so a regression writes
 * there, never into the repo.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PLATFORM_ORG_ID = 'org-platform-mcp-scope-test';
const TENANT_ORG_ID = 'org-tenant-mcp-scope-test';

const { mockSecurityConfig } = vi.hoisted(() => ({
  mockSecurityConfig: { platformOrganizationId: null as string | null },
}));

// Same pattern as require-platform-admin.test.ts: `config` is frozen at
// runtime, so only `security.platformOrganizationId` is overridden, live.
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

// Keep the REAL `isPlatformAdminRequest` (the check under test); replace only
// `authenticate`, which would otherwise need a real JWT/DB round trip. The
// `x-test-principal` header picks who is calling.
vi.mock('@/middleware/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/middleware/auth-middleware')>();
  return {
    ...actual,
    authenticate: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
      const headers = request.headers as Record<string, string | undefined>;
      const isPlatform = headers['x-test-principal'] === 'platform-admin';
      const organizationId = isPlatform ? PLATFORM_ORG_ID : TENANT_ORG_ID;
      // A tenant's OWN admin: exactly the principal `requireRole('admin')`
      // would wrongly let through and `isPlatformAdminRequest` must not.
      request.user = { userId: 'user-mcp-scope-test', organizationId, roles: ['admin'] };
      request.organizationId = organizationId;
      request.userContext = {
        organizationId,
        userId: 'user-mcp-scope-test',
        requestId: 'req-mcp-scope-test',
      };
    }),
  };
});
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => vi.fn().mockResolvedValue(undefined),
}));

const FAKE_SERVER = 'fakesrv';
const MCP_WEB_TOOL = `mcp_${FAKE_SERVER}_lookup`; // external-effect category
const MCP_FILE_TOOL = `mcp_${FAKE_SERVER}_writer`; // may touch the host
const mcpHandlerCalls: string[] = [];

describe('POST /v1/capabilities/mcp/execute — tool scope (security regression)', () => {
  let server: FastifyInstance;
  let workDir: string;
  // Restored individually: `vi.restoreAllMocks()` would also strip the
  // module-level `vi.fn()` preHandler mocks above of their implementations,
  // leaving Fastify waiting forever on a hook that never resolves.
  const spies: Array<{ mockRestore: () => void }> = [];
  const savedMcpFlag = process.env.MCP_CLIENT_ENABLED;

  beforeAll(async () => {
    delete process.env.MCP_CLIENT_ENABLED;

    const { registerToolsInRegistry } = await import('@/services/chat-request-processor');
    const { toolRegistry } = await import('@/core/tools/tool-registry');
    registerToolsInRegistry();
    await vi.waitFor(() => {
      if (!toolRegistry.isInitialized()) throw new Error('tool registry not yet initialized');
    });

    const mcpHandler =
      (name: string) => async (args: Record<string, unknown>, toolCallId: string) => {
        mcpHandlerCalls.push(name);
        return {
          tool_call_id: toolCallId,
          success: true,
          output: `${name}:${JSON.stringify(args)}`,
        };
      };
    // Registered exactly as mcp-client-service.ts registers a discovered tool
    // whose operator opted it into strategies.
    toolRegistry.register({
      name: MCP_WEB_TOOL,
      description: 'fake MCP web lookup',
      category: 'web',
      safeForStrategies: true,
      autoRecommendable: false,
      handler: mcpHandler(MCP_WEB_TOOL),
    });
    toolRegistry.register({
      name: MCP_FILE_TOOL,
      description: 'fake MCP file writer',
      category: 'file',
      safeForStrategies: true,
      autoRecommendable: false,
      handler: mcpHandler(MCP_FILE_TOOL),
    });

    const { registerCapabilitiesRoutes } = await import('../capabilities-routes');
    server = Fastify();
    await registerCapabilitiesRoutes(server);
    await server.ready();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    if (savedMcpFlag === undefined) delete process.env.MCP_CLIENT_ENABLED;
    else process.env.MCP_CLIENT_ENABLED = savedMcpFlag;
  });

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'mcp-exec-scope-'));
    spies.push(vi.spyOn(process, 'cwd').mockReturnValue(workDir));
    mockSecurityConfig.platformOrganizationId = PLATFORM_ORG_ID;
    mcpHandlerCalls.length = 0;
    const { mcpClientService } = await import('@/core/mcp/mcp-client-service');
    spies.push(
      vi
        .spyOn(mcpClientService, 'getConnectedServers')
        .mockReturnValue([
          { name: FAKE_SERVER, tools: [MCP_WEB_TOOL, MCP_FILE_TOOL], connected: true },
        ])
    );
  });

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
    delete process.env.MCP_CLIENT_ENABLED;
    mockSecurityConfig.platformOrganizationId = null;
    rmSync(workDir, { recursive: true, force: true });
  });

  function execute(payload: Record<string, unknown>, principal = 'tenant-admin') {
    return server.inject({
      method: 'POST',
      url: '/v1/capabilities/mcp/execute',
      headers: { 'x-test-principal': principal },
      payload,
    });
  }

  describe('native (non-MCP) tools are never reachable through this route', () => {
    it.each([
      ['MCP_CLIENT_ENABLED off', undefined],
      ['MCP_CLIENT_ENABLED on', 'true'],
    ])('tenant cannot write_file into the API working directory (%s)', async (_label, flag) => {
      if (flag) process.env.MCP_CLIENT_ENABLED = flag;

      const response = await execute({
        tool: 'write_file',
        arguments: { file_path: 'pwned.txt', content: 'written by a tenant' },
      });

      expect(existsSync(join(workDir, 'pwned.txt')), response.body).toBe(false);
      expect(response.statusCode, response.body).not.toBe(200);
    });

    it('tenant cannot read_file from the API working directory', async () => {
      process.env.MCP_CLIENT_ENABLED = 'true';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workDir, 'secret.env'), 'JWT_SECRET=do-not-leak');

      const response = await execute({ tool: 'read_file', arguments: { file_path: 'secret.env' } });

      expect(response.statusCode, response.body).not.toBe(200);
      expect(response.body).not.toContain('do-not-leak');
    });

    it('not even a platform admin can run a native tool here (they have /v1/tools/*)', async () => {
      process.env.MCP_CLIENT_ENABLED = 'true';

      const response = await execute(
        { tool: 'write_file', arguments: { file_path: 'admin.txt', content: 'x' } },
        'platform-admin'
      );

      expect(existsSync(join(workDir, 'admin.txt')), response.body).toBe(false);
      expect(response.statusCode, response.body).toBe(422);
      // The mode's own reason is carried in `details.attempts`.
      expect(response.body).toMatch(/Unknown or unregistered MCP tool: write_file/);
    });
  });

  describe('MCP_CLIENT_ENABLED is honoured on execute, not only on health', () => {
    it('flag off: a registered MCP tool is refused with capability_dependency_unavailable', async () => {
      const response = await execute({ tool: MCP_WEB_TOOL, arguments: { q: 'x' } });

      expect(response.statusCode, response.body).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('capability_dependency_unavailable');
      expect(JSON.stringify(body)).toMatch(/MCP_CLIENT_ENABLED/);
      expect(mcpHandlerCalls).toEqual([]);
    });
  });

  describe('flag on: MCP tools', () => {
    beforeEach(() => {
      process.env.MCP_CLIENT_ENABLED = 'true';
    });

    it('tenant runs an external-effect (web) MCP tool', async () => {
      const response = await execute({ tool: MCP_WEB_TOOL, arguments: { q: 'hello' } });

      expect(response.statusCode, response.body).toBe(200);
      const body = JSON.parse(response.body);
      expect(body._ailin.execution_path).toBe('agentic_sandbox');
      expect(body.data.success).toBe(true);
      expect(mcpHandlerCalls).toEqual([MCP_WEB_TOOL]);
    });

    it('tenant is refused (403) an MCP tool whose category may touch the host', async () => {
      const response = await execute({ tool: MCP_FILE_TOOL, arguments: { path: 'x' } });

      expect(response.statusCode, response.body).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('platform_admin_required');
      expect(mcpHandlerCalls).toEqual([]);
    });

    it('platform admin may run that same MCP tool', async () => {
      const response = await execute(
        { tool: MCP_FILE_TOOL, arguments: { path: 'x' } },
        'platform-admin'
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(mcpHandlerCalls).toEqual([MCP_FILE_TOOL]);
    });

    it('a tool the MCP client did not register is refused even if its name starts with mcp_', async () => {
      const { toolRegistry } = await import('@/core/tools/tool-registry');
      toolRegistry.register({
        name: 'mcp_spoofed_native',
        description: 'native tool that merely looks like an MCP one',
        category: 'web',
        safeForStrategies: true,
        handler: async (_args, toolCallId) => {
          mcpHandlerCalls.push('mcp_spoofed_native');
          return { tool_call_id: toolCallId, success: true, output: 'ran' };
        },
      });

      const response = await execute({ tool: 'mcp_spoofed_native', arguments: {} });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.body).toMatch(/Unknown or unregistered MCP tool: mcp_spoofed_native/);
      expect(mcpHandlerCalls).toEqual([]);
    });
  });
});
