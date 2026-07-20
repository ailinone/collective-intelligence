// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extended ChatRequest with metadata for API orchestration
 *
 * This interface extends the base ChatRequest to include metadata
 * needed for intelligent model selection and orchestration.
 */

import type { ChatRequest, TaskType } from './index';

/**
 * Extended ChatRequest with orchestration metadata
 */
export interface ChatRequestWithMetadata extends Omit<ChatRequest, 'model'> {
  /**
   * Model to use (from user specification or orchestration)
   */
  model?: string;

  /**
   * Flag indicating if the model was explicitly specified by the user
   * If false, API should delegate model selection to DynamicModelSelector
   */
  user_specified_model?: boolean;

  /**
   * Task type detected by CLI or specified by user
   * Used by API for intelligent model selection
   */
  task_type?: TaskType;

  /**
   * Project metadata provided by CLI/workflows
   */
  project_id?: string;
  projectId?: string;
  workspace_id?: string;
  working_directory?: string;
  workingDirectory?: string;
  workspace_path?: string;

  /**
   * Additional metadata for orchestration
   */
  metadata?: {
    /**
     * Complexity level of the task
     */
    complexity?: 'low' | 'medium' | 'high';

    /**
     * Quality target (0-1)
     */
    quality_target?: number;

    /**
     * Maximum cost allowed
     */
    max_cost?: number;

    /**
     * Preferred speed vs quality
     */
    prefer_speed?: boolean;

    /**
     * Workspace information for tool execution
     */
    working_directory?: string;
    workingDirectory?: string;
    workspace_path?: string;
    workspace_id?: string;

    /**
     * Project identifiers for indexing
     */
    project_id?: string;
    projectId?: string;
    branch?: string;
    repo_url?: string;

    /**
     * Allow future metadata fields without breaking typing
     */
    [key: string]: unknown;
  };
}

/**
 * Type guard to check if request has metadata
 */
export function isChatRequestWithMetadata(
  request: ChatRequest | ChatRequestWithMetadata
): request is ChatRequestWithMetadata {
  return 'user_specified_model' in request || 'task_type' in request || 'metadata' in request;
}

/**
 * Safely get user_specified_model flag
 */
export function getUserSpecifiedModelFlag(request: ChatRequest | ChatRequestWithMetadata): boolean {
  if (isChatRequestWithMetadata(request)) {
    if (request.user_specified_model === true) {
      return true;
    }
  }
  if (typeof request.model === 'string') {
    const normalized = request.model.trim().toLowerCase();
    if (normalized.length > 0 && normalized !== 'auto' && !normalized.startsWith('ailin-')) {
      return true;
    }
  }
  return false;
}

/**
 * Safely get task_type
 */
export function getTaskType(
  request: ChatRequest | ChatRequestWithMetadata
): TaskType | undefined {
  if (isChatRequestWithMetadata(request)) {
    return request.task_type;
  }
  // ChatRequest also has task_type, so check it
  if ('task_type' in request && typeof request.task_type === 'string') {
    return request.task_type as TaskType;
  }
  return undefined;
}
