// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §9 — Cross-Provider Catalog Leakage Detector.
 *
 * Pure function that scans a model list and reports rows where the
 * `providerId` does NOT match the namespace embedded in the model `id`.
 *
 * Concrete evidence from G3 audit:
 *   - perplexity catalog row had `sampleModelId="openai/gpt-5.5"` → 400
 *     "Invalid model" because Perplexity's API does not serve OpenAI
 *     models with that id format.
 *   - sambanova catalog row had `sampleModelId="MiniMax-M2.7"` → 422
 *     because SambaNova does not host MiniMax models under that id.
 *
 * The leakage SIGNAL is:
 *   - the model id has a slash-prefixed namespace `<X>/...`
 *   - that namespace `<X>` matches a KNOWN provider id
 *   - AND that namespace `<X>` is NOT the same as `model.provider`
 *
 * The leakage is reported PER ROW, with the suggested action:
 *   - if `<X>` is a known provider, the row probably belongs to provider `<X>`
 *     (the loader put it on the wrong provider's catalog page).
 *   - if `<X>` is not a known provider, the row may use a hub-style id
 *     format that's legitimate for the current provider — the detector
 *     reports it as `suspicious` rather than `leakage` so operators audit.
 *
 * Designed to be CI-runnable: takes a model list, returns a report. No
 * DB writes, no network, no side effects.
 */

export interface CatalogModelLike {
  readonly id: string;
  readonly provider?: string | null;
  /** Optional fields some adapters surface; the detector tolerates absence. */
  readonly upstreamProvider?: string | null;
  readonly canonicalProvider?: string | null;
  readonly routeProvider?: string | null;
}

export type LeakageSeverity = 'leakage' | 'suspicious' | 'ok';

export interface LeakageFinding {
  readonly modelId: string;
  readonly providerId: string;
  readonly severity: LeakageSeverity;
  readonly detectedNamespace?: string;
  readonly suggestedFix?: string;
  readonly reason: string;
}

export interface LeakageReport {
  readonly total: number;
  readonly leakage: number;
  readonly suspicious: number;
  readonly ok: number;
  readonly findings: readonly LeakageFinding[];
  readonly byProvider: Readonly<Record<string, { leakage: number; suspicious: number; ok: number }>>;
}

/**
 * Known provider namespaces. Used to detect whether a slash-prefix is a
 * legitimate cross-provider hosting marker (in which case `upstreamProvider`
 * should be set) vs. a leakage (where the catalog placed an upstream model
 * under the wrong adapter row).
 *
 * Curated from `providers.catalog.ts` + L1 self-healing DB providers.
 * Operator can extend per deployment.
 */
const KNOWN_PROVIDER_NAMESPACES: ReadonlySet<string> = new Set([
  'openai',
  'anthropic',
  'google',
  'mistral',
  'cohere',
  'meta',
  'meta-llama',
  'xai',
  'deepseek',
  'qwen',
  'alibaba',
  'minimax',
  'moonshot',
  'huggingface',
  'fireworks',
  'fireworks-ai',
  'togetherai',
  'together',
  'groq',
  'cerebras',
  'perplexity',
  'sambanova',
  'replicate',
  'nvidia',
  'aws-bedrock',
  'azure-openai',
  'vertex-ai',
  'gemini-openai',
  'aihubmix',
  'novita',
  'fireworks',
]);

/**
 * Hub-style providers that LEGITIMATELY accept namespaced model ids
 * (e.g., `meta/llama-3.2-11b` on vercel-ai-gateway). For these, a slash
 * prefix is NOT leakage — it's the canonical id format.
 */
const HUB_PROVIDERS_ACCEPTING_NAMESPACED_IDS: ReadonlySet<string> = new Set([
  'openrouter',
  'aihubmix',
  'cometapi',
  'edenai',
  'orqai',
  'requesty',
  'nanogpt',
  'venice',
  'aiml',
  'imagerouter',
  'poe',
  'github-models',
  'gemini-openai',
  'vercel-ai-gateway',
  'huggingface',  // HF router also accepts <org>/<model>
  'replicate',    // Replicate uses <owner>/<model> format
  'wandb',
  'bytez',
  'cloudflare-workers-ai',
]);

/**
 * Audit a single model.
 *
 * Returns:
 *   - `leakage` when the model id namespace points at a DIFFERENT known
 *     provider AND the row's provider is NOT a hub provider that would
 *     legitimately host it.
 *   - `suspicious` when the model id has a namespace prefix but it's
 *     ambiguous (unknown namespace, hub provider, etc.).
 *   - `ok` otherwise.
 */
export function detectModelLeakage(model: CatalogModelLike): LeakageFinding {
  const id = (model.id ?? '').toLowerCase();
  const providerId = (model.provider ?? '').toLowerCase();

  if (!id) {
    return {
      modelId: model.id ?? '',
      providerId: model.provider ?? '',
      severity: 'ok',
      reason: 'empty_model_id',
    };
  }

  // Slash-prefix detection — namespaced ids are the leakage carrier.
  const firstSlash = id.indexOf('/');
  if (firstSlash <= 0) {
    return {
      modelId: model.id,
      providerId: model.provider ?? '',
      severity: 'ok',
      reason: 'no_namespace_prefix',
    };
  }

  const namespace = id.slice(0, firstSlash);

  // Hub providers legitimately host namespaced ids.
  if (HUB_PROVIDERS_ACCEPTING_NAMESPACED_IDS.has(providerId)) {
    return {
      modelId: model.id,
      providerId: model.provider ?? '',
      severity: 'ok',
      detectedNamespace: namespace,
      reason: 'hub_provider_accepts_namespaced_id',
    };
  }

  // Namespace == provider == same → double-prefix (covered by alias module).
  if (namespace === providerId) {
    return {
      modelId: model.id,
      providerId: model.provider ?? '',
      severity: 'suspicious',
      detectedNamespace: namespace,
      suggestedFix: 'check_PROVIDER_MODEL_ALIASES_for_double_prefix_rewrite',
      reason: 'double_prefix_namespace_equals_providerId',
    };
  }

  // Namespace is a KNOWN provider that is NOT the row's provider — leakage.
  if (KNOWN_PROVIDER_NAMESPACES.has(namespace)) {
    // Check if upstream/canonical fields legitimately record this as a hosted model.
    const upstreamMatch =
      model.upstreamProvider?.toLowerCase() === namespace ||
      model.canonicalProvider?.toLowerCase() === namespace ||
      model.routeProvider?.toLowerCase() === namespace;
    if (upstreamMatch) {
      return {
        modelId: model.id,
        providerId: model.provider ?? '',
        severity: 'ok',
        detectedNamespace: namespace,
        reason: 'upstream_provider_field_legitimately_records_namespace',
      };
    }
    return {
      modelId: model.id,
      providerId: model.provider ?? '',
      severity: 'leakage',
      detectedNamespace: namespace,
      suggestedFix: `move_row_to_providerId="${namespace}"_or_set_upstreamProvider="${namespace}"`,
      reason: `model id namespace "${namespace}" is a known provider but row.provider="${providerId}"`,
    };
  }

  // Unknown namespace — could be legitimate (e.g., custom deployment) or
  // operator-introduced.
  return {
    modelId: model.id,
    providerId: model.provider ?? '',
    severity: 'suspicious',
    detectedNamespace: namespace,
    suggestedFix: 'verify_namespace_is_intentional',
    reason: 'unknown_namespace_prefix',
  };
}

/**
 * Audit a full catalog. Returns aggregated findings + per-provider counts.
 */
export function detectCrossProviderCatalogLeakage(
  models: readonly CatalogModelLike[],
): LeakageReport {
  const findings: LeakageFinding[] = [];
  const byProvider: Record<string, { leakage: number; suspicious: number; ok: number }> = {};
  let leakage = 0;
  let suspicious = 0;
  let ok = 0;

  for (const m of models) {
    const f = detectModelLeakage(m);
    findings.push(f);
    const p = f.providerId || '<unknown>';
    if (!byProvider[p]) byProvider[p] = { leakage: 0, suspicious: 0, ok: 0 };
    if (f.severity === 'leakage') {
      leakage++;
      byProvider[p].leakage++;
    } else if (f.severity === 'suspicious') {
      suspicious++;
      byProvider[p].suspicious++;
    } else {
      ok++;
      byProvider[p].ok++;
    }
  }

  return {
    total: models.length,
    leakage,
    suspicious,
    ok,
    findings,
    byProvider,
  };
}
