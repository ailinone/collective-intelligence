// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider re-validation — dimension classifier (LOTE AK, 2026-09-04).
 *
 * Pure, I/O-free scoring logic, split out of `revalidate-providers.mjs` for
 * two reasons:
 *
 *   1. It is the part worth testing. The driver is fetch + report plumbing;
 *      the judgement lives here, so it gets a contract test
 *      (`revalidate-providers-classification.test.ts`) while the driver stays
 *      a thin shell.
 *   2. The driver carries a `#!` shebang. On a Windows checkout with
 *      `core.autocrlf=true` that line becomes `#!/usr/bin/env node\r\n`, and
 *      importing the file from a test then dies with
 *      "SyntaxError: Invalid or unexpected token" — the exact hazard
 *      `.gitattributes` already documents for `*.sh` and `*.csv`. A module
 *      with no shebang cannot hit it at all. (`*.mjs text eol=lf` was added
 *      alongside this split so the driver itself stays LF too; belt and
 *      braces, because a checked-out CRLF file is not fixed by the rule
 *      until it is renormalised.)
 *
 * ── Why five dimensions and not one traffic light ────────────────────────
 *
 * The original driver collapsed every provider to one status derived from a
 * single question: "did /models return >=1 model?". That conflates at least
 * five independent failure modes and gets two of them backwards:
 *
 *   - An `execution-only` catalog row has NO /models endpoint BY DESIGN
 *     (azure-openai, aws-bedrock, voyage, and every row declaring
 *     `discoveryStatus: 'unavailable-upstream'`). Scoring it on discovery
 *     manufactured a permanent red for a provider that may be perfectly
 *     healthy — and buried the real reds in that noise.
 *   - A provider whose discovery answers fine can still be unusable: expired
 *     key, zero balance, exhausted quota, or 5xx on the execution path.
 *     "/models returned something" said green to all four.
 *
 * So each provider is scored on five INDEPENDENT dimensions, each with its
 * own `not-applicable` state, and the roll-up verdict is DERIVED from them
 * rather than replacing them:
 *
 *   discovery    can we enumerate this provider's inventory?
 *   credential   does the key authenticate?
 *   billing      is there balance/quota to actually spend?
 *   upstream     is the vendor reachable and not rate-limiting us?
 *   execution    has a real call to this provider succeeded recently?
 *
 * The first four read the control plane's existing `ProviderErrorClass`
 * taxonomy and `DiscoveryConfidence`; the fifth reads the
 * `ProviderHealthRegistry`. No new probing system is introduced — this only
 * interprets what the operability plane already measures.
 */

/**
 * Which `ProviderErrorClass` values are evidence about which dimension.
 * Anything not listed here stays `unknown`: an unclassified error must never
 * be silently read as a credential or billing problem, because those two
 * drive very different operator actions (rotate a key vs. top up an account).
 */
export const ERROR_CLASS_DIMENSION = {
  auth_failed: ['credential', 'invalid'],
  insufficient_credit: ['billing', 'exhausted'],
  quota_exceeded: ['billing', 'quota-exceeded'],
  rate_limited: ['upstream', 'rate-limited'],
  provider_5xx: ['upstream', 'erroring'],
  provider_timeout: ['upstream', 'timeout'],
  endpoint_not_found: ['discovery', 'endpoint-missing'],
  malformed_response: ['discovery', 'unparseable'],
  model_not_found: ['execution', 'model-missing'],
  adapter_error: ['execution', 'adapter-error'],
  streaming_broken: ['execution', 'streaming-broken'],
};

/**
 * Score one provider across the five dimensions.
 *
 * @param discovery  one entry from GET /v1/admin/operability/discovery
 * @param healthRecords  records from GET /v1/admin/operability/health for
 *                       this providerId (may be empty)
 * @param integrationMode  catalog mode from the CSV snapshot; decides whether
 *                       the discovery dimension applies at all
 */
export function classifyProvider(discovery, healthRecords = [], integrationMode = '') {
  const dims = {
    discovery: 'unknown',
    credential: 'unknown',
    billing: 'unknown',
    upstream: 'unknown',
    execution: 'unknown',
  };

  // Rows that deliberately have no listing endpoint are not "failing
  // discovery" — the dimension does not apply to them.
  const discoveryApplies =
    integrationMode !== 'execution-only' && integrationMode !== 'catalog-only';
  if (!discoveryApplies) dims.discovery = 'not-applicable';

  if (discovery) {
    const modelCount = discovery.modelCount ?? 0;
    // `discoveryConfidence` records WHICH probes actually ran, and is the only
    // thing standing between an honest credential verdict and the same
    // false-green this rewrite exists to remove:
    //   'unknown'            credential env var absent
    //   'inferred'           env var present, nothing authenticated succeeded
    //   'partially_verified' env var present + an authenticated listing (or
    //                        credit probe) succeeded
    //   'verified'           the above plus a passing credit probe
    // A bare `status === 'available'` proves NOTHING about the key: several
    // vendors serve /models publicly (atlascloud and avian answer 200 with no
    // Authorization header at all), so reading a 200 as credential evidence
    // would mint exactly the kind of green this rewrite removes.
    const conf = discovery.discoveryConfidence;
    const authenticatedCallSucceeded = conf === 'verified' || conf === 'partially_verified';

    if (discovery.status === 'available') {
      dims.upstream = 'ok'; // we reached the vendor
      dims.credential = authenticatedCallSucceeded ? 'ok' : 'present-unverified';
      // Only a passing credit probe says anything about balance. Silence is
      // not "funded".
      if (conf === 'verified') dims.billing = 'ok';
      if (discoveryApplies) dims.discovery = modelCount > 0 ? 'ok' : 'empty';
    } else if (discoveryApplies) {
      dims.discovery = 'failed';
    }

    const mapped = ERROR_CLASS_DIMENSION[discovery.errorClass];
    if (mapped) {
      const [dim, value] = mapped;
      // An error class is stronger evidence than the coarse status flag:
      // a provider can answer `available` on discovery and still be
      // rate-limited or out of credit on the execution path.
      if (dim !== 'discovery' || discoveryApplies) dims[dim] = value;
      // auth_failed also tells us the vendor was reachable enough to reject
      // us, which is real upstream evidence.
      if (dim === 'credential' || dim === 'billing') {
        if (dims.upstream === 'unknown') dims.upstream = 'ok';
      }
    }

    // "No key provisioned" and "the key was rejected" both arrive as
    // errorClass `auth_failed`, but they are different jobs for the operator:
    // provision a secret vs rotate one. Discovery already distinguishes them
    // in `reason`, so don't throw that away.
    const reasonText = String(discovery.reason ?? '').toLowerCase();
    if (discovery.errorClass === 'auth_failed' && reasonText.includes('missing env var')) {
      dims.credential = 'missing';
    }
  }

  // Execution evidence: the health registry records real call outcomes per
  // (provider, model). Any recent success is proof the execution path works,
  // which no amount of /models probing can establish.
  if (healthRecords.length > 0) {
    const anySuccess = healthRecords.some(
      (r) => r.lastSuccessAt || (r.consecutiveSuccesses ?? 0) > 0
    );
    const allFailing = healthRecords.every((r) => (r.consecutiveFailures ?? 0) > 0);
    if (anySuccess) {
      dims.execution = 'ok';
      dims.credential = 'ok';
      dims.upstream = 'ok';
    } else if (allFailing) {
      dims.execution = 'failing';
    }
  }

  return { ...dims, verdict: rollUp(dims) };
}

/**
 * Roll the five dimensions into one operator-facing verdict.
 *
 * Deliberately NOT a re-derivation of "green if /models answered": a provider
 * is only `usable` when nothing known blocks a real call. Each `unusable-*`
 * names a cause with a distinct operator action, so the report can be triaged
 * by cause rather than by provider name.
 */
export function rollUp(d) {
  // Missing before invalid: they are different jobs (provision vs rotate), and
  // a provider with no key at all is not evidence of a bad key.
  if (d.credential === 'missing') return 'unusable-credential-missing';
  if (d.credential === 'invalid') return 'unusable-credential';
  if (d.billing === 'exhausted' || d.billing === 'quota-exceeded') return 'unusable-billing';
  if (d.upstream === 'erroring' || d.upstream === 'timeout') return 'unusable-upstream';
  if (d.upstream === 'rate-limited') return 'degraded-rate-limited';
  if (d.execution === 'failing') return 'unusable-execution';
  if (d.discovery === 'failed') return 'unusable-discovery';
  if (d.discovery === 'empty') return 'degraded-no-inventory';
  if (d.discovery === 'ok' || d.execution === 'ok' || d.discovery === 'not-applicable') {
    // An execution-only row with no execution evidence yet is not provably
    // usable — say so rather than inheriting a green from a dimension that
    // does not apply to it.
    if (d.discovery === 'not-applicable' && d.execution !== 'ok') return 'unproven';
    return 'usable';
  }
  return 'unproven';
}

/**
 * Legacy CSV traffic light, kept so the committed snapshot column stays
 * comparable across runs. Derived FROM the dimensions, never instead of them.
 */
export function csvStatus(dims) {
  switch (dims.verdict) {
    case 'usable':
      return 'green';
    case 'degraded-rate-limited':
    case 'degraded-no-inventory':
    case 'unproven':
      return 'amber';
    default:
      return 'red';
  }
}
