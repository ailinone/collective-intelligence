// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-inference-file-download-intent.test.ts — production incident
 * fix (2026-09-08), verified live against ailin.chat:
 *
 * Bug 3 (wrong routing): "Escreva um script Python que calcula Fibonacci e
 * gere o arquivo para download." (write a Python Fibonacci script AND
 * generate the file for download — explicit, unambiguous download intent)
 * produced ZERO file-generation capability from `inferCapabilities()`. Root
 * cause: `CODE_FILE_GEN_KEYWORDS` only matches when the language token
 * (e.g. "Python") sits within a ~20-25 char window of the download-intent
 * phrase — but this phrasing separates them with an intervening clause
 * describing what the script does ("que calcula Fibonacci e"), pushing the
 * gap to ~40 chars. `FILE_GEN_GENERIC_KEYWORDS`' pt-BR branch also missed it
 * independently: it required the indefinite article "um arquivo" (the
 * phrase uses the definite "o arquivo") AND "para baixar" (the phrase uses
 * the anglicism "para download").
 *
 * With no file-generation capability inferred, the request never got a
 * dedicated media-generation stage — production observed the model instead
 * producing the code as prose (or, per the report, calling an unrelated
 * notes-style tool) rather than routing to the real downloadable-file
 * pipeline that correctly fires for the platform's zip/PDF requests.
 *
 * Fixed with a decoupled signal (EXPLICIT_FILE_DOWNLOAD_INTENT_RE, gated on
 * CODE_FILE_NOUN_RE matching independently anywhere in the text) plus
 * widening FILE_GEN_GENERIC_KEYWORDS' pt-BR article/anglicism acceptance.
 * Mirrors the existing regex-behavior test pattern in
 * capability-inference-multimodal.test.ts (the only other test file
 * exercising `inferCapabilities()` directly).
 */
import { describe, it, expect } from 'vitest';
import { inferCapabilities } from '../capability-inference';

function textMessage(content: string) {
  return [{ role: 'user', content }];
}

describe('inferCapabilities — explicit file-download intent (Bug 3)', () => {
  it('the exact production-reported phrase now infers code_file_generation', () => {
    const result = inferCapabilities(
      textMessage(
        'Escreva um script Python que calcula Fibonacci e gere o arquivo para download.'
      )
    );
    expect(result.requiredCapabilities).toContain('code_file_generation');
  });

  it('a generic "gere o arquivo para download" with NO language mention falls back to generic file_generation', () => {
    const result = inferCapabilities(
      textMessage('Por favor, gere o arquivo para download com os dados do relatório.')
    );
    expect(result.requiredCapabilities).toContain('file_generation');
    expect(result.requiredCapabilities).not.toContain('code_file_generation');
  });

  it('the definite article ("o arquivo") and the anglicism ("para download") both now work for the generic fallback, not only "um arquivo ... para baixar"', () => {
    const withDefiniteArticleAndAnglicism = inferCapabilities(
      textMessage('Crie o arquivo para download com esses dados.')
    );
    expect(withDefiniteArticleAndAnglicism.requiredCapabilities).toContain('file_generation');

    // Original phrasing must keep working — this is a widening, not a
    // replacement.
    const original = inferCapabilities(
      textMessage('Crie um arquivo para baixar com esses dados.')
    );
    expect(original.requiredCapabilities).toContain('file_generation');
  });

  it('an English equivalent ("... and generate the file to download") also infers code_file_generation', () => {
    const result = inferCapabilities(
      textMessage(
        'Write a Python script that computes Fibonacci numbers and generate the file to download.'
      )
    );
    expect(result.requiredCapabilities).toContain('code_file_generation');
  });

  it('does NOT regress the documented false positive: an ordinary troubleshooting question about downloading an existing script', () => {
    const result = inferCapabilities(
      textMessage('How do I download a python script from github?')
    );
    expect(result.requiredCapabilities).not.toContain('code_file_generation');
    expect(result.requiredCapabilities).not.toContain('file_generation');
  });

  it('does NOT fire on a plain coding question with no download intent at all', () => {
    const result = inferCapabilities(
      textMessage('Write a Python function that reverses a string.')
    );
    expect(result.requiredCapabilities).not.toContain('code_file_generation');
    expect(result.requiredCapabilities).not.toContain('file_generation');
  });

  it('does NOT fire on an unrelated question that merely mentions downloading a file and a language separately', () => {
    const result = inferCapabilities(
      textMessage(
        'How do I download a file from S3 using the Python boto3 library, and is it thread-safe?'
      )
    );
    expect(result.requiredCapabilities).not.toContain('code_file_generation');
  });

  it('a concrete format request (zip) still wins over the new code-file-download signal — no regression to format priority', () => {
    const result = inferCapabilities(textMessage('Gere um zip com um script python para download.'));
    expect(result.requiredCapabilities).toContain('zip_generation');
    expect(result.requiredCapabilities).not.toContain('code_file_generation');
  });
});
