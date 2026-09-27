// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test-only model of what Redis does when it runs
 * CATALOG_SNAPSHOT_PUBLISH_SCRIPT against a Map-backed fake store, so the
 * hermetic catalog tests can keep using a plain Map as "Redis". TTLs are
 * not modelled. The real Lua script is exercised against a real Redis 7 in
 * catalog-snapshot-publisher.integration.test.ts; keep the two in step.
 */
import { CATALOG_SNAPSHOT_PUBLISH_SCRIPT } from '@/services/catalog-snapshot-publisher';

export function runCatalogPublishScript(
  store: Map<string, string>,
  script: unknown,
  numKeys: unknown,
  ...args: unknown[]
): number {
  if (script !== CATALOG_SNAPSHOT_PUBLISH_SCRIPT) {
    throw new Error('fake redis: only the catalog snapshot publish script is modelled');
  }
  if (Number(numKeys) !== 3) {
    throw new Error(`fake redis: expected 3 keys, got ${String(numKeys)}`);
  }
  const [stagingKey, liveKey, metaKey, metaJson, version] = args.map((arg) => String(arg));
  const staged = store.get(stagingKey);
  if (staged === undefined) return -1;
  const current = store.get(metaKey);
  if (current !== undefined) {
    let currentVersion = Number.NaN;
    try {
      const decoded = JSON.parse(current) as unknown;
      if (decoded && typeof decoded === 'object') {
        currentVersion = Number((decoded as { generatedAt?: unknown }).generatedAt);
      }
    } catch {
      // Malformed meta: treated as absent, like the pcall(cjson.decode) guard.
    }
    if (Number.isFinite(currentVersion) && currentVersion > Number(version) && store.has(liveKey)) {
      store.delete(stagingKey);
      return 0;
    }
  }
  store.set(liveKey, staged);
  store.delete(stagingKey);
  store.set(metaKey, metaJson);
  return 1;
}
