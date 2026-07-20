// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Agentic Strategy
 *
 * Meta-strategy that plans and executes multi-step workflows autonomously.
 * Uses a planning model to generate a WorkflowDefinition (DAG of steps),
 * then executes each step using tools, LLM calls, and conditions.
 *
 * This bridges orchestration strategies with the Agentic Workflow Engine,
 * enabling strategies that ACT (read files, write code, run tests) not just THINK.
 *
 * Flow:
 *   1. Planner generates a workflow (JSON DAG of steps)
 *   2. Each step executes: llm_call (via model), tool_call (via Tool Registry), or condition
 *   3. Steps respect dependencies (topological execution)
 *   4. Final step's output becomes the response
 *
 * Best for: complex multi-step tasks (refactoring, project setup, analysis + execution).
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import { PROMPTS } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
} from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'agentic-strategy' });
const TIMEOUT_MS = Number(process.env.AGENTIC_TIMEOUT_MS ?? 180000);
const MAX_STEPS = Number(process.env.AGENTIC_MAX_STEPS ?? 10);

interface WorkflowStep {
  id: string;
  type: 'llm_call' | 'tool_call';
  tool?: string;
  args?: Record<string, unknown>;
  prompt?: string;
  depends_on: string[];
}

export class AgenticStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'agentic',
      name: 'agentic',
      displayName: 'Agentic Execution',
      description:
        'Autonomous multi-step execution: plans a workflow, executes tools and LLM calls in dependency order. For complex tasks requiring action, not just analysis.',
      minModels: 1,
      maxModels: 3,
      estimatedCostMultiplier: 5.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 5.0,
      suitableFor: ['code-generation', 'refactoring', 'debugging', 'testing', 'documentation'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Agentic timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 1) throw new Error('Agentic strategy requires at least 1 model');

    // Caminho-C Q2 cross-strategy honor: pin biases the planner/executor
    // slot. Agentic uses the same model for planning + execution, so the
    // pin (when present) drives the entire workflow.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Agentic: requested model not in operational pool — falling back to quality-sorted planner',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    // Single-candidate-bail bug fix: walk `sorted` to find a planner with
    // an operational adapter rather than hard-failing on sorted[0]. A
    // partial-coverage outage on the highest-quality model used to kill
    // the strategy before it could plan; now degrades through the pool.
    // `planner` and `executor` were const before — promoted to `let` so
    // the rebind is visible to all later phases (executor reuses planner
    // by design — same model plans and executes).
    let planner = sorted[0];
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    let plannerAdapter = await this.getAdapterForModel(planner, context);
    if (!plannerAdapter) {
      for (let i = 1; i < sorted.length; i++) {
        const candidate = sorted[i];
        const adapter = await this.getAdapterForModel(candidate, context);
        if (adapter) {
          log.warn(
            { requestId: context.requestId, primary: sorted[0].name, fallback: candidate.name },
            'Agentic planner: primary had no adapter, using fallback from sorted pool'
          );
          planner = candidate;
          plannerAdapter = adapter;
          break;
        }
      }
    }
    if (!plannerAdapter) throw new Error('No operational planner in candidate pool');
    const executor = planner; // Same model plans and executes
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    this.emitObserverEvent(context, { type: 'phase_start', models: [planner.name || planner.id], summary: 'Agentic: planning workflow.' });

    // Phase 1: Plan the workflow
    const planReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.agenticPlanner },
        ...request.messages,
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.2,
    };
    // executeModelWithRetry handles cross-provider failover when the
    // planner call itself fails (rate-limit, 5xx, timeout). Adapter-null
    // failover above (walk-through-sorted) handles the structural case
    // where the highest-quality model has no operational adapter at all.
    const planExec = await this.executeModelWithRetry(plannerAdapter, planner, planReq, 'planner', context);
    executions.push(planExec);

    // Parse workflow
    let steps: WorkflowStep[] = [];
    try {
      const content = planExec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string') {
        // JSON.parse returns `unknown`. Either shape: { steps: [...] } or
        // bare [...]. Filter out non-objects so the typed array stays clean.
        const parsed: unknown = JSON.parse(content);
        const rawSteps: unknown[] = Array.isArray(parsed)
          ? parsed
          : (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { steps?: unknown }).steps)
              ? (parsed as { steps: unknown[] }).steps
              : []);
        steps = rawSteps.filter(
          (s): s is WorkflowStep =>
            typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string',
        );
      }
    } catch {
      log.warn('Failed to parse workflow plan');
    }

    if (steps.length === 0) {
      // Fallback: direct execution without workflow
      const directExec = await this.executeModelWithTools(plannerAdapter, planner, request, 'primary');
      executions.push(directExec);
      return {
        finalResponse: directExec.response,
        strategyUsed: 'agentic',
        modelsUsed: executions,
        totalCost: executions.reduce((s, e) => s + e.cost, 0),
        totalDuration: Date.now() - startTime,
        metadata: { strategy: 'agentic', steps: 0, fallback: true },
      };
    }

    // Cap steps
    if (steps.length > MAX_STEPS) steps = steps.slice(0, MAX_STEPS);

    this.emitObserverEvent(context, {
      type: 'round_complete', round: 1, totalRounds: steps.length + 2,
      summary: `Workflow planned: ${steps.length} steps.`,
    });

    // Phase 2: Execute workflow steps in topological order
    const stepResults = new Map<string, string>();
    const completed = new Set<string>();
    let lastOutput = '';

    let iteration = 0;
    while (completed.size < steps.length && iteration < steps.length + 1) {
      iteration++;

      const ready = steps.filter(s => !completed.has(s.id) && s.depends_on.every(d => completed.has(d)));
      if (ready.length === 0) break;

      for (const step of ready) {
        // Resolve template variables: {{s1.output}} → actual output
        let resolvedPrompt = step.prompt || '';
        let resolvedArgs = step.args ? { ...step.args } : {};

        for (const [id, result] of stepResults) {
          const pattern = `{{${id}.output}}`;
          resolvedPrompt = resolvedPrompt.replace(pattern, result);
          for (const [key, val] of Object.entries(resolvedArgs)) {
            if (typeof val === 'string') {
              resolvedArgs[key] = val.replace(pattern, result);
            }
          }
        }

        if (step.type === 'tool_call' && step.tool) {
          // Execute tool via Tool Registry
          try {
            const { executeToolForStrategy } = await import('@/services/strategy-tool-executor');
            const toolResult = await executeToolForStrategy(
              { id: step.id, type: 'function', function: { name: step.tool, arguments: JSON.stringify(resolvedArgs) } },
              log,
            );
            const output = toolResult.success ? (toolResult.output || '') : (toolResult.error || 'Tool failed');
            stepResults.set(step.id, output);
            lastOutput = output;
          } catch (err) {
            stepResults.set(step.id, `Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (step.type === 'llm_call') {
          // Execute LLM call with reasoning + tool support
          const llmReq: ChatRequest = {
            ...request,
            messages: [
              { role: 'user', content: resolvedPrompt || `Execute step ${step.id}: ${originalQ}` },
            ],
          };
          const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
          const reasoningEnabled = this.isReasoningEnabled(request);
          // Default branch uses executeModelWithRetry for cross-provider
          // failover on per-step execution failure. With-tools and
          // with-reasoning branches stay on their dedicated helpers —
          // they have specialized response-shape handling that retry
          // doesn't currently wrap.
          const exec = hasTools
            ? await this.executeModelWithTools(plannerAdapter, executor, llmReq, 'executor')
            : reasoningEnabled
              ? await this.executeModelWithReasoning(plannerAdapter, executor, llmReq, 'executor')
              : await this.executeModelWithRetry(plannerAdapter, executor, llmReq, 'executor', context);
          executions.push(exec);

          const output = exec.response?.choices?.[0]?.message?.content;
          const outputStr = typeof output === 'string' ? output : '';
          stepResults.set(step.id, outputStr);
          lastOutput = outputStr;
        }

        completed.add(step.id);
      }

      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: iteration + 1,
        totalRounds: steps.length + 2,
        summary: `Step ${iteration}: ${ready.map(s => `${s.type}:${s.tool || 'llm'}`).join(', ')} — ${completed.size}/${steps.length} complete.`,
      });
    }

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Agentic workflow complete: ${completed.size} steps executed.` });

    // Build final response from last step output
    const finalResponse: ChatResponse = {
      id: `agentic-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: executor.name || 'agentic',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: lastOutput || 'Workflow completed but produced no output.' },
        finish_reason: 'stop',
        logprobs: null,
      }],
    };

    return {
      finalResponse,
      strategyUsed: 'agentic',
      modelsUsed: executions,
      totalCost: executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      metadata: {
        strategy: 'agentic',
        stepsPlanned: steps.length,
        stepsCompleted: completed.size,
        stepTypes: steps.map(s => s.type),
        stepResults: Object.fromEntries(stepResults),
        ...(this.isReasoningEnabled(request) && executions.some(e => e.reasoning)
          ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  // Intentionally buffered, not real per-token streaming (audited
  // 2026-07-11 alongside the other 12 strategies): the planner decides
  // the step graph (count, type, dependency order) at runtime, and the
  // final response is `lastOutput` — whichever step happens to finish
  // last in topological order. That step may be a tool_call (not an LLM
  // generation at all), so there is no fixed "final synthesis call" to
  // stream tokens from until planning + execution finish.
  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Agentic: planning and executing workflow.' });
    yield this.progressChunk('Planning workflow...', 0, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const result = await this.execute(request, context);
    const stepsCompleted = (result.metadata as { stepsCompleted?: number }).stepsCompleted ?? 0;

    yield this.progressChunk(`${stepsCompleted} steps executed.`, 2, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    yield result.finalResponse;

    for (const c of await this.drainObserverChunks(context)) yield c;
  }
}
