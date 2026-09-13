// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level tests for `executeAgenticSandboxMode` (ADR-024, LOTE AV):
 * `computer_use` / `agents` / `mcp` dispatched through
 * `POST /v1/capabilities/:capability/execute`.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is the flag-off group: it proves that
 * with every ADR-024 flag at its default (off), none of the three
 * capabilities ever reaches the sandbox, the MCP client, or a model call —
 * the request is refused with `capability_dependency_unavailable` before any
 * side effect occurs. This is the regression guard for the single hardest
 * constraint on this change ("ship default-off, and prove it").
 *
 * `computer_use` flag-on uses REAL Docker (no mocking of the sandbox) so a
 * green run means the container path was genuinely exercised, matching the
 * project's existing adversarial-sandbox test convention
 * (`computer-use-tools.integration.test.ts`). `agents` flag-on mocks the
 * dynamic model selector and provider adapter — a real run needs a live
 * provider credential, which this suite does not have — but exercises the
 * REAL `runBoundedAgent` loop and the REAL tool registry.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bypass auth: stamp a fixed OrchestrationContext so `getUserContext()` in
// capabilities-routes.ts picks it up directly (see its
// `extendedRequest.userContext || createOrchestrationContext(request)`).
vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
    request.userContext = {
      organizationId: 'org-adr024-test',
      userId: 'user-adr024-test',
      requestId: 'req-adr024-test',
    };
  }),
}));
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => vi.fn().mockResolvedValue(undefined),
}));

// Static (hoisted) mocks for the agent-loop's model dispatch, mutated per
// test via these `vi.fn()` handles rather than re-mocked with `vi.doMock` —
// `agent-model-invoker.ts` is dynamically imported the FIRST time any
// 'agents' request runs and then stays cached for the rest of this file, so
// a later `vi.doMock` on its dependencies would silently not apply. A
// module-level mock swapped by `mockImplementation`/`mockReset` per test
// does not have that problem.
const selectModelsMock = vi.fn();
const providerGetMock = vi.fn();
vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => ({ selectModels: selectModelsMock }),
}));
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ get: providerGetMock }),
}));

const AGENTIC_ENV_KEYS = [
  'AGENTIC_COMPUTER_USE_ENABLED',
  'AGENTIC_AGENTS_ENABLED',
  'MCP_CLIENT_ENABLED',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function clearAgenticFlags(): void {
  for (const key of AGENTIC_ENV_KEYS) delete process.env[key];
}

describe('agentic sandbox dispatch (ADR-024, LOTE AV)', () => {
  // One server for the whole file: `registerCapabilitiesRoutes` constructs
  // several orchestration services with real (redis/circuit-breaker) module
  // side effects that are expensive to redo per test and irrelevant to what
  // this file asserts. What DOES vary per test — env flags, tool
  // registration, mocked selector/provider — is reset in `beforeEach`/
  // `afterEach` below instead of tearing down the whole module graph.
  let server: FastifyInstance;

  beforeAll(async () => {
    for (const key of AGENTIC_ENV_KEYS) savedEnv[key] = process.env[key];
    clearAgenticFlags();
    const { registerCapabilitiesRoutes } = await import('../capabilities-routes');
    server = Fastify();
    await registerCapabilitiesRoutes(server);
    await server.ready();
  }, 60_000);

  afterAll(async () => {
    await server.close();
    for (const key of AGENTIC_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(() => {
    clearAgenticFlags();
  });

  afterEach(async () => {
    clearAgenticFlags();
    selectModelsMock.mockReset();
    providerGetMock.mockReset();
    const { __resetComputerUseRegistrationForTest } = await import(
      '@/core/sandbox/computer-use-tools'
    );
    __resetComputerUseRegistrationForTest();
    const { disposeAllSessions } = await import('@/core/sandbox/sandbox-session-manager');
    await disposeAllSessions();
  });

  // ── Flag OFF: the single most important group in this file ─────────────
  describe('flag off (default) — capability_dependency_unavailable, nothing executes', () => {
    it('computer_use: refuses without registering or invoking any sandbox tool', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/computer_use/execute',
        payload: { operation: 'shell', command: 'echo', args: ['hi'] },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error?.code ?? body.code).toBe('capability_dependency_unavailable');
      expect(JSON.stringify(body)).toMatch(/AGENTIC_COMPUTER_USE_ENABLED/);

      const { toolRegistry } = await import('@/core/tools/tool-registry');
      expect(
        toolRegistry.has('computer_shell'),
        'the tool must not even be registered when the flag is off'
      ).toBe(false);
    });

    it('agents: refuses via stopReason=disabled, before any model is selected', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/agents/execute',
        payload: { messages: [{ role: 'user', content: 'do something' }] },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error?.code ?? body.code).toBe('capability_dependency_unavailable');
      expect(JSON.stringify(body)).toMatch(/AGENTIC_AGENTS_ENABLED/);
      expect(
        selectModelsMock,
        'no model may be selected while the flag is off'
      ).not.toHaveBeenCalled();
    });

    it('mcp: refuses because no MCP tool can be registered without the client running', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/mcp/execute',
        payload: { tool: 'mcp_filesystem_read', arguments: {} },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error?.code ?? body.code).toBe('capability_dependency_unavailable');

      const { toolRegistry } = await import('@/core/tools/tool-registry');
      expect(toolRegistry.has('mcp_filesystem_read')).toBe(false);
    });
  });

  // ── Flag ON: computer_use, real Docker ──────────────────────────────────
  describe('computer_use flag on — real Docker execution', () => {
    let dockerUp = false;

    beforeEach(async () => {
      process.env.AGENTIC_COMPUTER_USE_ENABLED = 'true';
      // `registerCapabilitiesRoutes` never calls this — only `index.ts`'s
      // boot sequence does (see the LOTE AV commit wiring it in). Do here,
      // explicitly, what boot does implicitly.
      const { registerComputerUseTools } = await import('@/core/sandbox/computer-use-tools');
      registerComputerUseTools();
      const { resetDockerProbeForTesting, isDockerAvailable } = await import(
        '@/core/sandbox/container-sandbox'
      );
      resetDockerProbeForTesting();
      dockerUp = await isDockerAvailable();
    }, 30_000);

    it(
      'guard: Docker is reachable (otherwise the execution assertion below is vacuous)',
      () => {
        expect(
          dockerUp,
          'Docker is not reachable in this environment — start it and re-run before trusting a green result'
        ).toBe(true);
      },
      15_000
    );

    it(
      'runs a real allowlisted shell command inside the container and returns its output',
      async () => {
        if (!dockerUp) return;
        const response = await server.inject({
          method: 'POST',
          url: '/v1/capabilities/computer_use/execute',
          payload: { operation: 'shell', command: 'echo', args: ['adr-024-live'] },
        });

        expect(response.statusCode, response.body).toBe(200);
        const body = JSON.parse(response.body);
        expect(body._ailin.execution_path).toBe('agentic_sandbox');
        expect(body.data.success).toBe(true);
        expect(body.data.output.trim()).toBe('adr-024-live');
      },
      60_000
    );
  });

  // ── Flag ON: agents, mocked model turn ──────────────────────────────────
  describe('agents flag on — real bounded loop, mocked model turn', () => {
    beforeEach(() => {
      process.env.AGENTIC_AGENTS_ENABLED = 'true';
    });

    it('runs one no-tool-call model turn and returns the final content', async () => {
      selectModelsMock.mockResolvedValue([
        {
          model: { id: 'test-model-x', provider: 'test-provider-x' },
          score: 1,
          reason: 'test',
        },
      ]);
      const chatCompletion = vi.fn().mockResolvedValue({
        id: 'resp-1',
        object: 'chat.completion',
        created: 0,
        model: 'test-model-x',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'the answer is 42' },
            finish_reason: 'stop',
          },
        ],
      });
      providerGetMock.mockImplementation((name: string) =>
        name === 'test-provider-x' ? { chatCompletion } : undefined
      );

      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/agents/execute',
        payload: { messages: [{ role: 'user', content: 'what is the answer?' }] },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = JSON.parse(response.body);
      expect(body._ailin.execution_path).toBe('agentic_sandbox');
      expect(body.data.stopReason).toBe('success');
      expect(body.data.content).toBe('the answer is 42');
    });
  });
});
