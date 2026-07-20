// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityTester } from '../capabilities';

function createSineWaveWavFixture(
  durationMs: number = 500,
  sampleRate: number = 16000,
  frequencyHz: number = 440
): Buffer {
  const numSamples = Math.max(1, Math.floor((durationMs / 1000) * sampleRate));
  const bytesPerSample = 2; // PCM16
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const amplitude = 0.25;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * amplitude;
    const pcm = Math.max(-1, Math.min(1, sample)) * 32767;
    buffer.writeInt16LE(Math.round(pcm), 44 + i * bytesPerSample);
  }

  return buffer;
}

/**
 * Speech-to-text capability probe using a valid WAV fixture.
 * Success criterion is transport/execution correctness (provider returns text field),
 * not transcript semantic accuracy for synthetic tone audio.
 */
export const speechToTextTest: CapabilityTester = async ({ client }) => {
  const testAudio = createSineWaveWavFixture();

  const result = await client.speechToText({
    audio: testAudio,
    language: 'en',
  });

  const transcript = typeof result.text === 'string' ? result.text : '';
  const success = typeof result.text === 'string';

  return {
    success,
    score: success ? 0.75 : 0,
    metadata: {
      fixtureBytes: testAudio.length,
      transcriptLength: transcript.length,
      transcriptPreview: transcript.slice(0, 200),
      raw: result.raw,
    },
  };
};

/**
 * Text-to-speech capability probe.
 */
export const textToSpeechTest: CapabilityTester = async ({ client }) => {
  const text = 'This is a speech synthesis capability validation probe.';

  const result = await client.textToSpeech({
    text,
    voice: 'default',
    format: 'mp3',
  });

  const minSizeBytes = 1000;
  const success = Buffer.isBuffer(result.audio) && result.audio.length > minSizeBytes;

  return {
    success,
    score: success ? 0.85 : 0,
    metadata: {
      bytes: result.audio.length,
      format: result.format,
    },
  };
};
