// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Agentic Workflow Engine
 *
 * Enables autonomous, multi-step AI workflows where the system can:
 * - Plan and decompose complex tasks
 * - Execute steps autonomously
 * - Use tools and external resources
 * - Maintain context across steps
 * - Self-correct and retry on failures
 *
 * This is a key component for true Collective Intelligence,
 * going beyond simple request-response to agentic behavior.
 *
 * Architecture:
 * - Workflow: A complete task decomposed into steps
 * - Step: An individual unit of work (LLM call, tool use, etc.)
 * - Agent: The orchestration entity that executes workflows
 * - Context: Shared state across workflow steps
 */

import type { OrchestrationContext } from '@/types';
import type { ToolExecutionContext, ToolResult } from '@/services/advanced-tool-execution-service';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { safeResponseContent } from '@/core/orchestration/base-strategy';
import { nanoid } from 'nanoid';
import { prisma } from '@/database/client';

const log = logger.child({ component: 'agentic-workflow' });

/**
 * Workflow step types
 */
export type StepType = 
  | 'llm_call'      // Call an LLM
  | 'tool_call'     // Use a tool
  | 'human_input'   // Wait for human input
  | 'condition'     // Conditional branching
  | 'loop'          // Iterate over items
  | 'parallel'      // Execute steps in parallel
  | 'sub_workflow'; // Execute nested workflow

/**
 * Workflow step definition
 */
export interface WorkflowStep {
  id: string;
  name: string;
  type: StepType;
  config: {
    model?: string;
    prompt?: string;
    tools?: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
    condition?: string; // JavaScript expression
    items?: string;     // Variable name for loop items
    steps?: WorkflowStep[]; // Sub-steps for parallel/loop/sub_workflow
    humanInput?: {
      variable?: string;
      prompt?: string;
      required?: boolean;
      defaultValue?: unknown;
    };
    maxRetries?: number;
    timeout?: number;
  };
  dependencies?: string[]; // Step IDs that must complete first
}

/**
 * Workflow definition
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  steps: WorkflowStep[];
  initialContext?: Record<string, unknown>;
  maxDuration?: number; // Max execution time in ms
  maxSteps?: number;    // Max steps to prevent infinite loops
}

/**
 * Step execution result
 */
export interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped' | 'pending';
  output: unknown;
  error?: string;
  durationMs: number;
  cost: number;
  tokensUsed: number;
  retries: number;
}

/**
 * Workflow execution result
 */
export interface WorkflowResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  steps: StepResult[];
  finalOutput: unknown;
  totalDuration: number;
  totalCost: number;
  totalTokens: number;
  context: Record<string, unknown>;
}

/**
 * Workflow execution context
 */
interface ExecutionContext {
  workflowId: string;
  variables: Record<string, unknown>;
  stepResults: Map<string, StepResult>;
  startTime: number;
  stepsExecuted: number;
  maxSteps: number;
  maxDuration: number;
  organizationId: string;
  userId?: string;
}

export interface HumanInputRequest {
  workflowExecutionId: string;
  stepId: string;
  stepName: string;
  variable: string;
  prompt?: string;
  required: boolean;
  organizationId: string;
  userId?: string;
  context: Record<string, unknown>;
}

export type HumanInputResolver = (request: HumanInputRequest) => Promise<unknown>;

/**
 * Agentic Workflow Engine
 */
export class AgenticWorkflowEngine {
  private activeWorkflows: Map<string, ExecutionContext> = new Map();
  private registeredWorkflows: Map<string, WorkflowDefinition> = new Map();
  private humanInputResolver: HumanInputResolver | null = null;

  /**
   * Configure async resolver for human input steps.
   * Resolver can be wired to queue/UI/webhook without changing workflow definitions.
   */
  setHumanInputResolver(resolver: HumanInputResolver | null): void {
    this.humanInputResolver = resolver;
  }

  /**
   * Register a reusable workflow definition
   */
  registerWorkflow(workflow: WorkflowDefinition): void {
    this.registeredWorkflows.set(workflow.id, workflow);
    log.info({ workflowId: workflow.id, name: workflow.name }, 'Workflow registered');
  }

  /**
   * Get registered workflow by ID
   */
  getWorkflow(workflowId: string): WorkflowDefinition | undefined {
    return this.registeredWorkflows.get(workflowId);
  }

  /**
   * Create a new workflow from a natural language task description
   */
  async createWorkflowFromTask(params: {
    task: string;
    context: OrchestrationContext;
    availableTools?: Array<{ name: string; description: string }>;
  }): Promise<WorkflowDefinition> {
    const { task, context: _context, availableTools } = params;

    log.info({ task: task.substring(0, 100) }, 'Creating workflow from task');

    // Use LLM to plan the workflow
    const planningPrompt = this.buildPlanningPrompt(task, availableTools);

    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const allModels = await registry.getAllModels();

    // Select planning model (high quality)
    const planningModel = allModels
      .filter((m) => m.performance?.quality >= 0.85)
      .sort((a, b) => b.performance.quality - a.performance.quality)[0];

    if (!planningModel) {
      throw new Error('No suitable model for workflow planning');
    }

    const result = await registry.findModel(planningModel.id);
    if (!result) {
      throw new Error('Planning model not found');
    }

    const planResponse = await result.adapter.chatCompletion({
      model: planningModel.id,
      messages: [
        {
          role: 'system',
          content: `You are an expert workflow planner. Decompose tasks into clear, executable steps.
Output ONLY valid JSON.`,
        },
        {
          role: 'user',
          content: planningPrompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const planContentStr = safeResponseContent(planResponse);

    return this.parseWorkflowPlan(planContentStr, task);
  }

  /**
   * Execute a workflow
   */
  async execute(params: {
    workflow: WorkflowDefinition;
    input?: Record<string, unknown>;
    organizationId: string;
    userId?: string;
  }): Promise<WorkflowResult> {
    const { workflow, input, organizationId, userId } = params;

    const executionId = `wf_${nanoid(16)}`;
    const startTime = Date.now();

    log.info(
      {
        executionId,
        workflowId: workflow.id,
        stepCount: workflow.steps.length,
      },
      'Starting workflow execution'
    );

    // Initialize execution context
    const context: ExecutionContext = {
      workflowId: executionId,
      variables: {
        ...workflow.initialContext,
        ...input,
        _workflowId: executionId,
        _startTime: startTime,
      },
      stepResults: new Map(),
      startTime,
      stepsExecuted: 0,
      maxSteps: workflow.maxSteps || 100,
      maxDuration: workflow.maxDuration || 300000, // 5 min default
      organizationId,
      userId,
    };

    this.activeWorkflows.set(executionId, context);

    const stepResults: StepResult[] = [];
    let status: WorkflowResult['status'] = 'completed';
    let finalOutput: unknown = null;

    try {
      // Execute steps in order, respecting dependencies
      for (const step of workflow.steps) {
        // Check execution limits
        if (context.stepsExecuted >= context.maxSteps) {
          status = 'failed';
          log.warn({ executionId }, 'Workflow max steps exceeded');
          break;
        }

        if (Date.now() - startTime > context.maxDuration) {
          status = 'timeout';
          log.warn({ executionId }, 'Workflow timeout');
          break;
        }

        // Check dependencies
        if (step.dependencies && step.dependencies.length > 0) {
          const allDepsComplete = step.dependencies.every((depId) => {
            const depResult = context.stepResults.get(depId);
            return depResult && depResult.status === 'success';
          });

          if (!allDepsComplete) {
            stepResults.push({
              stepId: step.id,
              status: 'skipped',
              output: null,
              error: 'Dependencies not met',
              durationMs: 0,
              cost: 0,
              tokensUsed: 0,
              retries: 0,
            });
            continue;
          }
        }

        // Execute step
        const stepResult = await this.executeStep(step, context);
        stepResults.push(stepResult);
        context.stepResults.set(step.id, stepResult);
        context.stepsExecuted++;

        // Update context with step output
        context.variables[`${step.id}_output`] = stepResult.output;

        // Checkpoint: persist state to DB after each step for crash recovery
        this.checkpoint(executionId, workflow, context, stepResults).catch((err) =>
          log.warn({ error: getErrorMessage(err), executionId }, 'Workflow checkpoint failed')
        );

        if (stepResult.status === 'failed') {
          status = 'failed';
          break;
        }

        // Last successful step output becomes final output
        finalOutput = stepResult.output;
      }
    } catch (error) {
      status = 'failed';
      log.error(
        { executionId, error: getErrorMessage(error) },
        'Workflow execution failed'
      );
    } finally {
      this.activeWorkflows.delete(executionId);
    }

    const result: WorkflowResult = {
      workflowId: executionId,
      status,
      steps: stepResults,
      finalOutput,
      totalDuration: Date.now() - startTime,
      totalCost: stepResults.reduce((sum, s) => sum + s.cost, 0),
      totalTokens: stepResults.reduce((sum, s) => sum + s.tokensUsed, 0),
      context: context.variables,
    };

    log.info(
      {
        executionId,
        status,
        duration: result.totalDuration,
        cost: result.totalCost,
        steps: stepResults.length,
      },
      'Workflow execution completed'
    );

    // Finalize checkpoint in DB (non-blocking)
    this.finalizeCheckpoint(executionId, status).catch(() => {});

    return result;
  }

  /**
   * Cancel an active workflow
   */
  cancelWorkflow(executionId: string): boolean {
    const context = this.activeWorkflows.get(executionId);
    if (context) {
      this.activeWorkflows.delete(executionId);
      log.info({ executionId }, 'Workflow cancelled');
      return true;
    }
    return false;
  }

  /**
   * Get active workflow status
   */
  getWorkflowStatus(executionId: string): {
    active: boolean;
    stepsExecuted: number;
    elapsed: number;
  } | null {
    const context = this.activeWorkflows.get(executionId);
    if (!context) return null;

    return {
      active: true,
      stepsExecuted: context.stepsExecuted,
      elapsed: Date.now() - context.startTime,
    };
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<StepResult> {
    const startTime = Date.now();
    let retries = 0;
    const maxRetries = step.config.maxRetries || 3;

    while (retries < maxRetries) {
      try {
        const output = await this.executeStepInternal(step, context);

        return {
          stepId: step.id,
          status: 'success',
          output,
          durationMs: Date.now() - startTime,
          cost: 0, // Would be calculated from actual API calls
          tokensUsed: 0,
          retries,
        };
      } catch (error) {
        retries++;
        log.warn(
          {
            stepId: step.id,
            retry: retries,
            error: getErrorMessage(error),
          },
          'Step execution failed, retrying'
        );

        if (retries >= maxRetries) {
          return {
            stepId: step.id,
            status: 'failed',
            output: null,
            error: getErrorMessage(error),
            durationMs: Date.now() - startTime,
            cost: 0,
            tokensUsed: 0,
            retries,
          };
        }

        // Wait before retry (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      }
    }

    // Should never reach here
    return {
      stepId: step.id,
      status: 'failed',
      output: null,
      error: 'Max retries exceeded',
      durationMs: Date.now() - startTime,
      cost: 0,
      tokensUsed: 0,
      retries,
    };
  }

  /**
   * Execute step based on type
   */
  private async executeStepInternal(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<unknown> {
    switch (step.type) {
      case 'llm_call':
        return this.executeLLMStep(step, context);

      case 'tool_call':
        return this.executeToolStep(step, context);

      case 'condition':
        return this.executeConditionStep(step, context);

      case 'loop':
        return this.executeLoopStep(step, context);

      case 'parallel':
        return this.executeParallelStep(step, context);

      case 'sub_workflow':
        return this.executeSubWorkflow(step, context);

      case 'human_input':
        return this.executeHumanInputStep(step, context);

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  private async executeHumanInputStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<{
    variable: string;
    value: unknown;
    source: 'context' | 'resolver' | 'default' | 'optional_empty';
    prompt?: string;
  }> {
    const humanInputConfig = step.config.humanInput || {};
    const variable =
      typeof humanInputConfig.variable === 'string' && humanInputConfig.variable.trim().length > 0
        ? humanInputConfig.variable.trim()
        : `${step.id}_input`;
    const templatePrompt =
      typeof humanInputConfig.prompt === 'string'
        ? humanInputConfig.prompt
        : typeof step.config.prompt === 'string'
          ? step.config.prompt
          : '';
    const prompt =
      templatePrompt.trim().length > 0
        ? this.interpolateTemplate(templatePrompt, context.variables)
        : undefined;
    const required = humanInputConfig.required !== false;

    const existingValue = context.variables[variable];
    if (existingValue !== undefined && existingValue !== null) {
      return {
        variable,
        value: existingValue,
        source: 'context',
        prompt,
      };
    }

    if (this.humanInputResolver) {
      const resolvedValue = await this.humanInputResolver({
        workflowExecutionId: context.workflowId,
        stepId: step.id,
        stepName: step.name,
        variable,
        prompt,
        required,
        organizationId: context.organizationId,
        userId: context.userId,
        context: { ...context.variables },
      });

      if (resolvedValue !== undefined && resolvedValue !== null) {
        context.variables[variable] = resolvedValue;
        return {
          variable,
          value: resolvedValue,
          source: 'resolver',
          prompt,
        };
      }
    }

    if (humanInputConfig.defaultValue !== undefined) {
      context.variables[variable] = humanInputConfig.defaultValue;
      return {
        variable,
        value: humanInputConfig.defaultValue,
        source: 'default',
        prompt,
      };
    }

    if (!required) {
      context.variables[variable] = null;
      return {
        variable,
        value: null,
        source: 'optional_empty',
        prompt,
      };
    }

    throw new Error(
      `Human input required for step '${step.id}' (variable '${variable}') but no resolver/context/default provided`
    );
  }

  /**
   * Execute LLM call step
   */
  private async executeLLMStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<string> {
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();

    const modelId = step.config.model || 'auto';
    const prompt = this.interpolateTemplate(step.config.prompt || '', context.variables);

    // Find model
    const allModels = await registry.getAllModels();
    const model = modelId === 'auto'
      ? allModels.find((m) => m.performance?.quality >= 0.8)
      : allModels.find((m) => m.id === modelId || m.name === modelId);

    if (!model) {
      throw new Error(`Model ${modelId} not found`);
    }

    const result = await registry.findModel(model.id);
    if (!result) {
      throw new Error(`Model ${model.id} not in registry`);
    }

    const response = await result.adapter.chatCompletion({
      model: model.id,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    });

    return safeResponseContent(response);
  }

  /**
   * Execute tool call step
   */
  private async executeToolStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<unknown> {
    const tools = step.config.tools || [];
    
    if (tools.length === 0) {
      log.warn({ stepId: step.id }, 'Tool step has no tools configured');
      return { toolResult: null, error: 'No tools configured for step' };
    }

    // Execute first tool (for now, execute tools sequentially if multiple)
    const tool = tools[0];
    const toolCallId = `tool-${step.id}-${nanoid(8)}`;

    log.info({ stepId: step.id, toolName: tool.name, toolCallId }, 'Executing tool step');

    try {
      // Import tool execution functions dynamically
      const toolExecutionModule = await import('@/services/advanced-tool-execution-service.js');
      const {
        executeExtractFunctionTool,
        executeRenameSymbolTool,
        executeExtractVariableTool,
        executeHealFileTool,
        executeGenerateTestsTool,
        executeDetectErrorsTool,
        executeValidateCodeTool,
        executeFileSearchTool,
        executeDeleteFileTool,
        executeExploreCodebaseTool,
      } = toolExecutionModule;

      // Create tool execution context
      const toolContext: ToolExecutionContext = {
        workingDirectory: process.cwd(), // Default to current working directory
        timeout: step.config.timeout || 30000,
        log: log.child({ toolName: tool.name, toolCallId }),
        organizationId: context.organizationId,
        userId: context.userId,
      };

      // Dispatch to appropriate tool function based on tool name
      let toolResult: ToolResult;

      // Substitute variables in parameters
      const resolvedParams = this.substituteVariables(tool.parameters || {}, context.variables);

      switch (tool.name) {
        case 'extract_function':
          toolResult = await executeExtractFunctionTool(
            resolvedParams as { filePath: string; startLine: number; endLine: number; functionName: string; dryRun?: boolean },
            toolCallId,
            toolContext
          );
          break;

        case 'rename_symbol':
          toolResult = await executeRenameSymbolTool(
            resolvedParams as { oldName: string; newName: string; files: string[]; symbolType?: 'function' | 'variable' | 'class' | 'any'; dryRun?: boolean },
            toolCallId,
            toolContext
          );
          break;

        case 'extract_variable':
          toolResult = await executeExtractVariableTool(
            resolvedParams as { filePath: string; line: number; startColumn: number; endColumn: number; variableName: string; dryRun?: boolean },
            toolCallId,
            toolContext
          );
          break;

        case 'heal_file':
          toolResult = await executeHealFileTool(
            resolvedParams as { filePath: string },
            toolCallId,
            toolContext
          );
          break;

        case 'generate_tests':
          toolResult = await executeGenerateTestsTool(
            resolvedParams as { filePath: string },
            toolCallId,
            toolContext
          );
          break;

        case 'detect_errors':
          toolResult = await executeDetectErrorsTool(
            resolvedParams as { filePath: string },
            toolCallId,
            toolContext
          );
          break;

        case 'validate_code':
          toolResult = await executeValidateCodeTool(
            resolvedParams as { filePaths: string[] },
            toolCallId,
            toolContext
          );
          break;

        case 'file_search':
          toolResult = await executeFileSearchTool(
            resolvedParams as { pattern: string; directory?: string },
            toolCallId,
            toolContext
          );
          break;

        case 'delete_file':
          toolResult = await executeDeleteFileTool(
            resolvedParams as { filePath: string },
            toolCallId,
            toolContext
          );
          break;

        case 'explore_codebase':
          toolResult = await executeExploreCodebaseTool(
            resolvedParams as { path?: string; maxDepth?: number },
            toolCallId,
            toolContext
          );
          break;

        default:
          // For tools not directly available, try to use chat request processor
          log.warn({ toolName: tool.name }, 'Tool not directly supported in workflow engine, attempting via chat request processor');
          toolResult = {
            tool_call_id: toolCallId,
            success: false,
            error: `Tool "${tool.name}" is not directly supported in workflow engine. Please use chat request processor for this tool.`,
          };
      }

      if (!toolResult.success) {
        log.error(
          { stepId: step.id, toolName: tool.name, error: toolResult.error },
          'Tool execution failed'
        );
        throw new Error(toolResult.error || 'Tool execution failed');
      }

      // Store result in context for use in subsequent steps
      context.variables[`${step.name}_result`] = toolResult.output;
      context.variables[`${tool.name}_result`] = toolResult.output;

      log.info(
        { stepId: step.id, toolName: tool.name, success: toolResult.success },
        'Tool step executed successfully'
      );

      return {
        toolName: tool.name,
        toolCallId,
        success: toolResult.success,
        output: toolResult.output,
        metadata: toolResult.metadata,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error(
        { stepId: step.id, toolName: tool.name, error: errorMessage },
        'Tool execution failed'
      );
      
      // Store error in context
      context.variables[`${step.name}_error`] = errorMessage;
      context.variables[`${tool.name}_error`] = errorMessage;

      throw error;
    }
  }

  /**
   * Substitute variables in parameters using {{variable}} syntax
   */
  private substituteVariables(
    params: Record<string, unknown>,
    variables: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        // Replace {{variable}} syntax — explicit replacer signature so the
        // callback args don't widen to `any` (String.prototype.replace types
        // the replacer with `...args: any[]` for back-compat).
        result[key] = value.replace(/\{\{(\w+)\}\}/g, (match: string, varName: string) => {
          return variables[varName] !== undefined ? String(variables[varName]) : match;
        });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recursively substitute in nested objects
        result[key] = this.substituteVariables(value as Record<string, unknown>, variables);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Execute condition step
   */
  private async executeConditionStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<boolean> {
    const condition = step.config.condition || 'true';
    
    try {
      // Safely evaluate condition with context variables
      const fn = new Function(
        ...Object.keys(context.variables),
        `return ${condition}`
      );
      return Boolean(fn(...Object.values(context.variables)));
    } catch (error) {
      log.warn(
        { stepId: step.id, condition, error: getErrorMessage(error) },
        'Condition evaluation failed'
      );
      return false;
    }
  }

  /**
   * Execute loop step
   */
  private async executeLoopStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<unknown[]> {
    const itemsVar = step.config.items || '';
    const itemsValue = context.variables[itemsVar];
    
    // Type guard: ensure items is an array
    const items: unknown[] = Array.isArray(itemsValue) ? itemsValue : [];
    const results: unknown[] = [];

    for (const item of items) {
      // Execute sub-steps with item in context
      const itemContext = { ...context, variables: { ...context.variables, _item: item } };
      
      for (const subStep of step.config.steps || []) {
        const result = await this.executeStepInternal(subStep, itemContext);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Execute parallel step
   */
  private async executeParallelStep(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<unknown[]> {
    const subSteps = step.config.steps || [];
    
    const results = await Promise.all(
      subSteps.map((subStep) => this.executeStepInternal(subStep, context))
    );

    return results;
  }

  /**
   * Execute sub-workflow
   */
  private async executeSubWorkflow(
    step: WorkflowStep,
    context: ExecutionContext
  ): Promise<unknown> {
    const subSteps = step.config.steps || [];
    const results: unknown[] = [];

    for (const subStep of subSteps) {
      const result = await this.executeStepInternal(subStep, context);
      results.push(result);
    }

    return results[results.length - 1];
  }

  /**
   * Build planning prompt for workflow generation
   */
  private buildPlanningPrompt(
    task: string,
    tools?: Array<{ name: string; description: string }>
  ): string {
    let prompt = `Create a detailed workflow plan for the following task:

TASK: ${task}

`;

    if (tools && tools.length > 0) {
      prompt += `AVAILABLE TOOLS:\n`;
      for (const tool of tools) {
        prompt += `- ${tool.name}: ${tool.description}\n`;
      }
      prompt += '\n';
    }

    prompt += `Create a workflow with clear steps. Output JSON in this format:
{
  "name": "Workflow name",
  "description": "Brief description",
  "steps": [
    {
      "id": "step_1",
      "name": "Step name",
      "type": "llm_call|tool_call|condition|loop|parallel",
      "config": {
        "prompt": "For LLM calls",
        "tools": ["For tool calls"],
        "condition": "For conditions"
      },
      "dependencies": ["step_ids that must complete first"]
    }
  ]
}

Keep the workflow focused and efficient. Use 3-7 steps.`;

    return prompt;
  }

  /**
   * Parse workflow plan from LLM response
   */
  private parseWorkflowPlan(content: string, task: string): WorkflowDefinition {
    try {
      // Extract JSON from response
      let jsonStr = content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        jsonStr = jsonObjectMatch[0];
      }

      // JSON.parse returns `unknown` — narrow each accessed field structurally
      // so we only forward fields we can prove are well-typed.
      const parsed: unknown = JSON.parse(jsonStr);
      const parsedObj: { name?: unknown; description?: unknown; steps?: unknown } =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { name?: unknown; description?: unknown; steps?: unknown })
          : {};
      const parsedName = typeof parsedObj.name === 'string' ? parsedObj.name : 'Generated Workflow';
      const parsedDesc = typeof parsedObj.description === 'string' ? parsedObj.description : task.substring(0, 100);
      const parsedSteps: unknown[] = Array.isArray(parsedObj.steps) ? parsedObj.steps : [];

      const workflow: WorkflowDefinition = {
        id: `wf_def_${nanoid(12)}`,
        name: parsedName,
        description: parsedDesc,
        version: '1.0.0',
        steps: parsedSteps.map((rawStep, index): WorkflowDefinition['steps'][number] => {
          const step: Record<string, unknown> =
            typeof rawStep === 'object' && rawStep !== null
              ? (rawStep as Record<string, unknown>)
              : {};
          return {
            id: typeof step.id === 'string' ? step.id : `step_${index + 1}`,
            name: typeof step.name === 'string' ? step.name : `Step ${index + 1}`,
            type: typeof step.type === 'string' ? (step.type as WorkflowDefinition['steps'][number]['type']) : 'llm_call',
            config: typeof step.config === 'object' && step.config !== null
              ? (step.config as Record<string, unknown>)
              : {},
            dependencies: Array.isArray(step.dependencies)
              ? step.dependencies.filter((dep): dep is string => typeof dep === 'string')
              : [],
          };
        }),
      };

      return workflow;
    } catch (error) {
      log.warn(
        { error: getErrorMessage(error) },
        'Failed to parse workflow plan, using default'
      );

      // Return simple single-step workflow as fallback
      return {
        id: `wf_def_${nanoid(12)}`,
        name: 'Simple Task Workflow',
        description: task.substring(0, 100),
        version: '1.0.0',
        steps: [
          {
            id: 'main',
            name: 'Execute Task',
            type: 'llm_call',
            config: {
              prompt: task,
            },
          },
        ],
      };
    }
  }

  /**
   * Interpolate template string with context variables
   */
  private interpolateTemplate(
    template: string,
    variables: Record<string, unknown>
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string) => {
      const value = variables[key];
      return value !== undefined ? String(value) : `{{${key}}}`;
    });
  }

  /**
   * Checkpoint workflow state to DB for crash recovery.
   * Non-blocking — failures are logged but don't interrupt execution.
   */
  private async checkpoint(
    executionId: string,
    workflow: WorkflowDefinition,
    context: ExecutionContext,
    stepResults: StepResult[]
  ): Promise<void> {
    const serializedResults = stepResults.map((r) => ({
      stepId: r.stepId,
      status: r.status,
      durationMs: r.durationMs,
      cost: r.cost,
      tokensUsed: r.tokensUsed,
      retries: r.retries,
      error: r.error,
      // Omit output to keep serialization small
    }));

    await prisma.$executeRaw`
      INSERT INTO workflow_executions (
        id, workflow_id, organization_id, user_id,
        status, current_step_idx, total_steps,
        variables, step_results, updated_at
      ) VALUES (
        ${executionId}::uuid, ${workflow.id}, ${context.organizationId}::uuid,
        ${context.userId ?? null}::uuid,
        'running', ${context.stepsExecuted}, ${workflow.steps.length},
        ${JSON.stringify(context.variables)}::jsonb,
        ${JSON.stringify(serializedResults)}::jsonb,
        NOW()
      )
      ON CONFLICT (id) DO UPDATE
        SET
          current_step_idx = EXCLUDED.current_step_idx,
          variables = EXCLUDED.variables,
          step_results = EXCLUDED.step_results,
          updated_at = NOW()
    `;
  }

  /**
   * Finalize workflow state in DB.
   */
  async finalizeCheckpoint(
    executionId: string,
    status: 'completed' | 'failed' | 'timeout' | 'cancelled',
    error?: string
  ): Promise<void> {
    try {
      await prisma.$executeRaw`
        UPDATE workflow_executions
        SET status = ${status},
            error = ${error ?? null},
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${executionId}::uuid
      `;
    } catch (err) {
      log.warn({ error: getErrorMessage(err), executionId }, 'Workflow finalize checkpoint failed');
    }
  }
}

/**
 * Singleton instance
 */
let workflowEngineInstance: AgenticWorkflowEngine | null = null;

/**
 * Get workflow engine instance
 */
export function getAgenticWorkflowEngine(): AgenticWorkflowEngine {
  if (!workflowEngineInstance) {
    workflowEngineInstance = new AgenticWorkflowEngine();
  }
  return workflowEngineInstance;
}

