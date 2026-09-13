// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AL (2026-09-05) — reopened false-NPI classifications, round 2.
 *
 * Ambient, AMD, AnyAPI and Bailing were previously classified
 * NOT_PROGRAMMATICALLY_INTEGRABLE (LOTE AJ) on evidence that turned out to
 * describe the wrong company/domain for each. This suite locks in the
 * reopened rows' contract: catalog shape, secret wiring, and — since none
 * of these declare an `adapterClass` — resolution via the generic
 * OAI-compat bridge (`isOpenAICompatibleEntry`), mirroring the pattern
 * already used for the LOTE AJ/AK reopenings (cloudflare-ai-gateway, merge,
 * saladcloud, ebcloud).
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { isOpenAICompatibleEntry } from '../provider-catalog.types';
import { PROVIDER_SECRETS } from '../../../config/load-secrets-into-env';

const REOPENED_ROWS: ReadonlyArray<{ providerId: string; apiKeyEnvVar: string }> = [
  { providerId: 'ambient', apiKeyEnvVar: 'AMBIENT_API_KEY' },
  { providerId: 'amd', apiKeyEnvVar: 'AMD_API_KEY' },
  { providerId: 'anyapi', apiKeyEnvVar: 'ANYAPI_API_KEY' },
  { providerId: 'bailing', apiKeyEnvVar: 'BAILING_API_KEY' },
];

describe('LOTE AL reopened NPI rows (ambient, amd, anyapi, bailing)', () => {
  it.each(REOPENED_ROWS)(
    '$providerId has a catalog row that is discovery+execution, oai-compat, and not denied/disabled',
    ({ providerId, apiKeyEnvVar }) => {
      const entry = PROVIDER_CATALOG.find((e) => e.providerId === providerId);
      expect(entry, `${providerId} missing from PROVIDER_CATALOG`).toBeDefined();
      expect(entry!.integrationMode).toBe('discovery+execution');
      expect(entry!.apiKeyEnvVar).toBe(apiKeyEnvVar);
      expect(entry!.denyByDefault).not.toBe(true);
      expect(entry!.enabledByDefault).not.toBe(false);
      // None of these four declare a dedicated adapterClass — they must
      // resolve through the generic OAI-compat bridge, or they'd throw
      // CatalogPluginUnsupportedError at boot.
      expect(entry!.adapterClass).toBeUndefined();
      expect(isOpenAICompatibleEntry(entry!)).toBe(true);
    }
  );

  it.each(REOPENED_ROWS)(
    '$providerId API key env var is wired into load-secrets-into-env.ts PROVIDER_SECRETS',
    ({ apiKeyEnvVar }) => {
      expect(
        PROVIDER_SECRETS.some((s) => s.envVar === apiKeyEnvVar),
        `${apiKeyEnvVar} missing from PROVIDER_SECRETS`
      ).toBe(true);
    }
  );

  it('bailing carries the ant-ling alias (the corrected canonical host/product name)', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'bailing');
    expect(entry?.aliases).toContain('ant-ling');
    expect(entry?.baseUrl).toContain('ant-ling.com');
  });

  it('none of the four reopened rows collide with an existing providerId or alias', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.providerId);
    const idCounts = new Map<string, number>();
    for (const id of ids) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    for (const { providerId } of REOPENED_ROWS) {
      expect(idCounts.get(providerId)).toBe(1);
    }
  });
});
