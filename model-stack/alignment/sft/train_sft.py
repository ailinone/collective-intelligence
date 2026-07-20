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
Supervised Fine-Tuning (SFT) with TRL
=======================================
Fine-tunes a pretrained model on instruction-following data using
TRL's SFTTrainer with optional LoRA.

Usage
-----
    python train_sft.py --config sft_config.yaml
    python train_sft.py --config sft_config.yaml --no-lora  # full fine-tune
    accelerate launch train_sft.py --config sft_config.yaml
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

import click
import torch
import yaml
from datasets import Dataset, DatasetDict, load_dataset, load_from_disk
from peft import LoraConfig, TaskType, get_peft_model, PeftModel
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
)
from trl import SFTTrainer, SFTConfig

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── Chat template ────────────────────────────────────────────
CHAT_TEMPLATE = (
    "{% for message in messages %}"
    "{% if message['role'] == 'system' %}"
    "<|system|>\n{{ message['content'] }}\n"
    "{% elif message['role'] == 'user' %}"
    "<|user|>\n{{ message['content'] }}\n"
    "{% elif message['role'] == 'assistant' %}"
    "<|assistant|>\n{{ message['content'] }}\n"
    "{% endif %}"
    "{% endfor %}"
    "{% if add_generation_prompt %}<|assistant|>\n{% endif %}"
)


# ── Data formatting ──────────────────────────────────────────
def format_alpaca(example: Dict) -> str:
    """Format Alpaca-style instruction data into a chat string."""
    instruction = example.get("instruction", "")
    input_text = example.get("input", "")
    output_text = example.get("output", "")

    if input_text:
        prompt = f"{instruction}\n\nInput:\n{input_text}"
    else:
        prompt = instruction

    return f"<|user|>\n{prompt}\n<|assistant|>\n{output_text}\n"


def format_sharegpt(example: Dict) -> str:
    """Format ShareGPT-style multi-turn conversations."""
    conversations = example.get("conversations", [])
    text_parts = []
    for turn in conversations:
        role = turn.get("from", turn.get("role", ""))
        content = turn.get("value", turn.get("content", ""))
        if role in ("human", "user"):
            text_parts.append(f"<|user|>\n{content}\n")
        elif role in ("gpt", "assistant"):
            text_parts.append(f"<|assistant|>\n{content}\n")
        elif role == "system":
            text_parts.append(f"<|system|>\n{content}\n")
    return "".join(text_parts)


def format_messages(example: Dict) -> str:
    """Format OpenAI messages-style data."""
    messages = example.get("messages", [])
    text_parts = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        text_parts.append(f"<|{role}|>\n{content}\n")
    return "".join(text_parts)


FORMAT_FNS = {
    "alpaca": format_alpaca,
    "sharegpt": format_sharegpt,
    "messages": format_messages,
}


# ── Dataset loading ──────────────────────────────────────────
def load_sft_dataset(cfg: dict) -> DatasetDict:
    """Load and split dataset for SFT training."""
    data_cfg = cfg["data"]
    dataset_path = data_cfg["dataset_path"]
    eval_split = data_cfg.get("eval_split", 0.05)

    # Try loading from disk first, then HuggingFace hub
    path = Path(dataset_path)
    if path.exists():
        if path.suffix in (".json", ".jsonl"):
            dataset = load_dataset("json", data_files=str(path), split="train")
        elif path.is_dir():
            try:
                dataset = load_from_disk(str(path))
                if isinstance(dataset, DatasetDict):
                    return dataset
                dataset = dataset  # single split
            except Exception:
                dataset = load_dataset(str(path), split="train")
        else:
            dataset = load_dataset(str(path), split="train")
    else:
        logger.info("Loading dataset from HuggingFace hub: %s", dataset_path)
        dataset = load_dataset(dataset_path, split="train")

    # Apply formatting
    fmt = data_cfg.get("dataset_format", "alpaca")
    format_fn = FORMAT_FNS.get(fmt)
    if format_fn is None:
        raise ValueError(f"Unknown dataset format: {fmt}. Choose from {list(FORMAT_FNS.keys())}")

    def apply_format(example):
        example["text"] = format_fn(example)
        return example

    dataset = dataset.map(
        apply_format,
        num_proc=data_cfg.get("preprocessing_num_workers", 4),
        desc=f"Formatting ({fmt})",
    )

    # Train/eval split
    split = dataset.train_test_split(test_size=eval_split, seed=cfg.get("seed", 42))
    return DatasetDict({"train": split["train"], "test": split["test"]})


# ── Model loading ────────────────────────────────────────────
def load_model_and_tokenizer(cfg: dict):
    """Load base model and tokenizer."""
    model_cfg = cfg["model"]
    base_model = model_cfg["base_model"]
    tokenizer_path = model_cfg.get("tokenizer", base_model)

    dtype_map = {
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
        "fp32": torch.float32,
    }
    torch_dtype = dtype_map.get(model_cfg.get("torch_dtype", "bf16"), torch.bfloat16)
    attn_impl = model_cfg.get("attn_implementation", "sdpa")

    logger.info("Loading model from %s (dtype=%s, attn=%s)", base_model, torch_dtype, attn_impl)

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch_dtype,
        attn_implementation=attn_impl,
        trust_remote_code=True,
    )

    tokenizer = AutoTokenizer.from_pretrained(
        tokenizer_path,
        trust_remote_code=True,
        padding_side="right",
    )

    # Ensure pad token exists
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id

    # Set chat template
    if tokenizer.chat_template is None:
        tokenizer.chat_template = CHAT_TEMPLATE

    return model, tokenizer


# ── LoRA setup ───────────────────────────────────────────────
def setup_lora(model, cfg: dict):
    """Apply LoRA adapters to the model."""
    lora_cfg = cfg.get("lora", {})
    if not lora_cfg.get("enabled", False):
        logger.info("LoRA disabled; training full model.")
        return model

    lora_config = LoraConfig(
        r=lora_cfg.get("r", 64),
        lora_alpha=lora_cfg.get("lora_alpha", 128),
        lora_dropout=lora_cfg.get("lora_dropout", 0.05),
        target_modules=lora_cfg.get("target_modules", ["q_proj", "v_proj"]),
        bias=lora_cfg.get("bias", "none"),
        task_type=TaskType.CAUSAL_LM,
    )

    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    return model


# ── Merge and save ───────────────────────────────────────────
def merge_and_save(model, tokenizer, cfg: dict):
    """Merge LoRA adapters back into base model and save."""
    merge_cfg = cfg.get("merge", {})
    if not merge_cfg.get("merge_adapters", False):
        return

    output_dir = merge_cfg.get("output_dir", "./models/ailin-1b-sft-merged")
    logger.info("Merging LoRA adapters and saving to %s", output_dir)

    if isinstance(model, PeftModel):
        merged_model = model.merge_and_unload()
    else:
        merged_model = model

    merged_model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    logger.info("Merged model saved to %s", output_dir)


# ── Main ─────────────────────────────────────────────────────
@click.command()
@click.option("--config", required=True, type=click.Path(exists=True), help="Path to SFT config YAML.")
@click.option("--no-lora", is_flag=True, default=False, help="Disable LoRA (full fine-tuning).")
@click.option("--resume-from", default=None, type=str, help="Resume from a specific checkpoint.")
def main(config: str, no_lora: bool, resume_from: Optional[str]):
    """Launch SFT training."""
    with open(config) as f:
        cfg = yaml.safe_load(f)

    if no_lora:
        cfg.setdefault("lora", {})["enabled"] = False

    # Load model + tokenizer
    model, tokenizer = load_model_and_tokenizer(cfg)

    # Apply LoRA
    model = setup_lora(model, cfg)

    # Load dataset
    logger.info("Loading dataset...")
    dataset = load_sft_dataset(cfg)
    logger.info("Train: %d examples, Eval: %d examples", len(dataset["train"]), len(dataset["test"]))

    # Training arguments
    train_cfg = cfg.get("training", {})
    ckpt_cfg = cfg.get("checkpointing", {})
    eval_cfg = cfg.get("evaluation", {})
    log_cfg = cfg.get("logging", {})

    training_args = SFTConfig(
        output_dir=ckpt_cfg.get("output_dir", "./checkpoints/ailin-1b-sft"),
        run_name=cfg.get("run_name", "ailin-sft"),
        # Training
        num_train_epochs=train_cfg.get("epochs", 3),
        per_device_train_batch_size=train_cfg.get("per_device_train_batch_size", 4),
        per_device_eval_batch_size=train_cfg.get("per_device_eval_batch_size", 4),
        gradient_accumulation_steps=train_cfg.get("gradient_accumulation_steps", 8),
        learning_rate=train_cfg.get("learning_rate", 2e-5),
        weight_decay=train_cfg.get("weight_decay", 0.01),
        warmup_ratio=train_cfg.get("warmup_ratio", 0.03),
        lr_scheduler_type=train_cfg.get("lr_scheduler_type", "cosine"),
        max_grad_norm=train_cfg.get("gradient_clipping", 1.0),
        bf16=train_cfg.get("bf16", True),
        tf32=train_cfg.get("tf32", True),
        dataloader_num_workers=train_cfg.get("dataloader_num_workers", 4),
        optim=train_cfg.get("optim", "adamw_torch"),
        # SFT-specific
        max_seq_length=cfg["data"].get("max_length", 4096),
        packing=cfg["data"].get("packing", True),
        dataset_text_field="text",
        # Checkpointing
        save_strategy=ckpt_cfg.get("save_strategy", "steps"),
        save_steps=ckpt_cfg.get("save_steps", 200),
        save_total_limit=ckpt_cfg.get("save_total_limit", 5),
        load_best_model_at_end=ckpt_cfg.get("load_best_model_at_end", True),
        metric_for_best_model=ckpt_cfg.get("metric_for_best_model", "eval_loss"),
        greater_is_better=ckpt_cfg.get("greater_is_better", False),
        # Evaluation
        eval_strategy=eval_cfg.get("eval_strategy", "steps"),
        eval_steps=eval_cfg.get("eval_steps", 100),
        # Logging
        logging_steps=log_cfg.get("logging_steps", 10),
        report_to=log_cfg.get("report_to", "wandb"),
        # Misc
        seed=cfg.get("seed", 42),
        gradient_checkpointing=True,
        remove_unused_columns=False,
    )

    # W&B config
    wb_cfg = log_cfg.get("wandb", {})
    if wb_cfg.get("project"):
        os.environ.setdefault("WANDB_PROJECT", wb_cfg["project"])
    if wb_cfg.get("entity"):
        os.environ.setdefault("WANDB_ENTITY", wb_cfg["entity"])

    # Trainer
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset["test"],
        processing_class=tokenizer,
    )

    # Train
    logger.info("Starting SFT training...")
    if resume_from:
        trainer.train(resume_from_checkpoint=resume_from)
    else:
        trainer.train()

    # Save final
    logger.info("Saving final model...")
    trainer.save_model()
    tokenizer.save_pretrained(training_args.output_dir)

    # Evaluate
    logger.info("Running final evaluation...")
    eval_results = trainer.evaluate()
    logger.info("Final eval results: %s", eval_results)

    # Merge LoRA adapters
    merge_and_save(trainer.model, tokenizer, cfg)

    logger.info("SFT training complete.")


if __name__ == "__main__":
    main()
