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
Reward Model Training
======================
Trains a reward model on preference pairs using TRL's RewardTrainer.
Uses Bradley-Terry loss to learn a scalar reward from chosen/rejected pairs.

Usage
-----
    python train_reward.py \
        --base-model ./models/ailin-1b-sft-merged \
        --dataset ./data/preference/pairs.jsonl \
        --output-dir ./models/ailin-1b-reward

    accelerate launch train_reward.py \
        --base-model ./models/ailin-1b-sft-merged \
        --dataset ./data/preference/pairs.jsonl
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

import click
import torch
import torch.nn as nn
from datasets import Dataset, load_dataset, load_from_disk
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    TrainingArguments,
)
from trl import RewardConfig, RewardTrainer

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── Dataset preparation ──────────────────────────────────────
def load_preference_dataset(
    dataset_path: str,
    tokenizer: AutoTokenizer,
    max_length: int = 4096,
    eval_split: float = 0.05,
    seed: int = 42,
) -> dict:
    """
    Load preference pairs and format for RewardTrainer.
    Expected input format (JSONL):
        {"prompt": "...", "chosen": "...", "rejected": "..."}
    """
    path = Path(dataset_path)

    if path.exists():
        if path.suffix in (".json", ".jsonl"):
            dataset = load_dataset("json", data_files=str(path), split="train")
        elif path.is_dir():
            try:
                dataset = load_from_disk(str(path))
                if hasattr(dataset, "keys") and "train" in dataset:
                    dataset = dataset["train"]
            except Exception:
                dataset = load_dataset(str(path), split="train")
        else:
            dataset = load_dataset(str(path), split="train")
    else:
        dataset = load_dataset(dataset_path, split="train")

    logger.info("Loaded %d preference pairs", len(dataset))

    def format_pair(example):
        """Format into chosen/rejected text pairs for RewardTrainer."""
        prompt = example.get("prompt", "")

        # Build full texts
        chosen_text = f"<|user|>\n{prompt}\n<|assistant|>\n{example['chosen']}"
        rejected_text = f"<|user|>\n{prompt}\n<|assistant|>\n{example['rejected']}"

        # Tokenize chosen
        chosen_tokens = tokenizer(
            chosen_text,
            truncation=True,
            max_length=max_length,
            padding="max_length",
        )

        # Tokenize rejected
        rejected_tokens = tokenizer(
            rejected_text,
            truncation=True,
            max_length=max_length,
            padding="max_length",
        )

        return {
            "input_ids_chosen": chosen_tokens["input_ids"],
            "attention_mask_chosen": chosen_tokens["attention_mask"],
            "input_ids_rejected": rejected_tokens["input_ids"],
            "attention_mask_rejected": rejected_tokens["attention_mask"],
        }

    dataset = dataset.map(
        format_pair,
        num_proc=4,
        desc="Formatting preference pairs",
        remove_columns=dataset.column_names,
    )

    # Split
    split = dataset.train_test_split(test_size=eval_split, seed=seed)
    logger.info("Train: %d, Eval: %d", len(split["train"]), len(split["test"]))

    return split


# ── Model setup ──────────────────────────────────────────────
def load_reward_model(
    base_model_path: str,
    torch_dtype: torch.dtype = torch.bfloat16,
):
    """
    Load base model with a reward (sequence classification) head.
    The head projects the last hidden state to a single scalar.
    """
    logger.info("Loading reward model from %s", base_model_path)

    model = AutoModelForSequenceClassification.from_pretrained(
        base_model_path,
        num_labels=1,
        torch_dtype=torch_dtype,
        trust_remote_code=True,
    )

    tokenizer = AutoTokenizer.from_pretrained(
        base_model_path,
        trust_remote_code=True,
        padding_side="right",
    )

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id

    # Log model info
    total_params = sum(p.numel() for p in model.parameters())
    logger.info("Reward model parameters: %s (%.2fB)", f"{total_params:,}", total_params / 1e9)

    return model, tokenizer


# ── Evaluation metrics ───────────────────────────────────────
def compute_reward_metrics(eval_pred) -> Dict[str, float]:
    """Compute accuracy: how often the model assigns higher reward to chosen."""
    predictions = eval_pred.predictions
    # RewardTrainer outputs [chosen_rewards, rejected_rewards]
    if isinstance(predictions, tuple):
        chosen_rewards = predictions[0]
        rejected_rewards = predictions[1]
    else:
        # Single array: first half chosen, second half rejected
        mid = len(predictions) // 2
        chosen_rewards = predictions[:mid]
        rejected_rewards = predictions[mid:]

    accuracy = (chosen_rewards > rejected_rewards).mean()
    reward_margin = (chosen_rewards - rejected_rewards).mean()

    return {
        "accuracy": float(accuracy),
        "reward_margin": float(reward_margin),
        "chosen_reward_mean": float(chosen_rewards.mean()),
        "rejected_reward_mean": float(rejected_rewards.mean()),
    }


# ── Main ─────────────────────────────────────────────────────
@click.command()
@click.option("--base-model", required=True, type=str, help="Path to SFT model as base.")
@click.option("--dataset", required=True, type=str, help="Path to preference pairs dataset.")
@click.option("--output-dir", default="./models/ailin-1b-reward", type=str, help="Output directory.")
@click.option("--epochs", default=1, type=int, help="Number of training epochs.")
@click.option("--lr", default=1.5e-5, type=float, help="Learning rate.")
@click.option("--batch-size", default=4, type=int, help="Per-device batch size.")
@click.option("--grad-accum", default=8, type=int, help="Gradient accumulation steps.")
@click.option("--max-length", default=4096, type=int, help="Max sequence length.")
@click.option("--eval-split", default=0.05, type=float, help="Evaluation split fraction.")
@click.option("--wandb-project", default="ailin-reward", type=str, help="W&B project name.")
@click.option("--seed", default=42, type=int, help="Random seed.")
@click.option("--resume-from", default=None, type=str, help="Resume from checkpoint.")
def main(
    base_model: str,
    dataset: str,
    output_dir: str,
    epochs: int,
    lr: float,
    batch_size: int,
    grad_accum: int,
    max_length: int,
    eval_split: float,
    wandb_project: str,
    seed: int,
    resume_from: Optional[str],
):
    """Train a reward model on preference pairs."""
    torch.manual_seed(seed)

    # Load model
    model, tokenizer = load_reward_model(base_model)

    # Load dataset
    logger.info("Loading preference dataset from %s", dataset)
    data_splits = load_preference_dataset(
        dataset, tokenizer, max_length=max_length, eval_split=eval_split, seed=seed,
    )

    # W&B
    os.environ.setdefault("WANDB_PROJECT", wandb_project)

    # Training args
    training_args = RewardConfig(
        output_dir=output_dir,
        run_name="ailin-reward-model",
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        learning_rate=lr,
        weight_decay=0.01,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        max_grad_norm=1.0,
        bf16=True,
        tf32=True,
        gradient_checkpointing=True,
        # Checkpointing
        save_strategy="steps",
        save_steps=100,
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="accuracy",
        greater_is_better=True,
        # Evaluation
        eval_strategy="steps",
        eval_steps=50,
        # Logging
        logging_steps=10,
        report_to="wandb",
        # Reward-specific
        max_length=max_length,
        # Misc
        seed=seed,
        remove_unused_columns=False,
        dataloader_num_workers=4,
    )

    # Trainer
    trainer = RewardTrainer(
        model=model,
        args=training_args,
        train_dataset=data_splits["train"],
        eval_dataset=data_splits["test"],
        processing_class=tokenizer,
        compute_metrics=compute_reward_metrics,
    )

    # Train
    logger.info("Starting reward model training...")
    if resume_from:
        trainer.train(resume_from_checkpoint=resume_from)
    else:
        trainer.train()

    # Final eval
    logger.info("Running final evaluation...")
    eval_results = trainer.evaluate()
    logger.info("Final eval results:")
    for k, v in eval_results.items():
        logger.info("  %s: %.4f", k, v)

    # Save
    logger.info("Saving reward model to %s", output_dir)
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    # Save eval results
    results_path = Path(output_dir) / "eval_results.json"
    with open(results_path, "w") as f:
        json.dump(eval_results, f, indent=2)
    logger.info("Eval results saved to %s", results_path)

    logger.info("Reward model training complete.")


if __name__ == "__main__":
    main()
