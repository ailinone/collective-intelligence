// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * v0 tool-calling capability-mismatch fix (2026-09-09).
 *
 * The catalog previously declared `supports.tools: true` and tagged
 * `v0-auto`/`v0-pro`/`v0-max` with `tool_use` in `pinnedFallback.models`,
 * but v0's documented Platform API
 * (https://v0.app/docs/api/platform/reference/chats/create) has NO
 * `tools`/`tool_choice`/`functions` field on the `POST /chats` request body
 * for any model — confirmed directly against the reference page, which
 * lists the complete field set with no such field. `V0Adapter.chatCompletion`
 * / `buildV0Message` never read `request.tools`/`request.tool_choice`
 * either, so the router was being told the provider could satisfy
 * function-calling requests it was structurally incapable of honoring.
 *
 * The two fields that superficially look adjacent are NOT a substitute:
 *   - `attachedSkillIds`/`skills` reference pre-registered skills.sh /
 *     memory / project skills (max 3, domain-knowledge attachments, not
 *     arbitrary caller-defined JSON-schema functions).
 *   - `mcpServerIds` references MCP servers registered out-of-band that v0
 *     may consult autonomously server-side during generation — no inline
 *     per-request tool schema, and no `tool_calls` surfaced back to the
 *     caller to execute (the opposite shape of the OpenAI-style contract
 *     `ChatRequest.tools`/`tool_choice` represents in this codebase).
 *
 * This test locks in the removal so a future edit can't silently
 * reintroduce the false capability claim.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { normalizePinnedModelEntry } from '../provider-catalog.types';

describe('v0 tool-calling capability-mismatch fix', () => {
  const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'v0');

  it('v0 catalog row exists', () => {
    expect(entry).toBeTruthy();
  });

  it('does not declare supports.tools', () => {
    expect(entry!.supports.tools).not.toBe(true);
  });

  it('still declares supports.chat and supports.streaming (unaffected by this fix)', () => {
    expect(entry!.supports.chat).toBe(true);
    expect(entry!.supports.streaming).toBe(true);
  });

  it('no pinnedFallback model declares tool_use', () => {
    const models = entry!.pinnedFallback?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const raw of models) {
      const { id, capabilities } = normalizePinnedModelEntry(raw);
      expect(capabilities, `${id} should not declare tool_use`).not.toContain('tool_use');
    }
  });

  it('every pinnedFallback model still declares at least one real capability', () => {
    // Guards against the fix degenerating into an empty-capabilities row,
    // which would fail the separate pinned-fallback-capability-coverage
    // invariant test for an unrelated reason.
    const models = entry!.pinnedFallback?.models ?? [];
    for (const raw of models) {
      const { id, capabilities } = normalizePinnedModelEntry(raw);
      expect(capabilities.length, `${id} should declare >=1 capability`).toBeGreaterThan(0);
      expect(capabilities).toContain('chat');
    }
  });
});
