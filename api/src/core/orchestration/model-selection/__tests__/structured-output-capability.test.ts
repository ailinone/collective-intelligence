// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4D §7 — structured-output-capability unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  detectStructuredOutputSupport,
  satisfiesJudgeStructuredOutputRequirement,
  readStructuredOutputBackfill,
  type StructuredOutputBackfillEntry,
} from '@/core/orchestration/model-selection/structured-output-capability';

describe('01C.1B-J1D-R4D — detectStructuredOutputSupport', () => {
  it('strong: json_output capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['chat', 'json_output'] });
    expect(e.support).toBe('strong');
    expect(e.matchedCapabilities).toContain('json_output');
  });

  it('strong: json_mode capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['json_mode'] });
    expect(e.support).toBe('strong');
  });

  it('strong: structured_output capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['structured_output'] });
    expect(e.support).toBe('strong');
  });

  it('strong: response_format_json capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['response_format_json'] });
    expect(e.support).toBe('strong');
  });

  it('strong: metadata.response_format=json_object → strong', () => {
    const e = detectStructuredOutputSupport({
      capabilities: ['chat'],
      metadata: { response_format: 'json_object' },
    });
    expect(e.support).toBe('strong');
    expect(e.matchedMetadataKeys).toContain('response_format');
  });

  it('medium: function_calling capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['function_calling'] });
    expect(e.support).toBe('medium');
  });

  it('medium: tool_use capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['tool_use'] });
    expect(e.support).toBe('medium');
  });

  it('medium: tool_calling capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['tool_calling'] });
    expect(e.support).toBe('medium');
  });

  it('medium: tools capability', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['tools'] });
    expect(e.support).toBe('medium');
  });

  it('weak: instruction_json only', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['instruction_json'] });
    expect(e.support).toBe('weak');
  });

  it('none: only chat/text_generation', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['chat', 'text_generation'] });
    expect(e.support).toBe('none');
    expect(e.reason).toContain('no_structured_output_evidence');
  });

  it('case-insensitive: JSON_OUTPUT matches', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['JSON_OUTPUT'] });
    expect(e.support).toBe('strong');
  });

  it('stronger wins: caps say medium but metadata says strong → strong', () => {
    const e = detectStructuredOutputSupport({
      capabilities: ['function_calling'],
      metadata: { json_output: true },
    });
    expect(e.support).toBe('strong');
    expect(e.evidenceSource).toContain('metadata');
  });

  // ─── backfill paths ─────────────────────────────────────────────────────

  it('backfill: adds strong evidence to a none-only model', () => {
    const backfill: StructuredOutputBackfillEntry[] = [
      {
        providerId: 'deepinfra',
        modelId: 'anthropic/claude-opus-4-7',
        support: 'strong',
        reason: 'Anthropic API supports response_format=json_object',
        confidence: 'high',
        source: 'docs',
      },
    ];
    const e = detectStructuredOutputSupport({
      capabilities: ['chat', 'text_generation'],
      modelId: 'anthropic/claude-opus-4-7',
      providerId: 'deepinfra',
      backfill,
    });
    expect(e.support).toBe('strong');
    expect(e.matchedBackfillReason).toContain('Anthropic');
    expect(e.evidenceSource).toContain('backfill');
  });

  it('backfill cannot weaken existing strong evidence', () => {
    const backfill: StructuredOutputBackfillEntry[] = [
      {
        providerId: 'deepinfra',
        modelId: 'x/y',
        support: 'weak',
        reason: 'mislabeled override (should not weaken catalog strong)',
        confidence: 'low',
        source: 'manual',
      },
    ];
    const e = detectStructuredOutputSupport({
      capabilities: ['json_output'],
      modelId: 'x/y',
      providerId: 'deepinfra',
      backfill,
    });
    expect(e.support).toBe('strong');
  });

  it('backfill lookup is case-insensitive on provider+modelId', () => {
    const backfill: StructuredOutputBackfillEntry[] = [
      {
        providerId: 'DeepInfra',
        modelId: 'Anthropic/Claude-Opus-4-7',
        support: 'strong',
        reason: 'docs',
        confidence: 'high',
        source: 'docs',
      },
    ];
    const e = detectStructuredOutputSupport({
      capabilities: ['chat'],
      modelId: 'anthropic/claude-opus-4-7',
      providerId: 'deepinfra',
      backfill,
    });
    expect(e.support).toBe('strong');
  });

  it('backfill miss: no match → falls back to catalog evidence', () => {
    const backfill: StructuredOutputBackfillEntry[] = [
      {
        providerId: 'deepinfra',
        modelId: 'a/b',
        support: 'strong',
        reason: 'docs',
        confidence: 'high',
        source: 'docs',
      },
    ];
    const e = detectStructuredOutputSupport({
      capabilities: ['chat'],
      modelId: 'c/d',
      providerId: 'deepinfra',
      backfill,
    });
    expect(e.support).toBe('none');
  });

  // ─── judge requirement predicate ────────────────────────────────────────

  it('judge accepts strong by default', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['json_output'] });
    expect(satisfiesJudgeStructuredOutputRequirement({ evidence: e })).toBe(true);
  });

  it('judge accepts medium by default', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['function_calling'] });
    expect(satisfiesJudgeStructuredOutputRequirement({ evidence: e })).toBe(true);
  });

  it('judge rejects weak by default', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['instruction_json'] });
    expect(satisfiesJudgeStructuredOutputRequirement({ evidence: e })).toBe(false);
  });

  it('judge accepts weak ONLY with allowWeakStructuredOutputForJudge=true', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['instruction_json'] });
    expect(
      satisfiesJudgeStructuredOutputRequirement({
        evidence: e,
        allowWeakStructuredOutputForJudge: true,
      }),
    ).toBe(true);
  });

  it('judge rejects none in all cases', () => {
    const e = detectStructuredOutputSupport({ capabilities: ['chat'] });
    expect(satisfiesJudgeStructuredOutputRequirement({ evidence: e })).toBe(false);
    expect(
      satisfiesJudgeStructuredOutputRequirement({
        evidence: e,
        allowWeakStructuredOutputForJudge: true,
      }),
    ).toBe(false);
  });

  // ─── safety ─────────────────────────────────────────────────────────────

  it('does not leak secrets in evidence reason', () => {
    const e = detectStructuredOutputSupport({
      capabilities: ['chat'],
      metadata: { apiKey: 'sk-supersecret123456', auth: 'Bearer abc.def.ghi' },
    });
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/sk-supersecret/);
    expect(json).not.toMatch(/Bearer\s+abc/);
  });

  it('readStructuredOutputBackfill: returns empty overrides when none', () => {
    const r = readStructuredOutputBackfill({});
    expect(r.overrides).toEqual([]);
    expect(r.version).toBeUndefined();
  });

  it('readStructuredOutputBackfill: passes through overrides + version', () => {
    const overrides: StructuredOutputBackfillEntry[] = [
      {
        providerId: 'p',
        modelId: 'm',
        support: 'strong',
        reason: 'r',
        confidence: 'high',
        source: 'docs',
      },
    ];
    const r = readStructuredOutputBackfill({ version: 'v1', overrides });
    expect(r.version).toBe('v1');
    expect(r.overrides).toHaveLength(1);
  });
});
