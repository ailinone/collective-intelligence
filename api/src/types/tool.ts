// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool Types
 * Types for tool execution and results
 */

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  tool_call_id?: string;
  /**
   * Media/document artifact produced by this tool call (e.g. an image or
   * video generation tool). Same shape as
   * `advanced-tool-execution-service.ToolResult.artifact` / `ArtifactRef`
   * (`@/types`), so a value set here is structurally assignable there
   * without a cast once the tool-registry executor reads it back off the
   * object a handler returns.
   */
  artifact?: {
    type: 'image' | 'video' | 'audio' | 'document' | 'file';
    url: string;
    mimeType?: string;
    meta?: Record<string, unknown>;
  };
}
