// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the network vs provider error classifier. Locks in the
 * mapping that distinguishes "container has no DNS" from "provider
 * returned 401". Both look identical at the `fetch failed` surface.
 */

import { describe, it, expect } from 'vitest';
import { classifyNetworkError } from '../network-error-classifier';

describe('classifyNetworkError — network layer', () => {
  it('ENOTFOUND → network_dns_error (local infra, retryable)', () => {
    const r = classifyNetworkError({ code: 'ENOTFOUND' });
    expect(r.category).toBe('network_dns_error');
    expect(r.isLocalInfra).toBe(true);
    expect(r.isRetryable).toBe(true);
  });

  it('EAI_AGAIN → network_dns_error', () => {
    const r = classifyNetworkError({ code: 'EAI_AGAIN' });
    expect(r.category).toBe('network_dns_error');
  });

  it('ECONNREFUSED → network_connect_error', () => {
    const r = classifyNetworkError({ code: 'ECONNREFUSED' });
    expect(r.category).toBe('network_connect_error');
    expect(r.isLocalInfra).toBe(true);
    expect(r.isRetryable).toBe(true);
  });

  it('ETIMEDOUT → network_connect_error', () => {
    const r = classifyNetworkError({ code: 'ETIMEDOUT' });
    expect(r.category).toBe('network_connect_error');
  });

  it('CERT_HAS_EXPIRED → network_tls_error (not retryable)', () => {
    const r = classifyNetworkError({ code: 'CERT_HAS_EXPIRED' });
    expect(r.category).toBe('network_tls_error');
    expect(r.isLocalInfra).toBe(true);
    expect(r.isRetryable).toBe(false);
  });

  it('SELF_SIGNED_CERT_IN_CHAIN → network_tls_error', () => {
    expect(classifyNetworkError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }).category).toBe('network_tls_error');
  });
});

describe('classifyNetworkError — message fallback (no code)', () => {
  it('"fetch failed" with getaddrinfo message → network_dns_error', () => {
    const r = classifyNetworkError({ message: 'fetch failed: getaddrinfo ENOTFOUND' });
    expect(r.category).toBe('network_dns_error');
  });

  it('"fetch failed" with socket hang up → network_connect_error', () => {
    const r = classifyNetworkError({ message: 'fetch failed (socket hang up)' });
    expect(r.category).toBe('network_connect_error');
  });

  it('certificate-related message → network_tls_error', () => {
    const r = classifyNetworkError({ message: 'certificate verify failed' });
    expect(r.category).toBe('network_tls_error');
  });
});

describe('classifyNetworkError — HTTP status (provider layer)', () => {
  it('401 → provider_auth_error', () => {
    expect(classifyNetworkError({ httpStatus: 401 }).category).toBe('provider_auth_error');
  });

  it('403 without quota hint → provider_auth_error', () => {
    expect(classifyNetworkError({ httpStatus: 403 }).category).toBe('provider_auth_error');
  });

  it('403 with billing body → provider_quota_error', () => {
    const r = classifyNetworkError({ httpStatus: 403, body: '{"error":"insufficient billing balance"}' });
    expect(r.category).toBe('provider_quota_error');
  });

  it('402 → provider_quota_error', () => {
    expect(classifyNetworkError({ httpStatus: 402 }).category).toBe('provider_quota_error');
  });

  it('429 (rate limit) → provider_http_error (retryable)', () => {
    const r = classifyNetworkError({ httpStatus: 429 });
    expect(r.category).toBe('provider_http_error');
    expect(r.isRetryable).toBe(true);
  });

  it('429 with quota body → provider_quota_error', () => {
    const r = classifyNetworkError({ httpStatus: 429, body: '{"error":"quota exceeded"}' });
    expect(r.category).toBe('provider_quota_error');
  });

  it('404 + "model not found" body → provider_model_error', () => {
    const r = classifyNetworkError({ httpStatus: 404, body: '{"error":"model unknown gemini-x"}' });
    expect(r.category).toBe('provider_model_error');
    expect(r.isRetryable).toBe(false);
  });

  it('404 without model hint → provider_http_error', () => {
    const r = classifyNetworkError({ httpStatus: 404, body: 'not found' });
    expect(r.category).toBe('provider_http_error');
  });

  it('500 → provider_http_error (retryable)', () => {
    expect(classifyNetworkError({ httpStatus: 500 }).isRetryable).toBe(true);
  });
});

describe('classifyNetworkError — network code wins over HTTP status', () => {
  it('ENOTFOUND + 401 → network_dns_error (never reached HTTP)', () => {
    // A surprising input but useful guard: if we somehow have both,
    // the network code is the truth — HTTP status is stale.
    const r = classifyNetworkError({ code: 'ENOTFOUND', httpStatus: 401 });
    expect(r.category).toBe('network_dns_error');
  });
});

describe('classifyNetworkError — fallback', () => {
  it('empty input → unknown', () => {
    expect(classifyNetworkError({}).category).toBe('unknown');
  });
});
