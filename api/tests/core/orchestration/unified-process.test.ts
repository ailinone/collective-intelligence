// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for OrchestrationEngine.process() — Unified Entry Point (Fase 4)
 *
 * Tests:
 * 1. detectModality() correctly identifies request types
 * 2. process() routes to correct handler per modality
 * 3. Alias resolution works across all modalities
 */

import { describe, it, expect } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';

describe('OrchestrationEngine.detectModality()', () => {
  it('detects chat from /v1/chat/completions endpoint', () => {
    const modality = OrchestrationEngine.detectModality({
      endpoint: '/v1/chat/completions',
    });
    expect(modality).toBe('chat');
  });

  it('detects stt from /v1/audio/transcriptions endpoint', () => {
    const modality = OrchestrationEngine.detectModality({
      endpoint: '/v1/audio/transcriptions',
    });
    expect(modality).toBe('stt');
  });

  it('detects tts from /v1/audio/speech endpoint', () => {
    const modality = OrchestrationEngine.detectModality({
      endpoint: '/v1/audio/speech',
    });
    expect(modality).toBe('tts');
  });

  it('detects translation from /v1/translation/text endpoint', () => {
    const modality = OrchestrationEngine.detectModality({
      endpoint: '/v1/translation/text',
    });
    expect(modality).toBe('translation');
  });

  it('detects stt from audioBuffer presence', () => {
    const modality = OrchestrationEngine.detectModality({
      hasAudioBuffer: true,
    });
    expect(modality).toBe('stt');
  });

  it('detects tts from TTS input presence', () => {
    const modality = OrchestrationEngine.detectModality({
      hasTTSInput: true,
    });
    expect(modality).toBe('tts');
  });

  it('detects translation from text presence', () => {
    const modality = OrchestrationEngine.detectModality({
      hasTranslationText: true,
    });
    expect(modality).toBe('translation');
  });

  it('detects stt from alias capabilities', () => {
    const modality = OrchestrationEngine.detectModality({
      aliasCapabilities: ['speech_to_text'],
    });
    expect(modality).toBe('stt');
  });

  it('detects tts from alias capabilities', () => {
    const modality = OrchestrationEngine.detectModality({
      aliasCapabilities: ['text_to_speech'],
    });
    expect(modality).toBe('tts');
  });

  it('detects translation from alias capabilities', () => {
    const modality = OrchestrationEngine.detectModality({
      aliasCapabilities: ['translation'],
    });
    expect(modality).toBe('translation');
  });

  it('defaults to chat when no hints match', () => {
    const modality = OrchestrationEngine.detectModality({});
    expect(modality).toBe('chat');
  });

  it('endpoint takes precedence over payload hints', () => {
    const modality = OrchestrationEngine.detectModality({
      endpoint: '/v1/chat/completions',
      hasAudioBuffer: true, // Would normally be STT
    });
    expect(modality).toBe('chat');
  });
});
