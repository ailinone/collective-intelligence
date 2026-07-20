// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeToolMock = vi.fn();

vi.mock('@/services/jina-tools-service', () => ({
  JinaToolsService: vi.fn().mockImplementation(() => ({
    executeTool: executeToolMock,
  })),
}));

// Bypass JWT auth so the route handler under test is reachable without a token.
vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn().mockResolvedValue(undefined),
  requireRole: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined)),
  optionalAuth: vi.fn().mockResolvedValue(undefined),
  requireOrganization: vi.fn(),
}));

describe('Jina tool routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    executeToolMock.mockReset();
    server = Fastify();
    const { registerToolsRoutes } = await import('@/routes/tools/tools-routes');
    await registerToolsRoutes(server);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('POST /v1/tools/jina/search returns 200 and tool metadata', async () => {
    executeToolMock.mockResolvedValueOnce({
      success: true,
      tool_call_id: 'tool_jina_search',
      output: '{"items":[]}',
      metadata: {
        upstream_status: 200,
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/jina/search',
      payload: {
        query: 'openapi',
      },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.metadata).toMatchObject({
      tool_name: 'jina_search',
      upstream_status: 200,
    });
    expect(typeof body.metadata.duration_ms).toBe('number');
    expect(executeToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'search',
        payload: expect.objectContaining({
          query: 'openapi',
        }),
      })
    );
  });

  it('POST /v1/tools/jina/deepsearch propagates upstream 429 status and metadata', async () => {
    const upstreamError = Object.assign(new Error('rate limited'), {
      statusCode: 429,
      metadata: {
        upstream_status: 429,
        upstream_url: 'https://deepsearch.jina.ai/v1/chat/completions',
      },
    });
    executeToolMock.mockRejectedValueOnce(upstreamError);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/jina/deepsearch',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('rate limited');
    expect(body.metadata).toMatchObject({
      tool_name: 'jina_deepsearch',
      upstream_status: 429,
    });
  });
});

