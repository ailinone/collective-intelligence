// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit Tests for Tool Execution Service
 * 
 * Enterprise-grade tests for tool execution functions.
 * Tests file operations, Git commands, and code analysis tools.
 * 
 * @module tests/services/tool-execution-service
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

// Mock logger to avoid console output during tests
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLog),
};

// Type for tool execution context
interface ToolExecutionContext {
  workingDirectory: string;
  log: typeof mockLog;
}

// Helper to create test context
const createTestContext = (workingDirectory?: string): ToolExecutionContext => ({
  workingDirectory: workingDirectory || process.cwd(),
  log: mockLog,
});

describe('Tool Execution Service', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeAll(async () => {
    // Create a unique temporary directory for all tests
    tempDir = path.join(process.cwd(), `.test-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    // Cleanup temporary directory after all tests
    if (tempDir && existsSync(tempDir)) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to cleanup temp directory:', error);
      }
    }
  });

  beforeEach(async () => {
    // Create a fresh test file for each test
    testFilePath = path.join(tempDir, `test-file-${Date.now()}.ts`);
    await fs.writeFile(testFilePath, `
// Test file for tool execution tests
function hello() {
  console.log('Hello, World!');
}

function goodbye() {
  console.log('Goodbye, World!');
}

export { hello, goodbye };
`);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test file
    if (testFilePath && existsSync(testFilePath)) {
      try {
        await fs.unlink(testFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Search Replace Tool', () => {
    it('should replace a single occurrence in a file', async () => {
      const { executeSearchReplaceTool } = await import('@/services/tool-execution-service');
      
      const result = await executeSearchReplaceTool(
        {
          file_path: testFilePath,
          search: 'Hello, World!',
          replace: 'Hello, Universe!',
        },
        'test-call-sr-1',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(result.tool_call_id).toBe('test-call-sr-1');
      
      const content = await fs.readFile(testFilePath, 'utf-8');
      expect(content).toContain('Hello, Universe!');
      expect(content).not.toContain('Hello, World!');
    });

    it('should replace all occurrences when replace_all is true', async () => {
      const { executeSearchReplaceTool } = await import('@/services/tool-execution-service');
      
      // Create file with multiple occurrences
      const multiFilePath = path.join(tempDir, `multi-${Date.now()}.txt`);
      await fs.writeFile(multiFilePath, 'foo bar foo baz foo');

      const result = await executeSearchReplaceTool(
        {
          file_path: multiFilePath,
          search: 'foo',
          replace: 'qux',
          all: true,
        },
        'test-call-sr-2',
        createTestContext()
      );

      expect(result.success).toBe(true);
      
      const content = await fs.readFile(multiFilePath, 'utf-8');
      expect(content).toBe('qux bar qux baz qux');
      
      // Cleanup
      await fs.unlink(multiFilePath);
    });

    it('should fail gracefully when file does not exist', async () => {
      const { executeSearchReplaceTool } = await import('@/services/tool-execution-service');
      
      const result = await executeSearchReplaceTool(
        {
          file_path: '/nonexistent/path/file.txt',
          search: 'foo',
          replace: 'bar',
        },
        'test-call-sr-3',
        createTestContext()
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.tool_call_id).toBe('test-call-sr-3');
    });

    it('should fail when search string not found', async () => {
      const { executeSearchReplaceTool } = await import('@/services/tool-execution-service');
      
      const result = await executeSearchReplaceTool(
        {
          file_path: testFilePath,
          search: 'This string definitely does not exist anywhere',
          replace: 'replacement',
        },
        'test-call-sr-4',
        createTestContext()
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      const normalizedError = (result.error ?? '').toLowerCase();
      expect(
        normalizedError.includes('not found') || normalizedError.includes('no matches found')
      ).toBe(true);
    });
  });

  describe('Grep Search Tool', () => {
    it('should find patterns in files', async () => {
      const { executeGrepSearchTool } = await import('@/services/tool-execution-service');
      
      const result = await executeGrepSearchTool(
        {
          pattern: 'function',
          path: tempDir,
        },
        'test-call-grep-1',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('function');
      expect(result.tool_call_id).toBe('test-call-grep-1');
    });

    it('should handle no matches gracefully', async () => {
      const { executeGrepSearchTool } = await import('@/services/tool-execution-service');
      
      const result = await executeGrepSearchTool(
        {
          pattern: 'xyznonexistent123pattern789',
          path: tempDir,
        },
        'test-call-grep-2',
        createTestContext()
      );

      expect(result.success).toBe(true);
      // Should succeed but with no matches
      expect(result.output).toBeDefined();
    });

    it('should support regex patterns', async () => {
      const { executeGrepSearchTool } = await import('@/services/tool-execution-service');
      
      const result = await executeGrepSearchTool(
        {
          pattern: 'function\\s+\\w+',
          path: tempDir,
        },
        'test-call-grep-3',
        createTestContext()
      );

      expect(result.success).toBe(true);
    });
  });

  describe('List Directory Tool', () => {
    it('should list directory contents', async () => {
      const { executeListDirectoryTool } = await import('@/services/tool-execution-service');
      
      // Create additional test files
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(tempDir, 'file2.txt'), 'content2');
      await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true });

      const result = await executeListDirectoryTool(
        { path: tempDir },
        'test-call-ls-1',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('file1.txt');
      expect(result.output).toContain('file2.txt');
      expect(result.output).toContain('subdir');
    });

    it('should fail gracefully for nonexistent directory', async () => {
      const { executeListDirectoryTool } = await import('@/services/tool-execution-service');
      
      const result = await executeListDirectoryTool(
        { path: '/nonexistent/directory/path' },
        'test-call-ls-2',
        createTestContext()
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Git Tools', () => {
    it('should get git status in a git repository', async () => {
      const { executeGitStatusTool } = await import('@/services/tool-execution-service');
      
      // Run from project root which is a git repo
      const result = await executeGitStatusTool(
        'test-call-git-1',
        createTestContext(process.cwd())
      );

      expect(result.tool_call_id).toBe('test-call-git-1');
      // Should succeed in project root (which is a git repo)
      expect(result.success).toBe(true);
    });

    it('should get git diff', async () => {
      const { executeGitDiffTool } = await import('@/services/tool-execution-service');
      
      const result = await executeGitDiffTool(
        { staged: false },
        'test-call-git-2',
        createTestContext(process.cwd())
      );

      expect(result.tool_call_id).toBe('test-call-git-2');
      expect(result.success).toBe(true);
    });
  });

  describe('Batch Operations', () => {
    it('should apply batch search and replace', async () => {
      const { executeBatchSearchReplaceTool } = await import('@/services/tool-execution-service');
      
      // Create multiple files
      const file1Name = `batch1-${Date.now()}.txt`;
      const file2Name = `batch2-${Date.now()}.txt`;
      const file1 = path.join(tempDir, file1Name);
      const file2 = path.join(tempDir, file2Name);
      await fs.writeFile(file1, 'original content 1');
      await fs.writeFile(file2, 'original content 2');

      const result = await executeBatchSearchReplaceTool(
        {
          files: [file1Name, file2Name],
          search: 'original',
          replace: 'modified',
        },
        'test-call-batch-1',
        createTestContext(tempDir)
      );

      expect(result.success).toBe(true);

      const content1 = await fs.readFile(file1, 'utf-8');
      const content2 = await fs.readFile(file2, 'utf-8');
      expect(content1).toContain('modified');
      expect(content2).toContain('modified');

      // Cleanup
      await fs.unlink(file1);
      await fs.unlink(file2);
    });

    it('should apply multi-file changes atomically', async () => {
      const { executeApplyMultiFileChangesTool } = await import('@/services/tool-execution-service');
      
      const newFilePath = path.join(tempDir, `new-file-${Date.now()}.txt`);

      const result = await executeApplyMultiFileChangesTool(
        {
          changes: [
            { file_path: newFilePath, operation: 'create', content: 'brand new content' },
          ],
        },
        'test-call-multi-1',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(existsSync(newFilePath)).toBe(true);

      const content = await fs.readFile(newFilePath, 'utf-8');
      expect(content).toBe('brand new content');

      // Cleanup
      await fs.unlink(newFilePath);
    });
  });

  describe('TODO Management', () => {
    interface TodoItem {
      id: string;
      description: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
      priority?: 'high' | 'medium' | 'low';
      created_at: number;
      updated_at: number;
      completed_at?: number;
    }

    interface CreateTodoMetadata {
      todo: TodoItem;
    }

    interface ListTodosMetadata {
      total: number;
      items: TodoItem[];
    }

    it('should create a todo item', async () => {
      const { executeCreateTodoTool } = await import('@/services/tool-execution-service');
      
      const result = await executeCreateTodoTool(
        {
          description: 'Test TODO item for enterprise testing',
          priority: 'high',
        },
        'test-call-todo-1',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Test TODO item');
    });

    it('should list todos', async () => {
      const { executeListTodosTool } = await import('@/services/tool-execution-service');
      
      const result = await executeListTodosTool(
        {},
        'test-call-todo-2',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it('should mark a todo as completed via check tool', async () => {
      const { executeCreateTodoTool, executeCheckTodoTool, executeListTodosTool } = await import('@/services/tool-execution-service');

      const createContext = createTestContext(tempDir);
      const createResult = await executeCreateTodoTool(
        {
          description: 'Complete me',
          priority: 'low',
        },
        'test-call-todo-3',
        createContext
      );

      expect(createResult.success).toBe(true);
      const metadata = createResult.metadata as CreateTodoMetadata | undefined;
      const todoId = metadata?.todo?.id;
      expect(todoId).toBeDefined();

      const checkResult = await executeCheckTodoTool(
        { id: todoId },
        'test-call-todo-check-1',
        createContext
      );

      expect(checkResult.success).toBe(true);

      const listResult = await executeListTodosTool(
        {},
        'test-call-todo-check-2',
        createContext
      );

      expect(listResult.success).toBe(true);
      const listMetadata = listResult.metadata as ListTodosMetadata | undefined;
      const items = listMetadata?.items;
      expect(items?.some(item => item.id === todoId && item.status === 'completed')).toBe(true);
    });
  });

  describe('Codebase Search Tool', () => {
    it('should search codebase with query', async () => {
      const { executeCodebaseSearchTool } = await import('@/services/tool-execution-service');
      
      const result = await executeCodebaseSearchTool(
        {
          query: 'function',
          path: tempDir,
        },
        'test-call-search-1',
        createTestContext()
      );

      expect(result.tool_call_id).toBe('test-call-search-1');
      expect(result.success).toBe(true);
    });
  });

  describe('Tool Result Structure', () => {
    it('should return consistent result structure on success', async () => {
      const { executeListDirectoryTool } = await import('@/services/tool-execution-service');
      
      const result = await executeListDirectoryTool(
        { path: tempDir },
        'test-structure-1',
        createTestContext()
      );

      // Required fields
      expect(result).toHaveProperty('tool_call_id');
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
      
      if (result.success) {
        expect(result).toHaveProperty('output');
        expect(typeof result.output).toBe('string');
      }
    });

    it('should return consistent result structure on failure', async () => {
      const { executeListDirectoryTool } = await import('@/services/tool-execution-service');
      
      const result = await executeListDirectoryTool(
        { path: '/nonexistent' },
        'test-structure-2',
        createTestContext()
      );

      expect(result).toHaveProperty('tool_call_id');
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
      expect(typeof result.error).toBe('string');
    });
  });
});

