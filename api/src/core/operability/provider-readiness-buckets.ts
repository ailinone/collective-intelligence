// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Provider Readiness Buckets (revised taxonomy).
 *
 * The G classification (13 buckets A–M) was too coarse: the `unknown`
 * bucket absorbed providers that were:
 *   - specialized non-chat (deepgram, voyage, cartesia, elevenlabs, …)
 *   - chat-capable but lacked a catalog model bound to providerId
 *   - chat-capable but probed with the wrong model (sambanova got MiniMax,
 *     perplexity got an Anthropic model — the audit's "first chat-capable"
 *     query returned cross-provider models because of catalog leakage)
 *   - skipped probes entirely because no chat-capable catalog row existed
 *     for the providerId
 *
 * G2 introduces 22 actionable buckets so each problem has a distinct
 * `recommendedFix`. `V_unknown_unclassified` is residual — should be < 10%
 * of the registry after reclassification.
 */
export type ProviderReadinessBucket =
  | 'A_chat_ready'
  | 'B_discovery_ready_chat_not_probed'
  | 'C_blocked_by_credit'
  | 'D_blocked_by_auth_confirmed'
  | 'E_blocked_by_suspension'
  | 'F_rate_limited'
  | 'G_model_alias_mismatch_probable'
  | 'G2_model_alias_mismatch_confirmed'
  | 'H_model_not_supported_confirmed'
  | 'I_adapter_missing'
  | 'J_secret_missing'
  | 'K_local_ollama_ready'
  | 'L_local_ollama_unreachable'
  | 'M_local_ollama_not_configured'
  | 'N_specialized_non_chat_provider'
  | 'O_no_catalog_model_bound_to_provider'
  | 'P_provider_id_catalog_mismatch'
  | 'Q_auth_header_or_base_url_mismatch'
  | 'R_secret_alias_mismatch'
  | 'S_provider_requires_deployment_or_endpoint'
  | 'T_probe_skipped_by_budget_or_policy'
  | 'U_discovery_supported_but_empty'
  | 'V_unknown_unclassified';

/**
 * Recommended-fix string per bucket. Stable IDs that operators can
 * automate against (CI jobs, run-books, etc.).
 */
export const RECOMMENDED_FIX_BY_BUCKET: Readonly<
  Record<ProviderReadinessBucket, string | null>
> = {
  A_chat_ready: null,
  B_discovery_ready_chat_not_probed: 'run_chat_probe',
  C_blocked_by_credit: 'top_up_provider_balance',
  D_blocked_by_auth_confirmed: 'rotate_api_key',
  E_blocked_by_suspension: 'contact_provider_to_lift_suspension',
  F_rate_limited: 'wait_or_increase_quota',
  G_model_alias_mismatch_probable: 'add_provider_model_alias_in_catalog',
  G2_model_alias_mismatch_confirmed: 'add_provider_model_alias_in_catalog',
  H_model_not_supported_confirmed: 'remove_model_from_catalog_or_enable_provider_plan',
  I_adapter_missing: 'wire_adapter_for_provider_in_registry',
  J_secret_missing: 'add_provider_secret_to_gcp_secret_manager',
  K_local_ollama_ready: null,
  L_local_ollama_unreachable: 'start_ollama_host',
  M_local_ollama_not_configured: 'set_OLLAMA_HOSTS_or_OLLAMA_BASE_URL_in_env',
  N_specialized_non_chat_provider: 'classify_as_capability_specific_provider',
  O_no_catalog_model_bound_to_provider: 'add_catalog_model_with_providerId',
  P_provider_id_catalog_mismatch: 'align_catalog_providerId_with_adapter_name',
  Q_auth_header_or_base_url_mismatch: 'audit_adapter_auth_scheme_and_base_url',
  R_secret_alias_mismatch: 'add_secret_env_alias_to_loader',
  S_provider_requires_deployment_or_endpoint: 'configure_provider_deployment_endpoint',
  T_probe_skipped_by_budget_or_policy: 'rerun_audit_with_higher_budget_or_explicit_target',
  U_discovery_supported_but_empty: 'investigate_provider_discovery_endpoint',
  V_unknown_unclassified: 'investigate_provider_manually',
};

export const BUCKET_DESCRIPTIONS: Readonly<Record<ProviderReadinessBucket, string>> = {
  A_chat_ready: 'Chat-completions endpoint responded 200 with valid content.',
  B_discovery_ready_chat_not_probed: 'Discovery (/v1/models) worked but chat was not probed (budget/policy).',
  C_blocked_by_credit: 'Provider account has insufficient credit / balance too low.',
  D_blocked_by_auth_confirmed: 'API key rejected after secret presence + endpoint check.',
  E_blocked_by_suspension: 'Provider account suspended at vendor side.',
  F_rate_limited: 'Provider returned 429 / rate limit during probe.',
  G_model_alias_mismatch_probable: '404/400 with strong heuristic that model id is catalog-formatted, not API-formatted.',
  G2_model_alias_mismatch_confirmed: 'Reprobe with canonical alias succeeded (or discovery lists alias-form).',
  H_model_not_supported_confirmed: 'Reprobe with canonical alias still 404 — model truly absent on provider plan.',
  I_adapter_missing: 'Provider in registry but no adapter instance.',
  J_secret_missing: 'Adapter present, secret env var not loaded.',
  K_local_ollama_ready: 'Local Ollama host reachable with ≥1 model installed.',
  L_local_ollama_unreachable: 'OLLAMA_BASE_URL set but /api/tags failed.',
  M_local_ollama_not_configured: 'OLLAMA_BASE_URL / OLLAMA_HOSTS env unset.',
  N_specialized_non_chat_provider: 'Provider is capability-specific (audio, embeddings, image) — chat probe inapplicable.',
  O_no_catalog_model_bound_to_provider: 'Adapter present but no catalog row has providerId pointing at it.',
  P_provider_id_catalog_mismatch: 'Catalog row points at a providerId that does not match the adapter.getName() — wrong binding.',
  Q_auth_header_or_base_url_mismatch: 'Secret present but auth header scheme or base URL is wrong for this provider.',
  R_secret_alias_mismatch: 'Secret in GCP but loader uses different env var name; adapter never sees it.',
  S_provider_requires_deployment_or_endpoint: 'Provider needs deployment id / region / endpoint id (Azure, AWS Bedrock, Vertex).',
  T_probe_skipped_by_budget_or_policy: 'Audit reached budget cap before reaching this provider.',
  U_discovery_supported_but_empty: 'Discovery endpoint returned empty list (no models exposed).',
  V_unknown_unclassified: 'None of the above patterns matched — manual investigation required.',
};
