# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Coordinator-stable LoRA SFT orchestrator
=========================================

Trains the 24 coord-stable students from teacher_traces SFT data.
Wraps the existing alignment/sft/train_sft.py trainer; this module
owns the coord-specific config translation:

    model/configs/coord-stable/m{NN}.yaml + _shared.yaml
        ↓ load + merge inheritance
        ↓ translate to alignment/sft/sft_config.yaml shape
        ↓ subprocess: python -m alignment.sft.train_sft --config <generated>
        ↓ ./checkpoints/coord-stable/m{NN}/

Pipeline:
    1. Resolve `coord-stable/m{NN}.yaml` with `_shared.yaml` inheritance
    2. Translate to SFT trainer schema (model/data/training/lora blocks)
    3. Invoke train_sft.py (subprocess by default; importable for tests)
    4. Optionally loop M01..M24 (or filter by tier/specialty)

Why a separate orchestrator instead of pointing train_sft.py at the
coord configs directly: the coord configs declare *what* to train (the
24-student matrix shape — tier, specialty, base model, partition
strategy) while the SFT trainer config declares *how* (training args,
LoRA hyperparams, output paths). This module is the bridge.

Usage:
    # Train one coordinator
    python -m alignment.sft.train_sft_coord --model-id m01

    # Train all 24
    python -m alignment.sft.train_sft_coord --all

    # Only tier-1 encoders
    python -m alignment.sft.train_sft_coord --all --tier 1

    # Dry-run — print resolved configs without invoking trainer
    python -m alignment.sft.train_sft_coord --all --dry-run
"""

from __future__ import annotations

import copy
import logging
import shlex
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import click
import yaml

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Defaults — paths and discovery
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
COORD_CONFIG_DIR = REPO_ROOT / "model" / "configs" / "coord-stable"
DEFAULT_DATA_DIR = REPO_ROOT / "data" / "feedback" / "sft-coord"
DEFAULT_CHECKPOINT_ROOT = REPO_ROOT / "checkpoints" / "coord-stable"
DEFAULT_GENERATED_CONFIG_DIR = REPO_ROOT / "alignment" / "sft" / "_generated"


# ---------------------------------------------------------------------------
# YAML inheritance — m{NN}.yaml has `inherits: "_shared.yaml"` and the
# child's leaf scalars/lists override the parent. Dicts are deep-merged.
# ---------------------------------------------------------------------------


def _deep_merge(parent: dict[str, Any], child: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge two dicts; child wins on conflicting leaves.

    Lists are replaced (not concatenated). This matches how a child
    config's `target_modules:` should fully override the parent's,
    rather than appending to it.
    """
    merged = copy.deepcopy(parent)
    for key, value in child.items():
        if key == "inherits":
            continue
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def load_coord_config(model_id: str, config_dir: Path = COORD_CONFIG_DIR) -> dict[str, Any]:
    """Load and merge a coord config (m{NN}.yaml + parent chain).

    Resolves the `inherits:` directive recursively. The shared parent
    is `_shared.yaml`; future variants could chain further (e.g. a
    `_moe.yaml` between m17.yaml and _shared.yaml).
    """
    child_path = config_dir / f"{model_id}.yaml"
    if not child_path.exists():
        raise FileNotFoundError(f"Coord config not found: {child_path}")

    with open(child_path, encoding="utf-8") as f:
        child = yaml.safe_load(f) or {}

    parent_name = child.get("inherits")
    if not parent_name:
        return child

    parent_path = config_dir / parent_name
    if not parent_path.exists():
        raise FileNotFoundError(
            f"Parent config not found: {parent_path} (referenced by {child_path})"
        )

    with open(parent_path, encoding="utf-8") as f:
        parent = yaml.safe_load(f) or {}

    # Recursively resolve parent's inheritance too — supports multi-level
    # chains without explicit recursion in callers.
    if parent.get("inherits"):
        parent = _deep_merge(load_coord_config_from_path(parent_path, config_dir), parent)

    return _deep_merge(parent, child)


def load_coord_config_from_path(path: Path, config_dir: Path) -> dict[str, Any]:
    """Helper for recursive inheritance resolution given an arbitrary path."""
    with open(path, encoding="utf-8") as f:
        node = yaml.safe_load(f) or {}
    parent_name = node.get("inherits")
    if not parent_name:
        return node
    return _deep_merge(load_coord_config_from_path(config_dir / parent_name, config_dir), node)


# ---------------------------------------------------------------------------
# Translation — coord-stable schema → SFT trainer schema
# ---------------------------------------------------------------------------


@dataclass
class TranslationOptions:
    """Per-run paths overridable for tests / one-off runs."""

    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    checkpoint_root: Path = field(default_factory=lambda: DEFAULT_CHECKPOINT_ROOT)


def translate_to_sft_config(
    coord_config: dict[str, Any],
    options: TranslationOptions | None = None,
) -> dict[str, Any]:
    """Map a resolved coord config to the SFT trainer's expected schema.

    The SFT trainer reads sections: `model`, `data`, `training`, `lora`,
    `checkpointing`, `evaluation`, `logging`, `merge`. We surface only
    the fields that change between coordinators (base_model, lora rank,
    epochs, output dir); everything else gets a sensible coord-default.
    """
    options = options or TranslationOptions()
    model_id = coord_config["model_id"]
    fine_tune = coord_config.get("fine_tune", {})
    training = coord_config.get("training", {})
    serving = coord_config.get("serving", {})

    return {
        "run_name": f"coord-stable-{model_id}",
        "seed": 42,
        "model": {
            "base_model": coord_config["base_model"],
            "tokenizer": coord_config["base_model"],  # use the base model's tokenizer
            "torch_dtype": (
                "bf16" if training.get("precision", "bfloat16") == "bfloat16" else "fp32"
            ),
            "attn_implementation": (
                "flash_attention_2" if training.get("flash_attention_2", False) else "sdpa"
            ),
        },
        "data": {
            "dataset_path": str(options.data_dir),
            "dataset_format": "messages",
            "max_length": int(training.get("max_seq_length", serving.get("max_model_len", 2048))),
            "eval_split": float(coord_config.get("data", {}).get("validation_split", 0.05)),
            "preprocessing_num_workers": 4,
            "packing": True,
        },
        "training": {
            "epochs": int(training.get("num_epochs", 3)),
            "per_device_train_batch_size": int(training.get("micro_batch_size", 4)),
            "per_device_eval_batch_size": int(training.get("micro_batch_size", 4)),
            "gradient_accumulation_steps": int(training.get("gradient_accumulation_steps", 4)),
            "learning_rate": float(training.get("learning_rate", 2.0e-4)),
            "weight_decay": float(training.get("weight_decay", 0.0)),
            "warmup_ratio": float(training.get("warmup_ratio", 0.03)),
            "lr_scheduler_type": str(training.get("lr_scheduler", "cosine")),
            "gradient_clipping": 1.0,
            "bf16": True,
            "tf32": True,
            "dataloader_num_workers": 2,
            "optim": "adamw_torch",
        },
        "lora": {
            "enabled": fine_tune.get("method") in {"lora", "moe_lora"},
            "r": int(fine_tune.get("rank", 16)),
            "lora_alpha": int(fine_tune.get("alpha", 32)),
            "lora_dropout": float(fine_tune.get("dropout", 0.05)),
            "target_modules": list(fine_tune.get("target_modules", [])),
            "modules_to_save": list(fine_tune.get("modules_to_save", [])),
            "bias": str(fine_tune.get("bias", "none")),
            "task_type": (
                "SEQ_CLS" if coord_config.get("architecture") == "encoder_only" else "CAUSAL_LM"
            ),
        },
        "checkpointing": {
            "output_dir": str(options.checkpoint_root / model_id),
            "save_strategy": "steps",
            "save_steps": 200,
            "save_total_limit": 3,
            "load_best_model_at_end": True,
            "metric_for_best_model": "eval_loss",
            "greater_is_better": False,
        },
        "evaluation": {
            "eval_strategy": "steps",
            "eval_steps": 100,
        },
        "logging": {
            "logging_steps": 10,
            "report_to": "wandb",
            "wandb": {
                "project": "ailin-coord-stable",
                "entity": None,
                "tags": [
                    f"tier{coord_config.get('tier', '?')}",
                    coord_config.get("specialty", "unknown"),
                    coord_config.get("family", "unknown"),
                    "lora",
                ],
            },
        },
        "merge": {
            "merge_adapters": False,
            "output_dir": str(options.checkpoint_root / model_id / "merged"),
            "push_to_hub": False,
        },
    }


# ---------------------------------------------------------------------------
# Trainer invocation
# ---------------------------------------------------------------------------


def write_generated_config(
    sft_config: dict[str, Any],
    out_dir: Path | None = None,
) -> Path:
    """Write the translated SFT config to disk, returning the path.

    Generated files live in `_generated/` so they're easy to .gitignore;
    each filename matches the run_name for traceability. `out_dir` is
    looked up at call time (not def time) so tests can monkeypatch the
    module-level default.
    """
    resolved = out_dir or DEFAULT_GENERATED_CONFIG_DIR
    resolved.mkdir(parents=True, exist_ok=True)
    target = resolved / f"{sft_config['run_name']}.yaml"
    with open(target, "w", encoding="utf-8") as f:
        yaml.safe_dump(sft_config, f, sort_keys=False)
    return target


def invoke_trainer(
    config_path: Path,
    *,
    python: str = sys.executable,
    extra_args: Iterable[str] = (),
    runner: callable = subprocess.run,  # injectable for tests
) -> subprocess.CompletedProcess:
    """Spawn `train_sft.py --config <config_path>`.

    `runner` is overridable so tests can inject a fake without actually
    spinning up GPUs. Real callers should leave it at the default.
    """
    cmd = [
        python,
        "-m",
        "alignment.sft.train_sft",
        "--config",
        str(config_path),
        *extra_args,
    ]
    logger.info("invoking trainer: %s", " ".join(shlex.quote(c) for c in cmd))
    return runner(cmd, check=False, text=True)


# ---------------------------------------------------------------------------
# High-level orchestrator
# ---------------------------------------------------------------------------


@dataclass
class TrainPlan:
    """A planned training run for one coordinator."""

    model_id: str
    coord_config: dict[str, Any]
    sft_config: dict[str, Any]
    config_path: Path | None = None  # set after write_generated_config
    return_code: int | None = None


def plan_run(
    model_id: str,
    *,
    config_dir: Path | None = None,
    options: TranslationOptions | None = None,
    write_config: bool = True,
    out_dir: Path | None = None,
) -> TrainPlan:
    """Resolve config + translate + (optionally) write the generated file.

    Returns a TrainPlan object so callers can inspect/log before
    actually invoking the trainer. `config_dir` and `out_dir` are
    looked up at call time so tests can monkeypatch the module
    globals.
    """
    resolved_config_dir = config_dir or COORD_CONFIG_DIR
    coord = load_coord_config(model_id, config_dir=resolved_config_dir)
    sft = translate_to_sft_config(coord, options=options)
    plan = TrainPlan(model_id=model_id, coord_config=coord, sft_config=sft)
    if write_config:
        plan.config_path = write_generated_config(sft, out_dir=out_dir)
    return plan


def discover_model_ids(config_dir: Path = COORD_CONFIG_DIR) -> list[str]:
    """Return sorted list of all m*.yaml ids in the config dir."""
    return sorted(p.stem for p in config_dir.glob("m*.yaml") if not p.stem.startswith("_"))


def filter_by_tier_and_specialty(
    model_ids: Iterable[str],
    tier: int | None,
    specialty: str | None,
    config_dir: Path = COORD_CONFIG_DIR,
) -> list[str]:
    """Filter a model-id list by tier and/or specialty (intersection)."""
    out: list[str] = []
    for mid in model_ids:
        coord = load_coord_config(mid, config_dir=config_dir)
        if tier is not None and coord.get("tier") != tier:
            continue
        if specialty is not None and coord.get("specialty") != specialty:
            continue
        out.append(mid)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command()
@click.option("--model-id", "model_id", default=None, help="Train one coordinator (e.g. m01)")
@click.option("--all", "all_models", is_flag=True, help="Train all coordinators in the config dir")
@click.option("--tier", type=int, default=None, help="Filter by tier (1..6)")
@click.option(
    "--specialty",
    type=str,
    default=None,
    help="Filter by specialty (generalist|code|reasoning|routing-safety)",
)
@click.option(
    "--data-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=f"Directory of sft-coord-*.jsonl (default: {DEFAULT_DATA_DIR})",
)
@click.option(
    "--checkpoint-root",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=f"Where to write LoRA checkpoints (default: {DEFAULT_CHECKPOINT_ROOT})",
)
@click.option("--dry-run", is_flag=True, help="Plan + write configs, but don't invoke the trainer")
def cli(
    model_id: str | None,
    all_models: bool,
    tier: int | None,
    specialty: str | None,
    data_dir: Path | None,
    checkpoint_root: Path | None,
    dry_run: bool,
) -> None:
    """Coordinator-stable LoRA SFT orchestrator."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if not model_id and not all_models:
        raise click.UsageError("Provide either --model-id <id> or --all")

    options = TranslationOptions(
        data_dir=data_dir or DEFAULT_DATA_DIR,
        checkpoint_root=checkpoint_root or DEFAULT_CHECKPOINT_ROOT,
    )

    if all_models:
        ids = discover_model_ids()
        ids = filter_by_tier_and_specialty(ids, tier=tier, specialty=specialty)
    else:
        ids = [model_id] if model_id else []

    if not ids:
        click.echo("No coordinators matched the filter — nothing to do.")
        return

    click.echo(f"Planning {len(ids)} coordinator run(s): {', '.join(ids)}")

    failures: list[str] = []
    for mid in ids:
        plan = plan_run(mid, options=options)
        click.echo(
            f"  {mid}: base={plan.coord_config['base_model']} "
            f"tier={plan.coord_config.get('tier')} -> {plan.config_path}"
        )
        if dry_run:
            continue
        result = invoke_trainer(plan.config_path)
        plan.return_code = result.returncode
        if result.returncode != 0:
            failures.append(mid)
            logger.error("Trainer for %s exited with code %s", mid, result.returncode)

    if failures:
        click.echo(f"FAILED: {len(failures)} run(s) — {', '.join(failures)}")
        sys.exit(1)
    click.echo(f"Done -- {len(ids)} run(s) planned" + ("" if dry_run else " and invoked"))


if __name__ == "__main__":
    cli()
