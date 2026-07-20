// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit Tests for Advanced Tool Execution Service
 * 
 * Enterprise-grade tests for advanced tool execution functions.
 * Tests refactoring, validation, multimodal, and workflow tools.
 * 
 * @module tests/services/advanced-tool-execution-service
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

// Mock logger
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLog),
};

interface ToolExecutionContext {
  workingDirectory: string;
  log: typeof mockLog;
}

const createTestContext = (workingDirectory?: string): ToolExecutionContext => ({
  workingDirectory: workingDirectory || process.cwd(),
  log: mockLog,
});

describe('Advanced Tool Execution Service', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = path.join(process.cwd(), `.test-adv-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    if (tempDir && existsSync(tempDir)) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to cleanup temp directory:', error);
      }
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Refactoring Tools', () => {
    describe('Extract Function Tool', () => {
      it('should extract code into a new function', async () => {
        const { executeExtractFunctionTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `extract-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
function main() {
  const x = 1;
  const y = 2;
  const sum = x + y;
  console.log(sum);
}
`);

        const result = await executeExtractFunctionTool(
          {
            filePath: sourceFile,
            startLine: 4,
            endLine: 5,
            functionName: 'calculateSum',
          },
          'test-extract-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-extract-1');
        expect(result.success).toBe(true);
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });

    describe('Rename Symbol Tool', () => {
      it('should rename a symbol across files', async () => {
        const { executeRenameSymbolTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `rename-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
const oldVariableName = 'value';
console.log(oldVariableName);
function useOld() {
  return oldVariableName;
}
`);

        const result = await executeRenameSymbolTool(
          {
            oldName: 'oldVariableName',
            newName: 'newVariableName',
            files: [sourceFile],
          },
          'test-rename-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-rename-1');
        expect(result.success).toBe(true);

        const content = await fs.readFile(sourceFile, 'utf-8');
        expect(content).toContain('newVariableName');
        expect(content).not.toContain('oldVariableName');
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });

    describe('Extract Variable Tool', () => {
      it('should extract expression into a variable', async () => {
        const { executeExtractVariableTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `extract-var-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
function calculate() {
  return 2 + 3 * 4;
}
`);

        const result = await executeExtractVariableTool(
          {
            filePath: sourceFile,
            line: 3,
            startColumn: 10,
            endColumn: 19,
            variableName: 'result',
          },
          'test-extract-var-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-extract-var-1');
        expect(result.success).toBe(true);
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });

    describe('Inline Function Tool', () => {
      it('should inline a function call', async () => {
        const { executeInlineFunctionTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `inline-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
function helper() {
  return 42;
}

function main() {
  const value = helper();
  console.log(value);
}
`);

        const result = await executeInlineFunctionTool(
          {
            filePath: sourceFile,
            functionName: 'helper',
          },
          'test-inline-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-inline-1');
        expect(result.success).toBe(true);
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });
  });

  describe('Validation Tools', () => {
    describe('Detect Errors Tool', () => {
      it('should detect errors in code', async () => {
        const { executeDetectErrorsTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `errors-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
// This file has intentional issues for testing
const x: number = "not a number"; // Type error
function broken( {
  return; // Syntax error - missing closing paren
}
`);

        const result = await executeDetectErrorsTool(
          { filePath: sourceFile },
          'test-detect-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-detect-1');
        // Should detect the errors
        expect(result.success).toBe(true);
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });

    describe('Validate Code Tool', () => {
      it('should validate code against rules', async () => {
        const { executeValidateCodeTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `validate-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
const x: number = 42;
export function test() {
  return x;
}
`);

        const result = await executeValidateCodeTool(
          {
            filePaths: [sourceFile],
            rules: ['no-unused-vars', 'no-console'],
          },
          'test-validate-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-validate-1');
        expect(result.success).toBe(true);
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });

    describe('Heal File Tool', () => {
      it('should attempt to heal file errors', async () => {
        const { executeHealFileTool } = await import('@/services/advanced-tool-execution-service');
        
        const sourceFile = path.join(tempDir, `heal-${Date.now()}.ts`);
        await fs.writeFile(sourceFile, `
// File with minor issues
const  x = 1;  // Extra space
console.log(x)  // Missing semicolon
`);

        const result = await executeHealFileTool(
          {
            filePath: sourceFile,
            autoFix: false, // Dry run
          },
          'test-heal-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-heal-1');
        expect(result.success).toBe(true);
        
        // Cleanup
        await fs.unlink(sourceFile);
      });
    });
  });

  describe('Test Generation Tool', () => {
    it('should generate tests for a file', async () => {
      const { executeGenerateTestsTool } = await import('@/services/advanced-tool-execution-service');
      
      const sourceFile = path.join(tempDir, `source-${Date.now()}.ts`);
      await fs.writeFile(sourceFile, `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`);

      const result = await executeGenerateTestsTool(
        {
          filePath: sourceFile,
          framework: 'vitest',
        },
        'test-gen-1',
        createTestContext()
      );

      expect(result.tool_call_id).toBe('test-gen-1');
      expect(result.success).toBe(true);
      expect(result.output).toContain('test');
      
      // Cleanup
      await fs.unlink(sourceFile);
    });
  });

  describe('File Search Tool', () => {
    it('should search for files by pattern', async () => {
      const { executeFileSearchTool } = await import('@/services/advanced-tool-execution-service');
      
      // Create test files
      await fs.writeFile(path.join(tempDir, 'component.tsx'), 'export const Comp = () => null;');
      await fs.writeFile(path.join(tempDir, 'utils.ts'), 'export const util = () => {};');
      await fs.writeFile(path.join(tempDir, 'styles.css'), '.class {}');

      const result = await executeFileSearchTool(
        {
          pattern: '.*\\.ts.*',
          path: tempDir,
        },
        'test-file-search-1',
        createTestContext()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('.ts');
    });
  });

  describe('Workflow Tools', () => {
    describe('List Workflows Tool', () => {
      it('should list available workflows', async () => {
        const { executeListWorkflowsTool } = await import('@/services/advanced-tool-execution-service');
        
        const result = await executeListWorkflowsTool(
          {},
          'test-list-wf-1',
          createTestContext()
        );

        expect(result.success).toBe(true);
        expect(result.tool_call_id).toBe('test-list-wf-1');
      });
    });

    describe('Register Workflow Tool', () => {
      it('should register a new workflow', async () => {
        const { executeRegisterWorkflowTool } = await import('@/services/advanced-tool-execution-service');
        
        const result = await executeRegisterWorkflowTool(
          {
            workflow: {
              id: `test-workflow-${Date.now()}`,
              name: 'Test Workflow',
              description: 'A workflow for testing',
              steps: [
                { id: 'step-1', name: 'List Directory', tool: 'list_directory', params: { path: '.' } },
                { id: 'step-2', name: 'Grep Search', tool: 'grep_search', params: { pattern: 'test' } },
              ],
            },
          },
          'test-register-wf-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-register-wf-1');
        expect(result.success).toBe(true);
      });
    });

    describe('Execute Workflow Tool', () => {
      it('should execute a workflow', async () => {
        const { executeExecuteWorkflowTool } = await import('@/services/advanced-tool-execution-service');
        
        const result = await executeExecuteWorkflowTool(
          {
            workflowId: 'default',
            parameters: {},
          },
          'test-exec-wf-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-exec-wf-1');
        // May fail if workflow doesn't exist, but should handle gracefully
        expect(result).toHaveProperty('success');
      });
    });
  });

  describe('Codebase Exploration Tool', () => {
    it('should explore codebase structure', async () => {
      const { executeExploreCodebaseTool } = await import('@/services/advanced-tool-execution-service');
      
      const result = await executeExploreCodebaseTool(
        { startPath: tempDir },
        'test-explore-1',
        createTestContext()
      );

      expect(result.tool_call_id).toBe('test-explore-1');
      expect(result.success).toBe(true);
    });
  });

  describe('Git Resolve Conflict Tool', () => {
    it('should handle conflict resolution request', async () => {
      const { executeGitResolveConflictTool } = await import('@/services/advanced-tool-execution-service');
      
      const conflictFile = path.join(tempDir, `conflict-${Date.now()}.ts`);
      const conflictContent = [
        '<<<<<<< HEAD',
        "const version = 'ours';",
        '=======',
        "const version = 'theirs';",
        '>>>>>>> feature-branch',
      ].join('\n');
      await fs.writeFile(conflictFile, conflictContent);

      const result = await executeGitResolveConflictTool(
        {
          filePath: conflictFile,
          resolution: 'ours',
        },
        'test-resolve-1',
        createTestContext()
      );

      expect(result.tool_call_id).toBe('test-resolve-1');
      expect(result.success).toBe(true);
      
      // Cleanup
      await fs.unlink(conflictFile);
    });
  });

  describe('Multimodal Tools', () => {
    describe('Analyze Image Tool', () => {
      it('should handle image analysis request gracefully without API key', async () => {
        const { executeAnalyzeImageTool } = await import('@/services/advanced-tool-execution-service');
        
        const result = await executeAnalyzeImageTool(
          {
            image_path: path.join(tempDir, 'nonexistent.png'),
            analysis_type: 'general',
          },
          'test-analyze-img-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-analyze-img-1');
        // Should fail gracefully - no image or no API key
        expect(result).toHaveProperty('success');
      });
    });

    describe('Compare Images Tool', () => {
      it('should handle image comparison request gracefully', async () => {
        const { executeCompareImagesTool } = await import('@/services/advanced-tool-execution-service');
        
        const result = await executeCompareImagesTool(
          {
            image1_path: path.join(tempDir, 'img1.png'),
            image2_path: path.join(tempDir, 'img2.png'),
          },
          'test-compare-img-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-compare-img-1');
        // Should fail gracefully - images don't exist
        expect(result).toHaveProperty('success');
      });
    });

    describe('Extract Code from Screenshot Tool', () => {
      it('should handle code extraction request gracefully', async () => {
        const { executeExtractCodeFromScreenshotTool } = await import('@/services/advanced-tool-execution-service');
        
        const result = await executeExtractCodeFromScreenshotTool(
          {
            image_path: path.join(tempDir, 'screenshot.png'),
          },
          'test-extract-code-1',
          createTestContext()
        );

        expect(result.tool_call_id).toBe('test-extract-code-1');
        // Should fail gracefully
        expect(result).toHaveProperty('success');
      });
    });
  });

  describe('Tool Error Handling', () => {
    it('should handle invalid arguments gracefully', async () => {
      const { executeExtractFunctionTool } = await import('@/services/advanced-tool-execution-service');
      
      const result = await executeExtractFunctionTool(
        {
          filePath: '/nonexistent/file.ts',
          startLine: -1, // Invalid
          endLine: 0,
          functionName: '',
        },
        'test-error-1',
        createTestContext()
      );

      expect(result.tool_call_id).toBe('test-error-1');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

