// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * proactive-document-extra.test.ts
 *
 * Coverage for the prose/data-summary -> downloadable-document/CSV
 * enrichment (see proactive-document-extra.ts's module doc comment for the
 * full design). Mirrors proactive-structured-extras.test.ts's structure:
 * false-positive avoidance gets equal billing with the happy path, since
 * "structured prose" is an even fuzzier signal than a markdown table.
 */
import { describe, it, expect, vi } from 'vitest';
// This module transitively imports FileGenerationService, which statically
// imports every format library it supports (docx/exceljs/jszip/pdfkit/
// pptxgenjs) regardless of which format a given call actually uses. Only
// the 'csv' and 'markdown' formats are exercised below — pptxgenjs is
// mocked purely to keep this suite hermetic and independent of a heavy,
// entirely-unused rendering dependency (production code is untouched; this
// only affects the test module graph).
vi.mock('pptxgenjs', () => ({ default: class {} }));
import {
  parseRecordLine,
  findRecordListCsv,
  countHeadings,
  buildProactiveDocumentArtifact,
} from '../proactive-document-extra';

const UNIFORM_RECORD_LIST = `Here are this quarter's top performers:

- Name: Alice, Score: 92
- Name: Bob, Score: 78
- Name: Carla, Score: 85
- Name: Diego, Score: 81
- Name: Elena, Score: 90
- Name: Farid, Score: 88
- Name: Gina, Score: 95
- Name: Hugo, Score: 70

Let me know if you want more detail on any of these.`;

const STRUCTURED_REPORT = `# Quarterly Engineering Report

## Overview
This quarter the platform team shipped three major initiatives focused on reliability, latency, and developer velocity. Overall uptime improved to 99.95 percent, driven largely by the new deployment pipeline and the expanded on-call rotation introduced in the second month of the quarter.

## Highlights
The most significant win was the migration of the request routing layer to the new consensus-based selection engine, which cut median latency by roughly eighteen percent across all regions. The team also closed out a long-standing backlog of flaky integration tests, bringing the suite's pass rate from eighty-one percent to ninety-nine percent.

## Risks
Capacity planning remains a concern heading into the next quarter: current growth projections suggest the primary database cluster will need a vertical scale-up within ninety days. A remediation plan is already being drafted with the infrastructure team, and a dedicated on-call runbook is being written to cover the transition window.

## Next Steps
The team will prioritize the database scale-up, continue hardening the deployment pipeline, and begin a pilot of the new observability stack in a single region before a broader rollout. A follow-up review is scheduled for the middle of next quarter to confirm the migration met its latency and reliability targets before it is declared complete.`;

describe('parseRecordLine', () => {
  it('parses a comma-separated run of "Label: value" pairs', () => {
    const parsed = parseRecordLine('Name: Alice, Age: 30, Role: Engineer');
    expect(parsed).toEqual({
      labelsKey: 'name age role',
      labels: ['Name', 'Age', 'Role'],
      values: ['Alice', '30', 'Engineer'],
    });
  });

  it('rejects a line where a segment has no colon at all ("Pros: fast, cheap")', () => {
    expect(parseRecordLine('Pros: fast, cheap')).toBeUndefined();
  });

  it('rejects a line with only ONE field (below MIN_FIELDS_PER_RECORD)', () => {
    expect(parseRecordLine('Note: remember to save your work')).toBeUndefined();
  });

  it('rejects a segment with an empty value', () => {
    expect(parseRecordLine('Label: , Other: value')).toBeUndefined();
  });

  it('rejects a segment with an empty label (colon at position 0)', () => {
    expect(parseRecordLine(': value, Other: value')).toBeUndefined();
  });

  it('rejects a segment whose label exceeds MAX_RECORD_LABEL_LENGTH', () => {
    const longLabel = 'A'.repeat(41);
    expect(parseRecordLine(`${longLabel}: value, Other: value`)).toBeUndefined();
  });
});

describe('findRecordListCsv', () => {
  it('returns the shared headers/rows for a uniform list of >= MIN_RECORD_ROWS records', () => {
    const csv = findRecordListCsv(UNIFORM_RECORD_LIST);
    expect(csv).toBeDefined();
    expect(csv?.headers).toEqual(['Name', 'Score']);
    expect(csv?.rows).toHaveLength(8);
    expect(csv?.rows[0]).toEqual(['Alice', '92']);
  });

  it('returns undefined when the largest uniform group is below MIN_RECORD_ROWS', () => {
    const content = `- Name: Alice, Score: 92\n- Name: Bob, Score: 78\n- Name: Carla, Score: 85\n- Name: Diego, Score: 81\n- Name: Elena, Score: 90`;
    expect(findRecordListCsv(content)).toBeUndefined();
  });

  it('ignores an unrelated one-off "label: value" bullet when picking the largest group', () => {
    const content = `${UNIFORM_RECORD_LIST}\n\n- Note: this list is provisional`;
    const csv = findRecordListCsv(content);
    expect(csv).toBeDefined();
    expect(csv?.rows).toHaveLength(8);
  });

  it('does NOT count a group with inconsistent field shape toward the threshold (no partial credit)', () => {
    const content = [
      '- Name: Alice, Score: 92',
      '- Name: Bob, Score: 78',
      '- Name: Carla, Age: 30, City: NYC',
      '- Name: Diego, Score: 81',
      '- Name: Elena, Score: 90',
      '- Name: Farid, Score: 88',
    ].join('\n');
    // Largest group ("name score") has only 5 members — the odd
    // "Age"/"City" line forms its own separate group of 1.
    expect(findRecordListCsv(content)).toBeUndefined();
  });

  it('does NOT treat a numbered list of plain instructions as records (no colons at all)', () => {
    const content = [
      '1. Open the configuration file.',
      '2. Locate the timeout setting.',
      '3. Change the value to 30.',
      '4. Save the file.',
      '5. Restart the service.',
      '6. Verify the new timeout is active.',
    ].join('\n');
    expect(findRecordListCsv(content)).toBeUndefined();
  });
});

describe('countHeadings', () => {
  it('counts markdown ATX headings of any level', () => {
    expect(countHeadings(STRUCTURED_REPORT)).toBe(5);
  });

  it('does not count prose lines that merely start with a hash-like character', () => {
    expect(countHeadings('#tag is not a heading\nNor is #this since there is no space.')).toBe(0);
  });

  it('returns 0 for content with no headings', () => {
    expect(countHeadings('Just a plain paragraph of text with no structure at all.')).toBe(0);
  });
});

describe('buildProactiveDocumentArtifact — positive cases', () => {
  it('attaches a CSV ArtifactRef for a flat list of uniform data records', async () => {
    const artifact = await buildProactiveDocumentArtifact(UNIFORM_RECORD_LIST);
    expect(artifact).toBeDefined();
    expect(artifact?.type).toBe('file');
    expect(artifact?.mimeType).toBe('text/csv');
    expect(artifact?.url).toMatch(/^data:text\/csv;base64,/);

    const base64 = artifact!.url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    expect(decoded).toContain('Name,Score');
    expect(decoded).toContain('Alice,92');

    expect(artifact?.meta?.source).toBe('proactive_document_export');
    expect(artifact?.meta?.reason).toBe('response_contains_flat_list_of_uniform_records');
    expect(artifact?.meta?.recordCount).toBe(8);
  });

  it('attaches a markdown document ArtifactRef for a long, multi-section report', async () => {
    expect(STRUCTURED_REPORT.length).toBeGreaterThan(1200);
    const artifact = await buildProactiveDocumentArtifact(STRUCTURED_REPORT);
    expect(artifact).toBeDefined();
    expect(artifact?.type).toBe('document');
    expect(artifact?.mimeType).toBe('text/markdown');
    expect(artifact?.url).toMatch(/^data:text\/markdown;base64,/);

    const base64 = artifact!.url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    // The model's own markdown is materialized VERBATIM — no re-rendering.
    expect(decoded).toBe(STRUCTURED_REPORT);

    expect(artifact?.meta?.source).toBe('proactive_document_export');
    expect(artifact?.meta?.reason).toBe('response_is_long_structured_report');
    expect(artifact?.meta?.headingCount).toBe(5);
  });
});

describe('buildProactiveDocumentArtifact — false-positive avoidance (negative cases)', () => {
  it('does NOT trigger on a short conversational answer', async () => {
    expect(
      await buildProactiveDocumentArtifact('The capital of France is Paris. It has been the capital since 508 AD.')
    ).toBeUndefined();
  });

  it('does NOT trigger on long unstructured prose with no headings and no records', async () => {
    const longProse = 'This is a perfectly ordinary, moderately long conversational answer. '.repeat(30);
    expect(longProse.length).toBeGreaterThan(1200);
    expect(await buildProactiveDocumentArtifact(longProse)).toBeUndefined();
  });

  it('does NOT trigger with only 2 headings (below MIN_HEADINGS), even if long', async () => {
    const content = `# Quarterly Engineering Report

Overall uptime improved to 99.95 percent this quarter, driven largely by the new deployment pipeline and the expanded on-call rotation introduced in the second month of the quarter. The most significant win was the migration of the request routing layer to the new consensus-based selection engine, which cut median latency by roughly eighteen percent across all regions.

## Risks
Capacity planning remains a concern heading into the next quarter: current growth projections suggest the primary database cluster will need a vertical scale-up within ninety days. A remediation plan is already being drafted with the infrastructure team, and the team will prioritize this work alongside continued hardening of the deployment pipeline and a pilot of the new observability stack in a single region before a broader rollout. The rollout itself will be staged across three regions over six weeks, with a dedicated rollback plan documented for each stage in case latency regresses beyond the agreed error budget. A follow-up review is scheduled for the middle of next quarter to confirm the migration met its latency and reliability targets before it is declared complete. Additional headcount for the on-call rotation has also been approved, and onboarding for the two new engineers joining that rotation is expected to wrap up well before the scale-up work begins in earnest.`;
    // Isolate the property under test: this content is deliberately LONG
    // ENOUGH to pass the length gate, so the only reason it must not
    // trigger is the heading count (2, below MIN_HEADINGS).
    expect(content.length).toBeGreaterThan(1200);
    expect(countHeadings(content)).toBe(2);
    expect(await buildProactiveDocumentArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger when heading count qualifies but overall content is a short skeleton', async () => {
    const content = '# A\n\n## B\n\n## C\n\nShort.';
    expect(countHeadings(content)).toBe(3);
    expect(await buildProactiveDocumentArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on fewer than MIN_RECORD_ROWS uniform record lines', async () => {
    const content = `- Name: Alice, Score: 92\n- Name: Bob, Score: 78\n- Name: Carla, Score: 85\n- Name: Diego, Score: 81\n- Name: Elena, Score: 90`;
    expect(await buildProactiveDocumentArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on record-shaped bullets with inconsistent fields across lines', async () => {
    const content = [
      '- Name: Alice, Score: 92',
      '- Name: Bob, Score: 78',
      '- Name: Carla, Age: 30, City: NYC',
      '- Name: Diego, Score: 81',
      '- Name: Elena, Score: 90',
      '- Name: Farid, Score: 88',
    ].join('\n');
    expect(await buildProactiveDocumentArtifact(content)).toBeUndefined();
  });

  it('does NOT count headings or records that only appear inside a fenced code block', async () => {
    const content = [
      "Here's a snippet for reference:",
      '',
      '```yaml',
      '# Config Report',
      'name: value, other: value',
      'name: value2, other: value2',
      'name: value3, other: value3',
      'name: value4, other: value4',
      'name: value5, other: value5',
      'name: value6, other: value6',
      '```',
      '',
      'Thanks!',
    ].join('\n');
    expect(await buildProactiveDocumentArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on a numbered list of plain instructions (no data fields)', async () => {
    const content = [
      '1. Open the configuration file.',
      '2. Locate the timeout setting.',
      '3. Change the value to 30.',
      '4. Save the file.',
      '5. Restart the service.',
      '6. Verify the new timeout is active.',
    ].join('\n');
    expect(await buildProactiveDocumentArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger when finishReason is "length", even for otherwise-qualifying content', async () => {
    expect(await buildProactiveDocumentArtifact(UNIFORM_RECORD_LIST, 'length')).toBeUndefined();
    expect(await buildProactiveDocumentArtifact(STRUCTURED_REPORT, 'length')).toBeUndefined();
    // Sanity check: the SAME content without finishReason='length' DOES qualify.
    expect(await buildProactiveDocumentArtifact(UNIFORM_RECORD_LIST, 'stop')).toBeDefined();
    expect(await buildProactiveDocumentArtifact(STRUCTURED_REPORT, 'stop')).toBeDefined();
  });

  it('handles empty/whitespace-only input without throwing', async () => {
    expect(await buildProactiveDocumentArtifact('')).toBeUndefined();
    expect(await buildProactiveDocumentArtifact('   \n  ')).toBeUndefined();
  });

  it('handles pathologically large input by skipping rather than doing unbounded work', async () => {
    const huge = `${UNIFORM_RECORD_LIST}\n`.repeat(5_000);
    expect(huge.length).toBeGreaterThan(200_000);
    expect(await buildProactiveDocumentArtifact(huge)).toBeUndefined();
  });
});
