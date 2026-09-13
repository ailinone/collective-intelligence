// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration check: the system-capability-manifest's tool-category clause
 * against the REAL production tool registry (via chat-request-processor.ts's
 * `registerToolsInRegistry()`), not fixtures.
 *
 * Kept in its own file (separate module graph / process under vitest's
 * `pool: 'forks'`) so populating the real registry here can't leak into
 * system-capability-manifest.test.ts's empty/fixture-only assertions.
 *
 * `ensureToolsRegistered()` mirrors the sanctioned pattern already used by
 * generate-media-tool-media-consensus.test.ts: `registerToolsInRegistry()`
 * kicks off a dynamic import (to dodge a module-load-time circular
 * dependency) and is fire-and-forget, so tests await completion via
 * `vi.waitFor(() => toolRegistry.isInitialized())` rather than the function's
 * own return value.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerToolsInRegistry } from '@/services/chat-request-processor';
import { toolRegistry } from '@/core/tools/tool-registry';
import { buildSystemCapabilityManifest } from '../prompts/system-capability-manifest';
import { buildExecutionSystemPrompt } from '../execution-system-prompt';
import type { ChatRequest, OrchestrationContext } from '@/types';

async function ensureToolsRegistered(): Promise<void> {
  registerToolsInRegistry();
  await vi.waitFor(() => {
    if (!toolRegistry.isInitialized()) throw new Error('tool registry not yet initialized');
  });
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Can you also generate an image of this?' }],
    ...overrides,
  } as ChatRequest;
}

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'test-req',
    models: [],
    taskType: 'general',
    contextSize: 0,
    ...overrides,
  } as OrchestrationContext;
}

describe('system-capability-manifest — real tool-registry integration', () => {
  it('reflects the real, currently-registered tool categories (regression guard against drift)', async () => {
    await ensureToolsRegistered();

    const categories = toolRegistry.listCategories();
    // These categories are backed by real, long-standing registrations
    // (web_search -> 'web', write_file -> 'file', generate_video -> 'video')
    // — stable enough to assert on directly without over-fitting to the
    // exact full category set, which may legitimately grow over time.
    expect(categories).toContain('web');
    expect(categories).toContain('file');
    expect(categories).toContain('video');

    const manifest = buildSystemCapabilityManifest();
    for (const category of categories) {
      expect(manifest).toContain(category);
    }
    expect(manifest).toContain(categories.join(', '));
  });

  it('the injected execution system prompt carries the real category list for a substantive request', async () => {
    await ensureToolsRegistered();

    const prompt = buildExecutionSystemPrompt(makeRequest(), makeContext());
    expect(prompt).toContain('SYSTEM CAPABILITY AWARENESS');
    expect(prompt).toContain('Tool categories registered system-wide');
    for (const category of toolRegistry.listCategories()) {
      expect(prompt).toContain(category);
    }
  });

  it('does NOT include the manifest for a latency-sensitive request even with the real registry populated', async () => {
    await ensureToolsRegistered();

    const prompt = buildExecutionSystemPrompt(
      makeRequest({ max_tokens: 100 }),
      makeContext()
    );
    expect(prompt).not.toContain('SYSTEM CAPABILITY AWARENESS');
  });
});
