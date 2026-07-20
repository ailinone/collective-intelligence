// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SOTA dynamic-discovery guard.
 *
 * Until 2026-04-27 the file `api/src/config/model-catalog.ts` shipped a
 * 1768-line hand-curated `DEFAULT_MODEL_CATALOG` (~50 OpenAI rows, 1
 * Anthropic, 1 Google). The route `GET /v1/models` materialised those rows
 * into the response body whenever the runtime catalog table was empty
 * (cold-start, fresh deploy, post-truncation, fresh dev clone…).
 *
 * That fallback violated the SOTA dynamic-discovery contract: the route
 * advertised models that may not have been reachable, hiding genuine
 * cold-start emptiness behind synthetic inventory. The fix:
 *
 *   1. `api/src/config/model-catalog.ts` exports an empty array stub.
 *   2. `GET /v1/models` no longer falls back to it; it returns an empty
 *      list + a warn log + a background `centralModelDiscoveryService`
 *      trigger when the DB is empty.
 *
 * This guard makes those two invariants permanent — i.e. it fails CI if
 * anyone re-introduces a static seed (knowingly or not) by:
 *
 *   - Restoring rows to `DEFAULT_MODEL_CATALOG` (gate: array length === 0).
 *   - Importing `DEFAULT_MODEL_CATALOG` anywhere under `api/src/` outside
 *     the stub file itself, the central discovery service (which may
 *     legitimately type-reference the symbol while migrating), or this
 *     test file.
 *
 * If you have a genuine need to re-add hand-curated rows, STOP. The right
 * answer is a real provider model fetcher under
 * `api/src/services/model-fetchers/` registered with
 * `central-model-discovery-service.ts`. Update this test only after that
 * service is in place AND a project lead has reviewed why discovery is
 * insufficient.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative, sep } from 'path';
import { DEFAULT_MODEL_CATALOG } from '../model-catalog';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STUB_FILE = join(__dirname, '..', 'model-catalog.ts');
const SRC_ROOT = join(__dirname, '..', '..');
const REPO_API_ROOT = join(SRC_ROOT, '..');

// ─── Production-path scope ──────────────────────────────────────────────
//
// We exclude:
//   - The stub file itself (sole legitimate site of the symbol).
//   - This test file (it imports the symbol to assert emptiness).
//   - All test files (`__tests__/`, `*.test.ts`, `*.spec.ts`).
//   - The Prisma generated client (machine output, not in scope).
//   - Build artefacts under `dist/` (if any leak into src/).
const EXCLUDED_RELATIVE_PATHS = new Set<string>([
  'config/model-catalog.ts',
  'config/__tests__/no-static-model-catalog-fallback.test.ts',
]);

const EXCLUDED_DIR_SEGMENTS = ['__tests__', 'generated', 'dist', 'node_modules'];

const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

function* walkSourceFiles(root: string): Generator<string> {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_SEGMENTS.includes(entry.name)) continue;
      yield* walkSourceFiles(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_FILE_RE.test(entry.name)) continue;
    if (TEST_FILE_RE.test(entry.name)) continue;
    yield full;
  }
}

describe('SOTA guard: DEFAULT_MODEL_CATALOG is the deprecated empty stub', () => {
  it('exports an empty array (no static fallback rows allowed)', () => {
    // If this fails, someone re-added hand-curated model rows to
    // `api/src/config/model-catalog.ts`. Read the file's deprecation
    // header before changing this test or the file.
    expect(Array.isArray(DEFAULT_MODEL_CATALOG)).toBe(true);
    expect(DEFAULT_MODEL_CATALOG.length).toBe(0);
  });

  it('the stub file exists and remains short (no hidden inventory)', () => {
    // Defence-in-depth: a 1768-line file masquerading as "empty" via runtime
    // tricks (Object.defineProperty, lazy init, dynamic import) would still
    // bloat the diff and the bundle. Cap the file at a small line budget.
    const source = readFileSync(STUB_FILE, 'utf8');
    const lineCount = source.split('\n').length;
    // The current stub is ~33 lines (deprecation header + 1 export). Allow
    // headroom for future doc edits but trip the wire if real content sneaks
    // back in.
    expect(lineCount).toBeLessThanOrEqual(80);
  });
});

describe('SOTA guard: no production code path imports DEFAULT_MODEL_CATALOG', () => {
  it('zero imports of DEFAULT_MODEL_CATALOG outside the stub file', () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];

    // Match either the named-import form `import { DEFAULT_MODEL_CATALOG }`
    // or a require/dynamic-import that mentions the symbol or the stub
    // module path. We deliberately catch both `@/config/model-catalog` and
    // relative variants like `../config/model-catalog`.
    const importIdentRe = /\bDEFAULT_MODEL_CATALOG\b/;
    const importPathRe =
      /(?:from\s+['"][^'"\n]*\/config\/model-catalog['"]|require\(\s*['"][^'"\n]*\/config\/model-catalog['"]\s*\)|import\(\s*['"][^'"\n]*\/config\/model-catalog['"]\s*\))/;

    for (const file of walkSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (EXCLUDED_RELATIVE_PATHS.has(rel)) continue;

      const source = readFileSync(file, 'utf8');
      if (!importIdentRe.test(source) && !importPathRe.test(source)) continue;

      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line == null) continue;
        if (importIdentRe.test(line) || importPathRe.test(line)) {
          offenders.push({ file: rel, line: i + 1, snippet: line.trim() });
        }
      }
    }

    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  - ${o.file}:${o.line}  ${o.snippet}`)
        .join('\n');
      // eslint-disable-next-line no-console
      console.error(
        'no-static-model-catalog-fallback: production paths reference DEFAULT_MODEL_CATALOG. ' +
          'The static catalog is deprecated. Use central-model-discovery-service instead.\n' +
          detail,
      );
    }
    expect(offenders).toEqual([]);
  });
});

describe('SOTA guard: stub file is reachable + sized as expected', () => {
  // Sanity tests so a bad refactor of THIS test (path drift, glob breakage)
  // becomes obvious instead of silently passing zero scans.
  it('SRC_ROOT resolves to api/src and contains expected anchors', () => {
    expect(statSync(SRC_ROOT).isDirectory()).toBe(true);
    expect(statSync(join(SRC_ROOT, 'config')).isDirectory()).toBe(true);
    expect(statSync(join(SRC_ROOT, 'services')).isDirectory()).toBe(true);
    expect(statSync(join(SRC_ROOT, 'routes')).isDirectory()).toBe(true);
  });

  it('repo api root resolves correctly', () => {
    expect(statSync(REPO_API_ROOT).isDirectory()).toBe(true);
    // Sanity: api/ should sit next to its `package.json`.
    expect(statSync(join(REPO_API_ROOT, 'package.json')).isFile()).toBe(true);
  });

  it('walker visits a non-trivial number of files (regression smoke)', () => {
    let count = 0;
    for (const _file of walkSourceFiles(SRC_ROOT)) {
      count++;
      if (count > 50) break;
    }
    // If this drops to 0, the walker is broken (excluded too much) and the
    // import scan would silently pass. We require at least 50 files visited
    // before giving the import scan its credibility.
    expect(count).toBeGreaterThan(50);
  });
});
