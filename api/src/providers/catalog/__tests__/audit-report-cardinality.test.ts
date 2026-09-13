// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Audit-report cardinality guard (LOTE AK, 2026-09-04).
 *
 * THE DRIFT THIS EXISTS TO STOP
 * ─────────────────────────────
 * `reports/provider-integration-audit.json` carried a hand-maintained
 * `summary` block that had silently diverged from the very `rows[]` it
 * claimed to summarise, and from the catalog it claimed to describe:
 *
 *   - `rosterRowsTotal: 195` while `rows[]` held 212
 *   - `notProgrammaticallyIntegrable: 12` while the rows held 7
 *   - `productionCertifiedPerRepoEvidence: 41` while the rows held 31
 *   - a "cardinality note" asserting a partition whose parts summed to 217
 *     against a stated universe of 195
 *
 * A report that disagrees with its own data is worse than no report: it gets
 * quoted. The fix is not another manual correction — it is making the
 * catalog-derived numbers CHECKED, so the next lot cannot restate them from
 * memory. Anyone changing the catalog must update the report in the same
 * commit, exactly like the CSV runtime matrix already works.
 *
 * The universes are asserted INDEPENDENTLY and are never summed. That is the
 * whole point: they count different kinds of thing (roster entries vs catalog
 * rows vs alias strings), and adding any two produces a number that
 * corresponds to nothing real.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { isOpenAICompatibleEntry } from '../provider-catalog.types';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname_, '..', '..', '..', '..', '..');
const AUDIT_PATH = join(REPO_ROOT, 'reports', 'provider-integration-audit.json');

interface UniverseEntry {
  value: number;
  counts: string;
  derivedFrom: string;
  note?: string;
}
interface AuditReport {
  rows: Array<{ finalStatus: string; variantType?: string }>;
  summary: {
    universes: Record<string, UniverseEntry>;
    rosterStatusPartition: Record<string, number | string>;
    rosterShapePartition: Record<string, number | string>;
    inventoryHealth: Record<string, number | boolean | string>;
  };
}

const audit = JSON.parse(readFileSync(AUDIT_PATH, 'utf8')) as AuditReport;
const u = audit.summary.universes;

describe('audit report — catalog-derived universes match the catalog', () => {
  it('canonicalProviderCount equals the number of distinct catalog providerIds', () => {
    const ids = new Set(PROVIDER_CATALOG.map((e) => e.providerId));
    // Distinctness is part of the claim: a duplicated row (the `meta`/`llama`
    // case this lot removed) would otherwise inflate the count invisibly.
    expect(ids.size).toBe(PROVIDER_CATALOG.length);
    expect(u.canonicalProviderCount.value).toBe(ids.size);
  });

  it('aliasCount equals the total alias strings declared across rows', () => {
    const aliases = PROVIDER_CATALOG.reduce((n, e) => n + (e.aliases?.length ?? 0), 0);
    expect(u.aliasCount.value).toBe(aliases);
  });

  it('dynamicDiscoveryProviderCount equals the rows that actually discover', () => {
    const dyn = PROVIDER_CATALOG.filter(
      (e) => e.integrationMode === 'discovery+execution' || e.integrationMode === 'discovery-only'
    ).length;
    expect(u.dynamicDiscoveryProviderCount.value).toBe(dyn);
  });

  it('runtimeProviderInstanceCount equals the rows the loader will attempt to register', () => {
    // Mirrors catalog-loader's pre-flight filters. Kept as a computation
    // rather than a literal so a new denyByDefault or catalog-only row moves
    // the expectation automatically and forces the report to follow.
    const registrable = PROVIDER_CATALOG.filter(
      (e) =>
        e.enabledByDefault &&
        !e.denyByDefault &&
        e.integrationMode !== 'catalog-only' &&
        (isOpenAICompatibleEntry(e) || Boolean(e.adapterClass))
    ).length;
    expect(u.runtimeProviderInstanceCount.value).toBe(registrable);
  });

  it('every universe declares what it counts and where it comes from', () => {
    // An unlabelled number is exactly how the old summary became ambiguous:
    // nobody could tell which universe `rosterRowsTotal` belonged to.
    for (const [name, entry] of Object.entries(u)) {
      expect(entry.counts, `${name}.counts`).toBeTruthy();
      expect(entry.derivedFrom, `${name}.derivedFrom`).toBeTruthy();
      expect(typeof entry.value, `${name}.value`).toBe('number');
    }
    // The six the mission requires be kept separate.
    expect(Object.keys(u).sort()).toEqual(
      [
        'aliasCount',
        'canonicalProviderCount',
        'deploymentProfileCount',
        'dynamicDiscoveryProviderCount',
        'requestedRosterEntries',
        'runtimeProviderInstanceCount',
      ].sort()
    );
  });
});

describe('audit report — inventory-health claims match the catalog', () => {
  it('pinnedFallbackRows matches the rows that actually carry a pinned list', () => {
    const pinned = PROVIDER_CATALOG.filter(
      (e) => e.pinnedFallback && e.pinnedFallback.models.length > 0
    ).length;
    expect(audit.summary.inventoryHealth.pinnedFallbackRows).toBe(pinned);
  });

  it('discoveryStatusUnavailableUpstreamRows matches the declared zero-inventory rows', () => {
    const zero = PROVIDER_CATALOG.filter(
      (e) => e.discoveryStatus === 'unavailable-upstream'
    ).length;
    expect(audit.summary.inventoryHealth.discoveryStatusUnavailableUpstreamRows).toBe(zero);
  });

  it('reports zero staticModels rows, and the catalog has zero', () => {
    const legacy = PROVIDER_CATALOG.filter((e) => (e.staticModels?.length ?? 0) > 0).length;
    expect(legacy).toBe(0);
    expect(audit.summary.inventoryHealth.staticModelsRows).toBe(0);
  });

  it('csvRowsInRuntimeMatrix matches both the CSV and the catalog', () => {
    const csv = readFileSync(join(REPO_ROOT, 'api', 'docs', 'provider-runtime-matrix.csv'), 'utf8')
      .trim()
      .split('\n');
    const dataRows = csv.length - 1;
    expect(audit.summary.inventoryHealth.csvRowsInRuntimeMatrix).toBe(dataRows);
    expect(dataRows).toBe(PROVIDER_CATALOG.length);
  });
});

describe('audit report — the roster partitions are recomputed, not restated', () => {
  it('rosterStatusPartition matches a fresh count over rows[] and sums to the roster universe', () => {
    const fresh: Record<string, number> = {};
    for (const r of audit.rows) fresh[r.finalStatus] = (fresh[r.finalStatus] ?? 0) + 1;

    for (const [status, count] of Object.entries(fresh)) {
      expect(audit.summary.rosterStatusPartition[status], `status ${status}`).toBe(count);
    }
    expect(audit.summary.rosterStatusPartition._total).toBe(audit.rows.length);
    expect(u.requestedRosterEntries.value).toBe(audit.rows.length);
  });

  it('rosterShapePartition is a SECOND partition of the same universe, not an addition to it', () => {
    const shape = audit.summary.rosterShapePartition;
    const sum =
      Number(shape.plainProviderEntries) +
      Number(shape.profileEntries) +
      Number(shape.aliasEntries);
    expect(sum).toBe(audit.rows.length);
    expect(shape._total).toBe(audit.rows.length);
  });

  it('does not mix universes: the roster total is not the catalog total', () => {
    // The concrete confusion being guarded. These two numbers describe
    // different things and coincidentally-equal values would hide a bug, so
    // the report must keep them in separate fields regardless of value.
    expect(u.requestedRosterEntries.derivedFrom).not.toBe(
      u.canonicalProviderCount.derivedFrom
    );
  });
});
