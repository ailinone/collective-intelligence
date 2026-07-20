// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Incremental Indexing Service
 * Manages checkpoints and change detection for efficient re-indexing
 * 
 * Enterprise-grade implementation with:
 * - Hash-based change detection
 * - Checkpoint persistence
 * - Automatic cleanup
 * - Performance optimization
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'incremental-indexing' });

export interface CheckpointState {
  id: string;
  projectId: string;
  branch: string;
  commitSha?: string;
  fileHashes: Map<string, string>; // filePath -> checksum
  lastUpdated: Date;
  totalFiles: number;
  totalSymbols: number;
  totalDependencies: number;
  status: 'pending' | 'indexing' | 'completed' | 'failed';
}

export interface ChangeDetectionResult {
  newFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  unchangedFiles: string[];
  changeRate: number; // Percentage of files changed
}

export class IncrementalIndexingService {
  /**
   * Get or create checkpoint for a project/branch
   */
  async getOrCreateCheckpoint(
    projectId: string,
    branch: string,
    commitSha?: string
  ): Promise<CheckpointState> {
    const existing = await prisma.codebaseCheckpoint.findUnique({
      where: {
        projectId_branch: { projectId, branch },
      },
    });

    if (existing) {
      const fileHashes = existing.fileHashes as Record<string, string> | null;
      return {
        id: existing.id,
        projectId: existing.projectId,
        branch: existing.branch,
        commitSha: existing.commitSha || undefined,
        fileHashes: new Map(fileHashes ? Object.entries(fileHashes) : []),
        lastUpdated: existing.updatedAt,
        totalFiles: existing.fileCount || 0,
        totalSymbols: existing.symbolCount || 0,
        totalDependencies: existing.dependencyCount || 0,
        status: existing.status as 'pending' | 'indexing' | 'completed' | 'failed',
      };
    }

    const created = await prisma.codebaseCheckpoint.create({
      data: {
        projectId,
        branch,
        commitSha,
        status: 'pending',
      },
    });

    return {
      id: created.id,
      projectId: created.projectId,
      branch: created.branch,
      commitSha: created.commitSha || undefined,
      fileHashes: new Map(),
      lastUpdated: created.createdAt,
      totalFiles: 0,
      totalSymbols: 0,
      totalDependencies: 0,
      status: 'pending',
    };
  }

  /**
   * Detect changed files by comparing checksums
   * 
   * @param checkpoint - Current checkpoint state
   * @param incomingFiles - Files with their checksums from CLI
   * @returns Change detection result
   */
  detectChangedFiles(
    checkpoint: CheckpointState,
    incomingFiles: Array<{ filePath: string; checksum: string }>
  ): ChangeDetectionResult {
    const newFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const unchangedFiles: string[] = [];
    const incomingPaths = new Set(incomingFiles.map(f => f.filePath));

    // Check incoming files against checkpoint
    for (const file of incomingFiles) {
      const existingHash = checkpoint.fileHashes.get(file.filePath);
      
      if (!existingHash) {
        newFiles.push(file.filePath);
      } else if (existingHash !== file.checksum) {
        modifiedFiles.push(file.filePath);
      } else {
        unchangedFiles.push(file.filePath);
      }
    }

    // Find deleted files (in checkpoint but not in incoming)
    const deletedFiles: string[] = [];
    for (const [filePath] of checkpoint.fileHashes) {
      if (!incomingPaths.has(filePath)) {
        deletedFiles.push(filePath);
      }
    }

    const totalFiles = incomingFiles.length;
    const changedFiles = newFiles.length + modifiedFiles.length + deletedFiles.length;
    const changeRate = totalFiles > 0 ? (changedFiles / totalFiles) * 100 : 0;

    log.debug({
      new: newFiles.length,
      modified: modifiedFiles.length,
      deleted: deletedFiles.length,
      unchanged: unchangedFiles.length,
      changeRate: changeRate.toFixed(2),
    }, 'Change detection completed');

    return {
      newFiles,
      modifiedFiles,
      deletedFiles,
      unchangedFiles,
      changeRate,
    };
  }

  /**
   * Update checkpoint with new state
   */
  async updateCheckpoint(
    checkpointId: string,
    updates: {
      fileHashes: Map<string, string>;
      fileCount: number;
      symbolCount: number;
      dependencyCount: number;
      status: 'indexing' | 'completed' | 'failed';
      errorMessage?: string;
      totalLines?: number;
      totalSizeBytes?: number;
    }
  ): Promise<void> {
    const fileHashesObj = Object.fromEntries(updates.fileHashes);

    await prisma.codebaseCheckpoint.update({
      where: { id: checkpointId },
      data: {
        fileHashes: fileHashesObj,
        fileCount: updates.fileCount,
        symbolCount: updates.symbolCount,
        dependencyCount: updates.dependencyCount,
        status: updates.status,
        errorMessage: updates.errorMessage,
        totalLines: updates.totalLines,
        totalSizeBytes: updates.totalSizeBytes ? BigInt(updates.totalSizeBytes) : undefined,
        updatedAt: new Date(),
        ...(updates.status === 'completed' ? { completedAt: new Date() } : {}),
        ...(updates.status === 'indexing' ? { startedAt: new Date() } : {}),
      },
    });

    log.debug({ checkpointId, status: updates.status }, 'Checkpoint updated');
  }

  /**
   * Clean up old checkpoints (keep last N per project)
   * 
   * @param projectId - Project ID
   * @param keepCount - Number of checkpoints to keep (default: 5)
   */
  async cleanupOldCheckpoints(projectId: string, keepCount: number = 5): Promise<void> {
    const checkpoints = await prisma.codebaseCheckpoint.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      skip: keepCount,
    });

    if (checkpoints.length === 0) {
      return;
    }

    const deletedIds = checkpoints.map(c => c.id);
    await prisma.codebaseCheckpoint.deleteMany({
      where: { id: { in: deletedIds } },
    });

    log.info({ projectId, deleted: checkpoints.length }, 'Cleaned up old checkpoints');
  }

  /**
   * Get checkpoint statistics
   */
  async getCheckpointStats(projectId: string, branch?: string): Promise<{
    totalCheckpoints: number;
    latestCheckpoint?: {
      id: string;
      branch: string;
      status: string;
      fileCount: number;
      symbolCount: number;
      lastUpdated: Date;
    };
  } | null> {
    const where: Prisma.CodebaseCheckpointWhereInput = { projectId };
    if (branch) {
      where.branch = branch;
    }

    const checkpoints = await prisma.codebaseCheckpoint.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 1,
    });

    if (checkpoints.length === 0) {
      return null;
    }

    const latest = checkpoints[0];
    const total = await prisma.codebaseCheckpoint.count({ where: { projectId } });

    return {
      totalCheckpoints: total,
      latestCheckpoint: {
        id: latest.id,
        branch: latest.branch,
        status: latest.status,
        fileCount: latest.fileCount || 0,
        symbolCount: latest.symbolCount || 0,
        lastUpdated: latest.updatedAt,
      },
    };
  }
}

