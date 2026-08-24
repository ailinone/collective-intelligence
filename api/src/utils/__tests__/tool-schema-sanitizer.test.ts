// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { sanitizeToolSchemas } from '../tool-schema-sanitizer';

const incidentTool = {
  type: 'function' as const,
  function: {
    name: 'create_tasks',
    description: 'Create a visible task checklist',
    // Exact incident signature: `required: {}` (object, not array) at BOTH the
    // root and the array-items level. OpenAI rejects the request with
    // 400 invalid_function_parameters "'{}' is not of type 'array'".
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
            },
            required: {},
          },
        },
      },
      required: {},
    },
  },
};

describe('sanitizeToolSchemas', () => {
  it('drops object-valued `required` at root and nested items (incident signature)', () => {
    const tools = [structuredClone(incidentTool)];
    const sanitized = sanitizeToolSchemas(tools)!;

    expect(sanitized).toHaveLength(1);
    const params = sanitized[0].function!.parameters as Record<string, any>;
    expect(params).not.toHaveProperty('required');
    const items = params.properties.tasks.items;
    expect(items).not.toHaveProperty('required');
    // The rest of the schema is untouched
    expect(params.properties.tasks.type).toBe('array');
    expect(items.properties.content.type).toBe('string');
  });

  it('preserves valid `required` arrays of strings', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'ok',
          parameters: {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
          },
        },
      },
    ];
    const original = JSON.parse(JSON.stringify(tools));
    const sanitized = sanitizeToolSchemas(tools)!;
    expect(sanitized[0].function!.parameters).toEqual(original[0].function!.parameters);
  });

  it('filters non-string entries out of `required` arrays', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'mixed',
          parameters: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            required: ['a', 42, null, 'b'],
          },
        },
      },
    ];
    const sanitized = sanitizeToolSchemas(tools)!;
    expect((sanitized[0].function!.parameters as any).required).toEqual(['a', 'b']);
  });

  it('drops an all-invalid `required` array entirely', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'allbad',
          parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [1, 2] },
        },
      },
    ];
    const sanitized = sanitizeToolSchemas(tools)!;
    expect(sanitized[0].function!.parameters).not.toHaveProperty('required');
  });

  it('does not mutate the caller input and returns the same array when clean', () => {
    const tools = [structuredClone(incidentTool)];
    const snapshot = JSON.parse(JSON.stringify(tools));
    const result = sanitizeToolSchemas(tools);
    expect(tools).toEqual(snapshot); // input untouched
    expect(result).not.toBe(tools); // new array produced when changed
  });

  it('returns the identical array reference when nothing needs fixing', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'ok',
          parameters: { type: 'object', properties: { a: { type: 'string' } } },
        },
      },
    ];
    expect(sanitizeToolSchemas(tools)).toBe(tools);
  });

  it('handles undefined and empty arrays', () => {
    expect(sanitizeToolSchemas(undefined)).toBeUndefined();
    expect(sanitizeToolSchemas([])).toEqual([]);
  });

  it('normalizes required inside $defs / anyOf branches', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'defs',
          parameters: {
            type: 'object',
            $defs: { TaskItem: { type: 'object', properties: {}, required: {} } },
            properties: {
              x: { anyOf: [{ type: 'string' }, { type: 'object', required: {} }] },
            },
          },
        },
      },
    ];
    const sanitized = sanitizeToolSchemas(tools)!;
    const params = sanitized[0].function!.parameters as any;
    expect(params.$defs.TaskItem).not.toHaveProperty('required');
    expect(params.properties.x.anyOf[1]).not.toHaveProperty('required');
  });

  it('sanitizes the full 2026-08-21 incident payload shape: 38 tools with tools[27] = create_tasks', () => {
    const tools: any[] = Array.from({ length: 38 }, (_, i) => ({
      type: 'function',
      function: {
        name: `tool_${i}`,
        description: 'd',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    }));
    tools[27] = structuredClone(incidentTool);
    const sanitized = sanitizeToolSchemas(tools)!;
    for (let i = 0; i < 38; i++) {
      const params = sanitized[i].function.parameters;
      if (i === 27) {
        expect(params).not.toHaveProperty('required');
      } else {
        expect(params.required).toEqual(['q']);
      }
    }
  });

  describe('parameters shape normalization (2026-08-22 follow-up: `parameters: {}`)', () => {
    const DEFAULT_SCHEMA = { type: 'object', properties: {} };

    it('replaces `parameters: {}` with the canonical empty object schema', () => {
      const tools = [
        { type: 'function', function: { name: 'create_tasks', description: 'd', parameters: {} } },
      ];
      const sanitized = sanitizeToolSchemas(tools as any)!;
      expect(sanitized[0].function!.parameters).toEqual(DEFAULT_SCHEMA);
    });

    it('replaces absent `parameters` with the canonical empty object schema', () => {
      const tools = [{ type: 'function', function: { name: 'create_tasks', description: 'd' } }];
      const sanitized = sanitizeToolSchemas(tools as any)!;
      expect(sanitized[0].function!.parameters).toEqual(DEFAULT_SCHEMA);
    });

    it('normalizes `type: ["object"]` (array form) to `type: "object"`', () => {
      const tools = [
        {
          type: 'function',
          function: {
            name: 'create_tasks',
            parameters: { type: ['object'], properties: { q: { type: 'string' } } },
          },
        },
      ];
      const sanitized = sanitizeToolSchemas(tools as any)!;
      const params = sanitized[0].function!.parameters as any;
      expect(params.type).toBe('object');
      expect(params.properties.q.type).toBe('string'); // rest of schema preserved
    });

    it('leaves a valid schema untouched (by reference)', () => {
      const tools = [
        {
          type: 'function',
          function: {
            name: 'ok',
            parameters: {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['a'],
            },
          },
        },
      ];
      expect(sanitizeToolSchemas(tools as any)).toBe(tools);
    });

    it('reports each normalized tool exactly once via onNormalization', () => {
      const events: any[] = [];
      const tools = [
        { type: 'function', function: { name: 'a', parameters: {} } },
        { type: 'function', function: { name: 'b', parameters: { type: ['object'] } } },
        { type: 'function', function: { name: 'c', parameters: { type: 'object' } } },
      ];
      sanitizeToolSchemas(tools as any, { onNormalization: (e) => events.push(e) });
      expect(events.map((e) => e.name).sort()).toEqual(['a', 'b']);
      expect(events[0].reason).toBe('parameters-empty');
      expect(events[1].reason).toBe('type-array');
    });

    it('replaces non-object parameters (array/string) with the default schema', () => {
      const tools = [
        { type: 'function', function: { name: 'bad1', parameters: ['object'] } },
        { type: 'function', function: { name: 'bad2', parameters: 'object' } },
      ];
      const sanitized = sanitizeToolSchemas(tools as any)!;
      expect(sanitized[0].function!.parameters).toEqual(DEFAULT_SCHEMA);
      expect(sanitized[1].function!.parameters).toEqual(DEFAULT_SCHEMA);
    });

    it('replaces a root type that is not "object" with the default schema', () => {
      const tools = [
        { type: 'function', function: { name: 'bad', parameters: { type: 'string' } } },
      ];
      const sanitized = sanitizeToolSchemas(tools as any)!;
      expect(sanitized[0].function!.parameters).toEqual(DEFAULT_SCHEMA);
    });
  });
});
