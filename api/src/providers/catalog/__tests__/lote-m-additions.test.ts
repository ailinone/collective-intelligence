// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE M regression guard — 2026-04-23 complement-lot additions.
 *
 * ## Why this test exists
 *
 * The 2026-04-23 "LOTE COMPLEMENTAR" directive added 13 new canonical
 * catalog rows (12 net-new + 1 promotion) and declared 3 more providers
 * NOT_ELIGIBLE. Each row and each decision encodes specific invariants
 * that must survive future refactors:
 *
 *   - canonical providerId  (e.g. 'qianfan' NOT 'baidu', 'gmi' NOT 'gmicloud',
 *                            'phala' NOT 'redpill')
 *   - deny-by-default for uncensored providers (mancer, venice)
 *   - catalog-only integrationMode for first-party natives without wired
 *     adapters (inflection, relace)
 *   - secret mapping in load-secrets-into-env.ts (so the credential
 *     propagates to process.env once provisioned)
 *   - env-var → providerId mapping in ENV_VAR_TO_PROVIDER
 *   - NON_CANONICAL_HISTORICAL_CLAIMS for each NOT_ELIGIBLE provider
 *
 * If any of these invariants silently regresses — e.g. someone promotes
 * venice's denyByDefault to false, or renames qianfan back to baidu — the
 * matrix's promise of "correct by construction" becomes a lie. This file
 * catches those regressions at CI time.
 *
 * ## What this test does NOT do
 *
 *   - No HTTP probes. All 13 providers are secret-absent (12) or
 *     auth-incomplete (1) at lot closure. Live-validation is impossible
 *     without operator-provisioned credentials.
 *   - No Zod shape validation. `provider-catalog.schema.test.ts` already
 *     owns that.
 *   - No matrix-bucket assertion. `consolidation-matrix.test.ts` already
 *     owns the "every canonical provider is in one bucket" invariant.
 *     This file cross-cuts: it pins the *lot-specific* invariants that
 *     distinguish LOTE M additions from the rest of the catalog.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import {
  CONSOLIDATION_MATRIX,
  CREDENTIALS_MISSING_SUBCLASS,
  NON_CANONICAL_HISTORICAL_CLAIMS,
} from '../consolidation-matrix';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOAD_SECRETS_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'config',
  'load-secrets-into-env.ts',
);

/**
 * The 13 catalog rows landed in LOTE M 2026-04-23. This list is the
 * source-of-truth for all "new in this lot" assertions below.
 */
const LOTE_M_IDS = [
  'arcee',
  'atlascloud',
  'avian',
  'qianfan',
  'gmi',
  'infermatic',
  'inflection',
  'mancer',
  'phala',
  'relace',
  'siliconflow',
  'stepfun',
  'venice',
] as const;

/**
 * Providers classified NOT_ELIGIBLE this lot. Must appear in
 * NON_CANONICAL_HISTORICAL_CLAIMS with a 2026-04-23 supersession date
 * and an explanatory reason, and must NOT appear in the catalog.
 */
const LOTE_M_NOT_ELIGIBLE = ['liquid', 'modelrun', 'ncompass'] as const;

/**
 * Sublote promotion lists (module scope so every describe block can
 * reference them). Each list documents explicit D1 2026-04-24 bucket/
 * sub-class moves; adding or removing an id from these lists requires
 * corresponding evidence in NON_CANONICAL_HISTORICAL_CLAIMS.
 */
const LOTE_M_PROMOTED_TO_LIVE_D1 = ['infermatic'] as const;
const LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1 = ['arcee'] as const;
const LOTE_M_MOVED_TO_AUTH_INCOMPLETE_D1 = ['siliconflow', 'stepfun'] as const;

function findEntry(providerId: string) {
  return PROVIDER_CATALOG.find((e) => e.providerId === providerId);
}

// ──────────────────────────────────────────────────────────────────────────
// (A) Inventory: all 13 LOTE M ids exist as catalog rows
// ──────────────────────────────────────────────────────────────────────────

describe('LOTE M inventory — all 13 additions exist as catalog rows', () => {
  for (const id of LOTE_M_IDS) {
    it(`catalog row '${id}' exists`, () => {
      const entry = findEntry(id);
      // If this fires: someone removed the row. LOTE M closure mandates
      // all 13 rows live as canonical. To reverse, delete the row AND
      // the matrix bucket entry AND the secret mapping AND this test
      // entry — in a single coordinated revert.
      expect(entry).toBeTruthy();
    });
  }

  /**
   * IDs promoted out of credentials-missing via public /models probes.
   * Sublote A (2026-04-23) promoted venice; Sublote B (2026-04-23)
   * promoted atlascloud, avian, mancer, phala. Each move is evidenced
   * by an HTTP 200 response on the canonical /models surface without
   * a valid credential, documented in `consolidation-matrix.ts`
   * (partial bucket comment + NON_CANONICAL_HISTORICAL_CLAIMS).
   *
   * Adding an id here requires: (a) a real HTTP probe against the
   * canonical baseUrl returned 200 on /models without auth, and
   * (b) a corresponding historical-claims entry recording the probe.
   */
  const LOTE_M_PROMOTED_TO_PARTIAL = [
    'venice',
    'atlascloud',
    'avian',
    'mancer',
    'phala',
  ] as const;

  // D1 promotion lists are declared at module scope (above) so all
  // describe blocks can reference them. Semantics:
  //   LOTE_M_PROMOTED_TO_LIVE_D1       — /chat/200 with provisioned key
  //   LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1 — 402 auth-accepted
  //   LOTE_M_MOVED_TO_AUTH_INCOMPLETE_D1 — key provisioned, upstream-
  //                                        rejected (stays credentials-
  //                                        missing, sub-class changes)

  it('every LOTE M id is in credentials-missing OR partial OR live OR upstream-suspended (post Sublote A/B/D1)', () => {
    // Sublotes A/B promoted 5 LOTE M ids from credentials-missing →
    // partial (via public /models probe evidence). Sublote D1 promoted
    // 1 LOTE M id (infermatic) → live-validation (real /chat/200) and
    // 1 LOTE M id (arcee) → upstream-suspended (auth-accepted-402). All
    // OTHER LOTE M ids remain in credentials-missing. If this test
    // fires, either (a) a row was added without a matrix entry
    // (violates I1), or (b) a LOTE M id was moved to a new bucket
    // WITHOUT being added to one of the explicit promotion lists —
    // which is the whole point of keeping the explicit lists: each
    // bucket move must be a deliberate operator decision with probe
    // evidence, not silent drift.
    const credMissing = new Set(CONSOLIDATION_MATRIX['credentials-missing']);
    const partial = new Set(CONSOLIDATION_MATRIX['partial']);
    const live = new Set(CONSOLIDATION_MATRIX['live-validation']);
    const upstreamSuspended = new Set(CONSOLIDATION_MATRIX['upstream-suspended']);
    const partialSet = new Set<string>(LOTE_M_PROMOTED_TO_PARTIAL);
    const liveSet = new Set<string>(LOTE_M_PROMOTED_TO_LIVE_D1);
    const upstreamSet = new Set<string>(LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1);
    const misplaced: string[] = [];
    for (const id of LOTE_M_IDS) {
      const okInCreds = credMissing.has(id);
      const okInPartial = partialSet.has(id) && partial.has(id);
      const okInLive = liveSet.has(id) && live.has(id);
      const okInUpstream = upstreamSet.has(id) && upstreamSuspended.has(id);
      if (!okInCreds && !okInPartial && !okInLive && !okInUpstream) misplaced.push(id);
    }
    expect(misplaced).toEqual([]);
  });

  it('all `LOTE_M_PROMOTED_TO_PARTIAL` ids live in the `partial` bucket', () => {
    // Locks the promotion: every provider on the explicit partial-
    // promotion list must ACTUALLY be in the partial bucket and NOT
    // in credentials-missing. Fires if a maintainer adds an id here
    // without moving it, or removes it from the partial bucket
    // without removing it here.
    for (const id of LOTE_M_PROMOTED_TO_PARTIAL) {
      expect(CONSOLIDATION_MATRIX['partial']).toContain(id);
      expect(CONSOLIDATION_MATRIX['credentials-missing']).not.toContain(id);
    }
  });

  it('all `LOTE_M_PROMOTED_TO_LIVE_D1` ids live in the `live-validation` bucket', () => {
    // Sublote D1 promotion lock: infermatic (LiteLLM Virtual Key sk-
    // prefix confirmed, Qwen-Qwen3-30B-A3B chat 200 476B).
    for (const id of LOTE_M_PROMOTED_TO_LIVE_D1) {
      expect(CONSOLIDATION_MATRIX['live-validation']).toContain(id);
      expect(CONSOLIDATION_MATRIX['credentials-missing']).not.toContain(id);
    }
  });

  it('all `LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1` ids live in the `upstream-suspended` bucket', () => {
    // Sublote D1 promotion lock: arcee (trinity-mini chat 402 with
    // {"detail":"Insufficient credits. Required: 0.000037, Available: 0.000000"}).
    for (const id of LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1) {
      expect(CONSOLIDATION_MATRIX['upstream-suspended']).toContain(id);
      expect(CONSOLIDATION_MATRIX['credentials-missing']).not.toContain(id);
    }
  });

  it('qianfan is sub-classified as auth-incomplete (not secret-absent)', () => {
    // The v1 baidu-{key,secret,base-url} GCP secrets exist (placeholder
    // values), and a separate v2 QIANFAN_API_KEY must be provisioned.
    // Neither is trivially "secret-absent" — the correct sub-class is
    // auth-incomplete (matching aws-sagemaker's semantic).
    expect(CREDENTIALS_MISSING_SUBCLASS['auth-incomplete']).toContain('qianfan');
    expect(CREDENTIALS_MISSING_SUBCLASS['secret-absent']).not.toContain('qianfan');
  });

  it('D1 auth-incomplete promotions (siliconflow, stepfun) are sub-classified correctly', () => {
    // Sublote D1 (2026-04-24) moved siliconflow and stepfun from
    // secret-absent → auth-incomplete. Both had secrets provisioned
    // by the operator but the upstream rejected the specific key
    // (bare-JSON "Api key is invalid" / OAI-shape "Incorrect API key
    // provided"). They remain in credentials-missing; only the
    // sub-class changed.
    for (const id of LOTE_M_MOVED_TO_AUTH_INCOMPLETE_D1) {
      expect(CONSOLIDATION_MATRIX['credentials-missing']).toContain(id);
      expect(CREDENTIALS_MISSING_SUBCLASS['auth-incomplete']).toContain(id);
      expect(CREDENTIALS_MISSING_SUBCLASS['secret-absent']).not.toContain(id);
    }
  });

  it('remaining LOTE M ids (not qianfan, not promoted) are sub-classified as secret-absent', () => {
    // After Sublote A (venice → partial), Sublote B (atlascloud, avian,
    // mancer, phala → partial), Sublote D1 (infermatic → live, arcee →
    // upstream-suspended, siliconflow/stepfun → auth-incomplete
    // sub-class), the LOTE M ids still in credentials-missing that
    // should also be in secret-absent are: gmi, inflection, relace.
    // qianfan and siliconflow/stepfun are auth-incomplete.
    // If this test fires, either a LOTE M id was wrongly kept in
    // secret-absent after being promoted/moved, or it was removed from
    // secret-absent without being promoted/moved.
    const secretAbsent = new Set(CREDENTIALS_MISSING_SUBCLASS['secret-absent']);
    const partialSet = new Set<string>(LOTE_M_PROMOTED_TO_PARTIAL);
    const liveSet = new Set<string>(LOTE_M_PROMOTED_TO_LIVE_D1);
    const upstreamSet = new Set<string>(LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1);
    const authIncompleteSet = new Set<string>(LOTE_M_MOVED_TO_AUTH_INCOMPLETE_D1);
    const misclassified: string[] = [];
    for (const id of LOTE_M_IDS) {
      if (id === 'qianfan') continue;
      if (partialSet.has(id)) continue;
      if (liveSet.has(id)) continue;
      if (upstreamSet.has(id)) continue;
      if (authIncompleteSet.has(id)) continue;
      if (!secretAbsent.has(id)) misclassified.push(id);
    }
    expect(misclassified).toEqual([]);
  });

  it('partial/live/upstream-promoted LOTE M ids are NOT in any CREDENTIALS_MISSING_SUBCLASS list', () => {
    // Invariant: once a provider LEAVES credentials-missing, it must
    // also leave every sub-class. Sublote A (venice) + Sublote B
    // (atlascloud, avian, mancer, phala) + Sublote D1 (infermatic,
    // arcee) moves enforced here. Note: D1's siliconflow/stepfun
    // STAYED in credentials-missing — only their sub-class changed
    // — so they are NOT in this list.
    const allLeft = [
      ...LOTE_M_PROMOTED_TO_PARTIAL,
      ...LOTE_M_PROMOTED_TO_LIVE_D1,
      ...LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1,
    ];
    for (const id of allLeft) {
      for (const subclass of Object.keys(CREDENTIALS_MISSING_SUBCLASS)) {
        expect(CREDENTIALS_MISSING_SUBCLASS[subclass]).not.toContain(id);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (B) Provider-specific invariants
// ──────────────────────────────────────────────────────────────────────────

describe('LOTE M provider-specific invariants', () => {
  it('qianfan canonical providerId with alias chain [baidu, ernie, baidu-qianfan]', () => {
    const entry = findEntry('qianfan');
    expect(entry).toBeTruthy();
    // If this fires: the canonicalization decision (Opção A from the
    // 2026-04-23 operator response: "providerId `qianfan`, aliases
    // [baidu, ernie, baidu-qianfan]") was silently reverted. The
    // alternative Opção B/C would have used 'baidu' or 'baidu-qianfan'
    // as providerId, which creates a naming mismatch between our
    // canonical id and the upstream platform name (baidubce.com).
    const aliases = new Set(entry!.aliases ?? []);
    expect(aliases.has('baidu')).toBe(true);
    expect(aliases.has('ernie')).toBe(true);
    expect(aliases.has('baidu-qianfan')).toBe(true);
  });

  it('qianfan uses v2 OAI-compat base URL (qianfan.baidubce.com/v2)', () => {
    const entry = findEntry('qianfan');
    // The v1 OAuth endpoint (aip.baidubce.com/rpc/2.0/...) would require
    // a dedicated native adapter not present in-repo. v2 is the OAI-compat
    // surface the catalog row targets.
    expect(entry!.baseUrl).toBe('https://qianfan.baidubce.com/v2');
  });

  it('qianfan declares apiKeyEnvVarOverrideReason (non-canonical env var name)', () => {
    const entry = findEntry('qianfan');
    // QIANFAN_API_KEY is canonical for the v2 bce-v3 bearer format; the
    // legacy ERNIE_API_KEY / ERNIE_SECRET_KEY remain wired for the v1
    // OAuth flow. Zod requires the override reason when the env var
    // name diverges from <PROVIDER_ID_UPPER>_API_KEY — but QIANFAN_API_KEY
    // DOES match that pattern. The reason is present to document the
    // v1/v2 coexistence rather than to bypass the Zod rule. Test still
    // asserts it is non-empty because the test-writer explicitly wanted
    // that documentation to live here.
    expect(entry!.apiKeyEnvVarOverrideReason).toBeTruthy();
    expect(entry!.apiKeyEnvVarOverrideReason).toMatch(/v1|v2|ERNIE/i);
  });

  it('gmi canonical providerId with alias chain includes gmicloud', () => {
    const entry = findEntry('gmi');
    expect(entry).toBeTruthy();
    const aliases = new Set(entry!.aliases ?? []);
    // Canonical id is `gmi` (short, matches our env-var convention
    // GMI_API_KEY); upstream brand is GMICloud. The alias chain is
    // what lets incoming gmicloud/gmi-cloud/gmi-serving requests
    // resolve to the canonical row.
    expect(aliases.has('gmicloud')).toBe(true);
  });

  it('phala canonical providerId with alias [redpill]', () => {
    const entry = findEntry('phala');
    expect(entry).toBeTruthy();
    // RedPill (api.redpill.ai) is the runtime face of Phala Network.
    // We canonicalize to the platform name `phala` but accept `redpill`
    // as an alias for incoming requests that match upstream branding.
    const aliases = new Set(entry!.aliases ?? []);
    expect(aliases.has('redpill')).toBe(true);
  });

  it('phala declares apiKeyEnvVarOverrideReason (brand-vs-platform name)', () => {
    const entry = findEntry('phala');
    // PHALA_API_KEY passes the Zod rule (matches PROVIDER_ID_UPPER_API_KEY),
    // but documenting why we chose the platform name over the upstream
    // brand name REDPILL is essential for audit trails.
    expect(entry!.apiKeyEnvVarOverrideReason).toBeTruthy();
    expect(entry!.apiKeyEnvVarOverrideReason).toMatch(/redpill/i);
  });

  it('mancer is tagged contentPolicyClass=uncensored (admitted, never censored)', () => {
    const entry = findEntry('mancer');
    // 2026-04-28 Phase 4b: per the universal "habilitado e nunca censurado"
    // policy, uncensored providers are now FULL participants in routing.
    // The `denyByDefault` gate (which used to force opt-in) was removed and
    // replaced with the informational `contentPolicyClass: 'uncensored'`
    // tag. Downstream surfaces may still filter by this tag — but the
    // catalog layer no longer blocks registration.
    //
    // If this fires: someone removed the uncensored tag. Mancer's marketing
    // page still states "No filters, No guidelines, No constraints" — the
    // tag is the audit trail proving we KNEW about the policy when we
    // admitted the provider.
    expect(entry!.contentPolicyClass).toBe('uncensored');
    expect(entry!.denyByDefault).toBeUndefined();
    expect(entry!.enabledByDefault).toBe(true);
  });

  it('venice is tagged contentPolicyClass=uncensored (admitted, never censored)', () => {
    const entry = findEntry('venice');
    // Venice AI ships "Venice Uncensored 1.2" as a default-exposed model.
    // Same Phase-4b treatment as Mancer: tag with contentPolicyClass,
    // remove denyByDefault, keep enabledByDefault=true.
    expect(entry!.contentPolicyClass).toBe('uncensored');
    expect(entry!.denyByDefault).toBeUndefined();
    expect(entry!.enabledByDefault).toBe(true);
  });

  it('inflection is oai-compat-pure execution-only (OpenAI-compatible API, 2026-06-15)', () => {
    const entry = findEntry('inflection');
    // 2026-06-15: Inflection shipped a standard OpenAI-compatible API at
    // https://api.inflection.ai/v1 (chat/completions + embeddings, Bearer) — no
    // custom adapter needed. Promoted catalog-only → execution-only with the
    // documented pinnedFallback SKUs (no /v1/models listing endpoint).
    expect(entry!.integrationMode).toBe('execution-only');
    expect(entry!.integrationClass).toBe('oai-compat-pure');
  });

  it('relace has integrationMode=catalog-only (specialty code-edit)', () => {
    const entry = findEntry('relace');
    // Relace's /v1/code/apply merge endpoint is proprietary and not
    // a standard chat surface. Like Morph (the precedent case), Relace
    // needs a dedicated adapter with custom surfaces (codeApply,
    // codeRerank) that don't exist yet.
    expect(entry!.integrationMode).toBe('catalog-only');
    expect(entry!.integrationClass).toBe('first-party-native');
  });

  it('all LOTE M rows ship with enabledByDefault=true (universal "habilitado" policy)', () => {
    // 2026-04-28 policy shift: every catalog row is enabled by default.
    // Censorship/uncensored classification is now governed by
    // `contentPolicyClass`, not by `enabledByDefault: false` — see Phase 4b
    // of the SOTA closure (provider-fetcher-decisions.md).
    //
    // The original LOTE M policy was "operator opt-in" (defaults to false).
    // The current policy is "habilitado e nunca censurado": every provider
    // is admitted to the routing surface; uncensored providers are tagged
    // explicitly via `contentPolicyClass: 'uncensored'`. This test still
    // catches the inverse regression (someone flipping a LOTE M row back
    // to false), just under the new policy direction.
    const violators: string[] = [];
    for (const id of LOTE_M_IDS) {
      const entry = findEntry(id);
      if (entry?.enabledByDefault !== true) violators.push(id);
    }
    expect(violators).toEqual([]);
  });

  it('all LOTE M rows have lastReviewedAt in {2026-04-23, 2026-04-24, 2026-04-28} (dated closure + D1 re-review + Phase 4b)', () => {
    // Every row in this lot was originally reviewed on the LOTE M
    // closure date (2026-04-23). Rows touched by Sublote D1
    // (2026-04-24) during credential-arrival re-classification legally
    // bump to 2026-04-24 — provided the bump is recorded alongside a
    // promotion in one of the explicit D1 lists (partial, live,
    // upstream-suspended, or auth-incomplete sub-class).
    //
    // Phase 4b (2026-04-28) re-stamped mancer/venice when the
    // denyByDefault gate was replaced with the contentPolicyClass tag
    // — those two rows accept 2026-04-28. Any future lot must extend
    // PHASE_4B_TOUCHED here in lockstep with the stamp bump, so a
    // lot-merge accident still produces a violator. This test catches
    // accidental lot-merges that would collapse review dates and lose
    // the audit trail.
    const D1_TOUCHED = new Set<string>([
      ...LOTE_M_PROMOTED_TO_LIVE_D1,
      ...LOTE_M_PROMOTED_TO_UPSTREAM_SUSPENDED_D1,
      ...LOTE_M_MOVED_TO_AUTH_INCOMPLETE_D1,
    ]);
    const PHASE_4B_TOUCHED = new Set<string>(['mancer', 'venice']);
    // 2026-07-17 media-surface sweep: atlascloud was individually re-reviewed
    // (live probe proved both OAI-style video routes 404 → videoGeneration
    // de-advertised) and re-stamped. Same lockstep rule as PHASE_4B_TOUCHED:
    // extend this set only together with the entry's stamp bump.
    const MEDIA_SWEEP_2026_07_17_TOUCHED = new Set<string>(['atlascloud']);
    const violators: string[] = [];
    for (const id of LOTE_M_IDS) {
      const entry = findEntry(id);
      const reviewedAt = entry?.lastReviewedAt;
      const expected = MEDIA_SWEEP_2026_07_17_TOUCHED.has(id)
        ? '2026-07-17'
        : PHASE_4B_TOUCHED.has(id)
          ? '2026-04-28'
          : D1_TOUCHED.has(id)
            ? '2026-04-24'
            : '2026-04-23';
      if (reviewedAt !== expected) violators.push(`${id} (got ${reviewedAt}, expected ${expected})`);
    }
    expect(violators).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (C) Secret-loading mappings (load-secrets-into-env.ts wiring)
// ──────────────────────────────────────────────────────────────────────────

describe('LOTE M secret-loading mappings', () => {
  const source = readFileSync(LOAD_SECRETS_PATH, 'utf8');

  /**
   * Expected env-var name for each LOTE M id. qianfan uses the v2-specific
   * QIANFAN_API_KEY; everything else follows <PROVIDER_ID_UPPER>_API_KEY.
   */
  const EXPECTED_ENV_VAR: Record<(typeof LOTE_M_IDS)[number], string> = {
    arcee: 'ARCEE_API_KEY',
    atlascloud: 'ATLASCLOUD_API_KEY',
    avian: 'AVIAN_API_KEY',
    qianfan: 'QIANFAN_API_KEY',
    gmi: 'GMI_API_KEY',
    infermatic: 'INFERMATIC_API_KEY',
    inflection: 'INFLECTION_API_KEY',
    mancer: 'MANCER_API_KEY',
    phala: 'PHALA_API_KEY',
    relace: 'RELACE_API_KEY',
    siliconflow: 'SILICONFLOW_API_KEY',
    stepfun: 'STEPFUN_API_KEY',
    venice: 'VENICE_API_KEY',
  };

  for (const id of LOTE_M_IDS) {
    const envVar = EXPECTED_ENV_VAR[id];

    it(`PROVIDER_SECRETS has an entry for ${envVar}`, () => {
      // If this fires: the env-var → GCP-secret binding was removed.
      // The loader will silently fail to populate process.env[envVar]
      // when an operator provisions the GCP secret, making the
      // corresponding catalog row unreachable.
      const envVarRegex = new RegExp(
        `envVar:\\s*['"]${envVar}['"][\\s\\S]*?secretKeys:\\s*\\[`,
      );
      expect(source).toMatch(envVarRegex);
    });

    it(`ENV_VAR_TO_PROVIDER maps ${envVar} → '${id}'`, () => {
      // If this fires: Self-Healing Discovery (L1) cannot attribute
      // key presence back to the provider, so the provider never
      // transitions from credentials-missing to live on key arrival.
      const mapRegex = new RegExp(`${envVar}:\\s*['"]${id}['"]`);
      expect(source).toMatch(mapRegex);
    });
  }

  it('LLM_PROVIDER_ENV_VARS lists all 13 new env vars', () => {
    // If this fires: one or more LOTE M keys don't count toward the
    // "at least one LLM key present" gate. An operator could provision
    // a LOTE M secret and still see DEGRADED_SELF_HOSTED at boot.
    const missing: string[] = [];
    for (const id of LOTE_M_IDS) {
      const envVar = EXPECTED_ENV_VAR[id];
      const listRegex = new RegExp(`['"]${envVar}['"]`);
      if (!listRegex.test(source)) missing.push(envVar);
    }
    expect(missing).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (D) NOT_ELIGIBLE historical claims (liquid, modelrun, ncompass)
// ──────────────────────────────────────────────────────────────────────────

describe('LOTE M NOT_ELIGIBLE historical claims', () => {
  for (const id of LOTE_M_NOT_ELIGIBLE) {
    it(`NON_CANONICAL_HISTORICAL_CLAIMS documents why '${id}' is NOT_ELIGIBLE`, () => {
      // If this fires: the audit trail that explains why these
      // brand names (from the directive's 21-provider list) are NOT
      // in the catalog got silently erased. Operators looking at a
      // later complement lot wouldn't understand why we skipped them.
      const claim = NON_CANONICAL_HISTORICAL_CLAIMS.find((c) =>
        c.claim.includes(id),
      );
      expect(claim).toBeTruthy();
      expect(claim?.superseded_at).toBe('2026-04-23');
      expect(claim?.reason).toBeTruthy();
    });

    it(`'${id}' does NOT appear as a catalog row`, () => {
      // If this fires: a NOT_ELIGIBLE brand sneaked into the catalog.
      // Either (a) the eligibility judgment was reversed in a later
      // lot — in which case ALSO remove the historical claim and
      // this test entry; or (b) a copy-paste added a row without
      // due diligence. Revert or re-audit.
      const entry = findEntry(id);
      expect(entry).toBeUndefined();
    });
  }
});
