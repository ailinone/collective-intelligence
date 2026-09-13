// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Proactive structured extras — prose/data-summary-to-document promotion.
 *
 * SCOPE: the second of the two follow-ups explicitly deferred by
 * `proactive-structured-extras.ts`'s module doc comment (table -> chart).
 * This module implements exactly TWO closely-related extras sharing one
 * entry point: when a plain (non-streaming) chat response's finished text is
 * either (a) a long, genuinely multi-section report, or (b) a flat list of
 * structurally-uniform "label: value" records that isn't a markdown table,
 * promote it to a downloadable document (markdown) or spreadsheet (CSV) via
 * `FileGenerationService` — the same reuse-not-reinvent approach the
 * table-to-chart and code-file extras take.
 *
 * TRIGGER DESIGN (mirrors proactive-structured-extras.ts's philosophy —
 * "structured prose" is a much fuzzier signal than a markdown table, so this
 * is, if anything, MORE conservative than that module, combining multiple
 * independent structural signals rather than length alone):
 *
 *   RECORD PATH (-> CSV), checked first because it is the more specific,
 *   stronger signal:
 *   - Scans markdown list items (`- `, `* `, `1. `, etc.) for ones shaped
 *     like a comma-separated run of "Label: value" pairs (e.g. "Name: Alice,
 *     Age: 30, Role: Engineer") — at least {@link MIN_FIELDS_PER_RECORD}
 *     pairs, no bare/empty label or value.
 *   - Groups matching lines by their EXACT field-label sequence (order and
 *     count) — no partial credit, mirroring `computeNumericColumns`'s "every
 *     row or the column doesn't count" policy: a list mixing several
 *     unrelated "label: value" one-liners (a stray "Note: remember to
 *     save") never accidentally joins a real record group as long as its
 *     label sequence differs.
 *   - Only the LARGEST such group counts; it must have at least
 *     {@link MIN_RECORD_ROWS} lines to trigger. This is deliberately similar
 *     in spirit to (but independent of) the table detector's numeric-column
 *     rule: uniform SHAPE across many rows is the signal, not raw length.
 *
 *   REPORT PATH (-> markdown document), checked only when the record path
 *   didn't already claim the response:
 *   - Requires at least {@link MIN_HEADINGS} markdown ATX headings
 *     (`# ... ###### `) — a real multi-section report shape, not a
 *     conversational answer that merely happens to be long.
 *   - Requires at least {@link MIN_CONTENT_CHARS_FOR_REPORT} characters of
 *     content (after stripping fenced code blocks, so a response dominated
 *     by one big code sample can't pad this count — that content belongs to
 *     the sibling code-file extra instead).
 *   - The ORIGINAL text (not the stripped copy used only for signal
 *     detection) is what gets materialized, verbatim, as a `.md` file — no
 *     markdown-to-DOCX section parser is invented for this; the model's own
 *     well-formed markdown IS the file's content, the same "no rendering
 *     needed, the content already IS the bytes" logic `FileGenerationService`
 *     already applies to raw source code.
 *
 *   Both paths additionally:
 *   - Strip fenced code blocks before ANY structural scan (shared
 *     `stripFencedCodeBlocks` from proactive-structured-extras.ts) — a code
 *     sample's `#` comments or `key: value` config lines must never be
 *     misread as report headings or data records.
 *   - Skip entirely on pathologically large content
 *     ({@link MAX_CONTENT_LENGTH}) and when `finishReason === 'length'` — a
 *     response cut off elsewhere is not trustworthy enough to promote any
 *     part of it as "the complete document".
 *   - Run entirely post-hoc on the model's already-finished text — the model
 *     is never asked whether a document would help.
 */
import { FileGenerationService } from '@/services/file-generation-service';
import { stripFencedCodeBlocks } from '@/core/orchestration/proactive-structured-extras';
import type { ArtifactRef } from '@/types';

/** See module doc comment — record path. */
const MIN_FIELDS_PER_RECORD = 2;
const MIN_RECORD_ROWS = 6;
/** A "label" longer than this is more likely a full clause with an
 *  incidental colon ("Remember: always check your work") than a genuine
 *  short field key ("Name", "Price (USD)") — rejected rather than counted. */
const MAX_RECORD_LABEL_LENGTH = 40;

/** See module doc comment — report path. */
const MIN_HEADINGS = 3;
const MIN_CONTENT_CHARS_FOR_REPORT = 1200;

/** Defensive cap: skip detection entirely on pathologically large content
 *  (mirrors proactive-structured-extras.ts's MAX_CONTENT_LENGTH). */
const MAX_CONTENT_LENGTH = 200_000;

const LIST_ITEM_RE = /^[ \t]*(?:[-*•]|\d+[.)])\s+(.+)$/;
const ATX_HEADING_RE = /^[ \t]*#{1,6}\s+\S/;

const fileGenerationService = new FileGenerationService();

export interface ParsedRecordLine {
  /** Lowercased, trimmed labels — used only for the exact-shape grouping key. */
  labelsKey: string;
  /** Original-case labels, as they appeared in THIS line. */
  labels: string[];
  values: string[];
}

/**
 * Parses one list-item's text as a comma-separated run of "Label: value"
 * pairs. Returns `undefined` unless EVERY comma-separated segment has a
 * non-empty label (within {@link MAX_RECORD_LABEL_LENGTH}) and a non-empty
 * value — no partial credit, matching the module's stated policy. A line
 * like "Pros: fast, cheap" fails here (the second segment, "cheap", has no
 * colon), which is intentional: that is prose, not a data record.
 *
 * Exported (like `parseNumericCell` in the sibling table-to-chart module) so
 * each layer of the trigger can be unit-tested independently of the async
 * `FileGenerationService` call in {@link buildProactiveDocumentArtifact}.
 */
export function parseRecordLine(itemText: string): ParsedRecordLine | undefined {
  const segments = itemText
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < MIN_FIELDS_PER_RECORD) return undefined;

  const labels: string[] = [];
  const values: string[] = [];
  for (const segment of segments) {
    const colonIdx = segment.indexOf(':');
    if (colonIdx <= 0) return undefined;
    const label = segment.slice(0, colonIdx).trim();
    const value = segment.slice(colonIdx + 1).trim();
    if (label.length === 0 || label.length > MAX_RECORD_LABEL_LENGTH) return undefined;
    if (value.length === 0) return undefined;
    labels.push(label);
    values.push(value);
  }
  return { labelsKey: labels.map((label) => label.toLowerCase()).join(' '), labels, values };
}

/**
 * Finds the largest group of list-item lines sharing the EXACT same
 * "label: value" field shape (see {@link parseRecordLine}) and returns it as
 * ready CSV content when it reaches {@link MIN_RECORD_ROWS}. `undefined`
 * otherwise. Header casing is taken from the FIRST record in the winning
 * group (arbitrary but deterministic — real responses are consistent anyway).
 */
export function findRecordListCsv(
  strippedContent: string
): { headers: string[]; rows: string[][] } | undefined {
  const groups = new Map<string, ParsedRecordLine[]>();
  for (const line of strippedContent.split('\n')) {
    const listMatch = LIST_ITEM_RE.exec(line);
    if (!listMatch) continue;
    const parsed = parseRecordLine(listMatch[1]);
    if (!parsed) continue;
    const group = groups.get(parsed.labelsKey);
    if (group) group.push(parsed);
    else groups.set(parsed.labelsKey, [parsed]);
  }

  let winner: ParsedRecordLine[] | undefined;
  for (const group of groups.values()) {
    if (!winner || group.length > winner.length) winner = group;
  }
  if (!winner || winner.length < MIN_RECORD_ROWS) return undefined;

  return {
    headers: winner[0].labels,
    rows: winner.map((record) => record.values),
  };
}

/** Counts markdown ATX headings (`#` through `######`) in already
 *  fence-stripped content — the report path's structural signal. */
export function countHeadings(strippedContent: string): number {
  return strippedContent.split('\n').filter((line) => ATX_HEADING_RE.test(line)).length;
}

/**
 * Top-level entry point: scans a finished text response for either a flat
 * list of uniform data records or a genuine multi-section report and, if
 * found, materializes it as a CSV or markdown document via
 * `FileGenerationService`, returning a ready `ArtifactRef`. Returns
 * `undefined` when nothing qualifies (the common case) or when
 * `finishReason` indicates the response itself was cut off.
 */
export async function buildProactiveDocumentArtifact(
  content: string,
  finishReason?: string | null
): Promise<ArtifactRef | undefined> {
  if (!content || content.length === 0 || content.length > MAX_CONTENT_LENGTH) return undefined;
  if (finishReason === 'length') return undefined;

  const stripped = stripFencedCodeBlocks(content);

  const csv = findRecordListCsv(stripped);
  if (csv) {
    const result = await fileGenerationService.generate('csv', csv, 'data_export');
    const dataUrl = `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;
    return {
      type: 'file',
      url: dataUrl,
      mimeType: result.mimeType,
      meta: {
        source: 'proactive_document_export',
        reason: 'response_contains_flat_list_of_uniform_records',
        headers: csv.headers,
        recordCount: csv.rows.length,
        filename: result.filename,
      },
    };
  }

  const headingCount = countHeadings(stripped);
  if (headingCount >= MIN_HEADINGS && stripped.trim().length >= MIN_CONTENT_CHARS_FOR_REPORT) {
    const result = await fileGenerationService.generate('markdown', content, 'document_export');
    const dataUrl = `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;
    return {
      type: 'document',
      url: dataUrl,
      mimeType: result.mimeType,
      meta: {
        source: 'proactive_document_export',
        reason: 'response_is_long_structured_report',
        headingCount,
        totalChars: stripped.trim().length,
        filename: result.filename,
      },
    };
  }

  return undefined;
}
