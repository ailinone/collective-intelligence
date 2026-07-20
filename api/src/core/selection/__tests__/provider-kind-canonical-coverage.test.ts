// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider-kind canonical coverage — drift regression guard.
 *
 * ## Why this test exists
 *
 * `provider-kind.ts` classifies each provider as `native` | `hub` | `local`
 * | `unknown`, and that classification drives the selector's native-over-hub
 * routing bias. Historically the NATIVE_PROVIDERS and HUB_PROVIDERS sets
 * have drifted out of sync with the canonical catalog/switch registration:
 *
 *   - `featherless` vs canonical `featherless-ai`  (drift — fixed 2026-04-23)
 *   - `google-vertex` redundant with `vertex-ai`   (drift — fixed 2026-04-23)
 *   - `bedrock` vs canonical `aws-bedrock`         (drift — fixed earlier lot)
 *   - `fireworks` vs canonical `fireworks-ai`       (drift — fixed earlier lot)
 *   - `together` vs canonical `togetherai`          (drift — fixed earlier lot)
 *   - `aimlapi` vs canonical `aiml`                 (drift — fixed earlier lot)
 *   - `helicone` vs canonical `heliconeai`          (drift — fixed earlier lot)
 *
 * Each drift means the classifier returns `'unknown'` for a provider that
 * IS canonical (because the set member uses the alias spelling while the
 * caller passes the canonical id, or vice-versa). The bug is invisible at
 * compile time but silently degrades routing quality.
 *
 * ## The invariant
 *
 * Every id listed in NATIVE_PROVIDERS or HUB_PROVIDERS MUST be one of:
 *   (a) a canonical `providerId` in PROVIDER_CATALOG, OR
 *   (b) a canonical switch-case provider in `provider-registry.ts`, OR
 *   (c) a documented exception in DOCUMENTED_EXCEPTIONS below.
 *
 * If a new entry in either set fails all three, this test fails — telling
 * the author either to change the set entry to its canonical form or to
 * add a documented exception with a dated reason.
 *
 * ## What this test does NOT do
 *
 *   - It does NOT require every canonical provider to be classified. Some
 *     canonical providers are legitimately 'unknown' kind (e.g. catalog-only
 *     inventory rows like 'sap' that never run, or self-hosted endpoints
 *     that go through the 'local-' prefix path).
 *   - It does NOT pin the exact set sizes. The sets grow over time as new
 *     providers onboard; pinning would produce a noisy diff on every lot.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../../../providers/catalog/providers.catalog';
import { getProviderKindRegistry } from '../provider-kind';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REGISTRY_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'providers',
  'provider-registry.ts',
);

function extractSwitchCaseProviderIds(source: string): string[] {
  const regex = /^\s*case\s+'([a-z][a-z0-9-]*)'\s*:/gm;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * Documented drift exceptions — entries that are NOT canonical ids, but
 * are intentionally kept for a specific reason. Each entry MUST be accompanied
 * by a dated justification in a code comment nearby.
 *
 * Keep this list as small as possible. The preferred resolution for drift
 * is always to switch the set member to its canonical id, not to add
 * an exception here.
 */
const DOCUMENTED_EXCEPTIONS: ReadonlySet<string> = new Set([
  // Currently empty — all prior drift (google-vertex / featherless / bedrock /
  // fireworks / together / aimlapi / helicone / nvidia-hub) has been
  // resolved by switching to canonical ids. Any future addition here MUST
  // include a dated reason in provider-kind.ts and a grep-verifiable caller
  // that depends on the non-canonical spelling.
]);

describe('provider-kind canonical coverage', () => {
  const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
  const switchIds = new Set(extractSwitchCaseProviderIds(registrySource));
  const catalogIds = new Set(PROVIDER_CATALOG.map((e) => e.providerId));
  const canonicalIds = new Set<string>([...catalogIds, ...switchIds]);
  const registry = getProviderKindRegistry();

  it('every NATIVE_PROVIDERS entry is a canonical id or a documented exception', () => {
    const offenders: string[] = [];
    for (const id of registry.native) {
      if (!canonicalIds.has(id) && !DOCUMENTED_EXCEPTIONS.has(id)) {
        offenders.push(id);
      }
    }

    // If this fires: an entry in NATIVE_PROVIDERS is drift. Either:
    //   (a) rename the entry to its canonical providerId (preferred — grep
    //       the catalog for the display name to find the canonical id), or
    //   (b) add the drift entry to DOCUMENTED_EXCEPTIONS with a dated
    //       reason and a grep-verifiable caller that needs the non-
    //       canonical spelling.
    expect(offenders).toEqual([]);
  });

  it('every HUB_PROVIDERS entry is a canonical id or a documented exception', () => {
    const offenders: string[] = [];
    for (const id of registry.hub) {
      if (!canonicalIds.has(id) && !DOCUMENTED_EXCEPTIONS.has(id)) {
        offenders.push(id);
      }
    }

    // Same guidance as the NATIVE_PROVIDERS test above.
    expect(offenders).toEqual([]);
  });

  it('NATIVE_PROVIDERS and HUB_PROVIDERS are disjoint', () => {
    const nativeSet = new Set(registry.native);
    const overlap: string[] = [];
    for (const id of registry.hub) {
      if (nativeSet.has(id)) overlap.push(id);
    }

    // If this fires: a provider was classified BOTH native and hub. The
    // classifier checks NATIVE first, so hub membership is shadowed, but
    // the overlap is still a bug that should be resolved by moving the
    // entry to one set or the other.
    expect(overlap).toEqual([]);
  });

  it('DOCUMENTED_EXCEPTIONS are disjoint from canonical ids', () => {
    const leaked: string[] = [];
    for (const id of DOCUMENTED_EXCEPTIONS) {
      if (canonicalIds.has(id)) leaked.push(id);
    }

    // If this fires: an id was marked as a documented exception but it IS
    // canonical — so the exception is unnecessary. Remove it from
    // DOCUMENTED_EXCEPTIONS; the main invariant tests will accept it as
    // canonical.
    expect(leaked).toEqual([]);
  });
});
