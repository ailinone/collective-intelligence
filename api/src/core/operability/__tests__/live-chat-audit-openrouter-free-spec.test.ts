// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §8 — Live-chat audit support for OpenRouter `:free` models.
 *
 * Pins:
 *   - OpenRouter is now in `PROVIDER_SPECS` (no more
 *     `no_provider_spec_in_audit_script` for `openrouter::...`).
 *   - Model ids with `:free` suffix are passed verbatim (no
 *     normalization that strips the suffix).
 *   - Auth scheme is `Authorization: Bearer ${OPENROUTER_API_KEY}`,
 *     with the optional `HTTP-Referer` + `X-Title` headers set to
 *     non-secret defaults.
 *   - The header builder NEVER prints the secret value (it returns the
 *     header map; the test only inspects key shape).
 *
 * No provider HTTP calls (the spec is a pure-function registry — the
 * actual HTTP probe is in `probeRoute`, exercised separately and only
 * via the billable J1B/K stages).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const auditScriptSource = fs.readFileSync(
  path.resolve(__dirname, '../scripts/run-live-chat-operability-audit.ts'),
  'utf8',
);

describe('01C.1B-J1C §8 — OpenRouter audit spec', () => {
  it('PROVIDER_SPECS map includes an `openrouter` entry', () => {
    // The map key is `openrouter:` followed by an open brace.
    expect(auditScriptSource).toMatch(/openrouter:\s*\{/);
  });

  it('endpoint targets openrouter.ai /api/v1/chat/completions', () => {
    expect(auditScriptSource).toMatch(/openrouter\.ai\/api\/v1\/chat\/completions/);
  });

  it('envVar is OPENROUTER_API_KEY (matches runtime adapter)', () => {
    expect(auditScriptSource).toMatch(/envVar:\s*'OPENROUTER_API_KEY'/);
  });

  it('auth header shape is Authorization Bearer (no inline secret literal)', () => {
    // Match `Authorization: \`Bearer ${k}\`` — the secret is interpolated,
    // never logged as a literal string.
    expect(auditScriptSource).toMatch(/Authorization:\s*`Bearer \$\{k\}`/);
    // Negative: NO literal secret-looking value
    expect(auditScriptSource).not.toMatch(/Authorization:\s*'Bearer sk-/);
  });

  it('optional HTTP-Referer and X-Title headers are set without leaking secrets', () => {
    expect(auditScriptSource).toMatch(/'HTTP-Referer':/);
    expect(auditScriptSource).toMatch(/'X-Title':/);
  });

  it('no normalizeModelId stripping ":free" suffix (preserved verbatim)', () => {
    // Look for the openrouter block and confirm no `normalizeModelId`
    // that contains `.replace(/:free/`, etc. The COMMENT may mention
    // `:free` to document the intent — the FUNCTION body must not
    // strip it.
    const block = auditScriptSource.match(/openrouter:\s*\{[\s\S]*?\},?\s*(?='fireworks-ai'|\}\s*;)/);
    expect(block).not.toBeNull();
    if (block) {
      expect(block[0]).not.toMatch(/normalizeModelId/);
      // No code that strips `:free` (matches `replace(... :free ...)` or `slice(':free')`):
      expect(block[0]).not.toMatch(/replace\([^)]*:free/);
      expect(block[0]).not.toMatch(/slice\([^)]*:free/);
    }
  });

  it('specForRoute returns a defined ProbeRouteSpec for openrouter (simulated)', async () => {
    // The script is a CLI; we don't import it directly here (it would
    // trigger Prisma init). Instead, we verify the source pattern
    // matches what `specForRoute` consumes.
    //
    // `specForRoute(providerId, modelId)` returns undefined when the
    // provider is absent from PROVIDER_SPECS. By verifying the entry
    // exists, we prove openrouter routes will no longer hit the
    // `unauditableExtracted` path.
    expect(auditScriptSource).toContain('PROVIDER_SPECS[providerId.toLowerCase()]');
    expect(auditScriptSource).toMatch(/openrouter:\s*\{/);
  });
});
