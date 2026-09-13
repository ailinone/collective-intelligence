// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `providers:revalidate` — dimension-classification contract (LOTE AK, 2026-09-04).
 *
 * The revalidation driver used to reduce every provider to one traffic light
 * derived from a single question: "did /models return ≥1 model?". That
 * conflated five independent failure modes and produced two systematic lies:
 *
 *   1. `execution-only` rows have NO listing endpoint BY DESIGN, so they
 *      scored a permanent red no matter how healthy they were — burying the
 *      real reds in noise.
 *   2. A provider with an expired key, a zero balance, an exhausted quota or
 *      a 5xx execution path still scored green as long as discovery answered.
 *
 * These tests pin the corrected semantics. They exercise the classifier
 * directly (the script guards `main()` behind an invoked-directly check, so
 * importing it never triggers a live probe).
 */

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain-ESM operator module, intentionally untyped and
// free of project imports so the driver around it can run against a deployed
// API with no build step. Imported from the SHEBANG-FREE half of the script:
// importing the driver itself breaks on a Windows checkout, where
// core.autocrlf turns `#!/usr/bin/env node` into a CRLF line the loader
// rejects with "SyntaxError: Invalid or unexpected token".
import {
  classifyProvider,
  rollUp,
  csvStatus,
} from '../../../../scripts/revalidate-providers-classify.mjs';

const available = (over: Record<string, unknown> = {}) => ({
  providerId: 'p',
  status: 'available',
  modelCount: 12,
  // `partially_verified` = an AUTHENTICATED listing actually succeeded. That
  // is the only discovery-side evidence about the key; see the credential
  // tests below for why a bare 200 is not.
  discoveryConfidence: 'partially_verified',
  ...over,
});

describe('revalidate classifier — discovery is not the whole story', () => {
  it('scores a healthy discovery+execution provider usable', () => {
    const d = classifyProvider(available(), [], 'discovery+execution');
    expect(d.discovery).toBe('ok');
    expect(d.credential).toBe('ok');
    expect(d.verdict).toBe('usable');
    expect(csvStatus(d)).toBe('green');
  });

  it('does NOT score a provider green when discovery answered but the key is rejected', () => {
    // The exact regression the old single-signal logic produced: /models
    // answered, so it said green, while auth_failed means no call can work.
    const d = classifyProvider(
      available({ errorClass: 'auth_failed' }),
      [],
      'discovery+execution'
    );
    expect(d.credential).toBe('invalid');
    expect(d.verdict).toBe('unusable-credential');
    expect(csvStatus(d)).toBe('red');
  });

  it('separates a billing block from a credential block', () => {
    const credit = classifyProvider(
      available({ errorClass: 'insufficient_credit' }),
      [],
      'discovery+execution'
    );
    expect(credit.billing).toBe('exhausted');
    expect(credit.credential).not.toBe('invalid');
    expect(credit.verdict).toBe('unusable-billing');

    const quota = classifyProvider(
      available({ errorClass: 'quota_exceeded' }),
      [],
      'discovery+execution'
    );
    expect(quota.billing).toBe('quota-exceeded');
    expect(quota.verdict).toBe('unusable-billing');
  });

  it('reports rate limiting as degraded, not dead', () => {
    const d = classifyProvider(
      available({ errorClass: 'rate_limited' }),
      [],
      'discovery+execution'
    );
    expect(d.upstream).toBe('rate-limited');
    expect(d.verdict).toBe('degraded-rate-limited');
    expect(csvStatus(d)).toBe('amber');
  });

  it('attributes vendor 5xx/timeout to upstream, never to our credentials', () => {
    for (const [errorClass, expected] of [
      ['provider_5xx', 'erroring'],
      ['provider_timeout', 'timeout'],
    ] as const) {
      const d = classifyProvider(
        { providerId: 'p', status: 'unavailable', modelCount: 0, errorClass },
        [],
        'discovery+execution'
      );
      expect(d.upstream).toBe(expected);
      expect(d.credential).toBe('unknown');
      expect(d.verdict).toBe('unusable-upstream');
    }
  });

  it('refuses to call the credential OK from a 200 that proves nothing about the key', () => {
    // The atlascloud/avian case: those hosts serve /v1/models PUBLICLY — they
    // answer 200 with no Authorization header at all. Reading that 200 as
    // "the key works" would mint precisely the false green this rewrite
    // exists to remove. `inferred` means the env var is merely present.
    const d = classifyProvider(
      available({ discoveryConfidence: 'inferred' }),
      [],
      'discovery+execution'
    );
    expect(d.credential).toBe('present-unverified');
    expect(d.credential).not.toBe('ok');
  });

  it('does not read silence as a funded account', () => {
    // Only a passing credit probe (confidence `verified`) says anything about
    // balance. A listing that succeeded says nothing about spend.
    const partial = classifyProvider(available(), [], 'discovery+execution');
    expect(partial.billing).toBe('unknown');

    const verified = classifyProvider(
      available({ discoveryConfidence: 'verified' }),
      [],
      'discovery+execution'
    );
    expect(verified.billing).toBe('ok');
  });

  it('separates a missing key from a rejected one', () => {
    // Both arrive as errorClass auth_failed, but they are different jobs:
    // provision a secret vs rotate one.
    const missing = classifyProvider(
      {
        providerId: 'p',
        status: 'unavailable',
        modelCount: 0,
        errorClass: 'auth_failed',
        reason: 'missing env var: SOMETHING_API_KEY',
      },
      [],
      'discovery+execution'
    );
    expect(missing.credential).toBe('missing');
    expect(missing.verdict).toBe('unusable-credential-missing');

    const rejected = classifyProvider(
      {
        providerId: 'p',
        status: 'unavailable',
        modelCount: 0,
        errorClass: 'auth_failed',
        reason: 'credential probe failed: 401',
      },
      [],
      'discovery+execution'
    );
    expect(rejected.credential).toBe('invalid');
    expect(rejected.verdict).toBe('unusable-credential');
  });

  it('leaves unrecognised error classes as unknown rather than guessing a cause', () => {
    const d = classifyProvider(
      { providerId: 'p', status: 'unavailable', modelCount: 0, errorClass: 'unknown_error' },
      [],
      'discovery+execution'
    );
    expect(d.credential).toBe('unknown');
    expect(d.billing).toBe('unknown');
    expect(d.discovery).toBe('failed');
  });
});

describe('revalidate classifier — execution-only rows are not scored on discovery', () => {
  it('marks discovery not-applicable for execution-only and refuses to call it red', () => {
    const d = classifyProvider(
      { providerId: 'aws-bedrock', status: 'unavailable', modelCount: 0 },
      [],
      'execution-only'
    );
    expect(d.discovery).toBe('not-applicable');
    expect(d.verdict).toBe('unproven');
    expect(csvStatus(d)).toBe('amber');
  });

  it('does the same for catalog-only rows', () => {
    const d = classifyProvider(
      { providerId: 'relace', status: 'unavailable', modelCount: 0 },
      [],
      'catalog-only'
    );
    expect(d.discovery).toBe('not-applicable');
  });

  it('promotes an execution-only row to usable on real execution evidence', () => {
    // This is the only path to green for a row with no listing endpoint:
    // the health registry saw a real call succeed.
    const d = classifyProvider(
      { providerId: 'aws-bedrock', status: 'unavailable', modelCount: 0 },
      [{ providerId: 'aws-bedrock', lastSuccessAt: '2026-09-04T00:00:00Z', consecutiveSuccesses: 3 }],
      'execution-only'
    );
    expect(d.execution).toBe('ok');
    expect(d.verdict).toBe('usable');
  });

  it('flags an execution-only row whose every recorded call is failing', () => {
    const d = classifyProvider(
      { providerId: 'writer-ish', status: 'available', modelCount: 0 },
      [{ providerId: 'writer-ish', consecutiveFailures: 4 }],
      'execution-only'
    );
    expect(d.execution).toBe('failing');
    expect(d.verdict).toBe('unusable-execution');
  });
});

describe('revalidate classifier — discovery that answers with nothing', () => {
  it('distinguishes "responded with zero models" from "failed"', () => {
    const empty = classifyProvider(available({ modelCount: 0 }), [], 'discovery+execution');
    expect(empty.discovery).toBe('empty');
    expect(empty.verdict).toBe('degraded-no-inventory');

    const failed = classifyProvider(
      { providerId: 'p', status: 'unavailable', modelCount: 0 },
      [],
      'discovery+execution'
    );
    expect(failed.discovery).toBe('failed');
    expect(failed.verdict).toBe('unusable-discovery');
  });
});

describe('revalidate roll-up ordering', () => {
  it('reports the cause with the clearest operator action first', () => {
    // Credential beats billing beats upstream: rotating a dead key is
    // pointless if the account is also empty, but the key is what blocks
    // every single call, so it is what the operator must fix first.
    expect(
      rollUp({
        discovery: 'ok',
        credential: 'invalid',
        billing: 'exhausted',
        upstream: 'erroring',
        execution: 'failing',
      })
    ).toBe('unusable-credential');
  });

  it('never emits green from a dimension that does not apply', () => {
    expect(
      rollUp({
        discovery: 'not-applicable',
        credential: 'unknown',
        billing: 'unknown',
        upstream: 'unknown',
        execution: 'unknown',
      })
    ).toBe('unproven');
  });
});
