#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Resume Training from Checkpoint
================================
Finds and validates the latest checkpoint, then relaunches training.

Usage
-----
    python resume.py --config ../configs/pretrain_1b.yaml
    python resume.py --config ../configs/pretrain_1b.yaml --checkpoint-dir ./checkpoints/ailin-1b
    python resume.py --config ../configs/pretrain_1b.yaml --step 50000  # resume from specific step
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import click
import yaml

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def compute_config_hash(config_path: str) -> str:
    """Compute the model config hash for validation against checkpoint."""
    with open(config_path) as f:
        raw = yaml.safe_load(f)

    model = raw.get("model", {})
    keys = [
        "hidden_size", "num_attention_heads", "num_key_value_heads",
        "num_hidden_layers", "intermediate_size", "vocab_size",
        "max_position_embeddings",
    ]
    payload = {k: model.get(k) for k in keys}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def find_checkpoints(checkpoint_dir: str):
    """Find all valid checkpoints in directory, sorted by step."""
    ckpt_dir = Path(checkpoint_dir)
    if not ckpt_dir.exists():
        return []

    checkpoints = []
    for d in ckpt_dir.iterdir():
        if d.is_dir() and d.name.startswith("step-"):
            try:
                step = int(d.name.split("-")[1])
                meta_file = d / "metadata.json"
                meta = {}
                if meta_file.exists():
                    with open(meta_file) as f:
                        meta = json.load(f)
                checkpoints.append({
                    "path": d,
                    "step": step,
                    "meta": meta,
                })
            except (ValueError, json.JSONDecodeError) as e:
                logger.warning("Skipping invalid checkpoint %s: %s", d, e)

    checkpoints.sort(key=lambda c: c["step"])
    return checkpoints


def validate_checkpoint(
    ckpt_path: Path,
    expected_config_hash: Optional[str] = None,
) -> tuple[bool, list[str]]:
    """
    Validate checkpoint integrity:
    - metadata.json exists and is valid
    - config hash matches (if provided)
    - model state files exist
    - no corrupted files (basic size check)
    """
    issues = []

    if not ckpt_path.exists():
        return False, ["Checkpoint directory does not exist"]

    # Metadata
    meta_file = ckpt_path / "metadata.json"
    if not meta_file.exists():
        issues.append("Missing metadata.json")
    else:
        try:
            with open(meta_file) as f:
                meta = json.load(f)

            if expected_config_hash:
                ckpt_hash = meta.get("config_hash", "")
                if ckpt_hash != expected_config_hash:
                    issues.append(
                        f"Config hash mismatch: checkpoint has '{ckpt_hash}', "
                        f"current config has '{expected_config_hash}'. "
                        f"Model architecture may have changed."
                    )

            if "step" not in meta:
                issues.append("Metadata missing 'step' field")

        except json.JSONDecodeError as e:
            issues.append(f"Corrupted metadata.json: {e}")

    # Model state files
    has_model = False
    state_patterns = [
        "pytorch_model*.bin",
        "model*.safetensors",
        "*.bin",
        "*.safetensors",
    ]
    for pattern in state_patterns:
        if list(ckpt_path.rglob(pattern)):
            has_model = True
            break

    # DeepSpeed format
    if not has_model:
        ds_dirs = list(ckpt_path.glob("global_step*"))
        if ds_dirs:
            has_model = True

    if not has_model:
        issues.append("No model state files found")

    # Check for zero-byte files (corruption indicator)
    for f in ckpt_path.rglob("*"):
        if f.is_file() and f.suffix in (".bin", ".safetensors", ".pt") and f.stat().st_size == 0:
            issues.append(f"Zero-byte file detected: {f.name}")

    critical_issues = [
        i for i in issues
        if "Missing metadata" not in i and "optimizer" not in i.lower()
    ]
    is_valid = len(critical_issues) == 0

    return is_valid, issues


@click.command()
@click.option("--config", required=True, type=click.Path(exists=True), help="Path to YAML training config.")
@click.option("--checkpoint-dir", default=None, type=str, help="Override checkpoint directory.")
@click.option("--step", default=None, type=int, help="Resume from specific step (default: latest).")
@click.option("--validate-only", is_flag=True, help="Only validate, don't launch training.")
@click.option("--accelerate-config", default=None, type=str, help="Path to accelerate config.")
@click.option("--num-processes", default=None, type=int, help="Number of processes for accelerate.")
def main(
    config: str,
    checkpoint_dir: Optional[str],
    step: Optional[int],
    validate_only: bool,
    accelerate_config: Optional[str],
    num_processes: Optional[int],
):
    """Resume training from a checkpoint."""
    # Load config to find checkpoint dir
    with open(config) as f:
        raw_config = yaml.safe_load(f)

    if checkpoint_dir is None:
        checkpoint_dir = raw_config.get("checkpointing", {}).get("save_dir", "./checkpoints/ailin-1b")

    logger.info("Looking for checkpoints in: %s", checkpoint_dir)

    # Find checkpoints
    checkpoints = find_checkpoints(checkpoint_dir)
    if not checkpoints:
        logger.error("No checkpoints found in %s", checkpoint_dir)
        sys.exit(1)

    logger.info("Found %d checkpoint(s):", len(checkpoints))
    for ckpt in checkpoints:
        step_num = ckpt["step"]
        val_loss = ckpt["meta"].get("metrics", {}).get("val_loss", "N/A")
        ts = ckpt["meta"].get("timestamp", "N/A")
        logger.info("  step-%d  val_loss=%s  timestamp=%s", step_num, val_loss, ts)

    # Select checkpoint
    if step is not None:
        selected = None
        for ckpt in checkpoints:
            if ckpt["step"] == step:
                selected = ckpt
                break
        if selected is None:
            logger.error("No checkpoint found for step %d", step)
            available = [c["step"] for c in checkpoints]
            logger.error("Available steps: %s", available)
            sys.exit(1)
    else:
        selected = checkpoints[-1]  # latest

    logger.info("Selected checkpoint: step-%d at %s", selected["step"], selected["path"])

    # Validate
    expected_hash = compute_config_hash(config)
    logger.info("Current config hash: %s", expected_hash)

    is_valid, issues = validate_checkpoint(selected["path"], expected_hash)

    if issues:
        for issue in issues:
            level = logging.WARNING if is_valid else logging.ERROR
            logger.log(level, "  %s", issue)

    if not is_valid:
        logger.error("Checkpoint validation FAILED. Cannot resume safely.")
        if not click.confirm("Resume anyway (dangerous)?"):
            sys.exit(1)
        logger.warning("Proceeding despite validation failures (user override).")
    else:
        logger.info("Checkpoint validation PASSED.")

    if validate_only:
        logger.info("Validate-only mode. Exiting.")
        return

    # Build accelerate launch command
    train_script = str(Path(__file__).parent.parent / "launcher" / "train.py")

    cmd = ["accelerate", "launch"]

    if accelerate_config:
        cmd.extend(["--config_file", accelerate_config])

    if num_processes:
        cmd.extend(["--num_processes", str(num_processes)])

    cmd.extend([
        train_script,
        "--config", config,
        "--resume",
    ])

    logger.info("Launching training: %s", " ".join(cmd))
    logger.info("Resuming from step %d", selected["step"])

    # Execute
    try:
        result = subprocess.run(cmd, check=True)
        sys.exit(result.returncode)
    except subprocess.CalledProcessError as e:
        logger.error("Training process exited with code %d", e.returncode)
        sys.exit(e.returncode)
    except FileNotFoundError:
        logger.error(
            "Could not find 'accelerate'. "
            "Install with: pip install accelerate"
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
