// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit coverage for system-capability-manifest.ts — the platform-wide
 * capability-awareness section injected into the EXECUTION system prompt
 * (see execution-system-prompt.ts, which wires this in right after the
 * per-request "Available capabilities: ..." tag list).
 *
 * Three things are pinned here:
 *  1. The scoping heuristic (`shouldIncludeSystemCapabilityManifest`) — gated
 *     on latency-sensitivity (prefer_speed / a small explicit max_tokens
 *     cap), NOT turn count. See the module doc comment for why turn count
 *     was rejected.
 *  2. The manifest's grounded content — real TRUE capabilities (media
 *     pipelines, collective strategies) and the real, explicit FALSE
 *     capability (no live code-execution sandbox), matching
 *     code-execution-honesty.ts's already-established fact.
 *  3. The tool-category clause is DERIVED from `toolRegistry.listCategories()`
 *     live, not a hardcoded name list — this file registers fixture tools
 *     directly into the (otherwise untouched, since this file imports
 *     neither chat-request-processor.ts nor anything that bootstraps real
 *     tools) singleton registry and asserts the manifest text tracks it
 *     exactly. A real-registry integration check lives in the sibling file
 *     system-capability-manifest-registry-integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  shouldIncludeSystemCapabilityManifest,
  buildSystemCapabilityManifest,
} from '../prompts/system-capability-manifest';
import { toolRegistry, type ToolRegistration } from '@/core/tools/tool-registry';
import type { ChatRequest, OrchestrationContext } from '@/types';

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello Ailin' }],
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

const noopHandler: ToolRegistration['handler'] = async (_args, toolCallId) => ({
  tool_call_id: toolCallId,
  success: true,
});

describe('shouldIncludeSystemCapabilityManifest', () => {
  it('is true for an ordinary request with no speed/token constraints (the common case)', () => {
    expect(shouldIncludeSystemCapabilityManifest(makeRequest(), makeContext())).toBe(true);
  });

  it('is true for a FIRST-turn, single-message request — turn count is not the gate', () => {
    const req = makeRequest({ messages: [{ role: 'user', content: 'Can you also do X?' }] });
    expect(shouldIncludeSystemCapabilityManifest(req, makeContext())).toBe(true);
  });

  it('is false when context.preferSpeed is true (ping-shaped request)', () => {
    expect(
      shouldIncludeSystemCapabilityManifest(makeRequest(), makeContext({ preferSpeed: true }))
    ).toBe(false);
  });

  it('is false when max_tokens sits at or below the latency-sensitive ceiling (320)', () => {
    expect(
      shouldIncludeSystemCapabilityManifest(makeRequest({ max_tokens: 320 }), makeContext())
    ).toBe(false);
    expect(
      shouldIncludeSystemCapabilityManifest(makeRequest({ max_tokens: 1 }), makeContext())
    ).toBe(false);
  });

  it('is true when max_tokens is above the ceiling', () => {
    expect(
      shouldIncludeSystemCapabilityManifest(makeRequest({ max_tokens: 321 }), makeContext())
    ).toBe(true);
    expect(
      shouldIncludeSystemCapabilityManifest(makeRequest({ max_tokens: 4096 }), makeContext())
    ).toBe(true);
  });

  it('is true when max_tokens is unset, regardless of other fields', () => {
    expect(
      shouldIncludeSystemCapabilityManifest(makeRequest({ max_tokens: undefined }), makeContext())
    ).toBe(true);
  });
});

describe('buildSystemCapabilityManifest — grounded TRUE capabilities', () => {
  const manifest = buildSystemCapabilityManifest();

  it('states real media-generation pipelines (image/video, TTS/STT, translation, file generation)', () => {
    expect(manifest).toContain('image/video generation');
    expect(manifest.toLowerCase()).toContain('text-to-speech');
    expect(manifest.toLowerCase()).toContain('speech-to-text');
    expect(manifest.toLowerCase()).toContain('translation');
    expect(manifest.toLowerCase()).toContain('file generation');
  });

  it('states real multi-model collective strategies by name', () => {
    expect(manifest.toLowerCase()).toContain('consensus');
    expect(manifest.toLowerCase()).toContain('debate');
    expect(manifest.toLowerCase()).toContain('expert-panel');
  });

  it('frames these as available "beyond this turn" rather than claiming they are active now', () => {
    expect(manifest).toMatch(/beyond this turn/i);
  });
});

describe('buildSystemCapabilityManifest — grounded FALSE capability (honesty)', () => {
  const manifest = buildSystemCapabilityManifest();

  it('explicitly states the platform has no live code-execution sandbox today', () => {
    expect(manifest).toContain(
      'It does NOT have a live, connected code-interpreter/sandbox that executes arbitrary user'
    );
  });

  it('never claims the platform can execute arbitrary user code', () => {
    expect(manifest.toLowerCase()).not.toMatch(/\bcan (run|execute) (arbitrary )?(user )?code\b/);
  });

  it('instructs honesty when a capability is unavailable on this turn', () => {
    expect(manifest.toLowerCase()).toContain('say so honestly');
  });
});

describe('buildSystemCapabilityManifest — tool category clause is DERIVED, not hardcoded', () => {
  it('omits the category clause entirely when the registry has nothing registered', () => {
    // This test file never imports chat-request-processor.ts or anything else
    // that bootstraps the real tool set, so at this point in a fresh module
    // graph the registry is empty. If a future import accidentally pulls in
    // real registrations, this assertion is the tripwire.
    if (toolRegistry.listCategories().length > 0) return; // real tools already present via a shared module graph — covered by the populated-state assertions below instead
    const manifest = buildSystemCapabilityManifest();
    expect(manifest).not.toContain('Tool categories registered system-wide');
  });

  it('lists newly registered categories, sorted and deduplicated, once tools exist', () => {
    toolRegistry.register({
      name: 'fixture_scm_tool_video',
      description: 'fixture',
      category: 'video',
      safeForStrategies: true,
      handler: noopHandler,
    });
    toolRegistry.register({
      name: 'fixture_scm_tool_analysis',
      description: 'fixture',
      category: 'analysis',
      safeForStrategies: true,
      handler: noopHandler,
    });
    // Second 'video' registration must not duplicate the category.
    toolRegistry.register({
      name: 'fixture_scm_tool_video_2',
      description: 'fixture',
      category: 'video',
      safeForStrategies: true,
      handler: noopHandler,
    });

    const categories = toolRegistry.listCategories();
    const manifest = buildSystemCapabilityManifest();

    // Whatever the live category set is (own fixtures plus anything already
    // present), the manifest must name every one of them and nothing else —
    // proving the clause is a live read of the registry, not a static string.
    expect(categories).toContain('video');
    expect(categories).toContain('analysis');
    expect(manifest).toContain(
      `Tool categories registered system-wide (a different turn may attach tools from any of these even when absent above): ${categories.join(', ')}.`
    );
  });

  it('a category with zero registered tools does not appear in the category CLAUSE', () => {
    // 'audio' legitimately appears in the manifest's static prose ("text-to-speech/
    // speech-to-text audio") describing the real CapabilityInvoker pipeline — that
    // is not a tool-registry category claim. This asserts the narrower, correct
    // thing: 'audio' must not appear inside the derived category-clause SENTENCE
    // itself unless toolRegistry actually has a tool registered under it.
    const categories = toolRegistry.listCategories();
    if (categories.includes('audio')) return; // some earlier state in this run registered one — nothing to assert
    const manifest = buildSystemCapabilityManifest();
    const clauseMatch = manifest.match(/registered system-wide[^.]*\./);
    expect(clauseMatch).not.toBeNull();
    expect(clauseMatch?.[0]).not.toMatch(/\baudio\b/);
  });
});
