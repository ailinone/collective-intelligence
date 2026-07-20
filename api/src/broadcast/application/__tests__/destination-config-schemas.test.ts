// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for destination-config-schemas — the Zod validator that lives at
 * the INSERT/UPDATE boundary (before an operator config reaches the DB).
 *
 * Coverage focus: URL hardening (scheme + userinfo + localhost guard).
 * These are belt-and-suspenders with the runtime SSRF guard — rejecting at
 * schema time means a misconfigured webhook doesn't silently pile into the
 * DLQ, it fails fast on create.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateDestinationConfig } from '../destination-config-schemas';

describe('validateDestinationConfig — webhook URL hardening', () => {
  const originalAllowHttp = process.env.BROADCAST_ALLOW_HTTP;
  afterEach(() => {
    if (originalAllowHttp === undefined) delete process.env.BROADCAST_ALLOW_HTTP;
    else process.env.BROADCAST_ALLOW_HTTP = originalAllowHttp;
  });

  const validSecret = 'x'.repeat(32);

  it('accepts a well-formed https webhook', () => {
    const r = validateDestinationConfig('webhook', {
      url: 'https://hooks.example.com/receive',
      secret: validSecret,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects http:// when BROADCAST_ALLOW_HTTP is not set', () => {
    delete process.env.BROADCAST_ALLOW_HTTP;
    const r = validateDestinationConfig('webhook', {
      url: 'http://hooks.example.com/receive',
      secret: validSecret,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/);
  });

  it('accepts http:// when BROADCAST_ALLOW_HTTP=true (dev/staging override)', () => {
    process.env.BROADCAST_ALLOW_HTTP = 'true';
    const r = validateDestinationConfig('webhook', {
      url: 'http://hooks.example.com/receive',
      secret: validSecret,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects URLs with embedded credentials', () => {
    const r = validateDestinationConfig('webhook', {
      url: 'https://user:pass@hooks.example.com/receive',
      secret: validSecret,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/credentials/);
  });

  it('rejects localhost / loopback / 0.0.0.0', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']) {
      const r = validateDestinationConfig('webhook', {
        url: `https://${host}/hook`,
        secret: validSecret,
      });
      expect(r.ok, `host ${host} should be rejected`).toBe(false);
    }
  });

  it('rejects non-http(s) schemes (javascript:, file:, gopher:)', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'gopher://evil.example.com/',
      'ftp://files.example.com/x',
    ]) {
      const r = validateDestinationConfig('webhook', {
        url,
        secret: validSecret,
      });
      expect(r.ok, `${url} should be rejected`).toBe(false);
    }
  });
});

describe('validateDestinationConfig — langfuse + otlp share the same URL rules', () => {
  it('langfuse rejects userinfo and loopback', () => {
    const r1 = validateDestinationConfig('langfuse', {
      baseUrl: 'https://creds:sneaky@cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
    });
    expect(r1.ok).toBe(false);

    const r2 = validateDestinationConfig('langfuse', {
      baseUrl: 'https://localhost:3000',
      publicKey: 'pk',
      secretKey: 'sk',
    });
    expect(r2.ok).toBe(false);
  });

  it('otlp rejects a gopher endpoint', () => {
    const r = validateDestinationConfig('otlp_collector', {
      endpoint: 'gopher://collector.example.com/',
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateDestinationConfig — datadog', () => {
  it('accepts a valid config with allowed site', () => {
    const r = validateDestinationConfig('datadog', {
      apiKey: 'x'.repeat(32),
      site: 'datadoghq.com',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects urlOverride that is http (respecting the shared rule)', () => {
    delete process.env.BROADCAST_ALLOW_HTTP;
    const r = validateDestinationConfig('datadog', {
      apiKey: 'x'.repeat(32),
      urlOverride: 'http://intake.example.com/logs',
    });
    expect(r.ok).toBe(false);
  });
});
