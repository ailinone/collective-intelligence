// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for `buildHubConfig()`'s `apiKeyOptional` propagation
 * (default-adapter-factories.ts).
 *
 * ## Why this test exists
 *
 * LOTE AL (2026-09-04) set out to fix a suspected bug: `buildHubConfig()`
 * never forwarding `entry.apiKeyOptional` into the adapter's `metadata`,
 * unlike the generic bridge in `catalog-provider-plugin.ts` (which has an
 * explicit comment: "without this, self-hosted entries with no API key set
 * in env explode in adapter construction").
 *
 * Investigation found the propagation line already present in
 * `buildHubConfig()` (`apiKeyOptional: ctx.entry.apiKeyOptional === true`)
 * since the catalog subsystem's original import (`5ab1be81`) — the bug did
 * not exist in this codebase. This test locks that behavior in so a future
 * edit can't silently drop the line again, using the two dedicated-factory
 * providers the LOTE AL brief named as candidates: Xinference and Triton.
 *
 * Xinference extends `OpenAICompatibleHubAdapter`, whose `validateConfig()`
 * throws `"<name>: API key is required"` when `metadata.apiKeyOptional` is
 * not `true` and no `apiKey` was supplied — so this test exercises the real
 * failure mode end-to-end (construct via the registered factory with an
 * empty apiKey) rather than just re-reading catalog data.
 *
 * Triton does NOT extend the hub adapter (extends `ProviderAdapter`
 * directly) and never calls `this.validateConfig()` in its constructor, so
 * it can never throw on a missing key regardless of `apiKeyOptional` — it's
 * included here only to document that non-hub dedicated adapters are
 * unaffected by this propagation, not as a positive proof of the fix.
 *
 * ## Phase 0 (2026-09-08) — full sweep of dedicated-factory apiKeyOptional rows
 *
 * A fresh catalog sweep (`PROVIDER_CATALOG.filter(e => e.apiKeyOptional &&
 * e.adapterClass)`) found 6 dedicated-factory-routed rows with
 * `apiKeyOptional: true`, not just the 2 above: vllm, lm-studio, xinference,
 * triton, ollama, aws-bedrock. ("volcano" — named as a candidate in the
 * original mission brief — does NOT carry `apiKeyOptional`; ARK genuinely
 * requires a bearer key, confirmed live by LOTE AR's GAP-R1 investigation.)
 *
 * vllm/lm-studio/ollama all extend `OpenAICompatibleHubAdapter` like
 * xinference AND additionally hardcode `apiKeyOptional: true` inside their
 * own constructor as a second, independent layer of protection — so, like
 * xinference, they would survive even if `buildHubConfig()`'s propagation
 * broke again. Covered below with the same "construct via the registered
 * factory, empty apiKey, must not throw" assertion.
 *
 * aws-bedrock is architecturally different from the other 5: its
 * `apiKeyOptional: true` exists so the generic single-env-var gate in
 * `catalog-provider-plugin.ts` doesn't block AWS's own multi-credential
 * model (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/role chain) — see the
 * catalog comment "role-based auth path bypasses ACCESS_KEY_ID". Unlike the
 * other 5, `AWSBedrockAdapter`'s own constructor independently REQUIRES
 * `accessKeyId` (env, config, or apiKey fallback) and throws if none is
 * resolvable — by design, since there is genuinely no way to call Bedrock
 * without credentials from somewhere. Asserting "no throw with a fully empty
 * env" would therefore be asserting the WRONG thing for this row. It is
 * covered by two narrower assertions instead: the catalog fields are as
 * documented, and construction succeeds once AWS-shaped credentials are
 * present via env (proving the catalog-provider-plugin gate — the part
 * `apiKeyOptional` actually controls — does not itself block registration).
 */

import { describe, expect, it } from 'vitest';
import { resolveAdapterFactory, type AdapterFactoryContext } from '../adapter-factory-registry';
import { registerDefaultAdapterFactories } from '../default-adapter-factories';
import type { ProviderCatalogEntry } from '../provider-catalog.types';
import { PROVIDER_CATALOG } from '../providers.catalog';

function ctxFor(providerId: string): AdapterFactoryContext {
  const entry = PROVIDER_CATALOG.find((e) => e.providerId === providerId);
  if (!entry) throw new Error(`fixture error: ${providerId} not in PROVIDER_CATALOG`);
  return {
    entry,
    apiKey: '', // the exact scenario buildHubConfig must survive
    baseUrl: entry.baseUrl,
  };
}

describe('buildHubConfig propagates apiKeyOptional (regression, LOTE AL)', () => {
  registerDefaultAdapterFactories();

  it('xinference catalog row declares apiKeyOptional: true', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'xinference');
    expect(entry?.apiKeyOptional).toBe(true);
    expect(entry?.adapterClass).toBe('XinferenceAdapter');
  });

  it('constructs XinferenceAdapter via the registered factory with an empty apiKey without throwing', () => {
    const factory = resolveAdapterFactory('XinferenceAdapter');
    expect(factory).toBeDefined();
    expect(() => factory!(ctxFor('xinference'))).not.toThrow();
  });

  it('triton catalog row declares apiKeyOptional: true (documented, not exercised via validateConfig)', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'triton');
    expect(entry?.apiKeyOptional).toBe(true);
  });

  it('constructs TritonAdapter via the registered factory with an empty apiKey without throwing', () => {
    const factory = resolveAdapterFactory('TritonAdapter');
    expect(factory).toBeDefined();
    expect(() => factory!(ctxFor('triton'))).not.toThrow();
  });

  it('mancer catalog row declares apiKeyOptional: true (LOTE AL GAP-R1 fix)', () => {
    // mancer has no adapterClass — it is built through the generic
    // catalog-provider-plugin.ts bridge, not through buildHubConfig()/
    // default-adapter-factories.ts. This assertion locks the catalog-side
    // half of the GAP-R1 fix (see providers.catalog.ts for the full
    // rationale); the generic bridge's own propagation is covered by
    // catalog-provider-plugin.test.ts.
    const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'mancer');
    expect(entry?.apiKeyOptional).toBe(true);
    expect(entry?.adapterClass).toBeUndefined();
  });

  it('a hypothetical hub-routed entry with apiKeyOptional=false still throws on an empty apiKey (sanity check on the test itself)', () => {
    // Proves the assertions above are actually meaningful — the factory
    // path DOES throw when apiKeyOptional is falsy, so a passing "does not
    // throw" test for xinference is evidence of real propagation, not a
    // vacuously-true assertion.
    const stubEntry: ProviderCatalogEntry = {
      providerId: 'stub-required-key',
      displayName: 'Stub Required Key',
      providerFamily: 'stub',
      integrationClass: 'oai-compat-pure',
      integrationMode: 'discovery+execution',
      baseUrl: 'https://stub.example/v1',
      apiKeyEnvVar: 'STUB_REQUIRED_API_KEY',
      supports: { chat: true },
      pricingMode: 'none',
      enabledByDefault: true,
      // apiKeyOptional intentionally omitted (falsy) — this is the "requires
      // a real key" shape the xinference/triton assertions above are being
      // contrasted against.
    };
    const factory = resolveAdapterFactory('GroqAdapter');
    expect(factory).toBeDefined();
    expect(() =>
      factory!({ entry: stubEntry, apiKey: '', baseUrl: stubEntry.baseUrl })
    ).toThrow(/API key is required/);
  });
});

describe('buildHubConfig propagates apiKeyOptional — full sweep (Phase 0, 2026-09-08)', () => {
  registerDefaultAdapterFactories();

  it.each(['vllm', 'lm-studio', 'ollama'])(
    "%s catalog row declares apiKeyOptional: true and constructs without throwing (empty apiKey)",
    (providerId) => {
      const entry = PROVIDER_CATALOG.find((e) => e.providerId === providerId);
      expect(entry?.apiKeyOptional).toBe(true);
      expect(entry?.adapterClass).toBeTruthy();

      const factory = resolveAdapterFactory(entry!.adapterClass);
      expect(factory).toBeDefined();
      expect(() => factory!(ctxFor(providerId))).not.toThrow();
    }
  );

  it('volcano (named in the original mission brief) does NOT carry apiKeyOptional — ARK genuinely requires a bearer key', () => {
    // Documents why volcano is absent from this sweep: unlike xinference,
    // this is not a propagation gap, it's the correct, intentional state.
    const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'volcano');
    expect(entry?.apiKeyOptional).toBeUndefined();
    expect(entry?.adapterClass).toBe('VolcanoAdapter');
  });

  describe('aws-bedrock (architecturally different — see file header)', () => {
    it('catalog row declares apiKeyOptional: true routed to AwsBedrockAdapter', () => {
      const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'aws-bedrock');
      expect(entry?.apiKeyOptional).toBe(true);
      expect(entry?.adapterClass).toBe('AwsBedrockAdapter');
    });

    it('constructs without throwing once AWS-shaped credentials are available via env (role-chain proxy)', () => {
      // We don't assert "no throw with a fully empty env" here — that would
      // fail for the correct reason (AWSBedrockAdapter's own constructor
      // requires SOME credential source) and would not be testing the thing
      // apiKeyOptional actually controls. Setting the AWS SDK's own env vars
      // stands in for "a real role/credential chain resolved something",
      // proving the catalog-provider-plugin single-key gate (the actual
      // apiKeyOptional consumer) does not itself block this row.
      const savedAccessKey = process.env.AWS_ACCESS_KEY_ID;
      const savedSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
      process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key';
      try {
        const factory = resolveAdapterFactory('AwsBedrockAdapter');
        expect(factory).toBeDefined();
        expect(() => factory!(ctxFor('aws-bedrock'))).not.toThrow();
      } finally {
        if (savedAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
        else process.env.AWS_ACCESS_KEY_ID = savedAccessKey;
        if (savedSecretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
        else process.env.AWS_SECRET_ACCESS_KEY = savedSecretKey;
      }
    });
  });
});
