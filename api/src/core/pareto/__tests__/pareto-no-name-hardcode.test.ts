// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-no-name-hardcode.test.ts — MVP 8A
 *
 * Source-level lint for the Pareto production layer.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'cost-quality-frontier.ts': resolve(__dirname, '..', 'cost-quality-frontier.ts'),
  'pareto-ensemble-optimizer.ts': resolve(__dirname, '..', 'pareto-ensemble-optimizer.ts'),
  'collective-selection-policy.ts': resolve(__dirname, '..', 'collective-selection-policy.ts'),
  'ensemble-plan-types.ts': resolve(__dirname, '..', 'ensemble-plan-types.ts'),
  'ensemble-plan-validator.ts': resolve(__dirname, '..', 'ensemble-plan-validator.ts'),
};

const sourceContent: Record<string, string> = {};
for (const [name, path] of Object.entries(SOURCES)) {
  try {
    sourceContent[name] = readFileSync(path, 'utf-8');
  } catch {
    sourceContent[name] = '__FILE_NOT_FOUND__';
  }
}

describe('pareto sources — sanity load', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} loaded`, () => {
      expect(content.length).toBeGreaterThan(0);
      expect(content).not.toBe('__FILE_NOT_FOUND__');
    });
  }
});

describe('pareto — no .includes(', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use .includes(`, () => {
      expect(content).not.toContain('.includes(');
    });
  }
});

describe('pareto — no RegExp / "regex"', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use RegExp`, () => {
      expect(content).not.toContain('RegExp');
    });
    it(`${name} does NOT contain "regex" (case-insensitive)`, () => {
      expect(content.toLowerCase()).not.toContain('regex');
    });
  }
});

describe('pareto — no family-name regex literals', () => {
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

describe('pareto — no model-family-name string literals', () => {
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

describe('pareto — no provider-name string literals', () => {
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
