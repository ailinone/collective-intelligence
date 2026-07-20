# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Tiered Ensemble Voter — coordinator-stable aggregation.

Implements the speculative cascade described in
`registry/models/coordinator-stable.yaml`:

  Tier 1 (encoders, ~5ms) decides ~70-80% of requests alone via
  confidence threshold. Only ambiguous / dissenting cases escalate
  through Tier 2 → 6.

The aggregator computes a weighted Bayesian-majority decision over
votes from each tier, returning a `RoleDecision`-compatible payload
that lands directly in `collective_signals.decision_value` (per the
F4.1 audit substrate in api/src/core/coordination/).

This module is INFRA — it does not call HF transformers directly.
Each tier is exposed as a callable `TierExecutor` (Protocol). The
production wiring (vLLM / inference servers) plugs in at the
`TieredEnsembleVoter.tier_executors` map.

Design constraints:
  - Must NEVER throw when a tier fails — failures are logged and the
    tier is marked unavailable so escalation continues.
  - Audit substrate is the source of truth: every decision carries
    full vote distribution, dissent count, scheduler tags, and
    aggregation method.
  - Idempotent within a single request: the same input must yield the
    same decision (modulo non-determinism in individual coordinators,
    bounded by their own seeds).
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


class Tier(int, Enum):
    """Cascade tier ordering. Lower numbers run first."""

    ENCODER = 1
    DENSE_TINY = 2
    DENSE_SMALL = 3
    DENSE_ANCHOR = 4
    MOE_LIGHT = 5
    MOE_HEAVY = 6


@dataclass(frozen=True)
class CoordinatorVote:
    """One vote from one coordinator model.

    Mirrors the audit substrate landed in api/src/core/coordination/
    (DebateSignalInput / TriRoleTurnInput) so downstream persistence
    is one-to-one without remapping.
    """

    model_id: str  # e.g. "m01"
    scheduler: str  # e.g. "coord-m01-modernbert"
    tier: Tier
    role: str  # the chosen RoleDecision.role
    reason: str  # short stable token (vocabulary in _shared.yaml)
    confidence: float  # 0.0 - 1.0 self-reported
    rationale: str | None = None
    features: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TierResult:
    """All votes from one tier, plus tier-level statistics."""

    tier: Tier
    votes: tuple[CoordinatorVote, ...]
    failed_models: tuple[str, ...] = ()  # models that errored / timed out

    @property
    def majority_role(self) -> str | None:
        if not self.votes:
            return None
        counts = Counter(v.role for v in self.votes)
        # Counter.most_common returns [(role, count), ...] — first is majority
        return counts.most_common(1)[0][0]

    @property
    def dissent_count(self) -> int:
        """How many votes disagree with the tier's majority."""
        if not self.votes:
            return 0
        majority = self.majority_role
        return sum(1 for v in self.votes if v.role != majority)

    @property
    def average_confidence(self) -> float:
        if not self.votes:
            return 0.0
        return sum(v.confidence for v in self.votes) / len(self.votes)


@dataclass(frozen=True)
class AggregatedDecision:
    """Final ensemble decision + full audit substrate.

    Every field is captured in `collective_signals.decision_value`
    JSONB by the F4.1 persistence path so downstream training has
    perfect visibility into the voting process.
    """

    role: str  # final chosen role
    reason: str  # aggregator's reason token
    scheduler: str = "ensemble-24-tiered-bayesian"
    confidence: float = 0.0
    aggregation_method: str = "weighted_bayesian_majority"
    tier_results: tuple[TierResult, ...] = ()
    vote_distribution: Mapping[str, int] = field(default_factory=dict)
    total_votes: int = 0
    dissent_count: int = 0
    tiers_activated: tuple[Tier, ...] = ()
    final_tier: Tier | None = None
    short_circuited: bool = False  # True if Tier 1-3 ended cascade


# ---------------------------------------------------------------------------
# Tier executor contract
# ---------------------------------------------------------------------------


class TierExecutor(Protocol):
    """Implemented by the production vLLM client per tier.

    Receives the request payload and returns the votes for the 4
    coordinators in that tier. Must NOT throw — failures should be
    caught and represented as `failed_models` in the returned TierResult.
    """

    async def __call__(self, request: Mapping[str, Any]) -> TierResult: ...


# ---------------------------------------------------------------------------
# Vote aggregator (pure)
# ---------------------------------------------------------------------------


class VoteAggregator:
    """Pure aggregator — given tier results, computes the final decision.

    Two algorithms supported:

      `weighted_bayesian_majority` (default)
        Each model's vote is weighted by `tier_weight × confidence ×
        accuracy_history` (accuracy_history defaults to 1.0 until the
        flywheel populates it). Majority wins; ties broken by total
        weight on the tied roles.

      `dissent_aware_synthesis`
        When dissent > threshold, escalate to LLM-synthesis (Tier 6
        coordinator picks the role from candidates). Implemented in
        TieredEnsembleVoter, not here.
    """

    def __init__(
        self,
        tier_weights: Mapping[Tier, float],
        accuracy_history: Mapping[str, float] | None = None,
    ) -> None:
        self.tier_weights = tier_weights
        self.accuracy_history = accuracy_history or {}

    def aggregate(
        self, tier_results: Sequence[TierResult]
    ) -> tuple[str, str, float, dict[str, int]]:
        """Returns (role, reason, confidence, vote_distribution)."""
        weighted_scores: Counter[str] = Counter()
        all_votes: list[CoordinatorVote] = []
        vote_dist: Counter[str] = Counter()

        for tr in tier_results:
            tier_w = self.tier_weights.get(tr.tier, 0.0)
            for v in tr.votes:
                acc = self.accuracy_history.get(v.model_id, 1.0)
                weight = tier_w * v.confidence * acc
                weighted_scores[v.role] += weight
                vote_dist[v.role] += 1
                all_votes.append(v)

        if not weighted_scores:
            return "fallback-default", "no-votes", 0.0, {}

        # Top-scoring role wins.
        winner_role, winner_score = weighted_scores.most_common(1)[0]
        total_weight = sum(weighted_scores.values())
        confidence = winner_score / total_weight if total_weight > 0 else 0.0

        # Reason = most common reason token among voters who chose the winner.
        reasons_for_winner = Counter(v.reason for v in all_votes if v.role == winner_role)
        winner_reason = (
            reasons_for_winner.most_common(1)[0][0] if reasons_for_winner else "weighted-majority"
        )

        return winner_role, winner_reason, confidence, dict(vote_dist)


# ---------------------------------------------------------------------------
# Ensemble config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EnsembleConfig:
    """Runtime config — read from coordinator-stable.yaml at boot."""

    tier_confidence_thresholds: Mapping[Tier, float] = field(
        default_factory=lambda: {
            Tier.ENCODER: 0.85,
            Tier.DENSE_TINY: 0.80,
            Tier.DENSE_SMALL: 0.75,
            Tier.DENSE_ANCHOR: 0.70,
            Tier.MOE_LIGHT: 0.65,
            # Tier 6 always runs to completion when reached.
        }
    )
    tier_weights: Mapping[Tier, float] = field(
        default_factory=lambda: {
            Tier.ENCODER: 0.10,
            Tier.DENSE_TINY: 0.15,
            Tier.DENSE_SMALL: 0.20,
            Tier.DENSE_ANCHOR: 0.25,
            Tier.MOE_LIGHT: 0.20,
            Tier.MOE_HEAVY: 0.10,
        }
    )
    dissent_escalate_threshold: int = 2
    aggregation_method: str = "weighted_bayesian_majority"
    fallback_role: str = "fallback-default"


# ---------------------------------------------------------------------------
# Tiered ensemble voter
# ---------------------------------------------------------------------------


class TieredEnsembleVoter:
    """The production cascade.

    Wires tier executors (one per tier) and runs them in order until
    either the confidence threshold is met OR all tiers are exhausted.
    """

    def __init__(
        self,
        tier_executors: Mapping[Tier, TierExecutor],
        config: EnsembleConfig | None = None,
        accuracy_history: Mapping[str, float] | None = None,
    ) -> None:
        self.tier_executors = dict(tier_executors)
        self.config = config or EnsembleConfig()
        self.aggregator = VoteAggregator(self.config.tier_weights, accuracy_history)

    async def decide(self, request: Mapping[str, Any]) -> AggregatedDecision:
        """Run the tiered cascade and return a final decision.

        The cascade exits early when the running aggregate of tiers
        run-so-far has confidence ≥ this tier's threshold AND dissent
        ≤ the configured threshold.
        """
        results: list[TierResult] = []
        tiers_activated: list[Tier] = []
        short_circuited = False
        final_tier: Tier | None = None

        for tier in (
            Tier.ENCODER,
            Tier.DENSE_TINY,
            Tier.DENSE_SMALL,
            Tier.DENSE_ANCHOR,
            Tier.MOE_LIGHT,
            Tier.MOE_HEAVY,
        ):
            executor = self.tier_executors.get(tier)
            if executor is None:
                logger.debug("Tier %s has no executor — skipping", tier.name)
                continue

            try:
                result = await executor(request)
            except Exception as exc:  # noqa: BLE001 — we MUST swallow per contract
                logger.warning(
                    "Tier %s executor failed: %s — continuing cascade",
                    tier.name,
                    exc,
                )
                # Empty result so cascade keeps going; tier is still marked activated.
                result = TierResult(tier=tier, votes=())

            results.append(result)
            tiers_activated.append(tier)
            final_tier = tier

            # Check exit condition: confidence threshold + low dissent.
            threshold = self.config.tier_confidence_thresholds.get(tier)
            if threshold is None:
                # Tier 6 has no threshold — always runs to completion.
                continue

            _, _, running_conf, _ = self.aggregator.aggregate(results)
            running_dissent = sum(r.dissent_count for r in results)

            if (
                running_conf >= threshold
                and running_dissent <= self.config.dissent_escalate_threshold
            ):
                short_circuited = True
                break

        # Final aggregation
        if not results:
            return AggregatedDecision(
                role=self.config.fallback_role,
                reason="no-tier-executors-registered",
                confidence=0.0,
                tier_results=(),
                vote_distribution={},
                total_votes=0,
                dissent_count=0,
                tiers_activated=(),
                final_tier=None,
                short_circuited=False,
            )

        role, reason, conf, vote_dist = self.aggregator.aggregate(results)
        total_votes = sum(len(r.votes) for r in results)
        # Total dissent = votes that disagreed with the winner across all tiers.
        total_dissent = sum(1 for r in results for v in r.votes if v.role != role)

        return AggregatedDecision(
            role=role,
            reason=reason,
            scheduler="ensemble-24-tiered-bayesian",
            confidence=conf,
            aggregation_method=self.config.aggregation_method,
            tier_results=tuple(results),
            vote_distribution=vote_dist,
            total_votes=total_votes,
            dissent_count=total_dissent,
            tiers_activated=tuple(tiers_activated),
            final_tier=final_tier,
            short_circuited=short_circuited,
        )
