// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Assistants API Types
 * OpenAI-compatible types for Assistants API
 */

import type { RequestUserContext } from './index';

export interface AssistantTool {
  type: 'code_interpreter' | 'file_search' | 'function';
  function?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CreateAssistantRequest {
  model?: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  tools?: AssistantTool[];
  tool_resources?: {
    code_interpreter?: {
      file_ids: string[];
    };
    file_search?: {
      vector_store_ids?: string[];
      vector_stores?: Array<{
        file_ids: string[];
        name?: string;
      }>;
    };
  };
  metadata?: Record<string, string>;
  temperature?: number | null;
  top_p?: number | null;
  response_format?: 'text' | 'json_object' | { type: 'json_object' } | null;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ModifyAssistantRequest {
  assistantId: string;
  model?: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  tools?: AssistantTool[];
  tool_resources?: {
    code_interpreter?: {
      file_ids: string[];
    };
    file_search?: {
      vector_store_ids?: string[];
      vector_stores?: Array<{
        file_ids: string[];
        name?: string;
      }>;
    };
  };
  metadata?: Record<string, string>;
  temperature?: number | null;
  top_p?: number | null;
  response_format?: 'text' | 'json_object' | { type: 'json_object' } | null;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetAssistantRequest {
  assistantId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteAssistantRequest {
  assistantId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListAssistantsRequest {
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface Assistant {
  id: string;
  object: 'assistant';
  created_at: number;
  name: string | null;
  description: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  tool_resources?: {
    code_interpreter?: {
      file_ids: string[];
    };
    file_search?: {
      vector_store_ids?: string[];
      vector_stores?: Array<{
        id: string;
        object: 'vector_store';
        created_at: number;
        name?: string;
        file_counts: {
          in_progress: number;
          completed: number;
          failed: number;
          cancelled: number;
        };
        status: 'expired' | 'in_progress' | 'completed';
        expires_after?: {
          anchor: 'last_active_at';
          days: number;
        };
        expires_at?: number;
        last_active_at?: number;
        metadata?: Record<string, string>;
      }>;
    };
  };
  metadata: Record<string, string>;
  temperature?: number | null;
  top_p?: number | null;
  response_format?: 'text' | 'json_object' | { type: 'json_object' } | null;
}

export interface DeleteAssistantResponse {
  id: string;
  object: 'assistant';
  deleted: boolean;
}

export interface ListAssistantsResponse {
  assistants: Assistant[];
  has_more: boolean;
}

// ============================================
// Assistants Files
// ============================================

export interface CreateAssistantFileRequest {
  assistantId: string;
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetAssistantFileRequest {
  assistantId: string;
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListAssistantFilesRequest {
  assistantId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteAssistantFileRequest {
  assistantId: string;
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface AssistantFile {
  id: string;
  object: 'assistant.file';
  created_at: number;
  assistant_id: string;
}

export interface ListAssistantFilesResponse {
  data: AssistantFile[];
  object: 'list';
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}

export interface DeleteAssistantFileResponse {
  id: string;
  object: 'assistant.file.deleted';
  deleted: boolean;
}

// ============================================
// Vector Stores
// ============================================

export interface VectorStore {
  id: string;
  object: 'vector_store';
  created_at: number;
  name?: string;
  usage_bytes?: number;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  status: 'expired' | 'in_progress' | 'completed';
  expires_after?: {
    anchor: 'last_active_at';
    days: number;
  };
  expires_at?: number;
  last_active_at?: number;
  metadata: Record<string, string>;
}

export interface CreateVectorStoreRequest {
  name?: string;
  file_ids?: string[];
  expires_after?: {
    anchor: 'last_active_at';
    days: number;
  };
  metadata?: Record<string, string>;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ModifyVectorStoreRequest {
  vectorStoreId: string;
  name?: string | null;
  expires_after?: {
    anchor: 'last_active_at';
    days: number;
  } | null;
  metadata?: Record<string, string>;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetVectorStoreRequest {
  vectorStoreId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListVectorStoresRequest {
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteVectorStoreRequest {
  vectorStoreId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListVectorStoresResponse {
  object: 'list';
  data: VectorStore[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}

export interface DeleteVectorStoreResponse {
  id: string;
  object: 'vector_store.deleted';
  deleted: boolean;
}

export interface VectorStoreFile {
  id: string;
  object: 'vector_store.file';
  created_at: number;
  vector_store_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
}

export interface CreateVectorStoreFileRequest {
  vectorStoreId: string;
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetVectorStoreFileRequest {
  vectorStoreId: string;
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListVectorStoreFilesRequest {
  vectorStoreId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
  filter?: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteVectorStoreFileRequest {
  vectorStoreId: string;
  fileId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListVectorStoreFilesResponse {
  object: 'list';
  data: VectorStoreFile[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}

export interface DeleteVectorStoreFileResponse {
  id: string;
  object: 'vector_store.file.deleted';
  deleted: boolean;
}

export interface SearchVectorStoreRequest {
  vectorStoreId: string;
  query: string;
  top_k?: number;
  /** Optional restriction to specific file ids within the store. */
  file_ids?: string[];
  userContext: RequestUserContext;
  requestId: string;
}

export interface VectorStoreSearchResultContent {
  type: 'text';
  text: string;
}

export interface VectorStoreSearchResult {
  file_id: string;
  /** Cosine similarity in [0,1] (1 = identical). */
  score: number;
  content: VectorStoreSearchResultContent[];
  chunk_index: number;
  metadata: Record<string, unknown>;
}

export interface SearchVectorStoreResponse {
  object: 'vector_store.search_results';
  search_query: string;
  data: VectorStoreSearchResult[];
  has_more: boolean;
  next_page: string | null;
}

