// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `extractExecutableCodeBlock` / `resolveExecutableCodeRequest` (ADR-026) —
 * the "WHAT to run" half of real code execution, layered on top of
 * `detectCodeExecutionIntent`'s existing "should we even try" signal (see
 * `code-execution-intent-detection.test.ts`, unchanged by ADR-026).
 *
 * The core invariant under test: this module NEVER guesses a language. A
 * fenced block with no tag, or a tag it does not recognize, yields `null` —
 * not a best-effort default — because silently assuming a language would
 * risk running code as the WRONG interpreter.
 */
import { describe, expect, it } from 'vitest';
import {
  extractExecutableCodeBlock,
  resolveExecutableCodeRequest,
} from '../capability-inference';

describe('extractExecutableCodeBlock', () => {
  it('extracts a python-tagged fenced block', () => {
    const result = extractExecutableCodeBlock('Run this:\n```python\nprint(1)\n```');
    expect(result).toEqual({ language: 'python', code: 'print(1)\n' });
  });

  it('recognizes common aliases for each language', () => {
    for (const tag of ['python', 'python3', 'py']) {
      expect(extractExecutableCodeBlock(`\`\`\`${tag}\nprint(1)\n\`\`\``)?.language).toBe('python');
    }
    for (const tag of ['javascript', 'js', 'node', 'nodejs']) {
      expect(extractExecutableCodeBlock(`\`\`\`${tag}\nconsole.log(1)\n\`\`\``)?.language).toBe(
        'javascript'
      );
    }
  });

  it('is case-insensitive on the language tag', () => {
    expect(extractExecutableCodeBlock('```Python\nprint(1)\n```')?.language).toBe('python');
    expect(extractExecutableCodeBlock('```PYTHON3\nprint(1)\n```')?.language).toBe('python');
  });

  it('returns null for an untagged fenced block — never guesses', () => {
    expect(extractExecutableCodeBlock('```\nprint(1)\n```')).toBeNull();
  });

  it('returns null for a fenced block in an unrecognized/unsupported language', () => {
    expect(extractExecutableCodeBlock('```ruby\nputs 1\n```')).toBeNull();
    expect(extractExecutableCodeBlock('```bash\necho 1\n```')).toBeNull();
    expect(extractExecutableCodeBlock('```rust\nfn main() {}\n```')).toBeNull();
  });

  it('returns null when there is no fenced block at all', () => {
    expect(extractExecutableCodeBlock('Execute this code for me please')).toBeNull();
  });

  it('returns null for an empty fenced block', () => {
    expect(extractExecutableCodeBlock('```python\n\n```')).toBeNull();
    expect(extractExecutableCodeBlock('```python\n   \n```')).toBeNull();
  });

  it('uses the FIRST fenced block when multiple are present', () => {
    const text = '```python\nprint("first")\n```\nand also\n```python\nprint("second")\n```';
    expect(extractExecutableCodeBlock(text)?.code).toBe('print("first")\n');
  });

  it('preserves the code body exactly, including internal blank lines and indentation', () => {
    const text = '```python\ndef f():\n    return 1\n\nprint(f())\n```';
    expect(extractExecutableCodeBlock(text)?.code).toBe('def f():\n    return 1\n\nprint(f())\n');
  });
});

describe('resolveExecutableCodeRequest — combines intent + extraction', () => {
  it('returns the language+code when BOTH genuine intent and a supported fenced block are present', () => {
    const result = resolveExecutableCodeRequest(
      'Execute este codigo Python em sandbox e me mostre o resultado real:\n```python\nprint(sum(range(1, 101)))\n```'
    );
    expect(result).toEqual({ language: 'python', code: 'print(sum(range(1, 101)))\n' });
  });

  it('returns null when there is a fenced block but NO execution intent (an ordinary coding question)', () => {
    expect(
      resolveExecutableCodeRequest('Can you review this code?\n```python\nprint(1)\n```')
    ).toBeNull();
  });

  it('returns null when there is genuine intent but no extractable code (fall back to the honesty directive)', () => {
    expect(resolveExecutableCodeRequest('Please execute this script for me')).toBeNull();
    expect(resolveExecutableCodeRequest('Run this code and show me the real output')).toBeNull();
  });

  it('returns null when there is intent and a fenced block, but the language is unsupported', () => {
    expect(
      resolveExecutableCodeRequest('Execute this code:\n```ruby\nputs sum\n```')
    ).toBeNull();
  });

  it('returns null for an untagged fenced block even with clear intent — never guesses the language', () => {
    expect(resolveExecutableCodeRequest('Execute this code:\n```\nprint(1)\n```')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveExecutableCodeRequest('')).toBeNull();
  });
});
