// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Routing policy fixture (skeleton for MVP 2).
 *
 * The registry_cache equivalence tests are policy-agnostic — they only
 * verify that the registry preserves input identity and shape. This
 * fixture provides default-zero weights so later MVPs (ModelScorer,
 * StrategyPlanner) can begin running tests with a known baseline.
 */

import type { RoutingPolicy, ScorerWeights, SelfHostedPolicy } from '../../types';

const ZERO_WEIGHTS: ScorerWeights = Object.freeze({
  semantic: 0,
  capability: 0,
  quality: 0,
  freshness: 0,
  health: 0,
  latency: 0,
  ttft: 0,
  cost: 0,
  context: 0,
  routeKind: 0,
  local: 0,
  feedback: 0,
  risk: 0,
});

const DEFAULT_SELF_HOSTED_POLICY: SelfHostedPolicy = 'last_resort';

/**
 * Policy with all scorer weights zeroed — equivalent to "no scoring
 * decision", which is the MVP 2 reality (no scorer wired yet).
 */
export const ROUTING_POLICY_FIXTURE: RoutingPolicy = Object.freeze({
  scorerWeights: ZERO_WEIGHTS,
  selfHostedPolicy: DEFAULT_SELF_HOSTED_POLICY,
  singleConfidenceMargin: 0,
  shadowDivergenceLogThreshold: 0.15,
  dryRunRateLimitPerMin: 10,
  maxCostUsd: 0,
  routeKindWeights: Object.freeze({
    native: 1.0,
    aggregator: 0.9,
    gateway: 0.85,
    edge: 0.9,
    local: 0.8,
    self_hosted: 0.75,
  }),
});
