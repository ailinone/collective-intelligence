// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import { FileGenerationService } from '@/services/file-generation-service';

/** Unzips a generated .docx and returns the raw word/document.xml text, so
 *  tests can assert on ACTUAL rendered content rather than just "some zip
 *  buffer was produced" (a 2-byte 'PK' prefix check would pass even for a
 *  docx whose content was silently dropped). */
async function readDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml missing from generated docx');
  return file.async('string');
}

/** Extracts real text from a generated PDF so tests assert on ACTUAL
 *  rendered content, not just "%PDF" header bytes. */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

/** Unzips a generated .pptx and returns the concatenated XML of every slide
 *  (ppt/slides/slideN.xml), so tests assert on ACTUAL rendered content
 *  rather than just "some zip buffer was produced". */
async function readAllSlideXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();
  if (slideFiles.length === 0) throw new Error('no ppt/slides/slideN.xml files found in generated pptx');
  const contents = await Promise.all(slideFiles.map((name) => zip.file(name)!.async('string')));
  return contents.join('\n');
}

/** Extracts the text content of every <a:t> run in slide XML, so tests can
 *  assert on exact rendered text tokens without false-positiving on
 *  unrelated OOXML boilerplate (e.g. the "a:" namespace prefix itself, or
 *  attribute values that happen to contain the same characters). */
function extractSlideTexts(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
}

async function countSlideFiles(buffer: Buffer): Promise<number> {
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
}

describe('FileGenerationService', () => {
  const service = new FileGenerationService();

  describe('json', () => {
    it('renders arbitrary JSON content with 2-space indentation', async () => {
      const result = await service.generate('json', { a: 1, b: [2, 3] }, 'report');

      expect(result.filename).toBe('report.json');
      expect(result.mimeType).toBe('application/json');
      expect(result.buffer.toString('utf-8')).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    });
  });

  describe('markdown', () => {
    it('renders a plain string as markdown text', async () => {
      const result = await service.generate('markdown', '# Title\n\nBody text.', 'notes');

      expect(result.filename).toBe('notes.md');
      expect(result.mimeType).toBe('text/markdown');
      expect(result.buffer.toString('utf-8')).toBe('# Title\n\nBody text.');
    });

    it('renders a { text } object as markdown text', async () => {
      const result = await service.generate('markdown', { text: '## Section' });

      expect(result.buffer.toString('utf-8')).toBe('## Section');
    });

    it('throws when content is neither a string nor { text }', async () => {
      await expect(service.generate('markdown', { wrong: true })).rejects.toThrow(
        'Markdown generation requires a string or { text: string }'
      );
    });
  });

  describe('csv', () => {
    it('renders headers and rows with CRLF line endings', async () => {
      const result = await service.generate(
        'csv',
        { headers: ['name', 'age'], rows: [['Alice', 30], ['Bob', 25]] },
        'people'
      );

      expect(result.filename).toBe('people.csv');
      expect(result.mimeType).toBe('text/csv');
      expect(result.buffer.toString('utf-8')).toBe('name,age\r\nAlice,30\r\nBob,25');
    });

    it('quotes fields containing commas, quotes, or newlines (RFC 4180)', async () => {
      const result = await service.generate('csv', {
        headers: ['name', 'note'],
        rows: [['Alice, Jr.', 'Said "hi"\nagain']],
      });

      expect(result.buffer.toString('utf-8')).toBe(
        'name,note\r\n"Alice, Jr.","Said ""hi""\nagain"'
      );
    });

    it('renders null/undefined cells as empty fields', async () => {
      const result = await service.generate('csv', {
        headers: ['a', 'b'],
        rows: [[null, 'x']],
      });

      expect(result.buffer.toString('utf-8')).toBe('a,b\r\n,x');
    });

    it('throws when content does not match { headers, rows }', async () => {
      await expect(service.generate('csv', { wrong: true })).rejects.toThrow(
        'CSV generation requires { headers: string[], rows: Array<Array<...>> }'
      );
    });
  });

  describe('docx', () => {
    it('renders a title + heading + paragraph + bullet_list + table into a real, non-empty DOCX (zip signature)', async () => {
      const result = await service.generate(
        'docx',
        {
          title: 'Quarterly Report',
          sections: [
            { type: 'heading', text: 'Summary', level: 1 },
            { type: 'paragraph', text: 'Revenue grew steadily this quarter.' },
            { type: 'bullet_list', items: ['Point one', 'Point two'] },
            { type: 'table', headers: ['Region', 'Revenue'], rows: [['EMEA', 12000], ['APAC', 9000]] },
          ],
        },
        'report'
      );

      expect(result.filename).toBe('report.docx');
      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.buffer.subarray(0, 2).toString('utf-8')).toBe('PK');

      // Unzip and verify the ACTUAL content landed in the document body —
      // a regression that silently drops all content would still produce
      // a non-empty PK-prefixed buffer, so the byte-signature check alone
      // is not sufficient (see review finding, 2026-07-15).
      const xml = await readDocumentXml(result.buffer);
      expect(xml).toContain('Quarterly Report');
      expect(xml).toContain('Summary');
      expect(xml).toContain('Revenue grew steadily this quarter.');
      expect(xml).toContain('Point one');
      expect(xml).toContain('Point two');
      expect(xml).toContain('Region');
      expect(xml).toContain('EMEA');
      expect(xml).toContain('12000');
    });

    it('renders a minimal document with no title and a single paragraph', async () => {
      const result = await service.generate('docx', {
        sections: [{ type: 'paragraph', text: 'Just one line.' }],
      });

      expect(result.buffer.subarray(0, 2).toString('utf-8')).toBe('PK');
      const xml = await readDocumentXml(result.buffer);
      expect(xml).toContain('Just one line.');
    });

    it('throws when content has no sections array', async () => {
      await expect(service.generate('docx', { title: 'x' })).rejects.toThrow(
        'DOCX generation requires { title?: string, sections: Array<'
      );
    });

    it('skips a null/non-object entry in sections but still renders the rest of the document', async () => {
      const result = await service.generate('docx', {
        sections: [null, { type: 'paragraph', text: 'Survives the null sibling.' }],
      });

      const xml = await readDocumentXml(result.buffer);
      expect(xml).toContain('Survives the null sibling.');
    });

    it('skips an unrecognized section type but still renders the rest of the document', async () => {
      const result = await service.generate('docx', {
        sections: [
          { type: 'quote', text: 'not a real section type' },
          { type: 'paragraph', text: 'This one is valid.' },
        ],
      });

      const xml = await readDocumentXml(result.buffer);
      expect(xml).toContain('This one is valid.');
      expect(xml).not.toContain('not a real section type');
    });

    it('skips a bullet_list section missing items, but still renders the rest of the document', async () => {
      const result = await service.generate('docx', {
        sections: [
          { type: 'bullet_list' },
          { type: 'paragraph', text: 'Survives the malformed sibling.' },
        ],
      });

      const xml = await readDocumentXml(result.buffer);
      expect(xml).toContain('Survives the malformed sibling.');
    });

    it('skips a table section missing headers or rows, but still renders the rest of the document', async () => {
      const resultMissingRows = await service.generate('docx', {
        sections: [
          { type: 'table', headers: ['A', 'B'] },
          { type: 'paragraph', text: 'After a table missing rows.' },
        ],
      });
      expect(await readDocumentXml(resultMissingRows.buffer)).toContain('After a table missing rows.');

      const resultMissingHeaders = await service.generate('docx', {
        sections: [
          { type: 'table', rows: [['x', 'y']] },
          { type: 'paragraph', text: 'After a table missing headers.' },
        ],
      });
      expect(await readDocumentXml(resultMissingHeaders.buffer)).toContain('After a table missing headers.');
    });
  });

  describe('xlsx', () => {
    it('renders multiple sheets with a bold header row into a real, non-empty XLSX with actual content', async () => {
      const result = await service.generate(
        'xlsx',
        {
          sheets: [
            { name: 'Sales', headers: ['Region', 'Revenue'], rows: [['EMEA', 12000], ['APAC', 9000]] },
            { name: 'Notes', rows: [['no header here']] },
          ],
        },
        'report'
      );

      expect(result.filename).toBe('report.xlsx');
      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.buffer.subarray(0, 2).toString('utf-8')).toBe('PK');

      // Read the workbook back with ExcelJS and verify the ACTUAL content —
      // not just "some zip buffer was produced" (see the DOCX review lesson).
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);

      const sales = workbook.getWorksheet('Sales');
      expect(sales).toBeDefined();
      expect(sales!.getRow(1).getCell(1).value).toBe('Region');
      expect(sales!.getRow(1).font?.bold).toBe(true);
      expect(sales!.getRow(2).getCell(1).value).toBe('EMEA');
      expect(sales!.getRow(2).getCell(2).value).toBe(12000);
      expect(sales!.getRow(3).getCell(1).value).toBe('APAC');

      const notes = workbook.getWorksheet('Notes');
      expect(notes).toBeDefined();
      expect(notes!.getRow(1).getCell(1).value).toBe('no header here');
    });

    it('renders a minimal single-sheet workbook with no header row', async () => {
      const result = await service.generate('xlsx', {
        sheets: [{ name: 'Data', rows: [['x', 1]] }],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      expect(workbook.getWorksheet('Data')).toBeDefined();
    });

    it('throws when content has no sheets array', async () => {
      await expect(service.generate('xlsx', { title: 'x' })).rejects.toThrow(
        'XLSX generation requires { sheets: Array<'
      );
    });

    it('skips a sheet missing name or rows, but still renders the rest of the workbook', async () => {
      const result = await service.generate('xlsx', {
        sheets: [
          { rows: [['orphan']] },
          { name: 'ValidSheet', rows: [['kept']] },
        ],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      expect(workbook.worksheets.length).toBe(1);
      expect(workbook.getWorksheet('ValidSheet')).toBeDefined();
    });

    it('falls back to a single empty sheet when every sheet was malformed (never produces a zero-sheet workbook)', async () => {
      const result = await service.generate('xlsx', {
        sheets: [{ name: 'Bad', rows: 'not-an-array' }],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      expect(workbook.worksheets.length).toBe(1);
    });

    it('sanitizes illegal characters and truncates sheet names over 31 characters', async () => {
      const longName = 'A'.repeat(40);
      const result = await service.generate('xlsx', {
        sheets: [
          { name: 'Bad/Name:Here', rows: [['x']] },
          { name: longName, rows: [['y']] },
        ],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      const names = workbook.worksheets.map((ws) => ws.name);
      expect(names).toContain('Bad_Name_Here');
      expect(names.some((n) => n.length <= 31 && n.includes('AAAA'))).toBe(true);
    });

    it('de-duplicates sheet names that collide after sanitization', async () => {
      const result = await service.generate('xlsx', {
        sheets: [
          { name: 'Report', rows: [['1']] },
          { name: 'Report', rows: [['2']] },
        ],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      const names = workbook.worksheets.map((ws) => ws.name);
      expect(new Set(names).size).toBe(2);
      expect(names).toContain('Report');
    });

    // Regression guards (2026-07-15, found by adversarial review of PR#108).
    it('skips a malformed individual row (not an array) but keeps the rest of the sheet, instead of crashing', async () => {
      const result = await service.generate('xlsx', {
        sheets: [
          {
            name: 'Mixed',
            rows: [['good', 1], { Region: 'EMEA', Revenue: 12000 }, null, ['also good', 2]],
          },
        ],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      const sheet = workbook.getWorksheet('Mixed');
      expect(sheet).toBeDefined();
      expect(sheet!.getRow(1).getCell(1).value).toBe('good');
      expect(sheet!.getRow(2).getCell(1).value).toBe('also good');
    });

    it('de-duplicates sheet names that collide only after case-insensitive comparison (ExcelJS uniqueness is case-insensitive)', async () => {
      const result = await service.generate('xlsx', {
        sheets: [
          { name: 'Report', rows: [['1']] },
          { name: 'REPORT', rows: [['2']] },
        ],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      const names = workbook.worksheets.map((ws) => ws.name);
      expect(names.length).toBe(2);
      const lower = names.map((n) => n.toLowerCase());
      expect(new Set(lower).size).toBe(2);
    });

    it('strips a leading/trailing single quote from a sheet name (Excel rejects it otherwise)', async () => {
      const result = await service.generate('xlsx', {
        sheets: [
          { name: "'Notes", rows: [['a']] },
          { name: "Notes'", rows: [['b']] },
        ],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      for (const ws of workbook.worksheets) {
        expect(ws.name.startsWith("'")).toBe(false);
        expect(ws.name.endsWith("'")).toBe(false);
      }
    });

    it('renames the reserved sheet name "History" instead of letting ExcelJS reject it', async () => {
      const result = await service.generate('xlsx', {
        sheets: [{ name: 'History', rows: [['a']] }],
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(result.buffer);
      expect(workbook.worksheets.length).toBe(1);
      expect(workbook.worksheets[0].name.toLowerCase()).not.toBe('history');
    });
  });

  describe('pdf', () => {
    it('renders a title + heading + paragraph + bullet_list + table into a real PDF with actual content', async () => {
      const result = await service.generate(
        'pdf',
        {
          title: 'Quarterly Report',
          sections: [
            { type: 'heading', text: 'Summary', level: 1 },
            { type: 'paragraph', text: 'Revenue grew steadily this quarter.' },
            { type: 'bullet_list', items: ['Point one', 'Point two'] },
            { type: 'table', headers: ['Region', 'Revenue'], rows: [['EMEA', 12000], ['APAC', 9000]] },
          ],
        },
        'report'
      );

      expect(result.filename).toBe('report.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');

      // Extract real text and verify actual content — not just "%PDF-"
      // header bytes (see the DOCX/XLSX review lesson: a byte-signature-only
      // check would pass even if renderPdf silently dropped all content).
      const text = await extractPdfText(result.buffer);
      expect(text).toContain('Quarterly Report');
      expect(text).toContain('Summary');
      expect(text).toContain('Revenue grew steadily this quarter.');
      expect(text).toContain('Point one');
      expect(text).toContain('Point two');
      expect(text).toContain('Region');
      expect(text).toContain('EMEA');
      expect(text).toContain('12000');

      // Regression guard (2026-07-15, found by adversarial review): the table
      // header's "bold" font is passed as `font: { family: 'Helvetica-Bold' }`,
      // which pdfkit's cell renderer silently ignores — only `font.src`
      // actually triggers a font switch. A real Helvetica-Bold font object is
      // only embedded in the PDF's resource dictionary when it was actually
      // selected somewhere, so its presence in the raw bytes is a reliable
      // (if indirect) signal that the header row's bold styling took effect.
      expect(result.buffer.toString('latin1')).toContain('Helvetica-Bold');
    });

    it('normalizes jagged table rows (more or fewer cells than the header) instead of crashing pdfkit', async () => {
      // pdfkit's table renderer computes column widths from the header row's
      // cell count; a data row with MORE cells indexes past that array and
      // throws deep inside pdfkit ("unsupported number: undefined"),
      // destroying the whole document — confirmed by adversarial review
      // against the real installed pdfkit@0.19.1.
      const result = await service.generate('pdf', {
        sections: [
          { type: 'paragraph', text: 'Before the table.' },
          {
            type: 'table',
            headers: ['Region', 'Revenue'],
            rows: [['EMEA', 12000, 'extra-cell'], ['APAC']],
          },
          { type: 'paragraph', text: 'After the table.' },
        ],
      });

      expect(result.buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
      const text = await extractPdfText(result.buffer);
      expect(text).toContain('Before the table.');
      expect(text).toContain('EMEA');
      expect(text).toContain('APAC');
      expect(text).toContain('After the table.');
    });

    it('coerces non-string bullet_list items instead of crashing pdfkit', async () => {
      // pdfkit's .list() calls string methods (e.g. charCodeAt) directly on
      // each item — a number/object/null item throws
      // "this.string.charCodeAt is not a function" and destroys the whole
      // document, confirmed by adversarial review against the real
      // installed pdfkit@0.19.1.
      const result = await service.generate('pdf', {
        sections: [{ type: 'bullet_list', items: ['ok', 42, { nested: true }, null] }],
      });

      expect(result.buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
      const text = await extractPdfText(result.buffer);
      expect(text).toContain('ok');
      expect(text).toContain('42');
    });

    it('skips a null/non-object entry in sections but still renders the rest of the document', async () => {
      const result = await service.generate('pdf', {
        sections: [null, { type: 'paragraph', text: 'Survives the null sibling.' }],
      });

      expect(result.buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
      const text = await extractPdfText(result.buffer);
      expect(text).toContain('Survives the null sibling.');
    });

    it('renders a minimal document with no title and a single paragraph', async () => {
      const result = await service.generate('pdf', {
        sections: [{ type: 'paragraph', text: 'Just one line.' }],
      });

      expect(result.buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
      const text = await extractPdfText(result.buffer);
      expect(text).toContain('Just one line.');
    });

    it('throws when content has no sections array', async () => {
      await expect(service.generate('pdf', { title: 'x' })).rejects.toThrow(
        'PDF generation requires { title?: string, sections: Array<'
      );
    });

    it('skips an unrecognized section type but still renders the rest of the document', async () => {
      const result = await service.generate('pdf', {
        sections: [
          { type: 'quote', text: 'not a real section type' },
          { type: 'paragraph', text: 'This one is valid.' },
        ],
      });

      const text = await extractPdfText(result.buffer);
      expect(text).toContain('This one is valid.');
      expect(text).not.toContain('not a real section type');
    });

    it('skips a bullet_list section missing items, but still renders the rest of the document', async () => {
      const result = await service.generate('pdf', {
        sections: [
          { type: 'bullet_list' },
          { type: 'paragraph', text: 'Survives the malformed sibling.' },
        ],
      });

      const text = await extractPdfText(result.buffer);
      expect(text).toContain('Survives the malformed sibling.');
    });

    it('skips a table section missing headers or rows, but still renders the rest of the document', async () => {
      const resultMissingRows = await service.generate('pdf', {
        sections: [
          { type: 'table', headers: ['A', 'B'] },
          { type: 'paragraph', text: 'After a table missing rows.' },
        ],
      });
      expect(await extractPdfText(resultMissingRows.buffer)).toContain('After a table missing rows.');

      const resultMissingHeaders = await service.generate('pdf', {
        sections: [
          { type: 'table', rows: [['x', 'y']] },
          { type: 'paragraph', text: 'After a table missing headers.' },
        ],
      });
      expect(await extractPdfText(resultMissingHeaders.buffer)).toContain('After a table missing headers.');
    });

    it('drops a malformed individual row (not an array) inside an otherwise valid table, instead of crashing', async () => {
      const result = await service.generate('pdf', {
        sections: [
          {
            type: 'table',
            headers: ['Region', 'Revenue'],
            rows: [['EMEA', 12000], { Region: 'bad', Revenue: 1 }, null, ['APAC', 9000]],
          },
        ],
      });

      const text = await extractPdfText(result.buffer);
      expect(text).toContain('EMEA');
      expect(text).toContain('APAC');
    });
  });

  describe('pptx', () => {
    it('renders a title slide + content slide (title, paragraph, bullet_list, table) into a real PPTX with actual content', async () => {
      const result = await service.generate(
        'pptx',
        {
          title: 'Quarterly Report',
          slides: [
            {
              title: 'Summary',
              items: [
                { type: 'paragraph', text: 'Revenue grew steadily this quarter.' },
                { type: 'bullet_list', items: ['Point one', 'Point two'] },
                { type: 'table', headers: ['Region', 'Revenue'], rows: [['EMEA', 12000], ['APAC', 9000]] },
              ],
            },
          ],
        },
        'report'
      );

      expect(result.filename).toBe('report.pptx');
      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.buffer.subarray(0, 2).toString('utf-8')).toBe('PK');

      // Unzip and verify the ACTUAL content landed in the slide XML — not
      // just "some zip buffer was produced" (see the DOCX/XLSX/PDF review
      // lesson: a byte-signature-only check would pass even if renderPptx
      // silently dropped all content).
      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('Quarterly Report');
      expect(xml).toContain('Summary');
      expect(xml).toContain('Revenue grew steadily this quarter.');
      expect(xml).toContain('Point one');
      expect(xml).toContain('Point two');
      expect(xml).toContain('Region');
      expect(xml).toContain('EMEA');
      expect(xml).toContain('12000');

      // The table header cells are requested bold (options: { bold: true })
      // — pptxgenjs uses a real boolean flag (unlike pdfkit's font.src trap),
      // so verify the resulting run-properties actually carry b="1".
      expect(xml).toMatch(/<a:rPr[^>]*\bb="1"/);
    });

    it('renders a minimal single-slide deck with no title and a single bullet_list', async () => {
      const result = await service.generate('pptx', {
        slides: [{ items: [{ type: 'bullet_list', items: ['Just one bullet.'] }] }],
      });

      expect(result.buffer.subarray(0, 2).toString('utf-8')).toBe('PK');
      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('Just one bullet.');
    });

    it('throws when content has no slides array', async () => {
      await expect(service.generate('pptx', { title: 'x' })).rejects.toThrow(
        'PPTX generation requires { title?: string, slides: Array<'
      );
    });

    it('skips a slide missing an items array, but still renders the rest of the deck', async () => {
      const result = await service.generate('pptx', {
        slides: [
          { title: 'Orphan' },
          { items: [{ type: 'paragraph', text: 'Survives the malformed sibling.' }] },
        ],
      });

      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('Survives the malformed sibling.');
      expect(xml).not.toContain('Orphan');
    });

    it('skips an unrecognized slide-item type but still renders the rest of the slide', async () => {
      const result = await service.generate('pptx', {
        slides: [
          {
            items: [
              { type: 'quote', text: 'not a real item type' },
              { type: 'paragraph', text: 'This one is valid.' },
            ],
          },
        ],
      });

      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('This one is valid.');
      expect(xml).not.toContain('not a real item type');
    });

    it('skips a bullet_list item missing items, but still renders the rest of the slide', async () => {
      const result = await service.generate('pptx', {
        slides: [
          {
            items: [
              { type: 'bullet_list' },
              { type: 'paragraph', text: 'Survives the malformed sibling.' },
            ],
          },
        ],
      });

      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('Survives the malformed sibling.');
    });

    it('skips a table item missing headers or rows, but still renders the rest of the slide', async () => {
      const resultMissingRows = await service.generate('pptx', {
        slides: [{ items: [
          { type: 'table', headers: ['A', 'B'] },
          { type: 'paragraph', text: 'After a table missing rows.' },
        ] }],
      });
      expect(await readAllSlideXml(resultMissingRows.buffer)).toContain('After a table missing rows.');

      const resultMissingHeaders = await service.generate('pptx', {
        slides: [{ items: [
          { type: 'table', rows: [['x', 'y']] },
          { type: 'paragraph', text: 'After a table missing headers.' },
        ] }],
      });
      expect(await readAllSlideXml(resultMissingHeaders.buffer)).toContain('After a table missing headers.');
    });

    it('coerces non-string bullet_list items and normalizes jagged table rows instead of crashing', async () => {
      const result = await service.generate('pptx', {
        slides: [{
          items: [
            { type: 'bullet_list', items: ['ok', 42, { nested: true }, null] },
            {
              type: 'table',
              headers: ['Region', 'Revenue'],
              rows: [['EMEA', 12000, 'extra-cell'], ['APAC'], { not: 'an array' }, null],
            },
          ],
        }],
      });

      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('ok');
      expect(xml).toContain('42');
      expect(xml).toContain('EMEA');
      expect(xml).toContain('APAC');
    });

    it('falls back to a single empty slide when every slide was malformed (never produces a zero-slide deck)', async () => {
      const result = await service.generate('pptx', {
        slides: [{ items: 'not-an-array' }],
      });

      const zip = await JSZip.loadAsync(result.buffer);
      const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      expect(slideFiles.length).toBe(1);
    });

    // Regression guard (2026-07-15, found by adversarial review of this PR):
    // content.title was only truthy-checked, not type-checked, unlike the
    // sibling slide.title guard a few lines below it — an object-shaped
    // title crashed pptxgenjs with "newObject.text.forEach is not a
    // function" instead of degrading gracefully.
    it('skips a non-string presentation title instead of crashing, but still renders the rest of the deck', async () => {
      const result = await service.generate('pptx', {
        title: { nested: true },
        slides: [{ items: [{ type: 'paragraph', text: 'Survives a malformed deck title.' }] }],
      });

      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('Survives a malformed deck title.');
      // No title slide should have been added for the malformed title.
      expect(await countSlideFiles(result.buffer)).toBe(1);
    });

    it('does not crash on a boolean presentation title either', async () => {
      await expect(
        service.generate('pptx', { title: true, slides: [{ items: [{ type: 'paragraph', text: 'ok' }] }] })
      ).resolves.toBeTruthy();
    });

    // Regression guard (2026-07-15, found by adversarial review): headers:[]
    // passed the Array.isArray check, drove headerCount to 0, and every data
    // row was then normalized (padded/truncated) to zero cells — silently
    // discarding the entire table instead of rendering a headerless dump
    // (the XLSX renderer's equivalent case correctly preserves row data).
    it('does not silently discard table data when headers is an empty array (headerless table dump)', async () => {
      const result = await service.generate('pptx', {
        slides: [{
          items: [{
            type: 'table',
            headers: [],
            rows: [['Alpha', 'Bravo', 'Charlie'], ['Delta', 'Echo', 'Foxtrot']],
          }],
        }],
      });

      const texts = extractSlideTexts(await readAllSlideXml(result.buffer));
      expect(texts).toContain('Alpha');
      expect(texts).toContain('Bravo');
      expect(texts).toContain('Charlie');
      expect(texts).toContain('Delta');
      expect(texts).toContain('Echo');
      expect(texts).toContain('Foxtrot');
    });

    // Regression guard (2026-07-15, found by adversarial review): table row
    // cells were String()-coerced but header cells were not — a non-string
    // header (boolean/null/object) rendered as a completely blank cell
    // instead of a stringified label.
    it('coerces non-string table header values instead of rendering a blank cell', async () => {
      const result = await service.generate('pptx', {
        slides: [{
          items: [{
            type: 'table',
            headers: ['Name', true, null, 42],
            rows: [['Alice', 'yes', 'n/a', '1']],
          }],
        }],
      });

      const texts = extractSlideTexts(await readAllSlideXml(result.buffer));
      expect(texts).toContain('Name');
      expect(texts).toContain('true');
      expect(texts).toContain('42');
    });

    // Regression guard (2026-07-15, found by adversarial review): every item
    // is placed at an absolute y-coordinate with no check against the
    // slide's actual height, so a moderately content-rich slide silently
    // pushed shapes below the visible slide bounds (present in the XML,
    // invisible in Slide Show). Verify the renderer now starts a
    // continuation slide instead of overflowing.
    it('auto-paginates when a slide\'s content would overflow the visible slide bounds', async () => {
      const result = await service.generate('pptx', {
        slides: [{
          title: 'Long Slide',
          items: [
            { type: 'paragraph', text: 'Paragraph one.' },
            { type: 'paragraph', text: 'Paragraph two.' },
            { type: 'paragraph', text: 'Paragraph three.' },
            { type: 'paragraph', text: 'Paragraph four.' },
            { type: 'paragraph', text: 'Paragraph five.' },
          ],
        }],
      });

      expect(await countSlideFiles(result.buffer)).toBeGreaterThan(1);
      const xml = await readAllSlideXml(result.buffer);
      expect(xml).toContain('Paragraph one.');
      expect(xml).toContain('Paragraph five.');
      expect(xml).toContain('(cont.)');
    });
  });

  describe('zip', () => {
    it('bundles multiple real files of different formats into a real zip, each with actual rendered content', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'report.csv', format: 'csv', content: { headers: ['Region', 'Revenue'], rows: [['EMEA', 12000]] } },
          { filename: 'data.json', format: 'json', content: { ok: true, count: 3 } },
          { filename: 'notes.md', format: 'markdown', content: '# Notes\n\nSomething important.' },
        ],
      });

      expect(result.filename).toBe('generated.zip');
      expect(result.mimeType).toBe('application/zip');
      expect(result.buffer.subarray(0, 2).toString('utf-8')).toBe('PK');

      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files).sort()).toEqual(['data.json', 'notes.md', 'report.csv']);

      const csv = await zip.file('report.csv')!.async('string');
      expect(csv).toContain('Region,Revenue');
      expect(csv).toContain('EMEA,12000');

      const json = await zip.file('data.json')!.async('string');
      expect(JSON.parse(json)).toEqual({ ok: true, count: 3 });

      const md = await zip.file('notes.md')!.async('string');
      expect(md).toContain('Something important.');
    });

    it('throws when content has no files array', async () => {
      await expect(service.generate('zip', {})).rejects.toThrow('ZIP generation requires');
    });

    it('throws when files is an empty array', async () => {
      await expect(service.generate('zip', { files: [] })).rejects.toThrow('at least one file');
    });

    it('skips a malformed entry (not an object) but still bundles the rest', async () => {
      const result = await service.generate('zip', {
        files: [
          null,
          { filename: 'ok.json', format: 'json', content: { a: 1 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files)).toEqual(['ok.json']);
    });

    it('skips an entry missing a filename but still bundles the rest', async () => {
      const result = await service.generate('zip', {
        files: [
          { format: 'json', content: { a: 1 } },
          { filename: 'ok.json', format: 'json', content: { a: 1 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files)).toEqual(['ok.json']);
    });

    it('skips an entry with an unsupported/unrecognized format, including a nested "zip" format', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'nested.zip', format: 'zip', content: { files: [] } },
          { filename: 'made-up.xyz', format: 'not-a-real-format', content: {} },
          { filename: 'ok.json', format: 'json', content: { a: 1 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files)).toEqual(['ok.json']);
    });

    it('skips an entry whose content fails its own format renderer, but still bundles the rest', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'broken.csv', format: 'csv', content: { not: 'valid csv content' } },
          { filename: 'ok.json', format: 'json', content: { a: 1 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files)).toEqual(['ok.json']);
    });

    it('throws when every entry is malformed, unsupported, or fails to render', async () => {
      await expect(
        service.generate('zip', {
          files: [
            null,
            { filename: 'broken.csv', format: 'csv', content: { not: 'valid' } },
          ],
        })
      ).rejects.toThrow('zero valid files');
    });

    // Regression guard (proactively applied from this session's zip-slip
    // awareness): a model-supplied filename containing path traversal must
    // never place the entry outside the archive root or in a subfolder.
    it('sanitizes a path-traversal filename down to its basename (zip-slip defense)', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: '../../etc/passwd.csv', format: 'csv', content: { headers: ['a'], rows: [['1']] } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      expect(names).toEqual(['passwd.csv']);
      expect(names.some((n) => n.includes('..') || n.includes('/'))).toBe(false);
    });

    it('deduplicates a case-insensitive filename collision instead of one entry overwriting the other', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'report.json', format: 'json', content: { first: true } },
          { filename: 'REPORT.json', format: 'json', content: { second: true } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names.length).toBe(2);
      const first = JSON.parse(await zip.file(names[0])!.async('string'));
      const second = JSON.parse(await zip.file(names[1])!.async('string'));
      expect([first, second]).toEqual(expect.arrayContaining([{ first: true }, { second: true }]));
    });

    it('normalizes a mismatched known extension instead of doubling it', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'report.csv', format: 'markdown', content: '# Hello' },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files)).toEqual(['report.md']);
    });

    // Regression guard (2026-07-16, found by adversarial review): a NUL byte
    // (and other C0 control chars) survived into the archive's raw
    // central-directory filename bytes, which many native/legacy unzip
    // tools truncate at — a classic null-byte-injection vector.
    it('strips control characters (including NUL) from a zip entry filename', async () => {
      const result = await service.generate('zip', {
        files: [{ filename: 'evil.json\0hidden.txt', format: 'json', content: { a: 1 } }],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      // '.txt' is a known extension (the code-generation fallback extension)
      // as of this PR, so it's stripped before the target extension is
      // appended, same as any other known-extension mismatch.
      expect(names).toEqual(['evil.jsonhidden.json']);
      expect(names[0]).not.toMatch(/[\x00-\x1F\x7F]/);
    });

    // Regression guard (2026-07-16, found by adversarial review): a Unicode
    // right-to-left-override character (the same trick used in real-world
    // disguised-archive malware) survived unsanitized, letting the
    // displayed filename visually spoof a different name/extension.
    it('strips Unicode bidi/format control characters (e.g. RTLO) from a zip entry filename', async () => {
      const rtlo = '‮';
      const result = await service.generate('zip', {
        files: [{ filename: `invoice${rtlo}gnp.txt`, format: 'markdown', content: '# hi' }],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      expect(names[0]).not.toContain(rtlo);
      // '.txt' is a known extension as of this PR (see the control-char
      // test above for why), so it's stripped before '.md' is appended.
      expect(names[0]).toBe('invoicegnp.md');
    });

    // Regression guard (2026-07-16, found by adversarial review): Windows-
    // invalid characters and reserved device stems (CON/COM1/etc.) passed
    // through unsanitized, unlike the sibling XLSX sheet-name sanitizer.
    it('strips Windows-invalid characters and renames a Windows-reserved device stem', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'a:b*c?.csv', format: 'csv', content: { headers: ['x'], rows: [['1']] } },
          { filename: 'CON.json', format: 'json', content: { a: 1 } },
          { filename: 'com1.json', format: 'json', content: { b: 2 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      expect(names).toContain('abc.csv');
      expect(names.some((n) => /[<>:"|?*]/.test(n))).toBe(false);
      expect(names).toContain('CON_file.json');
      expect(names).toContain('com1_file.json');
    });

    // Regression guard (2026-07-16, found by adversarial review): an
    // unbounded filename let a single overlong name wrap the zip format's
    // 16-bit entry-name-length field, silently corrupting/dropping an
    // UNRELATED sibling entry elsewhere in the same archive — real
    // cross-entry data loss, not just an unextractable-name cosmetic issue.
    it('caps an overlong filename so it cannot corrupt an unrelated sibling entry', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'normal_report.csv', format: 'csv', content: { headers: ['x'], rows: [['1']] } },
          { filename: 'a'.repeat(70000) + '.csv', format: 'csv', content: { headers: ['y'], rows: [['2']] } },
          { filename: 'another_normal_file.json', format: 'json', content: { ok: true } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      expect(names).toContain('normal_report.csv');
      expect(names).toContain('another_normal_file.json');
      expect(names.length).toBe(3);
    });

    // Regression guard (2026-07-16, found by adversarial review): a
    // dot-only or whitespace-only trailing path segment survived as a
    // literal (blank-looking) filename instead of falling back sanely.
    it('does not produce a blank-looking filename from a dot-only or whitespace-only segment', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: '...', format: 'json', content: { a: 1 } },
          { filename: 'sub/   ', format: 'json', content: { b: 2 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      expect(names.length).toBe(2);
      for (const name of names) {
        expect(name.replace(/\.json$/, '').trim()).not.toBe('');
        expect(/^\.*$/.test(name.replace(/\.json$/, ''))).toBe(false);
      }
    });

    // Regression guard (2026-07-16, found by adversarial review): the
    // extension-mismatch strip regex was anchored to end-of-string, so a
    // trailing space or period defeated it entirely, producing a genuinely
    // broken double extension like "report.csv .csv".
    it('normalizes a mismatched extension even with trailing whitespace/dots in the filename', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'report.csv ', format: 'csv', content: { headers: ['x'], rows: [['1']] } },
          { filename: 'report2.csv.', format: 'csv', content: { headers: ['y'], rows: [['2']] } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['report.csv', 'report2.csv']);
    });

    // Regression guard (2026-07-16, found by adversarial review): the zip
    // test suite only ever bundled csv/json/markdown entries — the async
    // sub-formats (docx/xlsx/pdf/pptx) recursively rendered inside a zip
    // had zero regression coverage, despite being the code path most likely
    // to silently regress (e.g. a future refactor breaking the await chain
    // for one nested renderer).
    it('correctly awaits and bundles every async sub-format (docx/xlsx/pdf/pptx) with real content intact', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'doc.docx', format: 'docx', content: { sections: [{ type: 'paragraph', text: 'DOCX_MARKER_TEXT' }] } },
          { filename: 'sheet.xlsx', format: 'xlsx', content: { sheets: [{ name: 'Data', rows: [['XLSX_MARKER_CELL']] }] } },
          { filename: 'doc.pdf', format: 'pdf', content: { sections: [{ type: 'paragraph', text: 'PDF_MARKER_TEXT' }] } },
          { filename: 'deck.pptx', format: 'pptx', content: { slides: [{ items: [{ type: 'paragraph', text: 'PPTX_MARKER_TEXT' }] }] } },
        ],
      });

      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['deck.pptx', 'doc.docx', 'doc.pdf', 'sheet.xlsx']);

      const docxBuffer = await zip.file('doc.docx')!.async('nodebuffer');
      expect(await readDocumentXml(docxBuffer)).toContain('DOCX_MARKER_TEXT');

      const xlsxBuffer = await zip.file('sheet.xlsx')!.async('nodebuffer');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(xlsxBuffer);
      expect(workbook.getWorksheet('Data')!.getRow(1).getCell(1).value).toBe('XLSX_MARKER_CELL');

      const pdfBuffer = await zip.file('doc.pdf')!.async('nodebuffer');
      expect(await extractPdfText(pdfBuffer)).toContain('PDF_MARKER_TEXT');

      const pptxBuffer = await zip.file('deck.pptx')!.async('nodebuffer');
      expect(await readAllSlideXml(pptxBuffer)).toContain('PPTX_MARKER_TEXT');
    });

    it('bundles a code entry, resolving its extension from its own language rather than a static lookup', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'script', format: 'code', content: { language: 'python', code: 'print("hello")' } },
          { filename: 'ok.json', format: 'json', content: { a: 1 } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['ok.json', 'script.py']);
      expect(await zip.file('script.py')!.async('string')).toBe('print("hello")');
    });

    // Regression guard (2026-07-16, found by adversarial review): folding
    // EVERY code-language extension into the shared strip-known-extension
    // pattern caused short, common, non-code-specific extensions (.cs, .r,
    // .go, .c, .sh...) to be silently stripped from completely unrelated
    // NON-code entries' filenames — e.g. a csv report literally named
    // "report.cs" is not related to C# at all, but would lose its suffix.
    it('does NOT strip a short code-language-like extension from a NON-code zip entry filename', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'report.cs', format: 'csv', content: { headers: ['x'], rows: [['1']] } },
          { filename: 'draft.r', format: 'pdf', content: { sections: [{ type: 'paragraph', text: 'hi' }] } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['draft.r.pdf', 'report.cs.csv']);
    });

    // Regression guard (2026-07-16, found by adversarial review): the
    // strip-known-extension pattern for CODE entries was built from the
    // language map's canonical VALUES only, so a filename spelled with an
    // ALIAS key (e.g. "docker-compose.yml" for language "yaml"/"yml", or
    // "setup.bash" for language "bash") never matched and produced a
    // visibly broken doubled extension.
    it('normalizes a code entry filename spelled with an alias extension instead of doubling it', async () => {
      const result = await service.generate('zip', {
        files: [
          { filename: 'docker-compose.yml', format: 'code', content: { language: 'yaml', code: 'a: 1' } },
          { filename: 'setup.bash', format: 'code', content: { language: 'bash', code: 'echo hi' } },
          { filename: 'schema.gql', format: 'code', content: { language: 'graphql', code: 'type Q {}' } },
        ],
      });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['docker-compose.yaml', 'schema.graphql', 'setup.sh']);
    });
  });

  describe('code', () => {
    it('renders already-generated code verbatim as a downloadable file, with the extension resolved from language', async () => {
      const result = await service.generate(
        'code',
        { language: 'python', code: 'def add(a, b):\n    return a + b\n' },
        'report'
      );

      expect(result.filename).toBe('report.py');
      expect(result.mimeType).toBe('text/plain');
      expect(result.buffer.toString('utf-8')).toBe('def add(a, b):\n    return a + b\n');
    });

    it('resolves extensions for a variety of common languages, case/whitespace-insensitively', async () => {
      const cases: Array<[string, string]> = [
        ['javascript', 'js'],
        ['TypeScript', 'ts'],
        ['  Go  ', 'go'],
        ['rust', 'rs'],
        ['c++', 'cpp'],
        ['C#', 'cs'],
      ];
      for (const [language, expectedExtension] of cases) {
        const result = await service.generate('code', { language, code: 'x' }, 'file');
        expect(result.filename).toBe(`file.${expectedExtension}`);
      }
    });

    it('falls back to .txt for an unrecognized/niche language instead of rejecting the request', async () => {
      const result = await service.generate('code', { language: 'brainfuck', code: '++++' }, 'file');
      expect(result.filename).toBe('file.txt');
      expect(result.buffer.toString('utf-8')).toBe('++++');
    });

    // Regression guard (2026-07-16, found by adversarial review): a plain
    // object-literal lookup indexed by a fully model-controlled string
    // resolves inherited Object.prototype properties for keys like
    // "constructor"/"__proto__"/"toString" instead of falling back to the
    // default extension — a real, exploitable prototype-pollution-adjacent
    // bug, not just a theoretical one.
    it('falls back to .txt for a language name that collides with an Object.prototype property, instead of resolving a garbage extension', async () => {
      const cases = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
      for (const language of cases) {
        const result = await service.generate('code', { language, code: 'x' }, 'file');
        expect(result.filename).toBe('file.txt');
      }
    });

    it('throws when content is missing language or code', async () => {
      await expect(service.generate('code', { code: 'x' })).rejects.toThrow('Code generation requires');
      await expect(service.generate('code', { language: 'python' })).rejects.toThrow('Code generation requires');
      await expect(service.generate('code', { language: 'python', code: 42 })).rejects.toThrow('Code generation requires');
    });
  });
});
