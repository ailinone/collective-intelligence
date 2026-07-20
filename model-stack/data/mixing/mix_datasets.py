# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Dataset mixing pipeline.

Takes multiple dataset paths with mixing weights (from YAML config),
supports temperature-based sampling and epoch/token-count mixing,
and outputs a single shuffled mixed dataset.
"""

from __future__ import annotations

import json
import logging
import math
import random
import time
from pathlib import Path
from typing import Any

import click
import jsonlines
import yaml
from pydantic import BaseModel, Field, field_validator
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config models
# ---------------------------------------------------------------------------

class DatasetSource(BaseModel):
    """A single dataset source in the mix."""

    path: str
    weight: float = Field(gt=0.0)
    name: str | None = None
    max_epochs: float = Field(default=float("inf"), gt=0.0)
    max_tokens: int | None = None  # If set, limits total tokens from this source

    @field_validator("name", mode="before")
    @classmethod
    def default_name(cls, v: str | None, info: Any) -> str:
        if v is None:
            return Path(info.data.get("path", "unknown")).stem
        return v


class MixConfig(BaseModel):
    """Configuration for dataset mixing."""

    sources: list[DatasetSource]
    output_path: str
    seed: int = 42
    temperature: float = Field(default=1.0, gt=0.0)
    total_tokens: int | None = None  # Total token budget for the mix
    total_samples: int | None = None  # Total sample budget
    shuffle_buffer_size: int = 100_000
    max_repetition: float = Field(default=3.0, gt=0.0)  # Max times a source can be repeated

    @field_validator("sources")
    @classmethod
    def at_least_one(cls, v: list[DatasetSource]) -> list[DatasetSource]:
        if not v:
            raise ValueError("At least one dataset source is required")
        return v


# ---------------------------------------------------------------------------
# Counting utilities
# ---------------------------------------------------------------------------

def count_records(path: Path) -> int:
    """Count records in a JSONL file."""
    count = 0
    with jsonlines.open(path, mode="r") as reader:
        for _ in reader:
            count += 1
    return count


def estimate_tokens(text: str) -> int:
    """Estimate token count from text using whitespace heuristic (~1.3 tokens per word)."""
    return int(len(text.split()) * 1.3)


# ---------------------------------------------------------------------------
# Temperature-based weight adjustment
# ---------------------------------------------------------------------------

def apply_temperature(weights: list[float], temperature: float) -> list[float]:
    """
    Apply temperature scaling to mixing weights.

    temperature < 1.0: sharpens distribution (favors higher-weight sources)
    temperature = 1.0: no change
    temperature > 1.0: flattens distribution (more uniform mixing)
    """
    if temperature == 1.0:
        return weights

    # Apply temperature: w_i^(1/T) then renormalize
    scaled = [w ** (1.0 / temperature) for w in weights]
    total = sum(scaled)
    return [w / total for w in scaled]


# ---------------------------------------------------------------------------
# Core mixing
# ---------------------------------------------------------------------------

def run_mix_datasets(
    config: MixConfig,
    report_path: Path,
) -> dict[str, Any]:
    """Execute the dataset mixing pipeline."""
    start_time = time.time()
    rng = random.Random(config.seed)

    output_path = Path(config.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Phase 1: Count source sizes
    logger.info("Phase 1: Counting source dataset sizes...")
    source_sizes: dict[str, int] = {}
    for src in config.sources:
        src_path = Path(src.path)
        if not src_path.exists():
            raise FileNotFoundError(f"Source dataset not found: {src_path}")
        size = count_records(src_path)
        source_sizes[src.name or src.path] = size
        logger.info("  %s: %d records", src.name, size)

    # Phase 2: Compute effective weights with temperature
    raw_weights = [src.weight for src in config.sources]
    total_raw = sum(raw_weights)
    normalized = [w / total_raw for w in raw_weights]
    effective_weights = apply_temperature(normalized, config.temperature)

    logger.info("Effective weights (temp=%.2f):", config.temperature)
    for src, w, ew in zip(config.sources, normalized, effective_weights):
        logger.info("  %s: raw=%.4f effective=%.4f", src.name, w, ew)

    # Phase 3: Compute sample counts per source
    if config.total_samples is not None:
        total_budget = config.total_samples
    elif config.total_tokens is not None:
        # Rough estimate: assume ~250 tokens per sample on average
        total_budget = config.total_tokens // 250
    else:
        # Default: one epoch of the largest source
        total_budget = sum(source_sizes.values())

    samples_per_source: dict[str, int] = {}
    for src, ew in zip(config.sources, effective_weights):
        src_name = src.name or src.path
        desired = int(total_budget * ew)
        src_size = source_sizes[src_name]

        # Enforce max repetition
        max_from_epochs = int(src_size * min(src.max_epochs, config.max_repetition))
        actual = min(desired, max_from_epochs)

        # Enforce token budget per source
        if src.max_tokens is not None:
            # Rough: ~250 tokens per sample
            token_limited = src.max_tokens // 250
            actual = min(actual, token_limited)

        samples_per_source[src_name] = actual
        epochs_used = actual / max(src_size, 1)
        logger.info(
            "  %s: %d samples (%.2f epochs of %d)", src_name, actual, epochs_used, src_size
        )

    # Phase 4: Sample from each source
    logger.info("Phase 4: Sampling records...")
    all_records: list[dict[str, Any]] = []

    for src in config.sources:
        src_name = src.name or src.path
        target_count = samples_per_source[src_name]
        src_path = Path(src.path)
        src_size = source_sizes[src_name]

        if target_count == 0:
            continue

        # Full epochs
        full_epochs = target_count // max(src_size, 1)
        remainder = target_count - (full_epochs * src_size)

        records: list[dict[str, Any]] = []
        with jsonlines.open(src_path, mode="r") as reader:
            for record in reader:
                records.append(record)

        for epoch in range(full_epochs):
            for record in records:
                enriched = dict(record)
                enriched.setdefault("metadata", {})["_mix_source"] = src_name
                enriched["metadata"]["_mix_epoch"] = epoch
                all_records.append(enriched)

        # Partial epoch: sample remainder
        if remainder > 0 and records:
            sampled = rng.sample(records, min(remainder, len(records)))
            for record in sampled:
                enriched = dict(record)
                enriched.setdefault("metadata", {})["_mix_source"] = src_name
                enriched["metadata"]["_mix_epoch"] = full_epochs
                all_records.append(enriched)

        logger.info(
            "  Sampled %d records from %s (%d full epochs + %d partial)",
            min(target_count, len(records) * (full_epochs + 1)),
            src_name,
            full_epochs,
            remainder,
        )

    # Phase 5: Shuffle and write
    logger.info("Phase 5: Shuffling %d total records...", len(all_records))
    rng.shuffle(all_records)

    # Apply token budget if specified
    if config.total_tokens is not None:
        logger.info("Applying token budget: %d tokens", config.total_tokens)
        token_count = 0
        trimmed: list[dict[str, Any]] = []
        for record in all_records:
            text = record.get("text", "")
            tokens = estimate_tokens(text)
            if token_count + tokens > config.total_tokens:
                break
            trimmed.append(record)
            token_count += tokens
        logger.info("Token budget: kept %d records (%d tokens)", len(trimmed), token_count)
        all_records = trimmed

    logger.info("Writing %d records to %s...", len(all_records), output_path)
    with jsonlines.open(output_path, mode="w") as writer:
        for record in tqdm(all_records, desc="Writing mixed dataset", unit=" records"):
            writer.write(record)

    elapsed = time.time() - start_time

    # Build report
    source_counts: dict[str, int] = {}
    for record in all_records:
        src = record.get("metadata", {}).get("_mix_source", "unknown")
        source_counts[src] = source_counts.get(src, 0) + 1

    report = {
        "output_file": str(output_path),
        "config": {
            "seed": config.seed,
            "temperature": config.temperature,
            "total_tokens": config.total_tokens,
            "total_samples": config.total_samples,
            "max_repetition": config.max_repetition,
        },
        "sources": {
            src.name: {
                "path": src.path,
                "raw_weight": src.weight,
                "effective_weight": round(ew, 6),
                "source_size": source_sizes.get(src.name or src.path, 0),
                "samples_target": samples_per_source.get(src.name or src.path, 0),
                "samples_actual": source_counts.get(src.name or src.path, 0),
                "epochs_used": round(
                    source_counts.get(src.name or src.path, 0)
                    / max(source_sizes.get(src.name or src.path, 1), 1),
                    3,
                ),
            }
            for src, ew in zip(config.sources, effective_weights)
        },
        "total_records_output": len(all_records),
        "elapsed_seconds": round(elapsed, 2),
    }

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    logger.info("Mix complete: %d records written in %.1fs", len(all_records), elapsed)
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("mix-datasets")
@click.option("--config", "config_path", required=True, type=click.Path(exists=True), help="Mix config YAML file")
@click.option("--report", "report_path", default=None, type=click.Path(), help="Output report JSON path")
@click.option("--seed", default=None, type=int, help="Override random seed from config")
@click.option("--temperature", default=None, type=float, help="Override temperature from config")
@click.option("--total-samples", default=None, type=int, help="Override total sample count")
@click.option("--total-tokens", default=None, type=int, help="Override total token budget")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    config_path: str,
    report_path: str | None,
    seed: int | None,
    temperature: float | None,
    total_samples: int | None,
    total_tokens: int | None,
    log_level: str,
) -> None:
    """Mix multiple datasets according to weighted config."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    with open(config_path, "r", encoding="utf-8") as f:
        raw_config = yaml.safe_load(f)

    config = MixConfig(**raw_config)

    # CLI overrides
    if seed is not None:
        config.seed = seed
    if temperature is not None:
        config.temperature = temperature
    if total_samples is not None:
        config.total_samples = total_samples
    if total_tokens is not None:
        config.total_tokens = total_tokens

    output_p = Path(config.output_path)
    if report_path is None:
        report_p = output_p.with_suffix(".mix_report.json")
    else:
        report_p = Path(report_path)

    report = run_mix_datasets(config, report_p)

    click.echo(f"\n--- Dataset Mix Report ---")
    click.echo(f"Total output records: {report['total_records_output']:>10,}")
    click.echo(f"\nSource breakdown:")
    for name, info in report["sources"].items():
        click.echo(
            f"  {name:30s} "
            f"samples={info['samples_actual']:>8,} "
            f"epochs={info['epochs_used']:.2f} "
            f"weight={info['effective_weight']:.4f}"
        )
    click.echo(f"\nElapsed time: {report['elapsed_seconds']:.1f}s")
    click.echo(f"Output: {report['output_file']}")
    click.echo(f"Report: {report_p}")


if __name__ == "__main__":
    cli()
