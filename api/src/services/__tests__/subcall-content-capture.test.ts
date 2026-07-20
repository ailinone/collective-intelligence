// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Full-flow subcall capture (include_subcall_content).
 *
 * The experiment must be auditable from input through the WHOLE strategy flow:
 * every voter/coordinator/synthesis subcall's actual output text, extracted
 * reasoning, and prompt-variant provenance — not just per-subcall metrics.
 * Content capture is OPT-IN (the intra-collective transcript can run to
 * hundreds of KB per response), so normal traffic keeps the lean shape.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mapSubcallEntries } from '../chat-request-processor';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

function exec(over: Partial<Parameters<typeof mapSubcallEntries>[0][number]> = {}) {
  return {
    modelId: 'prov/model-a',
    modelName: 'Model A',
    role: 'voter',
    cost: 0.01,
    durationMs: 1200,
    success: true,
    reasoning: 'thought about it step by step',
    promptKey: 'consensusVoter',
    promptVariantId: 'v2',
    response: {
      choices: [{ message: { content: 'the voter\'s full answer text' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
    ...over,
  };
}

describe('mapSubcallEntries', () => {
  it('default (includeContent=false): lean metrics-only shape — no transcript fields', () => {
    const [entry] = mapSubcallEntries([exec()], false);
    expect(entry.model_id).toBe('prov/model-a');
    expect(entry.cost_usd).toBe(0.01);
    expect(entry.tokens).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    expect(entry).not.toHaveProperty('content');
    expect(entry).not.toHaveProperty('reasoning');
    expect(entry).not.toHaveProperty('prompt_key');
  });

  it('includeContent=true: captures the full output text, reasoning, and prompt provenance', () => {
    const [entry] = mapSubcallEntries([exec()], true);
    expect(entry.content).toBe('the voter\'s full answer text');
    expect(entry.reasoning).toBe('thought about it step by step');
    expect(entry.prompt_key).toBe('consensusVoter');
    expect(entry.prompt_variant_id).toBe('v2');
    expect(entry.content_truncated).toBeUndefined();
  });

  it('content is NOT truncated by default (SUBCALL_CONTENT_MAX_CHARS unset → unlimited)', () => {
    delete process.env.SUBCALL_CONTENT_MAX_CHARS;
    const big = 'x'.repeat(500_000);
    const [entry] = mapSubcallEntries([exec({ response: { choices: [{ message: { content: big } }] } })], true);
    expect(entry.content).toHaveLength(500_000);
    expect(entry.content_truncated).toBeUndefined();
  });

  it('operator cap (SUBCALL_CONTENT_MAX_CHARS>0) clips and FLAGS the truncation explicitly', () => {
    process.env.SUBCALL_CONTENT_MAX_CHARS = '100';
    const big = 'y'.repeat(1_000);
    const [entry] = mapSubcallEntries([exec({ response: { choices: [{ message: { content: big } }] } })], true);
    expect(entry.content).toHaveLength(100);
    expect(entry.content_truncated).toBe(true);
  });

  it('a failed subcall with no response still yields an entry (content null, error kept)', () => {
    const [entry] = mapSubcallEntries(
      [exec({ success: false, error: 'timeout', response: undefined, reasoning: undefined, promptKey: undefined, promptVariantId: undefined })],
      true,
    );
    expect(entry.success).toBe(false);
    expect(entry.error).toBe('timeout');
    expect(entry.content).toBeNull();
    expect(entry.reasoning).toBeNull();
    expect(entry.tokens).toBeNull();
  });

  it('normalizes multimodal (parts-array) content to faithful text', () => {
    const parts = [
      { type: 'text', text: 'Here is the scene: ' },
      { type: 'image_url', image_url: { url: 'https://x/img.png' } },
      { type: 'text', text: ' — as requested.' },
    ];
    const [entry] = mapSubcallEntries(
      [exec({ response: { choices: [{ message: { content: parts as never } }] } })],
      true,
    );
    expect(entry.content).toBe('Here is the scene: [image_url] — as requested.');
  });

  it('preserves per-subcall identity across a multi-voter flow (order and roles)', () => {
    const entries = mapSubcallEntries([
      exec({ modelId: 'p/a', role: 'voter', response: { choices: [{ message: { content: 'A says X' } }] } }),
      exec({ modelId: 'p/b', role: 'voter', response: { choices: [{ message: { content: 'B says Y' } }] } }),
      exec({ modelId: 'p/c', role: 'synthesizer', response: { choices: [{ message: { content: 'final synthesis' } }] } }),
    ], true);
    expect(entries.map((e) => `${e.role}:${e.content}`)).toEqual([
      'voter:A says X',
      'voter:B says Y',
      'synthesizer:final synthesis',
    ]);
  });
});
