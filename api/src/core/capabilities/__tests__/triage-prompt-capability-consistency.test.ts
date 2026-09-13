// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * triage-prompt-capability-consistency.test.ts — LOTE AO (2026-09-05)
 *
 * The triage prompt tells the LLM "Capabilities must come from the catalog
 * provided" and then, further down, REQUIRES specific capability names in its
 * routing rules. Nothing checked that the two agreed.
 *
 * They did not. The prompt demanded ten file-generation capabilities
 * (`csv_generation`, `docx_generation`, `code_file_generation`, …) that did
 * not exist in `MODEL_CAPABILITIES` — the very list injected into
 * `{{CAPABILITIES}}`. They lived only in
 * `orchestration/capability-inference.ts#RequiredCapability`. The triage LLM
 * was being asked to emit values from a catalog it was simultaneously told
 * was closed.
 *
 * This suite renders the FINAL prompt (after template substitution) and
 * asserts that every capability-shaped token the rules name is present in the
 * injected catalog. It fails loudly if that contradiction ever comes back.
 *
 * It lives beside the ontology tests rather than under
 * `core/orchestration/__tests__/` because that directory is EXCLUDED from
 * `vitest.ci.config.ts` (it needs the Testcontainers-backed default config).
 * This guard has no such dependency and must run on every PR.
 */

import { describe, expect, it } from 'vitest';
import { TriagingService } from '@/core/orchestration/triage-service';
import { MODEL_CAPABILITIES, type ChatRequest } from '@/types';
import { capabilityOntology } from '../capability-ontology';

/**
 * `buildPrompt` is private and touches neither the provider registry nor the
 * config beyond reading them off `this`, so a structural stub is enough.
 */
function renderSystemPrompt(): string {
  const service = new TriagingService({} as never, { temperature: 0.1, maxTokens: 2048 });
  const messages = (
    service as unknown as {
      buildPrompt: (request: ChatRequest) => Array<{ role: string; content: string }>;
    }
  ).buildPrompt({ messages: [{ role: 'user', content: 'hello' }] } as ChatRequest);
  const system = messages.find((m) => m.role === 'system');
  if (!system) throw new Error('triage prompt has no system message');
  return system.content;
}

/** The `## Available capabilities:` section — the catalog actually injected. */
function injectedCatalog(prompt: string): Set<string> {
  const header = '## Available capabilities:\n';
  const start = prompt.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  const rest = prompt.slice(start + header.length);
  const end = rest.indexOf('\n##');
  const section = end === -1 ? rest : rest.slice(0, end);
  return new Set(
    section
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** Everything in the prompt BEFORE the catalog — the rules and JSON shape. */
function ruleSection(prompt: string): string {
  const idx = prompt.indexOf('## Available capabilities:');
  expect(idx).toBeGreaterThan(-1);
  return prompt.slice(0, idx);
}

/**
 * snake_case tokens that appear in the rules but are NOT capability names:
 * JSON field names, route/enum values, example ad-hoc role names, and
 * example CSV column names from the `generation_prompt` illustration.
 *
 * Anything snake_case that is neither here nor in the injected catalog makes
 * the test fail — deliberately. A new token is either a capability (add it
 * to the catalog) or prose scaffolding (add it here, on purpose).
 */
const NON_CAPABILITY_TOKENS: ReadonlySet<string> = new Set([
  // JSON output shape
  'execution_plan',
  'required_capabilities',
  'preferred_capabilities',
  'recommended_tools',
  'model_roles',
  'model_count',
  'max_tokens',
  'max_deliberation_rounds',
  'estimated_input_tokens',
  'quality_target',
  'prefer_speed',
  'requires_tools',
  'requires_continuation',
  'task_context',
  'generation_prompt',
  // LOTE AS (2026-09-06): structured video-generation attribute field names
  // (duration/resolution carry no underscore so they don't match SNAKE_CASE).
  'aspect_ratio',
  'audio_requested',
  // `route` enum values
  'direct_response',
  'planned_execution',
  // illustrative ad-hoc role names
  'security_auditor',
  'ux_reviewer',
  'data_scientist',
  // illustrative CSV columns inside an example generation_prompt
  'distance_km',
  'radius_km',
]);

const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

describe('triage prompt — injected catalog vs demanded capabilities', () => {
  it('injects the full MODEL_CAPABILITIES catalog', () => {
    const catalog = injectedCatalog(renderSystemPrompt());
    for (const cap of MODEL_CAPABILITIES) expect(catalog.has(cap)).toBe(true);
    expect(catalog.size).toBe(MODEL_CAPABILITIES.length);
  });

  it('names no capability the injected catalog lacks', () => {
    const prompt = renderSystemPrompt();
    const catalog = injectedCatalog(prompt);
    const unknown = [...new Set(ruleSection(prompt).match(SNAKE_CASE) ?? [])]
      .filter((token) => !NON_CAPABILITY_TOKENS.has(token))
      .filter((token) => !catalog.has(token));
    expect(unknown).toEqual([]);
  });

  it('names the ten file-generation capabilities AND has them in the catalog', () => {
    // The exact contradiction this suite exists to prevent.
    const prompt = renderSystemPrompt();
    const catalog = injectedCatalog(prompt);
    const rules = ruleSection(prompt);
    for (const cap of [
      'csv_generation',
      'json_generation',
      'markdown_generation',
      'docx_generation',
      'xlsx_generation',
      'pdf_generation',
      'pptx_generation',
      'zip_generation',
      'code_file_generation',
      'file_generation',
    ]) {
      expect(rules, `${cap} must be named in the rules`).toContain(cap);
      expect(catalog.has(cap), `${cap} must be in the injected catalog`).toBe(true);
    }
  });

  it('every catalog entry resolves in the capability ontology', () => {
    const catalog = injectedCatalog(renderSystemPrompt());
    const unresolved = [...catalog].filter((cap) => !capabilityOntology.has(cap));
    expect(unresolved).toEqual([]);
  });
});

describe('triage prompt — audio input (STT) routing', () => {
  /**
   * Pre-LOTE-AO, none of `speech_to_text`, `transcription`, `listen` or
   * `audio_input` appeared anywhere in the ~151-line prompt, even though
   * `audio-orchestration-service.ts` has a full STT/translation path keyed
   * on exactly those tags. Every audio request could only be described with
   * the OUTPUT-side capability.
   */
  it('gives the LLM an explicit input-side audio rule', () => {
    const rules = ruleSection(renderSystemPrompt());
    for (const token of ['speech_to_text', 'audio_input', 'diarization', 'transcri']) {
      expect(rules, `prompt must mention ${token}`).toContain(token);
    }
  });

  it('states that the two audio directions are not interchangeable', () => {
    const rules = ruleSection(renderSystemPrompt()).toLowerCase();
    expect(rules).toContain('never use it for a transcription');
    expect(rules).toContain('never use speech_to_text');
  });
});

describe('triage prompt — tools are not a hard capability filter', () => {
  /**
   * `dynamic-model-selector.ts` deliberately EXCLUDES `function_calling`
   * from the fail-closed hard filter (commit acc0efee + the 2026-08-21
   * pool-recovery note) and defers to a runtime probe. The prompt used to
   * present it like `vision`/`json_mode`, inviting the LLM to "make sure" by
   * adding it to required_capabilities.
   */
  it('tells the LLM tool support is deferred, not hard-filtered', () => {
    const rules = ruleSection(renderSystemPrompt());
    expect(rules).toContain('function_calling');
    expect(rules.toLowerCase()).toContain('deferred');
    expect(rules.toLowerCase()).toContain('runtime probe');
    expect(rules).toContain('requires_tools');
  });
});
