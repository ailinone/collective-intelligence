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
  context: ToolExecutionContext
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
  category:
    | 'file'
    | 'git'
    | 'search'
    | 'code'
    | 'refactoring'
    | 'testing'
    | 'task'
    | 'analysis'
    | 'workflow'
    | 'web'
    | 'image'
    | 'video'
    | 'audio'
    | 'general';
  /** Whether this tool is safe for use within orchestration strategies */
  safeForStrategies: boolean;
  /**
   * Auto-execution policy for a strategy's tool-calling loop
   * (`executeModelWithTools` in base-strategy.ts) — INDEPENDENT of
   * `safeForStrategies`, which governs whether the tool is offered to a
   * strategy participant at all, triage-auto-attach eligibility, and the
   * shared `executeForStrategy()` gate used elsewhere.
   *
   *  - omitted: no extra restriction beyond `safeForStrategies` — a
   *    `safeForStrategies:true` tool keeps auto-executing unconditionally,
   *    exactly as before this field existed.
   *  - `'quorumOnly'`: `executeModelWithTools` may auto-execute this call
   *    ONLY when a strict majority of the collective's voters independently
   *    proposed the exact same call (name + args), per
   *    `computeQuorumToolCall()` (`core/aggregation/response-aggregator.ts`
   *    — the SAME mechanism the response aggregator itself uses, not a
   *    parallel one). Used for billable/slow generation tools
   *    (`generate_video`, `generate_media`) so a single hallucinating voter
   *    can never trigger a real generation. Such a tool is typically ALSO
   *    `safeForStrategies:false` — quorum is the ONLY path to
   *    auto-execution, not an additional one alongside an unconditional one.
   *  - `'never'`: reserved for a tool that must never auto-execute inside a
   *    strategy's tool-calling loop, regardless of `safeForStrategies` or
   *    quorum. Not currently assigned to any tool.
   */
  strategyExecutionMode?: 'never' | 'quorumOnly';
  /**
   * Whether the TRIAGE LLM may AUTO-ATTACH this tool to a request that never
   * asked for tools.
   *
   * Omit to accept the structural default: auto-recommendable iff
   * `safeForStrategies` AND the category's effects are external or sandboxed
   * (`AUTO_RECOMMENDABLE_CATEGORIES`). Set it explicitly to opt a tool in
   * (e.g. `code_execute`, whose category is `code` but whose effects are
   * sandboxed) or to force one out.
   *
   * This replaced a hardcoded three-name allowlist (LOTE AO, 2026-09-05):
   * the registry is dynamic — plugins, strategies and MCP servers register
   * into it — so a literal name list could never describe it, and any tool
   * added after the list was written was silently un-recommendable.
   */
  autoRecommendable?: boolean;
  /** The handler function */
  handler: ToolHandler;
}

/**
 * Categories whose effects are EXTERNAL (the public web) or SANDBOXED, and
 * therefore safe for the triage LLM to auto-attach.
 *
 * Everything else — `file`, `search`, `code`, `git`, `refactoring`,
 * `testing`, `analysis`, `task`, `workflow`, `general` — touches the
 * server's own filesystem or codebase. Security review finding: letting
 * triage auto-attach those would let any "read file X and show me" prompt
 * legitimately induce server filesystem reads on a request whose client
 * never asked for tools.
 */
const AUTO_RECOMMENDABLE_CATEGORIES: ReadonlySet<ToolRegistration['category']> = new Set([
  'web',
  'image',
  'video',
  'audio',
]);

/**
 * Whether a category's effects stay OFF the API server's own filesystem,
 * codebase and shell (the same `AUTO_RECOMMENDABLE_CATEGORIES` rule, without
 * the triage-only `autoRecommendable` override). Direct-execution HTTP
 * surfaces use it to decide which tools an ordinary tenant may run and which
 * need a platform admin.
 */
export function isExternalEffectCategory(category: ToolRegistration['category']): boolean {
  return AUTO_RECOMMENDABLE_CATEGORIES.has(category);
}

/**
 * The structural rule. `safeForStrategies` is a hard precondition — a tool
 * the strategies may not run is never a tool triage may attach.
 */
export function isAutoRecommendable(reg: ToolRegistration): boolean {
  if (!reg.safeForStrategies) return false;
  if (typeof reg.autoRecommendable === 'boolean') return reg.autoRecommendable;
  return AUTO_RECOMMENDABLE_CATEGORIES.has(reg.category);
}

/**
 * Tools that must never be auto-executed on the server on behalf of a tenant
 * request. The SINGLE source of truth for both chat-completions tool-call
 * layers:
 *
 *  - layer 2, `chat-request-processor.ts` (`executeToolCallsAutomatically` /
 *    `executeRealTool`): the post-orchestration auto-dispatch of the final
 *    response's `tool_calls`;
 *  - layer 1, `base-strategy.ts` `executeModelWithTools` (the tool loop ~21
 *    strategies share) and `strategy-tool-executor.ts`
 *    `executeToolForStrategy`, via `isBlockedFromStrategyAutoExecution()`
 *    below.
 *
 * Every tenant API key reaches both layers with no role check, unlike the
 * admin/owner-gated `/v1/tools/*` routes these operations were designed for.
 *
 * SECURITY (2026-07-29): the first group is every tool registered
 * `safeForStrategies: false` (registerToolsInRegistry in
 * chat-request-processor.ts). Kept as an explicit list, rather than only
 * relying on `executeForStrategy()`, so the pre-registry-boot switch fallback
 * in `executeRealTool` is covered too, since it has no registration object to
 * consult.
 */
export const CHAT_AUTO_EXECUTE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'delete_file',
  'git_commit',
  'git_push',
  'git_pull',
  'git_create_branch',
  'git_merge',
  'git_rebase',
  'git_resolve_conflict',
  'todo_write',
  'create_todo',
  'update_todo',
  'execute_workflow',
  'register_workflow',

  // SECURITY (2026-09-23): these ARE registered `safeForStrategies: true`,
  // but the /v1/tools/* routes that expose them directly gate the entire
  // surface to admin/owner (tools-routes.ts), and a caller can force the
  // tool_call deterministically by supplying its own `tools`/`tool_choice` in
  // the request body. Filesystem-mutation tools and the vision tools (SSRF
  // risk: they fetch caller-supplied image URLs) must not auto-dispatch on a
  // tenant request even though the registry considers them strategy-safe.
  'write_file',
  'search_replace',
  'rename_symbol',
  'extract_function',
  'extract_variable',
  'inline_function',
  'refactor_code',
  'heal_file',
  'analyze_image',
  'compare_images',
  'extract_code_from_screenshot',

  // SECURITY (2026-09-25, issue #664 finding 1): these READ tools are
  // registered `safeForStrategies: true` and category `file`/`search`/
  // `analysis` — none of them auto-recommendable (not in
  // AUTO_RECOMMENDABLE_CATEGORIES, no explicit opt-in), so adding them here
  // changes nothing about triage auto-attach and only closes the same
  // client-forced-tool_choice hole #653 closed for the write/mutate tools.
  // Without this, any tenant key could force e.g. `read_file`/`grep_search`
  // via its own `tools`/`tool_choice` and have it auto-execute against the
  // API container's own working directory, reading the server's source tree
  // — not the tenant's data. The chat product's Open Terminal feature uses
  // these SAME names for a client-side tool the CLIENT executes; a call by
  // that name arriving in `request.tools` must come back unexecuted exactly
  // like any other client-owned tool_call, not be hijacked and run here.
  'read_file',
  'grep_search',
  'explore_codebase',
  'list_directory',
  'file_search',
  'analyze_codebase',
]);

/**
 * Layer-1 gate: whether a strategy's own tool loop must refuse to run this
 * tool call on the server.
 *
 * A strategy sees `request.tools` from exactly two sources: the CLIENT, or
 * triage's `applyRecommendedTools` (orchestration-engine.ts), which only
 * ever attaches tools `isAutoRecommendable()` admits and only when the client
 * sent none. So a blocklisted tool that is auto-recommendable (the vision
 * tools today) may still be a legitimate triage attachment and keeps
 * executing, while every other blocklisted name (write_file, the refactoring
 * tools, heal_file, and all `safeForStrategies:false` tools) can only have
 * come from the client, and is refused.
 *
 * The canonical `reg.name` is checked as well as the called name so an alias
 * of a blocked tool cannot slip past the name-keyed list.
 */
export function isBlockedFromStrategyAutoExecution(
  toolName: string,
  reg: ToolRegistration | undefined
): boolean {
  const blocked =
    CHAT_AUTO_EXECUTE_BLOCKED_TOOLS.has(toolName) ||
    (reg !== undefined && CHAT_AUTO_EXECUTE_BLOCKED_TOOLS.has(reg.name));
  if (!blocked) return false;
  return !(reg !== undefined && isAutoRecommendable(reg));
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
    log.debug(
      {
        tool: registration.name,
        category: registration.category,
        safeForStrategies: registration.safeForStrategies,
      },
      'Tool registered'
    );
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
    context: ToolExecutionContext
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
      log.error(
        { tool: name, error: err instanceof Error ? err.message : String(err) },
        'Tool execution error'
      );
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
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const registration = this.tools.get(name);
    if (!registration) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Tool "${name}" not found in registry.`,
      };
    }
    if (!registration.safeForStrategies) {
      return {
        tool_call_id: toolCallId,
        success: false,
        error: `Tool "${name}" is not permitted within strategy execution (safety restriction).`,
      };
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
    return tools.map((t) => `${t.name} (${t.category}): ${t.description}`).join('\n');
  }

  /**
   * Tools the TRIAGE LLM may auto-attach — derived from the registry itself
   * via `isAutoRecommendable`, NOT from a name list. The security invariant
   * is unchanged (never the server's own filesystem/codebase); what changed
   * is that it is now expressed as a property of each registration, so a
   * newly registered web/image/sandboxed tool participates automatically and
   * a newly registered filesystem tool still cannot.
   */
  listTriageRecommendableTools(): ToolRegistration[] {
    return this.listStrategyTools().filter(isAutoRecommendable);
  }

  /**
   * Catalog shown to the TRIAGE LLM for automatic tool recommendation — the
   * auto-recommendable subset, NOT the full strategy-safe set.
   * `safeForStrategies` includes server-filesystem tools (read_file,
   * write_file, grep_search, ...); letting triage auto-attach those to
   * requests that never asked for tools would let any "read file X and show
   * me" style prompt legitimately induce server filesystem reads. The rest
   * remain available when the CLIENT explicitly supplies them.
   */
  describeTriageRecommendableToolsForPrompt(): string {
    const tools = this.listTriageRecommendableTools();
    if (tools.length === 0) return 'None available';
    return tools.map((t) => `${t.name} (${t.category}): ${t.description}`).join('\n');
  }

  /** Get count of unique tools. */
  size(): number {
    return this.listNames().length;
  }

  /**
   * Distinct tool categories currently registered, system-wide — sorted,
   * deduplicated, derived live from the registry (NOT a hardcoded list).
   *
   * Used by execution-system-prompt.ts's system-capability-manifest section
   * to tell an executing model what KINDS of tools exist elsewhere in the
   * system, without hardcoding tool names that would drift as tools are
   * added, renamed, or removed (the same "documentation says X, code does Y"
   * drift class this session has hit repeatedly elsewhere). Naturally
   * excludes any category from the `ToolRegistration['category']` union that
   * has zero tools registered against it right now (e.g. 'audio' — TTS/STT
   * is real but exposed via `CapabilityInvoker`, not a callable chat tool),
   * which is itself accurate signal, not a gap.
   *
   * Empty only if `registerToolsInRegistry()` has not run yet (e.g. a unit
   * test importing this module directly without bootstrapping the app).
   */
  listCategories(): ToolRegistration['category'][] {
    const categories = new Set<ToolRegistration['category']>();
    for (const [, reg] of this.tools) {
      categories.add(reg.category);
    }
    return [...categories].sort();
  }

  /** Mark as initialized (called after all tools registered). */
  markInitialized(): void {
    this.initialized = true;
    log.info(
      { toolCount: this.size(), strategyTools: this.listStrategyTools().length },
      'Tool registry initialized'
    );
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/** Singleton tool registry instance. */
export const toolRegistry = new ToolRegistryImpl();

/** Convenience export for getting a handler (used by strategy-tool-executor). */
export function getToolExecutor(name: string): ToolHandler | undefined {
  return toolRegistry.getHandler(name);
}
