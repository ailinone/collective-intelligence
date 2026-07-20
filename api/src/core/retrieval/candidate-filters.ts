// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-filters.ts — deterministic, pure filters.
 *
 * MVP 5A invariants:
 *   - Each filter is a pure function. No I/O, no DB, no provider call.
 *   - NO pattern matching on names. Capability checks go through
 *     `capabilityOntology` plus structural `supports*` flags.
 *   - Filters return `{ pass, stage, reason }`. Composing them is the
 *     retriever's job, not the filter's.
 *   - Filters apply in a documented order; each filter sees the SAME
 *     candidate object — they NEVER mutate it.
 */

import type { CanonicalModel } from '../registry/canonical-model';
import type { ModelProviderOffering } from '../registry/model-offering';
import type { ProviderModelRoute } from '../registry/model-route';
import type { ExplicitPinInfo, PrivacyMode } from '../registry/types';
import { capabilityOntology } from '../capabilities/capability-ontology';
import { RETRIEVAL_STAGES } from './candidate-retrieval-types';

// ─── Common types ──────────────────────────────────────────────────────

export interface FilterCandidate {
  readonly canonical: CanonicalModel;
  readonly offering: ModelProviderOffering;
  readonly route: ProviderModelRoute;
}

export interface FilterVerdict {
  readonly pass: boolean;
  readonly stage: string;
  readonly reason: string;
}

const PASS: FilterVerdict = Object.freeze({ pass: true, stage: '', reason: '' });

// ─── Self-hosted classification (data, not logic) ───────────────────────

const SELF_HOSTED_KINDS: ReadonlySet<string> = new Set(['local', 'self_hosted']);

// ─── Filter: explicit pin ───────────────────────────────────────────────

export function filterByExplicitPin(
  c: FilterCandidate,
  pin: ExplicitPinInfo | null | undefined,
): FilterVerdict {
  if (!pin) return PASS;

  if (pin.routeId) {
    if (c.route.routeId !== pin.routeId) {
      return {
        pass: false,
        stage: RETRIEVAL_STAGES.EXPLICIT_PIN,
        reason: 'pin_route_mismatch',
      };
    }
    return PASS;
  }
  if (pin.offeringId) {
    if (c.offering.offeringId !== pin.offeringId) {
      return {
        pass: false,
        stage: RETRIEVAL_STAGES.EXPLICIT_PIN,
        reason: 'pin_offering_mismatch',
      };
    }
    return PASS;
  }
  if (pin.canonicalModelId) {
    if (c.canonical.canonicalModelId !== pin.canonicalModelId) {
      return {
        pass: false,
        stage: RETRIEVAL_STAGES.EXPLICIT_PIN,
        reason: 'pin_canonical_mismatch',
      };
    }
    return PASS;
  }
  return PASS;
}

// ─── Filter: privacy ────────────────────────────────────────────────────

export function filterByPrivacy(
  c: FilterCandidate,
  privacyMode: PrivacyMode | undefined,
): FilterVerdict {
  if (privacyMode !== 'local_required') return PASS;
  if (!SELF_HOSTED_KINDS.has(c.route.routeKind)) {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.PRIVACY,
      reason: 'privacy_local_required_but_route_is_external',
    };
  }
  return PASS;
}

// ─── Filter: required capabilities (structural, no name matching) ──────

export function filterByCapability(
  c: FilterCandidate,
  required: readonly string[] | undefined,
): FilterVerdict {
  if (!required || required.length === 0) return PASS;
  for (const cap of required) {
    if (!candidateSatisfiesCapability(c, cap)) {
      return {
        pass: false,
        stage: RETRIEVAL_STAGES.CAPABILITY,
        reason: `missing_capability:${capabilityOntology.normalize(cap)}`,
      };
    }
  }
  return PASS;
}

/**
 * Internal — checks whether a single capability is supported by the
 * route. Resolution priority:
 *   1. `chat` is the implicit baseline (registry already carries chat).
 *   2. `local` / `self_hosted` map to `routeKind` membership.
 *   3. If the ontology entry has a `routeFlag`, check the flag.
 *   4. Otherwise the capability is treated as informational (passes).
 */
function candidateSatisfiesCapability(c: FilterCandidate, cap: string): boolean {
  const id = capabilityOntology.normalize(cap);
  if (id === 'chat') return true;
  if (id === 'local' || id === 'self_hosted') {
    return SELF_HOSTED_KINDS.has(c.route.routeKind);
  }
  const def = capabilityOntology.get(id);
  if (def?.routeFlag) {
    return c.route[def.routeFlag] === true;
  }
  // For capabilities without a route flag (e.g. `reasoning`, `code`,
  // `multilingual`), defer to the canonical's normalised set. Falling
  // back to "supported" when present, "missing" when absent.
  return c.canonical.normalizedCapabilities.has(id);
}

// ─── Filter: contextWindow ──────────────────────────────────────────────

export function filterByContextWindow(
  c: FilterCandidate,
  minContextWindow: number | undefined,
): FilterVerdict {
  if (!minContextWindow || minContextWindow <= 0) return PASS;
  if (c.route.contextWindow < minContextWindow) {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.CONTEXT_WINDOW,
      reason: `context_below_min:${c.route.contextWindow}<${minContextWindow}`,
    };
  }
  return PASS;
}

// ─── Filter: route readiness ────────────────────────────────────────────

export function filterByReadiness(c: FilterCandidate): FilterVerdict {
  if (c.route.healthState === 'auth_failed') {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.READINESS,
      reason: 'route_auth_failed',
    };
  }
  if (c.route.healthState === 'no_credits' || c.route.creditStatus === 'no_credits') {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.READINESS,
      reason: 'route_no_credits',
    };
  }
  if (c.route.healthState === 'rate_limited') {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.READINESS,
      reason: 'route_rate_limited',
    };
  }
  if (c.route.minimalChatStatus === 'failed') {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.READINESS,
      reason: 'route_minimal_chat_failed',
    };
  }
  return PASS;
}

// ─── Filter: lifecycle ──────────────────────────────────────────────────

export function filterByLifecycle(
  c: FilterCandidate,
  options?: { allowPreview?: boolean; allowDeprecated?: boolean },
): FilterVerdict {
  const lc = c.canonical.lifecycle;
  const allowPreview = options?.allowPreview === true;
  const allowDeprecated = options?.allowDeprecated === true;
  if ((lc === 'deprecated' || lc === 'retired') && !allowDeprecated) {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.LIFECYCLE,
      reason: `lifecycle_${lc}_blocked`,
    };
  }
  if (lc === 'preview' && !allowPreview) {
    return {
      pass: false,
      stage: RETRIEVAL_STAGES.LIFECYCLE,
      reason: 'lifecycle_preview_blocked',
    };
  }
  return PASS;
}
