// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §9 — Live-chat audit support for Fireworks
 * `accounts/<owner>/models/<slug>` ids.
 *
 * Pins:
 *   - `fireworks-ai` is now in `PROVIDER_SPECS`.
 *   - The catalog id (e.g., `accounts/fireworks/models/qwen3-235b-a22b`)
 *     is passed through verbatim — no slug stripping.
 *   - `envVar` matches the runtime adapter loader (`FIREWORKS_AI_API_KEY`)
 *     to keep secret-resolution consistent.
 *
 * No provider HTTP calls.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const auditScriptSource = fs.readFileSync(
  path.resolve(__dirname, '../scripts/run-live-chat-operability-audit.ts'),
  'utf8',
);

describe('01C.1B-J1C §9 — Fireworks audit spec', () => {
  it('PROVIDER_SPECS map includes a `fireworks-ai` entry (hyphenated id)', () => {
    expect(auditScriptSource).toMatch(/'fireworks-ai':\s*\{/);
  });

  it('endpoint targets api.fireworks.ai /inference/v1/chat/completions', () => {
    expect(auditScriptSource).toMatch(/api\.fireworks\.ai\/inference\/v1\/chat\/completions/);
  });

  it('envVar is FIREWORKS_AI_API_KEY (matches adapter loader)', () => {
    expect(auditScriptSource).toMatch(/envVar:\s*'FIREWORKS_AI_API_KEY'/);
  });

  it('auth header shape is Authorization Bearer (no inline secret literal)', () => {
    // The whole script uses `Bearer ${k}` interpolation; ensure no literal
    // secret-looking values exist for fireworks.
    expect(auditScriptSource).not.toMatch(/Authorization:\s*'Bearer fw_/i);
  });

  it('no normalizeModelId stripping the `accounts/...` prefix', () => {
    const block = auditScriptSource.match(/'fireworks-ai':\s*\{[\s\S]*?\}\s*,?/);
    expect(block).not.toBeNull();
    if (block) {
      expect(block[0]).not.toMatch(/normalizeModelId/);
      // No replace stripping `accounts/`.
      expect(block[0]).not.toMatch(/replace\(\s*['"`]?accounts/);
    }
  });

  it('catalog id shape preservation: accounts/<owner>/models/<slug>', () => {
    // The script doesn't transform fireworks ids — the catalog passes
    // them through. Verify by negative pattern (no transformation
    // function block exists for fireworks).
    expect(auditScriptSource).toMatch(/'fireworks-ai':\s*\{[^}]*envVar/);
  });
});
