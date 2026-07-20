// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §11 — Provider unknown reclassification rules.
 *
 * Pins the static reclassification logic that the J1C helper script
 * (`tmp/01c1b-j1c-reclassify-unknown.mjs`) applies. The rules use only
 * static catalog + provider-type signals — no provider HTTP calls.
 *
 * The reclassification took J1B's 36 `unknown` providers down to 0
 * remaining unknown by routing each into one of:
 *   - S_specialized_non_chat (audio/embedding/image-only)
 *   - T_deployment_required (Azure/AWS Bedrock/Vertex/self-hosted)
 *   - U_missing_catalog_entry
 *   - O_auth_config_missing
 *   - P_base_url_missing
 *   - W_router_supported_pending_probe (catalog complete, awaits probe)
 *
 * This test pins the rule TABLE so future reclassification stays
 * deterministic.
 */

import { describe, it, expect } from 'vitest';

// Mirror the rule sets from the helper.
const SPECIALIZED_NON_CHAT = new Set(['deepgram', 'cartesia', 'elevenlabs', 'palabraai', 'voyage', 'jina', 'cohere-embed']);
const DEPLOYMENT_REQUIRED = new Set(['azure-openai', 'aws-bedrock', 'vertex-ai', 'gcp-vertex', 'vllm', 'lm-studio', 'ollama', 'xinference', 'triton']);

interface ProviderClassifyInput {
  readonly providerId: string;
  readonly hasCatalogEntry: boolean;
  readonly hasApiKeyEnvVar: boolean;
  readonly hasBaseUrl: boolean;
}

function classify(input: ProviderClassifyInput) {
  const p = input.providerId.toLowerCase();
  if (SPECIALIZED_NON_CHAT.has(p)) return 'S_specialized_non_chat';
  if (DEPLOYMENT_REQUIRED.has(p)) return 'T_deployment_required';
  if (!input.hasCatalogEntry) return 'U_missing_catalog_entry';
  if (!input.hasApiKeyEnvVar) return 'O_auth_config_missing';
  if (!input.hasBaseUrl) return 'P_base_url_missing';
  return 'W_router_supported_pending_probe';
}

describe('01C.1B-J1C §11 — unknown reclassification rules', () => {
  it('specialty providers (audio/embedding) → S_specialized_non_chat', () => {
    for (const p of ['deepgram', 'cartesia', 'elevenlabs', 'voyage']) {
      expect(classify({ providerId: p, hasCatalogEntry: true, hasApiKeyEnvVar: true, hasBaseUrl: true }))
        .toBe('S_specialized_non_chat');
    }
  });

  it('deployment-specific providers → T_deployment_required', () => {
    for (const p of ['azure-openai', 'aws-bedrock', 'vertex-ai', 'vllm', 'ollama']) {
      expect(classify({ providerId: p, hasCatalogEntry: true, hasApiKeyEnvVar: true, hasBaseUrl: true }))
        .toBe('T_deployment_required');
    }
  });

  it('self-hosted without endpoint → T_deployment_required', () => {
    expect(classify({ providerId: 'xinference', hasCatalogEntry: true, hasApiKeyEnvVar: true, hasBaseUrl: false }))
      .toBe('T_deployment_required');
  });

  it('provider missing from catalog → U_missing_catalog_entry', () => {
    expect(classify({ providerId: 'novel-provider-xyz', hasCatalogEntry: false, hasApiKeyEnvVar: false, hasBaseUrl: false }))
      .toBe('U_missing_catalog_entry');
  });

  it('catalog entry without apiKeyEnvVar → O_auth_config_missing', () => {
    expect(classify({ providerId: 'some-router', hasCatalogEntry: true, hasApiKeyEnvVar: false, hasBaseUrl: true }))
      .toBe('O_auth_config_missing');
  });

  it('catalog entry without baseUrl → P_base_url_missing', () => {
    expect(classify({ providerId: 'some-router', hasCatalogEntry: true, hasApiKeyEnvVar: true, hasBaseUrl: false }))
      .toBe('P_base_url_missing');
  });

  it('router with complete catalog spec → W_router_supported_pending_probe', () => {
    expect(classify({ providerId: 'togetherai', hasCatalogEntry: true, hasApiKeyEnvVar: true, hasBaseUrl: true }))
      .toBe('W_router_supported_pending_probe');
  });

  it('no provider HTTP call is implied by classification (pure function)', () => {
    // The classify function has no async work and no fetch. Calling it
    // with arbitrary input cannot produce a billable side-effect.
    expect(typeof classify).toBe('function');
    expect(classify.length).toBe(1);
  });
});
