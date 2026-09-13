// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * proactive-code-file-extra.test.ts
 *
 * Coverage for the code-block -> downloadable-file enrichment (see
 * proactive-code-file-extra.ts's module doc comment for the full design).
 * Mirrors proactive-structured-extras.test.ts's structure: false-positive
 * avoidance gets equal billing with the happy path.
 */
import { describe, it, expect, vi } from 'vitest';
// This module transitively imports FileGenerationService, which statically
// imports every format library it supports (docx/exceljs/jszip/pdfkit/
// pptxgenjs) regardless of which format a given call actually uses. Only
// the 'code' format is exercised below — pptxgenjs is mocked purely to keep
// this suite hermetic and independent of a heavy, entirely-unused rendering
// dependency (production code is untouched; this only affects the test
// module graph).
vi.mock('pptxgenjs', () => ({ default: class {} }));
import { buildProactiveCodeFileArtifact } from '../proactive-code-file-extra';

/** Builds a fenced code block with `linesCount` distinct, non-trivial lines
 *  (well above the module's MIN_CODE_LINES/MIN_CODE_CHARS thresholds) tagged
 *  with `language` (or untagged when omitted/empty). */
function makeCodeFence(language: string, linesCount = 16): string {
  const body = Array.from(
    { length: linesCount },
    (_, i) => `    value_${i} = ${i} * 2  # computed line number ${i}`
  ).join('\n');
  return ['```' + language, 'def compute():', body, '    return value_0'].join('\n') + '\n```';
}

const PYTHON_UTILITY_MODULE = `"""Simple utility module used for the proactive code-file extra test."""


def fibonacci(n):
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(n - 1):
        a, b = b, a + b
    return b


def is_prime(n):
    if n < 2:
        return False
    for divisor in range(2, int(n ** 0.5) + 1):
        if n % divisor == 0:
            return False
    return True


def main():
    for i in range(10):
        print(fibonacci(i), is_prime(i))


if __name__ == "__main__":
    main()`;

const JS_HELPER_MODULE = `function greet(name) {
  return \`Hello, \${name}!\`;
}

function farewell(name) {
  return \`Goodbye, \${name}!\`;
}

function shout(text) {
  return text.toUpperCase() + '!!!';
}

function whisper(text) {
  return text.toLowerCase() + '...';
}

console.log(greet('World'));
console.log(farewell('World'));
console.log(shout('done'));
console.log(whisper('done'));`;

describe('buildProactiveCodeFileArtifact — positive case', () => {
  it('attaches a file ArtifactRef for a large, well-formed, tagged code block', async () => {
    const content = `Here's a Python utility module that covers both cases:\n\n\`\`\`python\n${PYTHON_UTILITY_MODULE}\n\`\`\`\n\nLet me know if you'd like tests for it.`;
    const artifact = await buildProactiveCodeFileArtifact(content);

    expect(artifact).toBeDefined();
    expect(artifact?.type).toBe('file');
    expect(artifact?.mimeType).toBe('text/plain');
    expect(artifact?.url).toMatch(/^data:text\/plain;base64,/);

    const base64 = artifact!.url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    expect(decoded).toContain('def fibonacci');
    expect(decoded).toContain('def is_prime');

    expect(artifact?.meta?.source).toBe('proactive_code_file');
    expect(artifact?.meta?.language).toBe('python');
    expect(artifact?.meta?.filename).toMatch(/^code_snippet\.py$/);
  });

  it('picks the LARGEST qualifying block when the response contains several', async () => {
    const content = [
      'Here are two implementations you might find useful.',
      '',
      'First, a small JS helper module:',
      '',
      '```javascript',
      JS_HELPER_MODULE,
      '```',
      '',
      'And a more complete Python utility module:',
      '',
      '```python',
      PYTHON_UTILITY_MODULE,
      '```',
      '',
      "Let me know if you'd like tests for either one.",
    ].join('\n');

    const artifact = await buildProactiveCodeFileArtifact(content);
    expect(artifact).toBeDefined();
    // The Python block is substantially longer (more lines, longer lines) —
    // it must win over the qualifying-but-smaller JS block.
    expect(artifact?.meta?.language).toBe('python');
  });

  it.each([
    ['python', 'py'],
    ['javascript', 'js'],
    ['rust', 'rs'],
  ])('derives a .%s file for a %s-tagged block', async (language, expectedExtension) => {
    const content = `Sure, here you go:\n\n${makeCodeFence(language)}\n\nHope that helps.`;
    const artifact = await buildProactiveCodeFileArtifact(content);
    expect(artifact).toBeDefined();
    expect(artifact?.meta?.filename).toBe(`code_snippet.${expectedExtension}`);
  });
});

describe('buildProactiveCodeFileArtifact — false-positive avoidance (negative cases)', () => {
  it('does NOT trigger on a short plain-text answer with no code at all', async () => {
    expect(
      await buildProactiveCodeFileArtifact('The capital of France is Paris. It has been the capital since 508 AD.')
    ).toBeUndefined();
  });

  it('does NOT trigger on a tiny, tagged inline snippet', async () => {
    const content = "Here's a one-liner:\n\n```python\ndef add(a, b):\n    return a + b\n```\n\nThat's it.";
    expect(await buildProactiveCodeFileArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on a large UNTAGGED fenced block (pseudocode is routinely untagged)', async () => {
    const content = `You'd structure it roughly like this:\n\n${makeCodeFence('')}\n\nAdapt it to your actual language.`;
    expect(await buildProactiveCodeFileArtifact(content)).toBeUndefined();
  });

  it.each([['text'], ['plaintext'], ['txt']])(
    'does NOT trigger on a large block tagged with the generic "%s" placeholder',
    async (genericTag) => {
      const content = `Output looked like this:\n\n${makeCodeFence(genericTag)}\n\nNothing further to note.`;
      expect(await buildProactiveCodeFileArtifact(content)).toBeUndefined();
    }
  );

  it('does NOT trigger on a large block tagged with an unrecognized/unknown language', async () => {
    const content = `Here's the sample:\n\n${makeCodeFence('definitely-not-a-real-language')}\n\nDone.`;
    expect(await buildProactiveCodeFileArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on an UNTERMINATED fenced block (no closing fence at all)', async () => {
    const content = `Here's the start of it:\n\n\`\`\`python\n${PYTHON_UTILITY_MODULE}\n\n(response cuts off here without a closing fence)`;
    expect(await buildProactiveCodeFileArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger when finishReason is "length", even for an otherwise-qualifying block', async () => {
    const content = `Here you go:\n\n\`\`\`python\n${PYTHON_UTILITY_MODULE}\n\`\`\``;
    expect(await buildProactiveCodeFileArtifact(content, 'length')).toBeUndefined();
    // Sanity check: the SAME content without finishReason='length' DOES qualify.
    expect(await buildProactiveCodeFileArtifact(content, 'stop')).toBeDefined();
  });

  it('handles empty/whitespace-only input without throwing', async () => {
    expect(await buildProactiveCodeFileArtifact('')).toBeUndefined();
    expect(await buildProactiveCodeFileArtifact('   \n  ')).toBeUndefined();
  });

  it('handles pathologically large input by skipping rather than doing unbounded work', async () => {
    const huge = `Here you go:\n\n\`\`\`python\n${PYTHON_UTILITY_MODULE}\n\`\`\`\n`.repeat(2_000);
    expect(huge.length).toBeGreaterThan(200_000);
    expect(await buildProactiveCodeFileArtifact(huge)).toBeUndefined();
  });
});
