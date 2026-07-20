// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * File Generation Service
 *
 * Renders STRUCTURED content (produced by a chat model, not this service)
 * into real file bytes for a given format. Mirrors the media-generation
 * services (images/video/audio orchestration) in spirit: a model produces
 * the content, a deterministic renderer turns it into bytes — the model
 * never emits raw binary/base64 file data directly.
 *
 * NO HARDCODED CONTENT — every format method is a pure transform from the
 * caller-supplied structured content to a Buffer.
 */

import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';

const log = logger.child({ service: 'file-generation' });

export type FileGenerationFormat = 'csv' | 'json' | 'markdown' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'zip' | 'code';
/** Sub-file formats a zip entry may bundle — everything except 'zip' itself
 *  (no nested archives; keeps the render graph a flat one level deep). */
export type ZipEntryFormat = Exclude<FileGenerationFormat, 'zip'>;

export interface CsvContent {
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface MarkdownContent {
  /** Raw markdown text — the model authors this directly, no intermediate
   *  structure needed (unlike CSV/XLSX, markdown IS the target format). */
  text: string;
}

/** One block of a DOCX document body, in document order. */
export type DocxSection =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 | 4 }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet_list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: Array<Array<string | number | boolean | null>> };

export interface DocxContent {
  /** Optional document title, rendered as the built-in Title style (larger
   *  than any heading level) — separate from the section headings below. */
  title?: string;
  sections: DocxSection[];
}

/** One worksheet in an XLSX workbook. */
export interface XlsxSheet {
  name: string;
  /** Optional bold header row. Omit for a headerless data dump. */
  headers?: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface XlsxContent {
  sheets: XlsxSheet[];
}

/** One block of a PDF document body, in document order — identical shape to
 *  DocxSection so the same JSON schema concept works across both formats. */
export type PdfSection =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 | 4 }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet_list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: Array<Array<string | number | boolean | null>> };

export interface PdfContent {
  title?: string;
  sections: PdfSection[];
}

/** One content block placed on a PPTX slide, in slide order. Presentations
 *  are inherently slide-based rather than a single flowing document, so the
 *  content model is nested (slides -> items) instead of DOCX/PDF's flat
 *  section list. */
export type PptxSlideItem =
  | { type: 'paragraph'; text: string }
  | { type: 'bullet_list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: Array<Array<string | number | boolean | null>> };

export interface PptxSlideContent {
  /** Optional slide title, rendered large/bold at the top of the slide. */
  title?: string;
  items: PptxSlideItem[];
}

export interface PptxContent {
  /** Optional dedicated title slide, added before the content slides. */
  title?: string;
  slides: PptxSlideContent[];
}

/** One file to bundle into a zip archive — rendered via the exact same
 *  per-format renderer as a top-level `generate(entry.format, ...)` call
 *  would use, then packed alongside its siblings. */
export interface ZipFileEntry {
  filename: string;
  format: ZipEntryFormat;
  content: unknown;
}

export interface ZipContent {
  files: ZipFileEntry[];
}

/** The model's own already-generated source code, materialized as a
 *  downloadable file (name + correct extension + mime type) rather than
 *  left as a chat-only code block — no rendering library needed, the
 *  content already IS the file's bytes. `language` drives ONLY the file
 *  extension (via CODE_LANGUAGE_EXTENSIONS below); the actual filename stem
 *  still comes from the same `filenameBase` every other format uses. */
export interface CodeContent {
  language: string;
  code: string;
}

export interface FileGenerationResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

const MIME_TYPES: Record<FileGenerationFormat, string> = {
  csv: 'text/csv',
  json: 'application/json',
  markdown: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  // Always text/plain regardless of language — deliberately never
  // text/html or (text|application)/javascript etc: this is a downloadable
  // source file, not markup meant to be rendered/executed inline by
  // whatever eventually opens it. Real value used is resolved per-request
  // by resolveCodeFileMeta(); this entry only exists to satisfy the
  // Record<FileGenerationFormat, string> type.
  code: 'text/plain',
};

const EXTENSIONS: Record<FileGenerationFormat, string> = {
  csv: 'csv',
  json: 'json',
  markdown: 'md',
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
  pptx: 'pptx',
  zip: 'zip',
  // Placeholder — real extension is resolved per-request from `language` by
  // resolveCodeFileMeta(); see the comment on MIME_TYPES.code above.
  code: 'txt',
};

/** Language name (and common aliases) -> file extension, for materializing
 *  already-generated code as a correctly-named downloadable file. Falls
 *  back to CODE_DEFAULT_EXTENSION for anything unrecognized rather than
 *  rejecting the request — an unfamiliar/niche language name shouldn't
 *  block the download, it should just get a generic .txt extension. */
const CODE_LANGUAGE_EXTENSIONS: Record<string, string> = {
  python: 'py', py: 'py',
  javascript: 'js', js: 'js',
  typescript: 'ts', ts: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  java: 'java',
  kotlin: 'kt', kt: 'kt',
  swift: 'swift',
  go: 'go', golang: 'go',
  rust: 'rs', rs: 'rs',
  c: 'c',
  cpp: 'cpp', 'c++': 'cpp', cplusplus: 'cpp',
  csharp: 'cs', 'c#': 'cs', cs: 'cs',
  ruby: 'rb', rb: 'rb',
  php: 'php',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  sql: 'sql',
  shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh',
  powershell: 'ps1', ps1: 'ps1',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  perl: 'pl', pl: 'pl',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  haskell: 'hs', hs: 'hs',
  elixir: 'ex', ex: 'ex',
  erlang: 'erl', erl: 'erl',
  clojure: 'clj', clj: 'clj',
  dart: 'dart',
  vue: 'vue',
  graphql: 'graphql', gql: 'graphql',
  ini: 'ini',
  text: 'txt', plaintext: 'txt', txt: 'txt',
};
const CODE_DEFAULT_EXTENSION = 'txt';

/** Every extension this service knows about, joined for a single strip-known-
 *  extension regex — used when normalizing a NON-code zip entry's filename
 *  so a mismatched known extension (e.g. "report.csv" for a markdown entry)
 *  is replaced rather than doubled into "report.csv.md". Deliberately does
 *  NOT include every code-language extension (2026-07-16, adversarial
 *  review): several of those are short, common, non-code-specific
 *  extensions (.c, .r, .go, .cs, .sh, .pl...) that would otherwise get
 *  silently stripped from completely unrelated non-code entries — e.g. a
 *  csv report literally named "report.cs" (Czech-locale abbreviation, or
 *  any unrelated meaning) would silently lose its ".cs" suffix. Use
 *  CODE_ALL_EXTENSIONS_PATTERN below instead for entries whose OWN format
 *  is 'code'. */
const ALL_KNOWN_EXTENSIONS_PATTERN = Object.values(EXTENSIONS).join('|');

/** Escapes every regex metacharacter in a literal string — needed because
 *  CODE_ALL_EXTENSIONS_PATTERN below folds in raw map KEYS (not just
 *  extension-shaped VALUES) as regex alternatives, and at least one key
 *  ("c++") contains an unescaped `+` that would otherwise make the built
 *  RegExp throw "Nothing to repeat" (2026-07-16, adversarial-review fix
 *  round: caught by the test suite itself, not by a prior manual check). */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every extension AND alias-key a 'code' zip entry might plausibly already
 *  carry as its filename's extension, for that entry's own strip-known-
 *  extension pass — includes both KEYS and VALUES of
 *  CODE_LANGUAGE_EXTENSIONS (2026-07-16, adversarial review: an
 *  earlier version only included the map's canonical VALUES, so an alias
 *  spelled exactly like its own key — e.g. filename "docker-compose.yml"
 *  with language "yaml"/"yml" — never matched the stripped extension
 *  "yaml" and produced a doubled "docker-compose.yml.yaml"; same for
 *  "setup.bash"/"setup.zsh" against the canonical "sh"), plus the base
 *  per-format extensions too (so a code entry can still normalize away a
 *  mismatched NON-code extension, e.g. "script.csv" for a python entry).
 *  Every token is regex-escaped since several keys ("c++", "c#") contain
 *  regex metacharacters. */
const CODE_ALL_EXTENSIONS_PATTERN = Array.from(
  new Set([
    ...Object.values(EXTENSIONS),
    ...Object.keys(CODE_LANGUAGE_EXTENSIONS),
    ...Object.values(CODE_LANGUAGE_EXTENSIONS),
  ])
)
  .map(escapeRegExpLiteral)
  .join('|');

/** Characters Excel forbids in a worksheet name: \ / ? * [ ] : */
const XLSX_INVALID_SHEET_NAME_CHARS = /[\\/?*[\]:]/g;
/** Excel's hard cap on worksheet name length. */
const XLSX_MAX_SHEET_NAME_LENGTH = 31;
/** A worksheet name can't start or end with a single quotation mark. */
const XLSX_LEADING_TRAILING_QUOTE = /^'+|'+$/g;
/** Names Excel reserves for its own use — checked case-insensitively to be
 *  defensive even though the installed exceljs only enforces exact-case
 *  'History' today. */
const XLSX_RESERVED_SHEET_NAMES = new Set(['history']);

/** Every format a zip entry may legitimately declare — everything except
 *  'zip' itself (checked at runtime since entry.content is `unknown`; the
 *  TS `ZipEntryFormat` type alone doesn't stop a model literally emitting
 *  `"format":"zip"` for a nested entry). */
const ZIP_VALID_ENTRY_FORMATS = new Set<ZipEntryFormat>(['csv', 'json', 'markdown', 'docx', 'xlsx', 'pdf', 'pptx', 'code']);

/** C0 control characters (including NUL) — stripped from zip entry names so
 *  they can't be injected into the archive's central directory (2026-07-16,
 *  adversarial review: confirmed a NUL byte survives a real jszip
 *  generateAsync/loadAsync round-trip verbatim otherwise). */
const ZIP_CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F]/g;
/** Unicode "format" control characters (zero-width chars, RTLO/LTRO bidi
 *  overrides/isolates, BOM, variation selectors, etc — the `Cf` Unicode
 *  general category) — stripped so a filename can't visually spoof a
 *  different name/extension in a file manager (the RTLO trick used in
 *  real-world disguised-archive malware distribution). Uses a Unicode
 *  property escape (same technique as MULTILINGUAL_RE in
 *  capability-inference.ts) rather than raw codepoint ranges, so ESLint's
 *  no-misleading-character-class rule can verify there's no surrogate-pair
 *  pitfall and the intent stays legible instead of a wall of hex ranges. */
const ZIP_BIDI_FORMAT_CHARS_PATTERN = /\p{Cf}/gu;
/** Characters Windows forbids anywhere in a filename (beyond the path
 *  separators already handled by the basename split above). */
const ZIP_WINDOWS_INVALID_CHARS_PATTERN = /[<>:"|?*]/g;
/** Windows-reserved device stems — any extension after these still refers
 *  to the reserved device, not a real file, on Windows. */
const ZIP_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
/** Hard cap on a zip entry's name stem (excluding extension/suffix). An
 *  unbounded name let a single overlong filename wrap the zip format's
 *  16-bit entry-name-length field, silently corrupting or dropping an
 *  UNRELATED sibling entry elsewhere in the same archive (2026-07-16,
 *  adversarial review, reproduced against the real installed jszip) — this
 *  is real cross-entry data loss, not merely an unextractable-name issue. */
const ZIP_MAX_ENTRY_STEM_LENGTH = 200;

const DOCX_HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
] as const;

/** Font point sizes for PDF heading levels 1-4 (pdfkit has no named heading
 *  styles like DOCX — sizes are the only lever). */
const PDF_HEADING_SIZES = [20, 16, 14, 12] as const;
/** Body/paragraph/list/table font size. */
const PDF_BODY_SIZE = 11;

export class FileGenerationService {
  /**
   * Async because DOCX (and every ZIP-container format added after it —
   * XLSX/PPTX) packs its bytes via `docx`'s `Packer.toBuffer`, which is
   * async internally (JSZip compression). CSV/JSON/Markdown stay
   * synchronous transforms under the hood; wrapping them in an async
   * function costs nothing and keeps one uniform contract for callers.
   */
  async generate(
    format: FileGenerationFormat,
    content: unknown,
    filenameBase = 'generated'
  ): Promise<FileGenerationResult> {
    const buffer = await this.render(format, content);
    // 'code' is the one format whose extension/mime depend on the content
    // itself (the declared `language`), not a fixed per-format lookup — see
    // MIME_TYPES.code/EXTENSIONS.code above for why those entries are just
    // placeholders.
    if (format === 'code') {
      const { extension, mimeType } = this.resolveCodeFileMeta(this.assertCodeContent(content));
      return { buffer, filename: `${filenameBase}.${extension}`, mimeType };
    }
    return {
      buffer,
      filename: `${filenameBase}.${EXTENSIONS[format]}`,
      mimeType: MIME_TYPES[format],
    };
  }

  private async render(format: FileGenerationFormat, content: unknown): Promise<Buffer> {
    switch (format) {
      case 'csv':
        return this.renderCsv(this.assertCsvContent(content));
      case 'json':
        return Buffer.from(JSON.stringify(content, null, 2), 'utf-8');
      case 'markdown':
        return Buffer.from(this.assertMarkdownContent(content).text, 'utf-8');
      case 'docx':
        return this.renderDocx(this.assertDocxContent(content));
      case 'xlsx':
        return this.renderXlsx(this.assertXlsxContent(content));
      case 'pdf':
        return this.renderPdf(this.assertPdfContent(content));
      case 'pptx':
        return this.renderPptx(this.assertPptxContent(content));
      case 'zip':
        return this.renderZip(this.assertZipContent(content));
      case 'code':
        return this.renderCode(this.assertCodeContent(content));
      default: {
        const exhaustiveCheck: never = format;
        throw new Error(`Unsupported file generation format: ${String(exhaustiveCheck)}`);
      }
    }
  }

  private assertCsvContent(content: unknown): CsvContent {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray((content as CsvContent).headers) ||
      !Array.isArray((content as CsvContent).rows)
    ) {
      throw new Error('CSV generation requires { headers: string[], rows: Array<Array<...>> }');
    }
    return content as CsvContent;
  }

  private assertMarkdownContent(content: unknown): MarkdownContent {
    if (typeof content === 'string') {
      return { text: content };
    }
    if (
      content &&
      typeof content === 'object' &&
      typeof (content as MarkdownContent).text === 'string'
    ) {
      return content as MarkdownContent;
    }
    throw new Error('Markdown generation requires a string or { text: string }');
  }

  private assertDocxContent(content: unknown): DocxContent {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray((content as DocxContent).sections)
    ) {
      throw new Error(
        'DOCX generation requires { title?: string, sections: Array<{type:"heading"|"paragraph"|"bullet_list"|"table", ...}> }'
      );
    }
    return content as DocxContent;
  }

  private assertXlsxContent(content: unknown): XlsxContent {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray((content as XlsxContent).sheets)
    ) {
      throw new Error(
        'XLSX generation requires { sheets: Array<{ name: string, headers?: string[], rows: Array<Array<...>> }> }'
      );
    }
    return content as XlsxContent;
  }

  private assertPdfContent(content: unknown): PdfContent {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray((content as PdfContent).sections)
    ) {
      throw new Error(
        'PDF generation requires { title?: string, sections: Array<{type:"heading"|"paragraph"|"bullet_list"|"table", ...}> }'
      );
    }
    return content as PdfContent;
  }

  private assertPptxContent(content: unknown): PptxContent {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray((content as PptxContent).slides)
    ) {
      throw new Error(
        'PPTX generation requires { title?: string, slides: Array<{ title?: string, items: Array<{type:"paragraph"|"bullet_list"|"table", ...}> }> }'
      );
    }
    return content as PptxContent;
  }

  private assertZipContent(content: unknown): ZipContent {
    if (
      !content ||
      typeof content !== 'object' ||
      !Array.isArray((content as ZipContent).files) ||
      (content as ZipContent).files.length === 0
    ) {
      throw new Error(
        'ZIP generation requires { files: Array<{ filename: string, format: "csv"|"json"|"markdown"|"docx"|"xlsx"|"pdf"|"pptx"|"code", content: <that format\'s own content shape> }> } with at least one file'
      );
    }
    return content as ZipContent;
  }

  private assertCodeContent(content: unknown): CodeContent {
    if (
      !content ||
      typeof content !== 'object' ||
      typeof (content as CodeContent).language !== 'string' ||
      typeof (content as CodeContent).code !== 'string'
    ) {
      throw new Error('Code generation requires { language: string, code: string }');
    }
    return content as CodeContent;
  }

  /**
   * Resolves the file extension and mime type for a code-as-file entry from
   * its declared `language` — case/whitespace-insensitive lookup against
   * CODE_LANGUAGE_EXTENSIONS, falling back to CODE_DEFAULT_EXTENSION for an
   * unrecognized/niche language name rather than rejecting the request.
   *
   * Uses an explicit `hasOwnProperty` check rather than a plain bracket
   * lookup (2026-07-16, adversarial review): `content.language` is fully
   * model-controlled, and a bracket lookup on a bare object literal
   * resolves inherited Object.prototype properties for keys like
   * "constructor"/"toString"/"__proto__" — e.g. `language: "constructor"`
   * would otherwise resolve to `Object.prototype.constructor` (truthy, so
   * `??` never falls back), producing a garbage extension. A defensive
   * alphanumeric check on the final value is a second, independent layer:
   * even if some future edit to CODE_LANGUAGE_EXTENSIONS introduced a
   * malformed value, this stops it from ever reaching a filename/zip entry
   * name unsanitized.
   */
  private resolveCodeFileMeta(content: CodeContent): { extension: string; mimeType: string } {
    const normalizedLanguage = content.language.trim().toLowerCase();
    const rawExtension = Object.prototype.hasOwnProperty.call(CODE_LANGUAGE_EXTENSIONS, normalizedLanguage)
      ? CODE_LANGUAGE_EXTENSIONS[normalizedLanguage]
      : CODE_DEFAULT_EXTENSION;
    const extension = /^[a-z0-9]+$/i.test(rawExtension) ? rawExtension : CODE_DEFAULT_EXTENSION;
    return { extension, mimeType: 'text/plain' };
  }

  /**
   * RFC 4180-style CSV escaping: a field is quoted only when it contains a
   * comma, double quote, or newline; internal double quotes are doubled.
   */
  private escapeCsvField(value: string | number | boolean | null): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  private renderCsv(content: CsvContent): Buffer {
    const lines = [
      content.headers.map((h) => this.escapeCsvField(h)).join(','),
      ...content.rows.map((row) => row.map((cell) => this.escapeCsvField(cell)).join(',')),
    ];
    return Buffer.from(lines.join('\r\n'), 'utf-8');
  }

  /**
   * Renders a rich DOCX: headings (levels 1-4 map to Word's built-in Heading1-4
   * styles), plain paragraphs, bullet lists, and tables (bold header row).
   * Unknown section `type` values AND known types missing their required
   * fields are both skipped rather than thrown (logged at warn level) — a
   * partially malformed model response still yields a usable document
   * instead of nothing, since the model is only prompted in JSON mode, not
   * validated against a strict schema before it reaches this renderer.
   */
  private async renderDocx(content: DocxContent): Promise<Buffer> {
    const body: Array<Paragraph | Table> = [];

    if (content.title) {
      body.push(new Paragraph({ text: content.title, heading: HeadingLevel.TITLE }));
    }

    for (const section of content.sections) {
      if (!section || typeof section !== 'object') {
        log.warn({ section }, 'Skipping malformed docx section (not an object)');
        continue;
      }
      switch (section.type) {
        case 'heading': {
          if (typeof section.text !== 'string') {
            log.warn({ section }, 'Skipping malformed docx heading section (missing text)');
            break;
          }
          const levelIndex = Math.min(Math.max((section.level ?? 1) - 1, 0), DOCX_HEADING_LEVELS.length - 1);
          body.push(new Paragraph({ text: section.text, heading: DOCX_HEADING_LEVELS[levelIndex] }));
          break;
        }
        case 'paragraph':
          if (typeof section.text !== 'string') {
            log.warn({ section }, 'Skipping malformed docx paragraph section (missing text)');
            break;
          }
          body.push(new Paragraph({ text: section.text }));
          break;
        case 'bullet_list':
          if (!Array.isArray(section.items)) {
            log.warn({ section }, 'Skipping malformed docx bullet_list section (missing items array)');
            break;
          }
          for (const item of section.items) {
            body.push(new Paragraph({ text: item, bullet: { level: 0 } }));
          }
          break;
        case 'table':
          if (!Array.isArray(section.headers) || !Array.isArray(section.rows)) {
            log.warn({ section }, 'Skipping malformed docx table section (missing headers/rows array)');
            break;
          }
          body.push(
            new Table({
              rows: [
                new TableRow({
                  children: section.headers.map(
                    (header) =>
                      new TableCell({
                        children: [new Paragraph({ children: [new TextRun({ text: header, bold: true })] })],
                      })
                  ),
                }),
                ...section.rows.map(
                  (row) =>
                    new TableRow({
                      children: row.map(
                        (cell) => new TableCell({ children: [new Paragraph(cell === null ? '' : String(cell))] })
                      ),
                    })
                ),
              ],
            })
          );
          break;
        default:
          log.warn({ section }, 'Skipping docx section with unrecognized type');
      }
    }

    const doc = new Document({ sections: [{ children: body }] });
    return Packer.toBuffer(doc);
  }

  /**
   * Renders a workbook with one worksheet per entry in `content.sheets`
   * (bold header row when `headers` is present). Sheets missing a `name` or
   * `rows` array, and individual rows that aren't arrays, are skipped
   * (warn-logged) rather than thrown, mirroring the DOCX renderer's
   * degrade-gracefully contract. If every sheet was malformed, a single
   * empty sheet is added — Excel/most viewers reject a workbook with zero
   * worksheets, so "nothing valid was produced" must still yield an
   * openable (if empty) file, not a corrupt one.
   */
  private async renderXlsx(content: XlsxContent): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const usedNames = new Set<string>();
    let sheetsAdded = 0;

    content.sheets.forEach((sheet, index) => {
      if (!sheet || typeof sheet.name !== 'string' || !Array.isArray(sheet.rows)) {
        log.warn({ sheet }, 'Skipping malformed xlsx sheet (missing name or rows array)');
        return;
      }
      const worksheet = workbook.addWorksheet(this.sanitizeSheetName(sheet.name, usedNames, index));
      if (Array.isArray(sheet.headers) && sheet.headers.length > 0) {
        const headerRow = worksheet.addRow(sheet.headers);
        headerRow.font = { bold: true };
      }
      for (const row of sheet.rows) {
        if (!Array.isArray(row)) {
          log.warn({ sheetName: sheet.name, row }, 'Skipping malformed xlsx row (not an array)');
          continue;
        }
        worksheet.addRow(row.map((cell) => (cell === null ? '' : cell)));
      }
      sheetsAdded++;
    });

    if (sheetsAdded === 0) {
      workbook.addWorksheet('Sheet1');
    }

    // exceljs's own index.d.ts declares a conflicting global `interface Buffer
    // extends ArrayBuffer {}` that merges badly with @types/node's real
    // Buffer, so writeBuffer()'s declared Promise<Buffer> return type isn't
    // directly assignable to this method's Node Buffer return type despite
    // being a real Buffer at runtime. Buffer.from() re-wraps it into an
    // unambiguous Node Buffer and sidesteps the type conflict.
    const written = await workbook.xlsx.writeBuffer();
    return Buffer.from(narrowAs<ArrayBuffer>(written));
  }

  /**
   * Excel worksheet names: max 31 chars, forbid \ / ? * [ ] :, forbid a
   * leading/trailing single quote, forbid the reserved name "History", and
   * must be unique within the workbook — case-INSENSITIVELY ('Report' and
   * 'REPORT' collide, per ExcelJS's own uniqueness check). Sanitizes,
   * truncates, and de-duplicates against all of the above so a
   * model-supplied name can never crash the render, however it's malformed.
   */
  private sanitizeSheetName(name: string, used: Set<string>, index: number): string {
    let base = name
      .replace(XLSX_INVALID_SHEET_NAME_CHARS, '_')
      .trim()
      .slice(0, XLSX_MAX_SHEET_NAME_LENGTH)
      // Truncation itself can leave a NEW trailing quote mid-string, so this
      // strip must run after slicing, not before.
      .replace(XLSX_LEADING_TRAILING_QUOTE, '');
    if (!base || XLSX_RESERVED_SHEET_NAMES.has(base.toLowerCase())) {
      base = `Sheet${index + 1}`;
    }

    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffixText = `_${suffix}`;
      candidate = base.slice(0, XLSX_MAX_SHEET_NAME_LENGTH - suffixText.length) + suffixText;
      suffix++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  /**
   * Renders a PDF: headings (levels 1-4 map to decreasing built-in font
   * sizes), plain paragraphs, bullet lists (pdfkit's native `.list()`), and
   * tables (pdfkit's native `.table()`, bold header row via a per-cell font
   * override — pdfkit has no boolean "bold", only named font families).
   * Same degrade-gracefully contract as DOCX/XLSX: a section (or an
   * individual table row) that's missing its required fields is skipped
   * (warn-logged), not thrown — the model is only prompted in JSON mode,
   * not validated against a strict schema before it reaches this renderer.
   */
  private async renderPdf(content: PdfContent): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (content.title) {
        doc.fontSize(24).font('Helvetica-Bold').text(content.title);
        doc.moveDown();
      }

      for (const section of content.sections) {
        if (!section || typeof section !== 'object') {
          log.warn({ section }, 'Skipping malformed pdf section (not an object)');
          continue;
        }
        switch (section.type) {
          case 'heading': {
            if (typeof section.text !== 'string') {
              log.warn({ section }, 'Skipping malformed pdf heading section (missing text)');
              break;
            }
            const levelIndex = Math.min(Math.max((section.level ?? 1) - 1, 0), PDF_HEADING_SIZES.length - 1);
            doc.fontSize(PDF_HEADING_SIZES[levelIndex]).font('Helvetica-Bold').text(section.text);
            doc.moveDown(0.5);
            break;
          }
          case 'paragraph':
            if (typeof section.text !== 'string') {
              log.warn({ section }, 'Skipping malformed pdf paragraph section (missing text)');
              break;
            }
            doc.fontSize(PDF_BODY_SIZE).font('Helvetica').text(section.text);
            doc.moveDown();
            break;
          case 'bullet_list':
            if (!Array.isArray(section.items)) {
              log.warn({ section }, 'Skipping malformed pdf bullet_list section (missing items array)');
              break;
            }
            // pdfkit's .list() calls string methods (e.g. charCodeAt) on each
            // item directly — a non-string item (number/object/null) throws
            // and destroys the whole document. Coerce every item the same
            // way the table cells below already do.
            doc.fontSize(PDF_BODY_SIZE).font('Helvetica').list(
              section.items.map((item) => (item === null || item === undefined ? '' : String(item)))
            );
            doc.moveDown();
            break;
          case 'table': {
            if (!Array.isArray(section.headers) || !Array.isArray(section.rows)) {
              log.warn({ section }, 'Skipping malformed pdf table section (missing headers/rows array)');
              break;
            }
            // Learned from the XLSX review: a `rows` array can still contain
            // an individual malformed (non-array) row — filter those out
            // rather than letting a single bad row's .map() throw.
            const arrayRows = section.rows.filter((row) => Array.isArray(row));
            if (arrayRows.length !== section.rows.length) {
              log.warn(
                { droppedRows: section.rows.length - arrayRows.length },
                'Dropped malformed (non-array) rows from a pdf table section'
              );
            }
            // Unlike ExcelJS (tolerates jagged rows), pdfkit's table renderer
            // computes column widths/positions once from the header row's
            // cell count — a data row with MORE cells than the header indexes
            // past that array and throws deep inside pdfkit's cell-rect draw
            // code ("unsupported number: undefined"), destroying the whole
            // document. Normalize every row to exactly headers.length cells
            // (pad short rows with '', truncate long ones) before it ever
            // reaches doc.table().
            const headerCount = section.headers.length;
            const validRows = arrayRows.map((row) => {
              const normalized = row.slice(0, headerCount).map((cell) => (cell === null ? '' : String(cell)));
              while (normalized.length < headerCount) normalized.push('');
              return normalized;
            });
            doc.fontSize(PDF_BODY_SIZE).font('Helvetica');
            doc.table({
              data: [
                // pdfkit's table cell font override only takes effect via
                // `font.src` (the value doc.font() is ultimately called
                // with) — `font.family` alone (meant to accompany `src` for
                // TTC/DFont collections) is silently ignored, so the header
                // row would otherwise render in the same non-bold weight as
                // the body.
                section.headers.map((header) => ({ text: header, font: { src: 'Helvetica-Bold' } })),
                ...validRows,
              ],
            });
            doc.moveDown();
            break;
          }
          default:
            log.warn({ section }, 'Skipping pdf section with unrecognized type');
        }
      }

      doc.end();
    });
  }

  /**
   * Renders a presentation: an optional title slide, then one slide per
   * entry in `content.slides` (optional slide title, bullet lists, plain
   * text boxes, tables with a bold header row). Same degrade-gracefully
   * contract as DOCX/XLSX/PDF: a malformed slide, item, or individual table
   * row is skipped (warn-logged) rather than thrown. If nothing valid was
   * produced, a single empty slide is added — like XLSX's zero-worksheet
   * case, a zero-slide .pptx is invalid/unopenable in PowerPoint.
   */
  private async renderPptx(content: PptxContent): Promise<Buffer> {
    const pptx = new PptxGenJS();
    let slidesAdded = 0;

    // typeof guard (not just truthy) mirrors the per-slide `slide.title`
    // guard below — an object/array/boolean title is a plausible model slip
    // (e.g. {"title": {"text": "Q3 Report"}}) that crashes pptxgenjs's
    // addText() with "newObject.text.forEach is not a function" instead of
    // degrading gracefully (2026-07-15, adversarial review).
    if (typeof content.title === 'string') {
      const titleSlide = pptx.addSlide();
      titleSlide.addText(content.title, {
        x: 0.5, y: 2.5, w: '90%', h: 1.5,
        fontSize: 32, bold: true, align: 'center',
      });
      slidesAdded++;
    } else if (content.title) {
      log.warn({ title: content.title }, 'Skipping non-string pptx presentation title');
    }

    // EMU (English Metric Units) is pptxgenjs's/OOXML's native unit — 914400
    // per inch. Read the real configured slide height instead of hardcoding
    // 5.625in so this keeps working if pptxgenjs's default layout ever
    // changes.
    const EMU_PER_INCH = 914400;
    const slideHeightIn = pptx.presLayout.height / EMU_PER_INCH;
    const CONTENT_BOTTOM_MARGIN_IN = 0.3;
    const maxY = slideHeightIn - CONTENT_BOTTOM_MARGIN_IN;

    for (const slide of content.slides) {
      if (!slide || typeof slide !== 'object' || !Array.isArray(slide.items)) {
        log.warn({ slide }, 'Skipping malformed pptx slide (missing items array)');
        continue;
      }
      let pptxSlide = pptx.addSlide();
      let y = 0.4;
      const slideTitle = typeof slide.title === 'string' ? slide.title : undefined;
      const addSlideTitle = (text: string) => {
        pptxSlide.addText(text, { x: 0.4, y, w: '90%', h: 0.8, fontSize: 24, bold: true });
        y += 0.9;
      };
      if (slideTitle) {
        addSlideTitle(slideTitle);
      }

      // Every item below is placed at an absolute y-coordinate (pptxgenjs has
      // no native flow layout like docx/pdfkit), so a moderately content-rich
      // slide can silently push shapes below the visible slide bounds — they
      // exist in the XML but never display in Slide Show (2026-07-15,
      // adversarial review). Auto-paginate: before placing an item that would
      // overflow, start a continuation slide and reset the cursor.
      const ensureRoomFor = (heightIn: number) => {
        if (y + heightIn > maxY) {
          pptxSlide = pptx.addSlide();
          y = 0.4;
          if (slideTitle) {
            addSlideTitle(`${slideTitle} (cont.)`);
          }
        }
      };

      for (const item of slide.items) {
        if (!item || typeof item !== 'object') {
          log.warn({ item }, 'Skipping malformed pptx slide item (not an object)');
          continue;
        }
        switch (item.type) {
          case 'paragraph':
            if (typeof item.text !== 'string') {
              log.warn({ item }, 'Skipping malformed pptx paragraph item (missing text)');
              break;
            }
            ensureRoomFor(1.1);
            pptxSlide.addText(item.text, { x: 0.4, y, w: '90%', h: 1, fontSize: 14 });
            y += 1.1;
            break;
          case 'bullet_list':
            if (!Array.isArray(item.items)) {
              log.warn({ item }, 'Skipping malformed pptx bullet_list item (missing items array)');
              break;
            }
            // Learned from the PDF review: coerce every item to a string —
            // pptxgenjs's text layer expects string content, and a raw
            // number/object/null is exactly the kind of plausible model slip
            // that crashed pdfkit's equivalent .list() call.
            ensureRoomFor(2.1);
            pptxSlide.addText(
              item.items.map((bulletItem) => ({
                text: bulletItem === null || bulletItem === undefined ? '' : String(bulletItem),
                options: { bullet: true, breakLine: true },
              })),
              { x: 0.4, y, w: '90%', h: 2, fontSize: 14 }
            );
            y += 2.1;
            break;
          case 'table': {
            if (!Array.isArray(item.headers) || !Array.isArray(item.rows)) {
              log.warn({ item }, 'Skipping malformed pptx table item (missing headers/rows array)');
              break;
            }
            const arrayRows = item.rows.filter((row) => Array.isArray(row));
            if (arrayRows.length !== item.rows.length) {
              log.warn(
                { droppedRows: item.rows.length - arrayRows.length },
                'Dropped malformed (non-array) rows from a pptx table item'
              );
            }
            // headers may legitimately be empty (a "headerless dump", same
            // as XLSX's `sheet.headers.length > 0` check) — normalizing rows
            // to `headers.length` unconditionally previously truncated every
            // row to zero cells whenever headers was [], silently discarding
            // the entire table with no warning (2026-07-15, adversarial
            // review). Fall back to the widest actual row when there's no
            // header row to size against.
            const headerCount = item.headers.length;
            const columnCount =
              headerCount > 0 ? headerCount : arrayRows.reduce((max, row) => Math.max(max, row.length), 0);
            if (columnCount === 0) {
              log.warn({ item }, 'Skipping pptx table item with no headers and no data');
              break;
            }
            const normalizedRows = arrayRows.map((row) => {
              const normalized = row
                .slice(0, columnCount)
                .map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
              while (normalized.length < columnCount) normalized.push('');
              return normalized;
            });
            // Same coercion as row cells (and bullet items above) — an
            // un-coerced non-string header (e.g. `true`, `null`, an object)
            // previously rendered as a completely blank cell instead of a
            // stringified label (2026-07-15, adversarial review).
            const headerRow =
              headerCount > 0
                ? [
                    item.headers.map((header) => ({
                      text: header === null || header === undefined ? '' : String(header),
                      options: { bold: true },
                    })),
                  ]
                : [];
            ensureRoomFor(0.4 + 0.4 * (normalizedRows.length + headerRow.length));
            pptxSlide.addTable(
              [...headerRow, ...normalizedRows.map((row) => row.map((cell) => ({ text: cell })))],
              { x: 0.4, y, w: '90%' }
            );
            y += 0.4 + 0.4 * (normalizedRows.length + headerRow.length);
            break;
          }
          default:
            log.warn({ item }, 'Skipping pptx slide item with unrecognized type');
        }
      }
      slidesAdded++;
    }

    if (slidesAdded === 0) {
      pptx.addSlide();
    }

    const written = await pptx.write({ outputType: 'nodebuffer' });
    return Buffer.from(narrowAs<ArrayBuffer>(written));
  }

  /**
   * Bundles multiple files into a single zip archive. Each entry is
   * rendered via the exact same per-format renderer a top-level
   * `generate(entry.format, ...)` call would use — this method is purely a
   * fan-out + pack step, never a format renderer of its own. Same
   * degrade-gracefully contract as every other format: a malformed,
   * unsupported, or failing-to-render entry is skipped (warn-logged)
   * rather than aborting the whole archive. Unlike the other formats,
   * zero surviving entries is a hard error (not a filler fallback) — an
   * empty zip has no informational value to hand back to the user.
   */
  private async renderZip(content: ZipContent): Promise<Buffer> {
    const zip = new JSZip();
    const usedNamesLower = new Set<string>();
    let filesAdded = 0;

    for (const entry of content.files) {
      if (!entry || typeof entry !== 'object') {
        log.warn({ entry }, 'Skipping malformed zip entry (not an object)');
        continue;
      }
      if (typeof entry.filename !== 'string' || entry.filename.trim() === '') {
        log.warn({ entry }, 'Skipping malformed zip entry (missing filename)');
        continue;
      }
      if (!ZIP_VALID_ENTRY_FORMATS.has(entry.format)) {
        log.warn({ entry }, 'Skipping zip entry with unsupported or unrecognized format');
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await this.render(entry.format, entry.content);
      } catch (error) {
        log.warn(
          { entry, error: error instanceof Error ? error.message : String(error) },
          'Skipping zip entry that failed to render'
        );
        continue;
      }

      // 'code' resolves its extension from the entry's own `language`, same
      // as the top-level generate() special-case above — everything else
      // uses the fixed per-format EXTENSIONS lookup. The render() call just
      // above already validated entry.content as CodeContent (it would have
      // thrown and hit the catch otherwise), so this cast is safe. The
      // strip-pattern is ALSO format-specific: a 'code' entry's filename
      // needs to recognize code-language aliases (e.g. "docker-compose.yml"
      // for language "yaml") as strippable, while a non-code entry must NOT
      // have short code-language extensions (.c/.r/.go/.cs/.sh/...) that
      // could collide with an unrelated legitimate filename incorrectly
      // stripped (2026-07-16, adversarial review).
      const extension =
        entry.format === 'code'
          ? this.resolveCodeFileMeta(entry.content as CodeContent).extension
          : EXTENSIONS[entry.format];
      const stripPattern = entry.format === 'code' ? CODE_ALL_EXTENSIONS_PATTERN : ALL_KNOWN_EXTENSIONS_PATTERN;
      const finalName = this.uniqueZipEntryName(entry.filename, extension, stripPattern, usedNamesLower);
      zip.file(finalName, buffer);
      usedNamesLower.add(finalName.toLowerCase());
      filesAdded++;
    }

    if (filesAdded === 0) {
      throw new Error(
        'ZIP generation produced zero valid files — every entry was malformed, unsupported, or failed to render'
      );
    }

    return zip.generateAsync({ type: 'nodebuffer' });
  }

  /**
   * Reduces a model-supplied filename to a safe, portable zip entry name.
   * Layered defenses (2026-07-16, adversarial review — each one confirmed
   * by executing the real installed jszip against a hand-crafted adversarial
   * input, not just reasoning about it):
   *  - zip-slip path traversal ("../../etc/passwd") — basename reduction.
   *  - a segment that's ONLY dots/whitespace (e.g. "...", "   ") no longer
   *    survives as a literal (mostly-)blank filename.
   *  - C0 control characters (incl. NUL) and Unicode bidi/format control
   *    characters (e.g. U+202E right-to-left override) are stripped — a
   *    basename reduction alone does not stop control-byte injection into
   *    the archive's central directory, nor a visual-spoofing trick.
   *  - Windows-invalid characters (`<>:"|?*`) are stripped and Windows'
   *    reserved device stems (CON/PRN/AUX/NUL/COM1-9/LPT1-9) are renamed,
   *    mirroring the XLSX sheet-name sanitizer's equivalent defenses.
   *  - the stem is length-capped: an unbounded name let a single overlong
   *    filename silently corrupt the WHOLE archive (the zip format's 16-bit
   *    entry-name-length field wraps around, and an unrelated sibling entry
   *    was observed to vanish/garble as a result) — this is not merely an
   *    unextractable-entry cosmetic issue, it's a real cross-entry data-loss
   *    bug without the cap.
   *  - a mismatched KNOWN extension is stripped before appending the
   *    correct one (so "report.csv" for a markdown entry becomes
   *    "report.md", not "report.csv.md") — trailing whitespace/dots are
   *    normalized first (mirroring how Windows itself silently drops them),
   *    since otherwise a trailing character defeated the end-anchored
   *    extension-strip regex entirely.
   *  - a case-insensitive collision gets a " (n)" suffix so two entries
   *    never silently overwrite each other on extraction.
   */
  private uniqueZipEntryName(
    rawFilename: string,
    extension: string,
    stripPattern: string,
    usedNamesLower: Set<string>
  ): string {
    const rawSegment =
      rawFilename
        .replace(/[\\/]+/g, '/')
        .split('/')
        .filter((segment) => segment.trim() !== '' && !/^\.+$/.test(segment))
        .pop() || 'file';

    let sanitized = rawSegment
      .replace(ZIP_CONTROL_CHARS_PATTERN, '')
      .replace(ZIP_BIDI_FORMAT_CHARS_PATTERN, '')
      .replace(ZIP_WINDOWS_INVALID_CHARS_PATTERN, '')
      .trim()
      .replace(/\.+$/, '');
    if (sanitized === '') sanitized = 'file';

    let stem = sanitized.replace(new RegExp(`\\.(?:${stripPattern})$`, 'i'), '') || 'file';
    if (ZIP_RESERVED_STEMS.has(stem.toLowerCase())) {
      stem = `${stem}_file`;
    }
    stem = stem.slice(0, ZIP_MAX_ENTRY_STEM_LENGTH) || 'file';

    let candidate = `${stem}.${extension}`;
    let suffix = 2;
    while (usedNamesLower.has(candidate.toLowerCase())) {
      candidate = `${stem} (${suffix}).${extension}`;
      suffix++;
    }
    return candidate;
  }

  /**
   * Materializes already-generated source code as a downloadable file — no
   * rendering library needed, the content already IS the file's bytes. The
   * `language` field never touches this method directly (only
   * resolveCodeFileMeta uses it, for the extension/mime); the code itself
   * is written out completely as-is, including whatever indentation/
   * newlines the model produced.
   */
  private renderCode(content: CodeContent): Buffer {
    return Buffer.from(content.code, 'utf-8');
  }
}
