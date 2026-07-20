# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Feedback Transform: Apply quality gates and build SFT/DPO training pairs.

Reads validated outcome and shadow evaluation records, filters by quality
thresholds, and produces training-ready JSONL files.

SFT output format (compatible with alignment/sft/train_sft.py):
  {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}

DPO output format (compatible with alignment/dpo/train_dpo.py):
  {"prompt": "...", "chosen": "...", "rejected": "...", "chosen_score": 0.88, "rejected_score": 0.72}

Usage:
  python data/feedback/transform.py --input ./data/feedback/validated --config ./data/feedback/config.yaml --output ./data/feedback/staging
"""

from __future__ import annotations

import json
import logging
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import click
import jsonlines
import yaml

logger = logging.getLogger(__name__)


# ─── Quality Gates ────────────────────────────────────────────────────────────

def load_config(config_path: Path) -> dict[str, Any]:
    """Load quality gate configuration."""
    with open(config_path) as f:
        return yaml.safe_load(f)


def passes_sft_gate(record: dict[str, Any], config: dict[str, Any]) -> bool:
    """Check if an outcome record passes SFT quality gates."""
    gates = config.get("quality_gates", {}).get("sft", {})

    # Must be successful
    if gates.get("require_success", True) and not record.get("success", False):
        return False

    # Quality score threshold
    qs = record.get("quality_score")
    if qs is None or qs < gates.get("min_quality_score", 0.80):
        return False

    # Per-dimension threshold
    dims = record.get("quality_dimensions") or {}
    min_dim = gates.get("min_dimension_score", 0.65)
    required_dims = ["correctness", "completeness", "clarity", "efficiency", "relevance"]
    for dim in required_dims:
        if dim in dims and dims[dim] < min_dim:
            return False

    # Feedback iterations limit
    if record.get("feedback_iterations", 1) > gates.get("max_feedback_iterations", 2):
        return False

    return True


def passes_dpo_gate(record: dict[str, Any], config: dict[str, Any]) -> bool:
    """Check if a shadow evaluation passes DPO quality gates."""
    gates = config.get("quality_gates", {}).get("dpo", {})

    regret = abs(record.get("quality_regret", 0))
    if regret < gates.get("min_quality_regret", 0.10):
        return False

    floor = gates.get("min_quality_floor", 0.30)
    if record.get("chosen_quality", 0) < floor:
        return False
    if record.get("shadow_quality", 0) < floor:
        return False

    return True


def passes_staleness_gate(record: dict[str, Any], config: dict[str, Any]) -> bool:
    """Check if a record is fresh enough."""
    max_age_days = config.get("quality_gates", {}).get("staleness", {}).get("max_age_days", 7)
    created_at = record.get("created_at", "")
    if not created_at:
        return False
    try:
        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
        return dt >= cutoff
    except (ValueError, TypeError):
        return False


# ─── SFT Builder ──────────────────────────────────────────────────────────────

def build_sft_record(outcome: dict[str, Any]) -> dict[str, Any]:
    """Build an SFT training record from an outcome.

    Note: This produces METADATA-ONLY SFT records for routing optimization.
    To include actual prompt/response content, use FEEDBACK_INCLUDE_CONTENT=1
    during extraction. Without content, these records train the triage/routing
    model, not the response generation model.
    """
    # Build a synthetic instruction from the metadata
    task_type = outcome.get("task_type", "general")
    complexity = outcome.get("complexity", "medium")
    strategy = outcome.get("strategy", "single")
    models = outcome.get("models_used", [])
    quality = outcome.get("quality_score", 0)
    decision_source = outcome.get("decision_source", "unknown")

    instruction = (
        f"Task: {task_type} (complexity: {complexity})\n"
        f"Select the best orchestration strategy and model combination."
    )

    response = (
        f"Strategy: {strategy}\n"
        f"Models: {', '.join(models) if models else 'auto-selected'}\n"
        f"Decision source: {decision_source}\n"
        f"Quality achieved: {quality:.3f}\n"
        f"This combination was validated by real execution with quality score {quality:.3f}."
    )

    return {
        "messages": [
            {"role": "user", "content": instruction},
            {"role": "assistant", "content": response},
        ],
        "metadata": {
            "source": "ci_api_feedback",
            "trace_id_hash": outcome.get("trace_id_hash", ""),
            "quality_score": quality,
            "task_type": task_type,
            "complexity": complexity,
        },
    }


# ─── DPO Builder ──────────────────────────────────────────────────────────────

def build_dpo_record(shadow: dict[str, Any]) -> dict[str, Any]:
    """Build a DPO preference pair from a shadow evaluation."""
    task_type = shadow.get("task_type", "general")
    complexity = shadow.get("complexity", "medium")

    prompt = (
        f"Task: {task_type} (complexity: {complexity})\n"
        f"Select the best orchestration strategy."
    )

    # Winner is "chosen", loser is "rejected"
    winner = shadow.get("winner_strategy", shadow.get("chosen_strategy", ""))
    chosen_q = shadow.get("chosen_quality", 0)
    shadow_q = shadow.get("shadow_quality", 0)

    if winner == shadow.get("shadow_strategy"):
        chosen = f"Strategy: {shadow.get('shadow_strategy')} (quality: {shadow_q:.3f})"
        rejected = f"Strategy: {shadow.get('chosen_strategy')} (quality: {chosen_q:.3f})"
        chosen_score = shadow_q
        rejected_score = chosen_q
    else:
        chosen = f"Strategy: {shadow.get('chosen_strategy')} (quality: {chosen_q:.3f})"
        rejected = f"Strategy: {shadow.get('shadow_strategy')} (quality: {shadow_q:.3f})"
        chosen_score = chosen_q
        rejected_score = shadow_q

    return {
        "prompt": prompt,
        "chosen": chosen,
        "rejected": rejected,
        "chosen_score": chosen_score,
        "rejected_score": rejected_score,
        "score_diff": abs(chosen_score - rejected_score),
        "metadata": {
            "source": "ci_api_shadow_eval",
            "trace_id_hash": shadow.get("trace_id_hash", ""),
            "task_type": task_type,
            "complexity": complexity,
        },
    }


# ─── Contradiction Filter ─────────────────────────────────────────────────────

def filter_contradictions(records: list[dict[str, Any]], max_variance: float = 0.09) -> list[dict[str, Any]]:
    """Remove records with contradictory quality scores for the same input."""
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        ih = r.get("input_hash")
        if ih:
            by_hash[ih].append(r)

    excluded_hashes: set[str] = set()
    for ih, group in by_hash.items():
        scores = [r["quality_score"] for r in group if r.get("quality_score") is not None]
        if len(scores) >= 2:
            mean = sum(scores) / len(scores)
            variance = sum((s - mean) ** 2 for s in scores) / len(scores)
            if variance > max_variance:
                excluded_hashes.add(ih)
                logger.info(f"Excluding input_hash {ih[:8]}...: variance {variance:.4f} > {max_variance}")

    before = len(records)
    records = [r for r in records if r.get("input_hash") not in excluded_hashes]
    logger.info(f"Contradiction filter: {before} → {len(records)} records ({before - len(records)} excluded)")
    return records


# ─── Staging Report ───────────────────────────────────────────────────────────

def build_staging_report(
    sft_records: list[dict[str, Any]],
    dpo_records: list[dict[str, Any]],
    config: dict[str, Any],
    outcomes_total: int,
    shadow_total: int,
) -> dict[str, Any]:
    """Build a staging report for human review."""
    sample_size = config.get("staging", {}).get("sample_size", 20)

    sft_sample = random.sample(sft_records, min(sample_size, len(sft_records))) if sft_records else []
    dpo_sample = random.sample(dpo_records, min(sample_size, len(dpo_records))) if dpo_records else []

    # Quality distribution
    sft_scores = [r["metadata"]["quality_score"] for r in sft_records if "metadata" in r]
    dpo_diffs = [r["score_diff"] for r in dpo_records if "score_diff" in r]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "outcomes_input": outcomes_total,
            "shadow_input": shadow_total,
            "sft_output": len(sft_records),
            "dpo_output": len(dpo_records),
            "sft_acceptance_rate": len(sft_records) / max(outcomes_total, 1),
            "dpo_acceptance_rate": len(dpo_records) / max(shadow_total, 1),
        },
        "quality_distribution": {
            "sft_mean_quality": sum(sft_scores) / max(len(sft_scores), 1) if sft_scores else 0,
            "sft_min_quality": min(sft_scores) if sft_scores else 0,
            "sft_max_quality": max(sft_scores) if sft_scores else 0,
            "dpo_mean_diff": sum(dpo_diffs) / max(len(dpo_diffs), 1) if dpo_diffs else 0,
        },
        "samples": {
            "sft": sft_sample[:5],
            "dpo": dpo_sample[:5],
        },
        "config_used": config,
    }


# ─── CLI ──────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--input", "input_dir", required=True, type=click.Path(exists=True), help="Validated records directory")
@click.option("--config", "config_path", required=True, type=click.Path(exists=True), help="Config YAML path")
@click.option("--output", "output_dir", required=True, type=click.Path(), help="Staging output directory")
def main(input_dir: str, config_path: str, output_dir: str) -> None:
    """Apply quality gates and build SFT/DPO training pairs."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    inp = Path(input_dir)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    config = load_config(Path(config_path))

    # Load outcomes
    outcomes: list[dict[str, Any]] = []
    outcomes_file = inp / "outcomes.jsonl"
    if outcomes_file.exists():
        with jsonlines.open(outcomes_file, mode="r") as reader:
            outcomes = list(reader)
    logger.info(f"Loaded {len(outcomes)} outcome records")

    # Load shadow evals
    shadow: list[dict[str, Any]] = []
    shadow_file = inp / "shadow.jsonl"
    if shadow_file.exists():
        with jsonlines.open(shadow_file, mode="r") as reader:
            shadow = list(reader)
    logger.info(f"Loaded {len(shadow)} shadow evaluation records")

    outcomes_total = len(outcomes)
    shadow_total = len(shadow)

    # Apply gates
    outcomes = [r for r in outcomes if passes_staleness_gate(r, config)]
    outcomes = [r for r in outcomes if passes_sft_gate(r, config)]
    outcomes = filter_contradictions(outcomes)
    logger.info(f"After quality gates: {len(outcomes)} SFT-eligible outcomes")

    shadow = [r for r in shadow if passes_staleness_gate(r, config)]
    shadow = [r for r in shadow if passes_dpo_gate(r, config)]
    logger.info(f"After quality gates: {len(shadow)} DPO-eligible shadow evals")

    # Build training records
    sft_records = [build_sft_record(o) for o in outcomes]
    dpo_records = [build_dpo_record(s) for s in shadow]

    # Write staging outputs
    with jsonlines.open(out / "sft_staging.jsonl", mode="w") as w:
        for r in sft_records:
            w.write(r)

    with jsonlines.open(out / "dpo_staging.jsonl", mode="w") as w:
        for r in dpo_records:
            w.write(r)

    # Write staging report
    report = build_staging_report(sft_records, dpo_records, config, outcomes_total, shadow_total)
    with open(out / "staging_report.json", "w") as f:
        json.dump(report, f, indent=2, default=str)

    logger.info(f"Staging complete: {len(sft_records)} SFT, {len(dpo_records)} DPO records → {out}")


if __name__ == "__main__":
    main()
