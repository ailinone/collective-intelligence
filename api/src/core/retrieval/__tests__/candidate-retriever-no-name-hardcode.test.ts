// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retriever-no-name-hardcode.test.ts — MVP 5A
 *
 * Verifies that the FOUR production source files of MVP 5A do NOT
 * contain decisional hardcoding by model name or family. The same
 * pattern used in MVP 4's `model-scorer-no-regex.test.ts`.
 *
 * Files checked:
 *   - candidate-retriever.ts
 *   - candidate-filters.ts
 *   - candidate-sorter.ts
 *   - model-capability-document-builder.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'candidate-retriever.ts': resolve(__dirname, '..', 'candidate-retriever.ts'),
  'candidate-filters.ts': resolve(__dirname, '..', 'candidate-filters.ts'),
  'candidate-sorter.ts': resolve(__dirname, '..', 'candidate-sorter.ts'),
  'model-capability-document-builder.ts': resolve(
    __dirname,
    '../../capabilities/model-capability-document-builder.ts',
  ),
};

const sourceContent: Record<string, string> = {};
for (const [name, path] of Object.entries(SOURCES)) {
  try {
    sourceContent[name] = readFileSync(path, 'utf-8');
  } catch {
    sourceContent[name] = '__FILE_NOT_FOUND__';
  }
}

// Pre-check the source files all loaded.
describe('source files — sanity load', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} loaded`, () => {
      expect(content.length).toBeGreaterThan(0);
      expect(content).not.toBe('__FILE_NOT_FOUND__');
    });
  }
});

describe('no .includes( in production sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use .includes(`, () => {
      expect(content).not.toContain('.includes(');
    });
  }
});

describe('no RegExp class in production sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT use RegExp`, () => {
      expect(content).not.toContain('RegExp');
    });
  }
});

describe('no "regex" word in production sources', () => {
  for (const [name, content] of Object.entries(sourceContent)) {
    it(`${name} does NOT contain "regex" (case-insensitive)`, () => {
      expect(content.toLowerCase()).not.toContain('regex');
    });
  }
});

describe('no family-name regex literals in production sources', () => {
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

describe('no model family-name string literals in production sources', () => {
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
