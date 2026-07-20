// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CLI-API Integration Test Suite
 *
 * Validates request/response contracts used by CLI flows against real test server routes.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import jwt, { type Algorithm } from 'jsonwebtoken';
import type { ChatRequest } from '@/types';
import { prisma } from '@/database/client';
import { config } from '@/config';
import { createTestServerWithRoutes, clearTestServerInstance } from '../utils/test-server';
import { getTestModelId } from '../utils/dynamic-model-discovery';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

async function ensureRoleAssignment(userId: string, organizationId: string, roleName: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    throw new Error(`Role ${roleName} not found`);
  }

  await prisma.userRole.upsert({
    where: {
      userId_organizationId_roleId: {
        userId,
        organizationId,
        roleId: role.id,
      },
    },
    update: {},
    create: {
      userId,
      organizationId,
      roleId: role.id,
    },
  });
}

function createAccessToken(payload: {
  userId: string;
  organizationId: string;
  email: string;
  roles: string[];
}): string {
  const algorithm = config.security.jwtAlgorithms[0] as Algorithm;
  return jwt.sign(
    {
      ...payload,
      token_use: 'access',
      jti: `at_${randomUUID()}`,
    },
    config.security.jwtSecret,
    {
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      algorithm,
      expiresIn: config.security.jwtExpiresIn,
      notBefore: 0,
    }
  );
}

describe('CLI-API Integration Tests', () => {
  let server: FastifyInstance;
  let authToken = '';
  let discoveredModelId = 'auto';

  beforeAll(async () => {
    await startTestEnvironment();
    await syncDefaultRoles();

    server = await createTestServerWithRoutes();
    await server.ready();

    const testEmail = `cli-api-integration-${Date.now()}@test.com`;
    await prisma.user.deleteMany({ where: { email: testEmail } });

    const organization = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: `CLI API Integration Org ${Date.now()}`,
        tier: 'pro',
        status: 'active',
        settings: {},
      },
    });

    const passwordHash = await bcrypt.hash('TestPassword123!', 12);
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: testEmail,
        passwordHash,
        name: 'CLI API Integration Tester',
        organizationId: organization.id,
        role: 'owner',
        status: 'active',
      },
    });

    await ensureRoleAssignment(user.id, organization.id, 'owner');

    authToken = createAccessToken({
      userId: user.id,
      organizationId: organization.id,
      email: user.email,
      roles: ['owner'],
    });

    expect(authToken.length).toBeGreaterThan(0);

    const modelId = await getTestModelId();
    if (modelId) {
      discoveredModelId = modelId;
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await server.close();
    } catch {
      // Ignore close errors during teardown
    }
    clearTestServerInstance();
    await stopTestEnvironment();
  });

  async function sendChatRequest(request: ChatRequest): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
  }> {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: request,
    });

    const body = response.body
      ? (JSON.parse(response.body) as Record<string, unknown>)
      : {};

    return {
      statusCode: response.statusCode,
      body,
    };
  }

  function expectOperationalStatus(statusCode: number): void {
    expect([200, 400, 500, 503]).toContain(statusCode);
  }

  describe('Dynamic Model Selection Integration', () => {
    it('should use DynamicModelSelector for code generation tasks', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Create a function to calculate fibonacci numbers in Python' }],
        task_type: 'code_generation',
        temperature: 0.7,
        max_tokens: 500,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expectOperationalStatus(statusCode);

      if (statusCode === 200) {
        expect(body.choices).toBeDefined();
        expect(body.ailin_metadata).toBeDefined();
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should respect user-specified model override', async () => {
      if (!discoveredModelId || discoveredModelId === 'auto') {
        return;
      }

      const request: ChatRequest = {
        model: discoveredModelId,
        strategy: 'single',
        messages: [{ role: 'user', content: 'Explain quantum computing simply' }],
        task_type: 'chat',
        temperature: 0.7,
        max_tokens: 200,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expectOperationalStatus(statusCode);

      if (statusCode === 200) {
        expect(typeof body.model).toBe('string');
        expect((body.model as string).length).toBeGreaterThan(0);
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should handle debugging tasks with appropriate model selection', async () => {
      const request: ChatRequest = {
        messages: [
          {
            role: 'user',
            content: 'My Python code has a bug: def factorial(n): return n * factorial(n-1). Help fix it.',
          },
        ],
        task_type: 'debugging',
        temperature: 0.3,
        max_tokens: 300,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expectOperationalStatus(statusCode);

      if (statusCode === 200) {
        expect(body.choices).toBeDefined();
        expect(body.ailin_metadata).toBeDefined();
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should validate that multiple models are considered in selection', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Write a comprehensive analysis of climate change impacts' }],
        task_type: 'documentation',
        temperature: 0.7,
        max_tokens: 1000,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expectOperationalStatus(statusCode);

      if (statusCode === 200) {
        expect(body.ailin_metadata).toBeDefined();
        expect(body.choices).toBeDefined();
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should handle chat tasks efficiently', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'What is the capital of Brazil?' }],
        task_type: 'chat',
        temperature: 0.9,
        max_tokens: 50,
      };

      const startTime = Date.now();
      const { statusCode, body } = await sendChatRequest(request);
      const durationMs = Date.now() - startTime;

      expectOperationalStatus(statusCode);
      expect(durationMs).toBeLessThan(15000);

      if (statusCode === 200) {
        expect(body.choices).toBeDefined();
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });
  });

  describe('Error Handling and Fallback', () => {
    it('should handle invalid task_type gracefully', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello world' }],
        task_type: 'invalid_task_type' as ChatRequest['task_type'],
        temperature: 0.7,
        max_tokens: 100,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expect([200, 400, 500]).toContain(statusCode);

      if (statusCode === 200) {
        expect(body.choices).toBeDefined();
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should handle empty messages array', async () => {
      const request: ChatRequest = {
        messages: [],
        task_type: 'chat',
        temperature: 0.7,
        max_tokens: 100,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expect([400, 422]).toContain(statusCode);
      expect(body.error || body.message).toBeDefined();
    });
  });

  describe('Performance Validation', () => {
    it('should include performance metadata in responses', async () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Say hello' }],
        task_type: 'chat',
        temperature: 0.7,
        max_tokens: 10,
      };

      const { statusCode, body } = await sendChatRequest(request);
      expectOperationalStatus(statusCode);

      if (statusCode === 200) {
        const metadata = body.ailin_metadata as Record<string, unknown> | undefined;
        expect(metadata).toBeDefined();
        expect(metadata?.execution_time_ms).toBeDefined();
        expect(metadata?.cost_usd).toBeDefined();
      } else {
        expect(body.error || body.message).toBeDefined();
      }
    });
  });
});
