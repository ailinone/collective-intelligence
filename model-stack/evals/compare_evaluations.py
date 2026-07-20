# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Compare two eval reports (champion vs challenger) for promote/rollback decisions.
======================================================================================

Consumes two JSON reports produced by `evaluate_coord_decisions.py`
and computes the deltas + a structured promote/rollback recommendation
based on configurable thresholds.

Pipeline shape:
    sft-coord-*.jsonl
        ↓
    evaluate_coord_decisions.py (champion: current production decider)
        ↓ champion-report.json
        +
    evaluate_coord_decisions.py (challenger: trained candidate)
        ↓ challenger-report.json
        +
    compare_evaluations.py (this module)
        ↓ comparison.json + decision (promote | reject | inconclusive)

Decision logic (mirrors `coord-stable/_shared.yaml` promotion thresholds):
    promote when:
      - challenger.role_accuracy >= champion.role_accuracy + min_improvement_pp
      - challenger.brier_score <= champion.brier_score + max_brier_regression
      - per-strategy regressions are within tolerance (no slice gets
        meaningfully worse, even if the average improves)
    reject when:
      - challenger.role_accuracy is BELOW champion (any drop is bad)
      - per-strategy regression beyond tolerance
    inconclusive otherwise (improvement within noise floor)

Usage:
    python -m evals.compare_evaluations \\
        --champion ./eval-results/champion.json \\
        --challenger ./eval-results/challenger.json \\
        --output ./eval-results/comparison-2026-05-05.json \\
        --min-improvement-pp 2.0 \\
        --max-brier-regression 0.05
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import click

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Decision shapes
# ---------------------------------------------------------------------------

Decision = Literal["promote", "reject", "inconclusive"]


@dataclass
class StrategyDelta:
    """Per-strategy comparison row."""

    strategy_key: str
    champion_total: int
    challenger_total: int
    champion_accuracy: float
    challenger_accuracy: float
    accuracy_delta: float
    champion_brier: float
    challenger_brier: float
    brier_delta: float

    def regressed(self, max_accuracy_drop_pp: float, max_brier_regression: float) -> bool:
        """True if this strategy got meaningfully worse on either metric.

        Skipped when either side has zero records — a missing slice is
        a coverage-mismatch signal (operators should investigate the
        sft-coord input drift), NOT a regression. Without this guard,
        a missing-on-champion strategy lights up as `champion_brier=0`
        (perfect) vs `challenger_brier=0.08` (8 points worse), tripping
        the regression gate even though the strategy is genuinely new.
        """
        if self.champion_total == 0 or self.challenger_total == 0:
            return False
        accuracy_drop = self.champion_accuracy - self.challenger_accuracy
        brier_increase = self.challenger_brier - self.champion_brier
        return accuracy_drop > max_accuracy_drop_pp / 100.0 or brier_increase > max_brier_regression


@dataclass
class ComparisonReport:
    """Top-level comparison output."""

    decision: Decision
    reason: str
    champion_role_accuracy: float
    challenger_role_accuracy: float
    role_accuracy_delta_pp: float
    champion_brier: float
    challenger_brier: float
    brier_delta: float
    champion_total: int
    challenger_total: int
    per_strategy: list[StrategyDelta] = field(default_factory=list)
    regressed_strategies: list[str] = field(default_factory=list)
    threshold_min_improvement_pp: float = 2.0
    threshold_max_brier_regression: float = 0.05
    threshold_max_per_strategy_drop_pp: float = 5.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "reason": self.reason,
            "champion": {
                "role_accuracy": self.champion_role_accuracy,
                "brier_score": self.champion_brier,
                "total_records": self.champion_total,
            },
            "challenger": {
                "role_accuracy": self.challenger_role_accuracy,
                "brier_score": self.challenger_brier,
                "total_records": self.challenger_total,
            },
            "deltas": {
                "role_accuracy_pp": self.role_accuracy_delta_pp,
                "brier": self.brier_delta,
            },
            "per_strategy": [
                {
                    "strategy_key": s.strategy_key,
                    "champion": {
                        "total": s.champion_total,
                        "accuracy": s.champion_accuracy,
                        "brier": s.champion_brier,
                    },
                    "challenger": {
                        "total": s.challenger_total,
                        "accuracy": s.challenger_accuracy,
                        "brier": s.challenger_brier,
                    },
                    "accuracy_delta": s.accuracy_delta,
                    "brier_delta": s.brier_delta,
                }
                for s in self.per_strategy
            ],
            "regressed_strategies": self.regressed_strategies,
            "thresholds": {
                "min_improvement_pp": self.threshold_min_improvement_pp,
                "max_brier_regression": self.threshold_max_brier_regression,
                "max_per_strategy_drop_pp": self.threshold_max_per_strategy_drop_pp,
            },
        }


# ---------------------------------------------------------------------------
# Loader + comparison
# ---------------------------------------------------------------------------


def load_report(path: Path) -> dict[str, Any]:
    """Load and minimally validate an eval report."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    required = ("role_accuracy", "brier_score", "total_records", "per_strategy")
    missing = [k for k in required if k not in raw]
    if missing:
        raise ValueError(f"Report at {path} missing required keys: {missing}")
    return raw


def _build_strategy_deltas(
    champion: dict[str, Any],
    challenger: dict[str, Any],
) -> list[StrategyDelta]:
    """Per-strategy diff over the union of strategy keys.

    A strategy missing from one side is treated as zero-records on that
    side (no regression credit, no improvement penalty — operators
    notice via the records-mismatch warning).
    """
    champ_strategies = champion.get("per_strategy") or {}
    chal_strategies = challenger.get("per_strategy") or {}
    keys = sorted(set(champ_strategies.keys()) | set(chal_strategies.keys()))

    deltas: list[StrategyDelta] = []
    for key in keys:
        ch = champ_strategies.get(key) or {}
        cl = chal_strategies.get(key) or {}
        champ_acc = float(ch.get("role_accuracy", 0.0))
        chal_acc = float(cl.get("role_accuracy", 0.0))
        champ_brier = float(ch.get("brier_score", 0.0))
        chal_brier = float(cl.get("brier_score", 0.0))
        deltas.append(
            StrategyDelta(
                strategy_key=key,
                champion_total=int(ch.get("total", 0)),
                challenger_total=int(cl.get("total", 0)),
                champion_accuracy=champ_acc,
                challenger_accuracy=chal_acc,
                accuracy_delta=chal_acc - champ_acc,
                champion_brier=champ_brier,
                challenger_brier=chal_brier,
                brier_delta=chal_brier - champ_brier,
            )
        )
    return deltas


def compare(
    champion: dict[str, Any],
    challenger: dict[str, Any],
    *,
    min_improvement_pp: float = 2.0,
    max_brier_regression: float = 0.05,
    max_per_strategy_drop_pp: float = 5.0,
) -> ComparisonReport:
    """Compare two eval reports and produce a promote/reject decision.

    Decision rules (in order):
      1. If challenger overall accuracy is BELOW champion → reject
      2. If any strategy regressed beyond tolerance → reject (per-slice
         protection — an improvement on average can still mask a
         catastrophic regression on one strategy)
      3. If overall accuracy improvement >= min_improvement_pp AND brier
         doesn't regress beyond max_brier_regression → promote
      4. Otherwise → inconclusive (improvement within noise floor)

    All thresholds are configurable; defaults match coord-stable/_shared.yaml.
    """
    champ_acc = float(champion["role_accuracy"])
    chal_acc = float(challenger["role_accuracy"])
    champ_brier = float(champion["brier_score"])
    chal_brier = float(challenger["brier_score"])
    accuracy_delta_pp = (chal_acc - champ_acc) * 100.0
    brier_delta = chal_brier - champ_brier

    per_strategy = _build_strategy_deltas(champion, challenger)
    regressed = [
        s.strategy_key
        for s in per_strategy
        if s.regressed(max_per_strategy_drop_pp, max_brier_regression)
    ]

    # Decision tree
    decision: Decision
    reason: str

    if chal_acc < champ_acc:
        decision = "reject"
        reason = (
            f"challenger accuracy {chal_acc:.4f} below champion {champ_acc:.4f} "
            f"(any drop is rejected)"
        )
    elif regressed:
        decision = "reject"
        reason = (
            f"per-strategy regression detected on {len(regressed)} slice(s): {', '.join(regressed)}"
        )
    elif accuracy_delta_pp >= min_improvement_pp and brier_delta <= max_brier_regression:
        decision = "promote"
        reason = (
            f"accuracy gained +{accuracy_delta_pp:.2f}pp "
            f"(>= {min_improvement_pp}pp threshold), "
            f"brier delta {brier_delta:+.4f} within tolerance"
        )
    else:
        decision = "inconclusive"
        reason = (
            f"improvement {accuracy_delta_pp:+.2f}pp below "
            f"{min_improvement_pp}pp threshold OR brier regression "
            f"{brier_delta:+.4f} > {max_brier_regression}"
        )

    return ComparisonReport(
        decision=decision,
        reason=reason,
        champion_role_accuracy=champ_acc,
        challenger_role_accuracy=chal_acc,
        role_accuracy_delta_pp=accuracy_delta_pp,
        champion_brier=champ_brier,
        challenger_brier=chal_brier,
        brier_delta=brier_delta,
        champion_total=int(champion["total_records"]),
        challenger_total=int(challenger["total_records"]),
        per_strategy=per_strategy,
        regressed_strategies=regressed,
        threshold_min_improvement_pp=min_improvement_pp,
        threshold_max_brier_regression=max_brier_regression,
        threshold_max_per_strategy_drop_pp=max_per_strategy_drop_pp,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command()
@click.option(
    "--champion",
    "champion_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Path to champion eval report JSON (current production)",
)
@click.option(
    "--challenger",
    "challenger_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Path to challenger eval report JSON (candidate)",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=True,
    help="Where to write the comparison JSON",
)
@click.option(
    "--min-improvement-pp",
    type=float,
    default=2.0,
    show_default=True,
    help="Minimum overall accuracy improvement (in percentage points) required to promote",
)
@click.option(
    "--max-brier-regression",
    type=float,
    default=0.05,
    show_default=True,
    help="Maximum tolerated brier increase (positive number; lower brier is better)",
)
@click.option(
    "--max-per-strategy-drop-pp",
    type=float,
    default=5.0,
    show_default=True,
    help="Maximum tolerated per-strategy accuracy drop in percentage points",
)
@click.option(
    "--exit-nonzero-on-reject",
    is_flag=True,
    help="Exit with code 1 when decision=reject (CI-friendly gate)",
)
def cli(
    champion_path: Path,
    challenger_path: Path,
    output_path: Path,
    min_improvement_pp: float,
    max_brier_regression: float,
    max_per_strategy_drop_pp: float,
    exit_nonzero_on_reject: bool,
) -> None:
    """Compare two eval reports and emit a promote/reject decision."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    champion = load_report(champion_path)
    challenger = load_report(challenger_path)

    report = compare(
        champion,
        challenger,
        min_improvement_pp=min_improvement_pp,
        max_brier_regression=max_brier_regression,
        max_per_strategy_drop_pp=max_per_strategy_drop_pp,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    click.echo(f"Decision: {report.decision.upper()}")
    click.echo(f"Reason:   {report.reason}")
    click.echo(
        f"Accuracy: {report.champion_role_accuracy:.4f} -> "
        f"{report.challenger_role_accuracy:.4f} "
        f"({report.role_accuracy_delta_pp:+.2f}pp)"
    )
    click.echo(
        f"Brier:    {report.champion_brier:.4f} -> "
        f"{report.challenger_brier:.4f} "
        f"({report.brier_delta:+.4f})"
    )
    if report.regressed_strategies:
        click.echo(f"Regressed strategies: {', '.join(report.regressed_strategies)}")
    click.echo(f"Wrote comparison to {output_path}")

    if exit_nonzero_on_reject and report.decision == "reject":
        sys.exit(1)


if __name__ == "__main__":
    cli()
