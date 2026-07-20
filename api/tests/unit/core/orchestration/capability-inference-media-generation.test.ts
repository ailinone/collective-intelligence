// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import { inferCapabilities } from '@/core/orchestration/capability-inference';

function infer(text: string) {
  return inferCapabilities([{ role: 'user', content: text }]);
}

describe('inferCapabilities — image/audio/video generation', () => {
  it('detects image_generation for en and pt-BR phrasings', () => {
    expect(infer('generate an image of a mountain').requiredCapabilities).toContain('image_generation');
    expect(infer('gere uma imagem de um gato siames').requiredCapabilities).toContain('image_generation');
  });

  it('detects video_generation for en and pt-BR phrasings', () => {
    expect(infer('generate a video of a sunset').requiredCapabilities).toContain('video_generation');
    expect(infer('crie um vídeo de um cachorro correndo').requiredCapabilities).toContain('video_generation');
  });

  // Regression guard (2026-07-16 architecture audit): plain `\b` is
  // ASCII-only, so it never asserts a boundary immediately before a token
  // whose FIRST character is itself accented — `\báudio\b` could never
  // match after a space, making the pt-BR "áudio" noun dead code despite
  // looking correct in review. Fixed via Unicode-aware boundaries.
  it('detects audio_generation for the pt-BR "áudio" noun (previously dead code)', () => {
    expect(infer('gere um áudio narrando este texto').requiredCapabilities).toContain('audio_generation');
    expect(infer('gerar áudio da mensagem').requiredCapabilities).toContain('audio_generation');
  });

  it('detects audio_generation for the accent-less "audio"/"musica"/"narracao" spellings too', () => {
    expect(infer('gere um audio narrando este texto').requiredCapabilities).toContain('audio_generation');
    expect(infer('gere uma musica relaxante').requiredCapabilities).toContain('audio_generation');
  });

  it('detects audio_generation for en phrasings', () => {
    expect(infer('generate audio narrating this text').requiredCapabilities).toContain('audio_generation');
    expect(infer('create a song about the ocean').requiredCapabilities).toContain('audio_generation');
  });
});
