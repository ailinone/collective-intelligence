// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retrieval-types.ts — pure types for the retriever.
 *
 * MVP 5A invariants: pure types. No I/O.
 */

import type { ExplicitPinInfo, PrivacyMode } from '../registry/types';
import type { ModelScoreResult } from '../scoring/model-scorer';
import type { Sensitivity, ScoringPolicy } from '../scoring/scoring-policy';

// ─── Request ────────────────────────────────────────────────────────────

export interface CandidateRetrievalRequest {
  readonly requiredCapabilities?: readonly string[];
  readonly desiredCapabilities?: readonly string[];
  readonly minContextWindow?: number;
  readonly privacyMode?: PrivacyMode;
  readonly costSensitivity?: Sensitivity;
  readonly latencySensitivity?: Sensitivity;
  readonly explicitModelPin?: ExplicitPinInfo | null;
  readonly maxCandidates?: number;
  readonly scoringPolicy?: ScoringPolicy;
}

// ─── Result ─────────────────────────────────────────────────────────────

export interface CandidateRejection {
  readonly routeId: string;
  readonly stage: string;
  readonly reason: string;
}

export interface CandidateRetrievalResult {
  readonly candidates: readonly ModelScoreResult[];
  readonly rejectedByStage: readonly CandidateRejection[];
  readonly countsByStage: Readonly<Record<string, number>>;
}

// ─── Stage names (single source of truth) ───────────────────────────────

export const RETRIEVAL_STAGES = Object.freeze({
  INITIAL: 'initial',
  EXPLICIT_PIN: 'explicit_pin',
  PRIVACY: 'privacy',
  CAPABILITY: 'capability',
  CONTEXT_WINDOW: 'context_window',
  READINESS: 'readiness',
  LIFECYCLE: 'lifecycle',
  AFTER_FILTERS: 'after_filters',
  SCORER: 'scorer',
  AFTER_SCORE: 'after_score',
  RETURNED: 'returned',
} as const);

export type RetrievalStage = (typeof RETRIEVAL_STAGES)[keyof typeof RETRIEVAL_STAGES];
