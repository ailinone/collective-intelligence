// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test reproducing the exact production incident (2026-09): a
 * chat request — "Execute este codigo Python em sandbox e me mostre o
 * resultado real: print(sum(range(1, 101)))" — got a single garbage letter
 * ("y") as its entire response instead of the correct answer (5050).
 *
 * `detectCodeExecutionIntent` is the narrow, precise "please actually RUN
 * this and give me the real output" detector used by
 * execution-system-prompt.ts to inject an honesty directive (no fake tool
 * call, no bare-fragment answer — reason the result out and say so). It is
 * deliberately NOT the same signal as the broad CODING_KEYWORDS/
 * CODING_PHRASES detection that feeds `requiredCapabilities` for model
 * selection (that one intentionally fires on ordinary coding questions,
 * which is safe there because it resolves to the well-populated
 * `code_generation` catalog tag — see the doc comment in
 * capability-inference.ts above this function for the full rationale).
 */
import { describe, expect, it } from 'vitest';
import { detectCodeExecutionIntent } from '../capability-inference';

describe('detectCodeExecutionIntent', () => {
  it('detects the exact reproduced production incident text (pt-BR)', () => {
    expect(
      detectCodeExecutionIntent(
        'Execute este codigo Python em sandbox e me mostre o resultado real: print(sum(range(1, 101)))'
      )
    ).toBe(true);
  });

  it('detects an equivalent English phrasing', () => {
    expect(
      detectCodeExecutionIntent(
        'Run this code and show me the real output: print(sum(range(1, 101)))'
      )
    ).toBe(true);
  });

  it('detects "execute this script" phrasing', () => {
    expect(detectCodeExecutionIntent('Please execute this script for me')).toBe(true);
  });

  it('detects a bare execute-verb + fenced code block, even without an explicit noun', () => {
    expect(detectCodeExecutionIntent('Execute:\n```python\nprint(1)\n```')).toBe(true);
  });

  it('detects "rode esse código" (pt-BR "run" verb)', () => {
    expect(detectCodeExecutionIntent('Pode rodar esse código pra mim e me falar o resultado?')).toBe(
      true
    );
  });

  it('does NOT trigger on an ordinary coding question mentioning a language', () => {
    expect(detectCodeExecutionIntent('Can you help me debug my python function?')).toBe(false);
  });

  it('does NOT trigger on "how do I run a python file" style troubleshooting without a target', () => {
    // No code/script/sandbox/program noun near the verb, and no code block —
    // stays on the safe/narrow side per the doc comment's risk calculus.
    expect(detectCodeExecutionIntent('How do I run something with npm?')).toBe(false);
  });

  it('does NOT trigger on unrelated business use of "run the program"', () => {
    expect(detectCodeExecutionIntent('Who should run the onboarding program next quarter?')).toBe(
      false
    );
  });

  it('does NOT trigger on a plain SQL/API question with no execution verb', () => {
    expect(detectCodeExecutionIntent('What does this SQL query do?')).toBe(false);
  });

  it('does NOT trigger on an empty string', () => {
    expect(detectCodeExecutionIntent('')).toBe(false);
  });
});
