// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-hold-ttl.ts — per-strategy-family wallet hold TTL sizing (ENT-002
 * Phase 1 subset, D4).
 *
 * THE PROBLEM: the prepaid wallet's hold self-expires after
 * DEFAULT_HOLD_TTL_MS (prepaid-wallet.ts — 5 minutes). A hold that expires
 * MID-GENERATION frees the reserved spend while the execution is still
 * running, so concurrent requests can oversell the org's balance and the
 * post-execution settle can land on a balance that already spent that money
 * elsewhere. The 5-minute default was sized for plain chat; the intent
 * presets run collective executions (quality-multipass fan-out, triage +
 * fallback chains) whose worst-case wall clock exceeds it — production
 * observed ~50s for a SINGLE image generation, and multi-pass text
 * strategies with provider fallbacks legitimately run minutes.
 *
 * THE FIX: a per-family TTL floor sized for the WORST-CASE generation
 * horizon of each intent family, applied where the gate reserves (the gate
 * passes `ttlMs` into `reserve`). Non-family requests (raw ids, legacy
 * presets) keep the DEFAULT — this module only ever EXTENDS the window for
 * composite `<family>:<tier>` targets, never shortens anything (every value
 * below is >= DEFAULT_HOLD_TTL_MS).
 *
 * Sizing rationale (worst case, not median — an expired hold is uncorrectable):
 *   - auto: triage may route through any mechanism + fallback chain → budget
 *     the sum of a full deliberation window.
 *   - best (quality-multipass, fanout 6): the heaviest intent family — N
 *     sequential passes plus synthesis, each with provider failover.
 *   - fast / economy / single (solo mechanisms): a single call + fallback
 *     chain.
 * Each value carries a generous safety multiple over observed worst cases
 * (the cost of over-holding is bounded: the settle releases the unused
 * remainder, so an honest caller is never charged for the extension).
 */

import type { StrategyFamily } from '@/services/strategy-family';
import { resolveRequestStrategyFamily } from '@/services/strategy-family';

/** 10 minutes — solo families: single call + the full provider fallback chain. */
const SOLO_FAMILY_HOLD_TTL_MS = 10 * 60 * 1000;
/** 20 minutes — `best`/`auto`: multi-pass deliberation + synthesis + failover. */
const DELIBERATIVE_FAMILY_HOLD_TTL_MS = 20 * 60 * 1000;

/**
 * Worst-case hold horizon per strategy family. Every entry is >=
 * DEFAULT_HOLD_TTL_MS (5 min): the map can only EXTEND a hold's life.
 * `auto` is deliberative-class on purpose — triage can route it into any
 * mechanism, so its horizon must cover the heaviest one it may pick.
 */
export const HOLD_TTL_MS_BY_FAMILY: Record<StrategyFamily, number> = {
  auto: DELIBERATIVE_FAMILY_HOLD_TTL_MS,
  best: DELIBERATIVE_FAMILY_HOLD_TTL_MS,
  fast: SOLO_FAMILY_HOLD_TTL_MS,
  economy: SOLO_FAMILY_HOLD_TTL_MS,
  single: SOLO_FAMILY_HOLD_TTL_MS,
  // Fan-out collectives (Phase 2 exposure) — bounded below by the same solo
  // floor for now; Phase 2's fan-out wallet work (ENT-002) re-sizes these
  // against measured fan-out horizons before they are sold.
  parallel: SOLO_FAMILY_HOLD_TTL_MS,
  consensus: SOLO_FAMILY_HOLD_TTL_MS,
  'expert-panel': SOLO_FAMILY_HOLD_TTL_MS,
  // media-planner is deliberative-class: a bounded agentic turn loop that
  // fans out into MULTIPLE media generations (plus judge review passes), so
  // its worst-case horizon matches `best`/`auto`, not a solo call.
  'media-planner': DELIBERATIVE_FAMILY_HOLD_TTL_MS,
};

/** Minimal request shape this module reads (server-set post-normalization). */
export interface HoldTtlRequestShape {
  ailin_tier?: unknown;
  ailin_alias?: unknown;
  strategy?: unknown;
}

/**
 * The TTL the wallet gate should reserve with for this request:
 *   - composite `<family>:<tier>` target → the family's worst-case horizon;
 *   - anything else (raw id, legacy preset, absent model) → undefined, i.e.
 *     the store's own DEFAULT_HOLD_TTL_MS — byte-identical legacy behavior.
 */
export function holdTtlForRequest(req: HoldTtlRequestShape): number | undefined {
  const family = resolveRequestStrategyFamily(req);
  if (family === null) return undefined;
  return HOLD_TTL_MS_BY_FAMILY[family];
}
