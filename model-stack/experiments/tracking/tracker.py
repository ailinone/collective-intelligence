#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Experiment tracker with Weights & Biases integration and local fallback.

Tracks hyperparameters, metrics over time, artifacts, and tags.
Supports comparing experiments by loading from the local JSON store.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import click

logger = logging.getLogger("experiment_tracker")

LOCAL_STORE_DIR = Path(__file__).resolve().parent / "runs"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class MetricPoint:
    step: int
    value: float
    timestamp: float = field(default_factory=time.time)


@dataclass
class Experiment:
    run_id: str
    name: str = ""
    project: str = "ci-model-stack"
    hyperparams: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, list[MetricPoint]] = field(default_factory=dict)
    artifacts: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    status: str = "running"  # running | finished | failed
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: str = ""
    notes: str = ""

    def log_metric(self, name: str, value: float, step: int) -> None:
        if name not in self.metrics:
            self.metrics[name] = []
        self.metrics[name].append(MetricPoint(step=step, value=value))

    def log_metrics(self, values: dict[str, float], step: int) -> None:
        for name, value in values.items():
            self.log_metric(name, value, step)

    def latest_metrics(self) -> dict[str, float]:
        result = {}
        for name, points in self.metrics.items():
            if points:
                result[name] = points[-1].value
        return result

    def to_dict(self) -> dict:
        d = asdict(self)
        # Convert MetricPoint lists to plain dicts for JSON serialization
        for name in d["metrics"]:
            d["metrics"][name] = [asdict(p) for p in self.metrics[name]]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Experiment":
        metrics_raw = d.pop("metrics", {})
        exp = cls(**d)
        for name, points in metrics_raw.items():
            exp.metrics[name] = [MetricPoint(**p) for p in points]
        return exp


# ---------------------------------------------------------------------------
# Local JSON backend
# ---------------------------------------------------------------------------

class LocalStore:
    """Stores experiments as individual JSON files on disk."""

    def __init__(self, base_dir: Path = LOCAL_STORE_DIR) -> None:
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, run_id: str) -> Path:
        return self.base_dir / f"{run_id}.json"

    def save(self, exp: Experiment) -> None:
        self._path(exp.run_id).write_text(json.dumps(exp.to_dict(), indent=2))

    def load(self, run_id: str) -> Experiment | None:
        p = self._path(run_id)
        if not p.exists():
            return None
        return Experiment.from_dict(json.loads(p.read_text()))

    def list_runs(self, project: str | None = None, tag: str | None = None) -> list[Experiment]:
        experiments: list[Experiment] = []
        for f in self.base_dir.glob("*.json"):
            exp = Experiment.from_dict(json.loads(f.read_text()))
            if project and exp.project != project:
                continue
            if tag and tag not in exp.tags:
                continue
            experiments.append(exp)
        return sorted(experiments, key=lambda e: e.created_at, reverse=True)

    def delete(self, run_id: str) -> bool:
        p = self._path(run_id)
        if p.exists():
            p.unlink()
            return True
        return False


# ---------------------------------------------------------------------------
# Tracker (unified interface)
# ---------------------------------------------------------------------------

class ExperimentTracker:
    """High-level experiment tracker.

    Attempts to use W&B if available and ``use_wandb`` is True;
    always writes to the local JSON store as fallback / backup.
    """

    def __init__(
        self,
        project: str = "ci-model-stack",
        use_wandb: bool = True,
        local_dir: Path = LOCAL_STORE_DIR,
    ) -> None:
        self.project = project
        self.local = LocalStore(local_dir)
        self._wandb_run = None
        self._use_wandb = use_wandb and self._init_wandb(project)

    def _init_wandb(self, project: str) -> bool:
        try:
            import wandb  # type: ignore

            if wandb.api.api_key is None:
                logger.info("W&B API key not set; using local-only tracking")
                return False
            return True
        except ImportError:
            logger.info("wandb not installed; using local-only tracking")
            return False

    def start_run(
        self,
        run_id: str,
        name: str = "",
        hyperparams: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> Experiment:
        exp = Experiment(
            run_id=run_id,
            name=name or run_id,
            project=self.project,
            hyperparams=hyperparams or {},
            tags=tags or [],
        )

        if self._use_wandb:
            import wandb

            self._wandb_run = wandb.init(
                project=self.project,
                name=name or run_id,
                id=run_id,
                config=hyperparams or {},
                tags=tags or [],
                resume="allow",
            )

        self.local.save(exp)
        logger.info("Started experiment %s (W&B=%s)", run_id, self._use_wandb)
        return exp

    def log_metrics(self, exp: Experiment, values: dict[str, float], step: int) -> None:
        exp.log_metrics(values, step)
        self.local.save(exp)

        if self._use_wandb and self._wandb_run is not None:
            import wandb

            wandb.log(values, step=step)

    def log_artifact(self, exp: Experiment, path: str, name: str = "") -> None:
        exp.artifacts.append(path)
        self.local.save(exp)

        if self._use_wandb and self._wandb_run is not None:
            import wandb

            artifact = wandb.Artifact(name or Path(path).stem, type="model")
            artifact.add_file(path)
            self._wandb_run.log_artifact(artifact)

    def finish(self, exp: Experiment, status: str = "finished") -> None:
        exp.status = status
        exp.finished_at = datetime.now(timezone.utc).isoformat()
        self.local.save(exp)

        if self._use_wandb and self._wandb_run is not None:
            import wandb

            self._wandb_run.finish()
            self._wandb_run = None

        logger.info("Finished experiment %s (%s)", exp.run_id, status)

    def load(self, run_id: str) -> Experiment | None:
        return self.local.load(run_id)

    def list_runs(self, tag: str | None = None) -> list[Experiment]:
        return self.local.list_runs(project=self.project, tag=tag)

    def compare(self, run_ids: list[str]) -> dict[str, dict[str, float]]:
        """Return latest metrics for each run, keyed by run_id."""
        result: dict[str, dict[str, float]] = {}
        for rid in run_ids:
            exp = self.load(rid)
            if exp:
                result[rid] = exp.latest_metrics()
        return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli():
    """Experiment tracking CLI."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


@cli.command("list")
@click.option("--project", default="ci-model-stack")
@click.option("--tag", default=None)
def list_runs(project, tag):
    """List tracked experiments."""
    tracker = ExperimentTracker(project=project, use_wandb=False)
    runs = tracker.list_runs(tag=tag)
    if not runs:
        click.echo("No experiments found.")
        return
    for exp in runs:
        latest = exp.latest_metrics()
        metric_str = "  ".join(f"{k}={v:.4f}" for k, v in list(latest.items())[:5])
        tags_str = f" [{', '.join(exp.tags)}]" if exp.tags else ""
        click.echo(f"  {exp.run_id:30s} {exp.status:10s} {metric_str}{tags_str}")


@cli.command()
@click.argument("run_ids", nargs=-1)
@click.option("--project", default="ci-model-stack")
def compare(run_ids, project):
    """Compare experiments by run ID."""
    if not run_ids:
        raise click.UsageError("Provide at least one run ID")

    tracker = ExperimentTracker(project=project, use_wandb=False)
    comparison = tracker.compare(list(run_ids))

    if not comparison:
        click.echo("No matching runs found.")
        return

    # Gather all metric names
    all_keys = sorted(set(k for metrics in comparison.values() for k in metrics))

    # Header
    header = f"{'Metric':30s}"
    for rid in comparison:
        header += f"  {rid[:20]:>20s}"
    click.echo(header)
    click.echo("-" * len(header))

    for key in all_keys:
        row = f"{key:30s}"
        for rid in comparison:
            val = comparison[rid].get(key)
            row += f"  {val:>20.4f}" if val is not None else f"  {'N/A':>20s}"
        click.echo(row)


@cli.command()
@click.argument("run_id")
@click.option("--project", default="ci-model-stack")
def show(run_id, project):
    """Show details for a single experiment."""
    tracker = ExperimentTracker(project=project, use_wandb=False)
    exp = tracker.load(run_id)
    if exp is None:
        click.echo(f"Run {run_id} not found.")
        return

    click.echo(f"Run ID:      {exp.run_id}")
    click.echo(f"Name:        {exp.name}")
    click.echo(f"Status:      {exp.status}")
    click.echo(f"Created:     {exp.created_at}")
    click.echo(f"Finished:    {exp.finished_at or 'N/A'}")
    click.echo(f"Tags:        {', '.join(exp.tags) or 'none'}")
    click.echo(f"Hyperparams: {json.dumps(exp.hyperparams, indent=2)}")
    click.echo("Latest metrics:")
    for k, v in exp.latest_metrics().items():
        click.echo(f"  {k}: {v:.6f}")
    if exp.artifacts:
        click.echo("Artifacts:")
        for a in exp.artifacts:
            click.echo(f"  {a}")


if __name__ == "__main__":
    cli()
