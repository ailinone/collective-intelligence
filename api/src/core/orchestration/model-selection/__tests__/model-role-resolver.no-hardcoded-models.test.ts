// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * No-hardcoded-models enforcement.
 *
 * Production code in the model-selection subsystem and the planner MUST
 * NOT reference specific provider / model family names. The decision
 * surface is capability-based; family names belong to adapters, tests,
 * and comments only.
 *
 * If a future refactor accidentally introduces a name like 'gpt-4' or
 * 'claude' into a decision branch, this test breaks immediately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_TOKENS: readonly string[] = [
  'gpt',
  'claude',
  'gemini',
  'grok',
  'deepseek',
  'mistral',
  'qwen',
  'llama',
  // We intentionally do NOT include 'openai' / 'anthropic' / 'google' /
  // 'openrouter' / 'minimax' / 'nemotron' here because those tokens
  // legitimately appear in identifier patterns (e.g., provider IDs)
  // even though we don't use them in decisions. Adapters carry them.
  // Family-name model IDs are the real anti-pattern this test catches.
];

const PRODUCTION_FILES: readonly string[] = [
  'src/core/orchestration/model-selection/model-role-types.ts',
  'src/core/orchestration/model-selection/model-role-policy.ts',
  'src/core/orchestration/model-selection/model-role-selection-trace.ts',
  'src/core/orchestration/model-selection/model-role-resolver.ts',
  'src/core/orchestration/strategies/consensus-execution-planner.ts',
  'src/core/orchestration/strategies/consensus-plan-dry-run-service.ts',
];

// Walk up from __tests__ to the `api/` root:
//   __tests__ → model-selection → orchestration → core → src → api
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

function stripCommentsAndStrings(content: string): string {
  // Drop // line comments.
  let result = content.replace(/\/\/.*$/gm, '');
  // Drop /* ... */ block comments.
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop string literals to avoid false positives inside notes/log
  // messages.
  result = result.replace(/'(?:\\.|[^'\\])*'/g, "''");
  result = result.replace(/"(?:\\.|[^"\\])*"/g, '""');
  result = result.replace(/`(?:\\.|[^`\\])*`/g, '``');
  return result;
}

describe('model-selection — no hardcoded model names in decision code', () => {
  for (const relPath of PRODUCTION_FILES) {
    it(`${relPath}: no forbidden tokens in code (comments + strings stripped)`, () => {
      const absPath = join(REPO_ROOT, relPath);
      const raw = readFileSync(absPath, 'utf-8');
      const codeOnly = stripCommentsAndStrings(raw).toLowerCase();
      for (const token of FORBIDDEN_TOKENS) {
        const hits = codeOnly.match(new RegExp(`\\b${token}\\b`, 'g')) ?? [];
        expect(
          hits.length,
          `Forbidden token "${token}" appeared ${hits.length} time(s) in code (not strings/comments) of ${relPath}. Production decision logic must be capability-based, not model-name-based.`,
        ).toBe(0);
      }
    });
  }
});
