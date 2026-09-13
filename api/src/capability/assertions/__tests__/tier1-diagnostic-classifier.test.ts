// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier-1 diagnostic classifier — structural-first grading of the single
 * diagnostic response used by the Tiered Capability Fingerprint's Tier-1
 * probe (`core/orchestration/tier1-diagnostic-probe.ts`).
 *
 * Pins: each of the eight capabilities is graded from a REAL structural
 * trace (numbered list, markdown table, code fence, parseable JSON with
 * expected keys, a second code block, a labeled translation section) —
 * never from vibes, and never confirmed by a response that merely mentions
 * the right words without the actual structural shape.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTier1DiagnosticPrompt,
  classifyTier1StructuralSignals,
  extractTier1StructuralFacts,
  TIER1_PROBED_CAPABILITIES,
} from '../tier1-diagnostic-classifier';

const GOOD_RESPONSE = `
### Step 1: Reasoning
1. The first train travels for (2 + t) hours at 60 km/h when caught.
2. The second train travels for t hours at 90 km/h.
3. Setting distances equal: 60(2 + t) = 90t => 120 = 30t => t = 4.
The second train catches up 4 hours after it departs.

### Step 2: Analysis
| Option | Best for | Weakness |
| --- | --- | --- |
| Relational database | Structured queries | Harder to scale horizontally |
| Key-value store | Fast lookups | No relational queries |
| Object storage | Large blobs | High latency for small reads |

### Step 3: Code
\`\`\`python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\`\`\`

### Step 4: JSON summary
\`\`\`json
{"topic": "trains and fibonacci", "difficulty": "medium", "steps_used": 6}
\`\`\`

### Step 5: Translation
Translation: Il fait beau aujourd'hui, voulez-vous vous promener ?

### Step 6: Refactor
Before:
\`\`\`python
def f(x):
    if x == True:
        return True
    else:
        return False
\`\`\`
After:
\`\`\`python
def f(x):
    return bool(x)
\`\`\`

CONFIDENCE: high
`;

describe('buildTier1DiagnosticPrompt', () => {
  it('asks for all six labeled sections and a confidence tag', () => {
    const prompt = buildTier1DiagnosticPrompt();
    for (const label of [
      'Step 1: Reasoning',
      'Step 2: Analysis',
      'Step 3: Code',
      'Step 4: JSON summary',
      'Step 5: Translation',
      'Step 6: Refactor',
      'CONFIDENCE',
    ]) {
      expect(prompt).toContain(label);
    }
  });
});

describe('TIER1_PROBED_CAPABILITIES', () => {
  it('is exactly the eight capabilities the design specifies', () => {
    expect([...TIER1_PROBED_CAPABILITIES].sort()).toEqual(
      [
        'analysis',
        'chat',
        'code_generation',
        'json_mode',
        'reasoning',
        'refactoring',
        'streaming',
        'translation',
      ].sort()
    );
  });
});

describe('classifyTier1StructuralSignals — real evidence, all present', () => {
  const { verdicts, facts } = classifyTier1StructuralSignals(GOOD_RESPONSE);

  it('confirms chat from the substantive multi-section reply', () => {
    expect(verdicts.chat).toBe('confirmed');
  });
  it('confirms reasoning from the numbered step list', () => {
    expect(facts.hasNumberedSteps).toBe(true);
    expect(verdicts.reasoning).toBe('confirmed');
  });
  it('confirms analysis from the markdown table', () => {
    expect(facts.hasMarkdownTable).toBe(true);
    expect(verdicts.analysis).toBe('confirmed');
  });
  it('confirms code_generation from the fenced code block', () => {
    expect(facts.codeBlockCount).toBeGreaterThanOrEqual(1);
    expect(verdicts.code_generation).toBe('confirmed');
  });
  it('confirms json_mode from the parseable JSON with expected keys', () => {
    expect(facts.jsonSummaryParsed).toBe(true);
    expect(facts.jsonSummaryHasExpectedKeys).toBe(true);
    expect(verdicts.json_mode).toBe('confirmed');
  });
  it('marks translation ambiguous (attempted, but correctness is not regex-verifiable)', () => {
    expect(facts.hasTranslationSection).toBe(true);
    expect(facts.translationContentNonTrivial).toBe(true);
    expect(verdicts.translation).toBe('ambiguous');
  });
  it('confirms refactoring from the two (before/after) code blocks', () => {
    expect(facts.codeBlockCount).toBeGreaterThanOrEqual(2);
    expect(verdicts.refactoring).toBe('confirmed');
  });
  it('defaults streaming to rejected — text alone never confirms it', () => {
    // The probe caller overwrites this from transport-level chunk counting;
    // the classifier itself has no transport information.
    expect(verdicts.streaming).toBe('rejected');
  });
  it('parses the confidence tag', () => {
    expect(facts.confidenceTag).toBe('high');
  });
});

describe('classifyTier1StructuralSignals — absent evidence rejects, does not guess', () => {
  it('rejects everything for an empty response', () => {
    const { verdicts } = classifyTier1StructuralSignals('');
    expect(verdicts.chat).toBe('rejected');
    expect(verdicts.reasoning).toBe('rejected');
    expect(verdicts.analysis).toBe('rejected');
    expect(verdicts.code_generation).toBe('rejected');
    expect(verdicts.json_mode).toBe('rejected');
    expect(verdicts.translation).toBe('rejected');
    expect(verdicts.refactoring).toBe('rejected');
  });

  it('does not confirm reasoning from a single numbered item (needs >=2 to be a real step list)', () => {
    const { verdicts } = classifyTier1StructuralSignals(
      'Here is my one and only point:\n1. Just one step.'.padEnd(220, ' filler')
    );
    expect(verdicts.reasoning).toBe('rejected');
  });

  it('does not confirm analysis from a table-looking line with no separator row', () => {
    const text = '| a | b |\nSome text that is not a separator row at all here'.padEnd(220, ' x');
    const { verdicts } = classifyTier1StructuralSignals(text);
    expect(verdicts.analysis).toBe('rejected');
  });

  it('does not confirm json_mode when the fenced JSON is missing expected keys', () => {
    const text = '```json\n{"foo": "bar"}\n```'.padEnd(220, ' x');
    const { facts, verdicts } = classifyTier1StructuralSignals(text);
    expect(facts.jsonSummaryParsed).toBe(true);
    expect(facts.jsonSummaryHasExpectedKeys).toBe(false);
    expect(verdicts.json_mode).toBe('rejected');
  });

  it('does not confirm json_mode when the fenced block is not valid JSON', () => {
    const text = '```json\n{not valid json at all\n```'.padEnd(220, ' x');
    const { facts, verdicts } = classifyTier1StructuralSignals(text);
    expect(facts.jsonSummaryParsed).toBe(false);
    expect(verdicts.json_mode).toBe('rejected');
  });

  it('rejects translation when the section is missing entirely', () => {
    const text = 'A long enough response with no translation section at all.'.padEnd(220, ' x');
    const { verdicts } = classifyTier1StructuralSignals(text);
    expect(verdicts.translation).toBe('rejected');
  });

  it('rejects translation when the label is present but the content just echoes the English source', () => {
    const text =
      'Translation: The weather is nice today, shall we go for a walk?'.padEnd(220, ' x');
    const { facts, verdicts } = classifyTier1StructuralSignals(text);
    expect(facts.translationContentNonTrivial).toBe(false);
    expect(verdicts.translation).toBe('rejected');
  });

  it('does not confirm refactoring from a single code block (needs before+after)', () => {
    const text = '```python\nprint(1)\n```'.padEnd(220, ' x');
    const { facts, verdicts } = classifyTier1StructuralSignals(text);
    expect(facts.codeBlockCount).toBe(1);
    expect(verdicts.refactoring).toBe('rejected');
  });

  it('does not confirm chat from a short reply below the substantive-reply length bar', () => {
    const { verdicts } = classifyTier1StructuralSignals('ok');
    expect(verdicts.chat).toBe('rejected');
  });
});

describe('extractTier1StructuralFacts', () => {
  it('recognizes numbered steps written as "Step N:" as well as "N."', () => {
    const text = 'Step 1: do this\nStep 2: do that\nStep 3: done'.padEnd(220, ' x');
    const facts = extractTier1StructuralFacts(text);
    expect(facts.hasNumberedSteps).toBe(true);
  });

  it('counts multiple independent fenced code blocks correctly', () => {
    const text = '```js\nconsole.log(1)\n```\nsome text\n```py\nprint(1)\n```'.padEnd(220, ' x');
    const facts = extractTier1StructuralFacts(text);
    expect(facts.codeBlockCount).toBe(2);
  });
});
