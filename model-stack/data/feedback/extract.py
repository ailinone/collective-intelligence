# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Feedback Extract: Validate and parse extracted JSONL from the CI API.

Reads the extraction manifest, verifies SHA-256 checksums, and parses
JSONL records into validated Pydantic models.

Usage:
  python data/feedback/extract.py --manifest ./export/extraction-manifest-2026-04-01.json --output ./data/feedback/validated
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import click
import jsonlines
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ─── Record Models ────────────────────────────────────────────────────────────

class OutcomeRecord(BaseModel):
    """A single execution outcome from the CI API."""
    trace_id_hash: str
    strategy: str
    task_type: str = "general"
    complexity: str = "medium"
    quality_score: float | None = None
    quality_dimensions: dict[str, float] | None = None
    latency_ms: int = 0
    cost_usd: float = 0.0
    total_tokens: int = 0
    success: bool = False
    feedback_iterations: int = 1
    models_used: list[str] = Field(default_factory=list)
    decision_source: str | None = None
    input_hash: str | None = None
    created_at: str = ""


class ShadowRecord(BaseModel):
    """A shadow evaluation comparison from the CI API."""
    trace_id_hash: str
    task_type: str
    complexity: str
    chosen_strategy: str
    chosen_quality: float
    shadow_strategy: str
    shadow_quality: float
    quality_regret: float
    winner_strategy: str
    created_at: str = ""


class ExtractionManifest(BaseModel):
    """Manifest produced by the API extraction job."""
    extraction_id: str
    extracted_at: str
    outcomes: dict[str, Any]
    shadow: dict[str, Any]
    watermarks: dict[str, Any]


# ─── Validation ───────────────────────────────────────────────────────────────

def verify_sha256(file_path: Path, expected_sha256: str) -> bool:
    """Verify file integrity via SHA-256 checksum."""
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha.update(chunk)
    actual = sha.hexdigest()
    if actual != expected_sha256:
        logger.error(f"SHA-256 mismatch for {file_path}: expected {expected_sha256}, got {actual}")
        return False
    return True


def parse_outcomes(file_path: Path) -> list[OutcomeRecord]:
    """Parse and validate outcome records from JSONL."""
    records: list[OutcomeRecord] = []
    errors = 0
    with jsonlines.open(file_path, mode="r") as reader:
        for i, row in enumerate(reader):
            try:
                records.append(OutcomeRecord(**row))
            except Exception as e:
                errors += 1
                if errors <= 5:
                    logger.warning(f"Row {i} parse error: {e}")
    logger.info(f"Parsed {len(records)} outcomes, {errors} errors from {file_path}")
    return records


def parse_shadow(file_path: Path) -> list[ShadowRecord]:
    """Parse and validate shadow evaluation records from JSONL."""
    records: list[ShadowRecord] = []
    errors = 0
    with jsonlines.open(file_path, mode="r") as reader:
        for i, row in enumerate(reader):
            try:
                records.append(ShadowRecord(**row))
            except Exception as e:
                errors += 1
                if errors <= 5:
                    logger.warning(f"Row {i} parse error: {e}")
    logger.info(f"Parsed {len(records)} shadow evals, {errors} errors from {file_path}")
    return records


# ─── CLI ──────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--manifest", required=True, type=click.Path(exists=True), help="Path to extraction manifest JSON")
@click.option("--output", required=True, type=click.Path(), help="Output directory for validated records")
def main(manifest: str, output: str) -> None:
    """Validate and parse extracted JSONL from the CI API."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    manifest_path = Path(manifest)
    output_dir = Path(output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load manifest
    with open(manifest_path) as f:
        mf = ExtractionManifest(**json.load(f))

    base_dir = manifest_path.parent
    logger.info(f"Extraction ID: {mf.extraction_id}, extracted at: {mf.extracted_at}")

    # Verify and parse outcomes
    outcomes_file = base_dir / mf.outcomes["file"]
    if outcomes_file.exists():
        if not verify_sha256(outcomes_file, mf.outcomes["sha256"]):
            raise click.ClickException(f"Checksum failed for {outcomes_file}")
        outcomes = parse_outcomes(outcomes_file)
        # Write validated records
        with jsonlines.open(output_dir / "outcomes.jsonl", mode="w") as w:
            for r in outcomes:
                w.write(r.model_dump())
        logger.info(f"Wrote {len(outcomes)} validated outcomes to {output_dir / 'outcomes.jsonl'}")
    else:
        logger.warning(f"Outcomes file not found: {outcomes_file}")

    # Verify and parse shadow evaluations
    shadow_file = base_dir / mf.shadow["file"]
    if shadow_file.exists():
        if not verify_sha256(shadow_file, mf.shadow["sha256"]):
            raise click.ClickException(f"Checksum failed for {shadow_file}")
        shadow = parse_shadow(shadow_file)
        with jsonlines.open(output_dir / "shadow.jsonl", mode="w") as w:
            for r in shadow:
                w.write(r.model_dump())
        logger.info(f"Wrote {len(shadow)} validated shadow evals to {output_dir / 'shadow.jsonl'}")
    else:
        logger.warning(f"Shadow file not found: {shadow_file}")


if __name__ == "__main__":
    main()
