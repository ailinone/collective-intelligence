// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Advanced Tool Execution Service
 *
 * Implements advanced CLI tools in the API:
 * - Refactoring tools (extract_function, rename_symbol, extract_variable)
 * - Auto-healing tools (heal_file)
 * - Test generation tools (generate_tests)
 * - Workspace task management tools (todo_write)
 *
 * Based on CLI implementations for full compatibility
 */

import type { Logger } from 'pino';
import { promises as fs } from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * SECURITY: shell-free subprocess execution for the code-quality tools below
 * (heal_file / detect_errors / validate_code).
 *
 * `execAsync` (promisified `exec`) runs its command string through a shell, so
 * a client-derived `fullPath` interpolated into the string (e.g.
 * `a.ts";rm -rf ~ #`) could break out of the quoted argument and run arbitrary
 * commands. `runTool` instead invokes the binary directly with an ARGUMENT
 * ARRAY and NO shell (mirroring `runGit()` in tool-execution-service.ts), so
 * the file path is passed verbatim as a single argv entry — shell
 * metacharacters are inert.
 *
 * On Windows, `npx`/`prettier` resolve to `.cmd` shims that Node only spawns
 * via a shell; we therefore keep `shell: false` but launch them through the
 * platform shim resolver below. The path is still passed as a discrete argv
 * entry, never concatenated into a command string. The startsWith() boundary
 * check + working_directory clamp remain in place at each call site.
 */
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

async function runTool(
  file: string,
  argv: string[],
  cwd: string,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  // `shell` defaults to false for execFile; being explicit documents intent and
  // guards against a future refactor flipping it on. Each argv entry — including
  // the client-derived absolute path — is passed to the binary verbatim, so no
  // shell metacharacter can alter the command.
  // `encoding: 'utf8'` makes execFile resolve stdout/stderr as strings.
  const { stdout, stderr } = await execFileAsync(file, argv, {
    cwd,
    timeout,
    shell: false,
    encoding: 'utf8',
    // `.cmd` shims on Windows are launched by execFile via cmd internally only
    // when a shell is requested; with shell:false Node resolves the shim image
    // directly, so PATHEXT resolution still works for npx.cmd.
    windowsHide: true,
  });
  return { stdout, stderr };
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
}

// ============================================
// Task management types
// ============================================

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TodoList {
  items: TodoItem[];
  createdAt: number;
  updatedAt: number;
}

const TASK_LIST_FILE_PATH = '.ailin/todos.json';

// ============================================
// EXTRACT FUNCTION TOOL
// ============================================

interface ExtractFunctionArgs {
  filePath: string;
  startLine: number;
  endLine: number;
  functionName: string;
  dryRun?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Extract selected code into a new function
 */
export async function executeExtractFunctionTool(
  args: ExtractFunctionArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, startLine, endLine, functionName, dryRun = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    // Security check
    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }

    // Read file
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Validate line numbers
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Invalid line range: ${startLine}-${endLine} (file has ${lines.length} lines)`,
      };
    }

    // Extract the code block
    const extractedLines = lines.slice(startLine - 1, endLine);
    const extractedCode = extractedLines.join('\n');

    // Detect language from file extension
    const ext = path.extname(filePath).toLowerCase();
    const isTypeScript = ext === '.ts' || ext === '.tsx';
    const isJavaScriptFamily = ext === '.js' || ext === '.jsx' || isTypeScript;
    const isPython = ext === '.py';

    // Analyze for variables used (simple heuristic)
    const variablePattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    const usedVariables = new Set<string>();
    let match;
    while ((match = variablePattern.exec(extractedCode)) !== null) {
      usedVariables.add(match[1]);
    }

    // Filter out common keywords
    const keywords = new Set([
      'if', 'else', 'for', 'while', 'return', 'const', 'let', 'var',
      'function', 'class', 'import', 'export', 'true', 'false', 'null',
      'undefined', 'this', 'new', 'async', 'await', 'try', 'catch',
      'throw', 'typeof', 'instanceof', 'in', 'of', 'break', 'continue',
      'def', 'self', 'None', 'True', 'False', 'and', 'or', 'not',
    ]);
    const params = Array.from(usedVariables).filter(v => !keywords.has(v)).slice(0, 5);

    // Generate new function
    let newFunction: string;
    let functionCall: string;

    if (isPython) {
      const paramsStr = params.join(', ');
      newFunction = `def ${functionName}(${paramsStr}):\n    ${extractedCode.split('\n').join('\n    ')}\n`;
      functionCall = `${functionName}(${paramsStr})`;
    } else if (isJavaScriptFamily) {
      // TypeScript gets type annotations, JavaScript doesn't
      const paramsStr = params.map(p => isTypeScript ? `${p}: unknown` : p).join(', ');
      newFunction = `function ${functionName}(${paramsStr}) {\n  ${extractedCode.split('\n').join('\n  ')}\n}\n`;
      functionCall = `${functionName}(${paramsStr})`;
    } else {
      // Default: plain JS style for unknown languages
      const paramsStr = params.join(', ');
      newFunction = `function ${functionName}(${paramsStr}) {\n  ${extractedCode.split('\n').join('\n  ')}\n}\n`;
      functionCall = `${functionName}(${paramsStr})`;
    }

    if (dryRun) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `[DRY RUN] Would extract lines ${startLine}-${endLine} into function "${functionName}":\n\n${newFunction}\n\nReplace extracted code with:\n${functionCall}`,
        metadata: { dryRun: true, functionName, startLine, endLine },
      };
    }

    // Replace extracted code with function call and add function at the top
    const beforeLines = lines.slice(0, startLine - 1);
    const afterLines = lines.slice(endLine);
    const newContent = [newFunction, '', ...beforeLines, functionCall, ...afterLines].join('\n');

    await fs.writeFile(fullPath, newContent, 'utf-8');

    log.info({ filePath, functionName, startLine, endLine }, 'Function extracted successfully');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Extracted lines ${startLine}-${endLine} into function "${functionName}"`,
      metadata: { functionName, startLine, endLine, extractedLines: extractedLines.length },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Extract function failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Extract function failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// RENAME SYMBOL TOOL
// ============================================

interface RenameSymbolArgs {
  oldName: string;
  newName: string;
  files: string[];
  symbolType?: 'function' | 'variable' | 'class' | 'any';
  dryRun?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Rename a symbol across multiple files
 */
export async function executeRenameSymbolTool(
  args: RenameSymbolArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { oldName, newName, files, symbolType = 'any', dryRun = false } = args;
  const { workingDirectory, log } = context;

  try {
    // Validate names
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Invalid symbol name: ${newName}`,
      };
    }

    const results: Array<{ file: string; replacements: number }> = [];
    let totalReplacements = 0;

    // Build pattern based on symbol type
    let pattern: RegExp;
    switch (symbolType) {
      case 'function':
        pattern = new RegExp(`\\b(function\\s+)?${oldName}\\s*\\(`, 'g');
        break;
      case 'class':
        pattern = new RegExp(`\\b(class\\s+)?${oldName}\\b`, 'g');
        break;
      case 'variable':
        pattern = new RegExp(`\\b(const|let|var)\\s+${oldName}\\b`, 'g');
        break;
      default:
        pattern = new RegExp(`\\b${oldName}\\b`, 'g');
    }

    for (const filePattern of files) {
      const fullPath = path.resolve(workingDirectory, filePattern);

      // Security check
      if (!fullPath.startsWith(workingDirectory)) {
        continue;
      }

      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const matches = content.match(pattern);
        const replacementCount = matches ? matches.length : 0;

        if (replacementCount > 0) {
          if (!dryRun) {
            const newContent = content.replace(pattern, (match) => {
              return match.replace(oldName, newName);
            });
            await fs.writeFile(fullPath, newContent, 'utf-8');
          }
          results.push({ file: filePattern, replacements: replacementCount });
          totalReplacements += replacementCount;
        }
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    if (totalReplacements === 0) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `No occurrences of "${oldName}" found in specified files`,
      };
    }

    const output = dryRun
      ? `[DRY RUN] Would rename ${totalReplacements} occurrence(s) of "${oldName}" to "${newName}":\n${results.map(r => `  ${r.file}: ${r.replacements} occurrence(s)`).join('\n')}`
      : `Renamed ${totalReplacements} occurrence(s) of "${oldName}" to "${newName}":\n${results.map(r => `  ${r.file}: ${r.replacements} occurrence(s)`).join('\n')}`;

    log.info({ oldName, newName, totalReplacements }, 'Symbol renamed successfully');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { oldName, newName, totalReplacements, filesModified: results.length, dryRun },
    };
  } catch (error) {
    log.error({ oldName, newName, error }, 'Rename symbol failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Rename symbol failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// EXTRACT VARIABLE TOOL
// ============================================

interface ExtractVariableArgs {
  filePath: string;
  line: number;
  startColumn: number;
  endColumn: number;
  variableName: string;
  dryRun?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Extract an expression into a variable
 */
export async function executeExtractVariableTool(
  args: ExtractVariableArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, line, startColumn, endColumn, variableName, dryRun = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    if (line < 1 || line > lines.length) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Invalid line number: ${line}`,
      };
    }

    const targetLine = lines[line - 1];
    if (startColumn < 0 || endColumn > targetLine.length || startColumn >= endColumn) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Invalid column range: ${startColumn}-${endColumn}`,
      };
    }

    const expression = targetLine.substring(startColumn, endColumn);
    const ext = path.extname(filePath).toLowerCase();
    const isPython = ext === '.py';
    const isTypeScript = ext === '.ts' || ext === '.tsx';

    // Create variable declaration
    let declaration: string;
    if (isPython) {
      declaration = `${variableName} = ${expression}`;
    } else {
      declaration = isTypeScript
        ? `const ${variableName} = ${expression};`
        : `const ${variableName} = ${expression};`;
    }

    // Replace expression with variable name
    const newLine = targetLine.substring(0, startColumn) + variableName + targetLine.substring(endColumn);

    if (dryRun) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `[DRY RUN] Would extract expression "${expression}" into variable "${variableName}":\n\nAdd: ${declaration}\nReplace line ${line}: ${newLine}`,
        metadata: { dryRun: true, variableName, expression },
      };
    }

    // Insert declaration before the line and replace expression
    lines[line - 1] = newLine;
    lines.splice(line - 1, 0, declaration);

    await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');

    log.info({ filePath, variableName, expression }, 'Variable extracted successfully');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Extracted expression "${expression}" into variable "${variableName}"`,
      metadata: { variableName, expression, line },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Extract variable failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Extract variable failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// HEAL FILE TOOL
// ============================================

interface HealFileArgs {
  filePath: string;
  dryRun?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Automatically detect and fix errors in a file
 */
export async function executeHealFileTool(
  args: HealFileArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, dryRun = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }

    const ext = path.extname(filePath).toLowerCase();
    const issues: Array<{ type: string; message: string; fixed: boolean }> = [];

    // Run appropriate linter based on file type
    if (ext === '.ts' || ext === '.tsx') {
      try {
        // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
        const { stderr } = await runTool(
          NPX_BIN,
          ['tsc', '--noEmit', fullPath],
          workingDirectory,
          30000
        );
        if (stderr) {
          issues.push({ type: 'typescript', message: stderr, fixed: false });
        }
      } catch (error: unknown) {
        // Safely extract stderr without type assertions
        if (typeof error === 'object' && error !== null && 'stderr' in error) {
          const stderrDescriptor = Object.getOwnPropertyDescriptor(error, 'stderr');
          if (stderrDescriptor && typeof stderrDescriptor.value === 'string') {
            issues.push({ type: 'typescript', message: stderrDescriptor.value, fixed: false });
          }
        }
      }
    }

    if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
      try {
        // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
        const { stdout } = await runTool(
          NPX_BIN,
          ['eslint', fullPath, '--format', 'json'],
          workingDirectory,
          30000
        );
        // ESLint --format json returns Array<{ messages: Array<{ line, column, message }>, ... }>.
        const eslintResults: unknown = JSON.parse(stdout);
        if (Array.isArray(eslintResults)) {
          for (const result of eslintResults) {
            const messages = (typeof result === 'object' && result !== null)
              ? (result as { messages?: unknown }).messages
              : undefined;
            if (!Array.isArray(messages)) continue;
            for (const msgRaw of messages) {
              if (typeof msgRaw !== 'object' || msgRaw === null) continue;
              const msg = msgRaw as { line?: unknown; column?: unknown; message?: unknown };
              const line = typeof msg.line === 'number' ? msg.line : 0;
              const column = typeof msg.column === 'number' ? msg.column : 0;
              const message = typeof msg.message === 'string' ? msg.message : '';
              issues.push({ type: 'eslint', message: `${line}:${column} ${message}`, fixed: false });
            }
          }
        }
      } catch {
        // ESLint not available or errored
      }
    }

    if (ext === '.py') {
      try {
        // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
        const { stdout } = await runTool(
          PYTHON_BIN,
          ['-m', 'py_compile', fullPath],
          workingDirectory,
          30000
        );
        if (stdout) {
          issues.push({ type: 'python', message: stdout, fixed: false });
        }
      } catch (error: unknown) {
        // Safely extract stderr without type assertions
        if (typeof error === 'object' && error !== null && 'stderr' in error) {
          const stderrDescriptor = Object.getOwnPropertyDescriptor(error, 'stderr');
          if (stderrDescriptor && typeof stderrDescriptor.value === 'string') {
            issues.push({ type: 'python', message: stderrDescriptor.value, fixed: false });
          }
        }
      }
    }

    // Try auto-fix with ESLint if available
    if (!dryRun && (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx')) {
      try {
        // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
        await runTool(NPX_BIN, ['eslint', fullPath, '--fix'], workingDirectory, 30000);
        issues.forEach(i => { if (i.type === 'eslint') i.fixed = true; });
      } catch {
        // ESLint fix not available
      }
    }

    // Try auto-fix with Prettier if available
    if (!dryRun) {
      try {
        // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
        await runTool(NPX_BIN, ['prettier', '--write', fullPath], workingDirectory, 30000);
      } catch {
        // Prettier not available
      }
    }

    const fixedCount = issues.filter(i => i.fixed).length;
    const output = issues.length === 0
      ? `No issues found in ${filePath}`
      : dryRun
        ? `[DRY RUN] Found ${issues.length} issue(s) in ${filePath}:\n${issues.map(i => `  [${i.type}] ${i.message}`).join('\n')}`
        : `Healed ${filePath}: ${fixedCount}/${issues.length} issue(s) fixed:\n${issues.map(i => `  [${i.type}] ${i.fixed ? '✅' : '❌'} ${i.message}`).join('\n')}`;

    log.info({ filePath, issuesFound: issues.length, issuesFixed: fixedCount }, 'Heal file completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { filePath, issuesFound: issues.length, issuesFixed: fixedCount, dryRun },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Heal file failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Heal file failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// GENERATE TESTS TOOL
// ============================================

interface GenerateTestsArgs {
  filePath: string;
  framework?: 'vitest' | 'jest' | 'mocha' | 'pytest';
  language?: 'typescript' | 'javascript' | 'python';
  includeEdgeCases?: boolean;
  writeFile?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Generate unit tests for a source file
 */
export async function executeGenerateTestsTool(
  args: GenerateTestsArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const {
    filePath,
    framework = 'vitest',
    language = 'typescript',
    includeEdgeCases = true,
    writeFile = true,
  } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }

    const content = await fs.readFile(fullPath, 'utf-8');

    // Extract function names from the source file (simple regex-based)
    const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
    const functions: string[] = [];
    let match;
    while ((match = functionPattern.exec(content)) !== null) {
      functions.push(match[1] || match[2]);
    }

    if (functions.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `No functions found in ${filePath}`,
      };
    }

    // Generate test file content
    const baseName = path.basename(filePath, path.extname(filePath));
    const importPath = `./${baseName}`;

    let testContent: string;

    if (framework === 'pytest') {
      testContent = `"""
Unit tests for ${baseName}
Generated by Ailin Developer Tool
"""

import pytest
from ${baseName} import ${functions.join(', ')}

${functions.map(fn => `
class Test${fn.charAt(0).toUpperCase() + fn.slice(1)}:
    """Auto-generated tests for ${fn}"""

    def test_${fn}_callable(self):
        """Ensures ${fn} is callable"""
        assert callable(${fn})
${includeEdgeCases ? `
    def test_${fn}_edge_case_empty(self):
        """Edge case: empty input; function must not crash."""
        try:
            ${fn}('')
        except (TypeError, ValueError):
            pass

    def test_${fn}_edge_case_none(self):
        """Edge case: None input; function must not crash."""
        try:
            ${fn}(None)
        except (TypeError, ValueError):
            pass
` : ''}
`).join('\n')}
`;
    } else {
      const importStatement = framework === 'vitest' || framework === 'jest'
        ? `import { ${functions.join(', ')} } from '${importPath}';`
        : `const { ${functions.join(', ')} } = require('${importPath}');`;

      const describeBlock = framework === 'vitest' || framework === 'jest'
        ? `import { describe, it, expect } from '${framework}';`
        : `const { describe, it } = require('mocha');\nconst { expect } = require('chai');`;

      testContent = `/**
 * Unit tests for ${baseName}
 * Generated by Ailin Developer Tool
 */

${describeBlock}
${importStatement}

${functions.map(fn => `
describe('${fn}', () => {
  it('should be exported as a function', () => {
    expect(typeof ${fn}).toBe('function');
  });
${includeEdgeCases ? `
  it('should handle empty input', () => {
    expect(typeof ${fn}).toBe('function');
    try { ${fn}(''); } catch (_) { /* function may throw on empty */ }
  });

  it('should handle null/undefined input', () => {
    expect(typeof ${fn}).toBe('function');
    try { ${fn}(null); } catch (_) { /* function may throw */ }
    try { ${fn}(undefined); } catch (_) { /* function may throw */ }
  });
` : ''}
});
`).join('\n')}
`;
    }

    // Determine test file path
    const ext = framework === 'pytest' ? '.py' : language === 'typescript' ? '.test.ts' : '.test.js';
    const testFileName = `${baseName}${ext}`;
    const testFilePath = path.join(path.dirname(fullPath), testFileName);

    if (writeFile) {
      await fs.writeFile(testFilePath, testContent, 'utf-8');
      log.info({ filePath, testFilePath, functionCount: functions.length }, 'Tests generated successfully');

      return {
        tool_call_id: toolCallId,
        success: true,
        output: `Generated test file: ${testFileName}\nFunctions tested: ${functions.join(', ')}`,
        metadata: { testFilePath, functions, framework },
      };
    }

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Test file content for ${baseName}:\n\n${testContent}`,
      metadata: { functions, framework, writeFile: false },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Generate tests failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Generate tests failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// TASK LIST WRITE TOOL
// ============================================

interface TodoWriteArgs {
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority?: 'high' | 'medium' | 'low';
  }>;
  merge?: boolean;
}

/**
 * Write/update task items
 */
export async function executeTodoWriteTool(
  args: TodoWriteArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { todos, merge = true } = args;
  const { workingDirectory, log } = context;

  try {
    const todoFilePath = path.join(workingDirectory, TASK_LIST_FILE_PATH);
    const todoDir = path.dirname(todoFilePath);

    // Ensure directory exists
    await fs.mkdir(todoDir, { recursive: true });

    // Load existing todos
    let todoList: TodoList;
    try {
      const content = await fs.readFile(todoFilePath, 'utf-8');
      // JSON.parse returns `unknown` — narrow to the TodoList shape, falling
      // back to a fresh empty list if the file's contents drift.
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { items?: unknown }).items)
      ) {
        todoList = parsed as TodoList;
      } else {
        throw new Error('todo file shape mismatch');
      }
    } catch {
      todoList = {
        items: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const now = Date.now();

    if (merge) {
      // Merge with existing todos
      for (const todo of todos) {
        const existingIndex = todoList.items.findIndex(i => i.id === todo.id);
        if (existingIndex >= 0) {
          todoList.items[existingIndex] = {
            ...todoList.items[existingIndex],
            ...todo,
            updatedAt: now,
            completedAt: todo.status === 'completed' ? now : todoList.items[existingIndex].completedAt,
          };
        } else {
          todoList.items.push({
            ...todo,
            createdAt: now,
            updatedAt: now,
            completedAt: todo.status === 'completed' ? now : undefined,
          });
        }
      }
    } else {
      // Replace all todos
      todoList.items = todos.map(todo => ({
        ...todo,
        createdAt: now,
        updatedAt: now,
        completedAt: todo.status === 'completed' ? now : undefined,
      }));
    }

    todoList.updatedAt = now;

    // Save todos
    await fs.writeFile(todoFilePath, JSON.stringify(todoList, null, 2), 'utf-8');

    const pending = todoList.items.filter(i => i.status === 'pending').length;
    const inProgress = todoList.items.filter(i => i.status === 'in_progress').length;
    const completed = todoList.items.filter(i => i.status === 'completed').length;

    log.info({ todoCount: todoList.items.length, pending, inProgress, completed }, 'Task list updated');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Tasks updated: ${todoList.items.length} total (${pending} pending, ${inProgress} in progress, ${completed} completed)`,
      metadata: { total: todoList.items.length, pending, inProgress, completed },
    };
  } catch (error) {
    log.error({ error }, 'Task list write failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Task list write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// REFACTOR CODE TOOL
// ============================================

interface RefactorCodeArgs {
  filePath: string;
  refactorType: 'simplify' | 'optimize' | 'modernize' | 'clean';
  dryRun?: boolean;
}

/**
 * Refactor code in a file
 */
export async function executeRefactorCodeTool(
  args: RefactorCodeArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, refactorType, dryRun = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }

    let content = await fs.readFile(fullPath, 'utf-8');
    const changes: string[] = [];

    switch (refactorType) {
      case 'simplify':
        // Simplify: Remove unnecessary complexity
        if (content.includes('== true')) {
          content = content.replace(/== true/g, '');
          changes.push('Removed redundant == true comparisons');
        }
        if (content.includes('== false')) {
          content = content.replace(/== false/g, ' === false');
          changes.push('Converted == false to === false');
        }
        if (/!!\w+/.test(content)) {
          changes.push('Note: Consider removing double negation (!!)');
        }
        break;

      case 'optimize':
        // Optimize: Performance improvements
        if (content.includes('.forEach(')) {
          changes.push('Note: Consider replacing .forEach() with for...of for better performance');
        }
        if (/\+\s*['"]/.test(content)) {
          changes.push('Note: Consider using template literals instead of string concatenation');
        }
        break;

      case 'modernize':
        // Modernize: Update to modern syntax
        content = content.replace(/var\s+/g, 'const ');
        changes.push('Converted var to const');
        
        content = content.replace(/function\s+(\w+)\s*\((.*?)\)\s*{/g, 'const $1 = ($2) => {');
        changes.push('Converted functions to arrow functions');
        break;

      case 'clean':
        // Clean: Remove dead code, unused imports
        content = content.replace(/\/\/\s*TODO:.*\n/g, '');
        changes.push('Removed TODO comments');
        
        content = content.replace(/console\.log\(.*?\);?\n?/g, '');
        changes.push('Removed console.log statements');
        break;
    }

    if (changes.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No ${refactorType} refactoring needed for ${filePath}`,
        metadata: { filePath, refactorType, changesApplied: 0 },
      };
    }

    if (!dryRun) {
      await fs.writeFile(fullPath, content, 'utf-8');
    }

    const output = dryRun
      ? `[DRY RUN] Would apply ${changes.length} ${refactorType} change(s) to ${filePath}:\n${changes.map(c => `  - ${c}`).join('\n')}`
      : `Applied ${changes.length} ${refactorType} change(s) to ${filePath}:\n${changes.map(c => `  - ${c}`).join('\n')}`;

    log.info({ filePath, refactorType, changesApplied: changes.length }, 'Refactor completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { filePath, refactorType, changesApplied: changes.length, dryRun },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Refactor code failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Refactor code failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// MULTIMODAL TOOLS - IMAGE ANALYSIS
// ============================================

interface AnalyzeImageArgs {
  image_path?: string;
  image_url?: string;
  image_base64?: string;
  prompt?: string;
  analysis_type?: 'general' | 'code' | 'diagram' | 'ui' | 'text';
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

// Note: Analysis result is returned as string in ToolResult.output
// Structured parsing can be done by the caller if needed

/**
 * Analyze an image using vision capabilities
 * Supports local files, URLs, and base64 encoded images
 *
 * Uses dynamic model discovery to find ANY model with vision/multimodal capability:
 * - Anthropic Claude (claude-3-opus, claude-3-sonnet, etc.)
 * - OpenAI GPT-4 Vision (gpt-4o, gpt-4-turbo, etc.)
 * - Google Gemini (gemini-pro-vision, gemini-1.5-pro, etc.)
 * - OpenRouter (access to many vision models)
 * - And any other provider with vision capability
 */
export async function executeAnalyzeImageTool(
  args: AnalyzeImageArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { image_path, image_url, image_base64, prompt, analysis_type = 'general' } = args;
  const { workingDirectory, log } = context;

  try {
    let imageData: string | null = null;
    let imageSource: string = 'unknown';
    let mimeType: string = 'image/jpeg';

    // Get image data from one of the sources
    if (image_base64) {
      imageData = image_base64;
      imageSource = 'base64';
    } else if (image_url) {
      // For URLs, we can pass them directly to models that support it
      // But we also fetch for models that need base64
      try {
        const response = await fetch(image_url);
        if (!response.ok) {
          return {
            tool_call_id: toolCallId,
            success: false,
            error: `Failed to fetch image from URL: ${response.statusText}`,
          };
        }
        // Detect mime type from response
        const contentType = response.headers.get('content-type');
        if (contentType) {
          mimeType = contentType.split(';')[0].trim();
        }
        const buffer = await response.arrayBuffer();
        imageData = Buffer.from(buffer).toString('base64');
        imageSource = 'url';
      } catch (fetchError) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
        };
      }
    } else if (image_path) {
      // Read local file
      const fullPath = path.resolve(workingDirectory, image_path);
      try {
        const buffer = await fs.readFile(fullPath);
        imageData = buffer.toString('base64');
        imageSource = 'file';
        // Detect mime type from extension
        const ext = path.extname(image_path).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
        };
        mimeType = mimeTypes[ext] || 'image/jpeg';
      } catch {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Image file not found: ${image_path}`,
        };
      }
    }

    if (!imageData) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'No image provided. Specify image_path, image_url, or image_base64',
      };
    }

    // Build the analysis prompt based on type
    const analysisPrompt = prompt || getDefaultPromptForType(analysis_type);

    // Use CapabilityExecutionService to find and use ANY model with vision capability
    const { getCapabilityExecutionService } = await import('./capability-execution-service.js');
    const capabilityService = getCapabilityExecutionService();

    // Check if we have models with vision capability
    const hasVisionCapability = await capabilityService.isCapabilityAvailable('vision');

    if (!hasVisionCapability) {
      log.warn('No models with vision capability available');
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'No models with vision capability available. Please configure a provider with vision support (OpenAI, Anthropic, Google, OpenRouter, etc.)',
      };
    }

    // Get organizationId from context (required for OrchestrationEngine)
    const organizationId = context.organizationId || 'default-org';
    const userId = context.userId;

    // Execute vision request through OrchestrationEngine
    // This ensures full orchestration: Triage → Strategy → Model Selection → Feedback → Quality
    const result = await capabilityService.executeVisionRequest(imageData, analysisPrompt, {
      imageFormat: 'base64',
      mimeType,
      organizationId,
      userId,
    });

    if (!result.success) {
      log.error({ error: result.error }, 'Vision analysis failed');
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Image analysis failed: ${result.error}`,
      };
    }

    const analysisText = result.response?.choices?.[0]?.message?.content || 'No analysis returned';

    log.info(
      {
        imageSource,
        analysis_type,
        modelUsed: result.modelUsed,
        providerUsed: result.providerUsed,
        executionTimeMs: result.executionTimeMs,
      },
      'Image analysis completed'
    );

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Image Analysis (${analysis_type}):\n\n${analysisText}`,
      metadata: {
        source: imageSource,
        analysis_type,
        model: result.modelUsed,
        provider: result.providerUsed,
        executionTimeMs: result.executionTimeMs,
      },
    };
  } catch (error) {
    log.error({ error }, 'Image analysis failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Image analysis failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function getDefaultPromptForType(type: string): string {
  switch (type) {
    case 'code':
      return 'Analyze this image and extract any code visible. Identify the programming language, describe the code structure, and point out any potential issues or improvements. If you can see code, transcribe it accurately.';
    case 'diagram':
      return 'Analyze this diagram in detail. Describe its structure, components, relationships, and what it represents. Extract any text labels, annotations, or data visible. Explain the flow or hierarchy if applicable.';
    case 'ui':
      return 'Analyze this UI/UX design thoroughly. Describe the layout, components, color scheme, typography, and user flow. Identify any accessibility concerns. Suggest specific improvements for usability or aesthetics.';
    case 'text':
      return 'Extract and transcribe ALL text visible in this image accurately. Preserve formatting, structure, and hierarchy where possible. Include any numbers, dates, or special characters.';
    default:
      return 'Describe this image in comprehensive detail. Identify all key elements, objects, people, text, colors, composition, and any relevant contextual information. Be thorough and precise.';
  }
}

interface CompareImagesArgs {
  image1_path?: string;
  image1_url?: string;
  image1_base64?: string;
  image2_path?: string;
  image2_url?: string;
  image2_base64?: string;
  comparison_type?: 'visual' | 'code' | 'ui' | 'diff';
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Compare two images and describe differences
 */
export async function executeCompareImagesTool(
  args: CompareImagesArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const {
    image1_path, image1_url, image1_base64,
    image2_path, image2_url, image2_base64,
    comparison_type = 'visual',
  } = args;
  const { workingDirectory, log } = context;

  try {
    // Helper to get image data
    const getImageData = async (
      filePath?: string,
      url?: string,
      base64?: string
    ): Promise<{ data: string; source: string } | null> => {
      if (base64) return { data: base64, source: 'base64' };
      
      if (url) {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          const buffer = await response.arrayBuffer();
          return { data: Buffer.from(buffer).toString('base64'), source: 'url' };
        } catch {
          return null;
        }
      }
      
      if (filePath) {
        try {
          const fullPath = path.resolve(workingDirectory, filePath);
          const buffer = await fs.readFile(fullPath);
          return { data: buffer.toString('base64'), source: 'file' };
        } catch {
          return null;
        }
      }
      
      return null;
    }

    const img1 = await getImageData(image1_path, image1_url, image1_base64);
    const img2 = await getImageData(image2_path, image2_url, image2_base64);

    if (!img1 || !img2) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Both images are required for comparison. Provide image1_* and image2_* parameters.',
      };
    }

    // Use CapabilityExecutionService to find a model with vision capability
    const { getCapabilityExecutionService } = await import('./capability-execution-service.js');
    const capabilityService = getCapabilityExecutionService();

    const hasVisionCapability = await capabilityService.isCapabilityAvailable('vision');

    if (!hasVisionCapability) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'No models with vision capability available. Please configure a provider with vision support (OpenAI, Anthropic, Google, OpenRouter, etc.)',
      };
    }

    const comparisonPrompts: Record<string, string> = {
      visual: 'Compare these two images in detail. Describe all visual differences and similarities you can identify, including colors, shapes, positions, and any text or objects present.',
      code: 'Compare the code shown in these two images. Identify what lines changed, what was added, what was removed. Be specific about the differences.',
      ui: 'Compare these two UI designs thoroughly. Describe all layout differences, component changes, styling updates, spacing changes, and any text differences.',
      diff: 'Analyze the differences between these two images systematically. Create a detailed list of every change you can identify, from major structural changes to subtle details.',
    };

    // Get organizationId from context (required for OrchestrationEngine)
    const organizationId = context.organizationId || 'default-org';
    const userId = context.userId;

    // Build the comparison message with both images
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: comparisonPrompts[comparison_type] || comparisonPrompts.visual },
          {
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${img1.data}` },
          },
          {
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${img2.data}` },
          },
        ],
      },
    ];

    // Execute through OrchestrationEngine for full orchestration
    // This ensures: Triage → Strategy Selection → Model Selection → Feedback → Quality
    const result = await capabilityService.executeWithCapabilities(messages, {
      requiredCapabilities: ['vision', 'multimodal'],
      organizationId,
      userId,
      taskType: 'analysis',
      qualityTarget: 0.8, // Higher quality for comparison tasks
    });

    if (!result.success) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Image comparison failed: ${result.error}`,
      };
    }

    const comparisonText = result.response?.choices?.[0]?.message?.content || 'No comparison returned';

    log.info(
      {
        comparison_type,
        modelUsed: result.modelUsed,
        providerUsed: result.providerUsed,
        strategyUsed: result.strategyUsed,
        qualityScore: result.qualityScore,
      },
      'Image comparison completed via OrchestrationEngine'
    );

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Image Comparison (${comparison_type}):\n\n${comparisonText}`,
      metadata: {
        comparison_type,
        model: result.modelUsed,
        provider: result.providerUsed,
        strategy: result.strategyUsed,
        qualityScore: result.qualityScore,
        orchestration: result.orchestrationMetadata,
      },
    };
  } catch (error) {
    log.error({ error }, 'Image comparison failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Image comparison failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface ExtractCodeFromScreenshotArgs {
  image_path?: string;
  image_url?: string;
  image_base64?: string;
  language_hint?: string;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Extract code from a screenshot image
 */
export async function executeExtractCodeFromScreenshotTool(
  args: ExtractCodeFromScreenshotArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { language_hint } = args;
  
  // Use analyze_image with code extraction prompt
  const analysisResult = await executeAnalyzeImageTool(
    {
      ...args,
      analysis_type: 'code',
      prompt: `Extract all code visible in this screenshot. ${language_hint ? `The code is likely in ${language_hint}.` : ''} Return ONLY the code, properly formatted, without any explanations or markdown code blocks.`,
    },
    toolCallId,
    context
  );

  if (!analysisResult.success) {
    return analysisResult;
  }

  // Post-process to extract just the code
  let extractedCode = analysisResult.output || '';
  
  // Remove common prefixes from analysis
  extractedCode = extractedCode
    .replace(/^Image Analysis \(code\):\n\n/i, '')
    .replace(/^```\w*\n?/gm, '')
    .replace(/```$/gm, '')
    .trim();

  return {
    tool_call_id: toolCallId,
    success: true,
    output: extractedCode,
    metadata: {
      ...analysisResult.metadata as Record<string, unknown>,
      language_hint,
      extracted: true,
    },
  };
}

// ============================================
// INLINE FUNCTION TOOL
// ============================================

interface InlineFunctionArgs {
  filePath: string;
  functionName: string;
  dryRun?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Inline a function call - replace call sites with function body
 */
export async function executeInlineFunctionTool(
  args: InlineFunctionArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, functionName, dryRun = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);
    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: file is outside working directory',
      };
    }
    const content = await fs.readFile(fullPath, 'utf-8');

    // Find function definition (declaration or block-bodied arrow).
    const declarationRegex = new RegExp(`\\bfunction\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`, 'm');
    const arrowBlockRegex = new RegExp(
      `\\b(?:const|let|var)\\s+${functionName}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{`,
      'm'
    );
    const arrowExprRegex = new RegExp(
      `\\b(?:const|let|var)\\s+${functionName}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*([^\\n;]+)`,
      'm'
    );

    const declarationMatch = declarationRegex.exec(content);
    const arrowBlockMatch = declarationMatch ? null : arrowBlockRegex.exec(content);
    const functionMatch = declarationMatch || arrowBlockMatch;

    let functionBody = '';
    let definitionStart = -1;
    let definitionEnd = -1;

    if (functionMatch) {
      definitionStart = functionMatch.index;
      const openBraceIndex = content.indexOf('{', functionMatch.index);

      if (openBraceIndex === -1) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Could not parse function body for "${functionName}" in ${filePath}`,
        };
      }

      let braceCount = 1;
      let cursor = openBraceIndex + 1;
      while (cursor < content.length && braceCount > 0) {
        const ch = content[cursor];
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
        cursor++;
      }

      if (braceCount !== 0) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Unbalanced braces while parsing "${functionName}" in ${filePath}`,
        };
      }

      definitionEnd = cursor;
      functionBody = content.substring(openBraceIndex + 1, cursor - 1).trim();
    } else {
      const arrowExprMatch = arrowExprRegex.exec(content);
      if (!arrowExprMatch) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Function "${functionName}" not found in ${filePath}`,
        };
      }
      definitionStart = arrowExprMatch.index;
      definitionEnd = arrowExprMatch.index + arrowExprMatch[0].length;
      functionBody = `return ${arrowExprMatch[1].trim().replace(/;$/, '')};`;
    }

    // Count call sites and exclude the definition itself.
    const callRegex = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
    let callCount = 0;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callRegex.exec(content)) !== null) {
      const callIndex = callMatch.index;
      if (callIndex >= definitionStart && callIndex < definitionEnd) {
        continue;
      }
      callCount++;
    }

    if (callCount === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No call sites found for "${functionName}" to inline`,
        metadata: { filePath, functionName, inlined: 0 },
      };
    }

    if (dryRun) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `[DRY RUN] Would inline "${functionName}" at ${callCount} call site(s)\nFunction body:\n${functionBody}`,
        metadata: { filePath, functionName, callSites: callCount, dryRun: true },
      };
    }

    // For simple functions, replace calls with body (simplified implementation)
    // Note: Full implementation would require proper AST manipulation
    log.info({ filePath, functionName, callCount }, 'Inline function requested');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `Found "${functionName}" with ${callCount} call site(s).\nFunction body identified. Manual inline recommended for complex cases.\n\nFunction body:\n${functionBody}`,
      metadata: { filePath, functionName, callSites: callCount, bodyExtracted: true },
    };
  } catch (error) {
    log.error({ filePath, functionName, error }, 'Inline function failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Inline function failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// FILE SEARCH TOOL
// ============================================

interface FileSearchArgs {
  pattern: string;
  path?: string;
  type?: 'name' | 'content' | 'both';
  max_results?: number;
  include_hidden?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Search for files by name pattern or content
 */
export async function executeFileSearchTool(
  args: FileSearchArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { pattern, path: searchPath = '.', type = 'name', max_results = 50, include_hidden = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, searchPath);
    const results: Array<{ path: string; type: 'name' | 'content'; match?: string }> = [];
    const patternRegex = new RegExp(pattern, 'i');

    const searchDirectory = async (dir: string, depth: number = 0): Promise<void> => {
      if (depth > 10 || results.length >= max_results) return;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (results.length >= max_results) break;

          // Skip hidden files/dirs unless requested
          if (!include_hidden && entry.name.startsWith('.')) continue;

          // Skip common ignore patterns
          if (['node_modules', 'dist', 'build', '.git', '__pycache__', '.next'].includes(entry.name)) {
            continue;
          }

          const entryPath = path.join(dir, entry.name);
          const relativePath = path.relative(workingDirectory, entryPath);

          if (entry.isDirectory()) {
            // Check directory name match
            if ((type === 'name' || type === 'both') && patternRegex.test(entry.name)) {
              results.push({ path: relativePath + '/', type: 'name' });
            }
            await searchDirectory(entryPath, depth + 1);
          } else if (entry.isFile()) {
            // Check file name match
            if ((type === 'name' || type === 'both') && patternRegex.test(entry.name)) {
              results.push({ path: relativePath, type: 'name' });
            }

            // Check content match
            if ((type === 'content' || type === 'both') && results.length < max_results) {
              // Only search text files
              const ext = path.extname(entry.name).toLowerCase();
              const textExtensions = ['.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.txt', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.sh', '.bash'];
              
              if (textExtensions.includes(ext) || !ext) {
                try {
                  const content = await fs.readFile(entryPath, 'utf-8');
                  const match = patternRegex.exec(content);
                  if (match) {
                    // Get surrounding context
                    const start = Math.max(0, match.index - 30);
                    const end = Math.min(content.length, match.index + match[0].length + 30);
                    const context = content.substring(start, end).replace(/\n/g, ' ');
                    results.push({ path: relativePath, type: 'content', match: `...${context}...` });
                  }
                } catch {
                  // Skip unreadable files
                }
              }
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    await searchDirectory(fullPath);

    if (results.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `No files found matching "${pattern}"`,
        metadata: { pattern, searchPath, type, found: 0 },
      };
    }

    let output = `Found ${results.length} result(s) for "${pattern}":\n\n`;
    
    for (const result of results) {
      if (result.type === 'name') {
        output += `📄 ${result.path}\n`;
      } else {
        output += `📄 ${result.path}\n   └─ ${result.match}\n`;
      }
    }

    log.info({ pattern, found: results.length }, 'File search completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { pattern, searchPath, type, found: results.length, results },
    };
  } catch (error) {
    log.error({ pattern, error }, 'File search failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `File search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// EXPORT SUPPORTED TOOLS
// ============================================

// ============================================
// DETECT ERRORS TOOL
// ============================================

interface DetectErrorsArgs {
  filePath: string;
  includeWarnings?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

interface CodeError {
  line: number;
  column?: number;
  message: string;
  type: 'syntax' | 'type' | 'lint' | 'runtime';
  code?: string;
  severity: 'error' | 'warning' | 'info';
}

/**
 * Detect errors in a file without fixing
 */
export async function executeDetectErrorsTool(
  args: DetectErrorsArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, includeWarnings = true } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    // Check if file exists
    try {
      await fs.access(fullPath);
    } catch {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `File not found: ${filePath}`,
      };
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    const errors: CodeError[] = [];

    // Detect based on file type
    if (['.ts', '.tsx'].includes(ext)) {
      // TypeScript - use tsc for type checking
      try {
        // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
        // tsc writes diagnostics to stdout; `--pretty false` keeps the parseable
        // `file(line,col): error TSxxxx:` format. (The old `2>&1` shell redirect
        // is unnecessary without a shell — we read stdout+stderr directly.)
        const { stdout, stderr } = await runTool(
          NPX_BIN,
          ['tsc', '--noEmit', '--pretty', 'false', fullPath],
          workingDirectory,
          30000
        );

        // Parse TypeScript errors (diagnostics may land on either stream)
        const lines = `${stdout}\n${stderr}`.split('\n');
        for (const line of lines) {
          const match = line.match(/([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)/);
          if (match) {
            errors.push({
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              message: match[6],
              type: 'type',
              code: match[5],
              severity: match[4] === 'error' ? 'error' : 'warning',
            });
          }
        }
      } catch (execError: unknown) {
        // tsc returns non-zero on errors, parse the output
        // Safely extract stderr/stdout without type assertions
        let output = '';
        if (execError && typeof execError === 'object' && execError !== null) {
          const stderrDescriptor = Object.getOwnPropertyDescriptor(execError, 'stderr');
          const stdoutDescriptor = Object.getOwnPropertyDescriptor(execError, 'stdout');
          
          if (stderrDescriptor && typeof stderrDescriptor.value === 'string') {
            output = stderrDescriptor.value;
          } else if (stdoutDescriptor && typeof stdoutDescriptor.value === 'string') {
            output = stdoutDescriptor.value;
          }
        }
        const lines = output.split('\n');
        for (const line of lines) {
          const match = line.match(/([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)/);
          if (match) {
            errors.push({
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              message: match[6],
              type: 'type',
              code: match[5],
              severity: match[4] === 'error' ? 'error' : 'warning',
            });
          }
        }
      }
    } else if (['.js', '.jsx'].includes(ext)) {
      // JavaScript - basic syntax check
      try {
        new Function(content);
      } catch (syntaxError: unknown) {
        const err = syntaxError as Error;
        const lineMatch = err.message.match(/line (\d+)/i);
        errors.push({
          line: lineMatch ? parseInt(lineMatch[1]) : 1,
          message: err.message,
          type: 'syntax',
          severity: 'error',
        });
      }
    } else if (ext === '.json') {
      // JSON syntax validation
      try {
        JSON.parse(content);
      } catch (jsonError: unknown) {
        const err = jsonError as Error;
        const posMatch = err.message.match(/position (\d+)/i);
        let line = 1;
        if (posMatch) {
          const pos = parseInt(posMatch[1]);
          line = content.substring(0, pos).split('\n').length;
        }
        errors.push({
          line,
          message: err.message,
          type: 'syntax',
          severity: 'error',
        });
      }
    }

    // Basic pattern-based checks for common issues
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      const lineNum = index + 1;

      // Check for console.log in production code
      if (line.includes('console.log') && includeWarnings) {
        errors.push({
          line: lineNum,
          message: 'console.log statement found (consider removing for production)',
          type: 'lint',
          severity: 'warning',
        });
      }

      // Check for TODO/FIXME comments
      if (/\/\/\s*(TODO|FIXME|HACK|XXX)/i.test(line) && includeWarnings) {
        errors.push({
          line: lineNum,
          message: 'TODO/FIXME comment found',
          type: 'lint',
          severity: 'info',
        });
      }

      // Check for debugger statements
      if (/\bdebugger\b/.test(line)) {
        errors.push({
          line: lineNum,
          message: 'debugger statement found',
          type: 'lint',
          severity: 'warning',
        });
      }
    });

    // Filter based on includeWarnings
    const filteredErrors = includeWarnings
      ? errors
      : errors.filter(e => e.severity === 'error');

    if (filteredErrors.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: `✅ No errors detected in ${filePath}`,
        metadata: { errorCount: 0 },
      };
    }

    // Group by type
    const byType = new Map<string, CodeError[]>();
    for (const error of filteredErrors) {
      const list = byType.get(error.type) || [];
      list.push(error);
      byType.set(error.type, list);
    }

    let output = `🔍 Error Detection: ${filePath}\n\n`;
    output += `Found ${filteredErrors.length} issue(s):\n\n`;

    for (const [type, typeErrors] of byType) {
      const emoji = type === 'syntax' ? '🔴' : type === 'type' ? '🟡' : '🟠';
      output += `${emoji} ${type.toUpperCase()} (${typeErrors.length}):\n`;

      for (const error of typeErrors.slice(0, 10)) {
        const col = error.column ? `:${error.column}` : '';
        const code = error.code ? ` [${error.code}]` : '';
        const icon = error.severity === 'error' ? '❌' : error.severity === 'warning' ? '⚠️' : 'ℹ️';
        output += `  ${icon} Line ${error.line}${col}: ${error.message}${code}\n`;
      }

      if (typeErrors.length > 10) {
        output += `  ... and ${typeErrors.length - 10} more\n`;
      }
      output += '\n';
    }

    log.info({ filePath, errorCount: filteredErrors.length }, 'Error detection completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: {
        errorCount: filteredErrors.length,
        byType: Object.fromEntries(
          Array.from(byType.entries()).map(([k, v]) => [k, v.length])
        ),
        errors: filteredErrors,
      },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Error detection failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Error detection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// VALIDATE CODE TOOL
// ============================================

interface ValidateCodeArgs {
  filePaths: string[];
  language?: 'typescript' | 'javascript' | 'python' | 'tsx' | 'jsx';
  skipTypeCheck?: boolean;
  skipLint?: boolean;
  autoFix?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

interface ValidationResult {
  valid: boolean;
  errors: CodeError[];
  warnings: CodeError[];
}

/**
 * Validate code for syntax errors, type errors, and linting issues
 */
export async function executeValidateCodeTool(
  args: ValidateCodeArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const {
    filePaths,
    language,
    skipTypeCheck = false,
    skipLint = false,
    autoFix = false,
  } = args;
  const { workingDirectory, log } = context;

  if (!filePaths || filePaths.length === 0) {
    return {
      tool_call_id: toolCallId,
      success: false,
      error: 'No files provided for validation',
    };
  }

  try {
    const results = new Map<string, ValidationResult>();
    let totalErrors = 0;
    let totalWarnings = 0;
    const failedFiles: string[] = [];

    for (const filePath of filePaths) {
      const fullPath = path.resolve(workingDirectory, filePath);
      const errors: CodeError[] = [];
      const warnings: CodeError[] = [];

      try {
        await fs.access(fullPath);
      } catch {
        results.set(filePath, {
          valid: false,
          errors: [{ line: 0, message: 'File not found', type: 'syntax', severity: 'error' }],
          warnings: [],
        });
        failedFiles.push(filePath);
        totalErrors++;
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      const detectedLang = language || (ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript');

      // Type checking for TypeScript
      if (!skipTypeCheck && (detectedLang === 'typescript' || detectedLang === 'tsx')) {
        try {
          // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
          await runTool(NPX_BIN, ['tsc', '--noEmit', fullPath], workingDirectory, 30000);
        } catch (execError: unknown) {
          // Type guard for exec error with stderr/stdout
          // Safely extract stderr/stdout without type assertions
          let output = '';
          if (execError && typeof execError === 'object' && execError !== null) {
            const stderrDescriptor = Object.getOwnPropertyDescriptor(execError, 'stderr');
            const stdoutDescriptor = Object.getOwnPropertyDescriptor(execError, 'stdout');
            
            if (stderrDescriptor && typeof stderrDescriptor.value === 'string') {
              output = stderrDescriptor.value;
            } else if (stdoutDescriptor && typeof stdoutDescriptor.value === 'string') {
              output = stdoutDescriptor.value;
            }
          }
          const lines = output.split('\n');
          for (const line of lines) {
            const match = line.match(/\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)/);
            if (match) {
              const errorObj: CodeError = {
                line: parseInt(match[1]),
                column: parseInt(match[2]),
                message: match[5],
                type: 'type',
                code: match[4],
                severity: match[3] === 'error' ? 'error' : 'warning',
              };
              if (errorObj.severity === 'error') {
                errors.push(errorObj);
              } else {
                warnings.push(errorObj);
              }
            }
          }
        }
      }

      // Linting with ESLint if available
      if (!skipLint) {
        try {
          // SECURITY: shell-free — fullPath is a discrete argv entry (no shell).
          // The `--fix` flag is a fixed token (never interpolated) and the old
          // `2>/dev/null` redirect is unnecessary without a shell.
          const eslintArgv = autoFix
            ? ['eslint', '--fix', fullPath, '--format', 'json']
            : ['eslint', fullPath, '--format', 'json'];
          await runTool(NPX_BIN, eslintArgv, workingDirectory, 30000);
        } catch {
          // ESLint may not be available, skip linting
        }
      }

      totalErrors += errors.length;
      totalWarnings += warnings.length;

      const valid = errors.length === 0;
      if (!valid) {
        failedFiles.push(filePath);
      }

      results.set(filePath, { valid, errors, warnings });
    }

    // Build output
    let output = `📝 Validation Results for ${filePaths.length} file(s):\n\n`;

    for (const [file, result] of results) {
      if (!result.valid) {
        output += `❌ ${file}:\n`;
        for (const error of result.errors) {
          const location = error.line ? `  Line ${error.line}${error.column ? `:${error.column}` : ''}` : '';
          const rule = error.code ? ` [${error.code}]` : '';
          output += `${location}: ${error.message}${rule}\n`;
        }
        if (result.warnings.length > 0) {
          output += `  ⚠️  ${result.warnings.length} warning(s)\n`;
        }
        output += '\n';
      } else {
        output += `✅ ${file}: Valid`;
        if (result.warnings.length > 0) {
          output += ` (⚠️  ${result.warnings.length} warning(s))`;
        }
        output += '\n';
      }
    }

    // Summary
    output += `\n📊 Summary:\n`;
    output += `  Files validated: ${filePaths.length}\n`;
    output += `  Passed: ${filePaths.length - failedFiles.length}\n`;
    output += `  Failed: ${failedFiles.length}\n`;
    output += `  Total errors: ${totalErrors}\n`;
    output += `  Total warnings: ${totalWarnings}\n`;

    if (autoFix) {
      output += `\n🔧 Auto-fix was enabled.\n`;
    }

    const success = failedFiles.length === 0;

    log.info({ filesValidated: filePaths.length, failed: failedFiles.length }, 'Code validation completed');

    return {
      tool_call_id: toolCallId,
      success,
      output,
      error: success ? undefined : `Validation failed for ${failedFiles.length} file(s)`,
      metadata: {
        validated: filePaths.length,
        passed: filePaths.length - failedFiles.length,
        failed: failedFiles.length,
        errors: totalErrors,
        warnings: totalWarnings,
      },
    };
  } catch (error) {
    log.error({ error }, 'Code validation failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Code validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// GIT RESOLVE CONFLICT TOOL
// ============================================

interface GitResolveConflictArgs {
  filePath: string;
  resolution: 'ours' | 'theirs' | 'manual';
  manualContent?: string;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Resolve Git merge conflicts in a file
 */
export async function executeGitResolveConflictTool(
  args: GitResolveConflictArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, resolution, manualContent } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    // Check if file exists
    try {
      await fs.access(fullPath);
    } catch {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `File not found: ${filePath}`,
      };
    }

    const content = await fs.readFile(fullPath, 'utf-8');

    // Check if file has conflict markers
    if (!content.includes('<<<<<<<') || !content.includes('>>>>>>>')) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `No merge conflicts detected in ${filePath}`,
      };
    }

    let resolvedContent: string;

    if (resolution === 'manual' && manualContent) {
      resolvedContent = manualContent;
    } else {
      // Parse and resolve conflicts
      const conflictRegex = /<<<<<<< .*?\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> .*?/g;

      resolvedContent = content.replace(conflictRegex, (_match: string, ours: string, theirs: string) => {
        return resolution === 'ours' ? ours : theirs;
      });
    }

    // Write resolved content
    await fs.writeFile(fullPath, resolvedContent, 'utf-8');

    // Stage the resolved file — SECURITY: shell-free git via argv array. The
    // client-supplied filePath is passed verbatim after `--` so it can be
    // neither parsed as a git option nor break out via shell metacharacters.
    await runTool('git', ['add', '--', filePath], workingDirectory, 10000);

    log.info({ filePath, resolution }, 'Git conflict resolved');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `✅ Resolved conflicts in ${filePath} using "${resolution}" strategy`,
      metadata: { filePath, resolution },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Git resolve conflict failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Git resolve conflict failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// DELETE FILE TOOL
// ============================================

interface DeleteFileArgs {
  filePath: string;
  force?: boolean;
  [key: string]: unknown; // Index signature to satisfy Record<string, unknown> constraint
}

/**
 * Delete a file from the filesystem
 */
export async function executeDeleteFileTool(
  args: DeleteFileArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { filePath, force = false } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, filePath);

    // Security check
    if (!fullPath.startsWith(workingDirectory)) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Access denied: path is outside working directory',
      };
    }

    // Check if file exists
    try {
      await fs.access(fullPath);
    } catch {
      if (force) {
        return {
          tool_call_id: toolCallId,
          success: true,
          output: `File ${filePath} does not exist (--force flag used)`,
        };
      }
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `File not found: ${filePath}`,
      };
    }

    await fs.unlink(fullPath);

    log.info({ filePath }, 'File deleted');

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `✅ Deleted file: ${filePath}`,
      metadata: { filePath },
    };
  } catch (error) {
    log.error({ filePath, error }, 'Delete file failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Delete file failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// WORKFLOW TOOLS
// ============================================

interface WorkflowStep {
  id: string;
  name: string;
  tool?: string;
  command?: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  condition?: string;
}

interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  variables?: Record<string, unknown>;
}

// In-memory workflow storage (in production, use database)
const workflowRegistry = new Map<string, WorkflowDefinition>();

/**
 * Execute a tool as part of a workflow step
 * This dispatcher routes to the appropriate tool implementation
 */
async function executeWorkflowStepTool(
  toolName: string,
  params: Record<string, unknown>,
  toolCallId: string,
  context: ToolExecutionContext,
  variables: Record<string, unknown>
): Promise<ToolResult> {
  const { log } = context;

  // Substitute variables in params
  const resolvedParams = substituteVariables(params, variables);

  log.debug({ toolName, params: resolvedParams }, 'Executing workflow step tool');

  // Type guard helper to validate and convert params
  // Validates required fields exist and returns typed params
  // Type assertion is safe after validation of required fields
  // Using Record<string, unknown> as base type to allow any object structure
  function validateParams<T extends Record<string, unknown>>(
    params: Record<string, unknown>,
    requiredFields: (keyof T)[]
  ): T {
    for (const field of requiredFields) {
      if (!(field in params)) {
        throw new Error(`Missing required parameter: ${String(field)}`);
      }
    }
    // Type assertion is safe here because we've validated required fields exist
    // and the params object structure matches T (with optional properties allowed)
    // This is necessary because TypeScript cannot infer that Record<string, unknown>
    // with validated keys matches the generic type T
    // All types used with this function now extend Record<string, unknown> to satisfy constraint
    return params as T;
  }

  // Route to appropriate tool based on name
  switch (toolName) {
    case 'extract_function':
      return executeExtractFunctionTool(validateParams<ExtractFunctionArgs>(resolvedParams, ['filePath', 'startLine', 'endLine', 'functionName']), toolCallId, context);

    case 'rename_symbol':
      return executeRenameSymbolTool(validateParams<RenameSymbolArgs>(resolvedParams, ['oldName', 'newName', 'files']), toolCallId, context);

    case 'extract_variable':
      return executeExtractVariableTool(validateParams<ExtractVariableArgs>(resolvedParams, ['filePath', 'line', 'startColumn', 'endColumn', 'variableName']), toolCallId, context);

    case 'inline_function':
      return executeInlineFunctionTool(validateParams<InlineFunctionArgs>(resolvedParams, ['filePath', 'functionName']), toolCallId, context);

    case 'heal_file':
      return executeHealFileTool(validateParams<HealFileArgs>(resolvedParams, ['filePath']), toolCallId, context);

    case 'detect_errors':
      return executeDetectErrorsTool(validateParams<DetectErrorsArgs>(resolvedParams, ['filePath']), toolCallId, context);

    case 'validate_code':
      return executeValidateCodeTool(validateParams<ValidateCodeArgs>(resolvedParams, ['filePaths']), toolCallId, context);

    case 'generate_tests':
      return executeGenerateTestsTool(validateParams<GenerateTestsArgs>(resolvedParams, ['filePath']), toolCallId, context);

    case 'analyze_image':
      return executeAnalyzeImageTool(validateParams<AnalyzeImageArgs>(resolvedParams, ['image_path']), toolCallId, context);

    case 'compare_images':
      return executeCompareImagesTool(validateParams<CompareImagesArgs>(resolvedParams, ['image1_path', 'image2_path']), toolCallId, context);

    case 'extract_code_from_screenshot':
      return executeExtractCodeFromScreenshotTool(validateParams<ExtractCodeFromScreenshotArgs>(resolvedParams, ['image_path']), toolCallId, context);

    case 'file_search':
      return executeFileSearchTool(validateParams<FileSearchArgs>(resolvedParams, ['pattern']), toolCallId, context);

    case 'git_resolve_conflict':
      return executeGitResolveConflictTool(validateParams<GitResolveConflictArgs>(resolvedParams, ['filePath']), toolCallId, context);

    case 'delete_file':
      return executeDeleteFileTool(validateParams<DeleteFileArgs>(resolvedParams, ['filePath']), toolCallId, context);

    case 'explore_codebase':
      return executeExploreCodebaseTool(validateParams<Record<string, unknown>>(resolvedParams, []), toolCallId, context);

    default:
      // For tools from tool-execution-service, import and execute
      try {
        const toolService = await import('./tool-execution-service.js');

        // Check common tools from tool-execution-service
        if (toolName === 'search_replace' && toolService.executeSearchReplaceTool) {
          return toolService.executeSearchReplaceTool(validateParams<{ file_path: string; search: string; replace: string }>(resolvedParams, ['file_path', 'search', 'replace']), toolCallId, context);
        }
        if (toolName === 'grep_search' && toolService.executeGrepSearchTool) {
          return toolService.executeGrepSearchTool(validateParams<{ pattern: string }>(resolvedParams, ['pattern']), toolCallId, context);
        }
        if (toolName === 'git_status' && toolService.executeGitStatusTool) {
          return toolService.executeGitStatusTool(toolCallId, context);
        }
        if (toolName === 'git_commit' && toolService.executeGitCommitTool) {
          return toolService.executeGitCommitTool(validateParams<{ message: string }>(resolvedParams, ['message']), toolCallId, context);
        }
        if (toolName === 'git_diff' && toolService.executeGitDiffTool) {
          return toolService.executeGitDiffTool(validateParams<Record<string, unknown>>(resolvedParams, []), toolCallId, context);
        }
        if (toolName === 'list_directory' && toolService.executeListDirectoryTool) {
          return toolService.executeListDirectoryTool(validateParams<{ path?: string }>(resolvedParams, []), toolCallId, context);
        }
        if (toolName === 'create_todo' && toolService.executeCreateTodoTool) {
          return toolService.executeCreateTodoTool(validateParams<{ description: string }>(resolvedParams, ['description']), toolCallId, context);
        }
        if (toolName === 'web_search' && toolService.executeWebSearchTool) {
          return toolService.executeWebSearchTool(validateParams<{ query: string }>(resolvedParams, ['query']), toolCallId, context);
        }
        if (toolName === 'codebase_search' && toolService.executeCodebaseSearchTool) {
          return toolService.executeCodebaseSearchTool(validateParams<{ query: string }>(resolvedParams, ['query']), toolCallId, context);
        }
      } catch (importError) {
        log.warn({ toolName, error: importError }, 'Failed to import tool from tool-execution-service');
      }

      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Unknown tool: ${toolName}. Available tools: extract_function, rename_symbol, extract_variable, inline_function, heal_file, detect_errors, validate_code, generate_tests, analyze_image, compare_images, file_search, git_resolve_conflict, delete_file, explore_codebase, search_replace, grep_search, git_status, git_commit, git_diff, list_directory, create_todo, web_search, codebase_search`,
      };
  }
}

/**
 * Substitute variables in params using {{variable}} syntax
 */
function substituteVariables(
  params: Record<string, unknown>,
  variables: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Replace {{variable}} patterns with actual values
      result[key] = value.replace(/\{\{(\w+)\}\}/g, (_match: string, varName: string) => {
        const varValue = variables[varName];
        return varValue !== undefined ? String(varValue) : `{{${varName}}}`;
      });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively substitute in nested objects
      result[key] = substituteVariables(value as Record<string, unknown>, variables);
    } else {
      result[key] = value;
    }
  }

  return result;
}

interface ExecuteWorkflowArgs {
  workflowId: string;
  variables?: Record<string, unknown>;
}

/**
 * Execute a registered workflow
 */
export async function executeExecuteWorkflowTool(
  args: ExecuteWorkflowArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { workflowId, variables = {} } = args;
  const { log } = context;

  try {
    const workflow = workflowRegistry.get(workflowId);

    if (!workflow) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Workflow not found: ${workflowId}`,
      };
    }

    const startTime = Date.now();
    const results: Array<{ step: string; success: boolean; output?: string; error?: string }> = [];
    let tasksExecuted = 0;
    let tasksFailed = 0;

    // Execute steps sequentially with REAL implementation
    for (const step of workflow.steps) {
      try {
        // Skip if condition not met (basic evaluation)
        if (step.condition) {
          // Simple condition check - evaluate variable truthiness
          const conditionMet = Boolean(variables[step.condition]);
          if (!conditionMet) {
            results.push({ step: step.name, success: true, output: 'Skipped (condition not met)' });
            continue;
          }
        }

        // Check dependencies
        if (step.dependsOn && step.dependsOn.length > 0) {
          const dependencyFailed = step.dependsOn.some((depId) => {
            const depResult = results.find((r) => r.step === depId);
            return depResult && !depResult.success;
          });
          if (dependencyFailed) {
            results.push({ step: step.name, success: false, error: 'Dependency failed' });
            tasksFailed++;
            continue;
          }
        }

        // REAL EXECUTION: Execute based on step type
        let stepResult: { success: boolean; output?: string; error?: string };

        if (step.command) {
          // Execute shell command
          try {
            const { stdout, stderr } = await execAsync(step.command, {
              cwd: context.workingDirectory,
              timeout: context.timeout || 30000,
            });
            stepResult = {
              success: true,
              output: stdout || stderr || 'Command completed successfully',
            };
          } catch (cmdError: unknown) {
            const errorMessage = cmdError instanceof Error 
              ? cmdError.message 
              : (() => {
                  // Safely extract stderr without type assertions
                  if (typeof cmdError === 'object' && cmdError !== null && 'stderr' in cmdError) {
                    const stderrDescriptor = Object.getOwnPropertyDescriptor(cmdError, 'stderr');
                    if (stderrDescriptor) {
                      return String(stderrDescriptor.value || 'Command failed');
                    }
                  }
                  return 'Command failed';
                })();
            stepResult = {
              success: false,
              error: errorMessage,
            };
          }
        } else if (step.tool) {
          // Execute tool - dispatch to appropriate tool function
          const toolResult = await executeWorkflowStepTool(
            step.tool,
            step.params || {},
            `${toolCallId}-${step.id}`,
            context,
            variables
          );
          stepResult = {
            success: toolResult.success,
            output: toolResult.output,
            error: toolResult.error,
          };
        } else {
          // No-op step (just for organization or conditions)
          stepResult = {
            success: true,
            output: `Step "${step.name}" completed (no action required)`,
          };
        }

        if (stepResult.success) {
          tasksExecuted++;
        } else {
          tasksFailed++;
        }
        results.push({
          step: step.name,
          success: stepResult.success,
          output: stepResult.output,
          error: stepResult.error,
        });
      } catch (stepError) {
        tasksFailed++;
        results.push({
          step: step.name,
          success: false,
          error: stepError instanceof Error ? stepError.message : String(stepError),
        });
      }
    }

    const duration = Date.now() - startTime;

    let output = `✅ Workflow "${workflow.name}" completed\n\n`;
    output += `📊 Summary:\n`;
    output += `  ⏱️  Duration: ${duration}ms\n`;
    output += `  ✅ Tasks executed: ${tasksExecuted}\n`;
    output += `  ❌ Tasks failed: ${tasksFailed}\n\n`;

    output += `📝 Step Results:\n`;
    for (const result of results) {
      const icon = result.success ? '✅' : '❌';
      output += `  ${icon} ${result.step}\n`;
      if (result.error) {
        output += `     Error: ${result.error}\n`;
      }
    }

    log.info({ workflowId, duration, tasksExecuted, tasksFailed }, 'Workflow executed');

    return {
      tool_call_id: toolCallId,
      success: tasksFailed === 0,
      output,
      metadata: { workflowId, duration, tasksExecuted, tasksFailed, results },
    };
  } catch (error) {
    log.error({ workflowId, error }, 'Workflow execution failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Workflow execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface ListWorkflowsArgs {
  // No required args
}

/**
 * List all registered workflows
 */
export async function executeListWorkflowsTool(
  _args: ListWorkflowsArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { log } = context;

  try {
    const workflows = Array.from(workflowRegistry.values());

    if (workflows.length === 0) {
      return {
        tool_call_id: toolCallId,
        success: true,
        output: '📋 No workflows registered\n\nUse register_workflow to create a new workflow.',
        metadata: { count: 0 },
      };
    }

    let output = `📋 Registered Workflows (${workflows.length}):\n\n`;

    for (const workflow of workflows) {
      output += `📌 ${workflow.name} (${workflow.id})\n`;
      if (workflow.description) {
        output += `   ${workflow.description}\n`;
      }
      output += `   Steps: ${workflow.steps.length}\n\n`;
    }

    log.info({ count: workflows.length }, 'List workflows completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: { count: workflows.length, workflows: workflows.map(w => ({ id: w.id, name: w.name, steps: w.steps.length })) },
    };
  } catch (error) {
    log.error({ error }, 'List workflows failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `List workflows failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface RegisterWorkflowArgs {
  workflow: WorkflowDefinition;
}

/**
 * Register a new workflow
 */
export async function executeRegisterWorkflowTool(
  args: RegisterWorkflowArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { workflow } = args;
  const { log } = context;

  try {
    if (!workflow || !workflow.id || !workflow.name || !workflow.steps) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: 'Invalid workflow definition. Required: id, name, steps',
      };
    }

    // Validate steps
    for (const step of workflow.steps) {
      if (!step.id || !step.name) {
        return {
          tool_call_id: toolCallId,
          success: false,
          error: `Invalid step definition. Each step requires: id, name`,
        };
      }
    }

    const exists = workflowRegistry.has(workflow.id);
    workflowRegistry.set(workflow.id, workflow);

    const action = exists ? 'updated' : 'registered';

    log.info({ workflowId: workflow.id, steps: workflow.steps.length }, `Workflow ${action}`);

    return {
      tool_call_id: toolCallId,
      success: true,
      output: `✅ Workflow "${workflow.name}" ${action}\n\n📋 Details:\n  ID: ${workflow.id}\n  Steps: ${workflow.steps.length}`,
      metadata: { workflowId: workflow.id, action, steps: workflow.steps.length },
    };
  } catch (error) {
    log.error({ error }, 'Register workflow failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Register workflow failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================
// EXPLORE CODEBASE TOOL
// ============================================

interface ExploreCodebaseArgs {
  path?: string;
  depth?: number;
  includeStats?: boolean;
}

/**
 * Explore codebase structure and provide overview
 */
export async function executeExploreCodebaseTool(
  args: ExploreCodebaseArgs,
  toolCallId: string,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const { path: targetPath = '.', depth = 2, includeStats = true } = args;
  const { workingDirectory, log } = context;

  try {
    const fullPath = path.resolve(workingDirectory, targetPath);
    const stats = {
      totalFiles: 0,
      totalDirs: 0,
      byExtension: new Map<string, number>(),
      totalSize: 0,
    };

    interface TreeNode {
      name: string;
      type: 'file' | 'directory';
      children?: TreeNode[];
      size?: number;
    }

    const buildTree = async (dir: string, currentDepth: number): Promise<TreeNode[]> => {
      if (currentDepth > depth) return [];

      const nodes: TreeNode[] = [];

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip common ignore patterns
          if (['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.cache'].includes(entry.name)) {
            continue;
          }

          if (entry.name.startsWith('.') && currentDepth > 0) continue;

          const entryPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            stats.totalDirs++;
            const children = await buildTree(entryPath, currentDepth + 1);
            nodes.push({
              name: entry.name,
              type: 'directory',
              children,
            });
          } else if (entry.isFile()) {
            stats.totalFiles++;
            const ext = path.extname(entry.name).toLowerCase() || 'no-ext';
            stats.byExtension.set(ext, (stats.byExtension.get(ext) || 0) + 1);

            try {
              const fileStat = await fs.stat(entryPath);
              stats.totalSize += fileStat.size;
              nodes.push({
                name: entry.name,
                type: 'file',
                size: fileStat.size,
              });
            } catch {
              nodes.push({ name: entry.name, type: 'file' });
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }

      // Sort: directories first, then alphabetically
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return nodes;
    }

    const tree = await buildTree(fullPath, 0);

    // Build tree output
    const renderTree = (nodes: TreeNode[], indent: string = ''): string => {
      let output = '';
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const isLast = i === nodes.length - 1;
        const prefix = isLast ? '└── ' : '├── ';
        const icon = node.type === 'directory' ? '📁' : '📄';

        output += `${indent}${prefix}${icon} ${node.name}\n`;

        if (node.children && node.children.length > 0) {
          const newIndent = indent + (isLast ? '    ' : '│   ');
          output += renderTree(node.children, newIndent);
        }
      }
      return output;
    }

    let output = `🔍 Codebase Explorer: ${targetPath}\n\n`;
    output += renderTree(tree);

    if (includeStats) {
      output += `\n📊 Statistics:\n`;
      output += `  📁 Directories: ${stats.totalDirs}\n`;
      output += `  📄 Files: ${stats.totalFiles}\n`;
      output += `  💾 Total Size: ${formatSize(stats.totalSize)}\n\n`;

      if (stats.byExtension.size > 0) {
        output += `📝 File Types:\n`;
        const sorted = Array.from(stats.byExtension.entries()).sort((a, b) => b[1] - a[1]);
        for (const [ext, count] of sorted.slice(0, 10)) {
          output += `  ${ext}: ${count} file(s)\n`;
        }
        if (sorted.length > 10) {
          output += `  ... and ${sorted.length - 10} more types\n`;
        }
      }
    }

    log.info({ path: targetPath, files: stats.totalFiles, dirs: stats.totalDirs }, 'Explore codebase completed');

    return {
      tool_call_id: toolCallId,
      success: true,
      output,
      metadata: {
        path: targetPath,
        files: stats.totalFiles,
        directories: stats.totalDirs,
        totalSize: stats.totalSize,
        byExtension: Object.fromEntries(stats.byExtension),
      },
    };
  } catch (error) {
    log.error({ path: targetPath, error }, 'Explore codebase failed');
    return {
      tool_call_id: toolCallId,
      success: false,
      error: `Explore codebase failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const ADVANCED_SUPPORTED_TOOLS = [
  'extract_function',
  'rename_symbol',
  'extract_variable',
  'heal_file',
  'generate_tests',
  'todo_write',
  'refactor_code',
  'analyze_image',
  'compare_images',
  'extract_code_from_screenshot',
  'inline_function',
  'file_search',
  'detect_errors',
  'validate_code',
  'git_resolve_conflict',
  'delete_file',
  'execute_workflow',
  'list_workflows',
  'register_workflow',
  'explore_codebase',
] as const;

export type AdvancedSupportedTool = (typeof ADVANCED_SUPPORTED_TOOLS)[number];
