// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phantom-capability regression guard for triage model selection.
 *
 * `TriageService#determineTriageCapabilities` builds the HARD-required
 * capability list for selecting the triage model itself. Since the selector
 * fails closed on an unsatisfiable hard capability requirement (2026-09-03,
 * `selector-hard-capability-failclosed.test.ts`), any capability listed here
 * that no real model can ever earn permanently empties the triage-model pool
 * for every request — exactly what happened with `analysis` (SOTA audit,
 * 2026-09-07): it was pushed unconditionally, yet no extraction pipeline —
 * provider-declared, modality, parameter, or name-regex — had ever assigned
 * it to a model.
 *
 * This test statically extracts every capability literal from that one
 * method (not the whole file, so unrelated capability references elsewhere
 * cannot mask a real gap) and asserts each one is REACHABLE by some real,
 * dynamic assignment path: either the structural-derivation rule set, or a
 * documented "directly assignable" capability (provider-declared / modality /
 * parameter / name-regex evidence already exists for it in production).
 *
 * A future PR that adds a new hard-required capability to
 * `determineTriageCapabilities` without also giving it a real derivation
 * path — a structural rule, or a documented assignment mechanism — fails
 * this test instead of silently shipping a second phantom-capability outage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isModelCapability } from '@/types';
import { structuralTargets } from '@/capability/assertions/structural-derivation';

const TRIAGE_SERVICE_PATH = join(__dirname, '..', 'triage-service.ts');
const source = readFileSync(TRIAGE_SERVICE_PATH, 'utf8');

/**
 * Extracts a method body by brace-matching from its DECLARATION onward.
 *
 * Matches on a method-declaration prefix (e.g. `private foo(`), not a bare
 * call-site substring — `src.indexOf('foo(')` would happily match `this.foo(`
 * at any earlier call site in the file and brace-match from whatever
 * unrelated block follows it, silently extracting the wrong body instead of
 * throwing.
 */
function extractMethodBody(src: string, methodName: string): string {
  const declPattern = new RegExp(`(?:private|public|protected)\\s+${methodName}\\s*\\(`);
  const declMatch = declPattern.exec(src);
  if (!declMatch) {
    throw new Error(`Declaration not found in triage-service.ts: ${methodName}`);
  }
  const sigIdx = declMatch.index;
  const openBrace = src.indexOf('{', src.indexOf(')', sigIdx));
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${methodName} body`);
}

/**
 * Capabilities with a real, already-verified assignment path that predates
 * this audit and doesn't run through structural derivation:
 *   - `chat`   — the universal provider-declared/name-regex baseline; every
 *                onboarded chat model carries it.
 *   - `function_calling` — deferred to the runtime probe (GAP-A13) rather
 *                than the catalog filter, and explicitly excluded from the
 *                selector's hard-capability fail-closed path for exactly
 *                that reason (see dynamic-model-selector.ts).
 *   - `reasoning` — directly assigned by model-capability-inference.ts via
 *                a name/description regex (`reasoning|thinking|o[1-9]`,
 *                line ~174) and a declared-parameter rule (`reasoning` /
 *                `include_reasoning` / `thinking`, line ~593) — the same
 *                evidence structural-derivation's own `analysis` rule cites
 *                as the reason `analysis` is safe to require once `reasoning`
 *                is present ("any model that later earns `reasoning` earns
 *                `analysis`"). Not a structural-derivation TARGET itself
 *                (structuralTargets() only lists capabilities a RULE
 *                produces, and reasoning is consumed as a rule
 *                precondition, never produced by one) — that's a property
 *                of how the ontology is wired, not evidence of a phantom.
 * Any OTHER capability referenced here must be derivable via
 * `structuralTargets()` (deriveStructuralSignals rules) — the same
 * contract the `analysis` fix relies on.
 */
const KNOWN_DIRECTLY_ASSIGNABLE = new Set(['chat', 'function_calling', 'reasoning']);

describe('determineTriageCapabilities — no phantom hard-required capability', () => {
  const body = extractMethodBody(source, 'determineTriageCapabilities');

  // Pull every single-quoted identifier out of the method body and keep only
  // the ones that are real ModelCapability slugs (filters out incidental
  // string literals, if any are ever added).
  const literals = Array.from(body.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
  const requiredCapabilities = Array.from(new Set(literals)).filter(isModelCapability);

  it('extracted at least the two capabilities the current implementation requires', () => {
    // Sanity check on the extractor itself — if this ever drops to zero, the
    // brace-matching or the regex broke, not the production code.
    expect(requiredCapabilities.length).toBeGreaterThanOrEqual(2);
    expect(requiredCapabilities).toContain('chat');
    expect(requiredCapabilities).toContain('analysis');
  });

  it.each(
    // Computed once, outside the callback, so a failing case names the
    // actual capability rather than a numeric index.
    (() => {
      const derivable = new Set(structuralTargets());
      return requiredCapabilities.map((cap) => [cap, derivable.has(cap as never)] as const);
    })()
  )('%s has a real assignment path (directly assignable or structurally derived)', (cap, isDerivable) => {
    const reachable = KNOWN_DIRECTLY_ASSIGNABLE.has(cap) || isDerivable;
    expect(
      reachable,
      `"${cap}" is hard-required by determineTriageCapabilities but has no real assignment ` +
        'path — add a structural-derivation rule (or a provider-declared/parameter/name-regex ' +
        'rule in model-capability-inference.ts) before requiring it, or it will permanently ' +
        'empty the triage-model pool (the exact "analysis" phantom-capability incident).'
    ).toBe(true);
  });
});
