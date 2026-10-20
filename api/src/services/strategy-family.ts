// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-family.ts — the pure strategy-family vocabulary shared by the A3
 * target-policy gate (strategy-target-policy.ts) and the wallet hold-TTL
 * sizing (strategy-hold-ttl.ts).
 *
 * WHY a separate module: both consumers need to derive the canonical strategy
 * family from a post-normalization ChatRequest, but the target-policy module
 * also pulls in Redis/billing-client dependencies (it reads entitlements) and
 * the wallet gate must stay import-light (its test suite mocks its store, not
 * the Redis stack). This file deliberately imports ONLY `pricing-tiers.ts`
 * (itself dependency-free) so every consumer can share the exact same family
 * derivation without dragging infrastructure along.
 *
 * The 8-family enum is the `STRATEGY_POLICY` executionReady set
 * (pricing-tiers.ts) — the canonical taxonomy per the Enterprise Model Catalog
 * spec (CAT-006). It is repeated here as a literal union (not derived from
 * STRATEGY_POLICY's string keys) so the type system — not a runtime filter —
 * is what bounds every `StrategyFamily` in the codebase; a family added to
 * STRATEGY_POLICY must be added here explicitly, which a compile error will
 * force at every switch/map that matters.
 */

import { parseStrategyTier } from '@/services/pricing-tiers';

export type StrategyFamily =
  | 'auto'
  | 'best'
  | 'fast'
  | 'economy'
  | 'single'
  | 'parallel'
  | 'consensus'
  | 'expert-panel'
  | 'media-planner';

export const STRATEGY_FAMILIES: readonly StrategyFamily[] = [
  'auto',
  'best',
  'fast',
  'economy',
  'single',
  'parallel',
  'consensus',
  'expert-panel',
  'media-planner',
];

export function isStrategyFamily(value: string): value is StrategyFamily {
  return (STRATEGY_FAMILIES as readonly string[]).includes(value);
}

/**
 * The minimal post-normalization request shape the derivation reads. Kept
 * structural (not `ChatRequest`) so tests can build tiny fixtures and so this
 * module never imports the full `@/types` chain.
 *
 * All three fields are SERVER-SET by `normalizeChatRequest`:
 *   - `ailin_tier`/`ailin_tier_rate` exist ONLY for `<family>:<tier>` cells
 *     (chat-routes.ts strips/re-stamps them; a client cannot inject them);
 *   - `ailin_alias` is the resolved alias id (`best:medium`, `ailin-auto`, …).
 * Legacy `ailin-*` presets resolve an alias but carry NO tier carrier, and raw
 * model ids carry neither — so "tier carrier present" is precisely "this
 * request is a composite `<family>:<tier>` target", the same discriminator the
 * prepaid-wallet gate bills on (prepaid-wallet-gate.ts `resolveTier`).
 */
export interface StrategyFamilyRequestShape {
  ailin_tier?: unknown;
  ailin_alias?: unknown;
  strategy?: unknown;
}

/**
 * The strategy family this request will actually execute, or `null` when the
 * request is not a composite `<family>:<tier>` target (legacy `ailin-*`
 * presets, raw provider ids, `auto`) — i.e. the targets the Phase 1 policy
 * gate must pass through untouched.
 *
 * The family comes from the SERVER-SET alias (re-parsed with the same
 * `parseStrategyTier` the resolver used), never from a raw client string. A
 * tier carrier with an unresolvable family returns `null` (treated as
 * non-composite, passes through): the carrier proves CI itself resolved a
 * priced cell, so a mismatch here is a resolver drift to be logged upstream,
 * not a client-controllable deny.
 */
export function resolveRequestStrategyFamily(
  req: StrategyFamilyRequestShape
): StrategyFamily | null {
  if (req.ailin_tier === undefined || req.ailin_tier === null) return null;
  const alias = typeof req.ailin_alias === 'string' ? req.ailin_alias : null;
  const fromAlias = alias !== null ? parseStrategyTier(alias)?.strategy : undefined;
  if (fromAlias !== undefined && isStrategyFamily(fromAlias)) return fromAlias;
  // Fallback: `strategy` post-normalization is usually an EXECUTION name
  // (`quality-multipass`), which is intentionally NOT a family — only an exact
  // family-name match counts. No heuristic renaming: ambiguity here would let
  // one identity be policed as another.
  const strategy = typeof req.strategy === 'string' ? req.strategy : null;
  if (strategy !== null && isStrategyFamily(strategy)) return strategy;
  return null;
}

// ── Boot configuration for the A3 gate (pure, importable from config) ──────

export type TargetPolicyMode = 'off' | 'shadow' | 'enforce';

/** `TARGET_POLICY_MODE`, validated. Anything unrecognized falls back to the
 * safe default (`shadow` — decide + log, never enforce) rather than guessing. */
export function targetPolicyModeFromEnv(env: Record<string, string | undefined> = process.env): TargetPolicyMode {
  const raw = env.TARGET_POLICY_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  return 'shadow';
}

/**
 * Startup assertion (A3 design §7.2): `TARGET_POLICY_MODE=enforce` promises
 * real denials keyed on billing plan data — running that with billing
 * credentials unconfigured would make every decision land on the
 * `unavailable_*` failure path, i.e. a silent global allow (low-risk) / global
 * deny (high-risk) driven by an accident of configuration. Refuse to boot in
 * that state. Pure + dependency-free so `validateConfig()` (config/index.ts)
 * can call it without an import cycle.
 */
export function assertTargetPolicyBootConfiguration(
  env: Record<string, string | undefined> = process.env
): void {
  if (targetPolicyModeFromEnv(env) !== 'enforce') return;
  const missing: string[] = [];
  if (!env.BILLING_SERVICE_URL?.trim()) missing.push('BILLING_SERVICE_URL');
  if (!env.BILLING_API_SECRET_KEY?.trim()) missing.push('BILLING_API_SECRET_KEY');
  if (missing.length > 0) {
    throw new Error(
      `TARGET_POLICY_MODE=enforce requires billing credentials for entitlement resolution, ` +
        `but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not configured. ` +
        `Enforce mode without them would deny (or allow) every tiered request based on ` +
        `billing availability alone. Set TARGET_POLICY_MODE=shadow (decide + log only) or ` +
        `configure the missing variable(s).`
    );
  }
}
