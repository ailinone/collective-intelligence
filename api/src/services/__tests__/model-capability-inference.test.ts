// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  classifyDedicatedSpecialization,
  extractModelModalities,
  inferEndpointCompatibility,
  inferModelCapabilities,
  inferProviderFromModelId,
  inferSupportedEndpoints,
  normalizeOperationEndpoint,
} from '@/services/model-capability-inference';

describe('model-capability-inference', () => {
  it('infers audio-to-audio and transcription capabilities from modalities', () => {
    const capabilities = inferModelCapabilities({
      modelId: 'openai/gpt-audio',
      metadata: {
        architecture: {
          input_modalities: ['text', 'audio'],
          output_modalities: ['text', 'audio'],
        },
        supported_parameters: ['structured_outputs', 'tools'],
      },
    });

    expect(capabilities).toContain('audio');
    expect(capabilities).toContain('listen');
    expect(capabilities).toContain('text_to_speech');
    expect(capabilities).toContain('speech_to_text');
    expect(capabilities).toContain('transcription');
    expect(capabilities).toContain('audio_to_audio');
    expect(capabilities).toContain('realtime_audio');
    expect(capabilities).toContain('chat');
    expect(capabilities).toContain('json_mode');
    expect(capabilities).toContain('function_calling');
  });

  it('infers video understanding and video transcription from video input', () => {
    const capabilities = inferModelCapabilities({
      modelId: 'google/gemini-video-analyzer',
      metadata: {
        architecture: {
          input_modalities: ['video', 'text'],
          output_modalities: ['text'],
        },
      },
    });

    expect(capabilities).toContain('video_understanding');
    expect(capabilities).toContain('video_to_text');
    expect(capabilities).toContain('video_transcription');
    expect(capabilities).toContain('transcription');
  });

  it('infers image-to-video and video generation from modalities', () => {
    const capabilities = inferModelCapabilities({
      modelId: 'google/veo-image2video',
      metadata: {
        architecture: {
          input_modalities: ['image'],
          output_modalities: ['video'],
        },
      },
    });

    expect(capabilities).toContain('image_to_video');
    expect(capabilities).toContain('video_generation');
    expect(capabilities).toContain('multimodal');
    expect(capabilities).toContain('vision');
  });

  it('does not infer video_generation from video understanding-only descriptions', () => {
    const capabilities = inferModelCapabilities({
      modelId: 'openrouter/gemini-video-analyzer',
      metadata: {
        description: 'Model focused on video understanding and video transcription.',
        architecture: {
          input_modalities: ['video', 'text'],
          output_modalities: ['text'],
        },
      },
    });

    expect(capabilities).toContain('video_understanding');
    expect(capabilities).toContain('video_transcription');
    expect(capabilities).not.toContain('video_generation');
  });

  it('infers advanced capabilities from descriptive identifiers', () => {
    const capabilities = inferModelCapabilities({
      modelId: 'openai/deep-search-operator-coder-health',
      metadata: {
        description:
          'Deep research assistant with computer use, coding support and health workflows.',
      },
    });

    expect(capabilities).toContain('deep_search');
    expect(capabilities).toContain('deep_research');
    expect(capabilities).toContain('research');
    expect(capabilities).toContain('computer_use');
    expect(capabilities).toContain('coding');
    expect(capabilities).toContain('health');
  });

  it('keeps embeddings models as non-chat when no text output is present', () => {
    const capabilities = inferModelCapabilities({
      modelId: 'text-embedding-3-large',
      metadata: {
        architecture: {
          input_modalities: ['text'],
          output_modalities: [],
        },
      },
    });

    expect(capabilities).toContain('embedding');
    expect(capabilities).toContain('embeddings');
    expect(capabilities).not.toContain('chat');
  });

  it('extracts modalities and provider prefix safely', () => {
    const modalities = extractModelModalities({
      architecture: {
        input_modalities: ['text', 'audio'],
        output_modalities: ['text'],
      },
    });

    expect(modalities.input).toEqual(expect.arrayContaining(['text', 'audio']));
    expect(modalities.output).toEqual(expect.arrayContaining(['text']));
    expect(inferProviderFromModelId('openai/gpt-5')).toBe('openai');
    expect(inferProviderFromModelId('alibaba@qvq-max')).toBe('alibaba');
    expect(inferProviderFromModelId('workspace123@openai/gpt-4o-mini')).toBe('openai');
    expect(inferProviderFromModelId('gpt-5')).toBeUndefined();
  });

  it('maps inferred capabilities to supported operation endpoints', () => {
    const endpoints = inferSupportedEndpoints(
      [
        'chat',
        'function_calling',
        'image_generation',
        'video_generation',
        'speech_to_text',
        'text_to_speech',
        'realtime',
      ],
      {}
    );

    expect(endpoints).toContain('chat_completions');
    expect(endpoints).toContain('responses');
    expect(endpoints).toContain('images');
    expect(endpoints).toContain('videos');
    expect(endpoints).toContain('audio_speech');
    expect(endpoints).toContain('audio_transcriptions');
    expect(endpoints).toContain('realtime');
  });

  it('marks endpoint compatibility as explicit when declared in metadata', () => {
    const compatibility = inferEndpointCompatibility(['chat', 'function_calling', 'embeddings'], {
      endpoint: 'responses',
      supported_endpoints: ['embeddings', 'chat_completions'],
    });

    expect(compatibility.responses).toBe('explicit');
    expect(compatibility.embeddings).toBe('explicit');
    expect(compatibility.chat_completions).toBe('explicit');
  });

  it('marks endpoint compatibility as inferred when not declared explicitly', () => {
    const compatibility = inferEndpointCompatibility(['chat', 'tts', 'speech_to_text'], {});

    expect(compatibility.chat_completions).toBe('inferred');
    expect(compatibility.audio_speech).toBe('inferred');
    expect(compatibility.audio_transcriptions).toBe('inferred');
  });

  it('normalizes endpoint aliases safely', () => {
    expect(normalizeOperationEndpoint('chat_completions_special')).toBe('chat_completions');
    expect(normalizeOperationEndpoint('stt')).toBe('audio_transcriptions');
    expect(normalizeOperationEndpoint('tts')).toBe('audio_speech');
    expect(normalizeOperationEndpoint('not_a_real_endpoint')).toBeUndefined();
  });

  // ── Production bug (LOTE BA, 2026-09): aggregator-hub metadata fabricating
  //    chat-shaped capabilities on dedicated non-chat endpoints ────────────
  // Confirmed live: llmgateway declares the EXACT SAME `supported_parameters`
  // (temperature, max_tokens, top_p, frequency_penalty, presence_penalty,
  // response_format, tools, tool_choice) for text-embedding-3-small,
  // text-embedding-3-large, gemini-embedding-001, text-embedding-ada-002,
  // etc. — a blanket schema copied across its whole catalog, not a real
  // description of what an embeddings-only endpoint accepts. Trusting it
  // persisted `['streaming','json_mode','function_calling','tool_use',
  // 'embedding','embeddings']` for a pure embeddings model.
  describe('dedicated non-chat endpoints ignore aggregator-hub supported_parameters (LOTE BA)', () => {
    const AGGREGATOR_SUPPORTED_PARAMETERS = [
      'temperature',
      'max_tokens',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'response_format',
      'tools',
      'tool_choice',
    ];

    it('llmgateway/text-embedding-3-small does not get chat-shaped capabilities', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'text-embedding-3-small',
        metadata: { supported_parameters: AGGREGATOR_SUPPORTED_PARAMETERS },
      });

      expect(capabilities).toContain('embedding');
      expect(capabilities).toContain('embeddings');
      for (const bogus of [
        'streaming',
        'json_mode',
        'function_calling',
        'tool_use',
        'chat',
        'text_generation',
      ]) {
        expect(capabilities, bogus).not.toContain(bogus);
      }
    });

    it.each([
      'text-embedding-3-large',
      'text-embedding-ada-002',
      'gemini-embedding-001',
      'voyage-3-large',
    ])('%s ignores the same blanket supported_parameters list', (modelId) => {
      const capabilities = inferModelCapabilities({
        modelId,
        metadata: { supported_parameters: AGGREGATOR_SUPPORTED_PARAMETERS },
      });

      expect(capabilities).toContain('embedding');
      for (const bogus of ['function_calling', 'tool_use', 'streaming', 'json_mode']) {
        expect(capabilities, `${modelId}/${bogus}`).not.toContain(bogus);
      }
    });

    it('a reranker id also ignores the blanket supported_parameters list', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'rerank-english-v3.0',
        metadata: { supported_parameters: AGGREGATOR_SUPPORTED_PARAMETERS },
      });

      expect(capabilities).toContain('reranking');
      for (const bogus of ['function_calling', 'tool_use', 'streaming', 'json_mode']) {
        expect(capabilities, bogus).not.toContain(bogus);
      }
    });

    it('a moderation classifier id also ignores the blanket supported_parameters list', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'omni-moderation-latest',
        metadata: { supported_parameters: AGGREGATOR_SUPPORTED_PARAMETERS },
      });

      expect(capabilities).toContain('moderation');
      for (const bogus of ['function_calling', 'tool_use', 'streaming', 'json_mode']) {
        expect(capabilities, bogus).not.toContain(bogus);
      }
    });

    it('a model with declared text output KEEPS supported_parameters inference (regression guard)', () => {
      // Real chat models must not lose function_calling/streaming just
      // because the guard exists — declared text output is strong evidence
      // the endpoint really is chat-shaped.
      const capabilities = inferModelCapabilities({
        modelId: 'openai/gpt-4o',
        metadata: {
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: AGGREGATOR_SUPPORTED_PARAMETERS,
        },
      });

      expect(capabilities).toContain('function_calling');
      expect(capabilities).toContain('tool_use');
      expect(capabilities).toContain('streaming');
      expect(capabilities).toContain('json_mode');
    });
  });

  // ── Production bug (LOTE BA, 2026-09): gpt-image family missing
  //    image_generation ───────────────────────────────────────────────────
  // Confirmed live on vercel-ai-gateway/poe/fastrouter/routeway: no
  // architecture/capabilities metadata is declared for these hub rows, so
  // `inferModelCapabilities` fell all the way through to the vendor-family
  // `gpt` regex and tagged them chat instead of consulting the (fixed)
  // dedicated-specialisation classifier.
  describe('gpt-image family is classified as image, not chat (LOTE BA)', () => {
    it.each(['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'openai/gpt-image-1-mini'])(
      '%s → image_generation, no chat capabilities, with no declared metadata',
      (modelId) => {
        const capabilities = inferModelCapabilities({ modelId });

        expect(capabilities).toContain('image_generation');
        expect(capabilities).not.toContain('chat');
        expect(capabilities).not.toContain('text_generation');
        expect(capabilities).not.toContain('streaming');
      }
    );

    it('classifyDedicatedSpecialization recognises gpt-image-1 as image, not chat', () => {
      expect(classifyDedicatedSpecialization('gpt-image-1')?.modelType).toBe('image');
      expect(classifyDedicatedSpecialization('openai/gpt-image-1.5')?.modelType).toBe('image');
    });
  });

  // ── `reasoning_effort` supported_parameters entry → `deep_compute`
  //    (SOTA audit, 2026-09-07: `deep_compute` had zero real assignments in
  //    production across every extraction path). `reasoning_effort` is the
  //    real, cross-provider supported_parameters token for a configurable
  //    compute-budget dial (OpenAI o1/o3, xAI grok, Groq's oai-compat
  //    reasoning family — see providers.catalog.ts), distinct from the plain
  //    `reasoning`/`thinking` presence flag already handled above.
  describe('reasoning_effort parameter infers deep_compute (SOTA audit, 2026-09-07)', () => {
    it('adds deep_compute when supported_parameters lists reasoning_effort', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'openai/o3',
        metadata: {
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['reasoning_effort', 'tools'],
        },
      });

      expect(capabilities).toContain('deep_compute');
      expect(capabilities).toContain('reasoning');
      expect(capabilities).toContain('thinking_mode');
    });

    it('does not add deep_compute without a reasoning_effort parameter', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'openai/gpt-4o',
        metadata: {
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['tools', 'response_format'],
        },
      });

      expect(capabilities).not.toContain('deep_compute');
    });

    it('does not add deep_compute on a dedicated non-chat endpoint even if the blanket aggregator list includes reasoning_effort', () => {
      const capabilities = inferModelCapabilities({
        modelId: 'text-embedding-3-small',
        metadata: { supported_parameters: ['reasoning_effort', 'tools'] },
      });

      expect(capabilities).not.toContain('deep_compute');
    });
  });
});
