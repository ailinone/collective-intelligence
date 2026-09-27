// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for the tool sandbox containment check.
 *
 * Every "stay inside workingDirectory" guard in tool-execution-service.ts and
 * advanced-tool-execution-service.ts used `fullPath.startsWith(workingDirectory)`,
 * which a sibling directory sharing the same prefix satisfies
 * (`/sandbox/base` vs `/sandbox/base-evil`). They now go through
 * `isPathWithinDirectory`, which compares via `path.relative`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';

import { isPathWithinDirectory, executeListDirectoryTool } from '@/services/tool-execution-service';
import { executeDeleteFileTool } from '@/services/advanced-tool-execution-service';

function stubLogger(): Logger {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => log,
  };
  return log as unknown as Logger;
}

describe('isPathWithinDirectory', () => {
  const base = path.resolve('/srv/sandbox/base');

  it('accepts the base itself and its descendants', () => {
    expect(isPathWithinDirectory(base, base)).toBe(true);
    expect(isPathWithinDirectory(base, path.join(base, 'a', 'b.txt'))).toBe(true);
  });

  it('rejects a sibling directory that shares the base as a string prefix', () => {
    expect(isPathWithinDirectory(base, path.resolve('/srv/sandbox/base-evil/x'))).toBe(false);
    expect(isPathWithinDirectory(base, path.resolve('/srv/sandbox/base2'))).toBe(false);
  });

  it('rejects parent traversal', () => {
    expect(isPathWithinDirectory(base, path.resolve(base, '..'))).toBe(false);
    expect(isPathWithinDirectory(base, path.resolve(base, '../../etc/passwd'))).toBe(false);
  });
});

describe('tool handlers refuse sibling-prefix escapes', () => {
  let root: string;
  let base: string;
  let victim: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tool-containment-'));
    base = path.join(root, 'base');
    const sibling = path.join(root, 'base-evil');
    await mkdir(base, { recursive: true });
    await mkdir(sibling, { recursive: true });
    victim = path.join(sibling, 'victim.txt');
    await writeFile(victim, 'must survive');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('delete_file does not delete a file in a prefix-sharing sibling directory', async () => {
    const result = await executeDeleteFileTool({ filePath: '../base-evil/victim.txt' }, 'call-1', {
      workingDirectory: base,
      log: stubLogger(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside working directory/);
    await expect(access(victim)).resolves.toBeUndefined();
  });

  it('list_directory does not list a prefix-sharing sibling directory', async () => {
    const result = await executeListDirectoryTool({ path: '../base-evil' }, 'call-2', {
      workingDirectory: base,
      log: stubLogger(),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('victim.txt');
  });
});
