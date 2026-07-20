// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-no-name-hardcode.test.ts — MVP 8C.0
 *
 * The shadow layer must NOT branch on any model/provider family name.
 * Identifiers may appear only in tests/fixtures, not production.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'shadow-routing-types.ts': resolve(__dirname, '..', 'shadow-routing-types.ts'),
  'shadow-routing-config.ts': resolve(__dirname, '..', 'shadow-routing-config.ts'),
  'shadow-routing-sampling.ts': resolve(__dirname, '..', 'shadow-routing-sampling.ts'),
  'shadow-routing-redaction.ts': resolve(__dirname, '..', 'shadow-routing-redaction.ts'),
  'shadow-routing-logger.ts': resolve(__dirname, '..', 'shadow-routing-logger.ts'),
  'shadow-routing-metrics.ts': resolve(__dirname, '..', 'shadow-routing-metrics.ts'),
  'shadow-routing-service.ts': resolve(__dirname, '..', 'shadow-routing-service.ts'),
};

const content: Record<string, string> = {};
for (const [n, p] of Object.entries(SOURCES)) {
  try {
    content[n] = readFileSync(p, 'utf-8');
  } catch {
    content[n] = '__NOT_FOUND__';
  }
}

describe('shadow routing — sanity load', () => {
  for (const [name, src] of Object.entries(content)) {
    it(`${name} loaded`, () => {
      expect(src.length).toBeGreaterThan(0);
      expect(src).not.toBe('__NOT_FOUND__');
    });
  }
});

describe('shadow routing — no family-name regex literals', () => {
  const FORBIDDEN = [
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
  for (const [name, src] of Object.entries(content)) {
    it(`${name} no family-name regex literals`, () => {
      for (const f of FORBIDDEN) expect(src).not.toContain(f);
    });
  }
});

describe('shadow routing — no family-name string literals', () => {
  const FORBIDDEN = [
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
  for (const [name, src] of Object.entries(content)) {
    it(`${name} no family-name string literals`, () => {
      for (const f of FORBIDDEN) expect(src).not.toContain(f);
    });
  }
});

describe('shadow routing — no provider-name literals', () => {
  const FORBIDDEN = [
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
  for (const [name, src] of Object.entries(content)) {
    it(`${name} no provider-name literals`, () => {
      for (const f of FORBIDDEN) expect(src).not.toContain(f);
    });
  }
});
