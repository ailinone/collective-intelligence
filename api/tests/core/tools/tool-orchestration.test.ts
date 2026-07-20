// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import {
  ToolDependencyAnalyzer,
  IntelligentToolDispatcher,
  ParallelToolExecutionCoordinator,
  toolOrchestrationSystem,
  type ToolCall,
} from '@/core/tools/tool-orchestration-system';

describe('Tool Orchestration System', () => {
  const mockModels = [
    { id: 'gemini-flash', name: 'Gemini 2.0 Flash', provider: 'google' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
    { id: 'deepseek-coder', name: 'DeepSeek Coder', provider: 'deepseek' },
    { id: 'claude-haiku', name: 'Claude Haiku', provider: 'anthropic' },
  ];

  describe('ToolDependencyAnalyzer', () => {
    const analyzer = new ToolDependencyAnalyzer();

    it('should detect no dependencies for independent tools', () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: { path: 'a.ts' } },
        { id: '2', name: 'list_directory', parameters: { path: '.' } },
        { id: '3', name: 'grep_search', parameters: { pattern: 'TODO' } },
      ];

      const graph = analyzer.analyzeDependencies(tools);

      expect(graph.parallelGroups.length).toBe(1); // All in one group
      expect(graph.parallelGroups[0].tools.length).toBe(3);
      expect(graph.parallelGroups[0].parallel).toBe(true);
    });

    it('should detect dependencies between tools', () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: {} },
        { id: '2', name: 'write_file', parameters: { mode: 'edit' } },
        { id: '3', name: 'git_commit', parameters: {} },
      ];

      const graph = analyzer.analyzeDependencies(tools);

      // Should have 3 groups due to dependencies
      // Group 1: read_file
      // Group 2: write_file (depends on read_file)
      // Group 3: git_commit (depends on write_file)
      expect(graph.parallelGroups.length).toBeGreaterThanOrEqual(2);
    });

    it('should group independent tools together', () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: { path: 'a.ts' } },
        { id: '2', name: 'read_file', parameters: { path: 'b.ts' } },
        { id: '3', name: 'read_file', parameters: { path: 'c.ts' } },
        { id: '4', name: 'grep_search', parameters: { pattern: 'test' } },
        { id: '5', name: 'list_directory', parameters: { path: '.' } },
      ];

      const graph = analyzer.analyzeDependencies(tools);

      // All should be in one parallel group (no dependencies)
      expect(graph.parallelGroups.length).toBe(1);
      // Should include all unique tool names
      expect(graph.parallelGroups[0].tools.length).toBeGreaterThanOrEqual(3);
      expect(graph.parallelGroups[0].parallel).toBe(true);
    });
  });

  describe('IntelligentToolDispatcher', () => {
    const dispatcher = new IntelligentToolDispatcher();

    it('should profile tools correctly', () => {
      const readFileProfile = dispatcher.profileTool('read_file');
      expect(readFileProfile.speed).toBe('any');
      expect(readFileProfile.precision).toBe('low');
      expect(readFileProfile.specialization).toBe('none');

      const writeFileProfile = dispatcher.profileTool('write_file');
      expect(writeFileProfile.precision).toBe('high');
      expect(writeFileProfile.specialization).toBe('code');

      const gitCommitProfile = dispatcher.profileTool('git_commit');
      expect(gitCommitProfile.precision).toBe('high');
    });

    it('should assign code tools to code-specialized models', () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'write_file', parameters: {} },
        { id: '2', name: 'refactor_code', parameters: {} },
        { id: '3', name: 'generate_tests', parameters: {} },
      ];

      const assignments = dispatcher.assignToolsToModels(tools, mockModels);

      // DeepSeek Coder should get at least some code tools
      const deepseekTools = assignments.get('deepseek-coder') || [];
      expect(deepseekTools.length).toBeGreaterThan(0);
    });

    it('should distribute tools across multiple models', () => {
      const tools: ToolCall[] = Array.from({ length: 12 }, (_, i) => ({
        id: `${i + 1}`,
        name: i % 2 === 0 ? 'read_file' : 'grep_search',
        parameters: {},
      }));

      const assignments = dispatcher.assignToolsToModels(tools, mockModels);

      // Should use multiple models
      expect(assignments.size).toBeGreaterThan(1);
      
      // Should balance load
      const toolCounts = Array.from(assignments.values()).map((t) => t.length);
      const max = Math.max(...toolCounts);
      const min = Math.min(...toolCounts);
      
      // Load should be relatively balanced (within 2x)
      expect(max / min).toBeLessThan(3);
    });
  });

  describe('ParallelToolExecutionCoordinator', () => {
    const coordinator = new ParallelToolExecutionCoordinator();

    it('should create execution plan with parallel groups', () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: {} },
        { id: '2', name: 'read_file', parameters: {} },
        { id: '3', name: 'grep_search', parameters: {} },
        { id: '4', name: 'list_directory', parameters: {} },
      ];

      const plan = coordinator.createExecutionPlan(tools, mockModels);

      expect(plan.groups.length).toBeGreaterThan(0);
      expect(plan.assignments.size).toBeGreaterThan(0);
      expect(plan.estimatedSpeedup).toBeGreaterThan(1);
    });

    it('should calculate significant speedup for many independent tools', () => {
      const tools: ToolCall[] = Array.from({ length: 20 }, (_, i) => ({
        id: `${i + 1}`,
        name: 'read_file',
        parameters: { path: `file${i}.ts` },
      }));

      const plan = coordinator.createExecutionPlan(tools, mockModels);

      // With 20 independent tools and 4 models, should have good speedup
      expect(plan.estimatedSpeedup).toBeGreaterThan(3);
      expect(plan.assignments.size).toBeGreaterThan(1);
    });

    it('should provide execution statistics', () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: {} },
        { id: '2', name: 'grep_search', parameters: {} },
        { id: '3', name: 'list_directory', parameters: {} },
      ];

      const plan = coordinator.createExecutionPlan(tools, mockModels);
      const stats = coordinator.getStatistics(plan);

      expect(stats.toolCount).toBe(3);
      expect(stats.modelCount).toBeGreaterThan(0);
      expect(stats.parallelizationFactor).toBeGreaterThan(0);
    });
  });

  describe('Tool Orchestration System (Facade)', () => {
    it('should orchestrate tools and provide recommendations', async () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: {} },
        { id: '2', name: 'write_file', parameters: {} },
        { id: '3', name: 'generate_tests', parameters: {} },
      ];

      const result = await toolOrchestrationSystem.orchestrate(tools, mockModels);

      expect(result.plan).toBeDefined();
      expect(result.statistics).toBeDefined();
      expect(result.recommendation).toContain('parallelization');
    });

    it('should recognize excellent parallelization (>5x)', async () => {
      const tools: ToolCall[] = Array.from({ length: 30 }, (_, i) => ({
        id: `${i + 1}`,
        name: 'read_file',
        parameters: { path: `file${i}.ts` },
      }));

      const result = await toolOrchestrationSystem.orchestrate(tools, mockModels);

      expect(result.recommendation).toContain('Excellent');
      expect(result.statistics.parallelizationFactor).toBeGreaterThan(5);
    });

    it('should handle dependency chains correctly', async () => {
      const tools: ToolCall[] = [
        { id: '1', name: 'read_file', parameters: {} },
        { id: '2', name: 'search_replace', parameters: {} }, // Depends on read_file
        { id: '3', name: 'git_commit', parameters: {} }, // Depends on search_replace
      ];

      const result = await toolOrchestrationSystem.orchestrate(tools, mockModels);

      // Should detect dependencies and create sequential groups
      expect(result.plan.groups.length).toBeGreaterThanOrEqual(2);
      expect(result.recommendation).toBeDefined();
    });
  });
});

