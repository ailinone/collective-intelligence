# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Mock Cascade — exercises the real `TieredEnsembleVoter` with synthetic
executors so we can validate the full speculative-cascade pipeline
through HTTP without needing the 24 students trained or vLLM running.

This is the third coord_serving mode (between MOCK_DETERMINISTIC, which
canns one tier-1 vote, and TEACHER_PROXY, which uses one synthetic
teacher vote). MOCK_CASCADE stitches the production aggregation logic
together end-to-end:

  request → 6 mock tier executors → TieredEnsembleVoter →
            cascade exit (short-circuit OR Tier 6 fallthrough) →
            AggregatedDecision

The contract is identical to REAL_ENSEMBLE — when Phase 2c.2 lands the
vLLM clients, the executors swap and nothing else changes. That makes
this module the integration test for the cascade itself, not just the
HTTP contract.

Behavior knobs (per-tier, set via context flags so individual tests can
exercise specific cascade branches):

  context.mockCascade.dissentAtTier: int        — split votes 50/50 at this tier
  context.mockCascade.failTier:      int        — that tier's executor raises
  context.mockCascade.confidenceTier:dict[int,float]
                                                — override per-tier base confidence
  context.mockCascade.disagreeTier:  int        — that tier votes a NON-canonical role

Without any flags the cascade short-circuits at Tier 1 — with all 4
encoders voting the canonical role unanimously, the aggregator's
winner_share confidence is 1.0 (regardless of per-vote confidence),
which crosses the 0.85 threshold. To exercise full cascade
exhaustion, set `dissentTiers: [1, 2, 3, 4, 5, 6]` so each tier's
vote distribution stays split and confidence stays below threshold
at every step.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .tiered_voter import (
    AggregatedDecision,
    CoordinatorVote,
    EnsembleConfig,
    Tier,
    TieredEnsembleVoter,
    TierResult,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Default behavior — confidence ramps so the cascade naturally short-
# circuits at Tier 2/3 unless flags override.
# ---------------------------------------------------------------------------

DEFAULT_TIER_CONFIDENCE: dict[Tier, float] = {
    Tier.ENCODER: 0.70,  # below 0.85 threshold → escalate
    Tier.DENSE_TINY: 0.82,  # crosses 0.80 threshold → short-circuit here
    Tier.DENSE_SMALL: 0.88,
    Tier.DENSE_ANCHOR: 0.92,
    Tier.MOE_LIGHT: 0.95,
    Tier.MOE_HEAVY: 0.97,
}

# 4 model ids per tier — mirrors the 24-student matrix shape.
DEFAULT_TIER_MODELS: dict[Tier, tuple[str, ...]] = {
    Tier.ENCODER: ("m01", "m02", "m03", "m04"),
    Tier.DENSE_TINY: ("m05", "m06", "m07", "m08"),
    Tier.DENSE_SMALL: ("m09", "m10", "m11", "m12"),
    Tier.DENSE_ANCHOR: ("m13", "m14", "m15", "m16"),
    Tier.MOE_LIGHT: ("m17", "m18", "m19", "m20"),
    Tier.MOE_HEAVY: ("m21", "m22", "m23", "m24"),
}

CANONICAL_ROLE_BY_DECISION: dict[tuple[str, str], str] = {
    ("tri-role-collective", "role-for-turn"): "auditor",
    ("debate", "moderator-selection"): "moderator",
    ("expert-panel", "panel-composition"): "coordinator",
    ("consensus", "synthesis-coordinator"): "synthesizer",
    ("parallel-race", "race-candidates"): "candidate",
    ("sensitivity-consensus", "aggregation-method"): "weighted_confidence",
}

DISSENT_ROLE = "dissent-mock"
DISAGREE_ROLE = "disagree-mock"


# ---------------------------------------------------------------------------
# Behavior config — populated from request context flags
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MockCascadeBehavior:
    """Flags that shape the mock cascade for a single request.

    All optional. Built from the request's `context.mockCascade` payload
    in `from_context`; if the payload is missing or malformed, defaults
    are returned (rising-confidence agreement → short-circuit at Tier 2).

    `dissent_at_tier` (singular int) and `dissent_tiers` (frozenset) are
    UNIONed: a tier dissents if it matches either. The plural form lets a
    test force dissent across multiple tiers (e.g. to prevent short-
    circuit and exercise Tier 6 fallthrough); the singular form is the
    common single-tier case.
    """

    dissent_at_tier: int | None = None
    dissent_tiers: frozenset[int] = field(default_factory=frozenset)
    fail_tier: int | None = None
    disagree_tier: int | None = None
    confidence_overrides: Mapping[int, float] = field(default_factory=dict)

    def is_dissent_tier(self, tier_value: int) -> bool:
        return tier_value == self.dissent_at_tier or tier_value in self.dissent_tiers

    @classmethod
    def from_context(cls, context: Mapping[str, Any]) -> MockCascadeBehavior:
        raw = context.get("mockCascade")
        if not isinstance(raw, dict):
            return cls()
        try:
            return cls(
                dissent_at_tier=cls._opt_int(raw.get("dissentAtTier")),
                dissent_tiers=cls._coerce_int_set(raw.get("dissentTiers")),
                fail_tier=cls._opt_int(raw.get("failTier")),
                disagree_tier=cls._opt_int(raw.get("disagreeTier")),
                confidence_overrides=cls._coerce_conf_map(raw.get("confidenceTier")),
            )
        except (TypeError, ValueError) as exc:
            logger.debug("mockCascade flags malformed (%s); using defaults", exc)
            return cls()

    @staticmethod
    def _opt_int(value: Any) -> int | None:
        if value is None:
            return None
        return int(value)

    @staticmethod
    def _coerce_int_set(raw: Any) -> frozenset[int]:
        if not isinstance(raw, (list, tuple, set, frozenset)):
            return frozenset()
        out: set[int] = set()
        for item in raw:
            try:
                out.add(int(item))
            except (TypeError, ValueError):
                continue
        return frozenset(out)

    @staticmethod
    def _coerce_conf_map(raw: Any) -> dict[int, float]:
        if not isinstance(raw, dict):
            return {}
        out: dict[int, float] = {}
        for k, v in raw.items():
            try:
                out[int(k)] = float(v)
            except (TypeError, ValueError):
                continue
        return out


# ---------------------------------------------------------------------------
# Mock executor
# ---------------------------------------------------------------------------


class MockTierExecutor:
    """Synthetic stand-in for a vLLM tier client.

    Behavior is fully derivable from the (request, behavior) pair:
    - canonical role comes from CANONICAL_ROLE_BY_DECISION
    - confidence comes from DEFAULT_TIER_CONFIDENCE (or override)
    - on `dissent_at_tier` matching this tier, half the votes flip role
    - on `disagree_tier` matching this tier, ALL votes flip role
    - on `fail_tier` matching this tier, raises RuntimeError (caught
      by TieredEnsembleVoter's error handler — failed_models tracked)
    """

    def __init__(
        self,
        tier: Tier,
        behavior: MockCascadeBehavior,
        model_ids: tuple[str, ...] | None = None,
    ) -> None:
        self.tier = tier
        self.behavior = behavior
        self.model_ids = model_ids or DEFAULT_TIER_MODELS[tier]

    async def __call__(self, request: Mapping[str, Any]) -> TierResult:
        if self.behavior.fail_tier == int(self.tier):
            # Raise so TieredEnsembleVoter's contract (catch + continue)
            # is exercised. The voter records failed_models for us.
            raise RuntimeError(f"mock-cascade: forced failure at tier {int(self.tier)}")

        canonical = self._canonical_role(request)
        confidence = self.behavior.confidence_overrides.get(
            int(self.tier),
            DEFAULT_TIER_CONFIDENCE[self.tier],
        )

        votes: list[CoordinatorVote] = []
        is_dissent = self.behavior.is_dissent_tier(int(self.tier))
        for idx, model_id in enumerate(self.model_ids):
            role = canonical
            if self.behavior.disagree_tier == int(self.tier):
                role = DISAGREE_ROLE
            elif is_dissent and idx % 2 == 1:
                role = DISSENT_ROLE
            votes.append(
                CoordinatorVote(
                    model_id=model_id,
                    scheduler=f"coord-{model_id}-mock",
                    tier=self.tier,
                    role=role,
                    reason="task-type-match",
                    confidence=confidence,
                    rationale=f"mock-cascade tier-{int(self.tier)}",
                )
            )

        return TierResult(tier=self.tier, votes=tuple(votes), failed_models=())

    @staticmethod
    def _canonical_role(request: Mapping[str, Any]) -> str:
        strategy = str(request.get("strategy", ""))
        decision_type = str(request.get("decision_type") or request.get("decisionType") or "")
        return CANONICAL_ROLE_BY_DECISION.get((strategy, decision_type), "fallback-default")


# ---------------------------------------------------------------------------
# Cascade decision entrypoint
# ---------------------------------------------------------------------------


async def mock_cascade_decide(
    strategy: str,
    decision_type: str,
    context: Mapping[str, Any],
) -> AggregatedDecision:
    """Run the real TieredEnsembleVoter with mock executors per tier.

    The output is an AggregatedDecision identical in shape to what
    REAL_ENSEMBLE will produce — tests can use this to validate
    cascade short-circuit, dissent escalation, failure handling, and
    Tier 6 fallthrough through the same code path that production
    will use.
    """
    behavior = MockCascadeBehavior.from_context(context)
    executors = {tier: MockTierExecutor(tier, behavior) for tier in Tier}
    voter = TieredEnsembleVoter(
        tier_executors=executors,
        config=EnsembleConfig(),
    )
    request_payload = {
        "strategy": strategy,
        "decision_type": decision_type,
        "context": dict(context),
    }
    decision = await voter.decide(request_payload)
    # Tag the scheduler so consumers can distinguish mock-cascade from
    # the real production scheduler tag.
    return AggregatedDecision(
        role=decision.role,
        reason=decision.reason,
        scheduler="mock-cascade-24-tiered",
        confidence=decision.confidence,
        aggregation_method=decision.aggregation_method,
        tier_results=decision.tier_results,
        vote_distribution=decision.vote_distribution,
        total_votes=decision.total_votes,
        dissent_count=decision.dissent_count,
        tiers_activated=decision.tiers_activated,
        final_tier=decision.final_tier,
        short_circuited=decision.short_circuited,
    )
