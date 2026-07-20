// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderProbeStrategy — per-adapter configuration for what discovery
 * actually probes.
 *
 * Why this exists: not every provider supports the same probe surface.
 * Anthropic has no `/v1/models` listing, Cloudflare Workers AI doesn't
 * expose a billing API, Ollama has `/api/tags` but no auth, etc. A naive
 * `HEAD /v1/models` strategy would mark the majority of providers as
 * "unavailable" because they don't implement the probe — destroying the
 * candidate pool.
 *
 * Design principle: the absence of a probe surface is NOT evidence of
 * unavailability. Each adapter declares what it supports; missing
 * surfaces map to `discoveryConfidence: 'partially_verified'` or
 * `'inferred'` rather than to `state: 'unavailable'`.
 *
 * Phase 1: minimal default strategies for the most common integration
 * shapes. The catalog already classifies providers by `integrationClass`
 * (`oai-compat-pure`, `oai-compat-quirks`, `native-anthropic`, etc.) — we
 * use that classification to derive a sensible default. Operators can
 * override per-provider via `overrides`.
 */

import type {
  CredentialProbeKind,
  CreditProbeKind,
  EndpointProbeKind,
  ModelProbeKind,
  ProviderProbeStrategy,
} from './types';

// ─── Defaults by integration class ─────────────────────────────────────────

/**
 * Conservative defaults that minimize false negatives. The strategy here is:
 *
 * 1. credentialProbe: prefer `env_only` (just check the env var is set).
 *    Only escalate to `auth_endpoint` or `models_api` when we have
 *    evidence the provider supports it cheaply.
 *
 * 2. creditProbe: most providers have NO billing API exposed publicly.
 *    Default to `not_supported` and rely on RUNTIME signals (HTTP 402)
 *    to detect credit exhaustion.
 *
 * 3. endpointProbe: prefer `models_api` when the integration class
 *    declares it works (`oai-compat-pure`); otherwise `not_supported`
 *    and let runtime traffic validate.
 *
 * 4. modelProbe: same logic as endpointProbe.
 *
 * IMPORTANT: we deliberately AVOID using HEAD or OPTIONS as default
 * endpoint probes. Most LLM providers either reject those methods or
 * return 405/501 even when fully operational — using them as health
 * indicators causes false unavailability.
 */
const DEFAULT_BY_INTEGRATION_CLASS: Readonly<
  Record<string, Omit<ProviderProbeStrategy, 'providerId'>>
> = Object.freeze({
  // OpenAI-compatible providers that expose /v1/models
  'oai-compat-pure': {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
  // OAI-compatible with quirks (some don't list models)
  'oai-compat-quirks': {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'not_supported',
    modelProbe: 'known_catalog_alias',
  },
  // Native Anthropic — no models listing endpoint
  'native-anthropic': {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'not_supported',
    modelProbe: 'known_catalog_alias',
  },
  // Native OpenAI — has /v1/models
  'native-openai': {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
  // Native Google / Vertex AI
  'native-google': {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'not_supported',
    modelProbe: 'known_catalog_alias',
  },
  // AWS Bedrock — uses SigV4, no public models listing in standard API
  'native-aws-bedrock': {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'not_supported',
    modelProbe: 'known_catalog_alias',
  },
  // Self-hosted (Ollama, llama.cpp, etc.)
  'self-hosted-oai-compat': {
    credentialProbe: 'not_supported',
    creditProbe: 'not_supported',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
  // Aggregator hubs that expose billing (NanoGPT, AiHubMix, etc.)
  'aggregator-with-billing': {
    credentialProbe: 'env_only',
    creditProbe: 'billing_api',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
  // Default fallback for unknown integration classes
  unknown: {
    credentialProbe: 'env_only',
    creditProbe: 'not_supported',
    endpointProbe: 'not_supported',
    modelProbe: 'known_catalog_alias',
  },
});

// ─── Per-provider overrides ────────────────────────────────────────────────

/**
 * Hand-tuned overrides for providers where the default doesn't match
 * reality. Add entries here when telemetry shows persistent false
 * negatives or false positives for a specific provider.
 */
const PROVIDER_OVERRIDES: Readonly<
  Record<string, Omit<ProviderProbeStrategy, 'providerId'>>
> = Object.freeze({
  // AiHubMix exposes /api/user/self for billing
  aihubmix: {
    credentialProbe: 'env_only',
    creditProbe: 'billing_api',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
  // CometAPI exposes /api/user/self for billing
  cometapi: {
    credentialProbe: 'env_only',
    creditProbe: 'billing_api',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
  // OpenRouter exposes /api/v1/auth/key for credit info
  openrouter: {
    credentialProbe: 'env_only',
    creditProbe: 'billing_api',
    endpointProbe: 'models_api',
    modelProbe: 'list_models',
  },
});

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Resolves the probe strategy for a given provider.
 * Order of resolution:
 *   1. PROVIDER_OVERRIDES (per-provider tuned)
 *   2. DEFAULT_BY_INTEGRATION_CLASS (by integration class)
 *   3. DEFAULT_BY_INTEGRATION_CLASS.unknown (catch-all)
 *
 * Operator-time customization happens by editing this file or by injecting
 * a custom resolver via the discovery service constructor.
 */
export function resolveProbeStrategy(input: {
  providerId: string;
  integrationClass?: string;
}): ProviderProbeStrategy {
  const override = PROVIDER_OVERRIDES[input.providerId.toLowerCase()];
  if (override) {
    return { providerId: input.providerId, ...override };
  }

  const byClass = input.integrationClass
    ? DEFAULT_BY_INTEGRATION_CLASS[input.integrationClass]
    : undefined;

  if (byClass) {
    return { providerId: input.providerId, ...byClass };
  }

  return { providerId: input.providerId, ...DEFAULT_BY_INTEGRATION_CLASS.unknown };
}

// ─── Probe-kind predicates ─────────────────────────────────────────────────

export function probeSupportsCredentialCheck(kind: CredentialProbeKind): boolean {
  return kind !== 'not_supported';
}

export function probeSupportsCreditCheck(kind: CreditProbeKind): boolean {
  return kind !== 'not_supported';
}

export function probeSupportsEndpointCheck(kind: EndpointProbeKind): boolean {
  return kind !== 'not_supported';
}

export function probeSupportsModelEnumeration(kind: ModelProbeKind): boolean {
  return kind === 'list_models' || kind === 'minimal_completion';
}
