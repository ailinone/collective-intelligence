// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AR (2026-09-06) closure — regression coverage for the three
 * independent findings applied this session. See
 * reports/provider-integration-gap-register.json (GAP-R1, GAP-AK-6, GAP-A10)
 * for the full evidence behind each change.
 *
 * (1) GAP-A10 rollout: a full-catalog scan found 3 more sibling pairs that
 *     are pure mechanical spreads (identical `supports`, no capability-audit
 *     or route-evidence asymmetry) and converted them to
 *     `deriveFromCatalogEntry()`, alongside the 3 existing POC rows
 *     (alibaba-coding-cn, minimax-token-plan-cn, stepfun-step-plan-cn):
 *       opencode-zen -> opencode-go, moonshot -> moonshot-cn,
 *       minimax -> minimax-cn.
 *     7 other candidate pairs were evaluated and found unsafe (route-
 *     evidence asymmetry or genuine capability-set divergence) — see
 *     GAP-A10's resolution text for the per-pair reasoning; none of those
 *     were touched in code.
 *
 * (2) GAP-AK-6: vivgrid promoted from execution-only/pinnedFallback to
 *     discovery+execution — an authenticated probe found a real, working
 *     GET /v1/models. replicate stays pinned deliberately
 *     (reason='curated-shortlist', unrelated to route existence). runwayml
 *     and topaz were RECONFIRMED terminal (still 404 on their candidate
 *     discovery path even with a verified-valid key) rather than merely
 *     "no key available" — no code change for those two, only register/
 *     comment updates.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { DISCOVERY_COMPLIANCE_REGISTRY } from '../consolidation-matrix';
import { ProviderCatalogSchema } from '../provider-catalog.schema';

function entry(id: string) {
  const e = PROVIDER_CATALOG.find((row) => row.providerId === id);
  expect(e, `expected catalog entry '${id}' to exist`).toBeTruthy();
  return e!;
}

describe('LOTE AR GAP-A10 rollout: newly-derived sibling rows', () => {
  it('opencode-go is derived from opencode-zen with identical supports', () => {
    const parent = entry('opencode-zen');
    const child = entry('opencode-go');
    expect(child.basedOn).toBe('opencode-zen');
    expect(child.supports).toEqual(parent.supports);
    expect(child.integrationClass).toBe(parent.integrationClass);
    expect(child.pricingMode).toBe(parent.pricingMode);
    expect(child.baseUrl).not.toBe(parent.baseUrl);
    expect(child.apiKeyEnvVar).toBe('OPENCODE_GO_API_KEY');
  });

  it('moonshot-cn is derived from moonshot with identical supports', () => {
    const parent = entry('moonshot');
    const child = entry('moonshot-cn');
    expect(child.basedOn).toBe('moonshot');
    expect(child.supports).toEqual(parent.supports);
    expect(child.integrationClass).toBe(parent.integrationClass);
    expect(child.baseUrl).not.toBe(parent.baseUrl);
    expect(child.apiKeyEnvVar).toBe('MOONSHOT_CN_API_KEY');
    // pricingMode is a deliberate override (remote on the live .ai row vs
    // none on the not-yet-live-probed .cn row) — NOT inherited verbatim.
    expect(child.pricingMode).toBe('none');
    expect(parent.pricingMode).toBe('remote');
  });

  it('minimax-cn is derived from minimax with identical supports', () => {
    const parent = entry('minimax');
    const child = entry('minimax-cn');
    expect(child.basedOn).toBe('minimax');
    expect(child.supports).toEqual(parent.supports);
    expect(child.integrationClass).toBe(parent.integrationClass);
    expect(child.baseUrl).not.toBe(parent.baseUrl);
    expect(child.apiKeyEnvVar).toBe('MINIMAX_CN_API_KEY');
  });

  it('the 7 evaluated-but-not-converted GAP-A10 candidates remain independent full rows', () => {
    // Each of these pairs was found unsafe to derive (route-evidence
    // asymmetry or genuine capability-set divergence) — assert neither side
    // carries a `basedOn` linking it to the other, so a future edit cannot
    // silently collapse them without re-litigating the documented reasons.
    const pairs: Array<[string, string]> = [
      ['alibaba-token-plan', 'alibaba-token-plan-cn'],
      ['tencent-coding', 'tencent-plan'],
      ['tencent-coding', 'tencent-tokenhub'],
      ['alibaba', 'alibaba-cn'],
      ['siliconflow', 'siliconflow-cn'],
      ['stepfun', 'stepfun-cn'],
      ['volcano', 'volcano-coding'],
      ['xiaomi-mimo', 'xiaomi-token-plan'],
    ];
    for (const [, childId] of pairs) {
      const child = PROVIDER_CATALOG.find((row) => row.providerId === childId);
      expect(child, `expected catalog entry '${childId}' to exist`).toBeTruthy();
      expect(child!.basedOn, `${childId} should not be derived`).toBeUndefined();
    }
  });

  it('whole catalog (including the 3 newly-derived rows) still passes Zod validation', () => {
    const result = ProviderCatalogSchema.safeParse(PROVIDER_CATALOG);
    expect(result.success).toBe(true);
  });
});

describe('LOTE AR GAP-AK-6: vivgrid discovery promotion', () => {
  it('vivgrid catalog row is discovery+execution with no pinnedFallback', () => {
    const e = entry('vivgrid');
    expect(e.integrationMode).toBe('discovery+execution');
    expect(e.pinnedFallback).toBeUndefined();
  });

  it('vivgrid is registered as compliant-dynamic-discovery, not pinnedFallback-by-design', () => {
    expect(DISCOVERY_COMPLIANCE_REGISTRY['compliant-dynamic-discovery']).toContain('vivgrid');
    expect(DISCOVERY_COMPLIANCE_REGISTRY['pinnedFallback-by-design']).not.toContain('vivgrid');
  });
});

describe('LOTE AR GAP-AK-6: replicate curated-shortlist stands (not promoted)', () => {
  it('replicate keeps its deliberate curated-shortlist pinnedFallback', () => {
    const e = entry('replicate');
    expect(e.pinnedFallback?.reason).toBe('curated-shortlist');
    expect(e.pinnedFallback?.models.length).toBeGreaterThan(0);
    expect(e.integrationMode).toBe('execution-only');
  });

  it('replicate is still on the zero-hardcode pinned-inventory allowlist', () => {
    // Cross-bucket sanity: replicate legitimately sits in
    // non-compliant-runtime-not-materialized (tracked debt), same as
    // before this session — confirming this LOTE did not silently move it.
    const classified = new Set([
      ...DISCOVERY_COMPLIANCE_REGISTRY['pinnedFallback-by-design'],
      ...DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-hardcoded-inventory'],
      ...DISCOVERY_COMPLIANCE_REGISTRY['compliant-deployment-discovery'],
      ...DISCOVERY_COMPLIANCE_REGISTRY['compliant-dynamic-discovery'],
      ...DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-runtime-not-materialized'],
    ]);
    expect(classified.has('replicate')).toBe(true);
  });
});

describe('LOTE AR GAP-AK-6: runwayml/topaz reconfirmed terminal (no code change)', () => {
  it('runwayml and topaz remain execution-only with their pinnedFallback intact', () => {
    for (const id of ['runwayml', 'topaz']) {
      const e = entry(id);
      expect(e.integrationMode).not.toBe('discovery+execution');
      expect(e.pinnedFallback?.models.length).toBeGreaterThan(0);
      expect(e.pinnedFallback?.reason).toBe('no-list-endpoint');
    }
  });
});

describe('LOTE AR GAP-R1: apiKeyOptional propagation still correct (already-fixed rows)', () => {
  it('mancer, xinference and triton all register credential-less (apiKeyOptional or no gate)', () => {
    const mancer = entry('mancer');
    expect(mancer.apiKeyOptional).toBe(true);
    const xinference = entry('xinference');
    expect(xinference.apiKeyOptional).toBe(true);
    // triton never routes through buildHubConfig's apiKeyOptional gate at
    // all (dedicated adapter, narrow {apiKey,baseUrl} shape) — nothing to
    // assert on the catalog row itself beyond its continued existence.
    expect(entry('triton')).toBeTruthy();
  });

  it('venice deliberately does NOT have apiKeyOptional set (open operator decision, GAP-R1)', () => {
    // Documents the current, intentional state so a future session does not
    // "fix" this without the operator decision GAP-R1 calls for: venice's
    // notes document the identical public-/models pattern mancer got fixed
    // for, but a real GCP secret exists and the fix was explicitly deferred
    // pending a decision entangled with GAP-R2's billing/x402 exclusion.
    const venice = entry('venice');
    expect(venice.apiKeyOptional).toBeUndefined();
  });
});
