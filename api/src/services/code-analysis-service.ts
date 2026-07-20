// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Code Analysis Service
 * 
 * Processes and stores code analysis results from CLI
 * Supports:
 * - Symbol storage and retrieval
 * - Dependency tracking
 * - Incremental indexing with checkpoints
 * - Semantic search
 */

import { prisma, Prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { ValidationError } from '@/utils/custom-errors';
import { IncrementalIndexingService } from './incremental-indexing-service';

const log = logger.child({ component: 'code-analysis-service' });

// ============================================
// Types
// ============================================

export interface SymbolPayload {
  name: string;
  qualifiedName?: string;
  type: 'function' | 'method' | 'class' | 'variable' | 'interface' | 'enum' | 'constant' | 'type' | 'import' | 'export';
  kind?: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  signature?: string;
  documentation?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isAsync?: boolean;
  isStatic?: boolean;
  isExported?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DependencyPayload {
  sourceFilePath: string;
  targetFilePath?: string;
  sourceSymbolName?: string;
  targetSymbolName?: string;
  dependencyType: 'import' | 'export' | 'call' | 'inherit' | 'implement' | 'reference' | 'type_reference';
  importPath?: string;
  isExternal?: boolean;
  isDynamic?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FileAnalysisPayload {
  filePath: string;
  symbols: SymbolPayload[];
  dependencies: DependencyPayload[];
  checksum: string;
  lineCount: number;
}

export interface AnalysisSyncRequest {
  projectId: string;
  branch?: string;
  commitSha?: string;
  files: FileAnalysisPayload[];
  isIncremental: boolean;
  previousChecksum?: string;
}

export interface AnalysisSyncResponse {
  success: boolean;
  filesProcessed: number;
  symbolsCreated: number;
  dependenciesCreated: number;
  checkpointId?: string;
  jobId?: string; // Job ID for async processing tracking
  warnings?: string[];
}

export interface SemanticSearchOptions {
  organizationId: string;
  projectId: string;
  branch?: string;
  query: string;
  limit?: number;
  includeSymbols?: boolean;
  includeContent?: boolean;
  symbolTypes?: string[];
}

export interface SemanticSearchResult {
  fileId: string;
  filePath: string;
  contentSnippet?: string;
  symbolMatches: Array<{
    name: string;
    type: string;
    line: number;
    score: number;
  }>;
  relevanceScore: number;
  matchType: 'content' | 'symbol' | 'both';
}

export interface SymbolReference {
  symbolId: string;
  filePath: string;
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  isDefinition: boolean;
  referenceCount: number;
}

export interface DependencyNode {
  sourceFile: string;
  targetFile: string;
  dependencyType: string;
  importPath?: string;
  depth: number;
}

// ============================================
// Service Implementation
// ============================================

/**
 * Sync code analysis results from CLI
 */
/**
 * Process incremental sync - only update changed files
 */
async function processIncrementalSync(
  tx: Prisma.TransactionClient,
  projectId: string,
  checkpointId: string,
  incomingFiles: FileAnalysisPayload[],
  warnings: string[],
  branch?: string
): Promise<{ symbolsCreated: number; dependenciesCreated: number }> {
  const indexingService = new IncrementalIndexingService();

  // Get checkpoint state
  const checkpoint = await indexingService.getOrCreateCheckpoint(
    projectId,
    branch || 'default'
  );

  // Detect changed files
  const changes = indexingService.detectChangedFiles(
    checkpoint,
    incomingFiles.map(f => ({ filePath: f.filePath, checksum: f.checksum }))
  );

  log.info({
    projectId,
    new: changes.newFiles.length,
    modified: changes.modifiedFiles.length,
    deleted: changes.deletedFiles.length,
    unchanged: changes.unchangedFiles.length,
    changeRate: changes.changeRate.toFixed(2),
  }, 'Incremental sync change detection');

  let symbolsCreated = 0;
  let dependenciesCreated = 0;

  // Process new and modified files only
  const filesToProcess = incomingFiles.filter(f =>
    changes.newFiles.includes(f.filePath) ||
    changes.modifiedFiles.includes(f.filePath)
  );

  for (const fileAnalysis of filesToProcess) {
    const result = await processFileAnalysis(tx, projectId, fileAnalysis, warnings);
    symbolsCreated += result.symbolsCreated;
    dependenciesCreated += result.dependenciesCreated;
  }

  // Handle deleted files - remove their symbols and dependencies
  for (const deletedPath of changes.deletedFiles) {
    const file = await tx.codebaseFile.findFirst({
      where: { projectId, path: deletedPath },
    });

    if (file) {
      // Delete symbols
      await tx.codebaseSymbol.deleteMany({ where: { fileId: file.id } });
      // Delete dependencies
      await tx.codebaseDependency.deleteMany({
        where: {
          OR: [
            { sourceFileId: file.id },
            { targetFileId: file.id }
          ]
        }
      });

      log.debug({ projectId, filePath: deletedPath }, 'Cleaned up deleted file');
    }
  }

  // Update checkpoint with new file hashes
  const newFileHashes = new Map(checkpoint.fileHashes);
  incomingFiles.forEach(f => {
    newFileHashes.set(f.filePath, f.checksum);
  });

  // Remove deleted files from hashes
  changes.deletedFiles.forEach(deletedPath => {
    newFileHashes.delete(deletedPath);
  });

  await indexingService.updateCheckpoint(checkpointId, {
    fileHashes: newFileHashes,
    fileCount: newFileHashes.size,
    symbolCount: symbolsCreated,
    dependencyCount: dependenciesCreated,
    status: 'completed',
  });

  return { symbolsCreated, dependenciesCreated };
}

/**
 * Find all references to a symbol across the codebase
 */
/*
DUPLICATE FUNCTION - COMMENTED OUT
This function was duplicated. Using the newer version below.
*/

/**
 * Perform semantic search across codebase (removed duplicate)
 */
/*
DUPLICATE FUNCTION - REMOVED
This function was duplicated. Using the newer version below.
*/

/**
 * Validate analysis payload before processing
 */
function validateAnalysisPayload(
  request: AnalysisSyncRequest
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate projectId
  if (!request.projectId || typeof request.projectId !== 'string' || request.projectId.trim().length === 0) {
    errors.push('projectId is required and must be a non-empty string');
  }

  // Validate isIncremental
  if (typeof request.isIncremental !== 'boolean') {
    errors.push('isIncremental must be a boolean');
  }

  // Validate files array
  if (!Array.isArray(request.files)) {
    errors.push('files must be an array');
  } else {
    if (request.files.length === 0) {
      errors.push('files array must not be empty');
    }

    if (request.files.length > 1000) {
      errors.push('files array exceeds maximum size (1000)');
    }

    // Validate each file
    for (let i = 0; i < request.files.length; i++) {
      const file = request.files[i];
      const prefix = `files[${i}]`;

      // Required fields
      if (!file.filePath || typeof file.filePath !== 'string' || file.filePath.trim().length === 0) {
        errors.push(`${prefix}.filePath is required and must be a non-empty string`);
      }

      if (!file.checksum || typeof file.checksum !== 'string' || file.checksum.length !== 64) {
        errors.push(`${prefix}.checksum is required and must be a valid SHA-256 hash (64 characters)`);
      }

      if (typeof file.lineCount !== 'number' || file.lineCount < 0) {
        errors.push(`${prefix}.lineCount must be a non-negative number`);
      }

      // Validate symbols array
      if (!Array.isArray(file.symbols)) {
        errors.push(`${prefix}.symbols must be an array`);
      } else {
        for (let j = 0; j < file.symbols.length; j++) {
          const symbol = file.symbols[j];
          const symbolPrefix = `${prefix}.symbols[${j}]`;

          if (!symbol.name || typeof symbol.name !== 'string' || symbol.name.trim().length === 0) {
            errors.push(`${symbolPrefix}.name is required and must be a non-empty string`);
          }

          if (!symbol.type || typeof symbol.type !== 'string' || symbol.type.trim().length === 0) {
            errors.push(`${symbolPrefix}.type is required and must be a non-empty string`);
          }

          if (typeof symbol.startLine !== 'number' || symbol.startLine < 0) {
            errors.push(`${symbolPrefix}.startLine must be a non-negative number`);
          }

          if (typeof symbol.endLine !== 'number' || symbol.endLine < symbol.startLine) {
            errors.push(`${symbolPrefix}.endLine must be greater than or equal to startLine`);
          }

          // Optional fields validation
          if (symbol.startColumn !== undefined && (typeof symbol.startColumn !== 'number' || symbol.startColumn < 0)) {
            errors.push(`${symbolPrefix}.startColumn must be a non-negative number if provided`);
          }

          if (symbol.endColumn !== undefined && (typeof symbol.endColumn !== 'number' || symbol.endColumn < 0)) {
            errors.push(`${symbolPrefix}.endColumn must be a non-negative number if provided`);
          }

          if (symbol.visibility !== undefined && !['public', 'private', 'protected', 'internal'].includes(symbol.visibility)) {
            errors.push(`${symbolPrefix}.visibility must be one of: public, private, protected, internal`);
          }

          if (symbol.isAsync !== undefined && typeof symbol.isAsync !== 'boolean') {
            errors.push(`${symbolPrefix}.isAsync must be a boolean if provided`);
          }

          if (symbol.isStatic !== undefined && typeof symbol.isStatic !== 'boolean') {
            errors.push(`${symbolPrefix}.isStatic must be a boolean if provided`);
          }

          if (symbol.isExported !== undefined && typeof symbol.isExported !== 'boolean') {
            errors.push(`${symbolPrefix}.isExported must be a boolean if provided`);
          }
        }
      }

      // Validate dependencies array
      if (!Array.isArray(file.dependencies)) {
        errors.push(`${prefix}.dependencies must be an array`);
      } else {
        for (let j = 0; j < file.dependencies.length; j++) {
          const dep = file.dependencies[j];
          const depPrefix = `${prefix}.dependencies[${j}]`;

          if (!dep.dependencyType || !['import', 'export', 'call', 'inherit', 'implement', 'reference', 'type_reference'].includes(dep.dependencyType)) {
            errors.push(`${depPrefix}.dependencyType is required and must be one of: import, export, call, inherit, implement, reference, type_reference`);
          }

          if (dep.isExternal !== undefined && typeof dep.isExternal !== 'boolean') {
            errors.push(`${depPrefix}.isExternal must be a boolean if provided`);
          }

          if (dep.isDynamic !== undefined && typeof dep.isDynamic !== 'boolean') {
            errors.push(`${depPrefix}.isDynamic must be a boolean if provided`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Decide whether to process synchronously or asynchronously based on batch size
 */
function shouldProcessAsync(request: AnalysisSyncRequest): boolean {
  // Process async for large batches (>100 files) or incremental syncs
  return request.files.length > 100 || request.isIncremental;
}

export async function syncCodeAnalysis(
  organizationId: string,
  request: AnalysisSyncRequest,
  options: { forceSync?: boolean; worker?: { process?: (data: unknown) => Promise<unknown> } } = {}
): Promise<AnalysisSyncResponse> {
  // Validate payload first
  const validation = validateAnalysisPayload(request);
  if (!validation.valid) {
    log.warn({
      organizationId,
      projectId: request.projectId,
      errors: validation.errors,
    }, 'Invalid code analysis payload');

    // Use ValidationError so route handlers can map to HTTP 400 instead of 500.
    throw new ValidationError(
      `Invalid payload: ${validation.errors.join(', ')}`,
      { errors: validation.errors }
    );
  }

  // Decide processing mode
  const useAsync = !options.forceSync && shouldProcessAsync(request);

  if (useAsync && options.worker) {
    // Process asynchronously
    log.info({
      organizationId,
      projectId: request.projectId,
      fileCount: request.files.length,
      isIncremental: request.isIncremental,
    }, 'Enqueueing analysis for async processing');

    // Type guard: check if worker has enqueueAnalysis method.
    // The structural narrow gives us the function but its return is
    // `unknown` until we cast it explicitly.
    if (typeof options.worker === 'object' && options.worker !== null && 'enqueueAnalysis' in options.worker && typeof options.worker.enqueueAnalysis === 'function') {
      const enqueue = options.worker.enqueueAnalysis as (
        orgId: string,
        req: typeof request,
      ) => Promise<string>;
      const jobId: string = await enqueue(organizationId, request);

      return {
        success: true,
        filesProcessed: 0, // Will be updated when job completes
        symbolsCreated: 0,
        dependenciesCreated: 0,
        jobId, // Return job ID for status tracking
        warnings: ['Analysis enqueued for async processing'],
      };
    } else {
      log.warn('Worker does not have enqueueAnalysis method, falling back to sync processing');
    }
  }

  // Process synchronously
  const warnings: string[] = [];
  let symbolsCreated = 0;
  let dependenciesCreated = 0;

  log.info({
    organizationId,
    projectId: request.projectId,
    branch: request.branch,
    fileCount: request.files.length,
    isIncremental: request.isIncremental,
  }, 'Processing code analysis sync synchronously');

  // Find project
  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId,
      externalId: request.projectId,
      defaultBranch: request.branch || 'default',
    },
  });

  if (!project) {
    throw new Error(`Project not found: ${request.projectId}`);
  }

  // Get or create checkpoint
  const checkpoint = await getOrCreateCheckpoint(project.id, request.branch || 'default', request.commitSha);

  try {
    // Update checkpoint status
    await prisma.codebaseCheckpoint.update({
      where: { id: checkpoint.id },
      data: { status: 'indexing', startedAt: new Date() },
    });

    // Process files - use incremental sync if requested
    if (request.isIncremental) {
      const result = await processIncrementalSync(
        prisma,
        project.id,
        checkpoint.id,
        request.files,
        warnings,
        request.branch
      );
      symbolsCreated = result.symbolsCreated;
      dependenciesCreated = result.dependenciesCreated;
    } else {
      // Full sync - process all files
      await prisma.$transaction(async (tx) => {
        for (const fileAnalysis of request.files) {
          const result = await processFileAnalysis(tx, project.id, fileAnalysis, warnings);
          symbolsCreated += result.symbolsCreated;
          dependenciesCreated += result.dependenciesCreated;
        }
      }, { timeout: 120000 }); // 2 minute timeout for large batches

      // Update checkpoint with results for full sync
      await prisma.codebaseCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          fileCount: request.files.length,
          symbolCount: symbolsCreated,
          dependencyCount: dependenciesCreated,
          fileHashes: request.files.reduce((acc, f) => {
            acc[f.filePath] = f.checksum;
            return acc;
          }, {} as Record<string, string>),
        },
      });
    }

    const filesProcessed = request.isIncremental ?
      request.files.length : // For incremental, this is the number of files sent (may be less than total)
      request.files.length;   // For full sync, this is all files

    log.info({
      projectId: project.id,
      filesProcessed,
      symbolsCreated,
      dependenciesCreated,
      isIncremental: request.isIncremental,
    }, 'Code analysis sync completed');

    return {
      success: true,
      filesProcessed,
      symbolsCreated,
      dependenciesCreated,
      checkpointId: checkpoint.id,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    // Update checkpoint with error
    await prisma.codebaseCheckpoint.update({
      where: { id: checkpoint.id },
      data: {
        status: 'failed',
        errorMessage: getErrorMessage(error),
      },
    });
    throw error;
  }
}

/**
 * Get or create checkpoint for incremental indexing
 */
async function getOrCreateCheckpoint(
  projectId: string,
  branch: string,
  commitSha?: string
): Promise<{ id: string; fileHashes: Record<string, string> }> {
  const existing = await prisma.codebaseCheckpoint.findUnique({
    where: {
      projectId_branch: { projectId, branch },
    },
  });

  if (existing) {
    return {
      id: existing.id,
      fileHashes: (existing.fileHashes as Record<string, string>) || {},
    };
  }

  const created = await prisma.codebaseCheckpoint.create({
    data: {
      projectId,
      branch,
      commitSha,
    },
  });

  return {
    id: created.id,
    fileHashes: {},
  };
}

/**
 * Process analysis for a single file
 */
async function processFileAnalysis(
  tx: Prisma.TransactionClient,
  projectId: string,
  analysis: FileAnalysisPayload,
  warnings: string[]
): Promise<{ symbolsCreated: number; dependenciesCreated: number }> {
  // Find file
  const file = await tx.codebaseFile.findFirst({
    where: {
      projectId,
      path: analysis.filePath,
    },
  });

  if (!file) {
    warnings.push(`File not found: ${analysis.filePath}`);
    return { symbolsCreated: 0, dependenciesCreated: 0 };
  }

  // Delete existing symbols and dependencies for this file (for incremental updates)
  await tx.codebaseSymbol.deleteMany({
    where: { fileId: file.id },
  });

  await tx.codebaseDependency.deleteMany({
    where: { sourceFileId: file.id },
  });

  // Create symbols
  let symbolsCreated = 0;
  const symbolMap = new Map<string, string>(); // name -> id

  for (const symbol of analysis.symbols) {
    try {
      const created = await tx.codebaseSymbol.create({
        data: {
          fileId: file.id,
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          type: symbol.type,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          startColumn: symbol.startColumn,
          endColumn: symbol.endColumn,
          signature: symbol.signature,
          documentation: symbol.documentation,
          visibility: symbol.visibility,
          isAsync: symbol.isAsync || false,
          isStatic: symbol.isStatic || false,
          isExported: symbol.isExported || false,
          metadata: (symbol.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      symbolMap.set(symbol.name, created.id);
      symbolsCreated++;
    } catch (error) {
      warnings.push(`Failed to create symbol ${symbol.name}: ${getErrorMessage(error)}`);
    }
  }

  // Create dependencies
  let dependenciesCreated = 0;

  for (const dep of analysis.dependencies) {
    try {
      // Find target file if specified
      let targetFileId: string | null = null;
      if (dep.targetFilePath) {
        const targetFile = await tx.codebaseFile.findFirst({
          where: {
            projectId,
            path: dep.targetFilePath,
          },
        });
        targetFileId = targetFile?.id || null;
      }

      // Find source symbol if specified
      let sourceSymbolId: string | null = null;
      if (dep.sourceSymbolName && symbolMap.has(dep.sourceSymbolName)) {
        sourceSymbolId = symbolMap.get(dep.sourceSymbolName)!;
      }

      await tx.codebaseDependency.create({
        data: {
          projectId,
          sourceFileId: file.id,
          targetFileId,
          sourceSymbolId,
          targetSymbolId: null, // Would require cross-file symbol lookup
          dependencyType: dep.dependencyType,
          importPath: dep.importPath,
          isExternal: dep.isExternal || false,
          isDynamic: dep.isDynamic || false,
          metadata: (dep.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      dependenciesCreated++;
    } catch (error) {
      warnings.push(`Failed to create dependency: ${getErrorMessage(error)}`);
    }
  }

  return { symbolsCreated, dependenciesCreated };
}

/**
 * Semantic search across codebase
 */
export async function semanticSearch(
  options: SemanticSearchOptions
): Promise<SemanticSearchResult[]> {
  const limit = Math.min(Math.max(options.limit || 20, 1), 100);

  log.debug({
    organizationId: options.organizationId,
    projectId: options.projectId,
    query: options.query,
    limit,
  }, 'Executing semantic search');

  // Find project
  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId: options.organizationId,
      externalId: options.projectId,
      defaultBranch: options.branch || 'default',
    },
  });

  if (!project) {
    return [];
  }

  // Use raw query for advanced search with full-text and trigram
  const results = await prisma.$queryRaw<Array<{
    file_id: string;
    file_path: string;
    content_snippet: string | null;
    symbol_matches: unknown;
    relevance_score: number;
    match_type: string;
  }>>`
    SELECT * FROM search_codebase_semantic(
      ${project.id}::uuid,
      ${options.query}::text,
      ${limit}::integer
    )
  `;

  return results.map((row) => ({
    fileId: row.file_id,
    filePath: row.file_path,
    contentSnippet: row.content_snippet || undefined,
    symbolMatches: Array.isArray(row.symbol_matches) 
      ? (row.symbol_matches as Array<{ name: string; type: string; line: number }>).map(s => ({
          name: s.name,
          type: s.type,
          line: s.line,
          score: row.relevance_score,
        }))
      : [],
    relevanceScore: row.relevance_score,
    matchType: row.match_type as 'content' | 'symbol' | 'both',
  }));
}

/**
 * Find all references to a symbol
 */
export async function findSymbolReferences(
  organizationId: string,
  projectId: string,
  symbolName: string,
  symbolType?: string,
  branch?: string
): Promise<SymbolReference[]> {
  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId,
      externalId: projectId,
      defaultBranch: branch || 'default',
    },
  });

  if (!project) {
    return [];
  }

  const results = await prisma.$queryRaw<Array<{
    symbol_id: string;
    file_path: string;
    symbol_name: string;
    symbol_type: string;
    start_line: number;
    end_line: number;
    is_definition: boolean;
    reference_count: bigint;
  }>>`
    SELECT * FROM find_symbol_references(
      ${project.id}::uuid,
      ${symbolName}::text,
      ${symbolType || null}::text
    )
  `;

  return results.map((row) => ({
    symbolId: row.symbol_id,
    filePath: row.file_path,
    symbolName: row.symbol_name,
    symbolType: row.symbol_type,
    startLine: row.start_line,
    endLine: row.end_line,
    isDefinition: row.is_definition,
    referenceCount: Number(row.reference_count),
  }));
}

/**
 * Get dependency graph for a project or file
 */
export async function getDependencyGraph(
  organizationId: string,
  projectId: string,
  filePath?: string,
  depth?: number,
  branch?: string
): Promise<DependencyNode[]> {
  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId,
      externalId: projectId,
      defaultBranch: branch || 'default',
    },
  });

  if (!project) {
    return [];
  }

  const results = await prisma.$queryRaw<Array<{
    source_file: string;
    target_file: string;
    dependency_type: string;
    import_path: string | null;
    depth: number;
  }>>`
    SELECT * FROM get_dependency_graph(
      ${project.id}::uuid,
      ${filePath || null}::text,
      ${depth || 2}::integer
    )
  `;

  return results.map((row) => ({
    sourceFile: row.source_file,
    targetFile: row.target_file,
    dependencyType: row.dependency_type,
    importPath: row.import_path || undefined,
    depth: row.depth,
  }));
}

/**
 * Get symbols for a file
 */
export async function getFileSymbols(
  organizationId: string,
  projectId: string,
  filePath: string,
  branch?: string
): Promise<Array<{
  id: string;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  signature?: string;
  isExported: boolean;
}>> {
  const file = await prisma.codebaseFile.findFirst({
    where: {
      project: {
        organizationId,
        externalId: projectId,
        defaultBranch: branch || 'default',
      },
      path: filePath,
    },
    include: {
      symbols: {
        orderBy: { startLine: 'asc' },
      },
    },
  });

  if (!file) {
    return [];
  }

  return file.symbols.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    startLine: s.startLine,
    endLine: s.endLine,
    signature: s.signature || undefined,
    isExported: s.isExported,
  }));
}

/**
 * Get checkpoint status for incremental sync
 */
export async function getCheckpointStatus(
  organizationId: string,
  projectId: string,
  branch?: string
): Promise<{
  exists: boolean;
  status?: string;
  fileHashes?: Record<string, string>;
  lastUpdated?: Date;
} | null> {
  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId,
      externalId: projectId,
      defaultBranch: branch || 'default',
    },
  });

  if (!project) {
    return null;
  }

  const checkpoint = await prisma.codebaseCheckpoint.findUnique({
    where: {
      projectId_branch: {
        projectId: project.id,
        branch: branch || 'default',
      },
    },
  });

  if (!checkpoint) {
    return { exists: false };
  }

  return {
    exists: true,
    status: checkpoint.status,
    fileHashes: (checkpoint.fileHashes as Record<string, string>) || {},
    lastUpdated: checkpoint.updatedAt,
  };
}

/**
 * Get project statistics
 */
export async function getProjectStats(
  organizationId: string,
  projectId: string,
  branch?: string
): Promise<{
  fileCount: number;
  symbolCount: number;
  dependencyCount: number;
  totalLines: number;
  languageDistribution: Record<string, number>;
  symbolTypeDistribution: Record<string, number>;
} | null> {
  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId,
      externalId: projectId,
      defaultBranch: branch || 'default',
    },
  });

  if (!project) {
    return null;
  }

  const [fileStats, symbolStats, dependencyCount] = await Promise.all([
    prisma.codebaseFile.groupBy({
      by: ['language'],
      where: { projectId: project.id },
      _count: true,
    }),
    prisma.codebaseSymbol.groupBy({
      by: ['type'],
      where: { file: { projectId: project.id } },
      _count: true,
    }),
    prisma.codebaseDependency.count({
      where: { projectId: project.id },
    }),
  ]);

  const languageDistribution: Record<string, number> = {};
  let fileCount = 0;
  for (const stat of fileStats) {
    const lang = stat.language || 'unknown';
    languageDistribution[lang] = stat._count;
    fileCount += stat._count;
  }

  const symbolTypeDistribution: Record<string, number> = {};
  let symbolCount = 0;
  for (const stat of symbolStats) {
    symbolTypeDistribution[stat.type] = stat._count;
    symbolCount += stat._count;
  }

  // Get line count from checkpoint
  const checkpoint = await prisma.codebaseCheckpoint.findUnique({
    where: {
      projectId_branch: {
        projectId: project.id,
        branch: branch || 'default',
      },
    },
  });

  return {
    fileCount,
    symbolCount,
    dependencyCount,
    totalLines: checkpoint?.totalLines || 0,
    languageDistribution,
    symbolTypeDistribution,
  };
}

