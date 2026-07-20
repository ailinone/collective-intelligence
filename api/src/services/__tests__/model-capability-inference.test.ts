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
    const compatibility = inferEndpointCompatibility(
      ['chat', 'function_calling', 'embeddings'],
      {
        endpoint: 'responses',
        supported_endpoints: ['embeddings', 'chat_completions'],
      }
    );

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
});
