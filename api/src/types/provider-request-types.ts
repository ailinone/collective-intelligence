// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Type-safe request/response types for provider adapters
 * Replaces all `any` types with specific interfaces
 */

// OpenAI-compatible message types
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface EmbeddingsRequestBody {
  model: string;
  input: string | string[];
}

export interface ImageGenerationRequestBody {
  model: string;
  prompt: string;
  size?: string;
  n?: number;
  response_format?: 'url' | 'b64_json';
  [key: string]: unknown; // For additional provider-specific options
}

export interface AudioTTSRequestBody {
  model: string;
  input: string;
  voice?: string;
  format?: string;
  [key: string]: unknown; // For additional provider-specific options
}

// Provider response types
export interface ProviderRawResponse {
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    delta?: {
      content?: string;
    };
  }>;
  [key: string]: unknown;
}

export interface EmbeddingsResponse {
  data: Array<{
    embedding: number[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export type ProviderEmbeddingsResponse = EmbeddingsResponse;

export interface ImageGenerationResponse {
  data: Array<{
    b64_json?: string;
    url?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// Generic JSON schema type
export type JSONSchema = Record<string, unknown>;

// Generic payload type for rawInvoke
export type RawInvokePayload = Record<string, unknown>;

// Generic response type for rawInvoke
export type RawInvokeResponse = unknown;

