// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-no-name-hardcode.test.ts — MVP 8A
 *
 * Source-level lint: production files in src/core/contribution/ must
 * NOT branch on any model family or provider name. Model identifiers
 * are opaque keys.
 *
 * Fixtures and tests are EXEMPT — they need names for narrative clarity.
 * This test reads only the production .ts files.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'historical-execution-types.ts': resolve(__dirname, '..', 'historical-execution-types.ts'),
  'model-task-performance-profile.ts': resolve(__dirname, '..', 'model-task-performance-profile.ts'),
  'model-harm-profile.ts': resolve(__dirname, '..', 'model-harm-profile.ts'),
  'pair-contribution-profile.ts': resolve(__dirname, '..', 'pair-contribution-profile.ts'),
  'historical-contribution-scorer.ts': resolve(__dirname, '..', 'historical-contribution-scorer.ts'),
  'contribution-aware-candidate-scorer.ts': resolve(__dirname, '..', 'contribution-aware-candidate-scorer.ts'),
  'contribution-explanation.ts': resolve(__dirname, '..', 'contribution-explanation.ts'),
};

const sourceContent: Record<string, string> = {};
for (const [name, path] of Object.entries(SOURCES)) {
  try {
    sourceContent[name] = readFileSync(path, 'utf-8');
  } catch {
    sourceContent[name] = '__FILE_NOT_FOUND__';
  }
}

describe('contribution sources — sanity load', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} loaded`, () => {
      expect(content.length).toBeGreaterThan(0);
      expect(content).not.toBe('__FILE_NOT_FOUND__');
    });
  }
});

describe('contribution — no .includes( in sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use .includes(`, () => {
      expect(content).not.toContain('.includes(');
    });
  }
});

describe('contribution — no RegExp / "regex" in sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use RegExp`, () => {
      expect(content).not.toContain('RegExp');
    });
    it(`${name} does NOT contain "regex" (case-insensitive)`, () => {
      expect(content.toLowerCase()).not.toContain('regex');
    });
  }
});

describe('contribution — no family-name regex literals', () => {
  const FORBIDDEN_LITERALS = [
    '/gpt/i',
    '/kimi/i',
    '/gemini/i',
    '/claude/i',
    '/grok/i',
    '/deepseek/i',
    '/mistral/i',
    '/llama/i',
    '/qwen/i',
    '/minimax/i',
    '/nemotron/i',
  ];
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT contain family-name regex literals`, () => {
      for (const literal of FORBIDDEN_LITERALS) {
        expect(content).not.toContain(literal);
      }
    });
  }
});

describe('contribution — no model-family-name string literals', () => {
  const FORBIDDEN_STRINGS = [
    "'gpt'",
    '"gpt"',
    "'claude'",
    '"claude"',
    "'gemini'",
    '"gemini"',
    "'kimi'",
    '"kimi"',
    "'grok'",
    '"grok"',
    "'deepseek'",
    '"deepseek"',
    "'qwen'",
    '"qwen"',
    "'llama'",
    '"llama"',
    "'mistral'",
    '"mistral"',
    "'minimax'",
    '"minimax"',
    "'nemotron'",
    '"nemotron"',
  ];
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT contain family-name string literals`, () => {
      for (const literal of FORBIDDEN_STRINGS) {
        expect(content).not.toContain(literal);
      }
    });
  }
});

describe('contribution — no provider-name string literals', () => {
  const FORBIDDEN_PROVIDERS = [
    "'openai'",
    '"openai"',
    "'anthropic'",
    '"anthropic"',
    "'google'",
    '"google"',
    "'openrouter'",
    '"openrouter"',
    "'aihubmix'",
    '"aihubmix"',
    "'cometapi'",
    '"cometapi"',
  ];
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT contain provider-name string literals`, () => {
      for (const literal of FORBIDDEN_PROVIDERS) {
        expect(content).not.toContain(literal);
      }
    });
  }
});
