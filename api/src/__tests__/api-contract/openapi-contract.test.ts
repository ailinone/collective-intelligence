// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAPI Contract Tests
 * Validates that API responses match the OpenAPI specification.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, unknown>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
}

function loadSpec(): OpenAPISpec {
  const specPath = path.join(__dirname, '../../../..', 'openapi-spec.json');
  const specContent = fs.readFileSync(specPath, 'utf-8');
  return JSON.parse(specContent) as OpenAPISpec;
}

describe('OpenAPI Contract Validation', () => {
  let openApiSpec: OpenAPISpec | null = null;

  beforeAll(() => {
    openApiSpec = loadSpec();
  });

  it('should have valid OpenAPI 3.0.3 structure', () => {
    expect(openApiSpec).not.toBeNull();
    if (!openApiSpec) return;
    expect(openApiSpec.openapi).toBe('3.0.3');
    expect(openApiSpec.info).toBeDefined();
    expect(openApiSpec.info.title).toContain('Ailin');
    expect(openApiSpec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(openApiSpec.paths).toBeDefined();
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(0);
  });

  it('should document all critical endpoints', () => {
    if (!openApiSpec) return;
    const paths = Object.keys(openApiSpec.paths);

    expect(paths).toContain('/v1/chat/completions');
    expect(paths).toContain('/v1/models');
    expect(paths).toContain('/v1/embeddings');
    expect(paths).toContain('/v1/auth/email-challenge');
    expect(paths).toContain('/v1/auth/register');
    expect(paths).toContain('/v1/auth/login');
    expect(paths).toContain('/v1/auth/refresh');
    expect(paths).toContain('/v1/analyze-requirements');
    expect(paths).toContain('/v1/provider-capabilities');
    expect(paths).toContain('/v1/chat/completions/intelligent');
    expect(paths).toContain('/v1/models/list');
    expect(paths).toContain('/v1/embeddings/create');
  });

  it('should NOT document blocked endpoints', () => {
    if (!openApiSpec) return;
    const paths = Object.keys(openApiSpec.paths);
    expect(paths).not.toContain('/auth/challenge');
    expect(paths).not.toContain('/models/providers');
    expect(paths).not.toContain('/users/me/password');
    expect(paths).not.toContain('/queue/jobs');
  });

  it('should have security schemes defined', () => {
    if (!openApiSpec) return;
    const schemes = openApiSpec.components?.securitySchemes as Record<string, any> | undefined;
    expect(schemes).toBeDefined();
    expect(schemes?.bearerAuth).toBeDefined();
    expect(schemes?.bearerAuth.type).toBe('http');
    expect(schemes?.bearerAuth.scheme).toBe('bearer');
  });

  it('should have all core schemas defined', () => {
    if (!openApiSpec) return;
    const schemas = Object.keys(openApiSpec.components?.schemas || {});
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas).toContain('ErrorResponse');
  });

  it('should have proper response schemas for /models', () => {
    if (!openApiSpec) return;
    const modelsPath = (openApiSpec.paths['/v1/models'] as any) ?? {};
    const getOp = modelsPath.get;
    expect(getOp).toBeDefined();

    const response200 = getOp.responses?.['200'];
    expect(response200).toBeDefined();

    const schema = response200.content?.['application/json']?.schema;
    expect(schema.properties).toBeDefined();
    expect(schema.properties.object).toBeDefined();
    expect(schema.properties.data).toBeDefined();
  });

  it('should document collective orchestration in description', () => {
    if (!openApiSpec) return;
    const description = (openApiSpec.info.description ?? '').toLowerCase();
    expect(description).toContain('multi-provider orchestration');
    expect(description).toContain('enterprise controls');
  });

  it('should document governance semantics in description', () => {
    if (!openApiSpec) return;
    const description = (openApiSpec.info.description ?? '').toLowerCase();
    expect(description).toContain('governance');
    expect(description).toContain('traceability');
  });

  it('should carry version and lifecycle semantics', () => {
    if (!openApiSpec) return;
    expect(openApiSpec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    const description = (openApiSpec.info.description ?? '').toLowerCase();
    expect(description).toContain('traceability');
  });

  it('should have examples for critical request schemas', () => {
    if (!openApiSpec) return;
    const chatPath = (openApiSpec.paths['/v1/chat/completions'] as any) ?? {};
    const requestSchema = chatPath.post?.requestBody?.content?.['application/json']?.schema;
    expect(requestSchema.properties.model).toBeDefined();
    expect(requestSchema.properties.messages).toBeDefined();
    expect(requestSchema.required).toContain('messages');
  });

  it('should document Ailin-specific request fields for /chat/completions', () => {
    if (!openApiSpec) return;
    const chatPath = (openApiSpec.paths['/v1/chat/completions'] as any) ?? {};
    const requestSchema = chatPath.post?.requestBody?.content?.['application/json']?.schema;
    expect(requestSchema.properties.strategy).toBeDefined();
    expect(requestSchema.properties.max_cost).toBeDefined();
    expect(requestSchema.properties.quality_target).toBeDefined();
    expect(requestSchema.properties.task_type).toBeDefined();
    expect(requestSchema.properties.response_format).toBeDefined();
  });

  it('should document async and error responses for /chat/completions', () => {
    if (!openApiSpec) return;
    const chatPath = (openApiSpec.paths['/v1/chat/completions'] as any) ?? {};
    const responses = chatPath.post?.responses ?? {};
    expect(responses['202']).toBeDefined();
    expect(responses['500']).toBeDefined();
    expect(responses['429']).toBeDefined();
  });
});

describe('OpenAPI Schema Consistency', () => {
  let openApiSpec: OpenAPISpec | null = null;

  beforeAll(() => {
    openApiSpec = loadSpec();
  });

  it('should have consistent path naming (all lowercase)', () => {
    if (!openApiSpec) return;
    const paths = Object.keys(openApiSpec.paths);
    paths.forEach((specPath) => {
      const pathWithoutParams = specPath.replace(/\{[^}]+\}/g, '');
      expect(pathWithoutParams).toBe(pathWithoutParams.toLowerCase());
    });
  });

  it('should use consistent HTTP methods', () => {
    if (!openApiSpec) return;
    const paths = openApiSpec.paths as Record<
      string,
      Record<string, { tags?: string[]; summary?: string; [key: string]: unknown }>
    >;

    Object.entries(paths).forEach(([, methods]) => {
      const httpMethods = Object.keys(methods);
      httpMethods.forEach((method) => {
        expect(method).toBe(method.toLowerCase());
        expect(methods[method].tags).toBeDefined();
        expect(methods[method].tags?.length ?? 0).toBeGreaterThan(0);
        expect(methods[method].summary).toBeDefined();
        expect(typeof methods[method].summary).toBe('string');
      });
    });
  });

  it('should have all $ref targets defined', () => {
    if (!openApiSpec) return;

    const definedSchemas = Object.keys(openApiSpec.components?.schemas || {});
    const definedResponses = Object.keys(openApiSpec.components?.responses || {});
    const definedRefs = new Set([...definedSchemas, ...definedResponses]);
    const refsUsed = new Set<string>();

    const extractRefs = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') return;

      const record = obj as Record<string, unknown>;
      if (typeof record.$ref === 'string') {
        const refName = record.$ref.split('/').pop();
        if (refName) refsUsed.add(refName);
      }

      Object.values(record).forEach((value) => extractRefs(value));
    };

    extractRefs(openApiSpec.paths);

    refsUsed.forEach((ref) => {
      expect(definedRefs.has(ref)).toBe(true);
    });
  });
});
