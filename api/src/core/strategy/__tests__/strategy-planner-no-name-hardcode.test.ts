// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-no-name-hardcode.test.ts — MVP 5B
 *
 * Source-level lint: the strategy planner / policy / validator MUST
 * NOT contain decisional hardcoding by model name or provider name.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'strategy-planner.ts': resolve(__dirname, '..', 'strategy-planner.ts'),
  'strategy-policy.ts': resolve(__dirname, '..', 'strategy-policy.ts'),
  'strategy-plan-validator.ts': resolve(__dirname, '..', 'strategy-plan-validator.ts'),
};

const sourceContent: Record<string, string> = {};
for (const [name, path] of Object.entries(SOURCES)) {
  try {
    sourceContent[name] = readFileSync(path, 'utf-8');
  } catch {
    sourceContent[name] = '__FILE_NOT_FOUND__';
  }
}

describe('strategy sources — sanity load', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} loaded`, () => {
      expect(content.length).toBeGreaterThan(0);
      expect(content).not.toBe('__FILE_NOT_FOUND__');
    });
  }
});

describe('no .includes( in strategy sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use .includes(`, () => {
      expect(content).not.toContain('.includes(');
    });
  }
});

describe('no RegExp / "regex" in strategy sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use RegExp`, () => {
      expect(content).not.toContain('RegExp');
    });
    it(`${name} does NOT contain "regex" (case-insensitive)`, () => {
      expect(content.toLowerCase()).not.toContain('regex');
    });
  }
});

describe('no family-name regex literals in strategy sources', () => {
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
  ];
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT contain family-name regex literals`, () => {
      for (const literal of FORBIDDEN_LITERALS) {
        expect(content).not.toContain(literal);
      }
    });
  }
});

describe('no model family-name string literals in strategy sources', () => {
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
  ];
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT contain family-name string literals`, () => {
      for (const literal of FORBIDDEN_STRINGS) {
        expect(content).not.toContain(literal);
      }
    });
  }
});

describe('no provider-name string literals in strategy sources', () => {
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
