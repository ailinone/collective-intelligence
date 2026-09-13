// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Proactive structured extras — text-response table-to-chart enrichment.
 *
 * SCOPE (deliberately narrow — see the PR description for the full design
 * rationale and the explicitly-deferred follow-ups):
 *
 * A plain conversational/analytical text response can benefit from a
 * proactively-attached "extra" even when the caller never asked for a file
 * (that explicit path is `code_file_generation`/`file_generation`, a
 * dedicated triage-stage capability — see orchestration-engine.ts). This
 * module implements exactly ONE such extra: when the model's OWN finished
 * text response already contains a genuine multi-row/multi-column markdown
 * comparison table, ALSO render that table as a real chart image and attach
 * it as an `ArtifactRef` via the existing `AilinMetadata.tool_artifacts`
 * pipeline (see `mergeArtifacts()`/`ArtifactRef` in base-strategy.ts and
 * `@/types`) — the same wire shape every other artifact-carrying response
 * already uses. No new artifact mechanism is introduced.
 *
 * Two further extras were deliberately deferred out of this module's first
 * version (promoting a complete code block to a downloadable file, and
 * promoting a prose/data summary to a downloadable document/CSV) — each
 * needed its own conservative trigger design, so bundling them into the
 * original PR would have traded a testable, bounded change for a broad,
 * harder-to-verify one. Both have since shipped as sibling modules following
 * this same pattern (post-hoc scan of the finished text, `ArtifactRef` via
 * `tool_artifacts`, reusing `FileGenerationService` instead of new rendering
 * infrastructure, own kill switch): see `proactive-code-file-extra.ts` and
 * `proactive-document-extra.ts`. All three are wired together in
 * chat-request-processor.ts.
 *
 * TRIGGER DESIGN (the part that actually matters — see task history: an
 * over-eager trigger that decorates every response is worse than no feature,
 * mirroring the inverse of the file-generation-intent regex that once
 * UNDER-triggered). This is intentionally strict on both axes:
 *
 *   - "multi-row": at least {@link MIN_CHART_ROWS} data rows — a 2-row table
 *     (e.g. a before/after pair) is not "comparing several items".
 *   - "multi-column": at least {@link MIN_NUMERIC_COLUMNS} columns (besides
 *     the leading label column) whose cells are ALL confidently numeric
 *     across every row — a table with one numeric column plus prose columns
 *     is not "compared across multiple dimensions" and is left alone. A
 *     table where numeric-looking data is inconsistent (e.g. one row says
 *     "TBD") never counts that column at all — no partial credit.
 *   - Markdown tables embedded inside fenced code blocks (```...```) are
 *     never matched — a code sample that happens to contain pipe characters
 *     (e.g. a Rust `match`, a shell pipeline) must never be misread as a
 *     comparison table.
 *   - Detection runs ENTIRELY post-hoc on the model's already-finished text
 *     (see `buildProactiveTableChartArtifact`'s caller in
 *     chat-request-processor.ts). The model is never asked whether an extra
 *     would help — that would reintroduce the same hallucination-prone
 *     "does the model know when to offer one" problem this design avoids.
 *
 * RENDERING: a small, dependency-free, fully deterministic SVG bar-chart
 * generator (`renderComparisonBarChartSvg`) — no network call, no AI image
 * generation (which would risk inventing numbers instead of plotting the
 * real ones), no new binary dependency. Each numeric column is normalized
 * to ITS OWN max value (not a shared axis) because compared dimensions are
 * routinely heterogeneous units (e.g. "price" vs "rating") — a shared scale
 * would visually misrepresent one of them. The real parsed value is always
 * printed above its bar so the normalization never hides the actual number.
 * The chart is embedded as a `data:image/svg+xml;base64,...` URL: this
 * codebase has no durable object-storage upload path for a LOCALLY rendered
 * asset (every other `ArtifactRef.url` in the codebase is a hosted URL
 * returned by an external provider — see chat-request-processor.ts's
 * `generate_media` tool), and `ArtifactRef.url` is a required, non-optional
 * field (no inline-base64 sibling field exists on that type, unlike
 * `AilinArtifact.b64_json`). A data URL is a real, directly renderable
 * `<img src="...">` value and needs no new upload/storage subsystem.
 */

import type { ArtifactRef } from '@/types';

/** A parsed GFM-style markdown table (pipe-delimited header + separator + data rows). */
export interface ParsedMarkdownTable {
  headers: string[];
  /** Raw string cells, row-major, header/separator rows excluded. */
  rows: string[][];
}

/** See module doc comment — the "multi-row" half of the trigger condition. */
const MIN_CHART_ROWS = 3;
/** See module doc comment — the "multi-column" half of the trigger condition. */
const MIN_NUMERIC_COLUMNS = 2;

/** Defensive cap: skip detection entirely on pathologically large content
 *  (avoids wasted work on a response nobody will read as a table anyway). */
const MAX_CONTENT_LENGTH = 200_000;

/** Rendering caps — keep the generated chart legible and its markup bounded,
 *  even if a table is technically chart-worthy but very large. Excess rows
 *  are dropped (not aggregated) and the artifact's `meta.truncated` records it. */
const MAX_CHART_ROWS_RENDERED = 15;
const MAX_CHART_COLUMNS_RENDERED = 6;

const SEPARATOR_CELL_RE = /^:?-+:?$/;

/** Cell values meaning "no data" rather than genuinely non-numeric text —
 *  never counted as either present or numeric. */
const EMPTY_CELL_TOKENS = new Set(['', '-', '--', '—', 'n/a', 'na', 'null', 'none', '?', 'tbd']);

const STRICT_NUMERIC_RE = /^[+-]?\d+(\.\d+)?$/;

/**
 * Removes fenced ``` code blocks so a code sample's pipe characters are never
 * mistaken for a markdown table. Deliberately simple (regex, not a full
 * markdown parser) — this module only needs to avoid the specific false
 * positive of table-shaped text inside a code fence, not implement Markdown.
 *
 * Exported so the sibling `proactive-document-extra.ts` detector can reuse
 * the exact same fence-stripping pass before scanning for heading/record
 * structure — the same rationale applies there (a code sample's `#` comments
 * or `key: value` lines must never be misread as markdown headings or a flat
 * list of data records).
 */
export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '');
}

/** Splits one `| a | b | c |` line into trimmed cells, tolerating missing
 *  leading/trailing pipes. Does not handle `\|`-escaped pipes inside a cell
 *  (rare in practice; an escaped-pipe table would parse as extra columns,
 *  which only makes the numeric-column check MORE conservative, never less). */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((cell) => SEPARATOR_CELL_RE.test(cell));
}

/**
 * Parses every well-formed GFM-style markdown table out of `content` (after
 * fenced code blocks have been stripped). A "table" requires a header row
 * immediately followed by a valid separator row (`|---|:--:|...`) with the
 * same cell count, followed by one or more data rows with that SAME cell
 * count — a row with a different column count ends the table rather than
 * being coerced into it.
 *
 * Pure and total: never throws, returns `[]` for content with no tables.
 */
export function parseMarkdownTables(content: string): ParsedMarkdownTable[] {
  if (!content) return [];
  const stripped = stripFencedCodeBlocks(content);
  const lines = stripped.split('\n');
  const tables: ParsedMarkdownTable[] = [];

  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i];
    if (!headerLine.includes('|')) {
      i += 1;
      continue;
    }
    const headerCells = splitTableRow(headerLine);
    const separatorCells = splitTableRow(lines[i + 1]);
    if (
      headerCells.length < 2 ||
      separatorCells.length !== headerCells.length ||
      !isSeparatorRow(separatorCells)
    ) {
      i += 1;
      continue;
    }

    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.includes('|')) break;
      const cells = splitTableRow(line);
      if (cells.length !== headerCells.length) break;
      rows.push(cells);
      j += 1;
    }

    if (rows.length > 0) {
      tables.push({ headers: headerCells, rows });
    }
    // Resume scanning after this table (whether or not it had data rows) —
    // avoids re-matching the separator line as a new header on the next pass.
    i = j > i + 1 ? j : i + 1;
  }

  return tables;
}

/**
 * Parses one table cell into a finite number, tolerating common real-world
 * decorations (thousands separators, a single leading currency symbol, a
 * trailing percent sign, surrounding whitespace). Anything else — a range
 * ("10-20"), a unit suffix ("3.5x", "5 GB"), free text — returns `undefined`.
 * Strict on purpose: a falsely-"numeric" column is exactly the kind of false
 * positive this feature must avoid, so there is no best-effort fallback.
 */
export function parseNumericCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (EMPTY_CELL_TOKENS.has(trimmed.toLowerCase())) return undefined;

  let candidate = trimmed.replace(/^[$€£¥]\s*/, '').replace(/,/g, '');
  if (candidate.endsWith('%')) candidate = candidate.slice(0, -1).trim();

  if (!STRICT_NUMERIC_RE.test(candidate)) return undefined;
  const value = Number(candidate);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Column indexes (excluding column 0, treated as the item/label column) where
 * EVERY data row's cell parses as numeric via {@link parseNumericCell}. A
 * single non-numeric cell anywhere in a column disqualifies that whole
 * column — no partial credit, matching the "no best-effort fallback" policy
 * above.
 */
export function computeNumericColumns(table: ParsedMarkdownTable): number[] {
  const columnCount = table.headers.length;
  const numeric: number[] = [];
  for (let col = 1; col < columnCount; col += 1) {
    const allNumeric = table.rows.every((row) => parseNumericCell(row[col]) !== undefined);
    if (allNumeric) numeric.push(col);
  }
  return numeric;
}

/**
 * The trigger condition (see module doc comment): at least
 * {@link MIN_CHART_ROWS} items being compared across at least
 * {@link MIN_NUMERIC_COLUMNS} genuinely numeric dimensions. Deliberately
 * excludes, by construction: a 2-row table of any width, and any table
 * (of any row count) with fewer than two fully-numeric non-label columns —
 * e.g. a plain 2x2 table never reaches either threshold.
 */
export function isChartWorthyComparisonTable(table: ParsedMarkdownTable): boolean {
  if (table.rows.length < MIN_CHART_ROWS) return false;
  return computeNumericColumns(table).length >= MIN_NUMERIC_COLUMNS;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateLabel(label: string, maxChars = 16): string {
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

/** Formats a parsed numeric value for display: integers print bare, other
 *  values keep up to 2 decimal places with trailing zeros trimmed. */
function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

const CHART_COLORS = ['#4C6EF5', '#F76707', '#37B24D', '#F03E3E', '#AE3EC9', '#1098AD'];

/**
 * Renders a grouped bar chart (one group per row, one bar per numeric column)
 * as a self-contained SVG document. Each numeric column is normalized to ITS
 * OWN maximum (see module doc comment for why) — bar height is therefore a
 * relative "how does this item rank on this dimension" signal, while the
 * real parsed value is always printed above the bar.
 *
 * Pure and deterministic: identical input always produces byte-identical
 * output (aside from nothing time/random-dependent — there is none).
 */
export function renderComparisonBarChartSvg(
  table: ParsedMarkdownTable,
  numericColumns: number[]
): string {
  const columns = numericColumns.slice(0, MAX_CHART_COLUMNS_RENDERED);
  const rows = table.rows.slice(0, MAX_CHART_ROWS_RENDERED);

  const columnMax = columns.map((col) =>
    Math.max(...rows.map((row) => parseNumericCell(row[col]) ?? 0), 0)
  );
  // A column where every rendered row is 0 would divide-by-zero into NaN —
  // treat it as "nothing to normalize against" (every bar renders at 0 height).
  const safeColumnMax = columnMax.map((max) => (max > 0 ? max : 1));

  const barWidth = 24;
  const barGap = 4;
  const groupGap = 28;
  const leftMargin = 16;
  const topMargin = 56; // legend + title
  const chartAreaHeight = 220;
  const bottomMargin = 70; // rotated x-axis labels
  const groupWidth = columns.length * barWidth + (columns.length - 1) * barGap;

  // The chart's plotted content sets the "natural" width, but a table with
  // few rows and several numeric columns (e.g. 3 items x 6 dimensions) can
  // need a WIDER legend row than the bars themselves take up — take whichever
  // is larger so the legend is never clipped by the viewBox.
  const contentWidth = leftMargin * 2 + rows.length * (groupWidth + groupGap) - groupGap;
  const legendWidth = leftMargin * 2 + columns.length * 120;
  const width = Math.max(contentWidth, legendWidth);
  const height = topMargin + chartAreaHeight + bottomMargin;
  const baselineY = topMargin + chartAreaHeight;

  const legend = columns
    .map((col, idx) => {
      const x = leftMargin + idx * 120;
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      return (
        `<rect x="${x}" y="16" width="12" height="12" fill="${color}" />` +
        `<text x="${x + 16}" y="26" font-size="12" font-family="sans-serif" fill="#333">` +
        `${escapeXml(truncateLabel(table.headers[col], 20))}</text>`
      );
    })
    .join('');

  const bars = rows
    .map((row, rowIdx) => {
      const groupX = leftMargin + rowIdx * (groupWidth + groupGap);
      const barsForGroup = columns
        .map((col, colIdx) => {
          const value = parseNumericCell(row[col]) ?? 0;
          const frac = value / safeColumnMax[colIdx];
          const barHeight = Math.max(0, frac * chartAreaHeight);
          const x = groupX + colIdx * (barWidth + barGap);
          const y = baselineY - barHeight;
          const color = CHART_COLORS[colIdx % CHART_COLORS.length];
          return (
            `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color}">` +
            `<title>${escapeXml(table.headers[col])}: ${escapeXml(formatValue(value))}</title>` +
            `</rect>` +
            `<text x="${x + barWidth / 2}" y="${y - 4}" font-size="10" font-family="sans-serif" ` +
            `text-anchor="middle" fill="#333">${escapeXml(formatValue(value))}</text>`
          );
        })
        .join('');
      const labelX = groupX + groupWidth / 2;
      const rawLabel = row[0] ?? '';
      const label = `<text x="${labelX}" y="${baselineY + 16}" font-size="11" font-family="sans-serif" ` +
        `text-anchor="end" fill="#333" transform="rotate(-30 ${labelX} ${baselineY + 16})">` +
        `<title>${escapeXml(rawLabel)}</title>${escapeXml(truncateLabel(rawLabel))}</text>`;
      return barsForGroup + label;
    })
    .join('');

  const title = `Comparison chart: ${columns
    .map((c) => table.headers[c])
    .join(', ')} by ${table.headers[0]}`;

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />` +
    `<line x1="${leftMargin}" y1="${baselineY}" x2="${width - leftMargin}" y2="${baselineY}" ` +
    `stroke="#333" stroke-width="1" />` +
    legend +
    bars +
    `</svg>`
  );
}

/**
 * Top-level entry point: scans a finished text response for a chart-worthy
 * markdown comparison table and, if found, renders it and returns a ready
 * `ArtifactRef` for the caller to append to `AilinMetadata.tool_artifacts`.
 * Returns `undefined` when nothing qualifies — this is expected to be the
 * common case; see the module doc comment for the trigger design.
 *
 * Pure aside from being a pure function of its input: no I/O, no randomness,
 * never throws (a malformed/adversarial table can, at worst, fail to match
 * and fall through to `undefined` — every code path here is total).
 */
export function buildProactiveTableChartArtifact(content: string): ArtifactRef | undefined {
  if (!content || content.length === 0 || content.length > MAX_CONTENT_LENGTH) return undefined;

  const tables = parseMarkdownTables(content);
  for (const table of tables) {
    if (!isChartWorthyComparisonTable(table)) continue;

    const numericColumns = computeNumericColumns(table);
    const renderedColumns = numericColumns.slice(0, MAX_CHART_COLUMNS_RENDERED);
    const renderedRows = table.rows.slice(0, MAX_CHART_ROWS_RENDERED);
    const svg = renderComparisonBarChartSvg(table, numericColumns);
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;

    return {
      type: 'image',
      url: dataUrl,
      mimeType: 'image/svg+xml',
      meta: {
        source: 'proactive_table_chart',
        reason: 'response_contains_multirow_multicolumn_comparison_table',
        labelColumn: table.headers[0],
        columns: renderedColumns.map((col) => table.headers[col]),
        rowsRendered: renderedRows.length,
        totalRows: table.rows.length,
        totalNumericColumns: numericColumns.length,
        truncated:
          table.rows.length > renderedRows.length || numericColumns.length > renderedColumns.length,
      },
    };
  }

  return undefined;
}
