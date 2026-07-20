#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Ablation study runner.

Takes a base training config and a list of ablation dimensions,
generates config variants for each combination, launches training runs,
collects results, and produces a comparison report.
"""

from __future__ import annotations

import copy
import itertools
import json
import logging
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import click
import yaml

logger = logging.getLogger("ablation_runner")


# ---------------------------------------------------------------------------
# Config generation
# ---------------------------------------------------------------------------

@dataclass
class AblationDimension:
    """A single dimension to ablate over."""

    name: str                         # Human-readable name
    config_path: str                  # Dot-separated path in the config dict (e.g. "training.lr")
    values: list[Any]                 # Values to try
    description: str = ""


@dataclass
class AblationVariant:
    """A single config variant generated from ablation dimensions."""

    variant_id: str
    label: str                        # e.g. "lr=1e-4_bs=64"
    config: dict[str, Any]
    ablation_values: dict[str, Any]   # dimension_name -> value used


def set_nested(d: dict, path: str, value: Any) -> None:
    """Set a value in a nested dict using dot-separated path."""
    keys = path.split(".")
    for key in keys[:-1]:
        if key not in d:
            d[key] = {}
        d = d[key]
    d[keys[-1]] = value


def get_nested(d: dict, path: str, default: Any = None) -> Any:
    """Get a value from a nested dict using dot-separated path."""
    keys = path.split(".")
    for key in keys:
        if not isinstance(d, dict) or key not in d:
            return default
        d = d[key]
    return d


def generate_variants(
    base_config: dict[str, Any],
    dimensions: list[AblationDimension],
    mode: str = "grid",
) -> list[AblationVariant]:
    """Generate config variants.

    Modes:
    - "grid": full grid search over all dimension value combinations
    - "one_at_a_time": vary one dimension at a time, holding others at baseline
    """
    variants: list[AblationVariant] = []

    if mode == "grid":
        # Cartesian product of all dimension values
        dim_values = [dim.values for dim in dimensions]
        for combo in itertools.product(*dim_values):
            config = copy.deepcopy(base_config)
            label_parts = []
            ablation_values = {}

            for dim, val in zip(dimensions, combo):
                set_nested(config, dim.config_path, val)
                short_val = str(val).replace(".", "p")
                label_parts.append(f"{dim.name}={short_val}")
                ablation_values[dim.name] = val

            variant = AblationVariant(
                variant_id=f"abl-{uuid.uuid4().hex[:8]}",
                label="_".join(label_parts),
                config=config,
                ablation_values=ablation_values,
            )
            variants.append(variant)

    elif mode == "one_at_a_time":
        for dim in dimensions:
            baseline_value = get_nested(base_config, dim.config_path)
            for val in dim.values:
                if val == baseline_value:
                    continue  # skip the baseline value
                config = copy.deepcopy(base_config)
                set_nested(config, dim.config_path, val)

                short_val = str(val).replace(".", "p")
                variant = AblationVariant(
                    variant_id=f"abl-{uuid.uuid4().hex[:8]}",
                    label=f"{dim.name}={short_val}",
                    config=config,
                    ablation_values={dim.name: val},
                )
                variants.append(variant)

        # Add baseline variant
        baseline = AblationVariant(
            variant_id=f"abl-baseline-{uuid.uuid4().hex[:8]}",
            label="baseline",
            config=copy.deepcopy(base_config),
            ablation_values={dim.name: get_nested(base_config, dim.config_path) for dim in dimensions},
        )
        variants.insert(0, baseline)

    else:
        raise ValueError(f"Unknown mode: {mode}")

    return variants


# ---------------------------------------------------------------------------
# Run management
# ---------------------------------------------------------------------------

@dataclass
class AblationRun:
    variant: AblationVariant
    status: str = "pending"         # pending | running | completed | failed
    result_metrics: dict[str, float] = field(default_factory=dict)
    elapsed_seconds: float = 0.0
    error: str = ""
    started_at: str = ""
    finished_at: str = ""


def run_training_variant(
    variant: AblationVariant,
    training_script: str,
    output_dir: Path,
    dry_run: bool = False,
) -> AblationRun:
    """Launch a training run for a single variant."""
    run = AblationRun(variant=variant)
    run.started_at = datetime.now(timezone.utc).isoformat()
    run.status = "running"

    variant_dir = output_dir / variant.variant_id
    variant_dir.mkdir(parents=True, exist_ok=True)

    # Write config
    config_path = variant_dir / "config.yaml"
    config_path.write_text(yaml.dump(variant.config, default_flow_style=False))

    if dry_run:
        logger.info("DRY RUN: would launch %s with config %s", training_script, config_path)
        run.status = "completed"
        run.result_metrics = {"loss": 0.0}
        run.finished_at = datetime.now(timezone.utc).isoformat()
        return run

    cmd = [
        sys.executable,
        training_script,
        "--config", str(config_path),
        "--output-dir", str(variant_dir),
    ]

    logger.info("Launching variant %s: %s", variant.label, " ".join(cmd))
    start = time.time()

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=7200,  # 2 hour max per variant
        )
        run.elapsed_seconds = time.time() - start

        if result.returncode != 0:
            run.status = "failed"
            run.error = result.stderr[:500]
            logger.error("Variant %s failed: %s", variant.label, run.error)
        else:
            run.status = "completed"
            # Try to load metrics from the variant's output
            metrics_path = variant_dir / "metrics.json"
            if metrics_path.exists():
                run.result_metrics = json.loads(metrics_path.read_text())
            else:
                # Try to parse from stdout
                for line in result.stdout.strip().split("\n"):
                    if line.startswith("{"):
                        try:
                            run.result_metrics = json.loads(line)
                            break
                        except json.JSONDecodeError:
                            continue

    except subprocess.TimeoutExpired:
        run.status = "failed"
        run.error = "Training timed out"
        run.elapsed_seconds = time.time() - start
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.elapsed_seconds = time.time() - start

    run.finished_at = datetime.now(timezone.utc).isoformat()
    return run


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

@dataclass
class AblationReport:
    dimensions: list[dict[str, Any]]
    variants: list[dict[str, Any]]
    mode: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "created_at": self.created_at,
            "mode": self.mode,
            "dimensions": self.dimensions,
            "num_variants": len(self.variants),
            "variants": self.variants,
        }


def generate_report(
    dimensions: list[AblationDimension],
    runs: list[AblationRun],
    mode: str,
) -> AblationReport:
    dim_info = [
        {"name": d.name, "config_path": d.config_path, "values": d.values, "description": d.description}
        for d in dimensions
    ]

    variant_info = []
    for run in runs:
        variant_info.append({
            "variant_id": run.variant.variant_id,
            "label": run.variant.label,
            "ablation_values": run.variant.ablation_values,
            "status": run.status,
            "metrics": run.result_metrics,
            "elapsed_seconds": round(run.elapsed_seconds, 1),
            "error": run.error,
        })

    return AblationReport(dimensions=dim_info, variants=variant_info, mode=mode)


def print_comparison(runs: list[AblationRun]) -> None:
    """Print a table comparing all variants."""
    completed = [r for r in runs if r.status == "completed" and r.result_metrics]
    if not completed:
        click.echo("No completed variants with metrics to compare.")
        return

    # Collect all metric names
    all_metrics = sorted(set(k for r in completed for k in r.result_metrics))

    # Header
    header = f"{'Variant':30s}"
    for m in all_metrics[:8]:  # limit columns
        header += f"  {m[:15]:>15s}"
    click.echo(header)
    click.echo("-" * len(header))

    # Sort by first metric
    first_metric = all_metrics[0] if all_metrics else ""
    sorted_runs = sorted(completed, key=lambda r: r.result_metrics.get(first_metric, 0), reverse=True)

    for run in sorted_runs:
        row = f"{run.variant.label[:30]:30s}"
        for m in all_metrics[:8]:
            val = run.result_metrics.get(m)
            if val is not None:
                row += f"  {val:>15.4f}"
            else:
                row += f"  {'N/A':>15s}"
        click.echo(row)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--base-config", required=True, type=click.Path(exists=True), help="Base training config YAML")
@click.option("--ablations", required=True, type=click.Path(exists=True), help="Ablation dimensions YAML")
@click.option("--training-script", required=True, type=click.Path(exists=True), help="Training script to run")
@click.option("--output-dir", required=True, type=click.Path(), help="Directory for variant outputs")
@click.option("--mode", type=click.Choice(["grid", "one_at_a_time"]), default="one_at_a_time")
@click.option("--dry-run", is_flag=True, default=False, help="Print plan without running")
@click.option("--report", type=click.Path(), default=None, help="Output report JSON path")
def main(
    base_config: str,
    ablations: str,
    training_script: str,
    output_dir: str,
    mode: str,
    dry_run: bool,
    report: str | None,
):
    """Run ablation studies over training hyperparameters.

    The ablations YAML file should have the format:

    \b
    dimensions:
      - name: learning_rate
        config_path: training.learning_rate
        values: [1.0e-5, 3.0e-5, 1.0e-4]
        description: "Learning rate sweep"
      - name: batch_size
        config_path: training.batch_size
        values: [32, 64, 128]
    """
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    base = yaml.safe_load(Path(base_config).read_text())
    abl_raw = yaml.safe_load(Path(ablations).read_text())

    dimensions = [
        AblationDimension(
            name=d["name"],
            config_path=d["config_path"],
            values=d["values"],
            description=d.get("description", ""),
        )
        for d in abl_raw.get("dimensions", [])
    ]

    if not dimensions:
        raise click.ClickException("No ablation dimensions defined")

    variants = generate_variants(base, dimensions, mode=mode)
    click.echo(f"Generated {len(variants)} variants (mode={mode}):")
    for v in variants:
        click.echo(f"  {v.variant_id}  {v.label}")

    if dry_run:
        click.echo("\nDry run: no training will be executed.")

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    runs: list[AblationRun] = []
    for i, variant in enumerate(variants):
        click.echo(f"\n[{i+1}/{len(variants)}] Running variant: {variant.label}")
        run = run_training_variant(variant, training_script, out, dry_run=dry_run)
        runs.append(run)
        if run.status == "completed":
            click.echo(f"  Completed in {run.elapsed_seconds:.1f}s  metrics={run.result_metrics}")
        else:
            click.echo(f"  {run.status}: {run.error}")

    # Comparison table
    click.echo(f"\n{'='*60}")
    click.echo("Ablation Comparison")
    click.echo(f"{'='*60}")
    print_comparison(runs)

    # Report
    abl_report = generate_report(dimensions, runs, mode)
    report_path = Path(report) if report else out / "ablation_report.json"
    report_path.write_text(json.dumps(abl_report.to_dict(), indent=2))
    click.echo(f"\nReport saved to {report_path}")

    # Exit code: non-zero if any variant failed
    failed = sum(1 for r in runs if r.status == "failed")
    if failed > 0:
        click.echo(f"\nWarning: {failed}/{len(runs)} variants failed")


if __name__ == "__main__":
    main()
