// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `ToolRegistration.strategyExecutionMode` — media-generation-delegation
 * plan, PR2.
 *
 * A plain data field with no logic of its own in `tool-registry.ts` — the
 * actual auto-execution GATE lives in `executeModelWithTools`
 * (base-strategy.ts, see execute-model-with-tools-quorum.test.ts). This
 * suite pins the two things that DO live here:
 *   - the field round-trips through register()/get() like any other, and
 *   - it is orthogonal to `safeForStrategies` / `isAutoRecommendable()`: a
 *     `strategyExecutionMode:'quorumOnly'` tool does NOT become
 *     auto-recommendable or strategy-listed just by having that field set —
 *     `safeForStrategies:false` still governs those, exactly as documented
 *     on the field itself. Getting this wrong would let a billable
 *     generation tool get auto-attached by triage to a request that never
 *     asked for it.
 */
import { describe, expect, it } from 'vitest';
import { isAutoRecommendable, toolRegistry, type ToolRegistration } from '../tool-registry';

const noopHandler: ToolRegistration['handler'] = async (_args, toolCallId) => ({
  tool_call_id: toolCallId,
  success: true,
});

function tool(overrides: Partial<ToolRegistration>): ToolRegistration {
  return {
    name: 'fixture_strategy_execution_mode_tool',
    description: 'fixture tool',
    category: 'general',
    safeForStrategies: true,
    handler: noopHandler,
    ...overrides,
  };
}

describe('ToolRegistration.strategyExecutionMode', () => {
  it('round-trips through register()/get() when set to "quorumOnly"', () => {
    const registration = tool({
      name: 'fixture_quorum_only_tool',
      category: 'video',
      safeForStrategies: false,
      strategyExecutionMode: 'quorumOnly',
    });
    toolRegistry.register(registration);
    expect(toolRegistry.get('fixture_quorum_only_tool')?.strategyExecutionMode).toBe('quorumOnly');
  });

  it('is undefined when not set, for an ordinary safeForStrategies:true tool', () => {
    const registration = tool({ name: 'fixture_plain_safe_tool', safeForStrategies: true });
    toolRegistry.register(registration);
    expect(toolRegistry.get('fixture_plain_safe_tool')?.strategyExecutionMode).toBeUndefined();
  });

  it('round-trips "never"', () => {
    const registration = tool({
      name: 'fixture_never_tool',
      safeForStrategies: true,
      strategyExecutionMode: 'never',
    });
    toolRegistry.register(registration);
    expect(toolRegistry.get('fixture_never_tool')?.strategyExecutionMode).toBe('never');
  });

  it('does NOT make a safeForStrategies:false tool auto-recommendable, even with strategyExecutionMode:"quorumOnly" and an external category', () => {
    // isAutoRecommendable's hard precondition is safeForStrategies — a
    // quorumOnly tool is deliberately NOT unconditionally safe, so it must
    // stay un-auto-attachable by triage regardless of category or
    // strategyExecutionMode. This is the same invariant
    // tool-registry-auto-recommendable.test.ts pins for the boolean alone;
    // here it's re-checked with the new field present to catch a future
    // change that accidentally couples the two.
    const quorumOnlyVideoTool = tool({
      category: 'video',
      safeForStrategies: false,
      strategyExecutionMode: 'quorumOnly',
    });
    expect(isAutoRecommendable(quorumOnlyVideoTool)).toBe(false);
  });

  it('does not implicitly grant safeForStrategies:true — listStrategyTools() still excludes a quorumOnly, safeForStrategies:false tool', () => {
    const registration = tool({
      name: 'fixture_quorum_only_not_listed',
      category: 'video',
      safeForStrategies: false,
      strategyExecutionMode: 'quorumOnly',
    });
    toolRegistry.register(registration);
    const listed = toolRegistry.listStrategyTools().map((t) => t.name);
    expect(listed).not.toContain('fixture_quorum_only_not_listed');
  });
});
