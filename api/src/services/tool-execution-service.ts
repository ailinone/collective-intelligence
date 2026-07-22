// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool Execution Service
 *
 * Implements CLI tools execution in the API for centralized processing.
 * Based on ailin-cli tool implementations for full compatibility.
 *
 * Features:
 * - File operations (search_replace, grep_search)
 * - Git operations (status, commit, diff, push, pull)
 * - Multi-file operations (atomic changes with rollback)
 * - Security: Path validation, timeout controls
 */

import type { Logger } from 'pino';
import { promises as fs } from 'fs';
import path from 'path';
import { narrowAs } from '@/utils/type-guards';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * SECURITY: shell-free git execution.
 *
 * `execAsync` (promisified `exec`) runs the command string through `/bin/sh`,
 * so any user-controlled token interpolated into the string (remote, branch,
 * commit message, …) can break out of the intended command via shell
 * metacharacters (`;`, `&&`, `$(…)`, backticks, `|`, …). The previous git
 * push/commit/merge/rebase/pull/create-branch implementations interpolated
 * client-supplied values directly, giving an authenticated caller arbitrary
 * command execution.
 *
 * `execFileAsync` runs the binary directly with an ARGUMENT ARRAY and NO shell,
 * so each argument is passed verbatim to git as a single argv entry — shell
 * metacharacters are inert. All git invocations below use this instead.
 */
const execFileAsync = promisify(execFile);

/**
 * Run `git` with the given argv array in `cwd`, never via a shell.
 * Returns the combined stdout/stderr the callers already surface.
 */
async function runGit(
  argv: string[],
  cwd: string,
  timeout: number,
  maxBuffer?: number
): Promise<{ stdout: string; stderr: string }> {
  // `shell` defaults to false for execFile — being explicit documents intent
  // and guards against a future refactor flipping it on.
  const { stdout, stderr } = await execFileAsync('git', argv, {
    cwd,
    timeout,
    shell: false,
    encoding: 'utf8',
    ...(maxBuffer !== undefined ? { maxBuffer } : {}),
  });
  return { stdout, stderr };
}

/**
 * SECURITY: reject an obviously hostile git ref/remote name before it reaches
 * argv. Even though argv (no shell) already neutralizes command injection,
 * git itself treats a leading `-` as an option — so a branch literally named
 * `--upload-pack=…` could smuggle an option into `git push origin <branch>`.
 * Disallowing a leading dash (and control chars) closes that argument-injection
 * vector. This is intentionally permissive otherwise: real refs allow `/`, `.`,
 * `-` in the middle, etc.
 */
export function assertSafeGitToken(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${label}: must not be empty`);
  }
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${label}: must not start with '-' (option injection)`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}: contains control characters`);
  }
}

/**
 * SECURITY: second-order command injection guard for git `remote` values
 * (js/second-order-command-line-injection). `assertSafeGitToken` blocks a
 * leading '-' (ordinary option injection), but git also recognizes special
 * "remote helper" URL schemes — notably `ext::<shell command>` and `fd::` —
 * that make the `git` binary itself execute an arbitrary command once it
 * parses the remote string. That happens even though we invoke git via
 * execFile with no shell: the shell-out occurs *inside* git, one level
 * removed, which is exactly the "second order" injection this rule flags.
 * A leading-dash check doesn't catch it because `ext::…` doesn't start with
 * '-'. Close it with an allowlist: either a plain configured-remote name, or
 * a conventional https/ssh/git URL whose host doesn't itself start with '-'
 * (blocking the related `ssh://-oProxyCommand=…` option-injection trick).
 */
const SAFE_GIT_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_GIT_REMOTE_URL = /^(?:https:\/\/|ssh:\/\/|git:\/\/|git@)[A-Za-z0-9][A-Za-z0-9._~%!$&'()*+,;=:@/-]*$/;

export function assertSafeGitRemote(value: string, label: string): void {
  assertSafeGitToken(value, label);
  if (SAFE_GIT_REMOTE_NAME.test(value) || SAFE_GIT_REMOTE_URL.test(value)) {
    return;
  }
  throw new Error(
    `Invalid ${label}: must be a plain remote name or an https/ssh/git URL`
  );
}

/**
 * SECURITY: exact "is this path inside that directory" check
 * (js/path-injection). A naked `resolved.startsWith(baseDir)` prefix check
 * is bypassable via sibling-directory collisions — e.g. baseDir "/base"
 * incorrectly matches "/base-evil" — because it never enforces a path
 * separator boundary. Comparing via `path.relative` is exact: the relative
 * path from base to target starts with '..' (or is itself absolute, e.g.
 * across Windows drives) if and only if target escapes base.
 */
function isPathWithinDirectory(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/**
 * SECURITY (js/regex-injection, js/incomplete-sanitization): convert a
 * simple glob pattern (`*` = any run of chars, `?` = any single char) into a
 * RegExp, escaping every *other* regex metacharacter first so a filename
 * like "release(1).ts" or "a+b.txt" matches literally instead of being
 * parsed as a regex group/quantifier. The previous inline conversions only
 * escaped '.' and never escaped a literal backslash in the input, so any
 * other metacharacter (or a backslash) leaked through into the compiled
 * pattern uncontrolled.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(withWildcards);
}

/**
 * SECURITY (js/regex-injection, CWE-400): `search`/`pattern` below is an
 * *intentional* user-supplied regex — the caller explicitly opted into
 * regex mode for search/replace or grep, so escaping it the way
 * `globToRegExp` does would silently turn regex mode into literal-string
 * mode and break the feature. Instead, bound the worst case: cap pattern
 * length and reject the classic nested-quantifier shape (`(a+)+`, `(a*)*`,
 * `(a|a){2,}`, …) that causes catastrophic backtracking / ReDoS, while
 * leaving ordinary regex patterns unaffected.
 */
const MAX_USER_REGEX_LENGTH = 500;
const CATASTROPHIC_REGEX_SHAPE = /\([^()]*[+*][^()]*\)[+*]|\([^()]*[+*][^()]*\)\{\d*,/;

function assertSafeUserRegex(source: string, label: string): void {
  if (source.length > MAX_USER_REGEX_LENGTH) {
    throw new Error(`Invalid ${label}: pattern too long (max ${MAX_USER_REGEX_LENGTH} chars)`);
  }
  if (CATASTROPHIC_REGEX_SHAPE.test(source)) {
    throw new Error(`Invalid ${label}: nested quantifiers can cause catastrophic backtracking`);
  }
}

/**
 * Simple glob-like file matcher using native fs
 * Supports basic patterns like **\/*.ts
 */
async function findFiles(
  pattern: string | string[],
  options: {
    cwd: string;
    absolute?: boolean;
    ignore?: string[];
  }
): Promise<string[]> {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const { cwd, absolute = false, ignore = [] } = options;
  const results: string[] = [];

  const ignoreSet = new Set(ignore.map((i) => i.replace(/\*\*/g, '').replace(/\*/g, '')));

  async function walkDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(cwd, fullPath);

        // Check ignore patterns
        const shouldIgnore = Array.from(ignoreSet).some(
          (ign) => relativePath.includes(ign) || entry.name.startsWith('.')
        );

        if (shouldIgnore) continue;

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          // Simple pattern matching
          const matchesAny = patterns.some((p) => {
            if (p === '**/*') return true;
            if (p.startsWith('**/')) {
              const ext = p.slice(3);
              return relativePath.endsWith(ext) || entry.name === ext;
            }
            if (p.includes('*')) {
              const regex = globToRegExp(p);
              return regex.test(relativePath) || regex.test(entry.name);
            }
            return relativePath === p || entry.name === p;
          });

          if (matchesAny) {
            results.push(absolute ? fullPath : relativePath);
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await walkDir(cwd);
  return results;
}

// ============================================
// Types
// ============================================

export interface ToolResult {
  tool_call_id: string;
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  workingDirectory: string;
  timeout?: number;
  log: Logger;
  organizationId?: string;
  userId?: string;
  /**
   * Cross-modal capability invoker (option B, 2026-06-11). Populated by
   * createToolContext so a tool handler (e.g. generate_video) can drive
   * modality generation through the shared CapabilityInvoker. Optional — code
   * tools (file/git/search) don't need it.
   */
  invoker?: import('@/core/orchestration/capability-invoker').CapabilityInvoker;
}

// ============================================
// SEARCH_REPLACE TOOL
// Based on: cli/src/core/tools/file-tools.ts:140-207
// ============================================

interface SearchReplaceArgs {
  file_path: string;
  search: string;
  replace: string;
  regex?: boolean;
  all?: boolean;
}

/**
 * Search and replace text in a file
 * Supports both literal string and regex patterns
 */
export async function executeSearchReplaceTool(
  args: SearchReplaceArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { file_path, search, replace, regex = false, all = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, file_path);

    // Security: Validate path is within working directory
    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }

    // Check file exists
    try {
      await fs.access(fullPath);
    } catch {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `File not found: ${file_path}`,
      };
    }

    // Read file content
    let content = await fs.readFile(fullPath, 'utf-8');
    let replacements = 0;

    if (regex) {
      assertSafeUserRegex(search, 'search');
      const flags = all ? 'g' : '';
      const pattern = new RegExp(search, flags);
      const matches = content.match(pattern);
      replacements = matches ? matches.length : 0;
      content = content.replace(pattern, replace);
    } else {
      if (all) {
        const parts = content.split(search);
        replacements = parts.length - 1;
        content = parts.join(replace);
      } else {
        if (content.includes(search)) {
          replacements = 1;
          content = content.replace(search, replace);
        }
      }
    }

    if (replacements === 0) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `No matches found for "${search}" in ${file_path}`,
      };
    }

    // Write updated content
    await fs.writeFile(fullPath, content, 'utf-8');

    log.info({ file_path, replacements }, 'Search/replace completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Replaced ${replacements} occurrence(s) in ${file_path}`,
      metadata: {
        file_path,
        replacements,
        search,
        replace: replace.substring(0, 50) + (replace.length > 50 ? '...' : ''),
      },
    };
  } catch (error) {
    log.error({ file_path, error }, 'Search/replace failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Search/replace failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// GREP_SEARCH TOOL
// Based on: cli/src/core/tools/file-tools.ts:362-450
// ============================================

interface GrepSearchArgs {
  pattern: string;
  path?: string;
  file_pattern?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  max_results?: number;
  include_context?: boolean;
  context_lines?: number;
}

interface SearchResult {
  file: string;
  line: number;
  content: string;
  context?: string;
}

/**
 * Search for patterns across files using grep-like functionality
 * Fast text search with regex support
 */
export async function executeGrepSearchTool(
  args: GrepSearchArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const {
    pattern,
    path: searchPath = '.',
    file_pattern = '**/*',
    regex = false,
    case_sensitive = false,
    max_results = 100,
    include_context = false,
    context_lines = 2,
  } = args;
  const { workingDirectory, log } = context;

  try {
    const fullSearchPath = path.resolve(workingDirectory, searchPath);

    // Security check
    if (!isPathWithinDirectory(workingDirectory, fullSearchPath)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: path is outside working directory',
      };
    }

    // Find matching files
    const files = await findFiles(file_pattern, {
      cwd: fullSearchPath,
      absolute: true,
      ignore: [
        'node_modules',
        '.git',
        'dist',
        'build',
        '.min.js',
        '.min.css',
        '.map',
        'coverage',
        '.next',
        '.cache',
      ],
    });

    if (regex) assertSafeUserRegex(pattern, 'pattern');

    const results: SearchResult[] = [];
    const searchPattern = regex
      ? new RegExp(pattern, case_sensitive ? '' : 'i')
      : pattern;

    for (const file of files) {
      if (results.length >= max_results) break;

      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          if (results.length >= max_results) return;

          const matches = regex
            ? (searchPattern as RegExp).test(line)
            : case_sensitive
              ? line.includes(pattern)
              : line.toLowerCase().includes(pattern.toLowerCase());

          if (matches) {
            const contextBlock = include_context
              ? lines
                .slice(Math.max(0, index - context_lines), Math.min(lines.length, index + 1 + context_lines))
                .join('\n')
                .trim()
              : undefined;

            results.push({
              file: path.relative(workingDirectory, file),
              line: index + 1,
              content: line.trim().substring(0, 200),
              context: contextBlock,
            });
          }
        });
      } catch {
        // Skip binary or unreadable files
        continue;
      }
    }

    if (results.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No matches found for pattern "${pattern}"`,
        metadata: { pattern, matches: 0, files_searched: files.length },
      };
    }

    // Format output
    let output = `Found ${results.length} match(es):\n\n`;
    for (const result of results) {
      output += `${result.file}:${result.line}: ${result.content}\n`;
      if (include_context && result.context) {
        output += `${result.context}\n\n`;
      }
    }

    if (results.length >= max_results) {
      output += `\n... (truncated at ${max_results} results)`;
    }

    log.info({ pattern, matches: results.length }, 'Grep search completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: {
        pattern,
        matches: results.length,
        files_with_matches: new Set(results.map((r) => r.file)).size,
        truncated: results.length >= max_results,
        contextIncluded: include_context,
        contextLines: include_context ? context_lines : 0,
      },
    };
  } catch (error) {
    log.error({ pattern, error }, 'Grep search failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Grep search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// GIT TOOLS
// Based on: cli/src/core/tools/git-tools.ts
// ============================================

/**
 * Get Git repository status
 */
export async function executeGitStatusTool(
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { workingDirectory, log } = context;

  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: workingDirectory,
      timeout: 10000,
    });

    const { stdout: branch } = await execAsync('git branch --show-current', {
      cwd: workingDirectory,
      timeout: 5000,
    });

    let output = `Current branch: ${branch.trim()}\n\n`;

    if (!stdout.trim()) {
      output += 'Working tree clean - no changes';
    } else {
      const lines = stdout.trim().split('\n');
      const staged: string[] = [];
      const modified: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);

        if (status.startsWith('A') || status.startsWith('M ')) {
          staged.push(file);
        } else if (status.includes('M') || status.includes('D')) {
          modified.push(file);
        } else if (status === '??') {
          untracked.push(file);
        }
      }

      if (staged.length > 0) {
        output += `Staged (${staged.length}):\n`;
        staged.forEach((f) => (output += `  + ${f}\n`));
        output += '\n';
      }

      if (modified.length > 0) {
        output += `Modified (${modified.length}):\n`;
        modified.forEach((f) => (output += `  ~ ${f}\n`));
        output += '\n';
      }

      if (untracked.length > 0) {
        output += `Untracked (${untracked.length}):\n`;
        untracked.forEach((f) => (output += `  ? ${f}\n`));
      }
    }

    log.info({ branch: branch.trim() }, 'Git status completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: {
        branch: branch.trim(),
        has_changes: stdout.trim().length > 0,
      },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git status failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GitCommitArgs {
  message: string;
  files?: string[];
}

/**
 * Create a Git commit
 */
export async function executeGitCommitTool(
  args: GitCommitArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { message, files } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array — file paths and the commit
    // message are passed as individual argv entries, so shell metacharacters
    // (`;`, `$(…)`, backticks, …) in a client-supplied message or filename are
    // inert. The `--` separator prevents any path from being parsed as an option.
    if (files && files.length > 0) {
      await runGit(['add', '--', ...files], workingDirectory, 30000);
    } else {
      await runGit(['add', '-A'], workingDirectory, 30000);
    }

    // Commit — message passed verbatim as a single argv entry (no shell, no
    // quoting/escaping needed; the previous `"`-only escaping was insufficient).
    const { stdout } = await runGit(['commit', '-m', message], workingDirectory, 30000);

    log.info({ message }, 'Git commit completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Commit created successfully:\n${stdout}`,
      metadata: { message },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git commit failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GitDiffArgs {
  files?: string[];
  staged?: boolean;
}

/**
 * Show Git diff
 */
export async function executeGitDiffTool(
  args: GitDiffArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { files, staged = false } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array — file paths after `--` are
    // passed verbatim (previously interpolated into a shell string).
    const argv = ['diff'];
    if (staged) argv.push('--staged');
    if (files && files.length > 0) {
      argv.push('--', ...files);
    }

    const { stdout } = await runGit(argv, workingDirectory, 30000, 1024 * 1024 * 5 /* 5MB */);

    if (!stdout.trim()) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: staged ? 'No staged changes' : 'No changes',
      };
    }

    log.info({ staged }, 'Git diff completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: stdout.substring(0, 50000), // Limit output
      metadata: { staged, lines: stdout.split('\n').length },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git diff failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GitPushArgs {
  remote?: string;
  branch?: string;
  force?: boolean;
  set_upstream?: boolean;
}

/**
 * Push commits to remote
 */
export async function executeGitPushTool(
  args: GitPushArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { remote = 'origin', branch, force = false, set_upstream = false } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array. Validate the client-supplied
    // remote/branch so neither can be parsed as a git option (leading `-`),
    // and the remote specifically against dangerous transport schemes
    // (js/second-order-command-line-injection — see assertSafeGitRemote).
    assertSafeGitRemote(remote, 'remote');
    if (branch) assertSafeGitToken(branch, 'branch');

    const argv = ['push', remote];
    if (branch) argv.push(branch);
    if (force) argv.push('--force');
    if (set_upstream) argv.push('--set-upstream');

    const { stdout, stderr } = await runGit(argv, workingDirectory, 60000);

    log.info({ remote, branch }, 'Git push completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: stdout || stderr || 'Push completed successfully',
      metadata: { remote, branch },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git push failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GitPullArgs {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

/**
 * Pull changes from remote
 */
export async function executeGitPullTool(
  args: GitPullArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { remote = 'origin', branch, rebase = false } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array (see runGit). Validate the
    // client-supplied remote/branch against option/control-char injection,
    // and the remote specifically against dangerous transport schemes
    // (js/second-order-command-line-injection — see assertSafeGitRemote).
    assertSafeGitRemote(remote, 'remote');
    if (branch) assertSafeGitToken(branch, 'branch');

    const argv = ['pull', remote];
    if (branch) argv.push(branch);
    if (rebase) argv.push('--rebase');

    const { stdout, stderr } = await runGit(argv, workingDirectory, 60000);

    log.info({ remote, branch }, 'Git pull completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: stdout || stderr || 'Pull completed successfully',
      metadata: { remote, branch },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git pull failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// MULTI-FILE TOOLS
// Based on: cli/src/core/tools/multi-file-tools.ts
// ============================================

interface FileChange {
  file_path: string;
  new_content?: string;
  content?: string;
  operation: 'create' | 'update' | 'delete';
}

interface ApplyMultiFileChangesArgs {
  changes: FileChange[];
  dry_run?: boolean;
}

/**
 * Apply changes to multiple files atomically
 * All changes succeed or all fail with rollback
 */
export async function executeApplyMultiFileChangesTool(
  args: ApplyMultiFileChangesArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { changes, dry_run = false } = args;
  const { workingDirectory, log } = context;

  const applied: string[] = [];
  const failed: Array<{ file: string; error: string }> = [];
  const originalContent = new Map<string, string>();
  // SECURITY: path resolved + boundary-checked once in Phase 1, reused for
  // every later use of this change.file_path (Phase 2 apply, rollback)
  // instead of re-resolving the raw client-supplied file_path a second time
  // with no check (js/path-injection).
  const resolvedPaths = new Map<string, string>();

  try {
    // Phase 1: Validate all files and backup existing content
    for (const change of changes) {
      const fullPath = path.resolve(workingDirectory, change.file_path);

      if (!isPathWithinDirectory(workingDirectory, fullPath)) {
        failed.push({ file: change.file_path, error: 'Path outside working directory' });
        continue;
      }
      resolvedPaths.set(change.file_path, fullPath);

      if (change.operation === 'update' || change.operation === 'delete') {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          originalContent.set(change.file_path, content);
        } catch {
          failed.push({ file: change.file_path, error: 'File not found' });
        }
      }
    }

    if (failed.length > 0) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Validation failed:\n${failed.map((f) => `- ${f.file}: ${f.error}`).join('\n')}`,
      };
    }

    if (dry_run) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `[DRY RUN] Would apply ${changes.length} changes:\n${changes.map((c) => `- ${c.operation.toUpperCase()}: ${c.file_path}`).join('\n')}`,
        metadata: { dry_run: true, changes: changes.length },
      };
    }

    // Phase 2: Apply changes
    for (const change of changes) {
      // SECURITY: reuse the path validated in Phase 1 rather than
      // re-resolving the raw file_path (js/path-injection). failed.length
      // was already checked above, so this should always be set; the guard
      // is belt-and-suspenders plus satisfies the Map<K,V>.get() type.
      const fullPath = resolvedPaths.get(change.file_path);
      if (!fullPath) {
        failed.push({ file: change.file_path, error: 'Path outside working directory' });
        continue;
      }

      try {
        switch (change.operation) {
          case 'create':
          case 'update': {
            const content = change.new_content ?? change.content;
            if (typeof content !== 'string') {
              throw new Error('Content is required for create/update operations');
            }

            const dir = path.dirname(fullPath);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(fullPath, content, 'utf-8');
            applied.push(`${change.operation.toUpperCase()}: ${change.file_path}`);
            break;
          }

          case 'delete':
            await fs.unlink(fullPath);
            applied.push(`DELETED: ${change.file_path}`);
            break;
        }
      } catch (error) {
        failed.push({
          file: change.file_path,
          error: error instanceof Error ? error.message : String(error),
        });

        // Rollback on failure
        log.warn({ file: change.file_path }, 'Rolling back changes due to failure');
        for (const appliedEntry of applied) {
          const filePath = appliedEntry.split(': ')[1];
          const original = originalContent.get(filePath);
          // SECURITY: reuse the Phase-1-validated path (js/path-injection)
          // instead of re-resolving the parsed-back filePath.
          const rollbackPath = resolvedPaths.get(filePath);
          if (original && rollbackPath) {
            try {
              await fs.writeFile(rollbackPath, original, 'utf-8');
            } catch (rollbackError) {
              log.error({ filePath, rollbackError }, 'Rollback failed');
            }
          }
        }

        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Failed to apply changes. Rolled back ${applied.length} file(s).\nError: ${failed[0].error}`,
        };
      }
    }

    log.info({ applied: applied.length }, 'Multi-file changes applied');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Successfully applied ${applied.length} changes:\n${applied.map((a) => `✅ ${a}`).join('\n')}`,
      metadata: { applied: applied.length },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Multi-file operation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface BatchSearchReplaceArgs {
  files: string[];
  search: string;
  replace: string;
  regex?: boolean;
  dry_run?: boolean;
}

/**
 * Search and replace across multiple files
 */
export async function executeBatchSearchReplaceTool(
  args: BatchSearchReplaceArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { files, search, replace, regex = false, dry_run = false } = args;
  const { workingDirectory, log } = context;

  try {
    // Expand glob patterns
    const matchedFiles = await findFiles(files, {
      cwd: workingDirectory,
    });

    if (matchedFiles.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `No files matched patterns: ${files.join(', ')}`,
      };
    }

    if (regex) assertSafeUserRegex(search, 'search');

    const changes: FileChange[] = [];
    let totalMatches = 0;

    for (const file of matchedFiles) {
      const fullPath = path.resolve(workingDirectory, file);

      // SECURITY: defensive re-validation (js/path-injection) even though
      // matchedFiles are walked from workingDirectory by findFiles().
      if (!isPathWithinDirectory(workingDirectory, fullPath)) {
        continue;
      }

      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        let newContent: string;
        let fileMatches = 0;

        if (regex) {
          const pattern = new RegExp(search, 'g');
          newContent = content.replace(pattern, () => {
            fileMatches++;
            return replace;
          });
        } else {
          const parts = content.split(search);
          fileMatches = parts.length - 1;
          newContent = parts.join(replace);
        }

        if (newContent !== content) {
          totalMatches += fileMatches;
          changes.push({
            file_path: file,
            new_content: newContent,
            operation: 'update',
          });
        }
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    if (changes.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `No matches found for "${search}" in ${matchedFiles.length} files`,
      };
    }

    if (dry_run) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `[DRY RUN] Would replace ${totalMatches} occurrence(s) in ${changes.length} file(s):\n${changes.map((c) => `- ${c.file_path}`).join('\n')}`,
        metadata: { dry_run: true, matches: totalMatches, files: changes.length },
      };
    }

    // Apply changes
    const result = await executeApplyMultiFileChangesTool(
      { changes, dry_run: false },
      toolCallId,
      context
    );

    if (result.success) {
      log.info({ matches: totalMatches, files: changes.length }, 'Batch search/replace completed');
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `Replaced ${totalMatches} occurrence(s) in ${changes.length} file(s)`,
        metadata: { matches: totalMatches, files: changes.length },
      };
    }

    return result;
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Batch search/replace failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// LIST DIRECTORY TOOL
// ============================================

interface ListDirectoryArgs {
  path?: string;
  recursive?: boolean;
  include_hidden?: boolean;
  max_depth?: number;
  file_pattern?: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

/**
 * List contents of a directory
 */
export async function executeListDirectoryTool(
  args: ListDirectoryArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const {
    path: targetPath = '.',
    recursive = false,
    include_hidden = false,
    max_depth = 3,
    file_pattern,
  } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, targetPath);

    // Security check
    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: path is outside working directory',
      };
    }

    // Check if path exists
    try {
      await fs.access(fullPath);
    } catch {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Directory not found: ${targetPath}`,
      };
    }

    const entries: DirectoryEntry[] = [];
    const patternRegex = file_pattern ? globToRegExp(file_pattern) : null;

    const scanDirectory = async (dir: string, currentDepth: number): Promise<void> => {
      if (currentDepth > max_depth) return;

      try {
        const items = await fs.readdir(dir, { withFileTypes: true });

        for (const item of items) {
          // Skip hidden files unless requested
          if (!include_hidden && item.name.startsWith('.')) {
            continue;
          }

          // Skip common ignore patterns
          if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'].includes(item.name)) {
            continue;
          }

          const itemPath = path.join(dir, item.name);
          const relativePath = path.relative(workingDirectory, itemPath);

          // Check pattern match
          if (patternRegex && !patternRegex.test(item.name)) {
            if (!item.isDirectory()) continue;
          }

          if (item.isDirectory()) {
            entries.push({
              name: item.name,
              path: relativePath,
              type: 'directory',
            });

            if (recursive) {
              await scanDirectory(itemPath, currentDepth + 1);
            }
          } else if (item.isFile()) {
            try {
              const stats = await fs.stat(itemPath);
              entries.push({
                name: item.name,
                path: relativePath,
                type: 'file',
                size: stats.size,
                modified: stats.mtime.toISOString(),
              });
            } catch {
              entries.push({
                name: item.name,
                path: relativePath,
                type: 'file',
              });
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    await scanDirectory(fullPath, 0);

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    // Format output
    let output = `Contents of ${targetPath}:\n\n`;
    
    const dirs = entries.filter(e => e.type === 'directory');
    const files = entries.filter(e => e.type === 'file');

    if (dirs.length > 0) {
      output += `Directories (${dirs.length}):\n`;
      for (const dir of dirs.slice(0, 100)) {
        output += `  📁 ${dir.path}/\n`;
      }
      if (dirs.length > 100) {
        output += `  ... and ${dirs.length - 100} more directories\n`;
      }
      output += '\n';
    }

    if (files.length > 0) {
      output += `Files (${files.length}):\n`;
      for (const file of files.slice(0, 100)) {
        const sizeStr = file.size !== undefined 
          ? ` (${formatFileSize(file.size)})`
          : '';
        output += `  📄 ${file.path}${sizeStr}\n`;
      }
      if (files.length > 100) {
        output += `  ... and ${files.length - 100} more files\n`;
      }
    }

    if (entries.length === 0) {
      output = `Directory ${targetPath} is empty or contains only hidden/ignored files`;
    }

    log.info({ targetPath, entries: entries.length }, 'List directory completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: {
        path: targetPath,
        totalEntries: entries.length,
        directories: dirs.length,
        files: files.length,
        recursive,
      },
    };
  } catch (error) {
    log.error({ targetPath, error }, 'List directory failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `List directory failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ============================================
// ADDITIONAL GIT TOOLS
// ============================================

interface GitCreateBranchArgs {
  name: string;
  checkout?: boolean;
  from?: string;
}

/**
 * Create and optionally checkout a new Git branch
 */
export async function executeGitCreateBranchTool(
  args: GitCreateBranchArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { name, checkout = true, from } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array. Validate branch names against
    // option/control-char injection. `--` separates flags from refs.
    assertSafeGitToken(name, 'branch name');
    if (from) assertSafeGitToken(from, 'from ref');

    const branchArgv = ['branch', '--', name];
    if (from) branchArgv.push(from);
    await runGit(branchArgv, workingDirectory, 10000);

    // Checkout if requested
    if (checkout) {
      await runGit(['checkout', '--', name], workingDirectory, 10000);
    }

    log.info({ branch: name, checkout }, 'Git create branch completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Branch "${name}" created${checkout ? ' and checked out' : ''}`,
      metadata: { branch: name, checkout },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git create branch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GitMergeArgs {
  branch: string;
  no_fast_forward?: boolean;
  squash?: boolean;
  message?: string;
}

/**
 * Merge a branch into current branch
 */
export async function executeGitMergeTool(
  args: GitMergeArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { branch, no_fast_forward = false, squash = false, message } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array. Validate the branch ref; the
    // message is passed as its own argv entry (no quoting/escaping needed).
    // Fixed flags precede the `--` separator so the branch can never be parsed
    // as an option.
    assertSafeGitToken(branch, 'branch');

    const argv = ['merge'];
    if (no_fast_forward) argv.push('--no-ff');
    if (squash) argv.push('--squash');
    if (message) argv.push('-m', message);
    argv.push('--', branch);

    const { stdout, stderr } = await runGit(argv, workingDirectory, 60000);

    log.info({ branch }, 'Git merge completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: stdout || stderr || `Merged branch "${branch}" successfully`,
      metadata: { branch, no_fast_forward, squash },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GitRebaseArgs {
  branch: string;
  interactive?: boolean;
  abort?: boolean;
  continue_rebase?: boolean;
}

/**
 * Rebase current branch onto another branch
 */
export async function executeGitRebaseTool(
  args: GitRebaseArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { branch, interactive = false, abort = false, continue_rebase = false } = args;
  const { workingDirectory, log } = context;

  try {
    // SECURITY: shell-free git via argv array.
    let argv: string[];

    if (abort) {
      argv = ['rebase', '--abort'];
    } else if (continue_rebase) {
      argv = ['rebase', '--continue'];
    } else {
      // SECURITY/HEADLESS: `git rebase -i` opens the sequence editor (and per-
      // commit commit-message editor) and blocks waiting for interactive input.
      // This service runs headless with no TTY/editor, so an interactive rebase
      // would hang until the 60s timeout and then leave the repo mid-rebase.
      // Reject it explicitly with an actionable message rather than silently
      // dropping `-i` (which would surprise a caller that expected to reorder/
      // squash commits) or auto-completing the todo list with a no-op editor
      // (which would apply an unintended, non-reviewable rewrite).
      if (interactive) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error:
            'Interactive rebase (interactive:true) is not supported in this headless ' +
            'environment: `git rebase -i` requires a sequence editor and would block. ' +
            'Use a non-interactive rebase (omit interactive), or perform the ' +
            'interactive rewrite locally.',
        };
      }
      // Validate the client-supplied branch ref against option/control-char
      // injection before placing it after the fixed flags.
      assertSafeGitToken(branch, 'branch');
      argv = ['rebase', branch];
    }

    const { stdout, stderr } = await runGit(argv, workingDirectory, 60000);

    log.info({ branch, abort, continue_rebase }, 'Git rebase completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: stdout || stderr || `Rebase ${abort ? 'aborted' : continue_rebase ? 'continued' : 'completed'}`,
      metadata: { branch, abort, continue_rebase },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git rebase failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// WORKSPACE TASK MANAGEMENT TOOLS
// ============================================

interface TodoItem {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
  created_at: number;
  updated_at: number;
  completed_at?: number;
}

interface TodoList {
  items: TodoItem[];
  created_at: number;
  updated_at: number;
}

const TASKS_FILE = '.ailin/todos.json';

async function loadTodoList(workingDirectory: string): Promise<TodoList> {
  const filePath = path.join(workingDirectory, TASKS_FILE);
  // SECURITY (js/path-injection): TASKS_FILE is a fixed relative constant so
  // this can't actually escape workingDirectory today, but validate the
  // resolved path locally anyway so the guard travels with the sink rather
  // than relying solely on the working_directory clamp in the route layer.
  if (!isPathWithinDirectory(workingDirectory, filePath)) {
    throw new Error('Access denied: tasks file outside working directory');
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return narrowAs<TodoList>(JSON.parse(content));
  } catch {
    return {
      items: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }
}

async function saveTodoList(workingDirectory: string, todoList: TodoList): Promise<void> {
  const filePath = path.join(workingDirectory, TASKS_FILE);
  // SECURITY (js/path-injection): see loadTodoList above.
  if (!isPathWithinDirectory(workingDirectory, filePath)) {
    throw new Error('Access denied: tasks file outside working directory');
  }
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, { recursive: true });
  todoList.updated_at = Date.now();
  await fs.writeFile(filePath, JSON.stringify(todoList, null, 2), 'utf-8');
}

interface CreateTodoArgs {
  description: string;
  priority?: 'high' | 'medium' | 'low';
}

/**
 * Create a new workspace task
 */
export async function executeCreateTodoTool(
  args: CreateTodoArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { description, priority = 'medium' } = args;
  const { workingDirectory, log } = context;

  try {
    const todoList = await loadTodoList(workingDirectory);

    const newTodo: TodoItem = {
      id: `todo_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      description,
      status: 'pending',
      priority,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    todoList.items.push(newTodo);
    await saveTodoList(workingDirectory, todoList);

    log.info({ todoId: newTodo.id }, 'Task created');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Created task: ${description} (ID: ${newTodo.id})`,
      metadata: { todo: newTodo },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Create task failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface UpdateTodoArgs {
  id: string;
  description?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}

/**
 * Update an existing workspace task
 */
export async function executeUpdateTodoTool(
  args: UpdateTodoArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { id, description, status, priority } = args;
  const { workingDirectory, log } = context;

  try {
    const todoList = await loadTodoList(workingDirectory);
    const todoIndex = todoList.items.findIndex((item) => item.id === id);

    if (todoIndex === -1) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Task not found: ${id}`,
      };
    }

    const todo = todoList.items[todoIndex];

    if (description !== undefined) todo.description = description;
    if (priority !== undefined) todo.priority = priority;
    if (status !== undefined) {
      todo.status = status;
      if (status === 'completed' && !todo.completed_at) {
        todo.completed_at = Date.now();
      } else if (status !== 'completed') {
        todo.completed_at = undefined;
      }
    }
    todo.updated_at = Date.now();

    await saveTodoList(workingDirectory, todoList);

    log.info({ todoId: id }, 'Task updated');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Updated task: ${todo.description} (Status: ${todo.status})`,
      metadata: { todo },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Update task failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface CheckTodoArgs {
  id: string;
}

/**
 * Convenience tool to mark a task as completed
 */
export async function executeCheckTodoTool(
  args: CheckTodoArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { id } = args;
  if (!id) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: 'Task id is required',
    };
  }

  return executeUpdateTodoTool(
    { id, status: 'completed' },
    toolCallId,
    context
  );
}

interface ListTodosArgs {
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}

/**
 * List all workspace tasks
 */
export async function executeListTodosTool(
  args: ListTodosArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { status, priority } = args;
  const { workingDirectory, log } = context;

  try {
    const todoList = await loadTodoList(workingDirectory);

    let items = todoList.items;

    if (status) {
      items = items.filter((item) => item.status === status);
    }
    if (priority) {
      items = items.filter((item) => item.priority === priority);
    }

    // Sort by priority then by creation date
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => {
      const aPriority = priorityOrder[a.priority || 'medium'];
      const bPriority = priorityOrder[b.priority || 'medium'];
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.created_at - b.created_at;
    });

    if (items.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: 'No tasks found',
        metadata: { total: 0 },
      };
    }

    const statusIcons: Record<string, string> = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      cancelled: '❌',
    };

    const priorityIcons: Record<string, string> = {
      high: '🔴',
      medium: '🟡',
      low: '🟢',
    };

    let output = `Task list (${items.length} items):\n\n`;
    for (const item of items) {
      const sIcon = statusIcons[item.status] || '⏳';
      const pIcon = priorityIcons[item.priority || 'medium'];
      output += `${sIcon} ${pIcon} [${item.id}] ${item.description}\n`;
    }

    log.info({ count: items.length }, 'Task list retrieved');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { total: items.length, items },
    };
  } catch (error) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `List tasks failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// WEB SEARCH TOOL
// ============================================

interface WebSearchArgs {
  query: string;
  num_results?: number;
  search_type?: 'general' | 'code' | 'docs' | 'news';
  search_depth?: 'basic' | 'deep';
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedDate?: string;
  score?: number;
}

/**
 * Perform a web search using multiple strategies:
 * 1. Try models with native web_search capability (Perplexity, Cohere Command R, etc.)
 * 2. Fall back to Tavily API if no capable models available
 * 3. Models are discovered dynamically from the ProviderRegistry
 */
export async function executeWebSearchTool(
  args: WebSearchArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { query, num_results = 5, search_type = 'general', search_depth = 'basic' } = args;
  const { log } = context;

  try {
    log.info({ query, num_results, search_type, search_depth }, 'Web search initiated');

    // Strategy 1: Try using a model with native web_search capability
    const { getCapabilityExecutionService } = await import('./capability-execution-service.js');
    const capabilityService = getCapabilityExecutionService();

    // Check if we have models with web_search capability
    const hasWebSearchCapability = await capabilityService.isCapabilityAvailable('web_search');

    if (hasWebSearchCapability) {
      log.debug('Using model with native web_search capability');

      // Build the search query based on type
      let searchPrompt = query;
      if (search_type === 'code') {
        searchPrompt = `Search for code examples and programming documentation: ${query}`;
      } else if (search_type === 'docs') {
        searchPrompt = `Search for official documentation and technical references: ${query}`;
      } else if (search_type === 'news') {
        searchPrompt = `Search for recent news and updates about: ${query}`;
      }

      // Get organizationId from context (required for OrchestrationEngine)
      const organizationId = context.organizationId || 'default-org';
      const userId = context.userId;

      // Execute through OrchestrationEngine for full orchestration
      const result = await capabilityService.executeWebSearchRequest(searchPrompt, {
        searchDepth: search_depth,
        organizationId,
        userId,
      });

      if (result.success && result.response) {
        const responseContent = result.response.choices?.[0]?.message?.content || '';

        return {
          tool_call_id: toolCallId,
          success: true,
          output: `Web Search Results for "${query}":\n\n${responseContent}`,
          metadata: {
            query,
            num_results,
            search_type,
            search_depth,
            provider: result.providerUsed,
            model: result.modelUsed,
            source: 'model_capability',
          },
        };
      }

      // If model search failed, log and try fallback
      log.warn({ error: result.error }, 'Model web search failed, trying Tavily fallback');
    }

    // Strategy 2: Use Tavily API as fallback
    const { getTavilySearchService } = await import('./tavily-search-service.js');
    const tavilyService = getTavilySearchService();

    if (tavilyService.isAvailable()) {
      log.debug('Using Tavily API for web search');

      // Determine topic based on search_type
      const topic = search_type === 'news' ? 'news' : 'general';

      const tavilyResult = await tavilyService.search({
        query,
        searchDepth: search_depth === 'deep' ? 'advanced' : 'basic',
        maxResults: num_results,
        includeAnswer: true,
        topic,
      });

      if (tavilyResult.success) {
        const results: WebSearchResult[] = tavilyResult.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          source: 'tavily',
          publishedDate: r.publishedDate,
          score: r.score,
        }));

        let output = `Web Search Results for "${query}":\n\n`;

        // Include Tavily's generated answer if available
        if (tavilyResult.answer) {
          output += `📝 Summary:\n${tavilyResult.answer}\n\n`;
          output += `📚 Sources:\n`;
        }

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          output += `\n${i + 1}. ${result.title}\n`;
          output += `   🔗 ${result.url}\n`;
          if (result.publishedDate) {
            output += `   📅 ${result.publishedDate}\n`;
          }
          output += `   ${result.snippet.substring(0, 200)}${result.snippet.length > 200 ? '...' : ''}\n`;
        }

        return {
          tool_call_id: toolCallId,
          success: true,
          output,
          metadata: {
            query,
            num_results,
            search_type,
            search_depth,
            results,
            hasAnswer: !!tavilyResult.answer,
            responseTime: tavilyResult.responseTime,
            source: 'tavily',
          },
        };
      }

      // Tavily also failed
      log.error({ error: tavilyResult.error }, 'Tavily search failed');
    }

    // No search capability available
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Web search unavailable. No models with web_search capability found and Tavily API not configured. Set TAVILY_API_KEY for fallback search.`,
    };
  } catch (error) {
    log.error({ query, error }, 'Web search failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// CODEBASE SEARCH TOOL
// ============================================

interface CodebaseSearchArgs {
  query: string;
  file_pattern?: string;
  max_results?: number;
  include_context?: boolean;
  context_lines?: number;
}

/**
 * Search the codebase semantically
 */
export async function executeCodebaseSearchTool(
  args: CodebaseSearchArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { query, file_pattern, max_results = 10, include_context = true, context_lines = 2 } = args;
  const { workingDirectory, log } = context;

  try {
    // Use grep search as fallback for semantic search
    const grepArgs: GrepSearchArgs = {
      pattern: query,
      path: '.',
      file_pattern: file_pattern,
      max_results: max_results,
      include_context,
      context_lines,
    };

    log.info(
      { query, file_pattern, max_results, include_context, context_lines, workingDirectory },
      'Codebase search initiated',
    );

    // Perform search
    const result = await executeGrepSearchTool(grepArgs, toolCallId, context);

    if (result.success) {
      return {
        ...result,
        output: `Codebase Search Results for "${query}":\n\n${result.output}`,
      };
    }

    return result;
  } catch (error) {
    log.error({ query, error }, 'Codebase search failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Codebase search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// SEMANTIC CODE ANALYSIS TOOLS
// ============================================

import {
  semanticSearch,
  findSymbolReferences,
  getDependencyGraph,
  getProjectStats,
} from '@/services/code-analysis-service';

interface FindSymbolReferencesArgs {
  symbol_name: string;
  symbol_type?: string;
  project_id?: string;
  branch?: string;
}

/**
 * Find all references to a symbol in the codebase
 */
export async function executeFindSymbolReferencesTool(
  args: FindSymbolReferencesArgs,
  toolCallId: string,
  context: ToolExecutionContext & { organizationId?: string; projectId?: string }
): Promise<ToolResult> {
  const { symbol_name, symbol_type, project_id, branch } = args;
  const { log } = context;

  try {
    const orgId = context.organizationId || 'default';
    const projId = project_id || context.projectId || 'default';

    const references = await findSymbolReferences(
      orgId,
      projId,
      symbol_name,
      symbol_type,
      branch
    );

    if (references.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No references found for symbol "${symbol_name}"`,
        metadata: { symbolName: symbol_name, found: 0 },
      };
    }

    let output = `Found ${references.length} reference(s) for "${symbol_name}":\n\n`;

    for (const ref of references) {
      output += `📍 ${ref.filePath}:${ref.startLine}\n`;
      output += `   Symbol: ${ref.symbolName} (${ref.symbolType})\n`;
      output += `   Definition: ${ref.isDefinition ? 'Yes' : 'No'}\n`;
      output += `   References: ${ref.referenceCount}\n`;
      output += '\n';
    }

    log.info({ symbolName: symbol_name, found: references.length }, 'Find symbol references completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { symbolName: symbol_name, found: references.length, references },
    };
  } catch (error) {
    log.error({ symbolName: symbol_name, error }, 'Find symbol references failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Find symbol references failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface AnalyzeCodebaseArgs {
  project_id?: string;
  branch?: string;
  include_stats?: boolean;
  include_symbols?: boolean;
}

/**
 * Analyze the codebase structure and provide statistics
 */
export async function executeAnalyzeCodebaseTool(
  args: AnalyzeCodebaseArgs,
  toolCallId: string,
  context: ToolExecutionContext & { organizationId?: string; projectId?: string }
): Promise<ToolResult> {
  const { project_id, branch, include_stats = true, include_symbols = false } = args;
  const { log } = context;

  try {
    const orgId = context.organizationId || 'default';
    const projId = project_id || context.projectId || 'default';

    let output = `Codebase Analysis for project "${projId}":\n\n`;

    if (include_stats) {
      const stats = await getProjectStats(orgId, projId, branch);
      
      if (stats) {
        output += `📊 Statistics:\n`;
        output += `   Total Files: ${stats.fileCount}\n`;
        output += `   Total Symbols: ${stats.symbolCount}\n`;
        output += `   Total Dependencies: ${stats.dependencyCount}\n`;
        output += `   Total Lines: ${stats.totalLines}\n\n`;

        if (stats.languageDistribution && Object.keys(stats.languageDistribution).length > 0) {
          output += `📝 Languages:\n`;
          for (const [lang, count] of Object.entries(stats.languageDistribution)) {
            output += `   ${lang}: ${count} files\n`;
          }
          output += '\n';
        }

        if (include_symbols && stats.symbolTypeDistribution && Object.keys(stats.symbolTypeDistribution).length > 0) {
          output += `🔧 Symbol Types:\n`;
          for (const [type, count] of Object.entries(stats.symbolTypeDistribution)) {
            output += `   ${type}: ${count}\n`;
          }
          output += '\n';
        } else if (!include_symbols) {
          output += '🔧 Symbol details omitted (set include_symbols=true to include).\n\n';
        }
      } else {
        output += `📊 Statistics: Project not indexed yet\n\n`;
      }
    }

    log.info({ projectId: projId }, 'Analyze codebase completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { projectId: projId, branch, includeSymbols: include_symbols },
    };
  } catch (error) {
    log.error({ error }, 'Analyze codebase failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Analyze codebase failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface GetDependencyGraphArgs {
  file_path?: string;
  symbol_name?: string;
  depth?: number;
  project_id?: string;
  branch?: string;
}

/**
 * Get dependency graph for a file or symbol
 */
export async function executeGetDependencyGraphTool(
  args: GetDependencyGraphArgs,
  toolCallId: string,
  context: ToolExecutionContext & { organizationId?: string; projectId?: string }
): Promise<ToolResult> {
  const { file_path, symbol_name, depth = 2, project_id, branch } = args;
  const { log } = context;

  try {
    const orgId = context.organizationId || 'default';
    const projId = project_id || context.projectId || 'default';

    const dependencies = await getDependencyGraph(
      orgId,
      projId,
      file_path,
      Math.min(depth, 5),
      branch
    );

    if (dependencies.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No dependencies found${file_path ? ` for ${file_path}` : ''}${symbol_name ? ` for symbol "${symbol_name}"` : ''}`,
        metadata: { dependencies: 0 },
      };
    }

    // Extract unique files as nodes
    const uniqueFiles = new Set<string>();
    for (const dep of dependencies) {
      uniqueFiles.add(dep.sourceFile);
      uniqueFiles.add(dep.targetFile);
    }

    let output = `Dependency Graph${file_path ? ` for ${file_path}` : ''}${symbol_name ? ` for "${symbol_name}"` : ''}:\n\n`;
    
    output += `📊 Summary: ${uniqueFiles.size} files, ${dependencies.length} dependencies\n\n`;

    output += `📄 Files involved:\n`;
    const fileList = Array.from(uniqueFiles).slice(0, 20);
    for (const file of fileList) {
      output += `   ${file}\n`;
    }
    if (uniqueFiles.size > 20) {
      output += `   ... and ${uniqueFiles.size - 20} more\n`;
    }

    output += `\n🔗 Dependencies:\n`;
    for (const dep of dependencies.slice(0, 20)) {
      output += `   ${dep.sourceFile} → ${dep.targetFile} (${dep.dependencyType})\n`;
    }
    if (dependencies.length > 20) {
      output += `   ... and ${dependencies.length - 20} more\n`;
    }

    log.info({ files: uniqueFiles.size, dependencies: dependencies.length }, 'Get dependency graph completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { files: uniqueFiles.size, dependencies: dependencies.length, graph: dependencies },
    };
  } catch (error) {
    log.error({ error }, 'Get dependency graph failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Get dependency graph failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface SemanticSearchArgs {
  query: string;
  limit?: number;
  project_id?: string;
  branch?: string;
}

/**
 * Perform semantic search across the codebase
 */
export async function executeSemanticSearchTool(
  args: SemanticSearchArgs,
  toolCallId: string,
  context: ToolExecutionContext & { organizationId?: string; projectId?: string }
): Promise<ToolResult> {
  const { query, limit = 10, project_id, branch } = args;
  const { log } = context;

  try {
    const orgId = context.organizationId || 'default';
    const projId = project_id || context.projectId || 'default';

    const results = await semanticSearch({
      organizationId: orgId,
      projectId: projId,
      query,
      limit: Math.min(limit, 50),
      branch,
    });

    if (results.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No results found for semantic search: "${query}"`,
        metadata: { query, found: 0 },
      };
    }

    let output = `Semantic Search Results for "${query}":\n\n`;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      output += `${i + 1}. 📄 ${result.filePath}\n`;
      output += `   Relevance: ${(result.relevanceScore * 100).toFixed(1)}%\n`;
      output += `   Match Type: ${result.matchType}\n`;
      
      if (result.symbolMatches && result.symbolMatches.length > 0) {
        output += `   Symbols: ${result.symbolMatches.map(s => `${s.name} (${s.type})`).join(', ')}\n`;
      }
      
      if (result.contentSnippet) {
        output += `   Snippet: ${result.contentSnippet.substring(0, 100)}...\n`;
      }
      output += '\n';
    }

    log.info({ query, found: results.length }, 'Semantic search completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { query, found: results.length, results },
    };
  } catch (error) {
    log.error({ query, error }, 'Semantic search failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Semantic search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// EXPORT SUPPORTED TOOLS
// ============================================

export const SUPPORTED_TOOLS = [
  'search_replace',
  'grep_search',
  'git_status',
  'git_commit',
  'git_diff',
  'git_push',
  'git_pull',
  'git_create_branch',
  'git_merge',
  'git_rebase',
  'apply_multi_file_changes',
  'batch_search_replace',
  'list_directory',
  'create_todo',
  'update_todo',
  'check_todo',
  'list_todos',
  'web_search',
  'codebase_search',
  'find_symbol_references',
  'analyze_codebase',
  'get_dependency_graph',
  'semantic_search',
] as const;

export type SupportedTool = (typeof SUPPORTED_TOOLS)[number];

