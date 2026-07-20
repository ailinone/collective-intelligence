// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1C §10 — Provider auth / base-URL spec review.
 *
 * For each provider that J1B reported as auth/base-url mismatched,
 * assert the CATALOG entry is structurally complete:
 *   - baseUrl is present
 *   - apiKeyEnvVar is present
 *   - authScheme is present
 *
 * The J1B runtime failure for these providers is operator-bound
 * (secret value, base-url reachability), NOT a config gap — these
 * tests pin that distinction.
 *
 * No provider HTTP calls; no secrets printed.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const catalogSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../providers/catalog/providers.catalog.ts'),
  'utf8',
);

function getProviderBlock(providerId: string): string | null {
  const startMarker = `providerId: '${providerId}'`;
  const start = catalogSrc.indexOf(startMarker);
  if (start === -1) return null;
  const next = catalogSrc.indexOf('providerId:', start + startMarker.length);
  return next === -1 ? catalogSrc.slice(start) : catalogSrc.slice(start, next);
}

function extract(block: string, key: string): string | null {
  const m = block.match(new RegExp(`${key}:\\s*'([^']+)'`));
  return m ? m[1] : null;
}

const MISMATCHED_J1B_PROVIDERS = [
  'hyperbolic',
  'xiaomi-mimo',
  'friendli',
  'aihubmix',
  'novita',
  'cometapi',
  'phala',
];

describe('01C.1B-J1C §10 — auth/base-URL mismatch review', () => {
  for (const providerId of MISMATCHED_J1B_PROVIDERS) {
    describe(`provider: ${providerId}`, () => {
      const block = getProviderBlock(providerId);

      it('has a catalog entry', () => {
        expect(block).not.toBeNull();
      });

      it('catalog defines `baseUrl`', () => {
        expect(block).not.toBeNull();
        if (block) expect(extract(block, 'baseUrl')).toMatch(/^https?:\/\//);
      });

      it('catalog defines `apiKeyEnvVar`', () => {
        expect(block).not.toBeNull();
        if (block) expect(extract(block, 'apiKeyEnvVar')).toMatch(/_API_KEY$|_TOKEN$/);
      });

      it('catalog defines `authScheme`', () => {
        expect(block).not.toBeNull();
        if (block) {
          const scheme = extract(block, 'authScheme');
          expect(scheme).not.toBeNull();
          expect(['bearer', 'api-key-header', 'header', 'query', 'oauth2']).toContain(scheme);
        }
      });

      it('catalog does NOT leak any secret-looking value', () => {
        expect(block).not.toBeNull();
        if (block) {
          // Common secret patterns. The catalog is checked into git;
          // it must NEVER contain literal secret values.
          expect(block).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
          expect(block).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
          expect(block).not.toMatch(/BEGIN PRIVATE KEY/);
        }
      });
    });
  }
});
