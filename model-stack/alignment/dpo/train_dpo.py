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
Direct Preference Optimization (DPO) Training
===============================================
Trains a model using DPO with TRL's DPOTrainer on preference pairs.

Usage
-----
    python train_dpo.py --config dpo_config.yaml
    accelerate launch train_dpo.py --config dpo_config.yaml
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Dict, Optional

import click
import numpy as np
import torch
import yaml
from datasets import Dataset, load_dataset, load_from_disk
from peft import LoraConfig, TaskType
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOConfig, DPOTrainer

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── Dataset loading ──────────────────────────────────────────
def load_preference_dataset(cfg: dict) -> dict:
    """Load preference pairs for DPO training.

    Expected format:
        {"prompt": "...", "chosen": "...", "rejected": "..."}
    """
    data_cfg = cfg["data"]
    dataset_path = data_cfg["dataset_path"]
    eval_split = data_cfg.get("eval_split", 0.05)
    seed = cfg.get("seed", 42)

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

    # Format for DPOTrainer: needs prompt, chosen, rejected as text
    def format_for_dpo(example):
        prompt = example.get("prompt", "")
        chosen = example.get("chosen", "")
        rejected = example.get("rejected", "")

        return {
            "prompt": f"<|user|>\n{prompt}\n<|assistant|>\n",
            "chosen": chosen,
            "rejected": rejected,
        }

    dataset = dataset.map(
        format_for_dpo,
        num_proc=data_cfg.get("preprocessing_num_workers", 4),
        desc="Formatting for DPO",
    )

    # Split
    split = dataset.train_test_split(test_size=eval_split, seed=seed)
    logger.info("Train: %d, Eval: %d", len(split["train"]), len(split["test"]))
    return split


# ── Win rate evaluation ──────────────────────────────────────
def compute_dpo_metrics(eval_pred) -> Dict[str, float]:
    """
    Compute win rate and other DPO-specific metrics.
    DPOTrainer provides chosen and rejected rewards in predictions.
    """
    predictions = eval_pred.predictions

    if isinstance(predictions, tuple) and len(predictions) >= 2:
        chosen_rewards = predictions[0]
        rejected_rewards = predictions[1]
    else:
        # Fallback: logits as single array
        chosen_rewards = predictions[:, 0] if predictions.ndim > 1 else predictions
        rejected_rewards = predictions[:, 1] if predictions.ndim > 1 else np.zeros_like(predictions)

    win_rate = (chosen_rewards > rejected_rewards).mean()
    reward_margin = (chosen_rewards - rejected_rewards).mean()
    chosen_mean = chosen_rewards.mean()
    rejected_mean = rejected_rewards.mean()

    return {
        "win_rate": float(win_rate),
        "reward_margin": float(reward_margin),
        "chosen_reward_mean": float(chosen_mean),
        "rejected_reward_mean": float(rejected_mean),
    }


# ── Main ─────────────────────────────────────────────────────
@click.command()
@click.option("--config", required=True, type=click.Path(exists=True), help="Path to DPO config YAML.")
@click.option("--resume-from", default=None, type=str, help="Resume from a checkpoint.")
def main(config: str, resume_from: Optional[str]):
    """Train with DPO using TRL."""
    with open(config) as f:
        cfg = yaml.safe_load(f)

    seed = cfg.get("seed", 42)
    torch.manual_seed(seed)

    model_cfg = cfg["model"]
    dpo_cfg = cfg.get("dpo", {})
    train_cfg = cfg.get("training", {})
    ckpt_cfg = cfg.get("checkpointing", {})
    eval_cfg = cfg.get("evaluation", {})
    log_cfg = cfg.get("logging", {})
    lora_cfg = cfg.get("lora", {})

    base_model_path = model_cfg["base_model"]
    tokenizer_path = model_cfg.get("tokenizer", base_model_path)

    dtype_map = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}
    torch_dtype = dtype_map.get(model_cfg.get("torch_dtype", "bf16"), torch.bfloat16)
    attn_impl = model_cfg.get("attn_implementation", "sdpa")

    # Load model
    logger.info("Loading model from %s", base_model_path)
    model = AutoModelForCausalLM.from_pretrained(
        base_model_path,
        torch_dtype=torch_dtype,
        attn_implementation=attn_impl,
        trust_remote_code=True,
    )

    # Reference model (DPO needs a frozen copy)
    logger.info("Loading reference model...")
    ref_model = AutoModelForCausalLM.from_pretrained(
        base_model_path,
        torch_dtype=torch_dtype,
        attn_implementation=attn_impl,
        trust_remote_code=True,
    )

    # Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(
        tokenizer_path, trust_remote_code=True, padding_side="left",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id
        ref_model.config.pad_token_id = tokenizer.eos_token_id

    # LoRA (optional)
    peft_config = None
    if lora_cfg.get("enabled", False):
        peft_config = LoraConfig(
            r=lora_cfg.get("r", 16),
            lora_alpha=lora_cfg.get("lora_alpha", 32),
            lora_dropout=lora_cfg.get("lora_dropout", 0.05),
            target_modules=lora_cfg.get("target_modules", ["q_proj", "v_proj"]),
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )
        logger.info("LoRA enabled: r=%d, alpha=%d", peft_config.r, peft_config.lora_alpha)
        # When using LoRA with DPO, ref_model is not needed (uses base weights)
        ref_model = None

    # Load dataset
    logger.info("Loading preference dataset...")
    data_splits = load_preference_dataset(cfg)

    # W&B
    wb_cfg = log_cfg.get("wandb", {})
    if wb_cfg.get("project"):
        os.environ.setdefault("WANDB_PROJECT", wb_cfg["project"])
    if wb_cfg.get("entity"):
        os.environ.setdefault("WANDB_ENTITY", wb_cfg["entity"])

    # Training arguments
    data_cfg = cfg.get("data", {})

    training_args = DPOConfig(
        output_dir=ckpt_cfg.get("output_dir", "./checkpoints/ailin-1b-dpo"),
        run_name=cfg.get("run_name", "ailin-dpo"),
        # DPO-specific
        beta=dpo_cfg.get("beta", 0.1),
        loss_type=dpo_cfg.get("loss_type", "sigmoid"),
        label_smoothing=dpo_cfg.get("label_smoothing", 0.0),
        max_length=data_cfg.get("max_length", 4096),
        max_prompt_length=data_cfg.get("max_prompt_length", 1024),
        # Training
        num_train_epochs=train_cfg.get("epochs", 1),
        per_device_train_batch_size=train_cfg.get("per_device_train_batch_size", 2),
        per_device_eval_batch_size=train_cfg.get("per_device_eval_batch_size", 2),
        gradient_accumulation_steps=train_cfg.get("gradient_accumulation_steps", 8),
        learning_rate=train_cfg.get("learning_rate", 5e-7),
        weight_decay=train_cfg.get("weight_decay", 0.01),
        warmup_ratio=train_cfg.get("warmup_ratio", 0.1),
        lr_scheduler_type=train_cfg.get("lr_scheduler_type", "cosine"),
        max_grad_norm=train_cfg.get("gradient_clipping", 1.0),
        bf16=train_cfg.get("bf16", True),
        tf32=train_cfg.get("tf32", True),
        optim=train_cfg.get("optim", "adamw_torch"),
        gradient_checkpointing=True,
        # Checkpointing
        save_strategy=ckpt_cfg.get("save_strategy", "steps"),
        save_steps=ckpt_cfg.get("save_steps", 100),
        save_total_limit=ckpt_cfg.get("save_total_limit", 3),
        load_best_model_at_end=ckpt_cfg.get("load_best_model_at_end", True),
        metric_for_best_model=ckpt_cfg.get("metric_for_best_model", "eval_loss"),
        # Evaluation
        eval_strategy=eval_cfg.get("eval_strategy", "steps"),
        eval_steps=eval_cfg.get("eval_steps", 50),
        # Logging
        logging_steps=log_cfg.get("logging_steps", 10),
        report_to=log_cfg.get("report_to", "wandb"),
        # Misc
        seed=seed,
        remove_unused_columns=False,
        dataloader_num_workers=4,
    )

    # Trainer
    trainer = DPOTrainer(
        model=model,
        ref_model=ref_model,
        args=training_args,
        train_dataset=data_splits["train"],
        eval_dataset=data_splits["test"],
        processing_class=tokenizer,
        peft_config=peft_config,
    )

    # Train
    logger.info("Starting DPO training (beta=%.2f, loss=%s)...", dpo_cfg.get("beta", 0.1), dpo_cfg.get("loss_type", "sigmoid"))
    if resume_from:
        trainer.train(resume_from_checkpoint=resume_from)
    else:
        trainer.train()

    # Final evaluation
    logger.info("Running final evaluation...")
    eval_results = trainer.evaluate()
    logger.info("Final eval results:")
    for k, v in eval_results.items():
        if isinstance(v, float):
            logger.info("  %s: %.4f", k, v)
        else:
            logger.info("  %s: %s", k, v)

    # Save final model
    output_cfg = cfg.get("output", {})
    final_dir = output_cfg.get("final_model_dir", ckpt_cfg.get("output_dir", "./models/ailin-1b-dpo"))
    logger.info("Saving final DPO model to %s", final_dir)
    trainer.save_model(final_dir)
    tokenizer.save_pretrained(final_dir)

    # Save eval results
    results_path = Path(final_dir) / "eval_results.json"
    results_path.parent.mkdir(parents=True, exist_ok=True)
    with open(results_path, "w") as f:
        json.dump(eval_results, f, indent=2, default=str)

    logger.info("DPO training complete.")


if __name__ == "__main__":
    main()
