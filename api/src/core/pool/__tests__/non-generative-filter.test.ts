// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the non-generative model exclusion (2026-06-30). The catalog mis-tags
 * rerankers / embeddings / decoding-method repos as `chat`; a live `consensus`
 * call selected them as voters on a math task. This filter excludes such model
 * CLASSES (not specific ids) so they cannot enter chat / collective-voting pools.
 */
import { describe, it, expect } from 'vitest';
import { isNonGenerativeModel } from '../non-generative-filter';

const m = (id: string, capabilities: string[] = []) =>
  ({ id, capabilities }) as unknown as Parameters<typeof isNonGenerativeModel>[0];

describe('isNonGenerativeModel', () => {
  it('excludes embedding models even when (falsely) tagged chat', () => {
    expect(
      isNonGenerativeModel(
        m('openai/text-embedding-3-small', ['chat', 'text_generation', 'embedding'])
      )
    ).toBe(true);
    expect(isNonGenerativeModel(m('text-embedding-3-small', ['embedding', 'embeddings']))).toBe(
      true
    );
  });

  it('excludes rerankers even when (falsely) tagged chat/text_generation', () => {
    expect(
      isNonGenerativeModel(m('jina-ai/jina-reranker-v3', ['chat', 'text_generation', 'streaming']))
    ).toBe(true);
    expect(isNonGenerativeModel(m('voyage-multilingual-2', ['chat']))).toBe(true);
  });

  it('excludes HF decoding-method demo repos mis-tagged as chat', () => {
    expect(
      isNonGenerativeModel(m('transformers-community/group-beam-search', ['chat', 'web_search']))
    ).toBe(true);
    expect(
      isNonGenerativeModel(m('transformers-community/contrastive-search', ['chat', 'web_search']))
    ).toBe(true);
  });

  it('excludes pure audio + forced-search endpoints', () => {
    expect(isNonGenerativeModel(m('mistralai/voxtral-small-latest', ['chat']))).toBe(true);
    expect(isNonGenerativeModel(m('openai/gpt-4o-search-preview', ['chat']))).toBe(true);
    expect(isNonGenerativeModel(m('openai/gpt-5-search-api', ['chat']))).toBe(true);
  });

  it('KEEPS real generative chat models, including strong multimodal ones', () => {
    expect(isNonGenerativeModel(m('openai/gpt-5.5', ['chat', 'text_generation']))).toBe(false);
    expect(
      isNonGenerativeModel(m('anthropic/claude-opus-4.8', ['chat', 'vision', 'text_generation']))
    ).toBe(false);
    expect(isNonGenerativeModel(m('moonshotai/Kimi-K2.6', ['chat']))).toBe(false);
    expect(
      isNonGenerativeModel(m('Qwen/Qwen3-235B-A22B-Thinking-2507', ['chat', 'reasoning']))
    ).toBe(false);
    // genuine VLM that chats — NOT excluded (quality ranking handles weak ones)
    expect(
      isNonGenerativeModel(
        m('qwen/qwen3-vl-30b-a3b-instruct', ['multimodal', 'vision', 'chat', 'text_generation'])
      )
    ).toBe(false);
  });

  // 2026-08-26: the same class recurred with a different model family, and this
  // time it was measured. Probing production with "17 x 23" returned wrong answers
  // 29% of the time, and the models being selected for a plain TEXT chat request
  // included a speech-recognition model and a text-to-speech model.
  //
  // Capability data cannot be trusted to exclude them. `inferModelCapabilities`
  // decides chat eligibility from a FAMILY-NAME regex over the id, so
  // `gemini-2.5-flash-preview-tts` matches /\bgemini\b/ and `Qwen/Qwen3-ASR-0.6B`
  // matches /\bqwen\b/ — both are persisted with ['chat','text_generation',
  // 'streaming']. The classifier that would have said "tts"/"asr" only runs when
  // the family regex yields nothing, so on these rows it never runs at all, and
  // `metadata.endpoint` is derived from those same capabilities (circular).
  //
  // The pre-existing `text-to-speech` / `speech-to-text` spellings do not match
  // the `-tts` / `-ASR-` forms vendors actually ship.
  describe('speech models mis-tagged as chat (observed in production)', () => {
    it.each([['gemini-2.5-flash-preview-tts'], ['Qwen/Qwen3-ASR-0.6B'], ['tts-1-hd']])(
      'excludes %s even when tagged chat/text_generation',
      (id) => {
        expect(isNonGenerativeModel(m(id, ['chat', 'text_generation', 'streaming']))).toBe(true);
      }
    );

    it.each([
      ['Qwen/Qwen3-VL-2B-Instruct'],
      ['meta-llama/Llama-3.2-1B-Instruct'],
      ['Qwen/Qwen2.5-Coder-7B-Instruct'],
      ['anthropic/claude-opus-4-5'],
      ['deepseek-v3.2-exp'],
      ['openai/gpt-oss-120b'],
      ['mistralai/Mistral-7B-Instruct'],
    ])('keeps %s — a small or specialised model is still a chat model', (id) => {
      // These were also observed being selected, and some of them answered
      // wrongly — but that is a RANKING problem, not a modality one. Excluding
      // them here would shrink the legitimate pool to fix the wrong bug.
      expect(isNonGenerativeModel(m(id, ['chat', 'text_generation']))).toBe(false);
    });

    it('matches the tts/asr tokens only at boundaries', () => {
      // A bare /tts/ or /asr/ would hit unrelated ids.
      expect(isNonGenerativeModel(m('acme/pattsy-7b', ['chat']))).toBe(false);
      expect(isNonGenerativeModel(m('org/disaster-recovery-model', ['chat']))).toBe(false);
    });
  });

  it('does not false-positive on names that merely contain "research"/"search" substrings', () => {
    expect(isNonGenerativeModel(m('some/research-assistant-70b', ['chat']))).toBe(false);
  });

  it('excludes xAI Grok Imagine image/video-generation models even when tagged chat', () => {
    expect(isNonGenerativeModel(m('grok-imagine-image', ['chat', 'streaming']))).toBe(true);
    expect(isNonGenerativeModel(m('grok-imagine-video', ['chat', 'streaming']))).toBe(true);
    expect(isNonGenerativeModel(m('grok-imagine-video-1.5-preview', ['chat', 'streaming']))).toBe(
      true
    );
  });

  it('excludes computer-use agent models even when tagged chat', () => {
    expect(isNonGenerativeModel(m('snowball-computer-use-no-safety', ['chat', 'streaming']))).toBe(
      true
    );
  });

  it('excludes the Grok build/agentic-coding model even when tagged chat', () => {
    expect(isNonGenerativeModel(m('grok-build-0.1', ['chat', 'streaming']))).toBe(true);
  });

  it('does not false-positive real chat models on "build"/"imagine"/"use" substrings', () => {
    expect(isNonGenerativeModel(m('grok-4-fast', ['chat']))).toBe(false);
    expect(isNonGenerativeModel(m('some/instruction-builder-7b', ['chat']))).toBe(false);
    expect(isNonGenerativeModel(m('anthropic/claude-opus-4.8', ['chat']))).toBe(false);
  });

  it('excludes sentence-embedding families whose ids flatten the org prefix (c3-v4 leak)', () => {
    // The exact model that voted in a live consensus math task: hub listings
    // flatten `intfloat/multilingual-e5-base` → `intfloat-multilingual-e5-base`,
    // so the old `^e5-` anchor never matched and it entered the pool as 'chat'.
    expect(
      isNonGenerativeModel(m('intfloat-multilingual-e5-base', ['chat', 'text_generation']))
    ).toBe(true);
    expect(isNonGenerativeModel(m('intfloat/multilingual-e5-large', ['chat']))).toBe(true);
    expect(isNonGenerativeModel(m('BAAI-bge-large-en-v1.5', ['chat']))).toBe(true);
    expect(isNonGenerativeModel(m('thenlper-gte-base', ['chat']))).toBe(true);
    expect(isNonGenerativeModel(m('sentence-transformers-all-MiniLM-L6-v2', ['chat']))).toBe(true);
    expect(isNonGenerativeModel(m('setu4993-LaBSE', ['chat']))).toBe(true);
    // guardrail against over-matching: real chat models with these letters survive
    expect(isNonGenerativeModel(m('google/gemma-3-27b', ['chat']))).toBe(false);
    expect(isNonGenerativeModel(m('mistralai/mistral-large', ['chat']))).toBe(false);
  });
});
