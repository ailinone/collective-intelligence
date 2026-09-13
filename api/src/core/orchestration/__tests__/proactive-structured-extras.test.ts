// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * proactive-structured-extras.test.ts
 *
 * Coverage for the text-response table→chart enrichment (see
 * proactive-structured-extras.ts's module doc comment for the full design).
 * False-positive avoidance gets equal billing with the happy path per the
 * task's own instructions: a feature that decorates every response with
 * noise is worse than no feature, so every deliberate exclusion from the
 * trigger condition has its own explicit test below.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMarkdownTables,
  parseNumericCell,
  computeNumericColumns,
  isChartWorthyComparisonTable,
  renderComparisonBarChartSvg,
  buildProactiveTableChartArtifact,
  type ParsedMarkdownTable,
} from '../proactive-structured-extras';

const MODEL_COMPARISON_TABLE = `Here is a comparison of the three models you asked about:

| Model | Price ($/1M tok) | Speed (tok/s) | Quality Score |
|-------|-------------------|----------------|----------------|
| Alpha | 15 | 120 | 92 |
| Beta | 3 | 60 | 78 |
| Gamma | 8 | 95 | 85 |
| Delta | 20 | 140 | 96 |

Alpha is the best all-rounder if budget allows.`;

describe('parseMarkdownTables', () => {
  it('parses a well-formed GFM table with leading/trailing pipes', () => {
    const tables = parseMarkdownTables(MODEL_COMPARISON_TABLE);
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(['Model', 'Price ($/1M tok)', 'Speed (tok/s)', 'Quality Score']);
    expect(tables[0].rows).toHaveLength(4);
    expect(tables[0].rows[0]).toEqual(['Alpha', '15', '120', '92']);
  });

  it('parses a table without leading/trailing pipes', () => {
    const content = 'Model | Score\n---|---\nA | 1\nB | 2\nC | 3';
    const tables = parseMarkdownTables(content);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ]);
  });

  it('accepts alignment colons in the separator row', () => {
    const content = '| A | B |\n|:--|--:|\n| x | 1 |\n| y | 2 |\n| z | 3 |';
    expect(parseMarkdownTables(content)).toHaveLength(1);
  });

  it('does NOT match a header-shaped line with no valid separator row beneath it', () => {
    const content = '| A | B |\nJust some prose, not a separator.\n| x | 1 |';
    expect(parseMarkdownTables(content)).toHaveLength(0);
  });

  it('stops a table at the first row whose column count differs', () => {
    const content = '| A | B |\n|---|---|\n| 1 | 2 |\n| only-one-cell |\n| 3 | 4 |';
    const tables = parseMarkdownTables(content);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([['1', '2']]);
  });

  it('ignores markdown-table-shaped text inside a fenced code block', () => {
    const content =
      'Here is a shell pipeline example:\n\n```bash\n# | col1 | col2 |\n# |---|---|\n# | a | 1 |\n# | b | 2 |\n# | c | 3 |\ncat file | grep foo | sort\n```\n\nThat pipes output through three stages.';
    expect(parseMarkdownTables(content)).toHaveLength(0);
  });

  it('returns an empty array for content with no tables', () => {
    expect(parseMarkdownTables('The capital of France is Paris.')).toEqual([]);
  });

  it('handles empty/whitespace input without throwing', () => {
    expect(parseMarkdownTables('')).toEqual([]);
    expect(parseMarkdownTables('   \n  ')).toEqual([]);
  });
});

describe('parseNumericCell', () => {
  it.each([
    ['92', 92],
    ['-3.5', -3.5],
    ['1,234', 1234],
    ['$15', 15],
    ['45%', 45],
    ['  10  ', 10],
    ['0', 0],
  ])('parses %s as %s', (raw, expected) => {
    expect(parseNumericCell(raw)).toBe(expected);
  });

  it.each([
    ['TBD', 'placeholder text'],
    ['N/A', 'na token'],
    ['-', 'empty dash'],
    ['', 'empty string'],
    ['10-20', 'a range'],
    ['3.5x', 'a unit suffix'],
    ['5 GB', 'a unit word'],
    ['fast', 'free text'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseNumericCell(raw)).toBeUndefined();
  });
});

describe('computeNumericColumns', () => {
  it('flags a column only when EVERY data row parses as numeric', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Item', 'Clean', 'Dirty'],
      rows: [
        ['a', '1', '1'],
        ['b', '2', 'TBD'],
        ['c', '3', '3'],
      ],
    };
    expect(computeNumericColumns(table)).toEqual([1]);
  });

  it('never counts column 0 (the label column) even if it looks numeric', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Rank', 'Score'],
      rows: [
        ['1', '10'],
        ['2', '20'],
      ],
    };
    expect(computeNumericColumns(table)).toEqual([1]);
  });
});

describe('isChartWorthyComparisonTable', () => {
  it('is worthy: 4 rows x 3 numeric columns', () => {
    const tables = parseMarkdownTables(MODEL_COMPARISON_TABLE);
    expect(isChartWorthyComparisonTable(tables[0])).toBe(true);
  });

  it('is NOT worthy: a small 2x2 table (2 rows, 1 numeric column)', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Item', 'Count'],
      rows: [
        ['a', '1'],
        ['b', '2'],
      ],
    };
    expect(isChartWorthyComparisonTable(table)).toBe(false);
  });

  it('is NOT worthy: enough rows but only ONE numeric column', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Model', 'Score', 'Notes'],
      rows: [
        ['Alpha', '92', 'great all-rounder'],
        ['Beta', '78', 'budget option'],
        ['Gamma', '85', 'balanced'],
      ],
    };
    expect(isChartWorthyComparisonTable(table)).toBe(false);
  });

  it('is NOT worthy: enough columns but only TWO rows', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Model', 'Price', 'Speed'],
      rows: [
        ['Alpha', '15', '120'],
        ['Beta', '3', '60'],
      ],
    };
    expect(isChartWorthyComparisonTable(table)).toBe(false);
  });

  it('is NOT worthy: a numeric-looking column disqualified by one inconsistent cell', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Model', 'Price', 'Speed'],
      rows: [
        ['Alpha', '15', '120'],
        ['Beta', '3', 'TBD'],
        ['Gamma', '8', '95'],
      ],
    };
    // Only "Price" is fully numeric across all rows — "Speed" is disqualified.
    expect(computeNumericColumns(table)).toEqual([1]);
    expect(isChartWorthyComparisonTable(table)).toBe(false);
  });
});

describe('renderComparisonBarChartSvg', () => {
  it('renders a valid SVG document with one bar per (row, numeric column) pair', () => {
    const tables = parseMarkdownTables(MODEL_COMPARISON_TABLE);
    const table = tables[0];
    const numericColumns = computeNumericColumns(table);
    const svg = renderComparisonBarChartSvg(table, numericColumns);

    expect(svg).toMatch(/^<svg /);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(
      table.rows.length * numericColumns.length
    );
    // Legend includes every compared dimension's header text.
    expect(svg).toContain('Price');
    expect(svg).toContain('Speed');
    expect(svg).toContain('Quality Score');
    // Row labels appear (possibly truncated) in the chart.
    expect(svg).toContain('Alpha');
  });

  it('escapes XML-significant characters in labels/headers', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Item <x>', 'A & B', 'C > D'],
      rows: [
        ['<script>', '1', '2'],
        ['b', '3', '4'],
        ['c', '5', '6'],
      ],
    };
    const svg = renderComparisonBarChartSvg(table, [1, 2]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('A &amp; B');
  });

  it('does not divide by zero when a numeric column is all zeros', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Item', 'Zero', 'Also Zero'],
      rows: [
        ['a', '0', '0'],
        ['b', '0', '0'],
        ['c', '0', '0'],
      ],
    };
    const svg = renderComparisonBarChartSvg(table, [1, 2]);
    expect(svg).not.toContain('NaN');
  });

  it('widens the viewBox to fit the legend when there are few rows but many numeric columns', () => {
    const table: ParsedMarkdownTable = {
      headers: ['Item', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      rows: [
        ['a', '1', '2', '3', '4', '5', '6'],
        ['b', '2', '3', '4', '5', '6', '7'],
        ['c', '3', '4', '5', '6', '7', '8'],
      ],
    };
    const numericColumns = [1, 2, 3, 4, 5, 6];
    const svg = renderComparisonBarChartSvg(table, numericColumns);
    const widthMatch = /width="(\d+)"/.exec(svg);
    expect(widthMatch).toBeDefined();
    const width = Number(widthMatch![1]);
    // Legend needs leftMargin*2 (32) + 6 columns * 120px = 752; the bars
    // themselves (3 narrow rows) would need far less — the viewBox must grow
    // to fit the legend, not clip it.
    expect(width).toBeGreaterThanOrEqual(752);
  });
});

describe('buildProactiveTableChartArtifact — positive case', () => {
  it('attaches a chart ArtifactRef for a genuine multi-row/multi-column comparison table', () => {
    const artifact = buildProactiveTableChartArtifact(MODEL_COMPARISON_TABLE);
    expect(artifact).toBeDefined();
    expect(artifact?.type).toBe('image');
    expect(artifact?.mimeType).toBe('image/svg+xml');
    expect(artifact?.url).toMatch(/^data:image\/svg\+xml;base64,/);

    const base64 = artifact!.url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    expect(decoded).toContain('<svg');
    expect(decoded).toContain('Alpha');

    expect(artifact?.meta?.source).toBe('proactive_table_chart');
    expect(artifact?.meta?.labelColumn).toBe('Model');
    expect(artifact?.meta?.columns).toEqual(['Price ($/1M tok)', 'Speed (tok/s)', 'Quality Score']);
    expect(artifact?.meta?.totalRows).toBe(4);
    expect(artifact?.meta?.truncated).toBe(false);
  });
});

describe('buildProactiveTableChartArtifact — false-positive avoidance (negative cases)', () => {
  it('does NOT trigger on a short plain-text answer with no table at all', () => {
    expect(
      buildProactiveTableChartArtifact('The capital of France is Paris. It has been the capital since 508 AD.')
    ).toBeUndefined();
  });

  it('does NOT trigger on a small 2x2 table that is not chart-worthy', () => {
    const content = 'Quick summary:\n\n| Item | Count |\n|---|---|\n| Apples | 3 |\n| Oranges | 5 |\n';
    expect(buildProactiveTableChartArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on inline pseudocode that is not a real complete file (and is not a table)', () => {
    const content =
      "You'd structure the loop roughly like this:\n\n```\nfor item in collection:\n    | process(item)  # pseudocode, not real syntax\n    | if done: break\n```\n\nThat's the general shape — you'll need to adapt it to your actual language.";
    expect(buildProactiveTableChartArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on a table with enough rows but only one numeric dimension', () => {
    const content =
      'Model | Score | Notes\n---|---|---\nAlpha | 92 | great all-rounder\nBeta | 78 | budget option\nGamma | 85 | balanced choice';
    expect(buildProactiveTableChartArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger on a comparison table embedded inside a fenced code block', () => {
    const content =
      '```markdown\n| Model | Price | Speed |\n|---|---|---|\n| Alpha | 15 | 120 |\n| Beta | 3 | 60 |\n| Gamma | 8 | 95 |\n```\n\nThat is example markdown syntax, not a real recommendation.';
    expect(buildProactiveTableChartArtifact(content)).toBeUndefined();
  });

  it('does NOT trigger when a numeric-looking column is disqualified by one inconsistent cell', () => {
    const content =
      'Model | Price | Speed\n---|---|---\nAlpha | 15 | 120\nBeta | 3 | TBD\nGamma | 8 | 95';
    expect(buildProactiveTableChartArtifact(content)).toBeUndefined();
  });

  it('handles empty/whitespace-only input without throwing', () => {
    expect(buildProactiveTableChartArtifact('')).toBeUndefined();
    expect(buildProactiveTableChartArtifact('   \n  ')).toBeUndefined();
  });

  it('handles pathologically large input by skipping rather than doing unbounded work', () => {
    const huge = `${MODEL_COMPARISON_TABLE}\n`.repeat(20_000);
    expect(huge.length).toBeGreaterThan(200_000);
    expect(buildProactiveTableChartArtifact(huge)).toBeUndefined();
  });
});

describe('buildProactiveTableChartArtifact — truncation bookkeeping', () => {
  it('marks meta.truncated when the table exceeds the render caps', () => {
    const header = '| Model | C1 | C2 | C3 | C4 | C5 | C6 | C7 |';
    const sep = '|---|---|---|---|---|---|---|---|';
    const rows = Array.from(
      { length: 20 },
      (_, i) => `| Model${i} | 1 | 2 | 3 | 4 | 5 | 6 | 7 |`
    );
    const content = [header, sep, ...rows].join('\n');
    const artifact = buildProactiveTableChartArtifact(content);
    expect(artifact).toBeDefined();
    expect(artifact?.meta?.truncated).toBe(true);
    expect(artifact?.meta?.totalRows).toBe(20);
  });
});
