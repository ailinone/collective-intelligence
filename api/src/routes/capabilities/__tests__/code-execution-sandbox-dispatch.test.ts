// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level tests for `executeCodeExecutionSandboxMode` (ADR-026):
 * `code_interpreter` dispatched through `POST /v1/capabilities/:capability/execute`.
 *
 * Mirrors `agentic-sandbox-dispatch.test.ts`'s structure and its central
 * concern: with `CODE_EXECUTION_SANDBOX_ENABLED` at its default (off), the
 * new ADR-026 sandbox must never be touched, and the request must fall
 * through to the PRE-EXISTING `sandbox_workflow` → `orchestration` chain
 * byte-for-byte as it did before this ADR (see
 * `capability-execution-plan-honesty.test.ts`'s "leaves the real
 * code-execution capabilities executable" pin for the static-plan half of
 * that contract; this file proves the DYNAMIC dispatch half).
 *
 * `CodeExecutionService` (the legacy `sandbox_workflow` executor —
 * `E2B`/`Daytona`/`LocalProcessSandbox`, ADR-024's documented "not safe to
 * expose... without that work landing first") and
 * `getCapabilityExecutionService` (the final `orchestration` fallback, a
 * real model call) are BOTH module-mocked here, deterministically, so the
 * flag-off fallthrough test exercises the real dispatch/fallthrough logic
 * without ever spawning a real host process or making a real network call —
 * exactly the kind of exposure ADR-024/ADR-026 exist to avoid.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
    request.userContext = {
      organizationId: 'org-adr025-test',
      userId: 'user-adr025-test',
      requestId: 'req-adr025-test',
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

// The health endpoint (GET /v1/capabilities/:capability/health, exercised by
// this file's "reports CODE_EXECUTION_SANDBOX_ENABLED..." test) calls
// `getAllCatalogModels()`, whose cold path is `prisma.model.findMany(...)`
// (see `model-catalog-service.ts`). Without this mock that hits a real,
// unconfigured Postgres connection and the route answers 500 instead of the
// 200 this file asserts. An empty result is sufficient: this file's health
// assertion only checks that the flag's name appears in the dependency
// report, which `resolveRuntimeDependencies` produces independently of the
// model inventory.
vi.mock('@/database/client', () => ({
  prisma: { model: { findMany: vi.fn().mockResolvedValue([]) } },
}));

// Same health endpoint also calls `getProviderRegistry()` unconditionally
// (before it even knows whether there are any candidate models to check
// operability for). The real registry is a module-level singleton that is
// never initialized in this file's isolated module graph, so an unmocked
// call throws "Provider registry not initialized" — mirrors the stub used by
// `agentic-sandbox-dispatch.test.ts` for the same reason.
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ get: vi.fn(), getAll: () => [] }),
}));

// The LEGACY sandbox_workflow executor — must never actually run E2B/Daytona/
// LocalProcessSandbox in this test file. Deterministic failure keeps the
// flag-off fallthrough test's THIRD hop (orchestration) reachable without
// depending on real sandbox infrastructure.
const legacyExecuteCodeMock = vi.fn().mockResolvedValue({
  success: false,
  error: 'legacy sandbox_workflow mocked failure (test)',
});
vi.mock('@/services/code-execution-service', () => ({
  CodeExecutionService: vi.fn().mockImplementation(() => ({
    executeCode: legacyExecuteCodeMock,
  })),
}));

// The final orchestration fallback — a real model call in production.
// Deterministic failure so the flag-off test's overall result is a clean,
// fast 422 instead of a real (or hanging) provider call.
const executeWithCapabilitiesMock = vi.fn().mockResolvedValue({
  success: false,
  error: 'orchestration mocked failure (test)',
});
vi.mock('@/services/capability-execution-service', () => ({
  getCapabilityExecutionService: () => ({
    executeWithCapabilities: executeWithCapabilitiesMock,
  }),
}));

// The NEW ADR-026 sandbox primitive. Real Docker is exercised separately in
// `core/sandbox/__tests__/code-execution-adversarial.integration.test.ts` —
// this file is about DISPATCH (which mode runs, and when), not the container
// itself, so it is mocked here for a fast, deterministic route-level proof.
const sandboxExecuteCodeMock = vi.fn();
vi.mock('@/core/sandbox/code-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/sandbox/code-execution')>();
  return { ...actual, executeCode: sandboxExecuteCodeMock };
});

const savedFlag: { value: string | undefined } = { value: undefined };

describe('code_interpreter dispatch (ADR-026)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    savedFlag.value = process.env.CODE_EXECUTION_SANDBOX_ENABLED;
    delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
    const { registerCapabilitiesRoutes } = await import('../capabilities-routes');
    server = Fastify();
    await registerCapabilitiesRoutes(server);
    await server.ready();
  }, 60_000);

  afterAll(async () => {
    await server.close();
    if (savedFlag.value === undefined) delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
    else process.env.CODE_EXECUTION_SANDBOX_ENABLED = savedFlag.value;
  });

  beforeEach(() => {
    delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
    legacyExecuteCodeMock.mockClear();
    executeWithCapabilitiesMock.mockClear();
    sandboxExecuteCodeMock.mockReset();
  });

  afterEach(() => {
    delete process.env.CODE_EXECUTION_SANDBOX_ENABLED;
  });

  describe('flag off (default) — the new sandbox is never touched, falls through unchanged', () => {
    it('never calls the ADR-026 sandbox, and still reaches the legacy sandbox_workflow path', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/code_interpreter/execute',
        payload: { code: 'print(1)', language: 'python' },
      });

      expect(sandboxExecuteCodeMock, 'the new sandbox must not run while the flag is off').not
        .toHaveBeenCalled();
      // Falls through past code_execution_sandbox (disabled) into the
      // PRE-EXISTING sandbox_workflow path, which the mocked
      // CodeExecutionService answers deterministically.
      expect(legacyExecuteCodeMock, 'sandbox_workflow must still be tried, exactly as before ADR-026').toHaveBeenCalledTimes(1);

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error?.code ?? body.code).toBe('capability_dependency_unavailable');
    });

    it('reports CODE_EXECUTION_SANDBOX_ENABLED as the unmet dependency on the health endpoint', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/capabilities/code_interpreter/health',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const dependencyText = JSON.stringify(body);
      expect(dependencyText).toMatch(/CODE_EXECUTION_SANDBOX_ENABLED/);
    });
  });

  describe('flag on — code_execution_sandbox runs FIRST and short-circuits the legacy path', () => {
    beforeEach(() => {
      process.env.CODE_EXECUTION_SANDBOX_ENABLED = 'true';
    });

    it('dispatches to the new sandbox and never falls through to sandbox_workflow/orchestration', async () => {
      sandboxExecuteCodeMock.mockResolvedValue({
        outcome: 'ok',
        exitCode: 0,
        stdout: '5050\n',
        stderr: '',
        durationMs: 42,
        auditId: 'test-audit-id',
        truncated: false,
        language: 'python',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/code_interpreter/execute',
        payload: { code: 'print(sum(range(1, 101)))', language: 'python' },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = JSON.parse(response.body);
      expect(body._ailin.execution_path).toBe('code_execution_sandbox');
      expect(body.data.success).toBe(true);
      expect(body.data.stdout).toBe('5050\n');
      expect(body.data.exit_code).toBe(0);

      expect(sandboxExecuteCodeMock).toHaveBeenCalledTimes(1);
      expect(
        legacyExecuteCodeMock,
        'a successful new-sandbox run must never fall through to the legacy path'
      ).not.toHaveBeenCalled();
      expect(executeWithCapabilitiesMock).not.toHaveBeenCalled();
    });

    it('normalizes language aliases (js -> javascript) before calling the sandbox', async () => {
      sandboxExecuteCodeMock.mockResolvedValue({
        outcome: 'ok',
        exitCode: 0,
        stdout: '1024\n',
        stderr: '',
        durationMs: 10,
        auditId: 'test-audit-id-2',
        truncated: false,
        language: 'javascript',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/code_interpreter/execute',
        payload: { code: 'console.log(2 ** 10)', language: 'js' },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(sandboxExecuteCodeMock).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'javascript', code: 'console.log(2 ** 10)' })
      );
    });

    it('reports a non-ok outcome (e.g. timeout) as data, not as an HTTP error — the request itself succeeded', async () => {
      sandboxExecuteCodeMock.mockResolvedValue({
        outcome: 'timeout',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 3000,
        auditId: 'test-audit-id-3',
        truncated: false,
        reason: 'Execution exceeded the 3000ms sandbox timeout and was killed',
        language: 'python',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/code_interpreter/execute',
        payload: { code: 'while True: pass', language: 'python' },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.success).toBe(false);
      expect(body.data.outcome).toBe('timeout');
      expect(legacyExecuteCodeMock).not.toHaveBeenCalled();
    });

    it('rejects an unsupported language before ever calling the sandbox (400, not a mode fallthrough)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/code_interpreter/execute',
        payload: { code: 'puts 1', language: 'ruby' },
      });

      expect(sandboxExecuteCodeMock).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
    });

    it('requires non-empty code (400)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/capabilities/code_interpreter/execute',
        payload: { language: 'python' },
      });
      expect(sandboxExecuteCodeMock).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
    });
  });
});
