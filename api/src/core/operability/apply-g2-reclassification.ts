// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Static G→G2 Reclassification Migrator.
 *
 * Pure function that takes a G-audit JSON snapshot (per-provider
 * `ProviderAuditResult` records) and applies the G2 taxonomy:
 *   - `provider-capability-kind` reclassifies specialized non-chat
 *     providers from `unknown` → N.
 *   - `provider-canonical-model-resolver` + `provider-model-aliases`
 *     reclassify H (`model_not_supported`) into G (alias-fixable) when
 *     a static alias would rewrite the catalog id.
 *   - `looksLikeAliasMismatch` reclassifies model-related 4xx into G.
 *   - Heuristics for `unknown` → O / P / R / S / T / U / V based on
 *     structural evidence (no catalog row, suspicious adapter binding,
 *     empty discovery, audit skipped).
 *
 * The function does NOT issue any network calls and does NOT touch the
 * database. It reads ONLY the G audit JSON + (optionally) a catalog
 * lookup table built by the caller. Designed for offline reclassification
 * before issuing real (billable) reprobes.
 */
import {
  type ProviderReadinessBucket,
  RECOMMENDED_FIX_BY_BUCKET,
} from './provider-readiness-buckets';
import {
  classifyProviderCapabilityKind,
  isSpecializedNonChatProvider,
} from './provider-capability-kind';
import {
  resolveCanonicalProbeModel,
  type CatalogCandidate,
} from './provider-canonical-model-resolver';
import { looksLikeAliasMismatch } from './provider-readiness-classifier';

/**
 * Subset of the G audit's `ProviderAuditResult` we read. We accept the
 * input by structural shape so the caller can pass any superset record
 * (e.g., the full G JSON, or a synthetic record for unit tests).
 */
export interface GAuditRecordLike {
  readonly providerId: string;
  readonly providerKind?: string;
  readonly adapterName?: string;
  readonly adapterRegistered?: boolean;
  readonly adapterInstantiable?: boolean;
  readonly secretsResolvedFromGcp?: boolean | null;
  readonly discoverySupported?: boolean | null;
  readonly discoveryReady?: boolean | null;
  readonly sampleModelId?: string | null;
  readonly chatProbeAttempted?: boolean;
  readonly chatReady?: boolean;
  readonly httpStatus?: number;
  readonly errorKind?: string;
  readonly bucket: string;
  readonly lastSanitizedMessage?: string | null;
  readonly discoveredModelIds?: readonly string[];
}

/**
 * Optional per-provider catalog lookup. The migrator uses this to find
 * an alternative model when reclassifying H → G with the canonical
 * resolver. If unavailable, the migrator can still detect alias
 * candidates from the `sampleModelId` in the G record alone.
 */
export interface CatalogLookupFn {
  (providerId: string): readonly CatalogCandidate[];
}

export interface G2Record extends GAuditRecordLike {
  /** New G2 bucket assignment. */
  readonly bucketG2: ProviderReadinessBucket;
  /** Whether the G bucket changed during reclassification. */
  readonly reclassified: boolean;
  /** Human-readable migration explanation. */
  readonly migrationReason: string;
  /** New recommended-fix (stable id) per G2 taxonomy. */
  readonly g2RecommendedFix: string | null;
  /** Canonical model the resolver would pick for a reprobe, if any. */
  readonly canonicalProbeModelId?: string;
  /** API model id (post-alias) the resolver would use for the reprobe. */
  readonly canonicalProbeApiModelId?: string;
  /** Resolver source if computed (catalog_alias / catalog_direct / …). */
  readonly canonicalProbeSource?: string;
}

export interface ApplyG2ReclassificationInput {
  readonly gAudit: readonly GAuditRecordLike[];
  readonly catalogLookup?: CatalogLookupFn;
  /** Optional: providers known to be skipped by budget (T_*). */
  readonly skippedByBudget?: readonly string[];
  /** Optional: providers known to need deployment endpoint (S_*). */
  readonly requiresDeployment?: readonly string[];
  /** Optional: providers with secret-alias loader mismatch (R_*). */
  readonly secretAliasMismatched?: readonly string[];
  /** Optional: providers with auth header / base URL mismatch (Q_*). */
  readonly authHeaderMismatched?: readonly string[];
  /** Optional: providers with provider-id ↔ catalog binding mismatch (P_*). */
  readonly catalogIdMismatched?: readonly string[];
}

export interface ApplyG2ReclassificationResult {
  readonly records: readonly G2Record[];
  /** Distribution snapshot before vs after. */
  readonly distributionBefore: Readonly<Record<string, number>>;
  readonly distributionAfter: Readonly<Record<ProviderReadinessBucket, number>>;
  /** Providers whose bucket changed. */
  readonly diff: ReadonlyArray<{
    readonly providerId: string;
    readonly from: string;
    readonly to: ProviderReadinessBucket;
    readonly reason: string;
  }>;
}

const SKIPPED_BUDGET_BUCKET_NAMES = new Set([
  'T_probe_skipped_by_budget_or_policy',
  'skipped',
  'budget_exhausted',
]);

/**
 * Apply the G→G2 reclassification.
 *
 * Priority (highest authority first):
 *   1. Capability-kind specialized → N (overrides chat-related buckets).
 *   2. Skipped-by-budget → T.
 *   3. Missing adapter / missing secret pass through (I / J unchanged).
 *   4. Chat-ready pass through (A unchanged).
 *   5. Credit / suspension / rate-limit pass through (C / E / F unchanged).
 *   6. Auth-blocked: refine into D (default), Q (header/base-url) or R
 *      (secret-alias loader miss) using caller-provided hints.
 *   7. Model-not-supported: apply resolver + alias detection to choose
 *      G (alias-probable) or H (truly absent).
 *   8. unknown: refine into O / P / S / T / U / V using structural hints.
 */
export function applyG2Reclassification(
  input: ApplyG2ReclassificationInput,
): ApplyG2ReclassificationResult {
  const skippedBudget = new Set((input.skippedByBudget ?? []).map((s) => s.toLowerCase()));
  const requiresDeployment = new Set(
    (input.requiresDeployment ?? []).map((s) => s.toLowerCase()),
  );
  const secretAliasMismatched = new Set(
    (input.secretAliasMismatched ?? []).map((s) => s.toLowerCase()),
  );
  const authHeaderMismatched = new Set(
    (input.authHeaderMismatched ?? []).map((s) => s.toLowerCase()),
  );
  const catalogIdMismatched = new Set(
    (input.catalogIdMismatched ?? []).map((s) => s.toLowerCase()),
  );

  const distributionBefore: Record<string, number> = {};
  const distributionAfter: Record<string, number> = {};
  const diff: Array<{
    providerId: string;
    from: string;
    to: ProviderReadinessBucket;
    reason: string;
  }> = [];
  const records: G2Record[] = [];

  for (const rec of input.gAudit) {
    distributionBefore[rec.bucket] = (distributionBefore[rec.bucket] ?? 0) + 1;
    const reclass = reclassifyOne(rec, {
      skippedBudget,
      requiresDeployment,
      secretAliasMismatched,
      authHeaderMismatched,
      catalogIdMismatched,
      catalogLookup: input.catalogLookup,
    });
    const newRec: G2Record = {
      ...rec,
      bucketG2: reclass.bucket,
      reclassified: reclass.bucket !== rec.bucket,
      migrationReason: reclass.reason,
      g2RecommendedFix: RECOMMENDED_FIX_BY_BUCKET[reclass.bucket],
      canonicalProbeModelId: reclass.canonicalModelId,
      canonicalProbeApiModelId: reclass.canonicalApiModelId,
      canonicalProbeSource: reclass.canonicalSource,
    };
    records.push(newRec);
    distributionAfter[reclass.bucket] = (distributionAfter[reclass.bucket] ?? 0) + 1;
    if (newRec.reclassified) {
      diff.push({
        providerId: rec.providerId,
        from: rec.bucket,
        to: reclass.bucket,
        reason: reclass.reason,
      });
    }
  }

  return {
    records,
    distributionBefore,
    distributionAfter: distributionAfter as Readonly<Record<ProviderReadinessBucket, number>>,
    diff,
  };
}

interface ReclassifyContext {
  readonly skippedBudget: ReadonlySet<string>;
  readonly requiresDeployment: ReadonlySet<string>;
  readonly secretAliasMismatched: ReadonlySet<string>;
  readonly authHeaderMismatched: ReadonlySet<string>;
  readonly catalogIdMismatched: ReadonlySet<string>;
  readonly catalogLookup?: CatalogLookupFn;
}

interface ReclassifyOneResult {
  readonly bucket: ProviderReadinessBucket;
  readonly reason: string;
  readonly canonicalModelId?: string;
  readonly canonicalApiModelId?: string;
  readonly canonicalSource?: string;
}

function reclassifyOne(rec: GAuditRecordLike, ctx: ReclassifyContext): ReclassifyOneResult {
  const providerId = rec.providerId.toLowerCase();

  // 1. Capability-kind takes precedence — specialized providers don't
  //    belong in any chat-related bucket regardless of what the chat
  //    probe attempt produced.
  if (isSpecializedNonChatProvider(providerId)) {
    return {
      bucket: 'N_specialized_non_chat_provider',
      reason: `provider classified as ${classifyProviderCapabilityKind(providerId)} (specialized non-chat)`,
    };
  }

  // 2. Skipped by budget/policy.
  if (ctx.skippedBudget.has(providerId) || SKIPPED_BUDGET_BUCKET_NAMES.has(rec.bucket)) {
    return {
      bucket: 'T_probe_skipped_by_budget_or_policy',
      reason: 'audit reached probe/budget cap before reaching this provider',
    };
  }

  // 3. Pass-through buckets — G→G2 keeps these labels (rename A_… → A_…
  //    by stripping the long prefix; the bucket file uses short ids).
  //    The G bucket strings are wordier; map to the G2 short equivalents.
  const passThrough = mapWordyToShortBucket(rec.bucket);
  if (passThrough && passThrough !== 'PASS_TO_REFINEMENT') {
    return { bucket: passThrough, reason: 'bucket carried over from G unchanged' };
  }

  // 4. Auth-blocked refinement.
  if (rec.bucket === 'D_registered_adapter_ready_blocked_by_auth' ||
      rec.errorKind === 'invalid_auth') {
    if (ctx.secretAliasMismatched.has(providerId)) {
      return {
        bucket: 'R_secret_alias_mismatch',
        reason: 'auth failure attributed to loader env-var alias mismatch',
      };
    }
    if (ctx.authHeaderMismatched.has(providerId)) {
      return {
        bucket: 'Q_auth_header_or_base_url_mismatch',
        reason: 'auth failure attributed to header scheme / base URL mismatch',
      };
    }
    if (ctx.requiresDeployment.has(providerId)) {
      return {
        bucket: 'S_provider_requires_deployment_or_endpoint',
        reason: 'auth failure attributed to missing deployment / endpoint id',
      };
    }
    return {
      bucket: 'D_blocked_by_auth_confirmed',
      reason: 'auth failure with no structural override hint — likely real invalid key',
    };
  }

  // 5. Model-not-supported refinement — apply the resolver + alias map.
  if (rec.bucket === 'H_registered_adapter_ready_model_not_supported' ||
      rec.errorKind === 'model_not_supported') {
    const aliasSuspect = looksLikeAliasMismatch({
      providerId,
      modelId: rec.sampleModelId ?? null,
      errorMessage: rec.lastSanitizedMessage ?? null,
      discoveredModelIds: rec.discoveredModelIds,
    });

    // Try the canonical resolver to see if catalog has an alias-fixable form.
    let canonical: ReclassifyOneResult['canonicalModelId'];
    let canonicalApi: ReclassifyOneResult['canonicalApiModelId'];
    let canonicalSource: ReclassifyOneResult['canonicalSource'];
    if (ctx.catalogLookup) {
      const r = resolveCanonicalProbeModel({
        providerId,
        catalogModels: ctx.catalogLookup(providerId),
      });
      if (r) {
        canonical = r.modelId;
        canonicalApi = r.apiModelId;
        canonicalSource = r.source;
      }
    }

    if (aliasSuspect || canonicalSource === 'catalog_alias') {
      return {
        bucket: 'G_model_alias_mismatch_probable',
        reason: aliasSuspect
          ? 'heuristic detected alias-format issue in catalog model id'
          : 'canonical resolver produced an alias-rewritten api model id',
        canonicalModelId: canonical,
        canonicalApiModelId: canonicalApi,
        canonicalSource,
      };
    }
    return {
      bucket: 'H_model_not_supported_confirmed',
      reason: 'no alias signal — model genuinely absent on provider plan or wrong adapter',
      canonicalModelId: canonical,
      canonicalApiModelId: canonicalApi,
      canonicalSource,
    };
  }

  // 6. unknown refinement.
  if (rec.bucket === 'unknown') {
    // No adapter / no catalog binding hint?
    if (rec.adapterRegistered === false) {
      return {
        bucket: 'I_adapter_missing',
        reason: 'unknown bucket promoted to I — adapter never registered',
      };
    }
    if (!rec.chatProbeAttempted) {
      // Discovery may have worked but chat probe never fired.
      if (rec.discoveryReady === true) {
        return {
          bucket: 'B_discovery_ready_chat_not_probed',
          reason: 'discovery succeeded; chat probe not attempted',
        };
      }
      if (rec.discoveryReady === false) {
        return {
          bucket: 'U_discovery_supported_but_empty',
          reason: 'discovery endpoint returned no models / failed',
        };
      }
      // No catalog candidate to probe with.
      return {
        bucket: 'O_no_catalog_model_bound_to_provider',
        reason: 'no catalog model row binds to this providerId — chat probe could not start',
      };
    }
    if (ctx.catalogIdMismatched.has(providerId)) {
      return {
        bucket: 'P_provider_id_catalog_mismatch',
        reason: 'catalog row points at a providerId that does not match adapter name',
      };
    }
    return {
      bucket: 'V_unknown_unclassified',
      reason: 'no structural hint matched — manual investigation required',
    };
  }

  // 7. Default fall-through (rate_limit, credit, suspension, etc.).
  return {
    bucket: 'V_unknown_unclassified',
    reason: `unrecognized G bucket "${rec.bucket}" — no migration rule matched`,
  };
}

/**
 * G bucket strings are wordy (`A_registered_and_chat_ready`); G2 uses
 * short ids (`A_chat_ready`). Map G→G2 short forms for pass-through.
 * Returns:
 *   - a G2 bucket when there is a 1:1 carry-over
 *   - `'PASS_TO_REFINEMENT'` when refinement logic should run
 *   - `null` when the input is not a known G bucket
 */
function mapWordyToShortBucket(
  gBucket: string,
): ProviderReadinessBucket | 'PASS_TO_REFINEMENT' | null {
  switch (gBucket) {
    case 'A_registered_and_chat_ready':
      return 'A_chat_ready';
    case 'B_registered_adapter_ready_discovery_only':
      return 'B_discovery_ready_chat_not_probed';
    case 'C_registered_adapter_ready_blocked_by_credit':
      return 'C_blocked_by_credit';
    case 'D_registered_adapter_ready_blocked_by_auth':
      return 'PASS_TO_REFINEMENT'; // refine into D / Q / R / S
    case 'E_registered_adapter_ready_blocked_by_suspension':
      return 'E_blocked_by_suspension';
    case 'F_registered_adapter_ready_blocked_by_rate_limit':
      return 'F_rate_limited';
    case 'G_registered_adapter_ready_model_alias_mismatch':
      return 'G_model_alias_mismatch_probable';
    case 'H_registered_adapter_ready_model_not_supported':
      return 'PASS_TO_REFINEMENT'; // refine into G / H via resolver
    case 'I_registered_but_adapter_missing':
      return 'I_adapter_missing';
    case 'J_registered_but_secret_missing':
      return 'J_secret_missing';
    case 'K_local_ollama_ready':
      return 'K_local_ollama_ready';
    case 'L_local_ollama_configured_but_unreachable':
      return 'L_local_ollama_unreachable';
    case 'M_local_ollama_not_configured':
      return 'M_local_ollama_not_configured';
    case 'unknown':
      return 'PASS_TO_REFINEMENT';
    default:
      // Already a short G2 bucket name? Pass through.
      if (Object.prototype.hasOwnProperty.call(RECOMMENDED_FIX_BY_BUCKET, gBucket)) {
        return gBucket as ProviderReadinessBucket;
      }
      return null;
  }
}
