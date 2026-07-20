// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * runtime-routing-config-provider.ts — MVP 7A
 *
 * Re-export module — keeps the public surface narrow. Consumers import
 * the provider contract + helpers from here without coupling to the
 * static-stub implementation file.
 */

export type {
  ModeExplanation,
  RoutingConfigSource,
  RoutingMode,
  RuntimeRoutingConfig,
  RuntimeRoutingConfigProvider,
} from './runtime-routing-config-types';

export {
  ALLOWED_MODES,
  ALLOWED_REASON,
  BLOCKED_MODES,
  BLOCKED_REASON,
} from './runtime-routing-config-types';

export {
  StaticRoutingConfigProvider,
  createStaticRoutingConfigProvider,
} from './static-routing-config-provider';
