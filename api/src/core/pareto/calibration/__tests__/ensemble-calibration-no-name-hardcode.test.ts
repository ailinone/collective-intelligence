// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-no-name-hardcode.test.ts — MVP 8B.7
 *
 * Production files must NOT branch on any model family / provider NAME.
 * Tests/fixtures are exempt.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'ensemble-calibration-types.ts': resolve(__dirname, '..', 'ensemble-calibration-types.ts'),
  'peer-lift-calibrator.ts': resolve(__dirname, '..', 'peer-lift-calibrator.ts'),
  'marginal-gain-calibrator.ts': resolve(__dirname, '..', 'marginal-gain-calibrator.ts'),
  'ensemble-expected-judge-estimator.ts': resolve(__dirname, '..', 'ensemble-expected-judge-estimator.ts'),
  'ensemble-lift-policy.ts': resolve(__dirname, '..', 'ensemble-lift-policy.ts'),
  'ensemble-calibrated-optimizer.ts': resolve(__dirname, '..', 'ensemble-calibrated-optimizer.ts'),
  'tasktype-ensemble-approval.ts': resolve(__dirname, '..', 'tasktype-ensemble-approval.ts'),
  'ensemble-calibration-report.ts': resolve(__dirname, '..', 'ensemble-calibration-report.ts'),
};

const content: Record<string, string> = {};
for (const [n, p] of Object.entries(SOURCES)) {
  try {
    content[n] = readFileSync(p, 'utf-8');
  } catch {
    content[n] = '__NOT_FOUND__';
  }
}

describe('ensemble calibration sources — sanity load', () => {
  for (const [name, src] of Object.entries(content)) {
    it(`${name} loaded`, () => {
      expect(src.length).toBeGreaterThan(0);
      expect(src).not.toBe('__NOT_FOUND__');
    });
  }
});

describe('ensemble calibration — no .includes(', () => {
  for (const [name, src] of Object.entries(content)) {
    it(`${name} does NOT use .includes(`, () => {
      expect(src).not.toContain('.includes(');
    });
  }
});

describe('ensemble calibration — no RegExp / "regex"', () => {
  for (const [name, src] of Object.entries(content)) {
    it(`${name} does NOT use RegExp`, () => {
      expect(src).not.toContain('RegExp');
    });
    it(`${name} does NOT contain "regex" (case-insensitive)`, () => {
      expect(src.toLowerCase()).not.toContain('regex');
    });
  }
});

describe('ensemble calibration — no family-name regex literals', () => {
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

describe('ensemble calibration — no model-family-name literals', () => {
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

describe('ensemble calibration — no provider-name literals', () => {
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
    it(`${name} no provider-name string literals`, () => {
      for (const f of FORBIDDEN) expect(src).not.toContain(f);
    });
  }
});
