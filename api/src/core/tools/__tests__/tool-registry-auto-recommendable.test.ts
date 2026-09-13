// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * tool-registry-auto-recommendable.test.ts — LOTE AO (2026-09-05)
 *
 * `recommended_tools` used to be bounded by `TRIAGE_RECOMMENDABLE_TOOLS`, a
 * hardcoded set of three literal names sitting on top of a registry that is
 * explicitly dynamic (plugins, strategies and MCP servers register into it).
 * Any tool registered afterwards was silently un-recommendable, and the name
 * list could drift from the security property it was meant to encode.
 *
 * The rule is now structural (`isAutoRecommendable`). This suite pins BOTH
 * halves of it:
 *   - the security invariant — nothing that touches the server's own
 *     filesystem or codebase may ever be auto-attached;
 *   - the dynamism — a newly registered external/sandboxed tool participates
 *     without anyone editing a list.
 */

import { describe, expect, it } from 'vitest';
import { isAutoRecommendable, type ToolRegistration } from '../tool-registry';

const noopHandler: ToolRegistration['handler'] = async (_args, toolCallId) => ({
  tool_call_id: toolCallId,
  success: true,
});

function tool(overrides: Partial<ToolRegistration>): ToolRegistration {
  return {
    name: 'fixture',
    description: 'fixture tool',
    category: 'general',
    safeForStrategies: true,
    handler: noopHandler,
    ...overrides,
  };
}

/** Categories whose handlers reach the server's own filesystem or repo. */
const SERVER_SIDE_CATEGORIES: ReadonlyArray<ToolRegistration['category']> = [
  'file',
  'git',
  'search',
  'refactoring',
  'testing',
  'task',
  'analysis',
  'workflow',
  'general',
];

describe('isAutoRecommendable — security invariant', () => {
  it('never admits a server-filesystem / codebase category by default', () => {
    for (const category of SERVER_SIDE_CATEGORIES) {
      expect(isAutoRecommendable(tool({ category })), `${category} must not be default-on`).toBe(
        false
      );
    }
  });

  it('never admits a tool the strategies may not run, whatever it declares', () => {
    expect(
      isAutoRecommendable(tool({ category: 'web', safeForStrategies: false }))
    ).toBe(false);
    // An explicit opt-in cannot override the strategy-safety precondition —
    // this is what stops a `safeForStrategies:false` MCP tool from being
    // auto-attached by declaring itself recommendable.
    expect(
      isAutoRecommendable(
        tool({ category: 'web', safeForStrategies: false, autoRecommendable: true })
      )
    ).toBe(false);
  });

  it('honours an explicit opt-OUT even for an external category', () => {
    expect(isAutoRecommendable(tool({ category: 'web', autoRecommendable: false }))).toBe(false);
  });
});

describe('isAutoRecommendable — dynamism', () => {
  it('admits external/sandboxed categories with no list to edit', () => {
    for (const category of ['web', 'image', 'video', 'audio'] as const) {
      expect(isAutoRecommendable(tool({ category })), `${category} must be default-on`).toBe(true);
    }
  });

  it('admits a sandboxed tool in a server-side category via explicit opt-in', () => {
    // This is exactly how `code_execute` (category `code`, sandboxed
    // effects) stays recommendable now that the name list is gone.
    expect(
      isAutoRecommendable(tool({ category: 'code', autoRecommendable: true }))
    ).toBe(true);
    // …while its filesystem-touching siblings in the same category do not.
    expect(isAutoRecommendable(tool({ category: 'code' }))).toBe(false);
  });

  it('lets a newly registered web tool participate immediately', () => {
    const brandNew = tool({ name: 'some_future_web_tool', category: 'web' });
    expect(isAutoRecommendable(brandNew)).toBe(true);
  });
});
