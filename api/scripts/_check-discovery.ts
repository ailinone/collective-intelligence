// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Empirical smoke check: verify the model discovery service initializes and
 * registers a non-trivial set of sources.
 *
 * Doesn't actually run discovery (which would hit external APIs and take
 * minutes). Just confirms structural integrity.
 *
 * Usage:
 *   pnpm tsx scripts/_check-discovery.ts
 */
import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service';

interface DiscoverySourceShape {
  readonly name: string;
  readonly type: string;
  readonly providers?: ReadonlyArray<string>;
}

async function main(): Promise<void> {
  const svc = await getCentralModelDiscoveryService();
  // The service exposes a private `discoverySources` Map. We probe it via a
  // typed structural cast (NOT `as unknown as`) so the smoke test has access
  // without breaking encapsulation in production code.
  const accessor = svc as { discoverySources: Map<string, DiscoverySourceShape> };
  const sources = accessor.discoverySources;

  // eslint-disable-next-line no-console
  console.log('[discovery] total sources:', sources.size);

  const byType: Record<string, number> = {};
  const providers = new Set<string>();
  for (const src of sources.values()) {
    byType[src.type] = (byType[src.type] ?? 0) + 1;
    for (const p of src.providers ?? []) {
      providers.add(p);
    }
  }
  // eslint-disable-next-line no-console
  console.log('[discovery] by type:', JSON.stringify(byType));
  // eslint-disable-next-line no-console
  console.log('[discovery] unique providers covered:', providers.size);
  // eslint-disable-next-line no-console
  console.log(
    '[discovery] sample providers:',
    Array.from(providers).slice(0, 15).join(', '),
  );

  if (sources.size < 30) {
    // eslint-disable-next-line no-console
    console.error('[discovery] FAIL — expected ≥30 sources, got', sources.size);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('[discovery] PASS');
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[discovery] CRASH:', message);
  process.exit(1);
});
