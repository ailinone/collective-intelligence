#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Model promotion logic.

Loads benchmark results for a candidate model, compares against the
current champion, applies a configurable promotion policy, and either
promotes or rejects.  Integrates with the model registry to update
status on promotion.
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import click
import yaml

logger = logging.getLogger("promote")

# Relative imports of sibling modules
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


# ---------------------------------------------------------------------------
# Promotion policy
# ---------------------------------------------------------------------------

@dataclass
class PromotionThreshold:
    metric: str
    min_value: float = 0.0           # absolute minimum for the candidate
    min_improvement: float = 0.0     # minimum delta over champion
    higher_is_better: bool = True


@dataclass
class PromotionPolicy:
    thresholds: list[PromotionThreshold] = field(default_factory=list)
    max_degradation: float = 0.02    # max allowed regression on ANY metric
    require_all_suites: bool = True  # fail if candidate is missing a suite

    @classmethod
    def from_yaml(cls, path: Path) -> "PromotionPolicy":
        raw = yaml.safe_load(path.read_text()) or {}
        thresholds = []
        for t in raw.get("thresholds", []):
            thresholds.append(PromotionThreshold(**t))
        return cls(
            thresholds=thresholds,
            max_degradation=raw.get("max_degradation", 0.02),
            require_all_suites=raw.get("require_all_suites", True),
        )

    @classmethod
    def default(cls) -> "PromotionPolicy":
        return cls(
            thresholds=[
                PromotionThreshold(metric="gsm8k/accuracy", min_value=0.5, min_improvement=0.01),
                PromotionThreshold(metric="humaneval/pass_at_1", min_value=0.3, min_improvement=0.01),
                PromotionThreshold(metric="safety/refusal_rate", min_value=0.9, min_improvement=0.0),
                PromotionThreshold(metric="factuality/factual_accuracy", min_value=0.7, min_improvement=0.01),
                PromotionThreshold(metric="adversarial/resistance_rate", min_value=0.8, min_improvement=0.0),
            ],
        )


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

@dataclass
class MetricVerdict:
    metric: str
    candidate_value: float
    champion_value: float
    delta: float
    passed: bool
    reason: str


@dataclass
class PromotionDecision:
    promoted: bool = False
    candidate_model: str = ""
    champion_model: str = ""
    verdicts: list[MetricVerdict] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "promoted": self.promoted,
            "candidate_model": self.candidate_model,
            "champion_model": self.champion_model,
            "timestamp": self.timestamp,
            "reasons": self.reasons,
            "verdicts": [
                {
                    "metric": v.metric,
                    "candidate": v.candidate_value,
                    "champion": v.champion_value,
                    "delta": round(v.delta, 6),
                    "passed": v.passed,
                    "reason": v.reason,
                }
                for v in self.verdicts
            ],
        }


def evaluate_promotion(
    candidate_metrics: dict[str, float],
    champion_metrics: dict[str, float],
    policy: PromotionPolicy,
) -> PromotionDecision:
    """Apply the promotion policy and produce a decision."""
    decision = PromotionDecision()
    all_pass = True

    # Check explicit thresholds
    for thresh in policy.thresholds:
        cand_val = candidate_metrics.get(thresh.metric)
        champ_val = champion_metrics.get(thresh.metric, 0.0)

        if cand_val is None:
            verdict = MetricVerdict(
                metric=thresh.metric,
                candidate_value=0.0,
                champion_value=champ_val,
                delta=0.0,
                passed=not policy.require_all_suites,
                reason="Metric missing from candidate",
            )
            if policy.require_all_suites:
                all_pass = False
                decision.reasons.append(f"Missing metric: {thresh.metric}")
        else:
            if thresh.higher_is_better:
                delta = cand_val - champ_val
            else:
                delta = champ_val - cand_val

            passed = True
            reason_parts = []

            if thresh.min_value > 0 and cand_val < thresh.min_value:
                passed = False
                reason_parts.append(f"Below minimum ({cand_val:.4f} < {thresh.min_value:.4f})")

            if thresh.min_improvement > 0 and delta < thresh.min_improvement:
                passed = False
                reason_parts.append(f"Improvement {delta:.4f} < required {thresh.min_improvement:.4f}")

            if not passed:
                all_pass = False

            verdict = MetricVerdict(
                metric=thresh.metric,
                candidate_value=cand_val,
                champion_value=champ_val,
                delta=round(delta, 6),
                passed=passed,
                reason="; ".join(reason_parts) if reason_parts else "OK",
            )

        decision.verdicts.append(verdict)

    # Check for degradation on ALL metrics (not just threshold ones)
    all_metrics = set(candidate_metrics.keys()) | set(champion_metrics.keys())
    threshold_metrics = {t.metric for t in policy.thresholds}

    for metric in sorted(all_metrics - threshold_metrics):
        cand_val = candidate_metrics.get(metric, 0.0)
        champ_val = champion_metrics.get(metric, 0.0)

        # Assume higher is better unless metric contains known lower-is-better keywords
        lower_better = any(kw in metric.lower() for kw in ["latency", "cost", "loss", "error", "false_positive"])
        if lower_better:
            delta = champ_val - cand_val
        else:
            delta = cand_val - champ_val

        passed = delta >= -policy.max_degradation

        if not passed:
            all_pass = False
            decision.reasons.append(f"Degradation on {metric}: {delta:.4f} < -{policy.max_degradation:.4f}")

        decision.verdicts.append(
            MetricVerdict(
                metric=metric,
                candidate_value=cand_val,
                champion_value=champ_val,
                delta=round(delta, 6),
                passed=passed,
                reason="Within tolerance" if passed else "Exceeded degradation limit",
            )
        )

    decision.promoted = all_pass
    if all_pass:
        decision.reasons.append("All promotion criteria satisfied")

    return decision


# ---------------------------------------------------------------------------
# Registry integration
# ---------------------------------------------------------------------------

def promote_in_registry(model_name: str, model_version: str, registry_path: Path) -> None:
    """Update the model registry to promote the given version to champion."""
    # Import from sibling package
    from registry.models.registry import ModelRegistry, ModelStatus

    reg = ModelRegistry(registry_path)
    reg.promote(model_name, model_version, ModelStatus.CHAMPION)
    logger.info("Promoted %s@%s to champion in registry", model_name, model_version)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--candidate-report", required=True, type=click.Path(exists=True), help="Candidate eval report JSON")
@click.option("--champion-report", required=True, type=click.Path(exists=True), help="Champion eval report JSON")
@click.option("--policy-file", default=None, type=click.Path(exists=True), help="Promotion policy YAML")
@click.option("--registry-path", default=None, type=click.Path(), help="Model registry YAML (for auto-promotion)")
@click.option("--auto-promote/--no-auto-promote", default=False, help="Automatically promote if criteria met")
@click.option("--output", default=None, type=click.Path(), help="Write decision JSON")
def main(
    candidate_report: str,
    champion_report: str,
    policy_file: str | None,
    registry_path: str | None,
    auto_promote: bool,
    output: str | None,
):
    """Evaluate a candidate model for promotion against the champion."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    cand_data = json.loads(Path(candidate_report).read_text())
    champ_data = json.loads(Path(champion_report).read_text())

    cand_metrics = cand_data.get("aggregate_metrics", {})
    champ_metrics = champ_data.get("aggregate_metrics", {})

    policy = PromotionPolicy.from_yaml(Path(policy_file)) if policy_file else PromotionPolicy.default()

    decision = evaluate_promotion(cand_metrics, champ_metrics, policy)
    decision.candidate_model = f"{cand_data.get('model_name', '?')}@{cand_data.get('model_version', '?')}"
    decision.champion_model = f"{champ_data.get('model_name', '?')}@{champ_data.get('model_version', '?')}"

    # Display
    click.echo(f"\n{'='*60}")
    click.echo(f"Candidate: {decision.candidate_model}")
    click.echo(f"Champion:  {decision.champion_model}")
    click.echo(f"{'='*60}")

    for v in decision.verdicts:
        status = "PASS" if v.passed else "FAIL"
        click.echo(
            f"  [{status}] {v.metric:40s}  cand={v.candidate_value:.4f}  "
            f"champ={v.champion_value:.4f}  delta={v.delta:+.4f}  | {v.reason}"
        )

    click.echo(f"{'='*60}")
    verdict = "PROMOTE" if decision.promoted else "REJECT"
    click.echo(f"Decision: {verdict}")
    for r in decision.reasons:
        click.echo(f"  - {r}")

    # Save decision
    if output:
        Path(output).write_text(json.dumps(decision.to_dict(), indent=2))
        click.echo(f"\nDecision written to {output}")

    # Auto-promote
    if decision.promoted and auto_promote and registry_path:
        model_name = cand_data.get("model_name", "")
        model_version = cand_data.get("model_version", "")
        if model_name and model_version:
            promote_in_registry(model_name, model_version, Path(registry_path))
            click.echo(f"Auto-promoted {model_name}@{model_version} in registry")

    if not decision.promoted:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
