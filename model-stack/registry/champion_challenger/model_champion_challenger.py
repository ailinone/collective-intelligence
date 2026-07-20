#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Champion / Challenger evaluation for model promotion decisions.

Compares a challenger model version against the current champion on a
configurable benchmark suite.  The challenger is promoted only if it
beats the champion by a configurable margin on **all** key metrics and
does not degrade any secondary metric beyond an allowed limit.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import click
import yaml

logger = logging.getLogger("champion_challenger")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class PromotionPolicy:
    """Thresholds governing whether a challenger is promoted."""

    # Key metrics: challenger must beat champion by >= margin on every one.
    key_metrics: dict[str, float] = field(default_factory=lambda: {
        "gsm8k_accuracy": 0.01,      # 1 pp improvement required
        "humaneval_pass1": 0.01,
        "safety_refusal_rate": 0.0,   # must not decrease
    })

    # Secondary metrics: no single metric may degrade more than this limit.
    degradation_limit: float = 0.02   # 2 pp max regression on any metric

    # If True, higher is better for all metrics.  Override per-metric below.
    higher_is_better_defaults: bool = True

    # Override: set to False for metrics where lower is better (e.g. latency).
    lower_is_better: set[str] = field(default_factory=lambda: {
        "latency_p99_ms",
        "cost_per_1k_tokens",
    })

    def is_higher_better(self, metric: str) -> bool:
        return metric not in self.lower_is_better


# ---------------------------------------------------------------------------
# Benchmark results
# ---------------------------------------------------------------------------

@dataclass
class BenchmarkResults:
    """Aggregated evaluation results for a model version."""

    model_name: str
    model_version: str
    metrics: dict[str, float] = field(default_factory=dict)
    run_timestamp: str = ""
    source_file: str = ""

    @classmethod
    def from_file(cls, path: str | Path) -> "BenchmarkResults":
        p = Path(path)
        data: dict
        if p.suffix in (".yaml", ".yml"):
            data = yaml.safe_load(p.read_text()) or {}
        else:
            data = json.loads(p.read_text())
        return cls(
            model_name=data.get("model_name", ""),
            model_version=data.get("model_version", ""),
            metrics=data.get("metrics", {}),
            run_timestamp=data.get("run_timestamp", ""),
            source_file=str(p),
        )


# ---------------------------------------------------------------------------
# Comparison engine
# ---------------------------------------------------------------------------

@dataclass
class MetricComparison:
    metric: str
    champion_value: float
    challenger_value: float
    delta: float
    required_margin: float
    passed: bool
    note: str = ""


@dataclass
class PromotionDecision:
    promoted: bool
    champion: str
    challenger: str
    comparisons: list[MetricComparison] = field(default_factory=list)
    key_metric_pass: bool = True
    degradation_pass: bool = True
    reasons: list[str] = field(default_factory=list)
    decided_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "promoted": self.promoted,
            "champion": self.champion,
            "challenger": self.challenger,
            "decided_at": self.decided_at,
            "key_metric_pass": self.key_metric_pass,
            "degradation_pass": self.degradation_pass,
            "reasons": self.reasons,
            "comparisons": [
                {
                    "metric": c.metric,
                    "champion": c.champion_value,
                    "challenger": c.challenger_value,
                    "delta": round(c.delta, 6),
                    "required_margin": c.required_margin,
                    "passed": c.passed,
                    "note": c.note,
                }
                for c in self.comparisons
            ],
        }


def compare_models(
    champion: BenchmarkResults,
    challenger: BenchmarkResults,
    policy: PromotionPolicy,
) -> PromotionDecision:
    """Run the full champion-challenger comparison.

    Returns a :class:`PromotionDecision` with evidence for every metric.
    """
    decision = PromotionDecision(
        promoted=False,
        champion=f"{champion.model_name}@{champion.model_version}",
        challenger=f"{challenger.model_name}@{challenger.model_version}",
    )

    all_metrics = set(champion.metrics.keys()) | set(challenger.metrics.keys())
    key_metric_pass = True
    degradation_pass = True

    for metric in sorted(all_metrics):
        champ_val = champion.metrics.get(metric, 0.0)
        chall_val = challenger.metrics.get(metric, 0.0)
        higher_better = policy.is_higher_better(metric)

        # Compute raw delta (positive = challenger is better)
        if higher_better:
            delta = chall_val - champ_val
        else:
            delta = champ_val - chall_val  # lower is better -> invert

        required_margin = policy.key_metrics.get(metric, 0.0)
        is_key = metric in policy.key_metrics

        passed = True
        note = ""

        if is_key:
            if delta < required_margin:
                passed = False
                key_metric_pass = False
                note = f"Key metric: delta {delta:.4f} < required margin {required_margin:.4f}"
            else:
                note = f"Key metric: OK (delta {delta:.4f} >= {required_margin:.4f})"
        else:
            # Secondary metric: check for degradation beyond limit
            if delta < -policy.degradation_limit:
                passed = False
                degradation_pass = False
                note = f"Degradation: {abs(delta):.4f} > limit {policy.degradation_limit:.4f}"
            else:
                note = "Secondary metric within tolerance"

        decision.comparisons.append(
            MetricComparison(
                metric=metric,
                champion_value=champ_val,
                challenger_value=chall_val,
                delta=round(delta, 6),
                required_margin=required_margin,
                passed=passed,
                note=note,
            )
        )

    decision.key_metric_pass = key_metric_pass
    decision.degradation_pass = degradation_pass
    decision.promoted = key_metric_pass and degradation_pass

    if not key_metric_pass:
        decision.reasons.append("Challenger failed one or more key metric thresholds")
    if not degradation_pass:
        decision.reasons.append("Challenger degraded beyond limit on secondary metric(s)")
    if decision.promoted:
        decision.reasons.append("Challenger meets all promotion criteria")

    return decision


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli():
    """Champion / Challenger model comparison."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


@cli.command()
@click.option("--champion-results", required=True, type=click.Path(exists=True), help="Champion benchmark results (JSON/YAML)")
@click.option("--challenger-results", required=True, type=click.Path(exists=True), help="Challenger benchmark results (JSON/YAML)")
@click.option("--policy-file", default=None, type=click.Path(exists=True), help="Promotion policy YAML (optional)")
@click.option("--output", default=None, type=click.Path(), help="Write decision JSON to file")
def compare(champion_results, challenger_results, policy_file, output):
    """Compare champion vs. challenger and output promotion decision."""
    champ = BenchmarkResults.from_file(champion_results)
    chall = BenchmarkResults.from_file(challenger_results)

    if policy_file:
        raw = yaml.safe_load(Path(policy_file).read_text()) or {}
        policy = PromotionPolicy(
            key_metrics=raw.get("key_metrics", PromotionPolicy.key_metrics),
            degradation_limit=raw.get("degradation_limit", PromotionPolicy.degradation_limit),
            lower_is_better=set(raw.get("lower_is_better", [])),
        )
    else:
        policy = PromotionPolicy()

    decision = compare_models(champ, chall, policy)

    click.echo(f"\n{'='*60}")
    click.echo(f"Champion:   {decision.champion}")
    click.echo(f"Challenger: {decision.challenger}")
    click.echo(f"{'='*60}")

    for c in decision.comparisons:
        status = "PASS" if c.passed else "FAIL"
        click.echo(f"  [{status}] {c.metric:30s} champ={c.champion_value:.4f}  chall={c.challenger_value:.4f}  delta={c.delta:+.4f}  | {c.note}")

    click.echo(f"{'='*60}")
    verdict = "PROMOTE" if decision.promoted else "REJECT"
    click.echo(f"Decision: {verdict}")
    for r in decision.reasons:
        click.echo(f"  - {r}")

    if output:
        Path(output).write_text(json.dumps(decision.to_dict(), indent=2))
        click.echo(f"\nDecision written to {output}")

    if not decision.promoted:
        raise SystemExit(1)


@cli.command()
@click.option("--output", required=True, type=click.Path(), help="Write default policy to YAML")
def init_policy(output):
    """Generate a default promotion policy file."""
    default = {
        "key_metrics": dict(PromotionPolicy.key_metrics),
        "degradation_limit": PromotionPolicy.degradation_limit,
        "lower_is_better": list(PromotionPolicy.lower_is_better),
    }
    Path(output).write_text(yaml.dump(default, default_flow_style=False))
    click.echo(f"Default policy written to {output}")


if __name__ == "__main__":
    cli()
