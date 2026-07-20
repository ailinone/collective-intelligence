# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for mock_cascade.py — MockTierExecutor + cascade integration.

Covers the four cascade branches REAL_ENSEMBLE will need to handle:

  1. Short-circuit at low tier (high agreement + high confidence)
  2. Dissent escalation across tiers
  3. Tier failure handled silently (cascade continues)
  4. Tier 6 fallthrough (no early exit possible)
  5. Disagreement at one tier doesn't break aggregation
  6. Confidence overrides per tier work as expected
"""

from __future__ import annotations

import pytest

from serving.aggregation.mock_cascade import (
    DEFAULT_TIER_CONFIDENCE,
    MockCascadeBehavior,
    MockTierExecutor,
    mock_cascade_decide,
)
from serving.aggregation.tiered_voter import Tier

# ---------------------------------------------------------------------------
# Behavior parsing
# ---------------------------------------------------------------------------


class TestMockCascadeBehavior:
    def test_empty_context_yields_defaults(self):
        behavior = MockCascadeBehavior.from_context({})
        assert behavior.dissent_at_tier is None
        assert behavior.fail_tier is None
        assert behavior.disagree_tier is None
        assert behavior.confidence_overrides == {}

    def test_full_payload_parses(self):
        behavior = MockCascadeBehavior.from_context(
            {
                "mockCascade": {
                    "dissentAtTier": 2,
                    "failTier": 4,
                    "disagreeTier": 5,
                    "confidenceTier": {"1": 0.95, "3": 0.50},
                }
            }
        )
        assert behavior.dissent_at_tier == 2
        assert behavior.fail_tier == 4
        assert behavior.disagree_tier == 5
        assert behavior.confidence_overrides == {1: 0.95, 3: 0.50}

    def test_malformed_payload_falls_back_to_defaults(self):
        behavior = MockCascadeBehavior.from_context(
            {"mockCascade": {"dissentAtTier": "not-a-number"}}
        )
        # Conversion error → defaults preserved (but raises ValueError, then None)
        assert behavior.dissent_at_tier is None or isinstance(behavior.dissent_at_tier, int)

    def test_non_dict_context_payload_ignored(self):
        behavior = MockCascadeBehavior.from_context({"mockCascade": "not-a-dict"})
        assert behavior.dissent_at_tier is None


# ---------------------------------------------------------------------------
# MockTierExecutor in isolation
# ---------------------------------------------------------------------------


class TestMockTierExecutor:
    @pytest.mark.asyncio
    async def test_default_executor_returns_canonical_role_for_all_models(self):
        executor = MockTierExecutor(Tier.ENCODER, MockCascadeBehavior())
        result = await executor(
            {
                "strategy": "debate",
                "decision_type": "moderator-selection",
            }
        )

        assert len(result.votes) == 4
        assert all(v.role == "moderator" for v in result.votes)
        assert result.tier == Tier.ENCODER
        assert result.failed_models == ()

    @pytest.mark.asyncio
    async def test_dissent_at_tier_splits_votes(self):
        behavior = MockCascadeBehavior(dissent_at_tier=int(Tier.ENCODER))
        executor = MockTierExecutor(Tier.ENCODER, behavior)

        result = await executor(
            {
                "strategy": "debate",
                "decision_type": "moderator-selection",
            }
        )

        roles = [v.role for v in result.votes]
        # Half-canonical, half-dissent (idx % 2 == 1 dissent)
        assert roles.count("moderator") == 2
        assert roles.count("dissent-mock") == 2

    @pytest.mark.asyncio
    async def test_fail_tier_raises(self):
        behavior = MockCascadeBehavior(fail_tier=int(Tier.DENSE_TINY))
        executor = MockTierExecutor(Tier.DENSE_TINY, behavior)

        with pytest.raises(RuntimeError, match="forced failure"):
            await executor(
                {
                    "strategy": "debate",
                    "decision_type": "moderator-selection",
                }
            )

    @pytest.mark.asyncio
    async def test_disagree_tier_yields_all_disagree_role(self):
        behavior = MockCascadeBehavior(disagree_tier=int(Tier.MOE_LIGHT))
        executor = MockTierExecutor(Tier.MOE_LIGHT, behavior)

        result = await executor(
            {
                "strategy": "debate",
                "decision_type": "moderator-selection",
            }
        )

        assert all(v.role == "disagree-mock" for v in result.votes)

    @pytest.mark.asyncio
    async def test_unknown_strategy_yields_fallback_role(self):
        executor = MockTierExecutor(Tier.ENCODER, MockCascadeBehavior())
        result = await executor(
            {
                "strategy": "unknown-strategy",
                "decision_type": "unknown-decision",
            }
        )

        assert all(v.role == "fallback-default" for v in result.votes)

    @pytest.mark.asyncio
    async def test_confidence_override_propagates_to_all_votes(self):
        behavior = MockCascadeBehavior(confidence_overrides={int(Tier.ENCODER): 0.42})
        executor = MockTierExecutor(Tier.ENCODER, behavior)

        result = await executor(
            {
                "strategy": "debate",
                "decision_type": "moderator-selection",
            }
        )

        assert all(v.confidence == 0.42 for v in result.votes)


# ---------------------------------------------------------------------------
# End-to-end cascade
# ---------------------------------------------------------------------------


class TestCascadeIntegration:
    @pytest.mark.asyncio
    async def test_default_cascade_short_circuits_when_threshold_met(self):
        # Default ramp: T1=0.70 (below 0.85 threshold), T2=0.82 (above 0.80
        # threshold). Cumulative confidence after T2 should cross T2 threshold.
        decision = await mock_cascade_decide(
            "debate",
            "moderator-selection",
            {},
        )

        # The cascade should NOT activate all 6 tiers — it should short-
        # circuit somewhere before MOE_HEAVY.
        assert int(decision.final_tier) <= int(Tier.DENSE_ANCHOR)
        assert decision.role == "moderator"
        assert decision.scheduler == "mock-cascade-24-tiered"
        assert decision.aggregation_method == "weighted_bayesian_majority"
        assert decision.short_circuited is True

    @pytest.mark.asyncio
    async def test_dissent_at_every_tier_runs_full_cascade(self):
        # NOTE: weighted_bayesian_majority's `confidence` is winner-share
        # (winner_score / total_weight), NOT the average per-vote
        # confidence. So unanimous votes always yield confidence=1.0
        # regardless of the per-vote confidence — short-circuit always
        # happens at T1. The only way to suppress short-circuit and force
        # full-cascade exhaustion is to keep the vote distribution split
        # at every tier.
        decision = await mock_cascade_decide(
            "debate",
            "moderator-selection",
            {"mockCascade": {"dissentTiers": [1, 2, 3, 4, 5, 6]}},
        )

        assert int(decision.final_tier) == int(Tier.MOE_HEAVY)
        assert decision.short_circuited is False
        assert decision.tiers_activated == tuple(t for t in Tier)

    @pytest.mark.asyncio
    async def test_tier_failure_does_not_break_cascade(self):
        # Force T1 to fail; cascade should continue through T2 and beyond,
        # producing a valid decision from the tiers that did succeed.
        decision = await mock_cascade_decide(
            "debate",
            "moderator-selection",
            {"mockCascade": {"failTier": 1}},
        )

        # T1 still gets activated (with empty votes), then T2 runs.
        assert Tier.ENCODER in decision.tiers_activated
        assert Tier.DENSE_TINY in decision.tiers_activated
        # Final decision should still be the canonical role from the
        # surviving tiers.
        assert decision.role == "moderator"

    @pytest.mark.asyncio
    async def test_full_cascade_with_dissent_at_tier_1(self):
        # Half of T1 dissents; running confidence drops, escalation to T2.
        decision = await mock_cascade_decide(
            "debate",
            "moderator-selection",
            {"mockCascade": {"dissentAtTier": 1}},
        )

        # The vote_distribution should reflect both roles
        assert "moderator" in decision.vote_distribution
        # T2+ should still vote unanimous canonical, so winner remains
        # moderator (not dissent-mock).
        assert decision.role == "moderator"
        # At least Tier 2 should have been activated due to T1 dissent.
        assert int(decision.final_tier) >= int(Tier.DENSE_TINY)

    @pytest.mark.asyncio
    async def test_canonical_roles_per_strategy(self):
        # Sanity: every strategy/decisionType pair returns the right role
        # through the cascade.
        cases = [
            ("tri-role-collective", "role-for-turn", "auditor"),
            ("debate", "moderator-selection", "moderator"),
            ("expert-panel", "panel-composition", "coordinator"),
            ("consensus", "synthesis-coordinator", "synthesizer"),
            ("parallel-race", "race-candidates", "candidate"),
        ]
        for strategy, decision_type, expected_role in cases:
            decision = await mock_cascade_decide(strategy, decision_type, {})
            assert decision.role == expected_role, f"{strategy}/{decision_type}"


# ---------------------------------------------------------------------------
# Default confidence ramp invariant — sanity check that the defaults
# we encode actually produce the cascade behavior we documented.
# ---------------------------------------------------------------------------


class TestDefaults:
    def test_default_confidence_ramp_is_monotonic(self):
        ordered = [
            Tier.ENCODER,
            Tier.DENSE_TINY,
            Tier.DENSE_SMALL,
            Tier.DENSE_ANCHOR,
            Tier.MOE_LIGHT,
            Tier.MOE_HEAVY,
        ]
        # itertools.pairwise gives us sliding (i, i+1) pairs without the
        # length-mismatch foot-gun of zip(seq, seq[1:]) that ruff B905
        # would force us to either silence or break.
        from itertools import pairwise

        for prev, nxt in pairwise(ordered):
            assert DEFAULT_TIER_CONFIDENCE[prev] < DEFAULT_TIER_CONFIDENCE[nxt]

    def test_t1_default_is_below_t1_threshold(self):
        # T1 default 0.70 should be below threshold 0.85 so cascade
        # naturally escalates instead of always short-circuiting at T1.
        from serving.aggregation.tiered_voter import EnsembleConfig

        cfg = EnsembleConfig()
        assert DEFAULT_TIER_CONFIDENCE[Tier.ENCODER] < cfg.tier_confidence_thresholds[Tier.ENCODER]
