// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared workspace-path guard for tool executors (filesystem/git/shell).
 *
 * Extracted from routes/tools/tools-routes.ts (2026-07-29) so the SAME clamp
 * protects every caller that resolves a client-supplied `working_directory`
 * into a real filesystem path — previously chat-request-processor.ts's
 * automatic tool_calls loop resolved it with a bare `path.resolve()`
 * (services/chat-request-processor.ts), letting a client point any tool at
 * an arbitrary absolute path on the host. That loop has no other reason to
 * import from a routes module, so this lives in utils instead.
 */
import path from 'node:path';
import { logger } from '@/utils/logger';

/**
 * Server-controlled base for tool filesystem/shell operations. Tool
 * executors run git and file operations under `context.workingDirectory`;
 * without a clamp a caller could point any tool at an arbitrary absolute
 * path on the host (`/etc`, another tenant's checkout, …).
 */
export function getToolsBaseDir(): string {
  const configured = process.env.TOOLS_BASE_DIR;
  return path.resolve(configured && configured.length > 0 ? configured : process.cwd());
}

/**
 * Resolve a client-supplied working_directory against the server base,
 * refusing anything that escapes the base. Returns the safe absolute path
 * (the base itself when no/invalid value is supplied).
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
      'Tool working_directory escapes the allowed base — clamping to base'
    );
    return base;
  }
  return resolved;
}
