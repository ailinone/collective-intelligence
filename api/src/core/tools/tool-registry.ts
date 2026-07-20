// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool Registry — Centralized, dynamic tool registration and execution.
 *
 * Replaces the 300+ line switch statement in chat-request-processor.ts with
 * a registry pattern that allows:
 * - Dynamic tool registration (plugins, MCPs, strategies can add tools)
 * - Shared execution between chat processor and orchestration strategies
 * - Tool metadata (description, parameters, capabilities) for model tool_choice
 * - Tool categories for scoping (e.g., strategies only get safe tools)
 *
 * Usage:
 *   import { toolRegistry } from '@/core/tools/tool-registry';
 *   toolRegistry.register({ name: 'web_search', handler: myHandler, ... });
 *   const result = await toolRegistry.execute('web_search', args, context);
 */

import type { ToolResult, ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'tool-registry' });

/** Handler function that executes a tool with parsed arguments. */
export type ToolHandler = (
  args: Record<string, unknown>,
  toolCallId: string,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

/** Tool metadata for registration. */
export interface ToolRegistration {
  /** Unique tool name (e.g., 'web_search', 'read_file') */
  name: string;
  /** Alternative names that resolve to this tool */
  aliases?: string[];
  /** Human-readable description */
  description: string;
  /** JSON Schema for parameters */
  parameters?: Record<string, unknown>;
  /** Tool category for scoping */
  category: 'file' | 'git' | 'search' | 'code' | 'refactoring' | 'testing' | 'task' | 'analysis' | 'workflow' | 'web' | 'image' | 'video' | 'audio' | 'general';
  /** Whether this tool is safe for use within orchestration strategies */
  safeForStrategies: boolean;
  /** The handler function */
  handler: ToolHandler;
}

/**
 * Central tool registry.
 * All tool implementations register here. Both chat-request-processor
 * and strategy-tool-executor consume from the same registry.
 */
class ToolRegistryImpl {
  private tools = new Map<string, ToolRegistration>();
  private initialized = false;

  /** Register a tool. Overwrites if name already exists. */
  register(registration: ToolRegistration): void {
    this.tools.set(registration.name, registration);
    // Register aliases
    if (registration.aliases) {
      for (const alias of registration.aliases) {
        this.tools.set(alias, registration);
      }
    }
    log.debug({ tool: registration.name, category: registration.category, safeForStrategies: registration.safeForStrategies }, 'Tool registered');
  }

  /** Register multiple tools at once. */
  registerAll(registrations: ToolRegistration[]): void {
    for (const reg of registrations) {
      this.register(reg);
    }
  }

  /** Get a tool handler by name. Returns undefined if not found. */
  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  /** Get a tool registration by name. */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Execute a tool by name. */
  async execute(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const registration = this.tools.get(name);
    if (!registration) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Tool "${name}" not found. Available: ${this.listNames().join(', ')}`,
      };
    }

    try {
      return await registration.handler(args, toolCallId, context);
    } catch (err) {
      log.error({ tool: name, error: err instanceof Error ? err.message : String(err) }, 'Tool execution error');
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Tool "${name}" execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Execute a tool, but only if it's marked safe for strategies. */
  async executeForStrategy(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const registration = this.tools.get(name);
    if (!registration) {
      return { tool_call_id: toolCallId, success: false, error: `Tool "${name}" not found in registry.` };
    }
    if (!registration.safeForStrategies) {
      return { tool_call_id: toolCallId, success: false, error: `Tool "${name}" is not permitted within strategy execution (safety restriction).` };
    }
    return this.execute(name, args, toolCallId, context);
  }

  /** List all registered tool names. */
  listNames(): string[] {
    // Deduplicate (aliases point to same registration)
    const unique = new Set<string>();
    for (const [, reg] of this.tools) {
      unique.add(reg.name);
    }
    return [...unique];
  }

  /** List tools by category. */
  listByCategory(category: ToolRegistration['category']): ToolRegistration[] {
    const seen = new Set<string>();
    const result: ToolRegistration[] = [];
    for (const [, reg] of this.tools) {
      if (reg.category === category && !seen.has(reg.name)) {
        seen.add(reg.name);
        result.push(reg);
      }
    }
    return result;
  }

  /** List tools safe for strategy execution. */
  listStrategyTools(): ToolRegistration[] {
    const seen = new Set<string>();
    const result: ToolRegistration[] = [];
    for (const [, reg] of this.tools) {
      if (reg.safeForStrategies && !seen.has(reg.name)) {
        seen.add(reg.name);
        result.push(reg);
      }
    }
    return result;
  }

  /**
   * Serialize the strategy-safe tool catalog as `name (category): description`
   * lines, for embedding in an LLM prompt.
   */
  describeStrategyToolsForPrompt(): string {
    const tools = this.listStrategyTools();
    if (tools.length === 0) return 'None available';
    return tools
      .map((t) => `${t.name} (${t.category}): ${t.description}`)
      .join('\n');
  }

  /**
   * Catalog shown to the TRIAGE LLM for automatic tool recommendation —
   * strictly the TRIAGE_RECOMMENDABLE_TOOLS allowlist, NOT the full
   * strategy-safe set. Security review finding: safeForStrategies includes
   * server-filesystem tools (read_file, write_file, grep_search, ...);
   * letting triage auto-attach those to requests that never asked for tools
   * would let any "read file X and show me" style prompt legitimately induce
   * server filesystem reads. Auto-recommendation is limited to tools whose
   * effects are external or sandboxed; the rest remain available when the
   * CLIENT explicitly supplies them.
   */
  describeTriageRecommendableToolsForPrompt(): string {
    const tools = this.listStrategyTools().filter((t) => TRIAGE_RECOMMENDABLE_TOOLS.has(t.name));
    if (tools.length === 0) return 'None available';
    return tools
      .map((t) => `${t.name} (${t.category}): ${t.description}`)
      .join('\n');
  }

  /** Get count of unique tools. */
  size(): number {
    return this.listNames().length;
  }

  /** Mark as initialized (called after all tools registered). */
  markInitialized(): void {
    this.initialized = true;
    log.info({ toolCount: this.size(), strategyTools: this.listStrategyTools().length }, 'Tool registry initialized');
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Tools the TRIAGE LLM may auto-attach to a request that did not ask for
 * tools. Inclusion criteria: effects are external (web) or sandboxed
 * (code-sandbox) — never the server's own filesystem/codebase. Tools outside
 * this set stay usable only when the client explicitly sends them in
 * `request.tools`.
 */
export const TRIAGE_RECOMMENDABLE_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'code_execute',
  'analyze_image',
]);

/** Singleton tool registry instance. */
export const toolRegistry = new ToolRegistryImpl();

/** Convenience export for getting a handler (used by strategy-tool-executor). */
export function getToolExecutor(name: string): ToolHandler | undefined {
  return toolRegistry.getHandler(name);
}
