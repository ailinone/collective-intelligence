// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Helper functions for Assistants Service
 * Type-safe parsing of Prisma JSON fields
 */

import type { Assistant, AssistantTool } from '@/types/assistants';
import { Prisma } from '@/generated/prisma/index.js';

/**
 * Type guard to check if a value is a valid AssistantTool
 */
function isAssistantTool(value: unknown): value is AssistantTool {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const tool = value as Record<string, unknown>;
  if (!('type' in tool) || typeof tool.type !== 'string') {
    return false;
  }
  const validTypes = ['code_interpreter', 'file_search', 'function'];
  if (!validTypes.includes(tool.type)) {
    return false;
  }
  if (tool.type === 'function') {
    if (!('function' in tool) || typeof tool.function !== 'object' || tool.function === null) {
      return false;
    }
    const func = tool.function as Record<string, unknown>;
    if (typeof func.name !== 'string' || typeof func.description !== 'string') {
      return false;
    }
  }
  return true;
}

/**
 * Parse tools from Prisma JSON field
 */
export function parseAssistantTools(tools: Prisma.JsonValue): AssistantTool[] {
  if (!tools) {
    return [];
  }

  if (Array.isArray(tools)) {
    const result: AssistantTool[] = [];
    for (const tool of tools) {
      if (isAssistantTool(tool)) {
        result.push(tool);
      }
    }
    return result;
  }

  if (typeof tools === 'string') {
    try {
      const parsed: unknown = JSON.parse(tools);
      return Array.isArray(parsed) ? (parsed as AssistantTool[]) : [];
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Parse tool_resources from Prisma JSON field
 */
export function parseToolResources(
  toolResources: Prisma.JsonValue | null
): Assistant['tool_resources'] | undefined {
  if (!toolResources) {
    return undefined;
  }

  if (typeof toolResources === 'object' && toolResources !== null) {
    return toolResources as Assistant['tool_resources'];
  }

  if (typeof toolResources === 'string') {
    try {
      const parsed: unknown = JSON.parse(toolResources);
      return parsed as Assistant['tool_resources'];
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Parse response_format from Prisma JSON field
 */
export function parseResponseFormat(
  responseFormat: Prisma.JsonValue | null
): Assistant['response_format'] | null {
  if (!responseFormat) {
    return null;
  }

  if (typeof responseFormat === 'string') {
    if (responseFormat === 'text' || responseFormat === 'json_object') {
      return responseFormat;
    }
    try {
      const parsed: unknown = JSON.parse(responseFormat);
      if (typeof parsed === 'string') {
        return parsed as 'text' | 'json_object';
      }
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        return parsed as { type: 'json_object' };
      }
    } catch {
      return null;
    }
  }

  if (responseFormat && typeof responseFormat === 'object' && 'type' in responseFormat) {
    return responseFormat as { type: 'json_object' };
  }

  return null;
}

/**
 * Parse metadata from Prisma JSON field
 */
export function parseMetadata(metadata: Prisma.JsonValue): Record<string, string> {
  if (!metadata) {
    return {};
  }

  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string') {
        result[key] = value;
      } else {
        result[key] = String(value);
      }
    }
    return result;
  }

  if (typeof metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Convert value to Prisma.InputJsonValue (type-safe)
 * Note: For null values, use toPrismaNullableJsonValue instead
 */
export function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null) {
    throw new Error('toPrismaJsonValue does not accept null. Use toPrismaNullableJsonValue instead.');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toPrismaJsonValue) as Prisma.InputJsonValue;
  }
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = toPrismaJsonValue(val);
    }
    return result;
  }
  return value as Prisma.InputJsonValue;
}

/**
 * Convert value to Prisma nullable JSON value
 */
export function toPrismaNullableJsonValue(
  value: unknown | null
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null || value === undefined) {
    return Prisma.DbNull as Prisma.NullableJsonNullValueInput;
  }
  return toPrismaJsonValue(value);
}

