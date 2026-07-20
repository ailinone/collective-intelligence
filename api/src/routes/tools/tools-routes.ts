// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tools API Routes
 * REST endpoints for executing development tools
 * 
 * Uses a simplified approach with argument adapters to handle
 * snake_case (API) to camelCase (internal) conversion.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import { logger } from '@/utils/logger';
import { authenticate, requireRole } from '@/middleware/auth-middleware';
import { nanoid } from 'nanoid';
import { JinaToolsService, type JinaToolName } from '@/services/jina-tools-service';
import {
  executeSearchReplaceTool,
  executeGrepSearchTool,
  executeListDirectoryTool,
  executeCodebaseSearchTool,
  executeApplyMultiFileChangesTool,
  executeBatchSearchReplaceTool,
  executeGitStatusTool,
  executeGitCommitTool,
  executeGitDiffTool,
  executeGitPushTool,
  executeGitPullTool,
  executeGitCreateBranchTool,
  executeGitMergeTool,
  executeGitRebaseTool,
  executeCreateTodoTool,
  executeUpdateTodoTool,
  executeCheckTodoTool,
  executeListTodosTool,
  executeWebSearchTool,
  executeFindSymbolReferencesTool,
  executeAnalyzeCodebaseTool,
  executeGetDependencyGraphTool,
  executeSemanticSearchTool,
  type ToolExecutionContext,
  type ToolResult,
} from '@/services/tool-execution-service';
import {
  executeExtractFunctionTool,
  executeRenameSymbolTool,
  executeExtractVariableTool,
  executeInlineFunctionTool,
  executeHealFileTool,
  executeDetectErrorsTool,
  executeValidateCodeTool,
  executeGenerateTestsTool,
  executeAnalyzeImageTool,
  executeCompareImagesTool,
  executeExtractCodeFromScreenshotTool,
  executeFileSearchTool,
  executeExecuteWorkflowTool,
  executeListWorkflowsTool,
  executeRegisterWorkflowTool,
  executeExploreCodebaseTool,
  executeGitResolveConflictTool,
} from '@/services/advanced-tool-execution-service';

// ============================================
// Common Response Schema
// ============================================

const toolResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', description: 'Whether the tool execution succeeded' },
    tool_call_id: { type: 'string', description: 'Unique identifier for this tool call' },
    output: { type: 'string', description: 'Output from tool execution', nullable: true },
    error: { type: 'string', description: 'Error message if execution failed', nullable: true },
    metadata: { type: 'object', additionalProperties: true, description: 'Additional metadata about execution' },
  },
  required: ['success', 'tool_call_id'],
};

// Permissive error response schema: the handler emits the tool-shape
// `{success, tool_call_id, error, metadata}`, but Fastify's built-in body
// validation rejects requests BEFORE the handler runs and emits the default
// error shape `{statusCode, code, error, message}`. Without
// `additionalProperties: true` and without dropping `required`, fast-json-stringify
// throws `FST_ERR_FAILED_ERROR_SERIALIZATION` on every validation failure,
// turning the route into a 500. This schema documents the tool-shape for OpenAPI
// while still allowing Fastify-shape validation errors to pass through.
const toolErrorResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    success: { type: 'boolean', description: 'Whether the tool execution succeeded' },
    tool_call_id: { type: 'string', description: 'Unique identifier for this tool call' },
    error: { description: 'Error message or details (string for tool failures, object for validation errors)' },
    metadata: { type: 'object', additionalProperties: true, description: 'Additional metadata about execution' },
    // Fastify default error envelope (emitted on body/query/params validation failures):
    statusCode: { type: 'number', description: 'HTTP status code (Fastify validation error envelope)' },
    code: { type: 'string', description: 'Fastify error code (e.g. FST_ERR_VALIDATION)' },
    message: { type: 'string', description: 'Human-readable error description' },
  },
};

// ============================================
// Types
// ============================================

interface ToolRequestBody {
  working_directory?: string;
  [key: string]: unknown;
}

const jinaToolsService = new JinaToolsService();

// ============================================
// Helper Functions
// ============================================

/**
 * SECURITY: server-controlled base for tool filesystem/shell operations.
 *
 * Tool executors run git and file operations under `context.workingDirectory`.
 * That value was taken VERBATIM from the client request body, so a caller could
 * point any tool at an arbitrary absolute path on the host (`/etc`, another
 * tenant's checkout, …). We clamp the client-supplied `working_directory` to a
 * server-configured base (TOOLS_BASE_DIR, default = the process cwd): the value
 * is resolved relative to the base and rejected if it escapes the base via `..`
 * or an absolute path that lands outside it. This does not weaken the admin/owner
 * RBAC gate added on the routes — it is defense-in-depth on top of it.
 */
function getToolsBaseDir(): string {
  const configured = process.env.TOOLS_BASE_DIR;
  return path.resolve(configured && configured.length > 0 ? configured : process.cwd());
}

/**
 * Resolve a client-supplied working_directory against the server base, refusing
 * anything that escapes the base. Returns the safe absolute path (the base
 * itself when no/invalid value is supplied).
 */
export function clampWorkingDirectory(baseDir: string, requested: unknown): string {
  const base = path.resolve(baseDir);
  if (typeof requested !== 'string' || requested.length === 0) {
    return base;
  }
  // Resolve relative to the base (absolute `requested` overrides base on
  // resolve, which is exactly the escape we then detect below).
  const resolved = path.resolve(base, requested);
  const rel = path.relative(base, resolved);
  // `rel` starting with '..' (or being an absolute path on a different drive)
  // means the target is outside the base — reject by falling back to the base.
  const escapes = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  if (escapes) {
    logger.warn(
      { requested, base, resolved },
      'Tool working_directory escapes the allowed base — clamping to base',
    );
    return base;
  }
  return resolved;
}

function createContext(request: FastifyRequest): ToolExecutionContext {
  const baseDir = getToolsBaseDir();
  let requested: unknown;
  if (request.body && typeof request.body === 'object' && request.body !== null) {
    const body = request.body as Record<string, unknown>;
    requested = body.working_directory;
  }
  return {
    workingDirectory: clampWorkingDirectory(baseDir, requested),
    log: logger,
  };
}

// Type-safe property extraction helpers
function getStringProperty(obj: ToolRequestBody, key: string, defaultValue = ''): string {
  const value = obj[key];
  return typeof value === 'string' ? value : defaultValue;
}

function getOptionalStringProperty(obj: ToolRequestBody, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function getBooleanProperty(obj: ToolRequestBody, key: string, defaultValue = false): boolean {
  const value = obj[key];
  return typeof value === 'boolean' ? value : defaultValue;
}

function getOptionalBooleanProperty(obj: ToolRequestBody, key: string): boolean | undefined {
  const value = obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getNumberProperty(obj: ToolRequestBody, key: string, defaultValue = 0): number {
  const value = obj[key];
  return typeof value === 'number' ? value : defaultValue;
}

function getOptionalNumberProperty(obj: ToolRequestBody, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function getErrorStatusCode(error: unknown): number {
  if (!error || typeof error !== 'object') {
    return 500;
  }

  const record = error as Record<string, unknown>;
  const statusCode = typeof record.statusCode === 'number'
    ? record.statusCode
    : typeof record.status === 'number'
      ? record.status
      : undefined;

  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
    return statusCode;
  }

  return 500;
}

function getErrorMetadata(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }

  return undefined;
}

// Generic tool executor that handles snake_case to camelCase conversion
async function executeTool<TArgs>(
  request: FastifyRequest,
  reply: FastifyReply,
  toolName: string,
  executor: (args: TArgs, id: string, ctx: ToolExecutionContext) => Promise<ToolResult>,
  argAdapter: (body: ToolRequestBody) => TArgs
): Promise<FastifyReply> {
  const toolCallId = nanoid();
  const context = createContext(request);
  const startTime = Date.now();
  
  context.log.info({ toolName, toolCallId }, 'Tool execution started');
  
  try {
    // Apply argument adapter - always required for type safety
    if (!request.body || typeof request.body !== 'object') {
      return reply.status(400).send({
        success: false,
        tool_call_id: toolCallId,
        error: 'Request body must be an object',
        metadata: { duration_ms: Date.now() - startTime, tool_name: toolName },
      });
    }
    
    const body = request.body as ToolRequestBody;
    const args = argAdapter(body);
    const result = await executor(args, toolCallId, context);
    const duration = Date.now() - startTime;
    
    context.log.info({ toolName, toolCallId, duration, success: result.success }, 'Tool execution completed');
    
    return reply.send({
      ...result,
      metadata: {
        ...(result.metadata || {}),
        duration_ms: duration,
        tool_name: toolName,
      },
    });
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = getErrorStatusCode(error);
    const errorMetadata = getErrorMetadata(error);
    context.log.error({ toolName, toolCallId, duration, error: errorMessage }, 'Tool execution failed');
    
    return reply.status(statusCode).send({
      success: false,
      tool_call_id: toolCallId,
      error: errorMessage,
      metadata: {
        ...(errorMetadata || {}),
        duration_ms: duration,
        tool_name: toolName,
      },
    });
  }
}

async function executeJinaToolExecutor(
  toolName: JinaToolName,
  args: Record<string, unknown>,
  toolCallId: string
): Promise<ToolResult> {
  return jinaToolsService.executeTool({
    toolName,
    payload: args,
    toolCallId,
  });
}

// ============================================
// Route Registration
// ============================================

export async function registerToolsRoutes(rootServer: FastifyInstance): Promise<void> {
  const log = logger.child({ service: 'tools-routes' });

  // ════════════════════════════════════════════════════════════════════════
  // SECURITY (RBAC + RCE surface reduction): the /v1/tools/* endpoints execute
  // shell commands (git push/commit/merge/rebase/pull) and arbitrary filesystem
  // operations under a client-controlled `working_directory`. Previously they
  // ran with ONLY the global api-key auth — any authenticated tenant could
  // drive the executors. We restrict the entire tool surface to admin/owner
  // principals.
  //
  // Mechanism: register all tool routes inside an ENCAPSULATED Fastify child
  // context (`rootServer.register(...)`) and attach the auth preHandler as a
  // scoped hook. Encapsulation guarantees the hook applies to every tool route
  // exactly once and does NOT leak to sibling routes on the root instance —
  // which a bare `server.addHook` on the root would. The inner plugin parameter
  // is intentionally named `server` so the ~47 `server.post('/v1/tools/...')`
  // route registrations below bind to the scoped instance unchanged.
  //
  // TODO(tools-rbac): if a future product requirement needs a non-admin subset
  // of read-only tools (e.g. grep/list_directory) exposed to regular tenants,
  // split those into a SEPARATE child plugin with a softer guard rather than
  // weakening this one. The shell/FS executors must stay admin-gated.
  await rootServer.register(async (server: FastifyInstance) => {
    server.addHook('preHandler', authenticate);
    server.addHook('preHandler', requireRole('admin', 'owner'));

  // ==========================================
  // File Operations
  // ==========================================

  server.post('/v1/tools/search-replace', {
    schema: {
      tags: ['Tools - File Operations'],
      summary: 'Search and replace in file',
      description: 'Search for text in a file and replace it with new text. Supports single or multiple replacements.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file_path', 'old_string', 'new_string'],
        properties: {
          file_path: { type: 'string', description: 'Path to the file to modify' },
          old_string: { type: 'string', description: 'Text to search for' },
          new_string: { type: 'string', description: 'Text to replace with' },
          replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences (default: false, replaces first only)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Search and replace completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid input)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'search_replace', executeSearchReplaceTool, (body: ToolRequestBody) => {
    // Type-safe extraction with validation
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const file_path = typeof body.file_path === 'string' ? body.file_path : '';
    const old_string = typeof body.old_string === 'string' ? body.old_string : '';
    const new_string = typeof body.new_string === 'string' ? body.new_string : '';
    const replace_all = typeof body.replace_all === 'boolean' ? body.replace_all : false;
    
    return {
      file_path,
      search: old_string,
      replace: new_string,
      all: replace_all,
    };
  }));

  server.post('/v1/tools/grep', {
    schema: {
      tags: ['Tools - File Operations'],
      summary: 'Search for pattern in files',
      description: 'Search for a text pattern in files using regex. Supports filtering by file patterns and case sensitivity.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', default: '.', description: 'Directory path to search in' },
          include: { type: 'array', items: { type: 'string' }, description: 'File patterns to include (e.g., ["*.ts", "*.js"])' },
          case_sensitive: { type: 'boolean', default: false, description: 'Case-sensitive search' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Search completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid pattern or path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'grep', executeGrepSearchTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const pattern = typeof body.pattern === 'string' ? body.pattern : '';
    const path = typeof body.path === 'string' ? body.path : '.';
    const include = Array.isArray(body.include) ? body.include.filter((i): i is string => typeof i === 'string') : undefined;
    const case_sensitive = typeof body.case_sensitive === 'boolean' ? body.case_sensitive : false;
    
    return {
      pattern,
      path,
      include,
      case_sensitive,
    };
  }));

  server.post('/v1/tools/list-directory', {
    schema: {
      tags: ['Tools - File Operations'],
      summary: 'List directory contents',
      description: 'List files and directories in a specified path. Supports recursive listing and hidden files.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          path: { type: 'string', default: '.', description: 'Directory path to list' },
          recursive: { type: 'boolean', default: false, description: 'List recursively' },
          show_hidden: { type: 'boolean', default: false, description: 'Include hidden files and directories' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Directory listing retrieved successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'list_directory', executeListDirectoryTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const path = typeof body.path === 'string' ? body.path : '.';
    const recursive = typeof body.recursive === 'boolean' ? body.recursive : false;
    const show_hidden = typeof body.show_hidden === 'boolean' ? body.show_hidden : false;
    
    return {
      path,
      recursive,
      include_hidden: show_hidden,
    };
  }));

  server.post('/v1/tools/file-search', {
    schema: {
      tags: ['Tools - File Operations'],
      summary: 'Search for files by pattern',
      description: 'Search for files by name or content pattern. Supports searching by filename, content, or both.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Pattern to search for (filename or content)' },
          directory: { type: 'string', description: 'Directory to search in' },
          file_type: { type: 'string', enum: ['name', 'content', 'both'], description: 'Search type: name, content, or both' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'File search completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid pattern)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'file_search', executeFileSearchTool, (body: ToolRequestBody) => {
    // Type-safe extraction with validation
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const pattern = typeof body.pattern === 'string' ? body.pattern : '';
    const directory = typeof body.directory === 'string' ? body.directory : undefined;
    const file_type = typeof body.file_type === 'string' ? body.file_type : undefined;
    const type = (file_type === 'name' || file_type === 'content' || file_type === 'both') 
      ? file_type as 'name' | 'content' | 'both'
      : undefined;
    
    return {
      pattern,
      path: directory,
      type,
    };
  }));

  // ==========================================
  // Batch Operations
  // ==========================================

  server.post('/v1/tools/batch-search-replace', {
    schema: {
      tags: ['Tools - Batch Operations'],
      summary: 'Batch search and replace',
      description: 'Perform search and replace operations across multiple files in a single request.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['changes'],
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['file_path', 'old_string', 'new_string'],
              properties: {
                file_path: { type: 'string', description: 'Path to the file to modify' },
                old_string: { type: 'string', description: 'Text to search for' },
                new_string: { type: 'string', description: 'Text to replace with' },
              },
            },
            description: 'Array of changes to apply',
          },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Batch search and replace completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid changes)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'batch_search_replace', executeBatchSearchReplaceTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const changes = Array.isArray(body.changes) ? body.changes : [];
    const validChanges = changes.filter((c): c is { file_path?: string; old_string?: string; new_string?: string } => 
      typeof c === 'object' && c !== null
    );
    
    return {
      files: validChanges.map((c) => typeof c.file_path === 'string' ? c.file_path : ''),
      search: validChanges[0] && typeof validChanges[0].old_string === 'string' ? validChanges[0].old_string : '',
      replace: validChanges[0] && typeof validChanges[0].new_string === 'string' ? validChanges[0].new_string : '',
    };
  }));

  server.post('/v1/tools/apply-multi-file-changes', {
    schema: {
      tags: ['Tools - Batch Operations'],
      summary: 'Apply changes to multiple files',
      description: 'Apply create, update, or delete operations to multiple files in a single request.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['files'],
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'operation'],
              properties: {
                path: { type: 'string', description: 'File path' },
                content: { type: 'string', description: 'File content (required for create/update operations)' },
                operation: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Operation to perform' },
              },
            },
            description: 'Array of file changes to apply',
          },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Multi-file changes applied successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid files or operations)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'apply_multi_file_changes', executeApplyMultiFileChangesTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const files = Array.isArray(body.files) ? body.files : [];
    const validFiles = files.filter((f): f is { path?: string; operation?: string; content?: string } => 
      typeof f === 'object' && f !== null
    );
    const changes = validFiles.map((f) => ({
      file_path: typeof f.path === 'string' ? f.path : '',
      operation: (typeof f.operation === 'string' && (f.operation === 'create' || f.operation === 'update' || f.operation === 'delete')) 
        ? f.operation 
        : 'update' as 'create' | 'update' | 'delete',
      new_content: typeof f.content === 'string' ? f.content : '',
    }));
    
    return {
      changes,
    };
  }));

  // ==========================================
  // Git Operations
  // ==========================================

  server.post('/v1/tools/git/status', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Get Git status',
      description: 'Get the status of the Git repository, including staged, modified, and untracked files.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git status retrieved successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (not a Git repository)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => {
    // executeGitStatusTool has different signature (no args)
    const toolCallId = nanoid();
    const context = createContext(request);
    const startTime = Date.now();
    try {
      const result = await executeGitStatusTool(toolCallId, context);
      return reply.send({ ...result, metadata: { duration_ms: Date.now() - startTime, tool_name: 'git_status' } });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorResponse = {
        success: false, 
        tool_call_id: toolCallId,
        error: errorMessage,
        metadata: { duration_ms: Date.now() - startTime, tool_name: 'git_status' },
      };
      reply.statusCode = 500;
      return reply.send(errorResponse);
    }
  });

  server.post('/v1/tools/git/commit', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Create Git commit',
      description: 'Create a Git commit with the specified message and files. Supports staging all files or specific files.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', description: 'Commit message' },
          files: { type: 'array', items: { type: 'string' }, description: 'Specific files to commit (if not provided, uses staged files)' },
          all: { type: 'boolean', default: false, description: 'Stage all files before committing' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git commit created successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid message or no files to commit)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_commit', executeGitCommitTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const files = Array.isArray(body.files) 
      ? body.files.filter((f): f is string => typeof f === 'string')
      : undefined;
    return {
      message: getStringProperty(body, 'message'),
      files,
    };
  }));

  server.post('/v1/tools/git/diff', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Get Git diff',
      description: 'Get the diff of changes in the Git repository. Supports staged, unstaged, or specific commit diffs.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          ref: { type: 'string', description: 'Git reference (commit hash, branch, etc.) to compare against' },
          staged: { type: 'boolean', default: false, description: 'Show staged changes' },
          file: { type: 'string', description: 'Specific file to show diff for' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git diff retrieved successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid reference or file)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_diff', executeGitDiffTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const files = typeof body.file === 'string' 
      ? [body.file]
      : (Array.isArray(body.files) 
          ? body.files.filter((f): f is string => typeof f === 'string')
          : undefined);
    return {
      files,
      staged: getBooleanProperty(body, 'staged', false),
    };
  }));

  server.post('/v1/tools/git/push', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Push to remote',
      description: 'Push commits to a remote Git repository. Supports force push and setting upstream branch.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          remote: { type: 'string', default: 'origin', description: 'Remote repository name' },
          branch: { type: 'string', description: 'Branch to push (defaults to current branch)' },
          force: { type: 'boolean', default: false, description: 'Force push (overwrites remote history)' },
          set_upstream: { type: 'boolean', default: false, description: 'Set upstream tracking branch' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git push completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid remote or branch)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_push', executeGitPushTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      remote: getOptionalStringProperty(body, 'remote'),
      branch: getOptionalStringProperty(body, 'branch'),
      force: getBooleanProperty(body, 'force', false),
      set_upstream: getOptionalBooleanProperty(body, 'set_upstream'),
    };
  }));

  server.post('/v1/tools/git/pull', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Pull from remote',
      description: 'Pull changes from a remote Git repository. Supports merge or rebase strategies.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          remote: { type: 'string', default: 'origin', description: 'Remote repository name' },
          branch: { type: 'string', description: 'Branch to pull (defaults to current branch)' },
          rebase: { type: 'boolean', default: false, description: 'Use rebase instead of merge' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git pull completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (conflict or invalid remote)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_pull', executeGitPullTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      remote: getOptionalStringProperty(body, 'remote'),
      branch: getOptionalStringProperty(body, 'branch'),
      rebase: getBooleanProperty(body, 'rebase', false),
    };
  }));

  server.post('/v1/tools/git/create-branch', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Create Git branch',
      description: 'Create a new Git branch from the current branch or specified starting point.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['branch_name'],
        properties: {
          branch_name: { type: 'string', description: 'Name of the new branch' },
          from: { type: 'string', description: 'Starting point (branch, commit, or tag). Defaults to current branch.' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git branch created successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (branch already exists or invalid name)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_create_branch', executeGitCreateBranchTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      name: getStringProperty(body, 'branch_name'),
      from: getOptionalStringProperty(body, 'from'),
    };
  }));

  server.post('/v1/tools/git/merge', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Merge Git branch',
      description: 'Merge a branch into the current branch. Supports fast-forward, no-ff, and squash merge strategies.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['branch'],
        properties: {
          branch: { type: 'string', description: 'Branch to merge into current branch' },
          no_ff: { type: 'boolean', default: false, description: 'Create a merge commit even if fast-forward is possible' },
          squash: { type: 'boolean', default: false, description: 'Squash merge (combine commits into one)' },
          message: { type: 'string', description: 'Custom merge commit message' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git merge completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (merge conflict or invalid branch)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_merge', executeGitMergeTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      branch: getStringProperty(body, 'branch'),
      no_fast_forward: getBooleanProperty(body, 'no_ff', false),
      squash: getOptionalBooleanProperty(body, 'squash'),
      message: getOptionalStringProperty(body, 'message'),
    };
  }));

  server.post('/v1/tools/git/rebase', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Rebase Git branch',
      description: 'Rebase the current branch onto another branch. Supports interactive rebase and conflict resolution.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['branch'],
        properties: {
          branch: { type: 'string', description: 'Branch to rebase onto' },
          interactive: { type: 'boolean', default: false, description: 'Use interactive rebase' },
          abort: { type: 'boolean', default: false, description: 'Abort ongoing rebase' },
          continue: { type: 'boolean', default: false, description: 'Continue rebase after resolving conflicts' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git rebase completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (rebase conflict or invalid branch)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_rebase', executeGitRebaseTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      branch: getStringProperty(body, 'branch'),
      interactive: getBooleanProperty(body, 'interactive', false),
      abort: getOptionalBooleanProperty(body, 'abort'),
      continue_rebase: getOptionalBooleanProperty(body, 'continue'),
    };
  }));

  server.post('/v1/tools/git/resolve-conflict', {
    schema: {
      tags: ['Tools - Git'],
      summary: 'Resolve Git conflict',
      description: 'Resolve merge or rebase conflicts in a file. Supports automatic resolution (ours/theirs) or manual content.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file', 'resolution'],
        properties: {
          file: { type: 'string', description: 'Path to the conflicted file' },
          resolution: { type: 'string', enum: ['ours', 'theirs', 'manual'], description: 'Resolution strategy: ours (accept current), theirs (accept incoming), or manual (use custom content)' },
          manual_content: { type: 'string', description: 'Custom content for manual resolution (required when resolution is "manual")' },
          working_directory: { type: 'string', description: 'Working directory for Git repository' },
        },
      },
      response: {
        200: {
          description: 'Git conflict resolved successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file or resolution strategy)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'git_resolve_conflict', executeGitResolveConflictTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const file = getStringProperty(body, 'file');
    const resolutionValue = getStringProperty(body, 'resolution');
    const resolution = (resolutionValue === 'ours' || resolutionValue === 'theirs' || resolutionValue === 'manual')
      ? resolutionValue as 'ours' | 'theirs' | 'manual'
      : 'manual' as const;
    
    return {
      filePath: file,
      resolution,
      manualContent: getOptionalStringProperty(body, 'manual_content'),
    };
  }));

  // ==========================================
  // Code Analysis
  // ==========================================

  server.post('/v1/tools/codebase-search', {
    schema: {
      tags: ['Tools - Code Analysis'],
      summary: 'Search codebase',
      description: 'Search for code patterns, functions, classes, or text across the codebase. Supports file pattern filtering and context inclusion.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query (text pattern, function name, class name, etc.)' },
          path: { type: 'string', default: '.', description: 'Directory path to search in' },
          max_results: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Maximum number of results to return' },
          file_pattern: { type: 'string', description: 'File pattern filter (e.g., "*.ts", "*.js")' },
          include_context: { type: 'boolean', default: false, description: 'Include surrounding code context in results' },
          context_lines: { type: 'integer', minimum: 0, maximum: 50, default: 3, description: 'Number of context lines to include' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Codebase search completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid query or path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'codebase_search', executeCodebaseSearchTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      query: getStringProperty(body, 'query'),
      file_pattern: getOptionalStringProperty(body, 'file_pattern'),
      max_results: getOptionalNumberProperty(body, 'max_results'),
      include_context: getBooleanProperty(body, 'include_context', false),
      context_lines: getOptionalNumberProperty(body, 'context_lines'),
    };
  }));

  server.post('/v1/tools/semantic-search', {
    schema: {
      tags: ['Tools - Code Analysis'],
      summary: 'Semantic code search',
      description: 'Perform semantic search across the codebase using AI-powered understanding. Finds code based on meaning and intent rather than exact text matches.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Semantic search query describing what you want to find' },
          file_types: { type: 'array', items: { type: 'string' }, description: 'Filter by file extensions (e.g., ["ts", "js"])' },
          max_results: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum number of results to return' },
          project_id: { type: 'string', description: 'Project ID for project-specific search' },
          branch: { type: 'string', description: 'Git branch to search in' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Semantic search completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid query)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'semantic_search', executeSemanticSearchTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      query: getStringProperty(body, 'query'),
      limit: getOptionalNumberProperty(body, 'max_results'),
      project_id: getOptionalStringProperty(body, 'project_id'),
      branch: getOptionalStringProperty(body, 'branch'),
    };
  }));

  server.post('/v1/tools/find-symbol-references', {
    schema: {
      tags: ['Tools - Code Analysis'],
      summary: 'Find symbol references',
      description: 'Find all references to a symbol (function, class, variable) across the codebase. Useful for refactoring and understanding code usage.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['symbol'],
        properties: {
          symbol: { type: 'string', description: 'Symbol name to find references for' },
          file_path: { type: 'string', description: 'Optional file path to limit search scope' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Symbol references found successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid symbol name)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'find_symbol_references', executeFindSymbolReferencesTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      symbol_name: getStringProperty(body, 'symbol'),
      file_path: getOptionalStringProperty(body, 'file_path'),
    };
  }));

  server.post('/v1/tools/analyze-codebase', {
    schema: {
      tags: ['Tools - Code Analysis'],
      summary: 'Analyze codebase',
      description: 'Perform comprehensive analysis of the codebase structure, including statistics, symbols, dependencies, and architecture insights.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          path: { type: 'string', default: '.', description: 'Directory path to analyze' },
          depth: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Analysis depth level' },
          project_id: { type: 'string', description: 'Project ID for project-specific analysis' },
          branch: { type: 'string', description: 'Git branch to analyze' },
          include_stats: { type: 'boolean', default: true, description: 'Include code statistics (lines, files, etc.)' },
          include_symbols: { type: 'boolean', default: true, description: 'Include symbol information (functions, classes, etc.)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Codebase analysis completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'analyze_codebase', executeAnalyzeCodebaseTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      project_id: getOptionalStringProperty(body, 'project_id'),
      branch: getOptionalStringProperty(body, 'branch'),
      include_stats: getBooleanProperty(body, 'include_stats', true),
      include_symbols: getBooleanProperty(body, 'include_symbols', true),
    };
  }));

  server.post('/v1/tools/dependency-graph', {
    schema: {
      tags: ['Tools - Code Analysis'],
      summary: 'Get dependency graph',
      description: 'Generate a dependency graph showing relationships between files, modules, and symbols. Useful for understanding code architecture and impact analysis.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          file_path: { type: 'string', description: 'File path to analyze dependencies for' },
          entry_point: { type: 'string', description: 'Entry point file or module (alternative to file_path)' },
          symbol_name: { type: 'string', description: 'Specific symbol to trace dependencies for' },
          depth: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Maximum depth of dependency traversal' },
          project_id: { type: 'string', description: 'Project ID for project-specific analysis' },
          branch: { type: 'string', description: 'Git branch to analyze' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Dependency graph generated successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file path or entry point)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'dependency_graph', executeGetDependencyGraphTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      file_path: getOptionalStringProperty(body, 'file_path') || getOptionalStringProperty(body, 'entry_point'),
      symbol_name: getOptionalStringProperty(body, 'symbol_name'),
      depth: getOptionalNumberProperty(body, 'depth') || 10,
      project_id: getOptionalStringProperty(body, 'project_id'),
      branch: getOptionalStringProperty(body, 'branch'),
    };
  }));

  server.post('/v1/tools/explore-codebase', {
    schema: {
      tags: ['Tools - Code Analysis'],
      summary: 'Explore codebase structure',
      description: 'Explore and understand the codebase structure, including directory tree, file organization, and high-level architecture.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          path: { type: 'string', default: '.', description: 'Directory path to explore' },
          depth: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Exploration depth level' },
          include_stats: { type: 'boolean', default: true, description: 'Include statistics for each directory' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Codebase exploration completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'explore_codebase', executeExploreCodebaseTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      path: getOptionalStringProperty(body, 'path'),
      depth: getOptionalNumberProperty(body, 'depth'),
      includeStats: getBooleanProperty(body, 'include_stats', true),
    };
  }));

  // ==========================================
  // Refactoring Tools
  // ==========================================

  server.post('/v1/tools/extract-function', {
    schema: {
      tags: ['Tools - Refactoring'],
      summary: 'Extract function',
      description: 'Extract a code block into a new function. Refactors code to improve modularity and reusability.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file_path', 'start_line', 'end_line', 'function_name'],
        properties: {
          file_path: { type: 'string', description: 'Path to the file containing the code to extract' },
          start_line: { type: 'integer', minimum: 1, description: 'Starting line number of code block' },
          end_line: { type: 'integer', minimum: 1, description: 'Ending line number of code block' },
          function_name: { type: 'string', description: 'Name for the extracted function' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Function extracted successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file path or line numbers)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'extract_function', executeExtractFunctionTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const functionName = getOptionalStringProperty(body, 'function_name');
    if (!functionName) {
      throw new Error('function_name is required');
    }
    return {
      filePath: getStringProperty(body, 'file_path'),
      startLine: getNumberProperty(body, 'start_line'),
      endLine: getNumberProperty(body, 'end_line'),
      functionName,
    };
  }));

  server.post('/v1/tools/rename-symbol', {
    schema: {
      tags: ['Tools - Refactoring'],
      summary: 'Rename symbol',
      description: 'Rename a symbol (function, class, variable) across the codebase. Automatically updates all references.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['old_name', 'new_name'],
        properties: {
          file_path: { type: 'string', description: 'Optional file path to limit rename scope' },
          old_name: { type: 'string', description: 'Current symbol name' },
          new_name: { type: 'string', description: 'New symbol name' },
          scope: { type: 'string', description: 'Rename scope (file, project, etc.)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Symbol renamed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid symbol names or conflict)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'rename_symbol', executeRenameSymbolTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const file_path = getOptionalStringProperty(body, 'file_path');
    return {
      oldName: getStringProperty(body, 'old_name'),
      newName: getStringProperty(body, 'new_name'),
      files: file_path ? [file_path] : [],
    };
  }));

  server.post('/v1/tools/extract-variable', {
    schema: {
      tags: ['Tools - Refactoring'],
      summary: 'Extract variable',
      description: 'Extract a code expression into a new variable. Improves code readability and maintainability.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file_path', 'start_line', 'variable_name'],
        properties: {
          file_path: { type: 'string', description: 'Path to the file containing the code' },
          start_line: { type: 'integer', minimum: 1, description: 'Line number where the expression is located' },
          end_line: { type: 'integer', minimum: 1, description: 'Optional ending line number for multi-line expressions' },
          variable_name: { type: 'string', description: 'Name for the extracted variable' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Variable extracted successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file path or line numbers)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'extract_variable', executeExtractVariableTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const variableName = getOptionalStringProperty(body, 'variable_name');
    if (!variableName) {
      throw new Error('variable_name is required');
    }
    return {
      filePath: getStringProperty(body, 'file_path'),
      line: getNumberProperty(body, 'start_line'),
      startColumn: 0,
      endColumn: 100,
      variableName,
    };
  }));

  server.post('/v1/tools/inline-function', {
    schema: {
      tags: ['Tools - Refactoring'],
      summary: 'Inline function',
      description: 'Inline a function call by replacing it with the function body. Removes unnecessary abstraction.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file_path', 'function_name'],
        properties: {
          file_path: { type: 'string', description: 'Path to the file containing the function call' },
          function_name: { type: 'string', description: 'Name of the function to inline' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Function inlined successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (function not found or cannot be inlined)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'inline_function', executeInlineFunctionTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      filePath: getStringProperty(body, 'file_path'),
      functionName: getStringProperty(body, 'function_name'),
    };
  }));

  // ==========================================
  // Testing and Validation
  // ==========================================

  server.post('/v1/tools/heal-file', {
    schema: {
      tags: ['Tools - Testing & Validation'],
      summary: 'Heal file errors',
      description: 'Detect and automatically fix errors in a file. Uses AI to understand context and apply appropriate fixes.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file_path'],
        properties: {
          file_path: { type: 'string', description: 'Path to the file to heal' },
          auto_fix: { type: 'boolean', default: false, description: 'Automatically apply fixes (if false, only reports errors)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'File healing completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'heal_file', executeHealFileTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      filePath: getStringProperty(body, 'file_path'),
      autoFix: getBooleanProperty(body, 'auto_fix', false),
    };
  }));

  server.post('/v1/tools/detect-errors', {
    schema: {
      tags: ['Tools - Testing & Validation'],
      summary: 'Detect code errors',
      description: 'Detect syntax errors, type errors, linting issues, and other code problems in files or directories.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          file_path: { type: 'string', description: 'Path to a specific file to check' },
          path: { type: 'string', description: 'Path to a directory to check (alternative to file_path)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Error detection completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file or directory path)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'detect_errors', executeDetectErrorsTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      filePath: getOptionalStringProperty(body, 'file_path') || getOptionalStringProperty(body, 'path') || '.',
    };
  }));

  server.post('/v1/tools/validate-code', {
    schema: {
      tags: ['Tools - Testing & Validation'],
      summary: 'Validate code',
      description: 'Validate code against coding standards, best practices, and custom rules. Supports multiple validation frameworks.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          file_path: { type: 'string', description: 'Path to file or directory to validate' },
          rules: { type: 'array', items: { type: 'string' }, description: 'Custom validation rules to apply' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Code validation completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file path or rules)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'validate_code', executeValidateCodeTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const file_path = getOptionalStringProperty(body, 'file_path');
    const rules = body.rules;
    return {
      filePaths: file_path ? [file_path] : [],
      rules: Array.isArray(rules) ? rules : undefined,
    };
  }));

  server.post('/v1/tools/generate-tests', {
    schema: {
      tags: ['Tools - Testing & Validation'],
      summary: 'Generate tests',
      description: 'Generate unit tests for code files. Supports multiple test frameworks and includes edge cases and coverage goals.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['file_path'],
        properties: {
          file_path: { type: 'string', description: 'Path to the file to generate tests for' },
          test_framework: { type: 'string', enum: ['vitest', 'jest', 'mocha', 'pytest'], description: 'Test framework to use' },
          language: { type: 'string', enum: ['typescript', 'javascript', 'python'], description: 'Programming language' },
          include_edge_cases: { type: 'boolean', default: false, description: 'Include edge case tests' },
          write_file: { type: 'boolean', default: true, description: 'Write test file to disk' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Tests generated successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid file path or framework)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'generate_tests', executeGenerateTestsTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const frameworkValue = getOptionalStringProperty(body, 'test_framework');
    const framework = (frameworkValue === 'vitest' || frameworkValue === 'jest' || 
                      frameworkValue === 'mocha' || frameworkValue === 'pytest')
      ? frameworkValue as 'vitest' | 'jest' | 'mocha' | 'pytest'
      : undefined;
    return {
      filePath: getStringProperty(body, 'file_path'),
      framework,
      language: getOptionalStringProperty(body, 'language') as 'typescript' | 'javascript' | 'python' | undefined,
      includeEdgeCases: getBooleanProperty(body, 'include_edge_cases', false),
      writeFile: getBooleanProperty(body, 'write_file', true),
    };
  }));

  // ==========================================
  // Multimodal Tools
  // ==========================================

  server.post('/v1/tools/analyze-image', {
    schema: {
      tags: ['Tools - Multimodal'],
      summary: 'Analyze image',
      description: 'Analyze images using AI vision models. Supports general analysis, code extraction, diagram understanding, UI analysis, and text recognition.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          image_path: { type: 'string', description: 'Local file path to the image' },
          image_url: { type: 'string', description: 'URL to the image (alternative to image_path)' },
          analysis_type: { type: 'string', enum: ['general', 'code', 'diagram', 'ui', 'text'], description: 'Type of analysis to perform' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Image analysis completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid image path or URL)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'analyze_image', executeAnalyzeImageTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const analysis_type_value = getOptionalStringProperty(body, 'analysis_type');
    const analysis_type = (analysis_type_value === 'general' || analysis_type_value === 'code' || 
                           analysis_type_value === 'diagram' || analysis_type_value === 'ui' || 
                           analysis_type_value === 'text')
      ? analysis_type_value as 'general' | 'code' | 'diagram' | 'ui' | 'text'
      : undefined;
    return {
      image_path: getOptionalStringProperty(body, 'image_path'),
      image_url: getOptionalStringProperty(body, 'image_url'),
      analysis_type,
    };
  }));

  server.post('/v1/tools/compare-images', {
    schema: {
      tags: ['Tools - Multimodal'],
      summary: 'Compare images',
      description: 'Compare two images and identify differences, similarities, and changes. Useful for UI testing and visual regression detection.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['image1_path', 'image2_path'],
        properties: {
          image1_path: { type: 'string', description: 'Path to the first image' },
          image2_path: { type: 'string', description: 'Path to the second image to compare' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Image comparison completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid image paths)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'compare_images', executeCompareImagesTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      image1_path: getStringProperty(body, 'image1_path'),
      image2_path: getStringProperty(body, 'image2_path'),
    };
  }));

  server.post('/v1/tools/extract-code-from-screenshot', {
    schema: {
      tags: ['Tools - Multimodal'],
      summary: 'Extract code from screenshot',
      description: 'Extract code from screenshots of code editors, terminals, or documentation. Uses AI vision to recognize and convert visual code to text.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          image_path: { type: 'string', description: 'Local file path to the screenshot' },
          image_url: { type: 'string', description: 'URL to the screenshot (alternative to image_path)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Code extraction completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid image path or URL)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'extract_code_from_screenshot', executeExtractCodeFromScreenshotTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      image_path: getOptionalStringProperty(body, 'image_path'),
      image_url: getOptionalStringProperty(body, 'image_url'),
    };
  }));

  // ==========================================
  // Task Management
  // ==========================================

  server.post('/v1/tools/todos/create', {
    schema: {
      tags: ['Tools - Task Management'],
      summary: 'Create workspace task',
      description: 'Create a new task in the workspace task management system. Tasks can be tracked, prioritized, and managed throughout development.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', description: 'Task description or content' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium', description: 'Task priority level' },
          due_date: { type: 'string', format: 'date-time', description: 'Optional due date for the task (ISO 8601 format)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Task created successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid task content or date)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'create_todo', executeCreateTodoTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const priorityValue = getOptionalStringProperty(body, 'priority');
    const priority = (priorityValue === 'low' || priorityValue === 'medium' || priorityValue === 'high')
      ? priorityValue as 'low' | 'medium' | 'high'
      : undefined;
    return {
      description: getStringProperty(body, 'content'),
      priority,
      dueDate: getOptionalStringProperty(body, 'due_date'),
    };
  }));

  server.post('/v1/tools/todos/update', {
    schema: {
      tags: ['Tools - Task Management'],
      summary: 'Update workspace task',
      description: 'Update an existing task. Can modify content, status, priority, or other task properties.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Task ID to update' },
          content: { type: 'string', description: 'New task content or description' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'New task status' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New task priority level' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Task updated successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid task ID or update data)',
          ...toolErrorResponseSchema,
        },
        404: {
          description: 'Task not found',
          ...toolErrorResponseSchema,
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'update_todo', executeUpdateTodoTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const statusValue = getOptionalStringProperty(body, 'status');
    const status = (statusValue === 'pending' || statusValue === 'in_progress' || 
                   statusValue === 'completed' || statusValue === 'cancelled')
      ? statusValue as 'pending' | 'in_progress' | 'completed' | 'cancelled'
      : undefined;
    const priorityValue = getOptionalStringProperty(body, 'priority');
    const priority = (priorityValue === 'low' || priorityValue === 'medium' || priorityValue === 'high')
      ? priorityValue as 'low' | 'medium' | 'high'
      : undefined;
    return {
      id: getStringProperty(body, 'id'),
      description: getOptionalStringProperty(body, 'content'),
      status,
      priority,
    };
  }));

  server.post('/v1/tools/todos/check', {
    schema: {
      tags: ['Tools - Task Management'],
      summary: 'Mark task as completed',
      description: 'Mark a task as completed. This is a convenience endpoint that updates task status to "completed".',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Task ID to mark as completed' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Task marked as completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid task ID)',
          ...toolErrorResponseSchema,
        },
        404: {
          description: 'Task not found',
          ...toolErrorResponseSchema,
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'check_todo', executeCheckTodoTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      id: getStringProperty(body, 'id'),
    };
  }));

  server.post('/v1/tools/todos/list', {
    schema: {
      tags: ['Tools - Task Management'],
      summary: 'List workspace tasks',
      description: 'List all tasks in the workspace. Supports filtering by status and priority.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'Filter by task status' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Filter by task priority' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Tasks listed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid filter parameters)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'list_todos', executeListTodosTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const statusValue = getOptionalStringProperty(body, 'status');
    const status = (statusValue === 'pending' || statusValue === 'in_progress' || 
                   statusValue === 'completed' || statusValue === 'cancelled')
      ? statusValue as 'pending' | 'in_progress' | 'completed' | 'cancelled'
      : undefined;
    const priorityValue = getOptionalStringProperty(body, 'priority');
    const priority = (priorityValue === 'low' || priorityValue === 'medium' || priorityValue === 'high')
      ? priorityValue as 'low' | 'medium' | 'high'
      : undefined;
    return {
      status,
      priority,
    };
  }));

  // ==========================================
  // Workflow Automation
  // ==========================================

  server.post('/v1/tools/workflows/execute', {
    schema: {
      tags: ['Tools - Workflow'],
      summary: 'Execute workflow',
      description: 'Execute a registered workflow with optional parameters. Workflows automate sequences of tool operations.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['workflow_id'],
        properties: {
          workflow_id: { type: 'string', description: 'ID of the workflow to execute' },
          parameters: { type: 'object', additionalProperties: true, description: 'Parameters to pass to the workflow' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Workflow executed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid workflow ID or parameters)',
          ...toolErrorResponseSchema,
        },
        404: {
          description: 'Workflow not found',
          ...toolErrorResponseSchema,
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'execute_workflow', executeExecuteWorkflowTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      workflowId: getStringProperty(body, 'workflow_id'),
      parameters: (typeof body.parameters === 'object' && body.parameters !== null)
        ? body.parameters as Record<string, unknown>
        : {},
    };
  }));

  server.get('/v1/tools/workflows', {
    schema: {
      tags: ['Tools - Workflow'],
      summary: 'List workflows',
      description: 'List all registered workflows in the workspace. Returns workflow metadata including name, description, and steps. Supports filtering and pagination via query parameters.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum number of workflows to return (1-100, default: 20)' },
          offset: { type: 'integer', minimum: 0, default: 0, description: 'Number of workflows to skip for pagination (default: 0)' },
          name: { type: 'string', description: 'Filter workflows by name (partial match, case-insensitive)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths in workflow steps' },
        },
      },
      response: {
        200: {
          description: 'Workflows listed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid query parameters)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          ...toolErrorResponseSchema,
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => {
    const context = createContext(request);
    const result = await executeListWorkflowsTool({}, nanoid(), context);
    return reply.send(result);
  });

  server.post('/v1/tools/workflows/register', {
    schema: {
      tags: ['Tools - Workflow'],
      summary: 'Register workflow',
      description: 'Register a new workflow that automates a sequence of tool operations. Workflows can be reused and executed with different parameters.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Workflow name' },
          description: { type: 'string', description: 'Workflow description' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Array of workflow steps (tool calls with parameters)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Workflow registered successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid workflow definition)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'register_workflow', executeRegisterWorkflowTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    return {
      workflow: {
        id: nanoid(),
        name: getStringProperty(body, 'name'),
        description: getOptionalStringProperty(body, 'description'),
        steps: Array.isArray(body.steps) ? body.steps : [],
      },
    };
  }));

  // ==========================================
  // Jina Tools
  // ==========================================

  server.post('/v1/tools/jina/reader', {
    schema: {
      tags: ['Tools - Web'],
      summary: 'Read web content via Jina Reader',
      description: 'Fetches normalized web content using Jina Reader (`r.jina.ai`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Target URL to read through Jina Reader.' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina reader execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid URL or payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_reader',
    (args, toolCallId) => executeJinaToolExecutor('reader', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return {
        ...body,
        url: getStringProperty(body, 'url'),
      };
    }
  ));

  server.post('/v1/tools/jina/search', {
    schema: {
      tags: ['Tools - Web'],
      summary: 'Search the web via Jina Search',
      description: 'Runs web search through Jina Search (`s.jina.ai`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query.' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina search execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid query or payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_search',
    (args, toolCallId) => executeJinaToolExecutor('search', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return {
        ...body,
        query: getStringProperty(body, 'query'),
      };
    }
  ));

  server.post('/v1/tools/jina/embeddings', {
    schema: {
      tags: ['Tools'],
      summary: 'Generate embeddings via Jina',
      description: 'Calls Jina embeddings API (`api.jina.ai/v1/embeddings`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['input'],
        properties: {
          input: {
            anyOf: [
              { type: 'string', minLength: 1 },
              { type: 'array', items: { type: 'string' }, minItems: 1 },
            ],
          },
          model: { type: 'string' },
          encoding_format: { type: 'string' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina embeddings execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_embeddings',
    (args, toolCallId) => executeJinaToolExecutor('embeddings', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return { ...body };
    }
  ));

  server.post('/v1/tools/jina/rerank', {
    schema: {
      tags: ['Tools'],
      summary: 'Rerank documents via Jina',
      description: 'Calls Jina rerank API (`api.jina.ai/v1/rerank`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query', 'documents'],
        properties: {
          query: { type: 'string' },
          documents: { type: 'array', items: { type: 'string' }, minItems: 1 },
          model: { type: 'string' },
          top_n: { type: 'integer', minimum: 1 },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina rerank execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_rerank',
    (args, toolCallId) => executeJinaToolExecutor('rerank', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return { ...body };
    }
  ));

  server.post('/v1/tools/jina/classify', {
    schema: {
      tags: ['Tools'],
      summary: 'Classify text via Jina',
      description: 'Calls Jina classify API (`api.jina.ai/v1/classify`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['input'],
        properties: {
          input: {
            anyOf: [
              { type: 'string', minLength: 1 },
              { type: 'array', items: { type: 'string' }, minItems: 1 },
            ],
          },
          model: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina classify execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_classify',
    (args, toolCallId) => executeJinaToolExecutor('classify', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return { ...body };
    }
  ));

  server.post('/v1/tools/jina/segment', {
    schema: {
      tags: ['Tools'],
      summary: 'Segment text via Jina',
      description: 'Calls Jina segment API (`api.jina.ai/v1/segment`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['input'],
        properties: {
          input: { type: 'string', minLength: 1 },
          model: { type: 'string' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina segment execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_segment',
    (args, toolCallId) => executeJinaToolExecutor('segment', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return { ...body };
    }
  ));

  server.post('/v1/tools/jina/deepsearch', {
    schema: {
      tags: ['Tools - Web'],
      summary: 'Run deep search via Jina',
      description: 'Calls Jina DeepSearch chat completions (`deepsearch.jina.ai/v1/chat/completions`).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          model: { type: 'string' },
          messages: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string' },
                content: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          temperature: { type: 'number' },
          max_tokens: { type: 'integer', minimum: 1 },
          top_p: { type: 'number' },
          stream: { type: 'boolean' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
        additionalProperties: true,
      },
      response: {
        200: { description: 'Jina deepsearch execution completed successfully', ...toolResponseSchema },
        400: { description: 'Bad request (invalid payload)', ...toolErrorResponseSchema },
        401: { description: 'Unauthorized (missing/invalid credentials)', ...toolErrorResponseSchema },
        403: { description: 'Forbidden by upstream policy', ...toolErrorResponseSchema },
        404: { description: 'Upstream resource not found', ...toolErrorResponseSchema },
        429: { description: 'Upstream rate-limited', ...toolErrorResponseSchema },
        500: { description: 'Internal server error', ...toolErrorResponseSchema },
      },
    },
  }, async (request, reply) => executeTool(
    request,
    reply,
    'jina_deepsearch',
    (args, toolCallId) => executeJinaToolExecutor('deepsearch', args, toolCallId),
    (body: ToolRequestBody) => {
      if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid request body');
      }
      return { ...body };
    }
  ));

  // ==========================================
  // Web Search
  // ==========================================

  server.post('/v1/tools/web-search', {
    schema: {
      tags: ['Tools - Web'],
      summary: 'Search the web',
      description: 'Perform web search using AI-powered search engines. Supports general, code, documentation, and news searches with configurable depth.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum number of results to return' },
          search_type: { type: 'string', enum: ['general', 'code', 'docs', 'news'], default: 'general', description: 'Type of search to perform' },
          search_depth: { type: 'string', enum: ['basic', 'deep'], default: 'basic', description: 'Search depth: basic (fast) or deep (comprehensive)' },
          working_directory: { type: 'string', description: 'Working directory for relative paths' },
        },
      },
      response: {
        200: {
          description: 'Web search completed successfully',
          ...toolResponseSchema,
        },
        400: {
          description: 'Bad request (invalid query)',
          ...toolErrorResponseSchema,
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., file or resource not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          ...toolErrorResponseSchema,
        },
      },
    },
  }, async (request, reply) => executeTool(request, reply, 'web_search', executeWebSearchTool, (body: ToolRequestBody) => {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Invalid request body');
    }
    const search_type_value = getOptionalStringProperty(body, 'search_type');
    const search_type = (search_type_value === 'general' || search_type_value === 'code' || 
                        search_type_value === 'docs' || search_type_value === 'news')
      ? search_type_value as 'general' | 'code' | 'docs' | 'news'
      : undefined;
    const search_depth_value = getOptionalStringProperty(body, 'search_depth');
    const search_depth = (search_depth_value === 'basic' || search_depth_value === 'deep')
      ? search_depth_value as 'basic' | 'deep'
      : undefined;
    return {
      query: getStringProperty(body, 'query'),
      num_results: getOptionalNumberProperty(body, 'max_results'),
      search_type,
      search_depth,
    };
  }));

    log.info('✅ Tools API routes registered (40+ endpoints, admin/owner-gated)');
  });
}
