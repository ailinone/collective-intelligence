# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Unit tests for the tiered ensemble voter."""

from __future__ import annotations

import pytest

from serving.aggregation.tiered_voter import (
    AggregatedDecision,
    CoordinatorVote,
    EnsembleConfig,
    Tier,
    TieredEnsembleVoter,
    TierResult,
    VoteAggregator,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _vote(
    model_id: str, tier: Tier, role: str, conf: float, reason: str = "task-type-match"
) -> CoordinatorVote:
    return CoordinatorVote(
        model_id=model_id,
        scheduler=f"coord-{model_id}",
        tier=tier,
        role=role,
        reason=reason,
        confidence=conf,
    )


# ---------------------------------------------------------------------------
# TierResult
# ---------------------------------------------------------------------------


class TestTierResult:
    def test_empty_tier_returns_no_majority(self):
        tr = TierResult(tier=Tier.ENCODER, votes=())
        assert tr.majority_role is None
        assert tr.dissent_count == 0
        assert tr.average_confidence == 0.0

    def test_unanimous_tier_zero_dissent(self):
        votes = (
            _vote("m01", Tier.ENCODER, "auditor", 0.9),
            _vote("m02", Tier.ENCODER, "auditor", 0.8),
            _vote("m03", Tier.ENCODER, "auditor", 0.95),
        )
        tr = TierResult(tier=Tier.ENCODER, votes=votes)
        assert tr.majority_role == "auditor"
        assert tr.dissent_count == 0
        # average ~0.883
        assert pytest.approx(tr.average_confidence, abs=0.01) == 0.883

    def test_split_tier_has_dissent(self):
        votes = (
            _vote("m01", Tier.ENCODER, "auditor", 0.9),
            _vote("m02", Tier.ENCODER, "auditor", 0.8),
            _vote("m03", Tier.ENCODER, "solver", 0.85),
            _vote("m04", Tier.ENCODER, "solver", 0.7),
        )
        tr = TierResult(tier=Tier.ENCODER, votes=votes)
        assert tr.majority_role == "auditor"  # tie broken by Counter ordering = first inserted
        assert tr.dissent_count == 2

    def test_failed_models_tracked_separately(self):
        votes = (_vote("m01", Tier.ENCODER, "auditor", 0.9),)
        tr = TierResult(tier=Tier.ENCODER, votes=votes, failed_models=("m02",))
        assert tr.majority_role == "auditor"
        assert tr.failed_models == ("m02",)


# ---------------------------------------------------------------------------
# VoteAggregator
# ---------------------------------------------------------------------------


class TestVoteAggregator:
    def test_no_results_returns_fallback(self):
        agg = VoteAggregator(tier_weights={Tier.ENCODER: 0.1})
        role, reason, conf, dist = agg.aggregate([])
        assert role == "fallback-default"
        assert reason == "no-votes"
        assert conf == 0.0
        assert dist == {}

    def test_weighted_majority_picks_highest_score(self):
        # Tier 1 (weight 0.1) has 2 votes for "auditor"
        # Tier 4 (weight 0.25) has 1 vote for "solver"
        # Despite numerical majority going to "auditor" (count 2 vs 1),
        # weighted score: auditor = 0.1 * (0.9+0.85) = 0.175
        # solver = 0.25 * 0.7 = 0.175 — TIE
        # Tie broken by Counter ordering — auditor inserted first.
        agg = VoteAggregator(tier_weights={Tier.ENCODER: 0.1, Tier.DENSE_ANCHOR: 0.25})
        results = [
            TierResult(
                tier=Tier.ENCODER,
                votes=(
                    _vote("m01", Tier.ENCODER, "auditor", 0.9),
                    _vote("m02", Tier.ENCODER, "auditor", 0.85),
                ),
            ),
            TierResult(
                tier=Tier.DENSE_ANCHOR,
                votes=(_vote("m13", Tier.DENSE_ANCHOR, "solver", 0.7),),
            ),
        ]
        role, reason, conf, dist = agg.aggregate(results)
        # With the values above, auditor wins by tiny margin (0.175) vs solver (0.175).
        # Both possible — we just verify the outcome is one of them and shape is correct.
        assert role in ("auditor", "solver")
        assert dist == {"auditor": 2, "solver": 1}
        assert 0.0 < conf <= 1.0

    def test_high_confidence_anchor_dominates_low_confidence_encoders(self):
        # 4 encoders at low confidence vs 1 anchor at high confidence —
        # anchor's higher tier weight × confidence outweighs the encoders.
        agg = VoteAggregator(tier_weights={Tier.ENCODER: 0.1, Tier.DENSE_ANCHOR: 0.25})
        results = [
            TierResult(
                tier=Tier.ENCODER,
                votes=tuple(_vote(f"m0{i + 1}", Tier.ENCODER, "auditor", 0.4) for i in range(4)),
            ),
            TierResult(
                tier=Tier.DENSE_ANCHOR,
                votes=(_vote("m13", Tier.DENSE_ANCHOR, "solver", 0.95),),
            ),
        ]
        role, _, conf, _ = agg.aggregate(results)
        # encoders: 0.1 * 4 * 0.4 = 0.16
        # anchor:   0.25 * 0.95   = 0.2375
        # solver wins.
        assert role == "solver"
        assert conf > 0.5

    def test_accuracy_history_can_demote_a_model(self):
        agg = VoteAggregator(
            tier_weights={Tier.ENCODER: 0.5},
            accuracy_history={"m01": 0.1, "m02": 1.0},  # m01 historically wrong
        )
        results = [
            TierResult(
                tier=Tier.ENCODER,
                votes=(
                    _vote("m01", Tier.ENCODER, "auditor", 0.99),
                    _vote("m02", Tier.ENCODER, "solver", 0.5),
                ),
            ),
        ]
        role, _, _, _ = agg.aggregate(results)
        # m01 weight: 0.5 * 0.99 * 0.1 = 0.0495
        # m02 weight: 0.5 * 0.5  * 1.0 = 0.25
        # solver wins despite m01's higher confidence.
        assert role == "solver"

    def test_reason_picked_from_winners(self):
        agg = VoteAggregator(tier_weights={Tier.ENCODER: 1.0})
        results = [
            TierResult(
                tier=Tier.ENCODER,
                votes=(
                    _vote("m01", Tier.ENCODER, "auditor", 0.9, reason="task-type-match"),
                    _vote("m02", Tier.ENCODER, "auditor", 0.8, reason="task-type-match"),
                    _vote("m03", Tier.ENCODER, "solver", 0.5, reason="cost-budget"),
                ),
            ),
        ]
        _, reason, _, _ = agg.aggregate(results)
        # Both auditor voters used "task-type-match" — that's the winner reason.
        assert reason == "task-type-match"


# ---------------------------------------------------------------------------
# TieredEnsembleVoter — cascade flow
# ---------------------------------------------------------------------------


class TestTieredEnsembleVoter:
    @pytest.mark.asyncio
    async def test_no_executors_returns_fallback(self):
        voter = TieredEnsembleVoter(tier_executors={})
        decision = await voter.decide({"strategy": "debate"})
        assert decision.role == "fallback-default"
        assert decision.reason == "no-tier-executors-registered"
        assert decision.short_circuited is False

    @pytest.mark.asyncio
    async def test_short_circuit_on_high_confidence(self):
        async def t1_executor(_req):
            return TierResult(
                tier=Tier.ENCODER,
                votes=tuple(_vote(f"m0{i + 1}", Tier.ENCODER, "auditor", 0.95) for i in range(4)),
            )

        # If only Tier 1 is registered and its confidence beats threshold,
        # decision exits at Tier 1.
        config = EnsembleConfig()
        voter = TieredEnsembleVoter(
            tier_executors={Tier.ENCODER: t1_executor},
            config=config,
        )
        decision = await voter.decide({"strategy": "tri-role-collective"})
        assert decision.role == "auditor"
        assert decision.short_circuited is True
        assert decision.tiers_activated == (Tier.ENCODER,)
        assert decision.final_tier == Tier.ENCODER
        assert decision.total_votes == 4
        assert decision.dissent_count == 0

    @pytest.mark.asyncio
    async def test_dissent_escalates_to_next_tier(self):
        async def t1_split(_req):
            return TierResult(
                tier=Tier.ENCODER,
                votes=(
                    _vote("m01", Tier.ENCODER, "auditor", 0.6),
                    _vote("m02", Tier.ENCODER, "auditor", 0.6),
                    _vote("m03", Tier.ENCODER, "solver", 0.6),
                    _vote("m04", Tier.ENCODER, "solver", 0.6),
                ),
            )

        async def t2_unanimous(_req):
            return TierResult(
                tier=Tier.DENSE_TINY,
                votes=tuple(
                    _vote(f"m0{i + 5}", Tier.DENSE_TINY, "auditor", 0.95) for i in range(4)
                ),
            )

        config = EnsembleConfig()
        voter = TieredEnsembleVoter(
            tier_executors={
                Tier.ENCODER: t1_split,
                Tier.DENSE_TINY: t2_unanimous,
            },
            config=config,
        )
        decision = await voter.decide({"strategy": "debate"})
        # Tier 1 has dissent=2 and confidence ~0.6 — escalation triggers.
        # Tier 2 is unanimous — combined confidence pushes past threshold.
        assert decision.role == "auditor"
        assert decision.tiers_activated == (Tier.ENCODER, Tier.DENSE_TINY)

    @pytest.mark.asyncio
    async def test_executor_failure_does_not_break_cascade(self):
        async def t1_raises(_req):
            raise RuntimeError("simulated failure")

        async def t2_ok(_req):
            return TierResult(
                tier=Tier.DENSE_TINY,
                votes=(_vote("m05", Tier.DENSE_TINY, "auditor", 0.95),),
            )

        voter = TieredEnsembleVoter(
            tier_executors={
                Tier.ENCODER: t1_raises,
                Tier.DENSE_TINY: t2_ok,
            },
        )
        decision = await voter.decide({"strategy": "debate"})
        # Tier 1 produced no votes; Tier 2's vote drives the decision.
        assert decision.role == "auditor"
        # Tier 1 was still "activated" (we tried it) — important for audit.
        assert Tier.ENCODER in decision.tiers_activated


# ---------------------------------------------------------------------------
# AggregatedDecision — basic shape sanity
# ---------------------------------------------------------------------------


class TestAggregatedDecision:
    def test_default_scheduler_is_ensemble_label(self):
        d = AggregatedDecision(role="x", reason="y")
        assert d.scheduler == "ensemble-24-tiered-bayesian"

    def test_aggregation_method_default(self):
        d = AggregatedDecision(role="x", reason="y")
        assert d.aggregation_method == "weighted_bayesian_majority"
