// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared "is this error about the PROVIDER being unreachable, or about the
 * CAPABILITY being unsupported" classifier for empirical runtime probes.
 *
 * Extracted from `function-calling-probe.ts` (2026-09-05, GAP-A13) so the
 * Tiered Capability Fingerprint probes (Tier-1 diagnostic, Tier-3
 * multimodal — see `tier1-diagnostic-probe.ts` / `tier3-multimodal-probe.ts`)
 * reuse the SAME liveness signal instead of re-deriving it. A probe that
 * hits a billing/auth/quota/timeout/network error has learned NOTHING about
 * the capability it was testing — the candidate is simply unexecutable right
 * now, which is the operability hub's concern, not a capability verdict to
 * cache.
 *
 * Deliberately conservative and message-text-based (not status-code-based
 * like `failures/provider-error-classifier.ts`): probe call sites only have
 * `err.message` from a thrown adapter error, not a structured HTTP response,
 * and the two classifiers serve different callers (this one answers "is this
 * a capability verdict?", not "should the caller retry?").
 */

/** Billing/auth/quota/timeout/network shapes — provider liveness, NOT a capability verdict. */
export const PROVIDER_LIVENESS_PATTERNS: readonly RegExp[] = [
  /insufficient/i,
  /credit/i,
  /quota/i,
  /billing/i,
  /unauthorized/i,
  /api\s*key/i,
  /forbidden/i,
  /rate.?limit/i,
  /timeout/i,
  /timed?\s*out/i,
  /econnreset/i,
  /socket\s+hang\s+up/i,
  /network/i,
  /fetch\s+failed/i,
];

/** True when `message` describes provider unavailability rather than a capability rejection. */
export function isProviderLivenessError(message: string): boolean {
  const text = message.toLowerCase();
  return PROVIDER_LIVENESS_PATTERNS.some((p) => p.test(text));
}
