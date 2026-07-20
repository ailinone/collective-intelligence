// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-pipeline-trace-redaction.test.ts — MVP 7A
 *
 * The final trace must NEVER contain prompt text, raw messages,
 * raw context, or any forbidden key. Redaction is applied by the
 * trace builder before the composer returns.
 */

import { describe, expect, it } from 'vitest';
import { composeRoutingPipeline } from '../routing-pipeline-composer';
import { createStaticRoutingConfigProvider } from '../../routing-config/runtime-routing-config-provider';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { ROUTING_TRACE_ALLOWED_KEYS } from '../../routing/routing-decision-trace';

const SENSITIVE_PROMPT = 'top-secret prompt content do not leak';
const FORBIDDEN_KEYS = [
  'prompt',
  'rawPrompt',
  'messages',
  'userMessage',
  'rawContext',
  'context',
  'userInput',
  'email',
  'phone',
  'fullName',
  'userId',
  'userName',
];

function runWithSensitiveText(mode: 'shadow_structural_full' | 'legacy' | 'shadow_trace_only' | 'shadow_registry_only' | 'registry_cache' | 'shadow_semantic_full' | 'semantic_primary') {
  return composeRoutingPipeline({
    requestId: 'r-redact',
    profilerInput: {
      requestId: 'r-redact',
      text: SENSITIVE_PROMPT,
    },
    registry: buildFixtureRegistry(),
    configProvider: createStaticRoutingConfigProvider({ mode }),
    nowIso: '2026-05-12T13:09:00.000Z',
    traceId: 'trace-redact-1',
  });
}

describe('routing-pipeline — trace redaction (shadow_structural_full)', () => {
  const result = runWithSensitiveText('shadow_structural_full');
  const traceJson = JSON.stringify(result.trace);

  it('trace JSON does NOT contain the raw prompt text', () => {
    expect(traceJson).not.toContain(SENSITIVE_PROMPT);
  });

  for (const k of FORBIDDEN_KEYS) {
    it(`trace JSON does NOT contain forbidden key "${k}"`, () => {
      expect(traceJson).not.toContain(`"${k}"`);
    });
  }

  it('trace has ONLY allowed top-level keys', () => {
    for (const k of Object.keys(result.trace)) {
      expect(ROUTING_TRACE_ALLOWED_KEYS.has(k)).toBe(true);
    }
  });
});

describe('routing-pipeline — trace redaction across all modes', () => {
  const modes = [
    'legacy',
    'registry_cache',
    'shadow_trace_only',
    'shadow_registry_only',
    'shadow_structural_full',
    'shadow_semantic_full',
    'semantic_primary',
  ] as const;

  for (const mode of modes) {
    const r = runWithSensitiveText(mode);
    const json = JSON.stringify(r.trace);

    it(`[${mode}] trace does NOT contain SENSITIVE_PROMPT`, () => {
      expect(json).not.toContain(SENSITIVE_PROMPT);
    });

    it(`[${mode}] trace has no forbidden top-level keys`, () => {
      for (const k of FORBIDDEN_KEYS) {
        expect(json).not.toContain(`"${k}"`);
      }
    });

    it(`[${mode}] trace top-level keys are in the allowlist`, () => {
      for (const k of Object.keys(r.trace)) {
        expect(ROUTING_TRACE_ALLOWED_KEYS.has(k)).toBe(true);
      }
    });
  }
});

describe('routing-pipeline — trace categorical-only contents', () => {
  it('taskProfile is a CATEGORICAL summary, not the full profile', () => {
    const result = runWithSensitiveText('shadow_structural_full');
    const summary = result.trace.taskProfile;
    expect(typeof summary.taskType).toBe('string');
    expect(typeof summary.complexity).toBe('string');
    expect(typeof summary.riskLevel).toBe('string');
    expect(typeof summary.privacyMode).toBe('string');
    expect(Array.isArray(summary.modalities)).toBe(true);
    // Should NOT contain confidenceNeeded, strategyHints, etc.
    expect(
      'confidenceNeeded' in (summary as Record<string, unknown>),
    ).toBe(false);
    expect(
      'strategyHints' in (summary as Record<string, unknown>),
    ).toBe(false);
    expect(
      'requiredCapabilities' in (summary as Record<string, unknown>),
    ).toBe(false);
  });

  it('attachments are NOT propagated to the trace', () => {
    const result = composeRoutingPipeline({
      requestId: 'r-redact-2',
      profilerInput: {
        requestId: 'r-redact-2',
        text: SENSITIVE_PROMPT,
        attachments: [
          { kind: 'document', approximateTokens: 5_000 },
          { kind: 'image', approximateTokens: 1_000 },
        ],
      },
      registry: buildFixtureRegistry(),
      configProvider: createStaticRoutingConfigProvider({
        mode: 'shadow_structural_full',
      }),
    });
    const json = JSON.stringify(result.trace);
    expect(json).not.toContain('attachments');
    expect(json).not.toContain('approximateTokens');
  });
});
