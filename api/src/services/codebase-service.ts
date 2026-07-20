// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import type {
  CodebaseFilePayload,
  CodebaseSearchMatch,
  CodebaseSearchResponse,
  CodebaseSyncRequest,
  CodebaseSyncResponse,
} from '@/types';

const log = logger.child({ component: 'codebase-service' });

const MAX_FILES_PER_CHUNK = 500;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export async function syncCodebaseChunk(
  organizationId: string,
  payload: CodebaseSyncRequest
): Promise<CodebaseSyncResponse> {
  if (!payload.files || payload.files.length === 0) {
    throw new Error('Codebase sync payload must include at least one file.');
  }

  if (payload.files.length > MAX_FILES_PER_CHUNK) {
    throw new Error(`File batch exceeds maximum allowed size (${MAX_FILES_PER_CHUNK}).`);
  }

  const branch = payload.branch ?? 'default';

  log.debug(
    {
      organizationId,
      projectId: payload.projectId,
      branch,
      sequence: payload.sequence,
      totalSequences: payload.totalSequences,
      fileCount: payload.files.length,
    },
    'Processing codebase sync chunk'
  );

  const warnings: string[] = [];

  const project = await prisma.codebaseProject.upsert({
    where: {
      organizationId_externalId_defaultBranch: {
        organizationId,
        externalId: payload.projectId,
        defaultBranch: branch,
      },
    },
    create: {
      organizationId,
      externalId: payload.projectId,
      rootPath: payload.rootPath,
      defaultBranch: branch,
      latestCommitSha: payload.commitSha,
      metadata: {
        totalSequences: payload.totalSequences,
      },
    },
    update: {
      rootPath: payload.rootPath,
      latestCommitSha: payload.commitSha ?? null,
      metadata: {
        updateTime: new Date().toISOString(),
        totalSequences: payload.totalSequences,
      },
    },
  });

  await prisma.$transaction(async (tx) => {
    for (const file of payload.files) {
      await syncSingleFile(tx, project.id, file, warnings);
    }
  });

  return {
    accepted: true,
    sequence: payload.sequence,
    totalSequences: payload.totalSequences,
    indexed: payload.isFinalChunk,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

async function syncSingleFile(
  tx: Prisma.TransactionClient,
  projectId: string,
  file: CodebaseFilePayload,
  warnings: string[]
): Promise<void> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    warnings.push(`Skipping oversized file: ${file.path} (${file.size} bytes)`);
    return;
  }

  const normalizedPath = normalizePath(file.path);
  const language = file.language ?? inferLanguage(normalizedPath);
  const decoded = decodeFileContent(file, warnings);

  await tx.codebaseFile.upsert({
    where: {
      projectId_path: {
        projectId,
        path: normalizedPath,
      },
    },
    create: {
      projectId,
      path: normalizedPath,
      sizeBytes: BigInt(file.size),
      checksum: file.checksum,
      lastModifiedAt: new Date(file.lastModified),
      language,
      executable: file.executable ?? false,
      encoding: decoded.encoding,
      content: decoded.content,
    },
    update: {
      sizeBytes: BigInt(file.size),
      checksum: file.checksum,
      lastModifiedAt: new Date(file.lastModified),
      language,
      executable: file.executable ?? false,
      encoding: decoded.encoding,
      content: decoded.content,
      updatedAt: new Date(),
    },
  });
}

function decodeFileContent(
  file: CodebaseFilePayload,
  warnings: string[]
): { content: string; encoding?: string } {
  if (!file.content) {
    return { content: '' };
  }

  if (file.encoding === 'base64') {
    try {
      const buffer = Buffer.from(file.content, 'base64');
      const decoded = buffer.toString('utf-8');
      if (looksBinary(decoded)) {
        warnings.push(`Binary file skipped from indexing: ${file.path}`);
        return { content: '', encoding: 'base64' };
      }
      return { content: decoded, encoding: 'utf-8' };
    } catch (error) {
      warnings.push(
        `Failed to decode base64 content for ${file.path}: ${getErrorMessage(error)}`
      );
      return { content: '', encoding: 'base64' };
    }
  }

  return {
    content: file.content,
    encoding: file.encoding ?? 'utf-8',
  };
}

function looksBinary(content: string): boolean {
  return /[\u0000-\u0008\u000E-\u001F]/.test(content);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function inferLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mapping: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.java': 'java',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.md': 'markdown',
    '.json': 'json',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.php': 'php',
    '.rs': 'rust',
    '.swift': 'swift',
    '.kt': 'kotlin',
  };
  return mapping[ext];
}

interface SearchOptions {
  organizationId: string;
  projectExternalId: string;
  branch?: string;
  query: string;
  limit?: number;
  fileTypes?: string[];
  includeContext?: boolean;
}

export async function searchCodebase(options: SearchOptions): Promise<CodebaseSearchResponse> {
  const startTime = performance.now();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

  const project = await prisma.codebaseProject.findFirst({
    where: {
      organizationId: options.organizationId,
      externalId: options.projectExternalId,
      defaultBranch: options.branch ?? 'default',
    },
  });

  if (!project) {
    return {
      query: options.query,
      totalResults: 0,
      returnedResults: 0,
      matches: [],
      truncated: false,
      latencyMs: Math.round(performance.now() - startTime),
    };
  }

  const whereClauses = [
    Prisma.sql`project_id = ${project.id}`,
    Prisma.sql`content ILIKE '%' || ${options.query} || '%'`,
  ];

  if (options.fileTypes && options.fileTypes.length > 0) {
    const patterns = options.fileTypes
      .map((type) => {
        const trimmed = type.trim();
        if (!trimmed) return null;
        return trimmed.startsWith('.') ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
      })
      .filter((value): value is string => value !== null);

    if (patterns.length > 0) {
      const typeConditions = patterns.map(
        (pattern) => Prisma.sql`path ILIKE '%' || ${pattern} || '%'`
      );
      const typeConditionsSql = Prisma.join(typeConditions, ' OR ');
      whereClauses.push(Prisma.sql`(${typeConditionsSql})`);
    }
  }

  await prisma.$executeRaw`SELECT set_limit(0.04);`;

  const whereSql = Prisma.join(whereClauses, ' AND ');

  const totalResult = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM codebase_files
    WHERE ${whereSql}
  `;
  const total = totalResult.length > 0 ? Number(totalResult[0].count) : 0;

  const rows = await prisma.$queryRaw<
    {
      id: string;
      path: string;
      language: string | null;
      content: string;
      score: number;
    }[]
  >`
    SELECT id, path, language, content,
           similarity(content, ${options.query}) AS score
    FROM codebase_files
    WHERE ${whereSql}
    ORDER BY score DESC NULLS LAST, updated_at DESC
    LIMIT ${limit}
  `;

  const matches: CodebaseSearchMatch[] = rows.map((row) =>
    buildSearchMatch(row, options.query, options.includeContext ?? true)
  );

  const latencyMs = Math.round(performance.now() - startTime);

  return {
    query: options.query,
    totalResults: total,
    returnedResults: matches.length,
    latencyMs,
    matches,
    truncated: total > matches.length,
  };
}

function buildSearchMatch(
  row: { id: string; path: string; language: string | null; content: string; score: number },
  query: string,
  includeContext: boolean
): CodebaseSearchMatch {
  const lines = row.content.split(/\r?\n/);
  const queryLower = query.toLowerCase();
  const matchIndex = row.content.toLowerCase().indexOf(queryLower);

  let startLine = 1;
  if (matchIndex >= 0) {
    const preceding = row.content.slice(0, matchIndex);
    startLine = preceding.split(/\r?\n/).length;
  }

  const snippetStart = Math.max(startLine - 1, 0);
  const snippetEnd = Math.min(snippetStart + 20, lines.length);
  const snippetLines = lines.slice(snippetStart, snippetEnd);

  const contentSnippet = snippetLines.join('\n').slice(0, 2000);

  const match: CodebaseSearchMatch = {
    id: row.id,
    filePath: row.path,
    startLine,
    endLine: snippetStart + snippetLines.length,
    content: contentSnippet,
    score: Number.isFinite(row.score) ? Number(row.score) : 0,
    language: row.language ?? undefined,
    highlights: [
      {
        startLine,
        endLine: snippetStart + snippetLines.length,
      },
    ],
    metadata: {
      type: 'file',
      name: row.path,
    },
  };

  if (includeContext) {
    const beforeStart = Math.max(startLine - 4, 1);
    const afterEnd = Math.min(snippetEnd + 3, lines.length);
    match.context = {
      before: lines.slice(beforeStart - 1, startLine - 1).join('\n'),
      after: lines.slice(snippetEnd, afterEnd).join('\n'),
    };
  }

  return match;
}
