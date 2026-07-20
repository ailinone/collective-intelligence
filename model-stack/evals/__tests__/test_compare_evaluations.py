# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for compare_evaluations.py — champion vs challenger gating logic."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _make_report(
    role_accuracy: float,
    brier_score: float,
    total_records: int = 1000,
    per_strategy: dict | None = None,
) -> dict:
    return {
        "decider_label": "test",
        "total_records": total_records,
        "role_accuracy": role_accuracy,
        "reason_match_rate": 0.5,
        "brier_score": brier_score,
        "role_matches": int(total_records * role_accuracy),
        "reason_matches": int(total_records * 0.5),
        "per_strategy": per_strategy or {},
        "role_confusion": {},
        "divergence_samples": [],
    }


# ---------------------------------------------------------------------------
# Core decision branches
# ---------------------------------------------------------------------------


class TestCompareDecisions:
    def test_promote_on_meaningful_improvement(self):
        from evals.compare_evaluations import compare

        champion = _make_report(role_accuracy=0.80, brier_score=0.18)
        challenger = _make_report(role_accuracy=0.85, brier_score=0.15)

        report = compare(champion, challenger, min_improvement_pp=2.0)
        assert report.decision == "promote"
        assert report.role_accuracy_delta_pp == pytest.approx(5.0)
        assert "+5.00pp" in report.reason or "5.00" in report.reason

    def test_reject_on_any_accuracy_drop(self):
        from evals.compare_evaluations import compare

        champion = _make_report(role_accuracy=0.85, brier_score=0.15)
        challenger = _make_report(role_accuracy=0.84, brier_score=0.15)

        report = compare(champion, challenger)
        assert report.decision == "reject"
        assert "below champion" in report.reason

    def test_inconclusive_on_below_threshold_improvement(self):
        from evals.compare_evaluations import compare

        champion = _make_report(role_accuracy=0.80, brier_score=0.18)
        challenger = _make_report(role_accuracy=0.81, brier_score=0.18)

        report = compare(champion, challenger, min_improvement_pp=2.0)
        assert report.decision == "inconclusive"
        assert "below" in report.reason and "threshold" in report.reason

    def test_reject_on_brier_regression_even_with_accuracy_gain(self):
        from evals.compare_evaluations import compare

        champion = _make_report(role_accuracy=0.80, brier_score=0.10)
        # Big accuracy gain but brier explodes
        challenger = _make_report(role_accuracy=0.90, brier_score=0.40)

        report = compare(champion, challenger, max_brier_regression=0.05)
        assert report.decision == "inconclusive"
        assert "brier regression" in report.reason


# ---------------------------------------------------------------------------
# Per-strategy regression protection
# ---------------------------------------------------------------------------


class TestPerStrategyProtection:
    def test_reject_when_one_strategy_regresses_despite_average_gain(self):
        """Average-only gating misses Simpson's-paradox regressions.

        If 4 strategies improve a lot and 1 regresses catastrophically,
        the average looks great but production is worse on the
        regressed slice. compare() must reject.
        """
        from evals.compare_evaluations import compare

        # Champion is uniformly meh
        champion_per_strategy = {
            f"s{i}/decision": {"total": 100, "role_accuracy": 0.7, "brier_score": 0.2}
            for i in range(5)
        }
        # Challenger: 4 huge wins + 1 catastrophic loss
        challenger_per_strategy = {
            "s0/decision": {"total": 100, "role_accuracy": 0.95, "brier_score": 0.05},
            "s1/decision": {"total": 100, "role_accuracy": 0.95, "brier_score": 0.05},
            "s2/decision": {"total": 100, "role_accuracy": 0.95, "brier_score": 0.05},
            "s3/decision": {"total": 100, "role_accuracy": 0.95, "brier_score": 0.05},
            "s4/decision": {"total": 100, "role_accuracy": 0.30, "brier_score": 0.50},  # disaster
        }
        champion = _make_report(
            role_accuracy=0.7,
            brier_score=0.2,
            per_strategy=champion_per_strategy,
        )
        challenger = _make_report(
            role_accuracy=0.82,  # average looks great
            brier_score=0.14,
            per_strategy=challenger_per_strategy,
        )

        report = compare(
            champion,
            challenger,
            max_per_strategy_drop_pp=5.0,
            max_brier_regression=0.05,
        )
        assert report.decision == "reject"
        assert "s4/decision" in report.regressed_strategies
        assert "per-strategy regression" in report.reason

    def test_promote_when_all_strategies_improve_uniformly(self):
        from evals.compare_evaluations import compare

        champion_per_strategy = {
            f"s{i}/decision": {"total": 100, "role_accuracy": 0.7, "brier_score": 0.2}
            for i in range(3)
        }
        challenger_per_strategy = {
            f"s{i}/decision": {"total": 100, "role_accuracy": 0.85, "brier_score": 0.15}
            for i in range(3)
        }
        champion = _make_report(
            role_accuracy=0.7, brier_score=0.2, per_strategy=champion_per_strategy
        )
        challenger = _make_report(
            role_accuracy=0.85, brier_score=0.15, per_strategy=challenger_per_strategy
        )

        report = compare(champion, challenger)
        assert report.decision == "promote"
        assert report.regressed_strategies == []

    def test_strategy_present_in_one_side_only(self):
        """Operators must notice when the strategy set differs between
        runs (different sft-coord input or partial training). Treat as
        zero-records on the missing side and report it via per-strategy
        rows but don't auto-reject."""
        from evals.compare_evaluations import compare

        champion = _make_report(
            role_accuracy=0.85,
            brier_score=0.10,
            per_strategy={
                "s1/decision": {"total": 100, "role_accuracy": 0.85, "brier_score": 0.10}
            },
        )
        challenger = _make_report(
            role_accuracy=0.90,
            brier_score=0.08,
            per_strategy={
                "s1/decision": {"total": 100, "role_accuracy": 0.90, "brier_score": 0.08},
                "s2/decision": {"total": 100, "role_accuracy": 0.90, "brier_score": 0.08},
            },
        )

        report = compare(champion, challenger)
        # s2 wasn't in champion (champion_total=0, champion_accuracy=0)
        # — challenger's 0.90 looks like a +0.90 win, not a regression.
        # This shouldn't trigger a reject.
        assert report.decision == "promote"
        assert len(report.per_strategy) == 2


# ---------------------------------------------------------------------------
# Loader + CLI
# ---------------------------------------------------------------------------


class TestLoader:
    def test_load_report_validates_required_keys(self, tmp_path: Path):
        from evals.compare_evaluations import load_report

        bad_path = tmp_path / "bad.json"
        bad_path.write_text(json.dumps({"foo": "bar"}), encoding="utf-8")

        with pytest.raises(ValueError, match="missing required keys"):
            load_report(bad_path)

    def test_load_report_happy_path(self, tmp_path: Path):
        from evals.compare_evaluations import load_report

        good_path = tmp_path / "good.json"
        good_path.write_text(
            json.dumps(_make_report(0.85, 0.15)),
            encoding="utf-8",
        )

        loaded = load_report(good_path)
        assert loaded["role_accuracy"] == 0.85


class TestCli:
    def test_cli_promote_path(self, tmp_path: Path):
        from click.testing import CliRunner

        from evals.compare_evaluations import cli

        champ_path = tmp_path / "champion.json"
        chall_path = tmp_path / "challenger.json"
        out_path = tmp_path / "comparison.json"
        champ_path.write_text(json.dumps(_make_report(0.80, 0.18)), encoding="utf-8")
        chall_path.write_text(json.dumps(_make_report(0.85, 0.15)), encoding="utf-8")

        result = CliRunner().invoke(
            cli,
            [
                "--champion",
                str(champ_path),
                "--challenger",
                str(chall_path),
                "--output",
                str(out_path),
            ],
        )

        assert result.exit_code == 0, result.output
        assert "PROMOTE" in result.output
        comparison = json.loads(out_path.read_text(encoding="utf-8"))
        assert comparison["decision"] == "promote"

    def test_cli_reject_with_exit_code(self, tmp_path: Path):
        from click.testing import CliRunner

        from evals.compare_evaluations import cli

        champ_path = tmp_path / "champion.json"
        chall_path = tmp_path / "challenger.json"
        out_path = tmp_path / "comparison.json"
        champ_path.write_text(json.dumps(_make_report(0.85, 0.15)), encoding="utf-8")
        chall_path.write_text(
            json.dumps(_make_report(0.80, 0.20)),
            encoding="utf-8",  # worse
        )

        result = CliRunner().invoke(
            cli,
            [
                "--champion",
                str(champ_path),
                "--challenger",
                str(chall_path),
                "--output",
                str(out_path),
                "--exit-nonzero-on-reject",
            ],
        )

        assert result.exit_code == 1, "should exit nonzero on reject"
        assert "REJECT" in result.output
