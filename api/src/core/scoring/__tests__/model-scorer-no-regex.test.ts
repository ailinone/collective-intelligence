// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-scorer-no-regex.test.ts — MVP 4
 *
 * Proves that `model-scorer.ts` source file does NOT contain:
 *   - `includes(` substring
 *   - `RegExp` substring (case-sensitive — class name)
 *   - the literal string `regex` (case-insensitive)
 *   - any family-name regex literal (`/gpt/i`, `/claude/i`, etc.)
 *
 * The point: the scorer must be purely structural — no decisional
 * branching based on model NAMES via includes/regex.
 *
 * Mechanism: reads the scorer source file with `fs` and runs substring
 * assertions. The test is fast (one file read) and has zero runtime
 * dependencies beyond Node's stdlib.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCORER_PATH = resolve(__dirname, '..', 'model-scorer.ts');

let SCORER_SOURCE = '';
try {
  SCORER_SOURCE = readFileSync(SCORER_PATH, 'utf-8');
} catch {
  SCORER_SOURCE = '__SCORER_FILE_NOT_FOUND__';
}

describe('model-scorer.ts — forbidden patterns are absent', () => {
  it('the file was read OK', () => {
    expect(SCORER_SOURCE.length).toBeGreaterThan(0);
    expect(SCORER_SOURCE).not.toBe('__SCORER_FILE_NOT_FOUND__');
  });

  it('does NOT use `.includes(` (substring matching)', () => {
    // The forbidden pattern is the exact string we'd grep for: `.includes(`.
    // Note: `Set.has(...)` and `Map.has(...)` are allowed; `.includes(` is not.
    expect(SCORER_SOURCE).not.toContain('.includes(');
  });

  it('does NOT use `RegExp` (class)', () => {
    expect(SCORER_SOURCE).not.toContain('RegExp');
  });

  it('does NOT use the literal word `regex` (case-insensitive)', () => {
    expect(SCORER_SOURCE.toLowerCase()).not.toContain('regex');
  });

  it('does NOT use any forbidden family-name regex literals', () => {
    // Each token is the exact text that would appear in source.
    const forbidden = [
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
    for (const f of forbidden) {
      expect(SCORER_SOURCE).not.toContain(f);
    }
  });

  it('does NOT mention family names as decision keys (literal substrings)', () => {
    // Family-name strings are legitimate in TEST fixtures, but the
    // PRODUCTION scorer file must not reference them as decision input.
    const forbiddenStrings = [
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
    ];
    for (const f of forbiddenStrings) {
      expect(SCORER_SOURCE).not.toContain(f);
    }
  });
});
