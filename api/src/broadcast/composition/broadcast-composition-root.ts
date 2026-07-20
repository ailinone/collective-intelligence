// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast Composition Root — wires the broadcast pipeline singletons.
 *
 * Lazily constructed on first access so the feature can stay fully gated by
 * `BROADCAST_FEATURE_ENABLED`. No construction happens at import time.
 *
 * Singletons live for the process lifetime. The KEK provider resolves its
 * backend (local vs GCP KMS) from env at first access — rotating KEK requires
 * a process restart, which is acceptable (ADR-017).
 */

import { BroadcastOutboxPoller } from '@/broadcast/application/broadcast-outbox-poller';
import { BroadcastDeliveryExecutor } from '@/broadcast/application/delivery-executor';
import { destinationResolver } from '@/broadcast/application/destination-resolver';
import {
  DestinationConfigCipher,
  resolveKekProvider,
} from '@/broadcast/infrastructure/encryption';
import type { DestinationAdapterRegistry } from '@/broadcast/infrastructure/destinations/destination-adapter';
import { buildDefaultAdapterRegistry } from '@/broadcast/infrastructure/destinations';

let _cipher: DestinationConfigCipher | null = null;
let _registry: DestinationAdapterRegistry | null = null;
let _executor: BroadcastDeliveryExecutor | null = null;
let _poller: BroadcastOutboxPoller | null = null;

function getCipher(): DestinationConfigCipher {
  if (_cipher) return _cipher;
  _cipher = new DestinationConfigCipher({ kek: resolveKekProvider(process.env) });
  return _cipher;
}

/** Exported so HTTP routes can share the same cipher singleton (one KEK cache per process). */
export function getBroadcastCipher(): DestinationConfigCipher {
  return getCipher();
}

function getAdapters(): DestinationAdapterRegistry {
  if (_registry) return _registry;
  _registry = buildDefaultAdapterRegistry();
  return _registry;
}

export function setBroadcastAdapterRegistry(registry: DestinationAdapterRegistry): void {
  _registry = registry;
  _executor = null;
  _poller = null;
}

export function getBroadcastExecutor(): BroadcastDeliveryExecutor {
  if (_executor) return _executor;
  _executor = new BroadcastDeliveryExecutor({
    cipher: getCipher(),
    adapters: getAdapters(),
  });
  return _executor;
}

export function getBroadcastPoller(): BroadcastOutboxPoller {
  if (_poller) return _poller;
  _poller = new BroadcastOutboxPoller({
    resolver: destinationResolver,
    executor: getBroadcastExecutor(),
  });
  return _poller;
}

/** Test helper — clears all singletons so each test starts clean. */
export function __resetBroadcastCompositionForTests(): void {
  _cipher = null;
  _registry = null;
  _executor = null;
  _poller = null;
}
