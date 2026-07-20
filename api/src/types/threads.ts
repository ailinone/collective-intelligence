// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Threads API Types
 * OpenAI-compatible types for Threads API (Assistants API)
 */

import type { RequestUserContext } from './index';

export interface CreateThreadRequest {
  messages?: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | Array<{
      type: 'text' | 'image_url';
      text?: string;
      image_url?: {
        url: string;
        detail?: 'low' | 'high' | 'auto';
      };
    }>;
    file_ids?: string[];
    metadata?: Record<string, string>;
    tool_call_id?: string; // Required for 'tool' role
    name?: string; // Tool name, used with 'tool' role
  }>;
  metadata?: Record<string, string>;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ModifyThreadRequest {
  threadId: string;
  metadata?: Record<string, string>;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetThreadRequest {
  threadId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteThreadRequest {
  threadId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface CreateMessageRequest {
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
      url: string;
      detail?: 'low' | 'high' | 'auto';
    };
  }>;
  file_ids?: string[];
  metadata?: Record<string, string>;
  tool_call_id?: string; // Required for 'tool' role
  name?: string; // Tool name, used with 'tool' role
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListMessagesRequest {
  threadId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  run_id?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface CreateRunRequest {
  threadId: string;
  assistant_id: string;
  model?: string;
  instructions?: string;
  additional_instructions?: string;
  additional_messages?: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tool_call_id?: string;
    name?: string;
  }>;
  tools?: Array<{
    type: 'code_interpreter' | 'file_search' | 'function';
    function?: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  file_ids?: string[];
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  max_prompt_tokens?: number;
  max_completion_tokens?: number;
  truncation_strategy?: {
    type: 'auto' | 'last_messages';
    last_messages?: number;
  };
  response_format?: 'text' | 'json_object' | { type: 'json_object' };
  stream?: boolean;
  userContext: RequestUserContext;
  requestId: string;
}

export interface Thread {
  id: string;
  object: 'thread';
  created_at: number;
  metadata: Record<string, string>;
}

export interface ThreadMessage {
  id: string;
  object: 'thread.message';
  created_at: number;
  thread_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: Array<{
    type: 'text' | 'image_url';
    text?: {
      value: string;
      annotations?: Array<{
        type: 'file_citation' | 'file_path';
        text: string;
        file_citation?: {
          file_id: string;
          quote: string;
        };
        file_path?: {
          file_id: string;
        };
        start_index: number;
        end_index: number;
      }>;
    };
    image_url?: {
      url: string;
      detail?: 'low' | 'high' | 'auto';
    };
  }>;
  assistant_id?: string;
  run_id?: string;
  file_ids: string[];
  metadata: Record<string, string>;
  tool_call_id?: string; // Present when role is 'tool'
  name?: string; // Tool name, present when role is 'tool'
}

export interface ThreadRun {
  id: string;
  object: 'thread.run';
  created_at: number;
  thread_id: string;
  assistant_id: string;
  status: 'queued' | 'in_progress' | 'requires_action' | 'cancelling' | 'cancelled' | 'failed' | 'completed' | 'expired';
  required_action?: {
    type: 'submit_tool_outputs';
    submit_tool_outputs: {
      tool_calls: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  };
  last_error?: {
    code: string;
    message: string;
  };
  expires_at: number;
  started_at: number | null;
  cancelled_at: number | null;
  failed_at: number | null;
  completed_at: number | null;
  model: string;
  instructions: string;
  tools: Array<{
    type: 'code_interpreter' | 'file_search' | 'function';
    function?: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  file_ids: string[];
  metadata: Record<string, string>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  temperature?: number;
  top_p?: number;
  max_prompt_tokens?: number;
  max_completion_tokens?: number;
}

export interface DeleteThreadResponse {
  id: string;
  object: 'thread.deleted';
  deleted: boolean;
}

export interface ListMessagesResponse {
  messages: ThreadMessage[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

export interface ListRunsRequest {
  threadId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetRunRequest {
  threadId: string;
  runId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListRunsResponse {
  runs: ThreadRun[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

export interface GetMessageRequest {
  threadId: string;
  messageId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ModifyMessageRequest {
  threadId: string;
  messageId: string;
  metadata?: Record<string, string>;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteMessageRequest {
  threadId: string;
  messageId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteMessageResponse {
  id: string;
  object: 'thread.message.deleted';
  deleted: boolean;
}

export interface SubmitToolOutputsRequest {
  threadId: string;
  runId: string;
  tool_outputs: Array<{
    tool_call_id: string;
    output?: string;
    error?: string;
  }>;
  stream?: boolean;
  userContext: RequestUserContext;
  requestId: string;
}

export interface CancelRunRequest {
  threadId: string;
  runId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListRunStepsRequest {
  threadId: string;
  runId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetRunStepRequest {
  threadId: string;
  runId: string;
  stepId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ThreadRunStep {
  id: string;
  object: 'thread.run.step';
  created_at: number;
  run_id: string;
  type: 'message_creation' | 'tool_calls';
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  step_details: {
    type: 'message_creation';
    message_creation?: {
      message_id: string;
    };
  } | {
    type: 'tool_calls';
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  expired_at?: number | null;
  cancelled_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  last_error?: {
    code: string;
    message: string;
  } | null;
  metadata: Record<string, string>;
}

export interface ListRunStepsResponse {
  steps: ThreadRunStep[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

