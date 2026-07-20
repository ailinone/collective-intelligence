// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import { inferCapabilities } from '@/core/orchestration/capability-inference';

function infer(text: string) {
  return inferCapabilities([{ role: 'user', content: text }]);
}

describe('inferCapabilities — file generation (2026-07-14)', () => {
  it('detects csv_generation for an explicit CSV request', () => {
    const result = infer('Please generate a csv of the 5 planets closest to the sun');
    expect(result.requiredCapabilities).toContain('csv_generation');
  });

  it('detects docx_generation for an explicit Word document request', () => {
    const result = infer('Please generate a docx of the meeting minutes');
    expect(result.requiredCapabilities).toContain('docx_generation');
  });

  it('detects xlsx_generation for an explicit Excel/xlsx request', () => {
    expect(infer('Please generate an xlsx of the top 5 companies by revenue').requiredCapabilities).toContain('xlsx_generation');
    expect(infer('Create an excel spreadsheet with quarterly sales figures').requiredCapabilities).toContain('xlsx_generation');
    expect(infer('Export an excel workbook with two sheets').requiredCapabilities).toContain('xlsx_generation');
  });

  // Regression guard (2026-07-15, found by adversarial review of PR#108):
  // bare "spreadsheet"/"workbook" nouns are too ambiguous to trust alone —
  // "workbook" commonly means a practice booklet, and "excel" is a common
  // verb ("excel at swimming"). xlsx_generation must require the
  // unambiguous "xlsx" token or "excel" paired directly with a file noun.
  it('does NOT trigger xlsx_generation on a bare "workbook"/"spreadsheet" noun without "excel"/"xlsx"', () => {
    expect(infer('build a workbook of algebra exercises for my students').requiredCapabilities).not.toContain('xlsx_generation');
    expect(infer('write a spreadsheet formula that sums values excluding blanks').requiredCapabilities).not.toContain('xlsx_generation');
  });

  it('does NOT trigger xlsx_generation on "excel" used as a verb, not a file noun', () => {
    const result = infer('make a routine to excel at swimming');
    expect(result.requiredCapabilities).not.toContain('xlsx_generation');
  });

  it('detects pdf_generation for an explicit PDF request', () => {
    const result = infer('Please generate a pdf of the meeting minutes');
    expect(result.requiredCapabilities).toContain('pdf_generation');
  });

  it('does NOT trigger pdf_generation on a bare mention of the format with no generation intent', () => {
    const result = infer('What is a pdf file used for?');
    expect(result.requiredCapabilities).not.toContain('pdf_generation');
  });

  // Regression guard (2026-07-15, found by adversarial review of this PR):
  // "pdf" is a common qualifier for SOFTWARE-building requests, not just
  // document-generation ones — unlike "docx"/"xlsx" which rarely qualify a
  // tool/app noun this way.
  it('does NOT trigger pdf_generation when "pdf" qualifies a software/tool noun, not a document request', () => {
    expect(infer('make a pdf reader app in Python').requiredCapabilities).not.toContain('pdf_generation');
    expect(infer('build a pdf parser library').requiredCapabilities).not.toContain('pdf_generation');
    expect(infer('create a pdf viewer component').requiredCapabilities).not.toContain('pdf_generation');
    expect(infer('write a pdf compressor script').requiredCapabilities).not.toContain('pdf_generation');
  });

  it('detects pptx_generation for an explicit PowerPoint/slide-deck request', () => {
    expect(infer('Please generate a pptx of the sales overview').requiredCapabilities).toContain('pptx_generation');
    expect(infer('Create a powerpoint presentation about our roadmap').requiredCapabilities).toContain('pptx_generation');
    expect(infer('Build a slide deck for the investor pitch').requiredCapabilities).toContain('pptx_generation');
  });

  it('does NOT trigger pptx_generation on a bare mention of the format with no generation intent', () => {
    const result = infer('What is a pptx file used for?');
    expect(result.requiredCapabilities).not.toContain('pptx_generation');
  });

  // Regression guard, applying the PDF/XLSX lesson proactively: exclude
  // "powerpoint"/"slide deck" immediately followed by a software/tool noun.
  it('does NOT trigger pptx_generation when "powerpoint" qualifies a software/tool noun, not a presentation request', () => {
    expect(infer('build a powerpoint automation library').requiredCapabilities).not.toContain('pptx_generation');
  });

  // Regression guard (2026-07-15, found by adversarial review of this PR):
  // the tool-noun exclusion previously only worked when the noun followed
  // the format keyword ("pptx reader"); a tool noun BEFORE the keyword in
  // the same clause ("a tool to convert pptx to pdf") still false-positived.
  // Confirmed as a pre-existing, shared gap in the PDF/XLSX patterns too.
  it('does NOT trigger a generation capability when a tool noun precedes the format keyword in the same clause', () => {
    // Strengthened (2026-07-16, adversarial review of this PR): the first
    // assertion previously only checked not-pptx, which passed green while
    // the phrase inferred pdf_generation through the unguarded conversion
    // alternative — a tool-noun clause must produce NO file capability at
    // all, for either the source or the target format of the conversion.
    expect(infer('create a tool to convert pptx to pdf').requiredCapabilities).not.toContain('pptx_generation');
    expect(infer('create a tool to convert pptx to pdf').requiredCapabilities).not.toContain('pdf_generation');
    expect(infer('build a tool to export xlsx').requiredCapabilities).not.toContain('xlsx_generation');
    expect(infer('create a tool to make pdf').requiredCapabilities).not.toContain('pdf_generation');
  });

  // Regression guard (2026-07-15, found by adversarial review): the
  // tool-noun exclusion list was incomplete — several plausible
  // "build software that manipulates this format" requests still
  // false-positived, plus the "-like" suffix form wasn't excluded at all.
  it('does NOT trigger pptx_generation for other software-building phrasings the exclusion list previously missed', () => {
    expect(infer('build a powerpoint clone').requiredCapabilities).not.toContain('pptx_generation');
    expect(infer('build a powerpoint renderer').requiredCapabilities).not.toContain('pptx_generation');
    expect(infer('make a powerpoint plugin').requiredCapabilities).not.toContain('pptx_generation');
    expect(infer('build a slide deck engine').requiredCapabilities).not.toContain('pptx_generation');
    expect(infer('build a powerpoint-like app').requiredCapabilities).not.toContain('pptx_generation');
  });

  // Regression guard (2026-07-15, found by adversarial review): "slide deck"
  // required literal whitespace, so the common hyphenated phrasing
  // "slide-deck" was never detected.
  it('detects pptx_generation for the hyphenated "slide-deck" phrasing too', () => {
    expect(infer('build me a slide-deck for the pitch').requiredCapabilities).toContain('pptx_generation');
  });

  it('detects zip_generation for an explicit archive/bundle request', () => {
    expect(infer('Please generate a zip with these reports').requiredCapabilities).toContain('zip_generation');
    expect(infer('Create an archive of the exported files').requiredCapabilities).toContain('zip_generation');
  });

  it('detects zip_generation when "zip"/"bundle" is used directly as the verb', () => {
    expect(infer('Can you zip these files together for me?').requiredCapabilities).toContain('zip_generation');
    expect(infer('Please bundle these documents up').requiredCapabilities).toContain('zip_generation');
  });

  it('does NOT trigger zip_generation on a bare mention of "zip code" (postal code)', () => {
    expect(infer('What is your zip code?').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('Please generate a zip code for this address').requiredCapabilities).not.toContain('zip_generation');
  });

  // Applying the PDF/XLSX/PPTX lesson proactively: exclude a tool-noun
  // (before OR after the format keyword) so "build a tool to zip files" is a
  // software request, not an archive-generation request.
  it('does NOT trigger zip_generation when "zip"/"archive" qualifies a software/tool noun', () => {
    expect(infer('build a tool to zip files').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('create a zip extractor tool').requiredCapabilities).not.toContain('zip_generation');
  });

  it('does NOT trigger zip_generation on a bare mention of the format with no generation intent', () => {
    expect(infer('What is a zip file used for?').requiredCapabilities).not.toContain('zip_generation');
  });

  // Regression guard (2026-07-16, found by adversarial review of this PR):
  // a bare "archive" noun/verb is dangerously ambiguous with ordinary
  // business/document-management English that has nothing to do with
  // generating a downloadable zip file — none of docx/xlsx/pdf/pptx have a
  // bare trigger word this overloaded.
  it('does NOT trigger zip_generation on ordinary business-English uses of "archive" unrelated to file bundling', () => {
    expect(infer('export the archive of transactions').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('create an archive service to store audit logs').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('build an archive pipeline for old invoices').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('generate an archive strategy document').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('make an archive of contact records').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('export the national archive records').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('create a data warehouse archive').requiredCapabilities).not.toContain('zip_generation');
  });

  // Regression guard (2026-07-16, found by adversarial review): the bare
  // "these"/"them"/"together" pronoun triggers (with no files-ish object)
  // false-positived heavily on unrelated requests just because they
  // happened to contain the word "bundle".
  it('does NOT trigger zip_generation on "bundle"/"zip" used as a verb with a non-file object', () => {
    expect(infer('bundle my API calls together for efficiency').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('can you bundle my phone and internet together').requiredCapabilities).not.toContain('zip_generation');
    expect(infer('bundle these API requests together').requiredCapabilities).not.toContain('zip_generation');
  });

  // Regression guard (2026-07-16, found by adversarial review): the
  // determiner+noun sub-pattern required the noun to sit IMMEDIATELY after
  // the determiner with zero tolerance for a natural adjective in between.
  it('tolerates a single adjective between the determiner and the files-ish noun', () => {
    expect(infer('zip the exported files').requiredCapabilities).toContain('zip_generation');
    expect(infer('zip the attached documents').requiredCapabilities).toContain('zip_generation');
    expect(infer('bundle our finished reports').requiredCapabilities).toContain('zip_generation');
    expect(infer('zip my downloaded files').requiredCapabilities).toContain('zip_generation');
    expect(infer('bundle the final reports').requiredCapabilities).toContain('zip_generation');
  });

  // Regression guard (2026-07-16, found by adversarial review): "archive"
  // was treated as a zip-equivalent noun but omitted from the verb-as-object
  // alternative's verb list, an inconsistency within the same regex.
  it('detects zip_generation when "archive" is used directly as the verb, with an explicit files-ish object', () => {
    expect(infer('archive these documents into a zip').requiredCapabilities).toContain('zip_generation');
    expect(infer('please archive the reports').requiredCapabilities).toContain('zip_generation');
  });

  // code_file_generation must stay NARROW: the overwhelming majority of coding
  // requests want an in-chat code block, not a downloadable file — these
  // are the signals that DO explicitly ask for a downloadable file. Every
  // one requires the literal, deliberate word "downloadable" (or the
  // specific "download ... as a LANGUAGE file/script" phrasing) — see the
  // regression-guard tests below for why a bare generation-verb + language
  // + "file" (with no download-intent word) is deliberately NOT enough
  // (2026-07-16, adversarial review found that weaker version false-
  // positived on ordinary coding questions).
  it('detects code_file_generation for an explicit downloadable-code-file request', () => {
    expect(infer('create a downloadable python script').requiredCapabilities).toContain('code_file_generation');
    expect(infer('generate a downloadable typescript file').requiredCapabilities).toContain('code_file_generation');
    expect(infer('download this as a python file').requiredCapabilities).toContain('code_file_generation');
    expect(infer('download it as a javascript file').requiredCapabilities).toContain('code_file_generation');
  });

  // Regression guard: "downloadable file"/"download this as a file" with NO
  // language mentioned must NOT trigger code_file_generation — that phrasing is
  // indistinguishable from the pre-existing generic file_generation signal,
  // which must keep handling it (see the "detects the generic file_generation
  // tag" test below).
  it('does NOT trigger code_file_generation on a bare "downloadable file" with no language mentioned', () => {
    expect(infer('can you give me this as a downloadable file').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('Please generate a downloadable file with this content').requiredCapabilities).not.toContain('code_file_generation');
  });

  // Regression guard (2026-07-16, found by adversarial review): the FIRST
  // draft of this regex accepted ANY generation verb (generate/create/make/
  // produce/write) + language + "file" as sufficient, with no download-
  // intent requirement — confirmed to false-positive on canonical ordinary
  // requests. Fixed by requiring the literal word "downloadable".
  it('does NOT trigger code_file_generation on "verb + language + file" with no download-intent word (the confirmed false-positive class)', () => {
    expect(infer('write a python file to test this function').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('create a java file with a main method').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('make a css file for the homepage').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('write an html file with a contact form').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('generate a sql file with these queries').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('create a javascript file called utils.js with a debounce function').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('Please generate a python file for this').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('export this as a javascript file').requiredCapabilities).not.toContain('code_file_generation');
  });

  // Regression guard (2026-07-16, found by adversarial review): the
  // original bare "download" + language + file/script alternative also
  // false-positived on troubleshooting questions about downloading an
  // EXISTING third-party script, unrelated to generating new code. Fixed
  // by requiring the specific "download ... as a LANGUAGE file/script"
  // phrasing (literal "as a"), which none of these confirmed false
  // positives contain.
  it('does NOT trigger code_file_generation on questions about downloading an existing third-party script', () => {
    expect(infer('how do I download a python script from github').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('I want to download a javascript file from this URL and run it').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('can you show me how to download a python file using requests').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('how do I download a csharp script someone shared with me').requiredCapabilities).not.toContain('code_file_generation');
  });

  // Regression guard (this PR, applying the code_file_generation-specific-risk
  // lesson proactively): the overwhelming majority of coding requests must
  // NEVER trigger code_file_generation — that would silently convert a normal
  // chat-with-code-block answer into an unwanted file download, a far worse
  // regression than any other format's false positive.
  it('does NOT trigger code_file_generation on ordinary coding questions (the overwhelming majority case)', () => {
    expect(infer('write a python function that returns fibonacci numbers').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('how do I implement quicksort in python').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('generate code in python').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('make a rust program for sorting').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('write a script that renames files').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('create a class in java that represents a bank account').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('can you write me a javascript function to debounce clicks').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('implement a binary search in go').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('fix this python bug').requiredCapabilities).not.toContain('code_file_generation');
    expect(infer('refactor this typescript code').requiredCapabilities).not.toContain('code_file_generation');
  });

  it('detects json_generation for an explicit JSON request', () => {
    const result = infer('Create a json file with the API response schema');
    expect(result.requiredCapabilities).toContain('json_generation');
  });

  it('detects markdown_generation for an explicit markdown request', () => {
    const result = infer('Write a markdown report summarizing the meeting notes');
    expect(result.requiredCapabilities).toContain('markdown_generation');
  });

  it('detects the generic file_generation tag for a format-agnostic file request', () => {
    const result = infer('Please generate a downloadable file with this content');
    expect(result.requiredCapabilities).toContain('file_generation');
  });

  it('does NOT trigger on a bare mention of the format with no generation intent', () => {
    const result = infer('What is a csv file used for?');
    expect(result.requiredCapabilities).not.toContain('csv_generation');
  });

  it('does NOT trigger the generic file tag on unrelated uses of the word "file"', () => {
    const result = infer('Can you review this file for bugs?');
    expect(result.requiredCapabilities).not.toContain('file_generation');
  });

  it('prefers the most specific format over the generic tag when both could match', () => {
    const result = infer('Generate a json file with this data');
    expect(result.requiredCapabilities).toContain('json_generation');
    expect(result.requiredCapabilities).not.toContain('file_generation');
  });

  it('does NOT trigger docx_generation on a bare mention of Word with no generation intent', () => {
    const result = infer('What version of Word document format is docx?');
    expect(result.requiredCapabilities).not.toContain('docx_generation');
  });

  it('does NOT trigger xlsx_generation on a bare mention of Excel/spreadsheet with no generation intent', () => {
    const result = infer('What is the difference between xlsx and csv spreadsheet formats?');
    expect(result.requiredCapabilities).not.toContain('xlsx_generation');
  });
});

// 2026-07-16 architecture audit fixes: restructured to a shared
// verb/conversion/guard builder (buildStandardFileFormatRegex) so every
// standard format gets the SAME Portuguese coverage and the SAME tool-noun
// guard by construction, plus the `code_generation` -> `code_file_generation`
// rename to eliminate the catalog ModelCapability name collision. See
// filegen_capability_architecture_audit_2026_07_16 memory for the full audit.
describe('inferCapabilities — file generation architecture audit fixes (2026-07-16)', () => {
  // CONFIRMED finding: zero pt-BR verb support in any of the 10 file
  // regexes despite the sibling image/audio/video regexes having it.
  describe('pt-BR support (previously 12/12 natural phrasings missed)', () => {
    it('detects pdf_generation for pt-BR phrasings', () => {
      expect(infer('gere um pdf com o resumo da reuniao').requiredCapabilities).toContain('pdf_generation');
      expect(infer('exporte isso como um arquivo pdf').requiredCapabilities).toContain('pdf_generation');
      expect(infer('faça um pdf').requiredCapabilities).toContain('pdf_generation');
    });

    it('detects xlsx_generation for pt-BR phrasings, including bare "planilha"', () => {
      expect(infer('crie uma planilha excel com as vendas').requiredCapabilities).toContain('xlsx_generation');
      expect(infer('monte uma planilha').requiredCapabilities).toContain('xlsx_generation');
    });

    it('detects csv_generation for pt-BR phrasings', () => {
      expect(infer('gere um csv dos 5 maiores paises').requiredCapabilities).toContain('csv_generation');
      expect(infer('exporte os dados em csv').requiredCapabilities).toContain('csv_generation');
    });

    it('detects zip_generation for pt-BR phrasings', () => {
      expect(infer('crie um arquivo zip com esses relatorios').requiredCapabilities).toContain('zip_generation');
    });

    it('detects pptx_generation for the pt-BR "apresentação powerpoint" phrasing', () => {
      expect(infer('gere uma apresentação powerpoint sobre o roadmap').requiredCapabilities).toContain(
        'pptx_generation',
      );
    });

    it('detects docx_generation for the pt-BR "documento word" phrasing', () => {
      expect(infer('crie um documento word').requiredCapabilities).toContain('docx_generation');
    });

    it('detects json_generation and markdown_generation for pt-BR phrasings', () => {
      expect(infer('gere um json').requiredCapabilities).toContain('json_generation');
      expect(infer('crie um arquivo markdown').requiredCapabilities).toContain('markdown_generation');
    });
  });

  // CONFIRMED finding: the shared tool-noun guard was only applied to
  // xlsx/pdf/pptx/zip, never propagated to csv/json/markdown/docx.
  describe('tool-noun guard now applies uniformly to every format', () => {
    it('does NOT trigger csv_generation on a "build a csv parser" software request', () => {
      expect(infer('build a csv parser').requiredCapabilities).not.toContain('csv_generation');
    });

    it('does NOT trigger json_generation on a "create a json parser" software request', () => {
      expect(infer('create a json parser in rust').requiredCapabilities).not.toContain('json_generation');
    });

    it('does NOT trigger docx_generation on docx/word software-building requests', () => {
      expect(infer('write a docx parser in python').requiredCapabilities).not.toContain('docx_generation');
      expect(infer('build a word document converter').requiredCapabilities).not.toContain('docx_generation');
    });

    it('does NOT trigger markdown_generation on markdown software-building requests', () => {
      expect(infer('create a readme generator cli').requiredCapabilities).not.toContain('markdown_generation');
      expect(
        infer('create a markdown editor component in react').requiredCapabilities,
      ).not.toContain('markdown_generation');
    });

    // CONFIRMED finding: json_generation fired on ordinary API-building
    // requests ("write an API that returns json") — the guard list already
    // includes "api", it just wasn't wired into JSON_GEN_KEYWORDS before.
    it('does NOT trigger json_generation on ordinary API-building requests that merely mention json', () => {
      expect(infer('write an API that returns json').requiredCapabilities).not.toContain('json_generation');
      expect(infer('make a route that sends json').requiredCapabilities).not.toContain('json_generation');
      expect(infer('build an API serving json').requiredCapabilities).not.toContain('json_generation');
    });

    it('still detects json_generation on a genuine json file request', () => {
      expect(infer('generate a json file').requiredCapabilities).toContain('json_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // guard list was singular-only (except "libraries"), so the exact FP
    // class it blocks escaped in the plural.
    it('blocks the tool-noun class in the PLURAL too', () => {
      expect(infer('create json endpoints for my app').requiredCapabilities).not.toContain('json_generation');
      expect(infer('build csv parsers for each input format').requiredCapabilities).not.toContain('csv_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // guard list was English-only while GEN_VERBS accepts pt-BR verbs, so
    // pt-BR build-software requests sailed through ("crie um leitor de pdf"
    // false-positived while "create a pdf reader" was blocked), and bare
    // "planilha" fired on formula requests whose en sibling has a test
    // guaranteeing NO trigger.
    it('blocks the tool-noun class for pt-BR tool nouns too', () => {
      expect(infer('crie um leitor de pdf em python').requiredCapabilities).not.toContain('pdf_generation');
      expect(infer('faça um conversor de pdf para word em python').requiredCapabilities).not.toContain('pdf_generation');
      expect(infer('crie uma fórmula de planilha que some os valores').requiredCapabilities).not.toContain('xlsx_generation');
    });
  });

  // CONFIRMED finding: the verb list (generate/create/make/produce/export/
  // write/build, exact form only) missed the entire conversion/re-export
  // verb family and any inflected form.
  describe('conversion phrasing and verb inflections', () => {
    it('detects the target format for "convert X to/into Y" phrasings', () => {
      expect(infer('convert this csv to xlsx').requiredCapabilities).toContain('xlsx_generation');
      expect(infer('convert this markdown file to pdf').requiredCapabilities).toContain('pdf_generation');
      expect(infer('convert my word document to pdf please').requiredCapabilities).toContain('pdf_generation');
      expect(infer('turn this table into an excel spreadsheet').requiredCapabilities).toContain(
        'xlsx_generation',
      );
    });

    it('detects the target format for "save/get this as a Y" phrasings', () => {
      expect(infer('save this as a pdf').requiredCapabilities).toContain('pdf_generation');
      expect(infer('can I get this as a pdf?').requiredCapabilities).toContain('pdf_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // first draft of the shared verb table accepted inflected forms
    // (made/written/built/generated/exports/criado...) and they fired on
    // sentences DESCRIBING existing files, not requesting generation —
    // 14 executed examples, all clean before inflections were added. Verbs
    // are back to base/imperative/infinitive forms only; inflected genuine
    // requests ("creates a pdf from the notes") are an accepted false
    // negative of this fallback layer (the triage LLM covers them on the
    // primary path).
    it('does NOT trigger on sentences that merely DESCRIBE existing files or software behavior', () => {
      expect(infer('summarize the changes I made to the pdf').requiredCapabilities).not.toContain('pdf_generation');
      expect(infer('the notes written in the pdf are unclear, summarize them').requiredCapabilities).not.toContain('pdf_generation');
      expect(infer('the numbers generated in the csv look wrong, can you check?').requiredCapabilities).not.toContain('csv_generation');
      expect(infer('the dashboard we built exports json').requiredCapabilities).not.toContain('json_generation');
      expect(infer('explique o erro no relatório criado em pdf').requiredCapabilities).not.toContain('pdf_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // conversion alternative initially lacked the tool-noun guard, letting
    // "build software that converts X to Y" requests back in through the
    // side door the guard exists to block.
    it('does NOT trigger on build-software-that-converts requests, via the conversion alternative', () => {
      expect(infer('build a script that converts markdown to pdf').requiredCapabilities).not.toContain('pdf_generation');
      expect(infer('write a function that converts the report to pdf').requiredCapabilities).not.toContain('pdf_generation');
      expect(infer('implement an endpoint that converts uploads to pdf').requiredCapabilities).not.toContain('pdf_generation');
      const cliCaps = infer('make a cli that converts csv to xlsx').requiredCapabilities;
      expect(cliCaps).not.toContain('xlsx_generation');
      expect(cliCaps).not.toContain('csv_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): a
    // conversion targeting bare "json" wants the json INLINE in chat, not a
    // .json file download — only the explicit "json file/export" phrasing
    // converts to a file.
    it('does NOT trigger json_generation on conversions with inline-json intent', () => {
      expect(infer('turn the data into json').requiredCapabilities).not.toContain('json_generation');
      expect(infer('convert this yaml to json').requiredCapabilities).not.toContain('json_generation');
      expect(infer('convert this object to json so I can paste it in my code').requiredCapabilities).not.toContain('json_generation');
    });

    it('still detects json_generation when the conversion target is explicitly a json FILE', () => {
      expect(infer('convert this yaml to a json file').requiredCapabilities).toContain('json_generation');
    });
  });

  // CONFIRMED finding: the zip verb-as-object alternative false-positived on
  // frontend build-tooling phrasings naming a JS bundler.
  describe('zip bundler-tool exclusion', () => {
    it('does NOT trigger zip_generation on frontend bundler-tooling questions', () => {
      expect(infer('bundle the javascript files with webpack').requiredCapabilities).not.toContain(
        'zip_generation',
      );
      expect(infer('bundle the css files together').requiredCapabilities).not.toContain('zip_generation');
    });

    it('still detects zip_generation for genuine archive requests', () => {
      expect(infer('zip the exported files').requiredCapabilities).toContain('zip_generation');
      expect(infer('create a zip of these reports').requiredCapabilities).toContain('zip_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // source-code-adjective exclusion initially applied to ALL three verbs,
    // regressing genuine archive requests — "zip" as a verb is archive
    // intent regardless of the object's type; only "bundle" is the
    // build-tooling verb.
    it('still detects zip_generation when "zip" is the verb, even with source-code-ish objects', () => {
      expect(infer('zip the source files and let me download them').requiredCapabilities).toContain(
        'zip_generation',
      );
      expect(infer('zip the html files for the designer').requiredCapabilities).toContain('zip_generation');
    });
  });

  // The `code_generation` -> `code_file_generation` rename: the OLD string
  // is a pre-existing catalog ModelCapability ("this model is good at
  // writing code"), so an ordinary coding request must never produce it as
  // a file-generation signal, under either name.
  describe('code_file_generation rename (was code_generation, collided with the catalog ModelCapability)', () => {
    it('still detects code_file_generation for an explicit downloadable-code-file request', () => {
      expect(
        infer('Please generate a downloadable python file with a function.').requiredCapabilities,
      ).toContain('code_file_generation');
    });

    it('an ordinary coding question produces neither the old nor the new capability string', () => {
      const caps = infer('Write a python function that returns fibonacci.').requiredCapabilities;
      expect(caps).not.toContain('code_file_generation');
      expect(caps).not.toContain('code_generation');
    });

    // Raised (not adversarially re-verified) by the audit: the narrow design
    // missed its own triage-prompt canonical example because extension
    // tokens like ".py" weren't accepted alongside language names, and the
    // "as a X file ... I can download" word order didn't fit any alternative.
    it('detects code_file_generation for the "as a .ext file I can download" phrasing', () => {
      expect(infer('give me this as a .py file I can download').requiredCapabilities).toContain(
        'code_file_generation',
      );
    });

    it('does NOT trigger on "as a .ext file" when the user is describing something already downloaded', () => {
      expect(
        infer(
          'I have this as a .py file, I already downloaded it, can you fix the bug?',
        ).requiredCapabilities,
      ).not.toContain('code_file_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // extension branch of CODE_FILE_NOUN was unreachable in the
    // "downloadable ..." alternatives — `\b` before a literal dot never
    // asserts after whitespace (the same ASCII-\b bug class documented for
    // "áudio"), so "create a downloadable .py script" matched NOTHING.
    it('detects code_file_generation for "downloadable .ext file/script" phrasings (extension after whitespace)', () => {
      expect(infer('create a downloadable .py script').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable .ts file').requiredCapabilities).toContain('code_file_generation');
    });

    // Regression guard (2026-07-16, adversarial review of this PR): the
    // code format was the only one still English-only after the pt-BR
    // restructuring — an explicit pt-BR downloadable-code request produced
    // zero file capability.
    it('detects code_file_generation for explicit pt-BR downloadable-code phrasings', () => {
      expect(
        infer('gere um script python para download, quero baixar como arquivo .py').requiredCapabilities,
      ).toContain('code_file_generation');
      expect(infer('crie um arquivo .py baixável com esse script').requiredCapabilities).toContain(
        'code_file_generation',
      );
    });

    it('does NOT trigger on ordinary pt-BR coding questions', () => {
      expect(infer('escreva uma função python que retorna fibonacci').requiredCapabilities).not.toContain(
        'code_file_generation',
      );
      expect(infer('como faço para baixar um script python do github?').requiredCapabilities).not.toContain(
        'code_file_generation',
      );
    });

    // 2026-07-17: CODE_LANGUAGE_NAMES/CODE_FILE_EXTENSIONS widened to match
    // FileGenerationService's CODE_LANGUAGE_EXTENSIONS 1:1 (the render-side
    // map is the actual source of truth for what the system can produce).
    // Confirmed gaps before this fix (execution): xml/toml/scss/sass/vue/
    // yaml/ini were entirely ABSENT from detection — "generate a downloadable
    // xml file" produced ZERO file capability, not even the generic fallback
    // (the bare word sits between "downloadable" and "file", breaking that
    // pattern too).
    it('detects code_file_generation for languages that were previously entirely undetectable (xml/toml/scss/...)', () => {
      expect(infer('generate a downloadable xml file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable toml file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable scss file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable sass file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable yaml file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable vue file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable ini file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable graphql file').requiredCapabilities).toContain('code_file_generation');
    });

    // Short aliases (js/ts/py/go...) are now accepted as bare LANGUAGE names,
    // not only as dotted extension tokens — safe to widen because the
    // narrowness of this capability comes entirely from the required
    // "downloadable"/"download…as a" signal, not from which language token
    // fills the slot.
    it('detects code_file_generation for short language aliases used as bare words (js/ts/py/go)', () => {
      expect(infer('generate a downloadable js file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable ts file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable py file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable go file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable golang file').requiredCapabilities).toContain('code_file_generation');
    });

    it('still detects the full language names and extension-token phrasings (regression)', () => {
      expect(infer('generate a downloadable python file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable html file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('generate a downloadable typescript file').requiredCapabilities).toContain('code_file_generation');
      expect(infer('give me this as a .xml file I can download').requiredCapabilities).toContain('code_file_generation');
      expect(infer('give me this as a .tsx file I can download').requiredCapabilities).toContain('code_file_generation');
    });

    // Narrowness preserved: widening WHICH language tokens are recognized
    // must not weaken the "downloadable" signal requirement itself.
    it('does NOT trigger on ordinary questions about the newly-added languages (no download-intent signal)', () => {
      expect(infer('how do I parse an xml file in python').requiredCapabilities).not.toContain('code_file_generation');
      expect(infer('write a function that reads a toml config file').requiredCapabilities).not.toContain('code_file_generation');
      expect(infer('write some scss for a responsive navbar').requiredCapabilities).not.toContain('code_file_generation');
      expect(infer('write a js function that debounces clicks').requiredCapabilities).not.toContain('code_file_generation');
      expect(infer('implement a binary search in go').requiredCapabilities).not.toContain('code_file_generation');
    });
  });
});
