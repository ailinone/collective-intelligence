// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Invariant: every multipart/form-data route must bypass Fastify's JSON body
 * validator.
 *
 * Live-traffic finding (LOTE AN). Fastify compiles the route's `schema.body`
 * into an Ajv validator that runs BEFORE the body parser. `@fastify/multipart`
 * is registered in stream mode (`src/server.ts`), so its parser calls `done()`
 * without a value and `request.body` stays `undefined`. A route that declares
 *
 *     consumes: ['multipart/form-data'],
 *     body: { type: 'object', required: ['file', ...] }
 *
 * therefore validates `undefined` against an object schema with required
 * properties and answers `400 {"code":"validation_error"}` before the handler
 * ever calls `request.file()`.
 *
 * Measured against the running server, POST /v1/files, /v1/images/edits,
 * /v1/images/variations and /v1/pdf/analyze all returned that 400 for a
 * perfectly well-formed multipart request, while the two audio routes — the
 * only ones carrying the bypass — reached their handlers. Since /v1/files is
 * the sole way to mint a file_id, the Files/Assistants/VectorStores/Batches/
 * FineTuning chain was unreachable end to end.
 *
 * The fix is one line per route:
 *     validatorCompiler: () => () => true,
 *
 * This test is deliberately source-level rather than HTTP-level: it needs no
 * database, no Redis and no provider keys, so it runs everywhere CI runs and
 * fails the moment somebody adds a seventh multipart route without the bypass.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** Recursively collect every .ts route source (excluding tests). */
function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectRouteFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

type RouteDecl = { file: string; method: string; routePath: string; body: string };

/**
 * Split a source file into per-route chunks.
 *
 * Each chunk starts at a `server.<method>(` call and runs to just before the
 * next one, so the route's options object — where both `consumes` and
 * `validatorCompiler` live — is contained within it.
 */
function extractRouteDeclarations(file: string): RouteDecl[] {
  const src = fs.readFileSync(file, 'utf8');
  const re = /server\.(post|put|patch)\(\s*(['"`])([^'"`]+)\2/g;
  const starts: Array<{ index: number; method: string; routePath: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    starts.push({ index: m.index, method: m[1], routePath: m[3] });
  }
  return starts.map((s, i) => ({
    file,
    method: s.method,
    routePath: s.routePath,
    body: src.slice(s.index, starts[i + 1]?.index ?? src.length),
  }));
}

const multipartRoutes = collectRouteFiles(ROUTES_DIR)
  .flatMap(extractRouteDeclarations)
  .filter((r) => r.body.includes('multipart/form-data'));

describe('multipart routes bypass JSON body validation', () => {
  it('finds the known multipart routes (guards against the scanner silently breaking)', () => {
    const found = multipartRoutes.map((r) => `${r.method.toUpperCase()} ${r.routePath}`).sort();
    // If this drops to zero the scanner regex has rotted and every other
    // assertion below would vacuously pass.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found).toEqual(
      expect.arrayContaining([
        'POST /v1/files',
        'POST /v1/images/edits',
        'POST /v1/images/variations',
        'POST /v1/pdf/analyze',
        'POST /v1/audio/transcriptions',
        'POST /v1/audio/translations',
      ])
    );
  });

  it.each(multipartRoutes.map((r) => [`${r.method.toUpperCase()} ${r.routePath}`, r] as const))(
    '%s declares validatorCompiler',
    (_label, route) => {
      const relative = path.relative(ROUTES_DIR, route.file).replace(/\\/g, '/');
      expect(
        route.body.includes('validatorCompiler'),
        `${route.method.toUpperCase()} ${route.routePath} (src/routes/${relative}) consumes ` +
          'multipart/form-data but does not set `validatorCompiler: () => () => true`. ' +
          "Fastify's Ajv validator runs before the multipart parser, so request.body is " +
          'undefined and the route will answer 400 validation_error for every upload.'
      ).toBe(true);
    }
  );

  it('every multipart route that declares a required body also has the bypass', () => {
    // The failure mode only bites when the body schema has `required`, so make
    // that combination explicit rather than relying on the blanket rule above.
    const offenders = multipartRoutes
      .filter((r) => /required:\s*\[/.test(r.body) && !r.body.includes('validatorCompiler'))
      .map((r) => `${r.method.toUpperCase()} ${r.routePath}`);
    expect(offenders).toEqual([]);
  });
});
