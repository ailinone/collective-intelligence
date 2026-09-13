// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AL (2026-09-05) — GAP-AK-6 closure: qianfan promoted from
 * `execution-only` (fabricated 3-model pinnedFallback) to
 * `discovery+execution` after official Baidu docs confirmed GET
 * /v2/models returns a shape extractRawModels/convertRawModel already
 * handle. Locks in the reclassification so a future edit can't silently
 * reintroduce a hardcoded inventory for this row (zero-hardcode policy).
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { DISCOVERY_COMPLIANCE_REGISTRY } from '../consolidation-matrix';

describe('LOTE AL GAP-AK-6 closure: qianfan discovery promotion', () => {
  it('qianfan catalog row is discovery+execution with no pinnedFallback', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'qianfan');
    expect(entry).toBeTruthy();
    expect(entry!.integrationMode).toBe('discovery+execution');
    expect(entry!.pinnedFallback).toBeUndefined();
  });

  it('qianfan moved out of discovery-compliance non-compliant-runtime-not-materialized', () => {
    expect(DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-runtime-not-materialized']).not.toContain(
      'qianfan'
    );
  });

  it('qianfan is now registered as compliant-dynamic-discovery', () => {
    expect(DISCOVERY_COMPLIANCE_REGISTRY['compliant-dynamic-discovery']).toContain('qianfan');
  });

  it('recraft was NOT blindly promoted alongside qianfan (kept pinnedFallback)', () => {
    // recraft has no documented /models at all — not a parser gap like
    // qianfan's, so it was not flipped.
    const recraft = PROVIDER_CATALOG.find((e) => e.providerId === 'recraft');
    expect(recraft?.pinnedFallback?.models.length).toBeGreaterThan(0);
    expect(recraft?.integrationMode).not.toBe('discovery+execution');
  });

  // relace surfaced a real, distinct blocker during this same shape-check
  // pass: a host mismatch between the documented /models (models.relace.ai)
  // and this row's then-baseUrl (instantapply.endpoint.relace.run) — not a
  // parser gap like qianfan's, so it was NOT flipped here. That mismatch was
  // resolved 2026-09-09 (LOTE AT, GAP-AK-6 closure) — see
  // `lote-at-relace-discovery-closure.test.ts` for the follow-up promotion,
  // which supersedes the `relace` half of this file's original assertion.
});
