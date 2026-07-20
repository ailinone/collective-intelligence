// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Inworld AI Dedicated Adapter
 *
 * Extends the OpenAI-compatible hub with Inworld-specific features:
 * - Basic auth (not Bearer) for all endpoints
 * - Router API (OpenAI-compatible chat completions)
 * - Anthropic Messages format support
 * - Custom TTS endpoint (/tts/v1/voice)
 * - Custom STT endpoint (/stt/v1/transcribe) with voice profiling
 * - Voice cloning (/voices/v1/voices:clone)
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import type { Model } from '@/types';
import type {
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
} from '@/types/model-client';

/** Voice sample used for cloning. */
export interface InworldVoiceSample {
  audioData: string;
  transcription: string;
}

/** Result of a voice cloning request. */
export interface InworldVoiceCloneResult {
  voiceId: string;
  raw: unknown;
}

/** STT response from Inworld with voice profiling data. */
export interface InworldSTTResponse extends AudioSTTResponse {
  voiceProfile?: {
    emotion?: string;
    accent?: string;
    age?: string;
    pitch?: string;
  };
}

export class InworldAdapter extends OpenAICompatibleHubAdapter {
  constructor(config: { apiKey: string; baseUrl?: string }) {
    const hubConfig: OpenAICompatibleHubAdapterConfig = {
      name: 'inworld',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.inworld.ai',
      enabled: true,
      providerName: 'inworld',
      displayName: 'Inworld AI',
      metadata: {
        authScheme: 'Basic',
        chatCompletionsPath: '/v1/chat/completions',
        modelListPath: '/router/v1/models',
      },
    };
    super(hubConfig);
  }

  // ---------------------------------------------------------------------------
  // TTS — Inworld uses POST /tts/v1/voice with JSON body
  // ---------------------------------------------------------------------------

  override async textToSpeech(model: Model, request: AudioTTSRequest): Promise<AudioTTSResponse> {
    const modelId = model.name || model.id;
    if (!modelId) {
      throw new Error('No TTS model identifier available — model must have a name or id');
    }
    const outputFormat = request.format || 'mp3';

    const payload: Record<string, unknown> = {
      text: request.text,
      modelId,
      outputFormat,
    };

    if (request.voice) {
      payload.voiceId = request.voice;
    }

    if (request.options?.timestampType) {
      payload.timestampType = request.options.timestampType;
    }

    const response = await this.sendJsonRequestWithRetry({
      path: '/tts/v1/voice',
      operation: 'text-to-speech',
      payload,
    });

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    return {
      audio: audioBuffer,
      format: outputFormat,
      raw: { size: audioBuffer.length },
    };
  }

  // ---------------------------------------------------------------------------
  // STT — Inworld uses POST /stt/v1/transcribe with multipart
  // ---------------------------------------------------------------------------

  override async speechToText(model: Model, request: AudioSTTRequest): Promise<InworldSTTResponse> {
    const normalizedModel = model.name || model.id || 'inworld/inworld-stt-1';
    const filename =
      typeof request.options?.filename === 'string' ? request.options.filename : 'audio.wav';
    const mimeType =
      typeof request.options?.mimeType === 'string' ? request.options.mimeType : 'audio/wav';
    const file = new File(
      [new Blob([new Uint8Array(request.audio)], { type: mimeType })],
      filename,
      { type: mimeType },
    );

    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', normalizedModel);
    if (typeof request.language === 'string') {
      formData.append('language', request.language);
    }

    const response = await this.sendMultipartRequestWithRetry({
      path: '/stt/v1/transcribe',
      operation: 'speech-to-text',
      formData,
    });

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    let text = rawText;
    let raw: unknown = rawText;
    let voiceProfile: InworldSTTResponse['voiceProfile'] | undefined;

    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        raw = parsed;
        if (typeof parsed.text === 'string') {
          text = parsed.text;
        }
        // Extract voice profiling data if present
        if (typeof parsed.transcription === 'string') {
          text = parsed.transcription;
        }
        if (parsed.emotion || parsed.accent || parsed.age || parsed.pitch) {
          voiceProfile = {
            emotion: typeof parsed.emotion === 'string' ? parsed.emotion : undefined,
            accent: typeof parsed.accent === 'string' ? parsed.accent : undefined,
            age: typeof parsed.age === 'string' ? parsed.age : undefined,
            pitch: typeof parsed.pitch === 'string' ? parsed.pitch : undefined,
          };
        }
      } catch {
        // keep text fallback
      }
    }

    return { text, raw, voiceProfile };
  }

  // ---------------------------------------------------------------------------
  // Voice Cloning — POST /voices/v1/voices:clone
  // ---------------------------------------------------------------------------

  async cloneVoice(
    displayName: string,
    langCode: string,
    voiceSamples: InworldVoiceSample[],
  ): Promise<InworldVoiceCloneResult> {
    const payload: Record<string, unknown> = {
      displayName,
      langCode,
      voiceSamples: voiceSamples.map((sample) => ({
        audioData: sample.audioData,
        transcription: sample.transcription,
      })),
    };

    const response = await this.sendJsonRequestWithRetry({
      path: '/voices/v1/voices:clone',
      operation: 'voice-clone',
      payload,
    });

    const result = (await response.json()) as Record<string, unknown>;
    const voiceId =
      typeof result.voiceId === 'string'
        ? result.voiceId
        : typeof result.voice_id === 'string'
          ? result.voice_id
          : typeof result.id === 'string'
            ? result.id
            : '';

    return { voiceId, raw: result };
  }

  // ---------------------------------------------------------------------------
  // Anthropic Messages format — POST /v1/messages
  // ---------------------------------------------------------------------------

  async anthropicMessages(
    messages: unknown[],
    model: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      model,
      messages,
      ...options,
    };

    const response = await this.sendJsonRequestWithRetry({
      path: '/v1/messages',
      operation: 'anthropic-messages',
      payload,
    });

    return response.json();
  }
}
