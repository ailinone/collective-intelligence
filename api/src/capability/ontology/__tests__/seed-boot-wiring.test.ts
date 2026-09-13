// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for the "ontology never seeded in production" incident
 * (SOTA audit, 2026-09-07): `capability_ontology` was empty for 100% of the
 * catalog because `seedCapabilityOntology` existed but was reachable only
 * from `scripts/hcra-reseed-ontology.ts` / `scripts/hcra-sprint1-bootstrap.ts`
 * — one-shot CLIs nobody re-ran, never wired into a migration or deploy step.
 * Every `model_capability_assertions` write silently hit the FK onto the
 * empty ontology table and was dropped, indefinitely.
 *
 * Two independent guards, so either kind of regression is caught:
 *
 *   1. `ONTOLOGY_SEED` itself must stay non-empty and every entry must
 *      resolve through `LEGACY_CAPABILITY_TO_URI` — the same map the writer,
 *      the discovery emitter, and the probe emitter depend on.
 *   2. `api/src/index.ts` boot sequence must still call
 *      `seedCapabilityOntology` (the fix wires it in — see the boot step
 *      right after `connectDatabase()`). This is a structural check on the
 *      SOURCE, not an import-and-run: booting the whole app in a unit test
 *      is out of scope, and the discovery-emitter integration test already
 *      proves the ontology round-trips against a real Postgres. What THIS
 *      test prevents is someone deleting the boot call and going back to
 *      "only a script seeds it" without any test failing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ONTOLOGY_SEED, LEGACY_CAPABILITY_TO_URI } from '../seed';

describe('ONTOLOGY_SEED', () => {
  it('is non-empty', () => {
    expect(ONTOLOGY_SEED.length).toBeGreaterThan(0);
  });

  it('every entry resolves through LEGACY_CAPABILITY_TO_URI', () => {
    for (const entry of ONTOLOGY_SEED) {
      expect(LEGACY_CAPABILITY_TO_URI[entry.slug]).toBe(`http://ailin.dev/cap/v1/${entry.slug}`);
    }
  });

  it('every broader/narrower edge points at a slug that is also seeded (no dangling reference)', () => {
    const knownUris = new Set(ONTOLOGY_SEED.map((e) => LEGACY_CAPABILITY_TO_URI[e.slug]));
    for (const entry of ONTOLOGY_SEED) {
      for (const u of [...entry.broader, ...entry.narrower]) {
        expect(knownUris.has(u), `${entry.slug} references unseeded URI ${u}`).toBe(true);
      }
    }
  });
});

describe('capability ontology boot wiring (index.ts)', () => {
  const indexSource = readFileSync(join(__dirname, '..', '..', '..', 'index.ts'), 'utf8');

  it('calls seedCapabilityOntology during boot, not only from a manual script', () => {
    expect(indexSource).toMatch(
      /import\(\s*['"]\.\/capability\/ontology\/seed(\.js)?['"]\s*\)/
    );
    expect(indexSource).toMatch(/await seedCapabilityOntology\(/);
  });

  it('the boot call happens after connectDatabase() (needs a live DB connection)', () => {
    const dbIdx = indexSource.indexOf('await connectDatabase()');
    const seedCallIdx = indexSource.indexOf('await seedCapabilityOntology(');
    expect(dbIdx).toBeGreaterThan(-1);
    expect(seedCallIdx).toBeGreaterThan(dbIdx);
  });

  it('failure to seed is non-fatal (wrapped so a transient DB hiccup does not crash boot)', () => {
    const seedCallIdx = indexSource.indexOf('await seedCapabilityOntology(');
    const surrounding = indexSource.slice(Math.max(0, seedCallIdx - 400), seedCallIdx);
    expect(surrounding).toMatch(/try\s*\{/);
  });
});
