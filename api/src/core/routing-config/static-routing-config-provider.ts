// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * static-routing-config-provider.ts — MVP 7A
 *
 * In-memory, immutable provider. Built once from constructor options,
 * never mutates, never reads env at module load, never spawns timers.
 *
 * Defaults are conservative — `mode = 'legacy'`, `enabled = true`,
 * `source = 'static_stub'`. The provider gates blocked modes through
 * the canonical `ALLOWED_MODES` / `BLOCKED_MODES` sets so callers cannot
 * be tricked by hand-crafted config objects.
 */

import {
  ALLOWED_MODES,
  ALLOWED_REASON,
  BLOCKED_MODES,
  BLOCKED_REASON,
  type ModeExplanation,
  type RoutingConfigSource,
  type RoutingMode,
  type RuntimeRoutingConfig,
  type RuntimeRoutingConfigProvider,
} from './runtime-routing-config-types';

export interface StaticRoutingConfigProviderOptions {
  readonly mode?: RoutingMode;
  readonly enabled?: boolean;
  readonly updatedAt?: string;
  readonly source?: RoutingConfigSource;
}

export class StaticRoutingConfigProvider implements RuntimeRoutingConfigProvider {
  private readonly config: RuntimeRoutingConfig;

  constructor(options: StaticRoutingConfigProviderOptions = {}) {
    const requestedMode: RoutingMode = options.mode ?? 'legacy';
    const enabled = options.enabled ?? true;
    const source: RoutingConfigSource = options.source ?? 'static_stub';

    const blocked = BLOCKED_MODES.has(requestedMode);
    const config: RuntimeRoutingConfig = blocked
      ? Object.freeze({
          mode: requestedMode,
          enabled: false,
          reason: BLOCKED_REASON,
          updatedAt: options.updatedAt,
          source,
        })
      : Object.freeze({
          mode: requestedMode,
          enabled,
          updatedAt: options.updatedAt,
          source,
        });

    this.config = config;
  }

  getConfig(): RuntimeRoutingConfig {
    return this.config;
  }

  getMode(): RoutingMode {
    return this.config.mode;
  }

  isModeAllowed(mode: RoutingMode): boolean {
    return ALLOWED_MODES.has(mode);
  }

  explainMode(mode: RoutingMode): ModeExplanation {
    if (ALLOWED_MODES.has(mode)) {
      return Object.freeze({ allowed: true, reason: ALLOWED_REASON });
    }
    if (BLOCKED_MODES.has(mode)) {
      return Object.freeze({ allowed: false, reason: BLOCKED_REASON });
    }
    return Object.freeze({ allowed: false, reason: 'mode_unknown' });
  }
}

/**
 * Convenience factory — produces a frozen provider in one call. Useful
 * for fixtures and the composer's default branch.
 */
export function createStaticRoutingConfigProvider(
  options: StaticRoutingConfigProviderOptions = {},
): RuntimeRoutingConfigProvider {
  return new StaticRoutingConfigProvider(options);
}
