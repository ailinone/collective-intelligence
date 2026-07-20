// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Internal-metadata contract invariant (type-safety follow-up, 2026-06-12).
 *
 * `__`-prefixed keys on OrchestrationResult.metadata are ENGINE-INTERNAL
 * bookkeeping. In JS/TS the dunder prefix is convention only — it enforces
 * nothing by itself. This test pins the three layers that turn the
 * convention into a guarantee:
 *
 *   1. CONTRACT  — every `__x` key the engine reads/writes on
 *      result.metadata is declared (typed + documented) in
 *      OrchestrationInternalMetadata. No ad-hoc stringly-typed keys.
 *   2. BOUNDARY  — the engine's public return strips every declared key
 *      (destructure into `publicMetadata`), so downstream consumers can
 *      never see them — even via a future careless spread.
 *   3. ENVELOPE  — chat-request-processor builds ailin_metadata from an
 *      explicit allowlist: it must never reference an internal key nor
 *      spread result.metadata wholesale.
 *
 * If you add a new internal key: declare it in OrchestrationInternalMetadata
 * AND add it to the boundary strip in orchestration-engine.ts — this test
 * fails loudly until both are done.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirnameLocal, '..', '..');

const typesSource = readFileSync(join(SRC, 'types', 'index.ts'), 'utf8');
const engineSource = readFileSync(join(SRC, 'core', 'orchestration', 'orchestration-engine.ts'), 'utf8');
const processorSource = readFileSync(join(SRC, 'services', 'chat-request-processor.ts'), 'utf8');

/** Keys declared in the typed contract. */
function declaredInternalKeys(): string[] {
  const start = typesSource.indexOf('export interface OrchestrationInternalMetadata {');
  expect(start).toBeGreaterThan(-1);
  const end = typesSource.indexOf('\n}', start);
  const block = typesSource.slice(start, end);
  const keys = [...block.matchAll(/(__\w+)\?:/g)].map((m) => m[1]);
  expect(keys.length).toBeGreaterThan(0);
  return [...new Set(keys)];
}

/** `__x` keys the engine actually uses as metadata keys (literals, property
 *  access, destructure aliases). `__finalize` (a local closure) never matches
 *  these shapes. */
function engineUsedKeys(): string[] {
  const used = new Set<string>();
  for (const rawLine of engineSource.split('\n')) {
    const line = rawLine.trim();
    // Comment lines mention `__finalize:` etc. in prose — only CODE counts.
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const m of line.matchAll(/metadata\??\.(__\w+)/g)) used.add(m[1]);
    for (const m of line.matchAll(/(__\w+)\??:/g)) used.add(m[1]);
  }
  return [...used];
}

describe('internal-metadata contract: __ keys are typed, stripped, and never client-visible', () => {
  const declared = declaredInternalKeys();

  it('1. CONTRACT — every __ key used by the engine is declared in OrchestrationInternalMetadata', () => {
    const undeclared = engineUsedKeys().filter((k) => !declared.includes(k));
    expect(undeclared).toEqual([]);
  });

  it('2. BOUNDARY — the public return strips every declared key into publicMetadata', () => {
    // Each declared key must appear as a strip alias `__x: _internal...` in the
    // boundary destructure, and the public spread must use publicMetadata.
    const missingFromStrip = declared.filter(
      (k) => !new RegExp(`${k}:\\s*_internal`).test(engineSource),
    );
    expect(missingFromStrip).toEqual([]);
    expect(engineSource).toContain('...publicMetadata,');
    // Regression pin: the public return must NOT spread raw result.metadata.
    // (Internal `result.metadata = { ...result.metadata, ... }` enrichments
    // are fine — they mutate the engine-internal object before the strip.)
    expect(engineSource).not.toMatch(/\.\.\.result\.metadata,\s*\n\s*triage: triageDecision/);
  });

  it('3. ENVELOPE — chat-request-processor never references internal keys nor spreads result.metadata', () => {
    for (const key of declared) {
      expect(processorSource.includes(key), `processor must not reference ${key}`).toBe(false);
    }
    expect(processorSource).not.toMatch(/\.\.\.\s*result\.metadata\b/);
  });
});
