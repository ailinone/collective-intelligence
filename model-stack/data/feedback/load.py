# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Feedback Load: Register staging data into the training pipeline.

Copies approved staging JSONL to dated dataset directories and registers
them in the dataset manifest registry for inclusion in training mixes.

Usage:
  python data/feedback/load.py \
    --staging-dir ./data/feedback/staging \
    --sft-dir ./data/sft/feedback \
    --dpo-dir ./data/preference/feedback \
    --manifest-dir ./datasets/manifests \
    --lineage-dir ./datasets/lineage
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

import click
import yaml

logger = logging.getLogger(__name__)


@click.command()
@click.option("--staging-dir", required=True, type=click.Path(exists=True), help="Staging directory")
@click.option("--sft-dir", required=True, type=click.Path(), help="SFT output directory")
@click.option("--dpo-dir", required=True, type=click.Path(), help="DPO output directory")
@click.option("--manifest-dir", required=True, type=click.Path(), help="Dataset manifests directory")
@click.option("--lineage-dir", required=True, type=click.Path(), help="Lineage records directory")
def main(
    staging_dir: str,
    sft_dir: str,
    dpo_dir: str,
    manifest_dir: str,
    lineage_dir: str,
) -> None:
    """Load approved staging data into training datasets."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    staging = Path(staging_dir)
    sft_out = Path(sft_dir)
    dpo_out = Path(dpo_dir)
    manifests = Path(manifest_dir)
    lineage = Path(lineage_dir)

    for d in [sft_out, dpo_out, manifests, lineage]:
        d.mkdir(parents=True, exist_ok=True)

    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Copy SFT staging to dated file
    sft_staging = staging / "sft_staging.jsonl"
    if sft_staging.exists() and sft_staging.stat().st_size > 0:
        sft_dest = sft_out / f"feedback-sft-{date_str}.jsonl"
        shutil.copy2(sft_staging, sft_dest)
        sft_count = sum(1 for _ in open(sft_dest))
        logger.info(f"SFT: {sft_count} records → {sft_dest}")

        # Write manifest
        sft_manifest = {
            "name": f"feedback-sft-{date_str}",
            "version": "1.0.0",
            "source_url": "ci-api-execution-outcomes",
            "license": "proprietary",
            "format": "jsonl",
            "splits": [{
                "name": "train",
                "num_rows": sft_count,
                "path": str(sft_dest),
            }],
            "row_count": sft_count,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "tags": ["feedback", "sft", "ci-api", "routing-optimization"],
            "pii_status": "redacted",
            "contamination_status": "not_checked",
        }
        with open(manifests / f"feedback_sft_{date_str}.yaml", "w") as f:
            yaml.dump(sft_manifest, f, default_flow_style=False)
    else:
        logger.info("No SFT staging data to load")

    # Copy DPO staging to dated file
    dpo_staging = staging / "dpo_staging.jsonl"
    if dpo_staging.exists() and dpo_staging.stat().st_size > 0:
        dpo_dest = dpo_out / f"feedback-dpo-{date_str}.jsonl"
        shutil.copy2(dpo_staging, dpo_dest)
        dpo_count = sum(1 for _ in open(dpo_dest))
        logger.info(f"DPO: {dpo_count} records → {dpo_dest}")

        dpo_manifest = {
            "name": f"feedback-dpo-{date_str}",
            "version": "1.0.0",
            "source_url": "ci-api-shadow-evaluations",
            "license": "proprietary",
            "format": "jsonl",
            "splits": [{
                "name": "train",
                "num_rows": dpo_count,
                "path": str(dpo_dest),
            }],
            "row_count": dpo_count,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "tags": ["feedback", "dpo", "ci-api", "preference-learning"],
            "pii_status": "redacted",
            "contamination_status": "not_checked",
        }
        with open(manifests / f"feedback_dpo_{date_str}.yaml", "w") as f:
            yaml.dump(dpo_manifest, f, default_flow_style=False)
    else:
        logger.info("No DPO staging data to load")

    # Write lineage record
    staging_report = staging / "staging_report.json"
    lineage_record = {
        "date": date_str,
        "loaded_at": datetime.now(timezone.utc).isoformat(),
        "staging_report": json.loads(staging_report.read_text()) if staging_report.exists() else None,
    }
    with open(lineage / f"feedback-lineage-{date_str}.json", "w") as f:
        json.dump(lineage_record, f, indent=2, default=str)

    logger.info(f"Lineage record written to {lineage / f'feedback-lineage-{date_str}.json'}")


if __name__ == "__main__":
    main()
