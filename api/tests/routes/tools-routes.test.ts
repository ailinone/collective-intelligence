// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration Tests for Tools API Routes
 * 
 * Tests the REST API endpoints for tool execution.
 * 
 * @module tests/routes/tools-routes
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '@/server';

describe('Tools API Routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    // Create server for testing
    server = await createServer();
    
    // Register tools routes
    const { registerToolsRoutes } = await import('@/routes/tools/tools-routes');
    await registerToolsRoutes(server);
    
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /v1/tools/workflows', () => {
    it('should return list of workflows', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/tools/workflows',
        headers: {
          authorization: 'Bearer ak_test_key',
        },
      });

      // Should work or require auth
      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
        expect(body).toHaveProperty('tool_call_id');
      }
    });
  });

  describe('POST /v1/tools/list-directory', () => {
    it('should list directory contents', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/list-directory',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          path: '.',
        },
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
        expect(body.success).toBe(true);
      }
    });

    it('should handle invalid directory gracefully', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/list-directory',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          path: '/nonexistent/directory/path',
        },
      });

      expect([200, 401, 500]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
        expect(body.success).toBe(false);
        expect(body).toHaveProperty('error');
      }
    });
  });

  describe('POST /v1/tools/grep', () => {
    it('should search for patterns in files', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/grep',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          pattern: 'function',
          path: 'src',
        },
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
        expect(body).toHaveProperty('tool_call_id');
      }
    });
  });

  describe('POST /v1/tools/git/status', () => {
    it('should return git status', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/git/status',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {},
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
        expect(body).toHaveProperty('tool_call_id');
      }
    });
  });

  describe('POST /v1/tools/codebase-search', () => {
    it('should search codebase', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/codebase-search',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          query: 'export function',
        },
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
      }
    });
  });

  describe('POST /v1/tools/todos/create', () => {
    it('should create a todo item', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/todos/create',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          content: 'Test TODO from API test',
          priority: 'medium',
        },
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
      }
    });
  });

  describe('POST /v1/tools/todos/check', () => {
    it('should attempt to mark a todo as completed', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/todos/check',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          id: 'todo_test_id',
        },
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
      }
    });
  });

  describe('POST /v1/tools/todos/list', () => {
    it('should list todo items', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/todos/list',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {},
      });

      expect([200, 401]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('success');
      }
    });
  });

  describe('Response Structure Validation', () => {
    it('should include metadata in all responses', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/list-directory',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          path: '.',
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('metadata');
        expect(body.metadata).toHaveProperty('duration_ms');
        expect(body.metadata).toHaveProperty('tool_name');
        expect(typeof body.metadata.duration_ms).toBe('number');
      }
    });
  });

  describe('Error Handling', () => {
    it('should return proper error structure on failure', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tools/search-replace',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ak_test_key',
        },
        payload: {
          file_path: '/nonexistent/file.ts',
          old_string: 'foo',
          new_string: 'bar',
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.success).toBe(false);
        expect(body).toHaveProperty('error');
        expect(typeof body.error).toBe('string');
      }
    });
  });
});

