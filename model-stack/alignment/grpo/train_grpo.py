#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""GRPO post-training with verifiable rewards (RLVR) — TRL 1.x.

2026-10-19 — new module. GRPO (Group Relative Policy Optimization,
Shao et al. 2024, https://arxiv.org/abs/2404.01342) replaced PPO as the
dominant reasoning-RL method: no value model, no reward model in the loop
when the task admits VERIFIABLE rewards (exact answer, unit tests, tool
call success). This is the DeepSeek-R1 recipe (https://arxiv.org/abs/2501.12948)
and the default post-training paradigm of the 2025/2026 generation.

This module replaces ``alignment/rlhf_rlaif/train_ppo.py`` (deleted):
TRL removed ``PPOTrainer`` in 1.0, so the old script cannot even import
against the current stack (validated: trl 1.16).

Usage
-----
    python train_grpo.py \
        --model ./checkpoints/sft-merged \
        --config alignment/grpo/grpo_config.yaml \
        --dataset ./data/grpo_prompts.jsonl \
        --output-dir ./checkpoints/grpo

    # multi-GPU:
    accelerate launch train_grpo.py --model ... --config ...

Dataset format (JSONL, verifiable-reward style):
    {"prompt": "Compute 17*23. Answer with just the number.", "answer": "391"}
    {"prompt": [{"role":"user","content":"..."}], "answer": "391"}

The ``answer`` column is forwarded to the reward function by TRL; any extra
columns are forwarded as kwargs, so custom verifiers only need to read them.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import click
import yaml

logger = logging.getLogger("grpo")


# ---------------------------------------------------------------------------
# Verifiable reward functions
# ---------------------------------------------------------------------------


def _norm_number(s: str) -> str | None:
    """Extract the last numeric value in a completion, normalized."""
    matches = re.findall(r"-?\d[\d,]*(?:\.\d+)?", s)
    if not matches:
        return None
    raw = matches[-1].replace(",", "")
    try:
        value = float(raw)
    except ValueError:
        return None
    return str(int(value)) if value.is_integer() else str(value)


def exact_match_reward(
    completions: list[str],
    answer: list[str] | None = None,
    **_kwargs: Any,
) -> list[float]:
    """Verifiable reward: 1.0 when the completion contains the exact answer.

    Numeric answers tolerate formatting differences (commas, decimals,
    surrounding text) by comparing normalized values. This is the canonical
    RLVR setup: no learned reward model, no reward hacking surface.
    """
    if answer is None:
        return [0.0] * len(completions)
    rewards: list[float] = []
    for completion, expected in zip(completions, answer, strict=False):
        if expected in completion:
            rewards.append(1.0)
            continue
        norm_c, norm_e = _norm_number(completion), _norm_number(expected)
        rewards.append(1.0 if norm_c is not None and norm_c == norm_e else 0.0)
    return rewards


REWARD_REGISTRY: dict[str, Callable[..., list[float]]] = {
    "exact_match": exact_match_reward,
}


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


def load_dataset_jsonl(path: str | Path) -> list[dict[str, Any]]:
    """Load a JSONL prompt/answer dataset (lazy datasets import)."""
    import json

    rows: list[dict[str, Any]] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        raise ValueError(f"No examples found in {path}")
    logger.info("Loaded %d GRPO examples from %s", len(rows), path)
    return rows


def train(
    model_path: str,
    dataset_path: str,
    config_path: str,
    output_dir: str,
    reward_name: str,
    use_lora: bool,
    push_to_hub: bool,
) -> None:
    """Run GRPO training with the selected verifiable reward."""
    # Heavy imports stay inside train() so `--help` and module import work
    # without the full ML stack installed (lint env / integration smoke).
    # Dataset from datasets.arrow_dataset — the re-export in datasets/__init__
    # is not visible to py.typed metadata (attr-defined false positive; same
    # class as the documented load_dataset import in quantize.py).
    from datasets.arrow_dataset import Dataset
    from trl import GRPOConfig, GRPOTrainer

    with open(config_path, encoding="utf-8") as f:
        raw_cfg: dict[str, Any] = yaml.safe_load(f) or {}
    grpo_kwargs = raw_cfg.get("grpo", raw_cfg)

    if reward_name not in REWARD_REGISTRY:
        raise click.BadParameter(
            f"Unknown reward '{reward_name}'. Available: {sorted(REWARD_REGISTRY)}"
        )
    reward_fn = REWARD_REGISTRY[reward_name]

    rows = load_dataset_jsonl(dataset_path)
    dataset = Dataset.from_list(rows)

    peft_config = None
    if use_lora:
        from peft import LoraConfig, TaskType

        peft_config = LoraConfig(
            task_type=TaskType.CAUSAL_LM,
            r=raw_cfg.get("lora", {}).get("r", 16),
            lora_alpha=raw_cfg.get("lora", {}).get("alpha", 32),
            lora_dropout=raw_cfg.get("lora", {}).get("dropout", 0.05),
            target_modules=raw_cfg.get("lora", {}).get(
                "target_modules", ["q_proj", "k_proj", "v_proj", "o_proj"]
            ),
        )

    # GRPOConfig: generation-group settings come from YAML so the same script
    # covers smoke (tiny G/len) and real runs (G=16, long completions).
    config = GRPOConfig(
        output_dir=output_dir,
        seed=grpo_kwargs.get("seed", 0),
        per_device_train_batch_size=grpo_kwargs.get("per_device_train_batch_size", 8),
        gradient_accumulation_steps=grpo_kwargs.get("gradient_accumulation_steps", 4),
        num_generations=grpo_kwargs.get("num_generations", 8),
        # NOTE: no max_prompt_length — GRPOConfig dropped it before trl 1.16
        # (unexpected-keyword failure validated in CI run 39314637719; the
        # YAML key, if present, is simply ignored rather than rejected).
        max_completion_length=grpo_kwargs.get("max_completion_length", 1024),
        temperature=grpo_kwargs.get("temperature", 1.0),
        top_p=grpo_kwargs.get("top_p", 1.0),
        learning_rate=grpo_kwargs.get("learning_rate", 1.0e-6),
        lr_scheduler_type=grpo_kwargs.get("lr_scheduler_type", "constant_with_warmup"),
        warmup_steps=grpo_kwargs.get("warmup_steps", 10),
        num_train_epochs=grpo_kwargs.get("num_train_epochs", 1),
        beta=grpo_kwargs.get("beta", 0.0),  # KL penalty; 0 = no reference model
        loss_type=grpo_kwargs.get("loss_type", "dapo"),
        scale_rewards=grpo_kwargs.get("scale_rewards", "group"),
        bf16=grpo_kwargs.get("bf16", True),
        gradient_checkpointing=grpo_kwargs.get("gradient_checkpointing", True),
        logging_steps=grpo_kwargs.get("logging_steps", 1),
        save_steps=grpo_kwargs.get("save_steps", 100),
        save_total_limit=grpo_kwargs.get("save_total_limit", 3),
        report_to=grpo_kwargs.get("report_to", "none"),
        push_to_hub=push_to_hub,
        use_vllm=grpo_kwargs.get("use_vllm", False),
    )

    trainer = GRPOTrainer(
        model=model_path,
        reward_funcs=[reward_fn],
        args=config,
        train_dataset=dataset,
        peft_config=peft_config,
    )
    trainer.train()

    trainer.save_model(output_dir)
    logger.info("GRPO model saved to %s", output_dir)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command()
@click.option("--model", required=True, help="Path or HF id of the SFT-merged policy")
@click.option(
    "--config",
    default=str(Path(__file__).parent / "grpo_config.yaml"),
    help="GRPO hyperparameter YAML",
)
@click.option("--dataset", required=True, help="JSONL with prompt/answer rows")
@click.option("--output-dir", default="./checkpoints/grpo", help="Output checkpoint dir")
@click.option(
    "--reward",
    default="exact_match",
    type=click.Choice(sorted(REWARD_REGISTRY)),
    help="Verifiable reward function",
)
@click.option("--lora/--no-lora", default=False, help="Train LoRA adapters instead of full FT")
@click.option("--push-to-hub", is_flag=True, default=False, help="Push final checkpoint to the Hub")
def main(
    model: str,
    config: str,
    dataset: str,
    output_dir: str,
    reward: str,
    lora: bool,
    push_to_hub: bool,
) -> None:
    """GRPO training with verifiable rewards (TRL 1.x GRPOTrainer)."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    train(
        model_path=model,
        dataset_path=dataset,
        config_path=config,
        output_dir=output_dir,
        reward_name=reward,
        use_lora=lora,
        push_to_hub=push_to_hub,
    )


if __name__ == "__main__":
    main()
